"""Shared provider plumbing: safe error messages, retries with backoff, the cost ledger, the budget guard."""

from __future__ import annotations

import asyncio
import email.utils
import logging
import random
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

import httpx
import yaml
from sqlalchemy import func, select

from app.config import get_settings
from app.db.models import ProviderCall
from app.db.session import get_sessionmaker

logger = logging.getLogger("geomemory.providers")

RETRY_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})
RATE_LIMITED = 429
MAX_BACKOFF_S = 30.0  # longest single backoff without a Retry-After
MAX_RETRY_AFTER_S = 60.0  # longest single wait a Retry-After can ask for
DETAIL_CHARS = 500  # start of a refused request's answer kept on the error (ProviderError.detail)


class ProviderError(RuntimeError):
    """A provider call failed. The message is safe to show (no response bodies, keys or internals); `detail`
    holds the start of a refused request's answer for the code to inspect, and is never shown or logged."""

    def __init__(
        self, message: str, *, retryable: bool, status: int | None = None, detail: str | None = None
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.detail = detail


class BudgetExceededError(ProviderError):
    def __init__(self, spent: float, budget: float) -> None:
        super().__init__(
            f"The provider budget of {budget:.2f} USD is used up ({spent:.2f} USD spent). "
            "Raise PROVIDER_BUDGET_USD to go on.",
            retryable=False,
        )


async def pause(seconds: float) -> None:
    """Wait between attempts (tests replace this)."""
    await asyncio.sleep(seconds)


def retry_after_s(headers: Mapping[str, str]) -> float | None:
    """Seconds an answer asks to wait: Retry-After as seconds or as an HTTP date, or retry-after-ms."""
    millis = headers.get("retry-after-ms")
    if millis:
        try:
            return max(0.0, float(millis) / 1000)
        except ValueError:
            pass
    value = (headers.get("retry-after") or "").strip()
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())


def _backoff(step: int, base_delay: float) -> float:
    return min(MAX_BACKOFF_S, base_delay * (2.0**step)) + random.uniform(0, 0.5 + base_delay / 2)  # noqa: S311


async def post_with_retries(
    client: httpx.AsyncClient,
    url: str,
    *,
    json: dict[str, Any],
    headers: dict[str, str],
    provider: str,
    attempts: int = 4,
    base_delay: float = 1.5,
    rate_limit_wait_s: float | None = None,
) -> httpx.Response:
    """POST with exponential backoff and jitter on 429/5xx and transport errors; other 4xx fail at once.

    A 429 (rate limit) is not counted as an attempt: it is retried, honouring Retry-After, until
    `rate_limit_wait_s` seconds of waiting are used (RATE_LIMIT_WAIT_S by default), so a burst of rate
    limiting never fails a call that a short wait saves. Then it fails as retryable with status 429.
    """
    budget = get_settings().rate_limit_wait_s if rate_limit_wait_s is None else rate_limit_wait_s
    waited = 0.0
    failures = 0
    limited = 0
    while True:
        last: ProviderError
        wait: float | None = None
        try:
            response = await asyncio.wait_for(
                client.post(url, json=json, headers=headers), timeout=get_settings().request_timeout_s
            )
        except (httpx.TimeoutException, TimeoutError):
            last = ProviderError(f"{provider} did not answer in time.", retryable=True)
        except httpx.HTTPError:
            last = ProviderError(f"{provider} is not reachable.", retryable=True)
        else:
            status = response.status_code
            if status < 400:
                return response
            if status == RATE_LIMITED:
                asked = retry_after_s(response.headers)
                delay = min(asked, MAX_RETRY_AFTER_S) if asked is not None else _backoff(limited, base_delay)
                limited += 1
                if waited >= budget:
                    logger.warning("%s still rate-limited after %.0f s of waiting", provider, waited)
                    raise ProviderError(
                        f"{provider} is rate-limited (429) and did not accept the request after "
                        f"{waited:.0f} s of waiting.",
                        retryable=True,
                        status=status,
                    )
                delay = min(delay, budget - waited)
                waited += delay
                await pause(delay)
                continue
            retryable = status in RETRY_STATUS
            last = ProviderError(
                f"{provider} refused the request ({status}).",
                retryable=retryable,
                status=status,
                detail=None if retryable else response.text[:DETAIL_CHARS],
            )
            if not retryable:
                logger.warning("%s returned %s", provider, status)
                raise last
            asked = retry_after_s(response.headers)
            wait = None if asked is None else min(asked, MAX_BACKOFF_S)
        failures += 1
        if failures >= attempts:
            raise last
        await pause(wait if wait is not None else _backoff(failures - 1, base_delay))


@lru_cache
def price_table() -> dict[str, Any]:
    path = get_settings().price_table
    if not path.exists():
        return {"models": {}, "ocr": {}}
    with path.open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle) or {}
    return data


# Models without a row in data/prices.yaml seen in this process (warned about once; e.g. local models).
_UNPRICED: set[str] = set()


def token_cost(model: str, input_tokens: int | None, output_tokens: int | None) -> float:
    """Cost from data/prices.yaml; 0 for a model it has no row for (expected for local models, e.g. on
    Ollama; logged once per model)."""
    entry = price_table().get("models", {}).get(model)
    if entry is None:
        if model not in _UNPRICED:
            _UNPRICED.add(model)
            logger.warning("no price for model %s; its calls are logged at cost 0", model)
        return 0.0
    return (input_tokens or 0) / 1e6 * float(entry["input_per_million"]) + (output_tokens or 0) / 1e6 * float(
        entry["output_per_million"]
    )


def ocr_cost(model: str, pages: int) -> float:
    table = price_table().get("ocr", {})
    entry = table.get(model) or table.get("default")
    return 0.0 if entry is None else pages / 1000 * float(entry["per_thousand_pages"])


@dataclass(frozen=True)
class Usage:
    provider: str
    purpose: str
    model: str | None
    input_tokens: int | None = None
    output_tokens: int | None = None
    pages: int | None = None
    cost_usd: float = 0.0
    ok: bool = True


async def spent_usd() -> float:
    async with get_sessionmaker()() as session:
        total = await session.scalar(select(func.coalesce(func.sum(ProviderCall.cost_usd), 0.0)))
        return float(total or 0.0)


async def check_budget(estimate_usd: float = 0.0) -> None:
    """Refuse a paid call when PROVIDER_BUDGET_USD would be exceeded."""
    budget = get_settings().provider_budget_usd
    if budget is None:
        return
    spent = await spent_usd()
    if spent + estimate_usd > budget:
        raise BudgetExceededError(spent, budget)


async def record_usage(usage: Usage, document_id: str | None) -> None:
    """Write the ledger row in its own transaction, so a later failure never loses the record of a charge."""
    async with get_sessionmaker()() as session:
        session.add(
            ProviderCall(
                document_id=document_id,
                provider=usage.provider,
                purpose=usage.purpose,
                model=usage.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                pages=usage.pages,
                cost_usd=usage.cost_usd,
                ok=usage.ok,
            )
        )
        await session.commit()
    logger.info(
        "provider call %s/%s model=%s pages=%s tokens=%s/%s cost=%.5f USD",
        usage.provider,
        usage.purpose,
        usage.model,
        usage.pages,
        usage.input_tokens,
        usage.output_tokens,
        usage.cost_usd,
    )
