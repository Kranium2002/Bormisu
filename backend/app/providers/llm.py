"""Structured model calls (classifier, extractor, second reads, sheet mapping) on OpenRouter or OpenAI.

Both are chat completions with `response_format` json_schema strict (app.providers.schema) and the same
message shapes: text parts, images as {"type": "image_url", "image_url": {"url": data URL}}. OpenRouter also
gets its own fields: provider routing (`require_parameters`, data collection per OPENROUTER_DATA_COLLECTION),
usage with cost, reasoning per model (app.providers.reasoning: off unless LLM_REASONING asks for it or the
model requires it; a 400 "Reasoning is mandatory" is retried once with it on) and the app headers. OpenAI
(POST {OPENAI_BASE_URL}/chat/completions; shapes checked against the openai SDK 2.54 types
CompletionCreateParams, ChatCompletionContentPartImageParam, ChatCompletion and CompletionUsage) gets
`max_completion_tokens`, plus `reasoning_effort` (and `temperature` 0 when reasoning is off), which are
dropped for a model that answers 400 to them (remembered per process).

The reply is validated with the Pydantic model; one retry gets the validation error. Partial JSON is never
accepted. Cost: the usage cost the provider reports (OpenRouter), else tokens times data/prices.yaml for the
requested model; every call is written to provider_calls and the budget is checked before it.

LLM_PROVIDER picks the providers (Settings.llm_routes): openrouter (Gemini 3.5 Flash by default), openai,
mistral (direct API, OpenAI-compatible chat completions); auto tries them in that order. A 401/403 moves the
call, and every later call of this process, to the next configured provider, with that provider's model for
the role (CLASSIFIER_MODEL / EXTRACTOR_MODEL on OpenRouter, OPENAI_CLASSIFIER_MODEL / OPENAI_EXTRACTOR_MODEL
on OpenAI, MISTRAL_CLASSIFIER_MODEL / MISTRAL_EXTRACTOR_MODEL on Mistral). Mistral reports no cost: its calls
are priced from data/prices.yaml.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from app.config import LlmRoute, ModelRole, Settings, get_settings
from app.providers import reasoning
from app.providers.base import ProviderError, Usage, check_budget, post_with_retries, record_usage, token_cost
from app.providers.schema import strict_json_schema

logger = logging.getLogger("geomemory.providers.llm")
TIMEOUT_S = 180.0
LABELS: dict[str, str] = {"mistral": "Mistral", "openrouter": "OpenRouter", "openai": "OpenAI"}
REFUSED_STATUS = frozenset({401, 403})
T = TypeVar("T", bound=BaseModel)

# Providers whose key was refused (401/403) in this process: auto mode tries them last until they answer
# again.
_REFUSED: set[str] = set()
# OpenAI models that answered 400 to the optional parameters (reasoning_effort, temperature) in this process.
_PLAIN_OPENAI_MODELS: set[str] = set()


class OutputTruncatedError(ProviderError):
    """The answer hit the output token limit; a smaller input (fewer pages) may fit."""


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


def provider_chain(settings: Settings | None = None) -> list[LlmRoute]:
    """The configured providers in the order a call tries them: LLM_PROVIDER's order, with the providers
    refused earlier in this process moved to the end."""
    routes = (settings or get_settings()).llm_routes
    return [r for r in routes if r not in _REFUSED] + [r for r in routes if r in _REFUSED]


def active_model(role: ModelRole) -> str:
    """The model a call for `role` goes to now (cache keys and run records). With no provider configured it is
    OpenRouter's setting, as before (test doubles stand in for the client then)."""
    settings = get_settings()
    chain = provider_chain(settings)
    return settings.llm_model(role, chain[0] if chain else "openrouter")


def openai_optional_params(settings: Settings) -> dict[str, Any]:
    """Parameters not every OpenAI model takes: reasoning effort per LLM_REASONING, temperature 0 when off."""
    level = settings.llm_reasoning
    if level == "off":
        return {"reasoning_effort": "none", "temperature": 0}
    return {"reasoning_effort": level}


def _json(response: httpx.Response, label: str) -> dict[str, Any]:
    try:
        payload: dict[str, Any] = response.json()
    except ValueError as exc:
        raise ProviderError(f"{label} sent an unreadable answer.", retryable=True) from exc
    return payload


