"""Gemini on OpenRouter as the default document model: route order and model ids, reasoning per model (data
file plus the automatic retry on "Reasoning is mandatory"), the openrouter_vision OCR route (boxes on the
0-1000 grid converted to the app's block boxes) and its ledger and budget.

respx mocks of OpenRouter's chat-completions shapes; every page, text and answer is FICTIONAL. No paid call.
"""

from __future__ import annotations

import base64
import io
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from PIL import Image
from sqlalchemy import select

from app.bh3 import bridge
from app.bh3 import llm as bh3_llm
from app.config import GEMINI_MODEL, get_settings
from app.db.models import OcrPage, OcrRun, ProviderCall
from app.db.session import get_sessionmaker
from app.pipeline import bh3_adapter
from app.pipeline import ocr as ocr_module
from app.pipeline.orchestrator import run_pipeline
from app.pipeline.schemas import PageLabel
from app.providers import reasoning
from app.providers.base import BudgetExceededError, ProviderError, Usage, record_usage, token_cost
from app.providers.fakes import label
from app.providers.llm import LlmClient, text_part
from app.providers.ocr_mistral import normalise_page
from app.providers.ocr_vision import (
    OCR_MAX_OUTPUT_TOKENS,
    UNSURE_CONFIDENCE,
    OpenRouterVisionOcrClient,
    corners,
    model_tag,
    ocr_prompt,
)
from app.storage import get_storage
from tests.test_ocr_openai import _done_pages, _stages_until_ocr
from tests.test_pipeline_classify_ocr import _upload, fictional_report

OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"
MANDATORY = {
    "error": {"message": "Reasoning is mandatory for this endpoint and cannot be disabled.", "code": 400}
}
KEYS = ("MISTRAL_API_KEY", "OPENROUTER_API_KEY", "OPEN_ROUTER_KEY", "OPENAI_API_KEY")


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """env(OPENROUTER_API_KEY=..., ...): only the keys given are set (fake values); settings cache cleared."""

    def set_env(**values: str) -> None:
        for name in KEYS:
            monkeypatch.setenv(name, "")
        for name in ("OCR_PROVIDER", "OCR_FALLBACK"):
            monkeypatch.delenv(name, raising=False)
        for name, value in values.items():
            monkeypatch.setenv(name, value)
        get_settings.cache_clear()

    yield set_env
    get_settings.cache_clear()


def completion(
    content: str | None, *, finish: str = "stop", cost: float | None = 0.004, **message: Any
) -> Any:
    usage: dict[str, Any] = {"prompt_tokens": 1500, "completion_tokens": 700}
    if cost is not None:
        usage["cost"] = cost
    return {
        "id": "gen-fictional",
        "model": GEMINI_MODEL,
        "choices": [
            {"finish_reason": finish, "message": {"role": "assistant", "content": content, **message}}
        ],
        "usage": usage,
    }


def png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(out, format="PNG")
    return out.getvalue()


FICTIONAL_READING = {
    "blocks": [
        {"kind": "title", "text": "FICTIONAL BOREHOLE FX-9", "box": [40, 100, 70, 600], "unsure": False},
        {"kind": "table_cell", "text": "0,00 - 1,20", "box": [200, 80, 230, 220], "unsure": False},
        {"kind": "table_cell", "text": "Sand, schluffig", "box": [200, 240, 230, 700], "unsure": True},
        {"kind": "text", "text": "   ", "box": [300, 80, 320, 200], "unsure": False},  # blank: dropped
        {"kind": "text", "text": "no box", "box": [5, 5, 5, 5], "unsure": False},  # no area: page-level
    ]
}


# ----------------------------------------------------------------------------------------------
# Defaults and route order
# ----------------------------------------------------------------------------------------------


