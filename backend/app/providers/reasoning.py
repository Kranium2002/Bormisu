"""Reasoning ("thinking") per model on OpenRouter (data/reasoning.yaml).

Document calls copy printed text: they are sent with reasoning off (`{"enabled": false}`) unless LLM_REASONING
asks for it, because reasoning tokens count against max_tokens and cost money. Some models refuse that with a
400 "Reasoning is mandatory for this endpoint and cannot be disabled": the models data/reasoning.yaml lists
get reasoning `{"effort": <effort>}` from the first call, and a model not listed that answers the 400 is
retried once with it and remembered for the rest of the process (`learn`). A call with reasoning on gets
`extra_output_tokens` more output tokens, so the answer still fits after the thinking.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import yaml

from app.config import get_settings

MANDATORY_MARKER = "reasoning is mandatory"
FILE = "reasoning.yaml"

# Models that answered "Reasoning is mandatory" in this process.
_LEARNED: set[str] = set()


@dataclass(frozen=True)
class ReasoningConfig:
    mandatory: tuple[str, ...]
    effort: str
    extra_output_tokens: int


@lru_cache
def config() -> ReasoningConfig:
    path = get_settings().data_dir / FILE
    data: dict[str, Any] = {}
    if path.exists():
        with path.open(encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    return ReasoningConfig(
        mandatory=tuple(str(p).lower() for p in data.get("mandatory") or ()),
        effort=str(data.get("effort") or "low"),
        extra_output_tokens=int(data.get("extra_output_tokens") or 0),
    )


def required(model: str) -> bool:
    """True when the model cannot run with reasoning off (listed, or refused it earlier in this process). A
    listed "vendor/model" pattern also matches the bare model id a vendor's own server uses."""
    name = model.lower()
    patterns = config().mandatory
    bare = [p.split("/", 1)[1] for p in patterns if "/" in p]
    return name in _LEARNED or any(fnmatch.fnmatchcase(name, p) for p in (*patterns, *bare))


def plain_fields(model: str, level: str | None = None) -> dict[str, Any]:
    """OpenAI-style reasoning field for another OpenAI-compatible server (a vendor's own endpoint, a local
    server): `reasoning_effort` only when reasoning is on (LLM_REASONING, or a model that requires it); with
    reasoning off nothing is sent, so a server that knows no such field is never confused by it."""
    field = openrouter_reasoning(model, level)
    return {} if is_off(field) else {"reasoning_effort": str(field.get("effort") or config().effort)}


def learn(model: str) -> None:
    _LEARNED.add(model.lower())


def is_off(field: Any) -> bool:
    return isinstance(field, dict) and field.get("enabled") is False


def mandatory_error(detail: str | None) -> bool:
    """True when an error body says the model refuses reasoning off."""
    return detail is not None and MANDATORY_MARKER in detail.lower()


def openrouter_reasoning(model: str, level: str | None = None) -> dict[str, Any]:
    """OpenRouter's `reasoning` field for a call: LLM_REASONING (or `level`) when not off, else off unless the
    model requires reasoning, then the configured effort."""
    level = get_settings().llm_reasoning if level is None else level
    if level != "off":
        return {"effort": level}
    if required(model):
        return {"effort": config().effort}
    return {"enabled": False}


def output_tokens(max_tokens: int, field: Any) -> int:
    """max_tokens for a call with this `reasoning` field: room for the thinking when it is on."""
    return max_tokens if field is None or is_off(field) else max_tokens + config().extra_output_tokens


def with_reasoning(body: dict[str, Any]) -> dict[str, Any]:
    """The body again with reasoning on at the configured effort (and room for it in max_tokens)."""
    field = {"effort": config().effort}
    out = {**body, "reasoning": field}
    if isinstance(body.get("max_tokens"), int):
        out["max_tokens"] = output_tokens(body["max_tokens"], field)
    return out
