"""OpenRouter chat completions with strict structured outputs (classifier and extractor).

Thin httpx client: `response_format` json_schema strict, `provider.require_parameters` so only endpoints that
honour the schema are used, data collection denied, usage (with cost) included. The reply is validated with
the Pydantic model; one retry gets the validation error. Partial JSON is never accepted.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from app.config import get_settings
from app.providers.base import ProviderError, Usage, check_budget, post_with_retries, record_usage, token_cost
from app.providers.schema import strict_json_schema

logger = logging.getLogger("geomemory.providers.openrouter")
PROVIDER = "openrouter"
TIMEOUT_S = 180.0
T = TypeVar("T", bound=BaseModel)


class OutputTruncatedError(ProviderError):
    """The answer hit max_tokens; a smaller input (fewer pages) may fit."""


@dataclass(frozen=True)
class StructuredResult[M: BaseModel]:
    data: M
    model: str | None
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float


def text_part(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def image_part(data_url: str) -> dict[str, Any]:
    return {"type": "image_url", "image_url": {"url": data_url}}


class OpenRouterClient:
    def __init__(self, http: httpx.AsyncClient | None = None) -> None:
        self.settings = get_settings()
        if self.settings.openrouter_api_key is None:
            raise ProviderError("OpenRouter is not configured.", retryable=False)
        self._http = http

    def _headers(self) -> dict[str, str]:
        key = self.settings.openrouter_api_key
        assert key is not None
        return {
            "Authorization": f"Bearer {key.get_secret_value()}",
            "HTTP-Referer": self.settings.openrouter_app_url,
            "X-Title": self.settings.openrouter_app_title,
        }

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        url = self.settings.openrouter_base_url.rstrip("/") + "/chat/completions"
        if self._http is not None:
            response = await post_with_retries(
                self._http, url, json=body, headers=self._headers(), provider="OpenRouter"
            )
        else:
            async with httpx.AsyncClient(timeout=TIMEOUT_S) as http:
                response = await post_with_retries(
                    http, url, json=body, headers=self._headers(), provider="OpenRouter"
                )
        try:
            payload: dict[str, Any] = response.json()
        except ValueError as exc:
            raise ProviderError("OpenRouter sent an unreadable answer.", retryable=True) from exc
        return payload

    async def structured(
        self,
        *,
        model: str,
        output: type[T],
        system: str,
        content: list[dict[str, Any]],
        purpose: str,
        document_id: str | None,
        max_tokens: int = 4000,
        estimate_usd: float = 0.0,
    ) -> StructuredResult[T]:
        schema = strict_json_schema(output)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ]
        in_total, out_total, cost_total = 0, 0, 0.0
        returned_model: str | None = None
        for attempt in range(2):
            await check_budget(estimate_usd)
            body = {
                "model": model,
                "messages": messages,
                "temperature": 0,
                "max_tokens": max_tokens,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": output.__name__, "strict": True, "schema": schema},
                },
                "provider": {
                    "require_parameters": True,
                    "data_collection": self.settings.openrouter_data_collection,
                },
                "usage": {"include": True},
            }
            payload = await self._post(body)
            usage = payload.get("usage") or {}
            in_tok, out_tok = usage.get("prompt_tokens"), usage.get("completion_tokens")
            returned_model = payload.get("model") or model
            cost = usage.get("cost")
            cost_usd = float(cost) if isinstance(cost, int | float) else token_cost(model, in_tok, out_tok)
            in_total += int(in_tok or 0)
            out_total += int(out_tok or 0)
            cost_total += cost_usd
            choice = (payload.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            text = message.get("content")
            finish = choice.get("finish_reason")
            ok = isinstance(text, str) and finish != "length"
            await record_usage(
                Usage(PROVIDER, purpose, returned_model, in_tok, out_tok, None, cost_usd, ok), document_id
            )
            if finish == "length":
                raise OutputTruncatedError("The model's answer was cut off (too long).", retryable=False)
            if not isinstance(text, str):
                raise ProviderError("The model sent no answer.", retryable=True)
            try:
                data = output.model_validate(json.loads(text))
            except (ValueError, ValidationError) as exc:
                if attempt == 1:
                    raise ProviderError(
                        "The model's answer did not match the expected structure.", retryable=True
                    ) from exc
                problem = str(exc)[:1500]
                messages = [
                    *messages,
                    {"role": "assistant", "content": text},
                    {
                        "role": "user",
                        "content": f"Your JSON did not validate: {problem}\nReturn corrected JSON only.",
                    },
                ]
                continue
            return StructuredResult(data, returned_model, in_total, out_total, cost_total)
        raise ProviderError("The model's answer did not match the expected structure.", retryable=True)
