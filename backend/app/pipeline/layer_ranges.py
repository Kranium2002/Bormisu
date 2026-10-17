"""Strata whose description declares their own depth range ("*Soft rock / Depth : 2.3 ~ 35.6 m").

Many logs print a stratum heading with its range and then, in the same description column, notes for
depth sub-intervals inside it ("12.2~14.0m : joint set ...", "41.5~41.8m : fracture zone"). A reader that
cuts the column at every such note returns the notes as strata of their own. The printed heading says how
far the stratum reaches, so a row that lies inside it and is not a heading itself is part of it: its text is
appended to the stratum's description and the stratum ends where the last such row ends.

Generic for every language: only the shape "<words> <a> ~ <b> m" (a heading) against "<a> ~ <b> m ..." or
no range at all (a note) is used, never a word list.
"""

from __future__ import annotations

import re

from app.normalize import numbers
from app.pipeline.schemas import ExtractedLayer, RawValue

# "<a> ~ <b> m" with ~, -, en/em dash or "to"; the unit right after the second number (not cm or mm).
_RANGE = re.compile(
    r"(?P<a>[0-9]+(?:[.,][0-9]+)?)\s*(?:m\s*)?(?:~|〜|～|-|–|—)\s*"
    r"(?P<b>[0-9]+(?:[.,][0-9]+)?)[\s\-]*m(?![a-z])",
    re.IGNORECASE,
)
_LEADING_NOISE = " \t-–—*•·:;,"
TOLERANCE_M = 0.3


def _declared(text: str | None) -> tuple[tuple[float, float] | None, bool]:
    """(the first depth range the description prints, whether it is a heading: words before it)."""
    if not text:
        return None, False
    match = _RANGE.search(text)
    if match is None:
        return None, False
    a, b = (float(match.group(k).replace(",", ".")) for k in ("a", "b"))
    if b <= a:
        return None, False
    heading = bool(text[: match.start()].strip(_LEADING_NOISE))
    return (a, b), heading


def _depth(value: RawValue) -> float | None:
    return numbers.parse_number(value.raw).value if value.raw is not None else None


def _inside(
    span: tuple[float, float], top: float | None, base: float | None, own: tuple[float, float] | None
) -> bool:
    low, high = span[0] - TOLERANCE_M, span[1] + TOLERANCE_M
    depths = [d for d in (top, base) if d is not None]
    if own is not None:
        depths += list(own)
    return bool(depths) and all(low <= d <= high for d in depths)


def _join(first: RawValue, second: RawValue) -> RawValue:
    if second.raw is None:
        return first
    if first.raw is None:
        return second
    return RawValue(
        raw=f"{first.raw} {second.raw}",
        block_ids=list(dict.fromkeys([*first.block_ids, *second.block_ids])),
        state="ok" if first.state == "ok" or second.state == "ok" else first.state,
    )


def _text_join(first: str | None, second: str | None) -> str | None:
    return " ".join(t for t in (first, second) if t) or None


def merge_declared_ranges(layers: list[ExtractedLayer]) -> list[ExtractedLayer]:
    """Fold sub-interval notes into the stratum whose printed heading range encloses them."""
    out: list[ExtractedLayer] = []
    span: tuple[float, float] | None = None  # the heading range of out[-1], while notes may follow it
    for layer in layers:
        own, worded = _declared(layer.description_raw.raw)
        top, base = _depth(layer.from_raw), _depth(layer.to_raw)
        # a worded range is the stratum's own heading only when it holds the stratum's top: "lenses 2-3 m
        # thick" in a 0-5 m stratum, or "infilling: calcite, 61.7~62.0m" in a row from 51 m, are not
        heading = worded and own is not None and (top is None or _inside(own, top, None, None))
        # a row printing no range of its own that starts where the heading's range ends is the next stratum
        # (a seam thinner than the tolerance), not a note
        starts_inside = own is not None or top is None or (span is not None and top < span[1])
        if span is not None and starts_inside and not heading and out and _inside(span, top, base, own):
            host = out[-1]
            host_base = _depth(host.to_raw)
            to_raw = (
                layer.to_raw if base is not None and (host_base is None or base > host_base) else host.to_raw
            )
            out[-1] = host.model_copy(
                update={
                    "to_raw": to_raw,
                    "description_raw": _join(host.description_raw, layer.description_raw),
                    "english_lithology": _text_join(host.english_lithology, layer.english_lithology),
                }
            )
            continue
        out.append(layer)
        span = own if heading else None
    return out
