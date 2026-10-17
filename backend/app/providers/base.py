"""Shared provider plumbing: safe error messages, retries with backoff, the cost ledger, the budget guard."""

from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import dataclass
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


class ProviderError(RuntimeError):
    """A provider call failed. The message is safe to show (no response bodies, keys or internals)."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status


class BudgetExceededError(ProviderError):
    def __init__(self, spent: float, budget: float) -> None:
        super().__init__(
            f"The provider budget of {budget:.2f} USD is used up ({spent:.2f} USD spent). "
            "Raise PROVIDER_BUDGET_USD to go on.",
            retryable=False,
        )


async def post_with_retries(
    client: httpx.AsyncClient,
    url: str,
    *,
    json: dict[str, Any],
    headers: dict[str, str],
    provider: str,
    attempts: int = 4,
    base_delay: float = 1.5,
) -> httpx.Response:
    """POST with exponential backoff on 429/5xx and transport errors; other 4xx fail at once."""
    last: ProviderError | None = None
    for attempt in range(attempts):
        try:
            response = await client.post(url, json=json, headers=headers)
        except httpx.TimeoutException:
            last = ProviderError(f"{provider} did not answer in time.", retryable=True)
        except httpx.HTTPError:
            last = ProviderError(f"{provider} is not reachable.", retryable=True)
        else:
            if response.status_code < 400:
                return response
            retryable = response.status_code in RETRY_STATUS
            last = ProviderError(
                f"{provider} refused the request ({response.status_code}).",
                retryable=retryable,
                status=response.status_code,
            )
            if not retryable:
                logger.warning("%s returned %s", provider, response.status_code)
                raise last
            retry_after = response.headers.get("retry-after")
            if retry_after and retry_after.isdigit():
                await asyncio.sleep(min(float(retry_after), 30.0))
                continue
        if attempt < attempts - 1:
            await asyncio.sleep(base_delay * (2**attempt) + random.uniform(0, 0.5))  # noqa: S311
    assert last is not None
    raise last


@lru_cache
def price_table() -> dict[str, Any]:
    path = get_settings().price_table
    if not path.exists():
        return {"models": {}, "ocr": {}}
    with path.open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle) or {}
    return data


def token_cost(model: str, input_tokens: int | None, output_tokens: int | None) -> float:
    entry = price_table().get("models", {}).get(model)
    if entry is None:
        logger.warning("no price for model %s; cost logged as 0", model)
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
