"""Local models through the OpenAI-compatible routes (README "Local models": Ollama at OPENAI_BASE_URL): the
openai_vision OCR route with boxes, OpenRouter's own fields only on OpenRouter, unpriced models at cost 0,
bh3's timeout and the chat's final round. Fictional values only; no request leaves the test."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app.bh3 import bridge as bh3_bridge
from app.chat import loop
from app.config import Settings, get_settings
from app.db.models import ProviderCall
from app.db.session import get_sessionmaker
from app.pipeline import bh3_adapter
from app.providers import base
from app.providers.llm import LlmClient
from app.providers.ocr_vision import OpenAIVisionOcrClient, OpenRouterVisionOcrClient
from tests.auth_utils import register
from tests.test_chat_api import FakeResponses, Script, post_chat, request_with
from tests.test_ocr_openai import png, transcription

LOCAL = "http://ollama.test:11434/v1"
COMPLETIONS = f"{LOCAL}/chat/completions"
MODEL = "fictional-vl:2b"
OPENROUTER_ONLY = {"provider", "usage", "reasoning", "plugins"}
READING = {
    "blocks": [
        {"kind": "title", "text": "FICTIONAL LOG FX-9", "box": [50, 100, 90, 700], "unsure": False},
        {"kind": "table_cell", "text": "1,20", "box": [300, 100, 320, 180], "unsure": True},
    ]
}


class Answer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str


@pytest.fixture(autouse=True)
def fresh_price_warnings() -> Iterator[None]:
    base._UNPRICED.clear()
    yield
    base._UNPRICED.clear()


@pytest.fixture(autouse=True)
def no_real_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_: Any) -> Any:
        raise AssertionError("tests never build a real OpenAI client")

    monkeypatch.setattr(loop, "_client", refuse)


@pytest.fixture
def keys(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., None]]:
    """keys(NAME=value, ...): only the provider keys given (fictional values); settings cache cleared."""

    def set_env(**values: str) -> None:
        for name in ("MISTRAL_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"):
            monkeypatch.setenv(name, "")
        for name, value in values.items():
            monkeypatch.setenv(name, value)
        get_settings.cache_clear()

    yield set_env
    monkeypatch.undo()
    get_settings.cache_clear()


@pytest.fixture
async def chat_api(db: None) -> AsyncIterator[tuple[httpx.AsyncClient, FastAPI]]:
    """The app and a client signed in as the fictional reviewer."""
    from app.main import create_app

    app = create_app(open_queue=False)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await register(client)
        yield client, app
    app.dependency_overrides.clear()


def _answer(content: str) -> httpx.Response:
    body = transcription(content)
    body["model"] = MODEL
    return httpx.Response(200, json=body)


@pytest.mark.db
async def test_openai_vision_reads_text_with_boxes_on_a_local_server(
    db: None, keys: Callable[..., None]
) -> None:
    keys(OPENAI_API_KEY="ollama", OPENAI_BASE_URL=LOCAL, OPENAI_OCR_MODEL=MODEL, OCR_PROVIDER="openai_vision")
    assert get_settings().ocr_routes == ["openai_vision"]
    with respx.mock() as mock:
        route = mock.post(COMPLETIONS).mock(return_value=_answer(json.dumps(READING)))
        response = await OpenAIVisionOcrClient().ocr(
            png(800, 1000), "image/png", document_id=None, page_count=1
        )
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == MODEL and body["max_completion_tokens"] > 0
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["name"] == "PageReading"
    assert body["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert not OPENROUTER_ONLY & set(body)
    assert route.calls[0].request.headers["authorization"] == "Bearer ollama"
    assert response.model == f"openai-vision:{MODEL}"
    (page,) = response.raw["pages"]
    title, cell = page["blocks"]
    assert (title["content"], cell["content"]) == ("FICTIONAL LOG FX-9", "1,20")
    # [ymin, xmin, ymax, xmax] on the 0-1000 grid -> corners normalised 0-1
    assert (title["top_left_x"], title["top_left_y"], title["bottom_right_x"]) == (0.1, 0.05, 0.7)
    assert "confidence_scores" in cell and "confidence_scores" not in title
    async with get_sessionmaker()() as session:
        call = await session.scalar(select(ProviderCall))
    assert call is not None and (call.provider, call.purpose, call.model, call.cost_usd) == (
        "openai",
        "ocr",
        MODEL,
        0.0,
    )


def test_auto_never_picks_openai_vision() -> None:
    settings = Settings(openai_api_key="ollama", openrouter_api_key=None, mistral_api_key=None)
    assert settings.ocr_routes == ["openai"]
    assert Settings(openai_api_key="ollama", ocr_provider="openai_vision").ocr_routes == ["openai_vision"]
    assert Settings(ocr_provider="openai_vision").ocr_routes == []  # no key, no route


def test_which_base_urls_get_provider_specific_fields() -> None:
    assert Settings().openrouter_fields and Settings().openai_is_openai
    local = Settings(openrouter_base_url=LOCAL, openai_base_url=LOCAL)
    assert not local.openrouter_fields and not local.openai_is_openai


@pytest.mark.db
async def test_openrouter_routes_on_another_server_send_plain_chat_completions(
    db: None, keys: Callable[..., None]
) -> None:
    keys(
        OPENROUTER_API_KEY="local",
        OPENROUTER_BASE_URL=LOCAL,
        LLM_PROVIDER="openrouter",
        CLASSIFIER_MODEL=MODEL,
        OPENROUTER_OCR_MODEL=MODEL,
    )
    with respx.mock() as mock:
        route = mock.post(COMPLETIONS).mock(
            side_effect=[_answer('{"value": "fictional"}'), _answer(json.dumps(READING))]
        )
        result = await LlmClient().structured(
            output=Answer,
            system="Fictional.",
            content=[],
            purpose="test",
            document_id=None,
            role="classifier",
        )
        await OpenRouterVisionOcrClient().ocr(png(400, 500), "image/png", document_id=None, page_count=1)
    assert result.data.value == "fictional" and result.cost_usd == 0.0
    structured, ocr = (json.loads(c.request.content) for c in route.calls)
    for body in (structured, ocr):
        assert body["model"] == MODEL and body["max_tokens"] > 0 and body["temperature"] == 0
        assert not OPENROUTER_ONLY & set(body)


def test_an_unpriced_model_costs_0_and_is_logged_once(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="geomemory.providers")
    assert base.token_cost(MODEL, 1000, 500) == 0.0
    assert base.token_cost(MODEL, 2000, 900) == 0.0
    assert [r.getMessage() for r in caplog.records].count(
        f"no price for model {MODEL}; its calls are logged at cost 0"
    ) == 1


def test_bh3_on_a_local_server_gets_no_openrouter_fields_and_the_request_timeout(tmp_path: Path) -> None:
    local = bh3_adapter.VisionRoute("openrouter", LOCAL, "local", MODEL, MODEL)
    assert bh3_adapter.openrouter_options(bh3_bridge, local, MODEL) == {}
    hosted = bh3_adapter.VisionRoute("openrouter", "https://openrouter.ai/api/v1", "k", MODEL, MODEL)
    assert "extra_body" in bh3_adapter.openrouter_options(bh3_bridge, hosted, MODEL)
    vlm = bh3_bridge.make_vlm(LOCAL, "ollama", MODEL, cache_dir=tmp_path, timeout_s=321.0)
    assert vlm.llm.cfg.timeout_s == 321.0 and vlm.llm.cfg.extra_body == {}


def test_the_chat_client_uses_the_base_url_and_the_turn_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    built: list[tuple[Any, ...]] = []
    monkeypatch.setattr(loop, "_client", lambda *args: built.append(args))
    monkeypatch.setenv("OPENAI_BASE_URL", LOCAL)
    monkeypatch.setenv("CHAT_TURN_TIMEOUT_S", "300")
    get_settings.cache_clear()
    try:
        loop.openai_model("ollama")
        assert loop.turn_timeout_s() == 300.0
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
    assert built == [("ollama", LOCAL, 300.0)]
    assert loop.turn_timeout_s() == loop.TURN_TIMEOUT_S


@pytest.mark.db
async def test_the_final_round_offers_no_tools_to_another_server(
    chat_api: tuple[httpx.AsyncClient, FastAPI], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "ollama")
    monkeypatch.setenv("OPENAI_BASE_URL", LOCAL)
    get_settings.cache_clear()
    monkeypatch.setattr(loop, "MAX_TOOL_ROUNDS", 0)  # the first round is the final one
    try:
        fake = FakeResponses(Script("resp_local").text("No fictional boreholes yet.").completed())
        _, chunks = await post_chat(chat_api, fake, request_with())
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
    (sent,) = fake.requests
    assert not {"tools", "tool_choice", "parallel_tool_calls"} & set(sent)
    assert "".join(c["delta"] for c in chunks if c["type"] == "text-delta") == "No fictional boreholes yet."