async def _send(
    http: httpx.AsyncClient | None,
    url: str,
    body: dict[str, Any],
    headers: dict[str, str],
    label: str,
    timeout_s: float,
) -> httpx.Response:
    if http is not None:
        return await post_with_retries(http, url, json=body, headers=headers, provider=label)
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        return await post_with_retries(client, url, json=body, headers=headers, provider=label)


async def post_openai_chat(
    http: httpx.AsyncClient | None,
    body: dict[str, Any],
    *,
    label: str = "OpenAI",
    timeout_s: float = TIMEOUT_S,
) -> dict[str, Any]:
    """POST a chat completion to OpenAI. The optional parameters are added unless the model refused them
    before; a 400 with them is retried once without them (a 400 is not billed)."""
    settings = get_settings()
    key = settings.openai_api_key
    if key is None:
        raise ProviderError("OpenAI is not configured.", retryable=False)
    url = settings.openai_base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {key.get_secret_value()}"}
    model = str(body.get("model"))
    optional = {} if model in _PLAIN_OPENAI_MODELS else openai_optional_params(settings)
    try:
        response = await _send(http, url, {**body, **optional}, headers, label, timeout_s)
    except ProviderError as exc:
        if exc.status != 400 or not optional:
            raise
        response = await _send(http, url, body, headers, label, timeout_s)
        if model not in _PLAIN_OPENAI_MODELS:
            logger.info("%s model %s takes no %s; sent without them", label, model, ", ".join(optional))
        _PLAIN_OPENAI_MODELS.add(model)
    return _json(response, label)


def openrouter_headers(settings: Settings) -> dict[str, str]:
    key = settings.openrouter_api_key
    if key is None:
        raise ProviderError("OpenRouter is not configured.", retryable=False)
    return {
        "Authorization": f"Bearer {key.get_secret_value()}",
        "HTTP-Referer": settings.openrouter_app_url,
        "X-Title": settings.openrouter_app_title,
    }


async def post_openrouter_chat(
    http: httpx.AsyncClient | None,
    body: dict[str, Any],
    *,
    label: str = "OpenRouter",
    timeout_s: float = TIMEOUT_S,
) -> dict[str, Any]:
    """POST a chat completion to OpenRouter. A model that answers 400 "Reasoning is mandatory" to reasoning
    off is asked again once with reasoning on (a 400 is not billed) and remembered for the rest of the
    process."""
    settings = get_settings()
    url = settings.openrouter_base_url.rstrip("/") + "/chat/completions"
    headers = openrouter_headers(settings)
    try:
        response = await _send(http, url, body, headers, label, timeout_s)
    except ProviderError as exc:
        if (
            exc.status != 400
            or not reasoning.mandatory_error(exc.detail)
            or not reasoning.is_off(body.get("reasoning"))
        ):
            raise
        model = str(body.get("model"))
        logger.info("%s model %s requires reasoning; sent again with it on", label, model)
        reasoning.learn(model)
        response = await _send(http, url, reasoning.with_reasoning(body), headers, label, timeout_s)
    return _json(response, label)