def test_gemini_is_the_default_and_openrouter_comes_first(env: Any) -> None:
    env(OPENROUTER_API_KEY="or", MISTRAL_API_KEY="mi", OPENAI_API_KEY="oa")
    settings = get_settings()
    assert settings.llm_routes == ["openrouter", "openai", "mistral"]
    assert settings.ocr_routes == ["openrouter_vision", "mistral", "openrouter", "openai"]
    assert settings.ocr_route == "openrouter_vision"
    for model in (settings.classifier_model, settings.extractor_model, settings.bh3_model):
        assert model == GEMINI_MODEL == "google/gemini-3.5-flash"
    assert settings.openrouter_ocr_model == GEMINI_MODEL
    assert settings.llm_model("classifier", "openrouter") == settings.llm_model("extractor", "openrouter")
    route = bh3_adapter.vision_route(settings)
    assert route is not None and (route.provider, route.model, route.text_model) == (
        "openrouter",
        GEMINI_MODEL,
        GEMINI_MODEL,
    )

    env(OPENROUTER_API_KEY="or", MISTRAL_API_KEY="mi", OCR_FALLBACK="none")
    assert get_settings().ocr_routes == ["openrouter_vision", "mistral"]  # only the routes with boxes
    env(MISTRAL_API_KEY="mi", OPENAI_API_KEY="oa")  # Mistral stays an optional fallback
    assert get_settings().llm_routes == ["openai", "mistral"]
    assert get_settings().ocr_routes == ["mistral", "openai"]
    env(OPENROUTER_API_KEY="or", OCR_PROVIDER="openrouter_vision")
    assert get_settings().ocr_routes == ["openrouter_vision"]
    env(MISTRAL_API_KEY="mi", OCR_PROVIDER="openrouter_vision")
    assert get_settings().ocr_routes == []


# ----------------------------------------------------------------------------------------------
# Reasoning per model
# ----------------------------------------------------------------------------------------------


def test_reasoning_field_per_model(env: Any) -> None:
    env(OPENROUTER_API_KEY="or")
    extra = reasoning.config().extra_output_tokens
    assert extra > 0 and reasoning.config().effort == "low"
    assert reasoning.required(GEMINI_MODEL) and reasoning.required("GOOGLE/Gemini-3.5-Flash-Lite")
    assert reasoning.openrouter_reasoning(GEMINI_MODEL) == {"effort": "low"}
    assert reasoning.openrouter_reasoning("fictional/plain-model") == {"enabled": False}
    assert reasoning.openrouter_reasoning("fictional/plain-model", "high") == {"effort": "high"}
    assert reasoning.output_tokens(600, {"effort": "low"}) == 600 + extra
    assert reasoning.output_tokens(600, {"enabled": False}) == 600
    reasoning.learn("fictional/plain-model")
    assert reasoning.openrouter_reasoning("fictional/plain-model") == {"effort": "low"}


async def test_structured_calls_send_reasoning_the_model_needs(db: None, env: Any) -> None:
    env(OPENROUTER_API_KEY="sk-or-test-not-real")
    good = label("log_sheet", borehole_labels=["FX-9"]).model_dump_json()
    extra = reasoning.config().extra_output_tokens
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(return_value=httpx.Response(200, json=completion(good)))
        result = await LlmClient().structured(
            output=PageLabel,
            system="fictional system prompt",
            content=[text_part("fictional page")],
            purpose="classify",
            document_id=None,
            role="classifier",
            max_tokens=600,
        )
    assert result.data.borehole_labels == ["FX-9"] and route.call_count == 1  # listed: no refused request
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == GEMINI_MODEL and body["reasoning"] == {"effort": "low"}
    assert body["max_tokens"] == 600 + extra  # room for the thinking
    assert body["provider"]["require_parameters"] is True and body["usage"] == {"include": True}


