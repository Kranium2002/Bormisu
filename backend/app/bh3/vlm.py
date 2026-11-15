"""Thin wrapper around `bh3.llm.LLM.complete_vision_json` for the four vision calls.

Adds: a per-run ledger (calls, cache hits, tokens, errors), a thread pool, one automatic downscale-and-retry
when the server says the image is too large, and truncation reporting so the caller can re-tile.
Everything provider-specific stays in bh3.llm; this module only speaks "image + schema → dict".
"""
from __future__ import annotations

import io
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional, TypeVar

from .llm import LLM, BudgetExceeded

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


class VLM:
    def __init__(self, llm: LLM, workers: Optional[int] = None, max_tokens: Optional[int] = None,
                 guard: Optional[Callable[[], None]] = None):
        self.llm = llm
        self.workers = workers or 1
        self.max_tokens = max_tokens or 4096
        self.guard = guard            # the backend's budget check before every paid call; raises BudgetExceeded
        self.ledger = Ledger()
        self.budget_hit = False

    def check_budget(self) -> None:
        if self.guard is not None:
            try:
                self.guard()
            except BudgetExceeded:
                self.budget_hit = True
                raise

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
