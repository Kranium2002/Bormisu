"""Thin wrapper around `bh3.llm.LLM.complete_vision_json` for the four vision calls.

Adds: a per-run ledger (calls, cache hits, tokens, errors), a thread pool, one automatic downscale-and-retry
when the server says the image is too large, and truncation reporting so the caller can re-tile.
Everything provider-specific stays in bh3.llm; this module only speaks "image + schema → dict".
"""
from __future__ import annotations

import io
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional, TypeVar

from .llm import LLM

from . import prompts
from .schemas import (CLASSIFY_SCHEMA, HEADER_SCHEMA, PROMPT_VERSION, TILE_LOG_SCHEMA, TILE_LOG_SYMBOL_SCHEMA, TILE_SPT_SCHEMA)

log = logging.getLogger(__name__)
T = TypeVar("T")
R = TypeVar("R")

MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


@dataclass
class Ledger:
    calls: int = 0
    cache_hits: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_s: float = 0.0
    truncated: int = 0
    errors: dict[str, int] = field(default_factory=dict)
    by_kind: dict[str, int] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, kind: str, meta: dict) -> None:
        with self._lock:
            self.calls += meta.get("calls", 0)
            self.cache_hits += 1 if meta.get("cache_hit") else 0
            self.prompt_tokens += meta.get("prompt_tokens", 0)
            self.completion_tokens += meta.get("completion_tokens", 0)
            self.latency_s += meta.get("latency_s", 0.0)
            self.truncated += 1 if meta.get("truncated") else 0
            self.by_kind[kind] = self.by_kind.get(kind, 0) + 1
            if meta.get("error"):
                self.errors[meta["error"]] = self.errors.get(meta["error"], 0) + 1

    def summary(self) -> str:
        return (f"vision calls={self.calls} cache_hits={self.cache_hits} tokens={self.prompt_tokens}+{self.completion_tokens} "
                f"(≈ ${cost_usd(self.prompt_tokens, self.completion_tokens):.2f}) latency={self.latency_s:.0f}s truncated={self.truncated} "
                f"by_kind={self.by_kind} errors={self.errors}")


class BudgetExceeded(RuntimeError):
    """Raised before a model call that would exceed the per-run budget (calls or tokens)."""


PRICE_IN = float(os.environ.get("LLM_PRICE_IN", "1.5"))      # $ per million prompt tokens (Mistral Medium 3.5 list)
PRICE_OUT = float(os.environ.get("LLM_PRICE_OUT", "7.5"))    # $ per million completion tokens


def cost_usd(prompt_tokens: int, completion_tokens: int) -> float:
    return prompt_tokens / 1e6 * PRICE_IN + completion_tokens / 1e6 * PRICE_OUT