async def test_reasoning_is_mandatory_is_retried_and_remembered(db: None, env: Any) -> None:
    env(OPENROUTER_API_KEY="sk-or-test-not-real", CLASSIFIER_MODEL="fictional/thinking-only")
    good = label("log_sheet").model_dump_json()
    extra = reasoning.config().extra_output_tokens

    async def classify() -> None:
        await LlmClient().structured(
            output=PageLabel,
            system="s",
            content=[text_part("fictional")],
            purpose="classify",
            document_id=None,
            role="classifier",
            max_tokens=600,
        )

    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            side_effect=[
                httpx.Response(400, json=MANDATORY),
                httpx.Response(200, json=completion(good)),
                httpx.Response(200, json=completion(good)),
            ]
        )
        await classify()
        await classify()
    bodies = [json.loads(c.request.content) for c in route.calls]
    assert bodies[0]["reasoning"] == {"enabled": False} and bodies[0]["max_tokens"] == 600
    assert bodies[1]["reasoning"] == {"effort": "low"} and bodies[1]["max_tokens"] == 600 + extra
    assert bodies[2]["reasoning"] == {"effort": "low"}  # remembered: no second refused request
    async with get_sessionmaker()() as session:
        calls = (await session.scalars(select(ProviderCall))).all()
    assert len(calls) == 2  # the refused 400 is not billed

    # Any other 400 is not retried.
    env(OPENROUTER_API_KEY="sk-or-test-not-real", CLASSIFIER_MODEL="fictional/other-model")
    with respx.mock() as mock:
        mock.post(OPENROUTER).mock(return_value=httpx.Response(400, json={"error": {"message": "bad"}}))
        with pytest.raises(ProviderError) as refused:
            await classify()
    assert refused.value.status == 400 and "bad" not in str(refused.value)


# How Google AI Studio (through OpenRouter) refuses a response schema beyond Gemini's limits.
SCHEMA_REFUSED = {
    "error": {
        "message": "Provider returned error",
        "code": 400,
        "metadata": {
            "raw": '{"error": {"code": 400, "message": "Request contains an invalid argument.", '
            '"status": "INVALID_ARGUMENT"}}',
            "provider_name": "Google AI Studio",
        },
    }
}


async def test_refused_response_schema_falls_back_to_json_mode(db: None, env: Any) -> None:
    env(OPENROUTER_API_KEY="sk-or-test-not-real", CLASSIFIER_MODEL="fictional/small-schema-model")
    good = label("log_sheet", borehole_labels=["FX-9"]).model_dump_json()

    async def classify() -> PageLabel:
        result = await LlmClient().structured(
            output=PageLabel,
            system="fictional system prompt",
            content=[text_part("fictional")],
            purpose="classify",
            document_id=None,
            role="classifier",
            max_tokens=600,
        )
        return result.data

    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            side_effect=[
                httpx.Response(400, json=SCHEMA_REFUSED),
                httpx.Response(200, json=completion(f"```json\n{good}\n```")),
                httpx.Response(200, json=completion(good)),
            ]
        )
        first = await classify()
        second = await classify()
    assert first.borehole_labels == ["FX-9"] and second.borehole_labels == ["FX-9"]
    bodies = [json.loads(c.request.content) for c in route.calls]
    assert bodies[0]["response_format"]["type"] == "json_schema"
    for body in bodies[
        1:
    ]:  # JSON mode with the schema in the system prompt; the second call goes there directly
        assert body["response_format"] == {"type": "json_object"}
        system = body["messages"][0]["content"]
        assert system.startswith("fictional system prompt") and '"borehole_labels"' in system
        assert body["provider"]["require_parameters"] is True and body["usage"] == {"include": True}
    async with get_sessionmaker()() as session:
        calls = (await session.scalars(select(ProviderCall))).all()
    assert len(calls) == 2  # the refused 400 is not billed


def _vision_llm(tmp_path: Path) -> bh3_llm.LLM:
    return bridge.make_llm(
        "https://openrouter.ai/api/v1",
        "sk-or-test-not-real",
        "fictional/vision-thinking-only",
        cache_dir=tmp_path,
        reasoning_effort="low",
        reasoning_extra_tokens=1000,
    )


