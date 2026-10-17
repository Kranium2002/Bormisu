"""Provider clients against mocked HTTP (respx). Recorded responses are FICTIONAL and hand-written."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx
from sqlalchemy import select

from app.config import get_settings
from app.pipeline.schemas import PageLabel
from app.providers.base import BudgetExceededError, ProviderError
from app.providers.fakes import label
from app.providers.llm_openrouter import OpenRouterClient, text_part
from app.providers.ocr_mistral import MistralOcrClient, normalise_page

pytestmark = pytest.mark.db  # usage is written to the provider_calls ledger


@pytest.fixture
def keys(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("MISTRAL_API_KEY", "mistral-test-not-real")
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")  # these tests check OpenRouter's request shape
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _completion(content: str, *, finish: str = "stop", cost: float | None = 0.0002) -> dict[str, Any]:
    usage: dict[str, Any] = {"prompt_tokens": 900, "completion_tokens": 120}
    if cost is not None:
        usage["cost"] = cost
    return {
        "id": "gen-fictional",
        "model": "mistralai/mistral-small-2603",
        "choices": [{"finish_reason": finish, "message": {"role": "assistant", "content": content}}],
        "usage": usage,
    }


async def test_structured_request_shape_and_retry_on_invalid_json(db: None, keys: Any) -> None:
    good = label("log_sheet", borehole_labels=["FX-1"]).model_dump_json()
    with respx.mock(assert_all_called=True) as mock:
        route = mock.post("https://openrouter.ai/api/v1/chat/completions").mock(
            side_effect=[
                httpx.Response(200, json=_completion('{"role": "log_sheet"}')),  # does not validate
                httpx.Response(200, json=_completion(good)),
            ]
        )
        result = await OpenRouterClient().structured(
            model="mistralai/mistral-small-2603",
            output=PageLabel,
            system="fictional system prompt",
            content=[text_part("fictional page")],
            purpose="classify",
            document_id=None,
        )
    assert result.data.borehole_labels == ["FX-1"]
    assert route.call_count == 2 and result.cost_usd == pytest.approx(0.0004)
    first = json.loads(route.calls[0].request.content)
    assert first["response_format"]["type"] == "json_schema"
    assert first["response_format"]["json_schema"]["strict"] is True
    schema = first["response_format"]["json_schema"]["schema"]
    assert schema["additionalProperties"] is False and set(schema["required"]) == set(schema["properties"])
    assert first["provider"] == {"require_parameters": True, "data_collection": "deny"}
    assert first["temperature"] == 0
    assert first["reasoning"] == {"enabled": False}  # reasoning tokens would eat the answer
    second = json.loads(route.calls[1].request.content)
    assert "did not validate" in second["messages"][-1]["content"]
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-test-not-real"


async def test_errors_are_safe_and_retryable(db: None, keys: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.providers.base as base

    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(base.asyncio, "sleep", no_sleep)
    with respx.mock() as mock:
        mock.post("https://openrouter.ai/api/v1/chat/completions").mock(
            side_effect=[
                httpx.Response(429),
                httpx.Response(503),
                httpx.Response(200, json=_completion("{}", finish="length")),
            ]
        )
        with pytest.raises(ProviderError) as cut:
            await OpenRouterClient().structured(
                model="m", output=PageLabel, system="s", content=[], purpose="classify", document_id=None
            )
    assert "cut off" in str(cut.value) and "sk-test" not in str(cut.value)
    with respx.mock() as mock:
        mock.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(401, json={"error": {"message": "secret detail sk-test-not-real"}})
        )
        with pytest.raises(ProviderError) as denied:
            await OpenRouterClient().structured(
                model="m", output=PageLabel, system="s", content=[], purpose="classify", document_id=None
            )
    assert (
        denied.value.retryable is False and "secret" not in str(denied.value) and "401" in str(denied.value)
    )


async def test_budget_guard(db: None, keys: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.providers.base import Usage, record_usage

    await record_usage(Usage("openrouter", "classify", "m", 1, 1, None, 0.6), None)
    monkeypatch.setenv("PROVIDER_BUDGET_USD", "0.5")
    get_settings.cache_clear()
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post("https://openrouter.ai/api/v1/chat/completions")
        with pytest.raises(BudgetExceededError):
            await OpenRouterClient().structured(
                model="m", output=PageLabel, system="s", content=[], purpose="classify", document_id=None
            )
        assert route.call_count == 0


async def test_mistral_ocr_request_and_normalisation(db: None, keys: Any) -> None:
    fictional = {
        "model": "mistral-ocr-fictional",
        "usage_info": {"pages_processed": 1, "doc_size_bytes": 10},
        "pages": [
            {
                "index": 0,
                "markdown": "FICTIONAL FX-7\n\n[tbl-0.html](tbl-0.html)",
                "tables": [
                    {"id": "tbl-0.html", "content": "<table><tr><td>0,50</td></tr></table>", "format": "html"}
                ],
                "header": None,
                "footer": "FICTIONAL",
                "dimensions": {"dpi": 200, "width": 1654, "height": 2339},
                "blocks": [
                    {
                        "type": "title",
                        "content": "FICTIONAL FX-7",
                        "top_left_x": 165,
                        "top_left_y": 117,
                        "bottom_right_x": 662,
                        "bottom_right_y": 175,
                        "confidence_scores": {
                            "average_content_confidence_score": 0.98,
                            "minimum_content_confidence_score": 0.9,
                        },
                    },
                    {
                        "type": "table",
                        "content": "<table>...</table>",
                        "top_left_x": 100,
                        "top_left_y": 300,
                        "bottom_right_x": 1500,
                        "bottom_right_y": 1900,
                        "confidence_scores": None,
                        "table_id": "tbl-0.html",
                    },
                ],
            }
        ],
    }
    with respx.mock() as mock:
        route = mock.post("https://api.mistral.ai/v1/ocr").mock(
            return_value=httpx.Response(200, json=fictional)
        )
        response = await MistralOcrClient().ocr(
            b"%PDF-1.7 fictional", "application/pdf", document_id=None, page_count=1
        )
    body = json.loads(route.calls[0].request.content)
    assert body["document"]["document_url"].startswith("data:application/pdf;base64,")
    assert body["include_blocks"] is True and body["confidence_scores_granularity"] == "block"
    assert body["table_format"] == "html" and body["include_image_base64"] is False
    assert response.pages_processed == 1 and response.model == "mistral-ocr-fictional"
    page = normalise_page(response.raw["pages"][0], 7)
    assert [b.id for b in page.blocks] == ["p7.b0", "p7.b1"]
    x, y, w, h = page.blocks[0].box or []
    assert x == pytest.approx(165 / 1654, abs=1e-4) and y == pytest.approx(117 / 2339, abs=1e-4)
    assert w == pytest.approx((662 - 165) / 1654, abs=1e-4) and h == pytest.approx(58 / 2339, abs=1e-4)
    assert page.blocks[0].confidence == 0.98 and page.blocks[1].confidence is None
    assert page.tables == ["<table><tr><td>0,50</td></tr></table>"]
    already = normalise_page(
        {
            "blocks": [
                {
                    "content": "x",
                    "top_left_x": 0.1,
                    "top_left_y": 0.2,
                    "bottom_right_x": 0.3,
                    "bottom_right_y": 0.25,
                }
            ]
        },
        1,
    )
    assert already.blocks[0].box == [0.1, 0.2, 0.2, 0.05]


async def test_openrouter_is_the_default_route_and_a_refused_key_moves_to_mistral(
    db: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.db.models import ProviderCall
    from app.db.session import get_sessionmaker
    from app.providers import llm

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("MISTRAL_API_KEY", "mistral-test-not-real")
    monkeypatch.setattr(llm, "_REFUSED", set())
    get_settings.cache_clear()
    answer = json.dumps(label("log_sheet", borehole_labels=["FX-1"]).model_dump(mode="json"))

    async def classify() -> Any:
        return await OpenRouterClient().structured(
            output=PageLabel,
            system="s",
            content=[text_part("FICTIONAL")],
            purpose="classify",
            document_id=None,
            role="classifier",
        )

    with respx.mock() as mock:
        openrouter = mock.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_completion(answer))
        )
        await classify()
    assert json.loads(openrouter.calls[0].request.content)["model"] == "google/gemini-3.5-flash"

    with respx.mock() as mock:
        mock.post("https://openrouter.ai/api/v1/chat/completions").mock(return_value=httpx.Response(401))
        mistral = mock.post("https://api.mistral.ai/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_completion(answer, cost=None))
        )
        result = await classify()
    body = json.loads(mistral.calls[0].request.content)
    assert body["model"] == "mistral-small-latest" and body["response_format"]["type"] == "json_schema"
    assert "provider" not in body and "usage" not in body and "reasoning" not in body  # OpenRouter-only
    assert mistral.calls[0].request.headers["authorization"] == "Bearer mistral-test-not-real"
    # Mistral reports no cost: priced from data/prices.yaml (900 in, 120 out at 0.15 / 0.60 per million)
    assert result.data.borehole_labels == ["FX-1"] and result.cost_usd == pytest.approx(0.000207)
    async with get_sessionmaker()() as session:
        providers = [row.provider for row in (await session.scalars(select(ProviderCall))).all()]
    assert providers.count("mistral") == 1 and providers.count("openrouter") == 1
    get_settings.cache_clear()
