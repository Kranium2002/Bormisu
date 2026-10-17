"""OCR through the OpenRouter file-parser plugin, and the route choice (respx mocks; FICTIONAL data)."""

from __future__ import annotations

import io
import itertools
import json
from typing import Any

import httpx
import pypdfium2 as pdfium
import pytest
import respx
from PIL import Image
from sqlalchemy import func, select

from app.config import get_settings
from app.db.models import OcrPage, OcrRun, Page, ProviderCall
from app.db.session import get_sessionmaker
from app.pipeline import classify as classify_module
from app.pipeline.orchestrator import run_pipeline
from app.providers.base import ProviderError
from app.providers.fakes import FakeClassifier
from app.providers.ocr_openrouter import MODEL_TAG, OpenRouterOcrClient, image_to_pdf
from tests.test_pipeline_classify_ocr import _upload, fictional_report, rule

pytestmark = pytest.mark.db
OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"
MISTRAL = "https://api.mistral.ai/v1/ocr"


def parsed(text: str | None) -> dict[str, Any]:
    """A fictional OpenRouter answer with the file-parser annotation (message.annotations[].file.content)."""
    annotations = (
        []
        if text is None
        else [
            {
                "type": "file",
                "file": {
                    "hash": "fictional",
                    "name": "page.pdf",
                    "content": [{"type": "text", "text": text}],
                },
            }
        ]
    )
    return {
        "id": "gen-fictional",
        "model": "mistralai/mistral-small-2603",
        "choices": [
            {
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "OK", "annotations": annotations},
            }
        ],
        "usage": {"prompt_tokens": 900, "completion_tokens": 2, "cost": 0.0001},
    }


@pytest.fixture
def openrouter_only(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test-not-real")
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    monkeypatch.setenv("MISTRAL_API_KEY", "")
    monkeypatch.setenv("OCR_PROVIDER", "openrouter")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def test_request_shape_parsed_text_and_cost(db: None, openrouter_only: Any) -> None:
    pdf = fictional_report()
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            return_value=httpx.Response(200, json=parsed("BOREHOLE LOG FX-1\n\n0,00 - 1,20 Sand"))
        )
        response = await OpenRouterOcrClient().ocr(pdf, "application/pdf", document_id=None, page_count=1)
    body = json.loads(route.calls[0].request.content)
    assert body["plugins"] == [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}]
    file_part = next(p for p in body["messages"][0]["content"] if p["type"] == "file")
    assert file_part["file"]["file_data"].startswith("data:application/pdf;base64,")
    assert body["model"] == get_settings().classifier_model and body["reasoning"] == {"enabled": False}
    assert response.model == MODEL_TAG and response.pages_processed == 1
    page = response.raw["pages"][0]
    assert page["markdown"].startswith("BOREHOLE LOG FX-1") and page["blocks"] == []
    async with get_sessionmaker()() as session:
        call = await session.scalar(select(ProviderCall))
        assert call is not None and call.purpose == "ocr" and call.pages == 1
        assert (
            call.cost_usd >= get_settings().openrouter_ocr_usd_per_page
        )  # the parser fee is always recorded


async def test_no_parsed_text_is_a_retryable_error(db: None, openrouter_only: Any) -> None:
    with respx.mock() as mock:
        mock.post(OPENROUTER).mock(return_value=httpx.Response(200, json=parsed(None)))
        with pytest.raises(ProviderError) as err:
            await OpenRouterOcrClient().ocr(b"%PDF-1.4", "application/pdf", document_id=None, page_count=1)
    assert err.value.retryable is True and "no parsed text" in str(err.value)
    with pytest.raises(ProviderError):
        await OpenRouterOcrClient().ocr(b"%PDF-1.4", "application/pdf", document_id=None, page_count=2)


def test_images_become_one_page_pdfs() -> None:
    out = io.BytesIO()
    Image.new("RGB", (800, 1100), "white").save(out, format="JPEG")
    pdf = image_to_pdf(out.getvalue())
    assert pdf.startswith(b"%PDF-")
    document = pdfium.PdfDocument(pdf)
    try:
        assert len(document) == 1
    finally:
        document.close()


def test_route_choice() -> None:
    from app.config import Settings

    def route(**env: Any) -> str | None:
        return Settings(**env).ocr_route

    assert route(openrouter_api_key="x", ocr_provider="openrouter") == "openrouter"
    assert route(openrouter_api_key="x", mistral_api_key="y", ocr_provider="auto") == "mistral"
    assert route(openrouter_api_key="x", ocr_provider="auto") == "openrouter"
    assert route(mistral_api_key="y", ocr_provider="openrouter") is None
    assert route(ocr_provider="auto") is None
    settings = Settings(openrouter_api_key="x", ocr_provider="openrouter")
    assert settings.mode == "live" and settings.ocr_configured


def _stages_until_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.pipeline import orchestrator

    monkeypatch.setattr(orchestrator, "STAGES", ("triage", "classify", "ocr"))
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: FakeClassifier(rule))