def test_bh3_retries_reasoning_is_mandatory_and_remembers_it(tmp_path: Path) -> None:
    llm = _vision_llm(tmp_path)
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            side_effect=[
                httpx.Response(400, json=MANDATORY),
                httpx.Response(200, json=completion('{"ok": true}')),
                httpx.Response(200, json=completion('{"ok": true}')),
            ]
        )
        out, meta = llm.complete_vision_json(
            png(20, 20), "image/png", "s", "u", schema, "classify", max_tokens=600
        )
        again, _ = _vision_llm(tmp_path).complete_vision_json(
            png(30, 30), "image/png", "s", "u", schema, "classify", max_tokens=600
        )
    assert out == {"ok": True} and again == {"ok": True} and meta["calls"] == 2
    bodies = [json.loads(c.request.content) for c in route.calls]
    assert bodies[0]["reasoning"] == {"enabled": False} and bodies[0]["max_tokens"] == 600
    assert bodies[1]["reasoning"] == {"effort": "low"} and bodies[1]["max_tokens"] == 1600
    assert bodies[2]["reasoning"] == {"effort": "low"} and bodies[2]["max_tokens"] == 1600  # remembered
    assert bodies[0]["provider"] == {"require_parameters": True} and bodies[0]["usage"] == {"include": True}


def test_bh3_gets_the_reasoning_its_model_needs(env: Any) -> None:
    env(OPENROUTER_API_KEY="sk-or-test-not-real")
    route = bh3_adapter.vision_route(get_settings())
    assert route is not None
    options = bh3_adapter.openrouter_options(bridge, route, route.model)
    assert options["extra_body"]["reasoning"] == {"effort": "low"}  # Gemini 3.5 Flash requires it
    assert options["extra_body"]["provider"] == {"require_parameters": True}
    assert options["reasoning_extra_tokens"] == reasoning.config().extra_output_tokens
    plain = bh3_adapter.openrouter_options(bridge, route, "fictional/plain-model")
    assert plain["extra_body"]["reasoning"] == {"enabled": False}
    mistral = bh3_adapter.VisionRoute("mistral", "https://api.mistral.ai/v1", "k", "m", "m")
    assert bh3_adapter.openrouter_options(bridge, mistral, "m") == {}


# ----------------------------------------------------------------------------------------------
# OCR on the openrouter_vision route
# ----------------------------------------------------------------------------------------------


def test_boxes_from_the_1000_grid() -> None:
    assert corners([100, 200, 300, 600]) == {
        "top_left_x": 0.2,
        "top_left_y": 0.1,
        "bottom_right_x": 0.6,
        "bottom_right_y": 0.3,
    }
    assert corners([300, 600, 100, 200]) == corners([100, 200, 300, 600])  # swapped corners
    assert corners([-20, 900, 50, 1200]) == {  # clamped to the page
        "top_left_x": 0.9,
        "top_left_y": 0.0,
        "bottom_right_x": 1.0,
        "bottom_right_y": 0.05,
    }
    assert corners([0.1, 0.2, 0.3, 0.6]) == corners([100, 200, 300, 600])  # already 0-1
    assert corners([5, 5, 5, 5]) is None and corners([1, 2, 3]) is None
    assert corners([float("nan"), 1, 2, 3]) is None


