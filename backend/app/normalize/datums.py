"""Depth origin and sign convention from printed notes (BACKEND.md 7.8).

Phrases per origin (ground, mudline, seabed, relative) and the sign-convention patterns are in
data/units.yaml (`depth_origins`, `negative_down_patterns`, `positive_down_patterns`), in several
languages. A specific origin wins over "relative to ..."; two different specific origins, or notes that
say both "negative down" and "positive down", are a contradiction and give None with a reason.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from app.normalize.api import DepthOrigin
from app.normalize.numbers import load_data, str_list, word_pattern

Origin = Literal["ground", "mudline", "seabed", "relative"]
_SPECIFIC: tuple[Origin, ...] = ("ground", "mudline", "seabed")


@dataclass(frozen=True)
class _Vocabulary:
    origins: tuple[tuple[Origin, re.Pattern[str]], ...]
    negative_down: tuple[re.Pattern[str], ...]
    positive_down: tuple[re.Pattern[str], ...]


def _prepare(text: str) -> str:
    folded = unicodedata.normalize("NFC", text).casefold()
    return re.sub(r"\s+", " ", folded).strip()


@lru_cache(maxsize=1)
def _vocabulary() -> _Vocabulary:
    data = load_data("units.yaml")
    origins_data = data.get("depth_origins") or {}
    origins: list[tuple[Origin, re.Pattern[str]]] = []
    all_origins: tuple[Origin, ...] = ("ground", "mudline", "seabed", "relative")
    for origin in all_origins:
        phrases = sorted((_prepare(p) for p in str_list(origins_data.get(origin))), key=len, reverse=True)
        if phrases:
            origins.append((origin, re.compile("|".join(word_pattern(p) for p in phrases))))
    return _Vocabulary(
        origins=tuple(origins),
        negative_down=tuple(
            re.compile(p, re.IGNORECASE) for p in str_list(data.get("negative_down_patterns"))
        ),
        positive_down=tuple(
            re.compile(p, re.IGNORECASE) for p in str_list(data.get("positive_down_patterns"))
        ),
    )


def parse_depth_origin(note_raw: str | None, datum_raw: str | None = None) -> DepthOrigin:
    """The depth origin and sign convention stated by the printed note (and printed datum)."""
    texts = [t for t in (note_raw, datum_raw) if t and t.strip()]
    if not texts:
        return DepthOrigin(None, reason="no depth note printed")
    text = _prepare(" | ".join(texts))[:2000]
    vocab = _vocabulary()
    found = [origin for origin, pattern in vocab.origins if pattern.search(text)]
    specific = [o for o in found if o in _SPECIFIC]
    reasons: list[str] = []
    origin: Origin | None
    if len(specific) > 1:
        origin = None
        reasons.append(f"the note names more than one depth origin ({', '.join(specific)})")
    elif specific:
        origin = specific[0]
    elif "relative" in found:
        origin = "relative"
    else:
        origin = None
        reasons.append("no depth origin stated")

    negative = any(p.search(text) for p in vocab.negative_down)
    positive = any(p.search(text) for p in vocab.positive_down)
    negative_down: bool | None
    if negative and positive:
        negative_down = None
        reasons.append("the note states both sign conventions")
    elif negative:
        negative_down = True
    elif positive:
        negative_down = False
    else:
        negative_down = None
    return DepthOrigin(origin, negative_down=negative_down, reason="; ".join(reasons) or None)
