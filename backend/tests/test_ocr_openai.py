"""OCR with an OpenAI key (a vision model transcribes the page render) and the OCR route chain.

respx mocks of the documented OpenAI chat-completions shapes (checked against the installed openai SDK types);
every document and answer is FICTIONAL.
"""

from __future__ import annotations

import base64
import io
import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import respx
from openai.types.chat import ChatCompletion, ChatCompletionContentPartImageParam
from openai.types.chat.completion_create_params import CompletionCreateParamsNonStreaming
from PIL import Image
from pydantic import TypeAdapter
from sqlalchemy import func, select

from app.config import get_settings
from app.db.models import OcrPage, OcrRun, Page, ProviderCall
from app.db.session import get_sessionmaker
from app.pipeline import classify as classify_module
from app.pipeline import ocr as ocr_module
from app.pipeline.orchestrator import run_pipeline
from app.providers.base import ProviderError, token_cost
from app.providers.fakes import FakeClassifier
from app.providers.ocr_openai import OCR_IMAGE_MAX_EDGE, OpenAIOcrClient, model_tag, ocr_prompt, page_png
from app.storage import get_storage
from tests.test_pipeline_classify_ocr import _upload, fictional_report, rule

pytestmark = pytest.mark.db
OPENAI = "https://api.openai.com/v1/chat/completions"
OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"
MISTRAL = "https://api.mistral.ai/v1/ocr"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """env(MISTRAL_API_KEY=..., ...): only the keys given are set (fake values); settings cache cleared."""

    def set_env(**values: str) -> None:
        for name in ("MISTRAL_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"):
            monkeypatch.setenv(name, "")
        for name, value in values.items():
            monkeypatch.setenv(name, value)
        get_settings.cache_clear()

    yield set_env
    get_settings.cache_clear()


def transcription(markdown: str | None) -> dict[str, Any]:
    """A fictional OpenAI chat completion carrying the page as markdown."""
    body = {
        "id": "chatcmpl-fictional",
        "object": "chat.completion",
        "created": 1_760_000_000,
        "model": "gpt-fictional-2026-01-01",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "logprobs": None,
                "message": {"role": "assistant", "content": markdown, "refusal": None},
            }
        ],
        "usage": {"prompt_tokens": 1100, "completion_tokens": 300, "total_tokens": 1400},
    }
    ChatCompletion.model_validate(body)
    return body


def png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(out, format="PNG")
    return out.getvalue()


def sent_image(request: httpx.Request) -> Image.Image:
    body = json.loads(request.content)
    part = body["messages"][1]["content"][0]
    return Image.open(io.BytesIO(base64.b64decode(part["image_url"]["url"].split(",", 1)[1])))


async def test_request_shape_markdown_and_cost(db: None, env: Any) -> None:
    env(OPENAI_API_KEY="sk-openai-test-not-real")
    settings = get_settings()
    fenced = "```markdown\nFICTIONAL LOG FX-5\n\n<table><tr><td>0,00</td><td>1,20</td></tr></table>\n```"
    with respx.mock() as mock:
        route = mock.post(OPENAI).mock(return_value=httpx.Response(200, json=transcription(fenced)))
        response = await OpenAIOcrClient().ocr(png(2400, 1800), "image/png", document_id=None, page_count=1)
    body = json.loads(route.calls[0].request.content)
    TypeAdapter(CompletionCreateParamsNonStreaming).validate_python(body)
    assert body["model"] == settings.chat_model  # OPENAI_OCR_MODEL unset: CHAT_MODEL
    assert body["messages"][0] == {"role": "system", "content": ocr_prompt()}
    assert "exactly as printed" in ocr_prompt() and "HTML" in ocr_prompt()  # the prompt is data/prompts/
    (part,) = body["messages"][1]["content"]
    TypeAdapter(ChatCompletionContentPartImageParam).validate_python(part)
    assert part["image_url"]["detail"] == "high"
    assert part["image_url"]["url"].startswith("data:image/png;base64,")
    image = sent_image(route.calls[0].request)
    assert image.format == "PNG" and max(image.size) == OCR_IMAGE_MAX_EDGE and image.size == (1600, 1200)
    assert body["max_completion_tokens"] > 0 and "response_format" not in body
    assert not {"plugins", "provider", "usage", "reasoning", "max_tokens"} & set(body)
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-openai-test-not-real"

    assert response.model == model_tag(settings.chat_model) and response.pages_processed == 1
    (page,) = response.raw["pages"]
    assert page["markdown"] == "FICTIONAL LOG FX-5\n\n<table><tr><td>0,00</td><td>1,20</td></tr></table>"
    assert page["blocks"] == [] and page["tables"] == [] and page["index"] == 0
    async with get_sessionmaker()() as session:
        call = await session.scalar(select(ProviderCall))
    assert call is not None and (call.provider, call.purpose, call.pages, call.ok) == (
        "openai",
        "ocr",
        1,
        True,
    )
    assert call.cost_usd == pytest.approx(token_cost(settings.chat_model, 1100, 300)) and call.cost_usd > 0