async def test_vision_ocr_request_blocks_with_boxes_and_cost(db: None, env: Any) -> None:
    env(OPENROUTER_API_KEY="sk-or-test-not-real")
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            return_value=httpx.Response(200, json=completion(json.dumps(FICTIONAL_READING), cost=0.0123))
        )
        response = await OpenRouterVisionOcrClient().ocr(
            png(2400, 1800), "image/png", document_id=None, page_count=1
        )
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == GEMINI_MODEL and body["temperature"] == 0
    assert body["messages"][0] == {"role": "system", "content": ocr_prompt()}
    assert "[ymin, xmin, ymax, xmax]" in ocr_prompt() and "0 to 1000" in ocr_prompt()
    text, image = body["messages"][1]["content"]
    assert text["type"] == "text" and image["image_url"]["url"].startswith("data:image/png;base64,")
    sent = Image.open(io.BytesIO(base64.b64decode(image["image_url"]["url"].split(",", 1)[1])))
    assert sent.size == (1600, 1200)
    assert (
        body["response_format"]["type"] == "json_schema" and body["response_format"]["json_schema"]["strict"]
    )
    assert body["provider"] == {"require_parameters": True, "data_collection": "deny"}
    assert body["usage"] == {"include": True} and body["reasoning"] == {"effort": "low"}
    assert body["max_tokens"] == OCR_MAX_OUTPUT_TOKENS + reasoning.config().extra_output_tokens
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-or-test-not-real"

    assert response.model == model_tag(GEMINI_MODEL) and response.pages_processed == 1
    (raw,) = response.raw["pages"]
    assert raw["dimensions"] == {"dpi": None, "width": 1600, "height": 1200}
    page = normalise_page(raw, 7)
    assert [b.id for b in page.blocks] == ["p7.b0", "p7.b1", "p7.b2", "p7.b3"]
    assert [b.text for b in page.blocks] == [
        "FICTIONAL BOREHOLE FX-9",
        "0,00 - 1,20",
        "Sand, schluffig",
        "no box",
    ]
    assert [b.type for b in page.blocks] == ["title", "table_cell", "table_cell", "text"]
    assert page.blocks[1].box == [0.08, 0.2, 0.14, 0.03]  # [x, y, w, h] normalised on the render
    assert page.blocks[3].box is None  # no area: the value cites the page
    assert page.blocks[1].confidence is None and page.blocks[2].confidence == UNSURE_CONFIDENCE
    assert page.markdown == "FICTIONAL BOREHOLE FX-9\n\n0,00 - 1,20\n\nSand, schluffig\n\nno box"
    async with get_sessionmaker()() as session:
        call = await session.scalar(select(ProviderCall))
    assert call is not None
    assert (call.provider, call.purpose, call.model, call.pages, call.ok) == (
        "openrouter",
        "ocr",
        GEMINI_MODEL,
        1,
        True,
    )
    assert call.cost_usd == pytest.approx(0.0123)  # the cost OpenRouter reports


async def test_vision_ocr_errors(db: None, env: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.providers.base as base

    async def no_wait(_: float) -> None:
        return None

    monkeypatch.setattr(base, "pause", no_wait)
    env(OPENROUTER_API_KEY="sk-or-test-not-real")
    page = png(800, 1100)

    async def read() -> Any:
        return await OpenRouterVisionOcrClient().ocr(page, "image/png", document_id=None, page_count=1)

    with pytest.raises(ProviderError):
        await OpenRouterVisionOcrClient().ocr(page, "image/png", document_id=None, page_count=2)
    good = json.dumps(FICTIONAL_READING)
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            side_effect=[
                httpx.Response(429, headers={"retry-after": "1"}),  # waited out
                httpx.Response(200, json=completion("not json at all")),  # asked again with the error
                httpx.Response(200, json=completion(good, cost=None)),
                httpx.Response(200, json=completion('{"blocks": []}')),  # a page without text
                httpx.Response(200, json=completion('{"lines": []}')),
                httpx.Response(200, json=completion('{"lines": []}')),
                httpx.Response(200, json=completion(None, refusal="I cannot help with that.")),
                httpx.Response(200, json=completion('{"blocks": [', finish="length")),
                httpx.Response(200, json=completion(None)),
            ]
        )
        fixed = await read()
        empty = await read()
        with pytest.raises(ProviderError) as invalid:
            await read()
        with pytest.raises(ProviderError) as refused:
            await read()
        with pytest.raises(ProviderError) as cut:
            await read()
        with pytest.raises(ProviderError) as nothing:
            await read()
    assert len(fixed.raw["pages"][0]["blocks"]) == 4
    retry = json.loads(route.calls[2].request.content)
    assert "did not validate" in retry["messages"][-1]["content"]
    assert retry["messages"][-2] == {"role": "assistant", "content": "not json at all"}
    assert empty.raw["pages"][0]["blocks"] == [] and empty.raw["pages"][0]["markdown"] == ""
    # One page failing never stops the others: every error here is retryable.
    for error in (invalid, refused, cut, nothing):
        assert error.value.retryable is True
    assert "declined" in str(refused.value) and "cut off" in str(cut.value)
    async with get_sessionmaker()() as session:
        calls = (await session.scalars(select(ProviderCall).order_by(ProviderCall.id))).all()
    assert len(calls) == 8 and all(c.pages == 1 and c.purpose == "ocr" for c in calls)
    priced = token_cost(GEMINI_MODEL, 1500, 700)  # no reported cost: priced from data/prices.yaml
    assert priced > 0 and calls[1].cost_usd == pytest.approx(priced)
    assert [c.ok for c in calls][-2:] == [False, False]  # cut off, no answer

    env(OPENROUTER_API_KEY="")
    with pytest.raises(ProviderError):
        OpenRouterVisionOcrClient()


