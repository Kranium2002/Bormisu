"""Structured model calls on OpenAI and the OpenRouter <-> OpenAI failover (respx mocks; FICTIONAL data).

The request and response shapes are checked against the installed openai SDK types, so the mocks follow the
documented API rather than our own idea of it.
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
from openai.types.shared_params import ResponseFormatJSONSchema
from PIL import Image
from pydantic import TypeAdapter
from sqlalchemy import select

from app.config import get_settings
from app.db.models import ProviderCall
from app.db.session import get_sessionmaker
from app.pipeline.schemas import PageLabel
from app.providers import llm
from app.providers.base import ProviderError, token_cost
from app.providers.fakes import label
from app.providers.llm import LlmClient, active_model, image_part, provider_chain, text_part
from app.providers.llm_openrouter import OpenRouterClient

pytestmark = pytest.mark.db  # usage is written to the provider_calls ledger

OPENAI = "https://api.openai.com/v1/chat/completions"
OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_ONLY_FIELDS = {"provider", "usage", "reasoning", "plugins", "transforms", "models", "max_tokens"}


@pytest.fixture
def keys(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """Set provider keys (fake values) for one test: keys(openai=True, openrouter=False, **other_env)."""

    def set_keys(*, openai: bool = True, openrouter: bool = False, **env: str) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-test-not-real" if openai else "")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test-not-real" if openrouter else "")
        monkeypatch.setenv("MISTRAL_API_KEY", "")
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        get_settings.cache_clear()

    yield set_keys
    get_settings.cache_clear()


def completion(
    content: str | None, *, model: str = "gpt-fictional-2026-01-01", **message: Any
) -> dict[str, Any]:
    """A fictional OpenAI chat completion (shape of openai.types.chat.ChatCompletion)."""
    body = {
        "id": "chatcmpl-fictional",
        "object": "chat.completion",
        "created": 1_760_000_000,
        "model": model,
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "logprobs": None,
                "message": {"role": "assistant", "content": content, "refusal": None, **message},
            }
        ],
        "usage": {"prompt_tokens": 900, "completion_tokens": 120, "total_tokens": 1020},
    }
    ChatCompletion.model_validate(body)  # the fictional answer has the documented shape
    return body


def openrouter_completion(content: str) -> dict[str, Any]:
    return {
        "id": "gen-fictional",
        "model": "mistralai/mistral-small-2603",
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 900, "completion_tokens": 120, "cost": 0.0002},
    }


def tiny_png() -> str:
    out = io.BytesIO()
    Image.new("RGB", (40, 60), "white").save(out, format="PNG")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii")


async def classify(client: LlmClient) -> PageLabel:
    result = await client.structured(
        role="classifier",
        output=PageLabel,
        system="fictional system prompt",
        content=[image_part(tiny_png()), text_part("fictional page text")],
        purpose="classify",
        document_id=None,
        max_tokens=600,
    )
    return result.data


async def ledger() -> list[ProviderCall]:
    async with get_sessionmaker()() as session:
        return list((await session.scalars(select(ProviderCall).order_by(ProviderCall.id))).all())


async def test_structured_call_on_openai_request_shape_and_validation_retry(db: None, keys: Any) -> None:
    keys(openai=True, openrouter=False)
    settings = get_settings()
    good = label("log_sheet", borehole_labels=["FX-9"]).model_dump_json()
    with respx.mock(assert_all_called=True) as mock:
        route = mock.post(OPENAI).mock(
            side_effect=[
                httpx.Response(200, json=completion('{"role": "log_sheet"}')),  # does not validate
                httpx.Response(200, json=completion(good)),
            ]
        )
        client = OpenRouterClient()  # the old name is the provider-aware client
        assert client.provider == "openai" and client.model_for("classifier") == settings.chat_model
        result = await classify(client)
    assert result.borehole_labels == ["FX-9"] and route.call_count == 2

    first = json.loads(route.calls[0].request.content)
    TypeAdapter(CompletionCreateParamsNonStreaming).validate_python(first)
    assert set(first) <= set(CompletionCreateParamsNonStreaming.__annotations__) | {"stream"}
    assert not OPENROUTER_ONLY_FIELDS & set(first)
    assert first["model"] == settings.chat_model  # OPENAI_CLASSIFIER_MODEL unset: CHAT_MODEL
    assert first["max_completion_tokens"] == 600
    assert first["reasoning_effort"] == "none" and first["temperature"] == 0  # LLM_REASONING=off
    response_format = first["response_format"]
    TypeAdapter(ResponseFormatJSONSchema).validate_python(response_format)
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["name"] == "PageLabel"
    assert response_format["json_schema"]["strict"] is True
    schema = response_format["json_schema"]["schema"]
    assert schema["additionalProperties"] is False and set(schema["required"]) == set(schema["properties"])
    system, user = first["messages"]
    assert system == {"role": "system", "content": "fictional system prompt"}
    image = user["content"][0]
    TypeAdapter(ChatCompletionContentPartImageParam).validate_python(image)
    assert image["type"] == "image_url" and image["image_url"]["url"].startswith("data:image/png;base64,")
    assert user["content"][1] == {"type": "text", "text": "fictional page text"}
    headers = route.calls[0].request.headers
    assert headers["authorization"] == "Bearer sk-openai-test-not-real"
    assert "x-title" not in headers and "http-referer" not in headers

    second = json.loads(route.calls[1].request.content)
    assert second["messages"][-2] == {"role": "assistant", "content": '{"role": "log_sheet"}'}
    assert "did not validate" in second["messages"][-1]["content"]

    calls = await ledger()
    expected = token_cost(settings.chat_model, 900, 120)
    assert expected > 0  # the default model has a price in data/prices.yaml
    assert [(c.provider, c.purpose, c.model, c.ok) for c in calls] == [
        ("openai", "classify", "gpt-fictional-2026-01-01", True)
    ] * 2
    assert all(c.cost_usd == pytest.approx(expected) for c in calls)


async def test_openai_models_and_answers(db: None, keys: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    keys(openai=True, OPENAI_CLASSIFIER_MODEL="gpt-fictional-small", OPENAI_EXTRACTOR_MODEL="gpt-fictional")
    assert (
        active_model("classifier") == "gpt-fictional-small" and active_model("extractor") == "gpt-fictional"
    )
    with respx.mock() as mock:
        route = mock.post(OPENAI).mock(
            side_effect=[
                httpx.Response(200, json=completion(None, refusal="I cannot help with that.")),
                httpx.Response(200, json=_length()),
            ]
        )
        with pytest.raises(ProviderError) as refused:
            await classify(LlmClient())
        assert "declined" in str(refused.value) and refused.value.retryable is False
        with pytest.raises(ProviderError) as cut:
            await classify(LlmClient())
        assert "cut off" in str(cut.value)
    assert json.loads(route.calls[0].request.content)["model"] == "gpt-fictional-small"


def _length() -> dict[str, Any]:
    body = completion("{")
    body["choices"][0]["finish_reason"] = "length"
    return body


async def test_openai_optional_parameters_are_dropped_for_a_model_that_refuses_them(
    db: None, keys: Any
) -> None:
    keys(openai=True)
    good = label("narrative").model_dump_json()
    with respx.mock() as mock:
        route = mock.post(OPENAI).mock(
            side_effect=[
                httpx.Response(
                    400, json={"error": {"message": "Unsupported parameter: 'reasoning_effort'."}}
                ),
                httpx.Response(200, json=completion(good)),
                httpx.Response(200, json=completion(good)),
            ]
        )
        await classify(LlmClient())
        await classify(LlmClient())
    bodies = [json.loads(call.request.content) for call in route.calls]
    assert "reasoning_effort" in bodies[0] and "temperature" in bodies[0]
    assert all("reasoning_effort" not in b and "temperature" not in b for b in bodies[1:])  # remembered
    assert len(await ledger()) == 2  # the refused request is not billed and not recorded


async def test_failover_openrouter_401_to_openai_and_back(db: None, keys: Any) -> None:
    keys(openai=True, openrouter=True)
    settings = get_settings()
    assert (
        provider_chain() == ["openrouter", "openai"] and active_model("extractor") == settings.extractor_model
    )
    good = label("log_sheet").model_dump_json()
    with respx.mock() as mock:
        openrouter = mock.post(OPENROUTER).mock(
            side_effect=[
                httpx.Response(401, json={"error": {"message": "fictional: key refused"}}),
                httpx.Response(200, json=openrouter_completion(good)),
            ]
        )
        openai = mock.post(OPENAI).mock(
            side_effect=[
                httpx.Response(200, json=completion(good)),
                httpx.Response(200, json=completion(good)),
                httpx.Response(401, json={"error": {"message": "fictional: key refused"}}),
            ]
        )
        await classify(LlmClient())  # OpenRouter 401 -> OpenAI
        assert (openrouter.call_count, openai.call_count) == (1, 1)
        assert {"openrouter"} == llm._REFUSED and provider_chain() == ["openai", "openrouter"]
        assert active_model("extractor") == settings.chat_model  # cache keys follow the provider in use
        sent = json.loads(openai.calls[0].request.content)
        assert sent["model"] == settings.chat_model and not OPENROUTER_ONLY_FIELDS & set(sent)

        await classify(LlmClient())  # remembered: straight to OpenAI
        assert (openrouter.call_count, openai.call_count) == (1, 2)

        await classify(LlmClient())  # OpenAI 401 -> OpenRouter
        assert (openrouter.call_count, openai.call_count) == (2, 3)
        sent = json.loads(openrouter.calls[1].request.content)
        assert sent["model"] == settings.classifier_model and sent["provider"]["require_parameters"] is True
        assert {"openai"} == llm._REFUSED and provider_chain() == ["openrouter", "openai"]
    providers = [c.provider for c in await ledger()]
    assert providers == ["openai", "openai", "openrouter"]  # refused requests are not recorded


async def test_failover_openai_401_to_openrouter(db: None, keys: Any) -> None:
    keys(openai=True, openrouter=True)
    llm._REFUSED.add("openrouter")  # an earlier refusal in this process put OpenAI first
    good = label("log_sheet").model_dump_json()
    with respx.mock() as mock:
        openai = mock.post(OPENAI).mock(return_value=httpx.Response(403, json={"error": {"message": "x"}}))
        openrouter = mock.post(OPENROUTER).mock(
            return_value=httpx.Response(200, json=openrouter_completion(good))
        )
        await classify(LlmClient())
    assert openai.call_count == 1 and openrouter.call_count == 1
    assert {"openai"} == llm._REFUSED


async def test_no_failover_with_a_forced_provider_or_a_single_key(db: None, keys: Any) -> None:
    keys(openai=True, openrouter=True, LLM_PROVIDER="openrouter")
    assert provider_chain() == ["openrouter"]
    with respx.mock(assert_all_called=False) as mock:
        mock.post(OPENROUTER).mock(return_value=httpx.Response(401))
        openai = mock.post(OPENAI)
        with pytest.raises(ProviderError) as err:
            await classify(LlmClient())
        assert err.value.status == 401 and openai.call_count == 0
    assert set() == llm._REFUSED
    keys(openai=True, openrouter=False, LLM_PROVIDER="auto")
    with respx.mock() as mock:
        mock.post(OPENAI).mock(return_value=httpx.Response(401))
        with pytest.raises(ProviderError):
            await classify(LlmClient())
    keys(openai=False, openrouter=False)
    with pytest.raises(ProviderError) as missing:
        LlmClient()
    assert "OPENAI_API_KEY" in str(missing.value)