class VLM:
    def __init__(self, llm: LLM, workers: Optional[int] = None, max_tokens: Optional[int] = None,
                 max_calls: Optional[int] = None, max_total_tokens: Optional[int] = None):
        self.llm = llm
        self.workers = workers or int(os.environ.get("BH_VLM_WORKERS", "4"))
        self.max_tokens = max_tokens or int(os.environ.get("BH_VLM_MAX_TOKENS", "4096"))
        # optional per-run limits (0 = none): a run stops cleanly, outputs still written, when one is reached
        self.max_calls = max_calls if max_calls is not None else int(os.environ.get("BH_VLM_MAX_CALLS", "0"))
        self.max_total_tokens = max_total_tokens if max_total_tokens is not None else int(os.environ.get("BH_VLM_MAX_TOTAL_TOKENS", "0"))
        self.ledger = Ledger()
        self.budget_hit = False

    def check_budget(self) -> None:
        with self.ledger._lock:
            calls, toks = self.ledger.calls, self.ledger.prompt_tokens + self.ledger.completion_tokens
        if (self.max_calls and calls >= self.max_calls) or (self.max_total_tokens and toks >= self.max_total_tokens):
            self.budget_hit = True
            raise BudgetExceeded(f"budget reached: {calls} calls, {toks:,} tokens (≈ ${self.cost():.2f}); "
                                 f"limits {self.max_calls} calls / {self.max_total_tokens:,} tokens. "
                                 f"Raise with --max-calls/--max-tokens-total or BH_VLM_MAX_CALLS/BH_VLM_MAX_TOTAL_TOKENS; re-run with resume to continue.")

    def cost(self) -> float:
        return cost_usd(self.ledger.prompt_tokens, self.ledger.completion_tokens)

    @property
    def enabled(self) -> bool:
        return self.llm.cfg.enabled

    # -- generic call ----------------------------------------------------------
    def call(self, image_path: str | Path, system: str, user: str, schema: dict, name: str,
             max_tokens: Optional[int] = None, model: Optional[str] = None) -> tuple[Optional[dict], dict]:
        image_path = Path(image_path)
        data = image_path.read_bytes()
        mime = MIME.get(image_path.suffix.lower(), "image/jpeg")
        self.check_budget()                       # cached answers never reach the model and never count
        out, meta = self.llm.complete_vision_json(data, mime, system, user, schema, name, model=model,
                                                  max_tokens=max_tokens or self.max_tokens, prompt_version=PROMPT_VERSION)
        if out is None and meta.get("error") == "image-too-large":
            small = _downscale(data, 0.7)
            log.info("%s: image too large for the server, retrying at 70%% (%d → %d bytes)", image_path.name, len(data), len(small))
            out, meta2 = self.llm.complete_vision_json(small, "image/jpeg", system, user, schema, name, model=model,
                                                       max_tokens=max_tokens or self.max_tokens, prompt_version=PROMPT_VERSION)
            meta2["calls"] += meta.get("calls", 0)
            meta2["downscaled"] = True
            meta = meta2
        self.ledger.add(name, meta)
        return out, meta

    # -- the four calls --------------------------------------------------------
    def classify(self, image_path: str | Path) -> tuple[Optional[dict], dict]:
        return self.call(image_path, prompts.SYSTEM_CLASSIFY, prompts.USER_CLASSIFY, CLASSIFY_SCHEMA, "classify",
                         max_tokens=600)

    def tile_log(self, image_path: str | Path, hint: str = "", symbols: bool = False) -> tuple[Optional[dict], dict]:
        user = prompts.USER_TILE_LOG + (f"\nContext: {hint}" if hint else "")
        if symbols:
            return self.call(image_path, prompts.SYSTEM_TILE_LOG_SYMBOLS, user, TILE_LOG_SYMBOL_SCHEMA, "tile_log")
        return self.call(image_path, prompts.SYSTEM_TILE_LOG, user, TILE_LOG_SCHEMA, "tile_log")

    def tile_spt(self, image_path: str | Path, hint: str = "") -> tuple[Optional[dict], dict]:
        user = prompts.USER_TILE_SPT + (f"\nContext: {hint}" if hint else "")
        return self.call(image_path, prompts.SYSTEM_TILE_SPT, user, TILE_SPT_SCHEMA, "tile_spt")

    def header(self, image_path: str | Path) -> tuple[Optional[dict], dict]:
        return self.call(image_path, prompts.SYSTEM_HEADER, prompts.USER_HEADER, HEADER_SCHEMA, "header", max_tokens=1200)

    # -- parallel map ----------------------------------------------------------
    def map(self, fn: Callable[[T], R], items: Iterable[T]) -> list[R]:
        items = list(items)
        if not items:
            return []
        if self.workers <= 1 or len(items) == 1:
            return [fn(x) for x in items]
        with ThreadPoolExecutor(max_workers=self.workers) as ex:
            return list(ex.map(fn, items))


def _downscale(data: bytes, factor: float) -> bytes:
    from PIL import Image
    im = Image.open(io.BytesIO(data)).convert("RGB")
    im = im.resize((max(1, int(im.width * factor)), max(1, int(im.height * factor))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue()