def _answer(payload: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    """(content, finish_reason, refusal) of the first choice."""
    choice = (payload.get("choices") or [{}])[0] or {}
    message = choice.get("message") or {}
    text, refusal = message.get("content"), message.get("refusal")
    return (
        text if isinstance(text, str) else None,
        choice.get("finish_reason"),
        refusal if isinstance(refusal, str) and refusal.strip() else None,
    )


class LlmClient:
    """Structured calls on the configured provider(s); see the module docstring."""

    def __init__(self, http: httpx.AsyncClient | None = None) -> None:
        self.settings = get_settings()
        if not self.settings.llm_routes:
            raise ProviderError(
                "No model provider is configured (set OPENROUTER_API_KEY, OPENAI_API_KEY or "
                "MISTRAL_API_KEY).",
                retryable=False,
            )
        self._http = http

    @property
    def provider(self) -> LlmRoute:
        """The provider the next call goes to first."""
        return provider_chain(self.settings)[0]

    def model_for(self, role: ModelRole) -> str:
        """The model the next call for `role` goes to first."""
        return self.settings.llm_model(role, self.provider)

    def _body(
        self,
        provider: LlmRoute,
        model: str,
        messages: list[dict[str, Any]],
        response_format: dict[str, Any],
        max_tokens: int,
    ) -> dict[str, Any]:
        if provider == "openai":
            return {
                "model": model,
                "messages": messages,
                "max_completion_tokens": max_tokens,
                "response_format": response_format,
            }
        if provider == "mistral":  # OpenAI-compatible chat completions; no OpenRouter-only fields
            return {
                "model": model,
                "messages": messages,
                "temperature": 0,
                "max_tokens": max_tokens,
                "response_format": response_format,
            }
        thinking = reasoning.openrouter_reasoning(model, self.settings.llm_reasoning)
        return {
            "model": model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": reasoning.output_tokens(max_tokens, thinking),
            "response_format": response_format,
            "provider": {
                "require_parameters": True,
                "data_collection": self.settings.openrouter_data_collection,
            },
            "usage": {"include": True},
            "reasoning": thinking,
        }

    async def _post(self, provider: LlmRoute, body: dict[str, Any]) -> dict[str, Any]:
        if provider == "openai":
            return await post_openai_chat(self._http, body)
        if provider == "mistral":
            key = self.settings.mistral_api_key
            if key is None:
                raise ProviderError("Mistral is not configured.", retryable=False)
            url = self.settings.mistral_base_url.rstrip("/") + "/chat/completions"
            headers = {"Authorization": f"Bearer {key.get_secret_value()}"}
            response = await _send(self._http, url, body, headers, "Mistral", TIMEOUT_S)
            return _json(response, "Mistral")
        return await post_openrouter_chat(self._http, body)

    async def structured(
        self,
        *,
        output: type[T],
        system: str,
        content: list[dict[str, Any]],
        purpose: str,
        document_id: str | None,
        role: ModelRole = "extractor",
        model: str | None = None,
        max_tokens: int = 4000,
        estimate_usd: float = 0.0,
    ) -> StructuredResult[T]:
        """One structured answer. `role` picks the model on each provider; an explicit `model` replaces it on
        the first provider tried (a failover uses the role's model of the next one)."""
        chain = provider_chain(self.settings)
        for index, provider in enumerate(chain):
            chosen = model if model is not None and index == 0 else self.settings.llm_model(role, provider)
            try:
                result = await self._structured_on(
                    provider,
                    chosen,
                    output=output,
                    system=system,
                    content=content,
                    purpose=purpose,
                    document_id=document_id,
                    max_tokens=max_tokens,
                    estimate_usd=estimate_usd,
                )
            except ProviderError as exc:
                refused = exc.status in REFUSED_STATUS and len(chain) > 1
                last = index == len(chain) - 1
                if refused:
                    if provider not in _REFUSED and not last:
                        logger.warning(
                            "%s refused the key (%s); structured calls go to %s",
                            LABELS[provider],
                            exc.status,
                            LABELS[chain[index + 1]],
                        )
                    _REFUSED.add(provider)
                if not refused or last:
                    raise
                continue
            _REFUSED.discard(provider)  # answering again: back to its place in the order
            return result
        raise ProviderError("No model provider is configured.", retryable=False)

    async def _structured_on(
        self,
        provider: LlmRoute,
        model: str,
        *,
        output: type[T],
        system: str,
        content: list[dict[str, Any]],
        purpose: str,
        document_id: str | None,
        max_tokens: int,
        estimate_usd: float,
    ) -> StructuredResult[T]:
        response_format = {
            "type": "json_schema",
            "json_schema": {"name": output.__name__, "strict": True, "schema": strict_json_schema(output)},
        }
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ]
        in_total, out_total, cost_total = 0, 0, 0.0
        for attempt in range(2):
            await check_budget(estimate_usd)
            payload = await self._post(
                provider, self._body(provider, model, messages, response_format, max_tokens)
            )
            usage = payload.get("usage") or {}
            in_tok, out_tok = usage.get("prompt_tokens"), usage.get("completion_tokens")
            returned_model = payload.get("model") or model
            reported = usage.get("cost")
            cost_usd = (
                float(reported)
                if isinstance(reported, int | float) and not isinstance(reported, bool)
                else token_cost(model, in_tok, out_tok)
            )
            in_total += int(in_tok or 0)
            out_total += int(out_tok or 0)
            cost_total += cost_usd
            text, finish, refusal = _answer(payload)
            ok = text is not None and finish != "length"
            await record_usage(
                Usage(provider, purpose, returned_model, in_tok, out_tok, None, cost_usd, ok), document_id
            )
            if finish == "length":
                raise OutputTruncatedError("The model's answer was cut off (too long).", retryable=False)
            if text is None:
                if refusal is not None:
                    raise ProviderError("The model declined to answer.", retryable=False)
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