async def test_vision_ocr_respects_the_budget(db: None, env: Any) -> None:
    env(OPENROUTER_API_KEY="sk-or-test-not-real", PROVIDER_BUDGET_USD="0.5")
    await record_usage(Usage("openrouter", "ocr", GEMINI_MODEL, 1, 1, 1, 0.49), None)
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(OPENROUTER)
        with pytest.raises(BudgetExceededError):
            await OpenRouterVisionOcrClient().ocr(png(100, 100), "image/png", document_id=None, page_count=1)
    assert route.call_count == 0  # refused before the paid call


async def test_pipeline_reads_scans_with_gemini_by_default(
    db: None, env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    env(OPENROUTER_API_KEY="sk-or-test-not-real", EXTRACTOR="classic")
    assert get_settings().ocr_route == "openrouter_vision"
    _stages_until_ocr(monkeypatch)
    doc_id = await _upload(fictional_report(), "doc_01JFAKE00000000000000GEM1")
    with respx.mock() as mock:
        route = mock.post(OPENROUTER).mock(
            return_value=httpx.Response(200, json=completion(json.dumps(FICTIONAL_READING)))
        )
        await run_pipeline(doc_id)
    assert route.call_count == 2 and await _done_pages(doc_id) == 2  # the two log pages, one request each
    storage = get_storage()
    for call, n in zip(route.calls, (2, 3), strict=True):  # the stored render itself, page by page
        url = json.loads(call.request.content)["messages"][1]["content"][1]["image_url"]["url"]
        sent = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
        stored = Image.open(io.BytesIO(storage.get_bytes(f"pages/{doc_id}/{n:04d}.png")))
        assert sent.convert("RGB").tobytes() == stored.convert("RGB").tobytes()
    async with get_sessionmaker()() as session:
        stored_page = await session.get(OcrPage, (doc_id, 2))
        runs = (await session.execute(select(OcrRun.provider, OcrRun.model, OcrRun.status))).all()
    assert stored_page is not None and len(stored_page.blocks) == 4
    assert stored_page.blocks[1]["id"] == "p2.b1" and stored_page.blocks[1]["box"] == [0.08, 0.2, 0.14, 0.03]
    assert set(runs) == {("openrouter", model_tag(GEMINI_MODEL), "done")}
    assert ocr_module.route_chain(get_settings())[0] == "openrouter_vision"

    from app.pipeline.extract import build_input
    from app.pipeline.group import plan_groups

    groups = await plan_groups(doc_id)
    inp = await build_input(doc_id, groups[0])
    cited = inp.blocks["p2.b1"]
    assert cited.text == "0,00 - 1,20" and cited.box == (
        0.08,
        0.2,
        0.14,
        0.03,
    )  # the classic extractor cites it