async def test_errors_and_inputs(db: None, env: Any) -> None:
    env(OPENAI_API_KEY="sk-openai-test-not-real", OPENAI_OCR_MODEL="gpt-fictional-vision")
    small = png(800, 1100)
    assert page_png(small, "image/png") == small  # small PNGs are sent unchanged
    rendered = Image.open(io.BytesIO(page_png(fictional_report(), "application/pdf")))
    assert max(rendered.size) == OCR_IMAGE_MAX_EDGE  # a PDF's first page is rendered
    with pytest.raises(ProviderError):
        await OpenAIOcrClient().ocr(small, "image/png", document_id=None, page_count=2)
    with respx.mock() as mock:
        route = mock.post(OPENAI).mock(
            side_effect=[
                httpx.Response(200, json=transcription(None)),
                httpx.Response(200, json=transcription("")),  # a page without text is an answer
            ]
        )
        with pytest.raises(ProviderError) as empty:
            await OpenAIOcrClient().ocr(small, "image/png", document_id=None, page_count=1)
        assert empty.value.retryable is True
        blank = await OpenAIOcrClient().ocr(small, "image/png", document_id=None, page_count=1)
    assert blank.raw["pages"][0]["markdown"] == ""
    assert json.loads(route.calls[0].request.content)["model"] == "gpt-fictional-vision"
    env(OPENAI_API_KEY="")
    with pytest.raises(ProviderError):
        OpenAIOcrClient()


def _stages_until_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.pipeline import orchestrator

    monkeypatch.setattr(orchestrator, "STAGES", ("triage", "classify", "ocr"))
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: FakeClassifier(rule))


async def _done_pages(doc_id: str) -> int:
    async with get_sessionmaker()() as session:
        value = await session.scalar(
            select(func.count())
            .select_from(Page)
            .where(Page.document_id == doc_id, Page.ocr_status == "done")
        )
    return int(value or 0)