async def test_pipeline_ocr_through_openrouter_one_page_per_call(
    db: None, openrouter_only: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stages_until_ocr(monkeypatch)
    doc_id = await _upload(fictional_report(), "doc_01JFAKE00000000000000ORO1")
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            return_value=httpx.Response(200, json=parsed("FICTIONAL PAGE TEXT\n\nline two"))
        )
        await run_pipeline(doc_id)
    assert route.call_count == 2  # the two log pages, one request each
    import base64

    sent = json.loads(route.calls[0].request.content)
    file_data = next(p for p in sent["messages"][0]["content"] if p["type"] == "file")["file"]["file_data"]
    document = pdfium.PdfDocument(base64.b64decode(file_data.split(",", 1)[1]))
    try:  # our own render rebuilt as a PDF: one page, no text layer of the original
        assert len(document) == 1
        textpage = document[0].get_textpage()
        assert textpage.count_chars() == 0
        textpage.close()
    finally:
        document.close()
    async with get_sessionmaker()() as session:
        statuses = dict(
            (await session.execute(select(Page.n, Page.ocr_status).where(Page.document_id == doc_id))).all()
        )
        assert statuses == {1: "skipped", 2: "done", 3: "done", 4: "skipped"}
        stored = await session.get(OcrPage, (doc_id, 2))
        assert (
            stored is not None
            and stored.markdown == "FICTIONAL PAGE TEXT\n\nline two"
            and stored.blocks == []
        )
        providers = (await session.scalars(select(OcrRun.provider))).all()
        assert set(providers) == {"openrouter"}
    from app.pipeline.extract import build_input
    from app.pipeline.group import plan_groups

    groups = await plan_groups(doc_id)
    inp = await build_input(doc_id, groups[0])
    assert inp.blocks and all(b.box is None for b in inp.blocks.values())  # page-level citations


async def test_auto_falls_back_to_openrouter_when_the_mistral_key_is_refused(
    db: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test-not-real")
    monkeypatch.setenv("MISTRAL_API_KEY", "mistral-refused-not-real")
    monkeypatch.setenv("OCR_PROVIDER", "auto")
    get_settings.cache_clear()
    _stages_until_ocr(monkeypatch)
    from app.pipeline import ocr as ocr_module

    try:
        doc_id = await _upload(fictional_report(), "doc_01JFAKE00000000000000ORO2")
        with respx.mock() as mock:
            mistral = mock.post(MISTRAL).mock(
                return_value=httpx.Response(401, json={"message": "Unauthorized"})
            )
            openrouter = mock.post(OPENROUTER).mock(
                return_value=httpx.Response(200, json=parsed("FICTIONAL"))
            )
            await run_pipeline(doc_id)
        assert mistral.call_count == 1 and openrouter.call_count == 2
        assert {"mistral"} == ocr_module._REFUSED_ROUTES  # later documents start with OpenRouter
        assert ocr_module.route_chain(get_settings()) == ["openrouter", "mistral"]
        async with get_sessionmaker()() as session:
            done = await session.scalar(
                select(func.count())
                .select_from(Page)
                .where(Page.document_id == doc_id, Page.ocr_status == "done")
            )
            assert done == 2
    finally:
        get_settings.cache_clear()


# ----------------------------------------------------------------------------------------------
# Rate limits (429): waited out with Retry-After, never counted as a failed attempt
# ----------------------------------------------------------------------------------------------


@pytest.fixture
def pauses(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    import app.providers.base as base

    waited: list[float] = []

    async def no_wait(seconds: float) -> None:
        waited.append(seconds)

    monkeypatch.setattr(base, "pause", no_wait)
    return waited


async def test_429_with_retry_after_is_waited_out(
    db: None, openrouter_only: Any, pauses: list[float]
) -> None:
    pdf = fictional_report()
    limited = {"retry-after": "7"}
    date = {"retry-after": "Wed, 21 Oct 2015 07:28:00 GMT"}  # in the past: retry at once
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            side_effect=[
                httpx.Response(429, headers=limited),
                httpx.Response(429, headers=limited),
                httpx.Response(429, headers=date),
                httpx.Response(429, headers={"retry-after-ms": "2500"}),
                httpx.Response(429, headers=limited),
                httpx.Response(200, json=parsed("BOREHOLE LOG FX-1")),
            ]
        )
        response = await OpenRouterOcrClient().ocr(pdf, "application/pdf", document_id=None, page_count=1)
    # Five 429s in a row are more than the 4 attempts other errors get: a rate limit is not a failure.
    assert route.call_count == 6 and pauses == [7.0, 7.0, 0.0, 2.5, 7.0]
    assert response.raw["pages"][0]["markdown"] == "BOREHOLE LOG FX-1"


async def test_429_without_retry_after_backs_off_until_the_wait_budget_is_used(
    db: None, openrouter_only: Any, pauses: list[float], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("RATE_LIMIT_WAIT_S", "40")
    get_settings.cache_clear()
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(return_value=httpx.Response(429))
        with pytest.raises(ProviderError) as refused:
            await OpenRouterOcrClient().ocr(
                fictional_report(), "application/pdf", document_id=None, page_count=1
            )
    assert refused.value.status == 429 and refused.value.retryable is True
    assert "rate-limited" in str(refused.value) and "sk-or" not in str(refused.value)
    assert sum(pauses) == pytest.approx(40.0)  # the whole budget, never more
    assert all(b >= a for a, b in itertools.pairwise(pauses[:-1]))  # growing backoff; the last is the rest
    assert route.call_count == len(pauses) + 1


async def test_openrouter_ocr_requests_are_capped_in_flight(openrouter_only: Any) -> None:
    import asyncio

    from app.pipeline.ocr import route_limit

    inside = peak = 0

    async def request(route: str) -> None:
        nonlocal inside, peak
        async with route_limit(route):
            inside += 1
            peak = max(peak, inside)
            await asyncio.sleep(0.01)
            inside -= 1

    await asyncio.gather(*(request("openrouter") for _ in range(4)))
    assert peak == 1  # OCR_OPENROUTER_CONCURRENCY defaults to 1
    inside = peak = 0
    await asyncio.gather(*(request("mistral") for _ in range(4)))
    assert peak == 4  # other routes are not capped here