async def test_pipeline_ocr_route_openai_one_page_per_call(
    db: None, env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    env(OPENAI_API_KEY="sk-openai-test-not-real", OCR_PROVIDER="openai")
    assert get_settings().ocr_routes == ["openai"]
    _stages_until_ocr(monkeypatch)
    doc_id = await _upload(fictional_report(), "doc_01JFAKE00000000000000OAI1")
    with respx.mock() as mock:
        route = mock.post(OPENAI).mock(
            return_value=httpx.Response(200, json=transcription("FICTIONAL PAGE TEXT\n\nline two"))
        )
        await run_pipeline(doc_id)
    assert route.call_count == 2  # the two log pages, one request each
    storage = get_storage()
    for call, n in zip(route.calls, (2, 3), strict=True):  # the stored render itself, page by page
        stored = Image.open(io.BytesIO(storage.get_bytes(f"pages/{doc_id}/{n:04d}.png")))
        assert sent_image(call.request).convert("RGB").tobytes() == stored.convert("RGB").tobytes()
    async with get_sessionmaker()() as session:
        statuses = dict(
            (await session.execute(select(Page.n, Page.ocr_status).where(Page.document_id == doc_id))).all()
        )
        assert statuses == {1: "skipped", 2: "done", 3: "done", 4: "skipped"}
        stored_page = await session.get(OcrPage, (doc_id, 2))
        assert stored_page is not None and stored_page.markdown == "FICTIONAL PAGE TEXT\n\nline two"
        assert stored_page.blocks == [] and stored_page.tables == []
        runs = (await session.execute(select(OcrRun.provider, OcrRun.model, OcrRun.status))).all()
        assert set(runs) == {("openai", model_tag(get_settings().chat_model), "done")}
    from app.pipeline.extract import build_input
    from app.pipeline.group import plan_groups

    groups = await plan_groups(doc_id)
    inp = await build_input(doc_id, groups[0])
    texts = [b.text for b in inp.blocks.values()]
    assert "FICTIONAL PAGE TEXT" in texts and "line two" in texts  # one citable block per paragraph
    assert all(b.box is None for b in inp.blocks.values())  # page-level citations


async def test_auto_chain_mistral_then_openrouter_refused_then_openai(
    db: None, env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    env(
        MISTRAL_API_KEY="mistral-refused-not-real",
        OPENROUTER_API_KEY="sk-or-refused-not-real",
        OPENAI_API_KEY="sk-openai-test-not-real",
        OCR_PROVIDER="auto",
    )
    settings = get_settings()
    assert settings.ocr_routes == ["mistral", "openrouter", "openai"] and settings.ocr_route == "mistral"
    _stages_until_ocr(monkeypatch)
    doc_id = await _upload(fictional_report(), "doc_01JFAKE00000000000000OAI2")
    with respx.mock() as mock:
        mistral = mock.post(MISTRAL).mock(return_value=httpx.Response(401, json={"message": "Unauthorized"}))
        openrouter = mock.post(OPENROUTER).mock(
            return_value=httpx.Response(401, json={"error": {"code": 401}})
        )
        openai = mock.post(OPENAI).mock(return_value=httpx.Response(200, json=transcription("FICTIONAL")))
        await run_pipeline(doc_id)
    # Mistral got both pages in one request; OpenRouter the first page; OpenAI read both pages.
    assert (mistral.call_count, openrouter.call_count, openai.call_count) == (1, 1, 2)
    assert await _done_pages(doc_id) == 2
    # Remembered for this process: later documents start with OpenAI, the refused routes come last.
    assert {"mistral", "openrouter"} == ocr_module._REFUSED_ROUTES
    assert ocr_module.route_chain(settings) == ["openai", "mistral", "openrouter"]
    async with get_sessionmaker()() as session:
        runs = (await session.execute(select(OcrRun.provider, OcrRun.status))).all()
    assert sorted(runs) == [
        ("mistral", "failed"),
        ("openai", "done"),
        ("openai", "done"),
        ("openrouter", "failed"),
    ]


async def test_a_forced_route_does_not_move(db: None, env: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    env(
        MISTRAL_API_KEY="mistral-refused-not-real",
        OPENAI_API_KEY="sk-openai-test-not-real",
        OCR_PROVIDER="mistral",
    )
    _stages_until_ocr(monkeypatch)
    doc_id = await _upload(fictional_report(), "doc_01JFAKE00000000000000OAI3")
    with respx.mock(assert_all_called=False) as mock:
        mock.post(MISTRAL).mock(return_value=httpx.Response(401, json={"message": "Unauthorized"}))
        openai = mock.post(OPENAI)
        await run_pipeline(doc_id)
    assert openai.call_count == 0 and await _done_pages(doc_id) == 0
    assert set() == ocr_module._REFUSED_ROUTES
