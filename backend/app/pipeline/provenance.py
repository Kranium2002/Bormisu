"""Provenance of extracted values from the OCR blocks the model cited (BACKEND.md 7.6).

For one value (or a value Python computed from several printed values):
- page and box: the union of the cited blocks' boxes on the first cited page in the group's reading order;
  blocks on other pages do not widen the box;
- raw: the printed text;
- method: `read` when every cited block lies on a page whose text layer is trustworthy, else `ocr`
  (callers override it with `derived` or `guessed` for computed or assumed values);
- confidence: the lowest confidence of the cited blocks.

Block ids the model cited that do not exist are ignored. Nothing here knows about documents or layouts.
"""

from __future__ import annotations

import enum
from collections.abc import Iterable, Mapping, Sequence
from typing import Final, Literal

from app.pipeline.schemas import RawValue, ValueStateLiteral
from app.pipeline.types import BlockRef
from app.schemas.boreholes import ProvenanceIn

MethodLiteral = Literal["read", "ocr", "derived", "guessed", "edited"]

# A page's embedded text layer is trusted as the source ("read") from this text_layer_quality upwards.
READ_MIN_TEXT_QUALITY = 0.9
_BOX_DECIMALS = 6


class _Default(enum.Enum):
    TOKEN = 0


# `raw` not given: the printed text of the cited values.
DEFAULT_RAW: Final = _Default.TOKEN


def printed(value: RawValue | None) -> str | None:
    """The printed text of a value whose state is ok, stripped; None when absent or not readable."""
    if value is None or value.state != "ok" or value.raw is None:
        return None
    text = value.raw.strip()
    return text or None


def union_box(boxes: Iterable[Sequence[float] | None]) -> list[float] | None:
    """[x, y, w, h] covering every box (normalised 0-1, clamped to the page); None without boxes."""
    x0 = y0 = 1.0
    x1 = y1 = 0.0
    found = False
    for box in boxes:
        if box is None or len(box) != 4:
            continue
        x, y, w, h = (float(v) for v in box)
        if w < 0 or h < 0:
            continue
        found = True
        x0, y0 = min(x0, x), min(y0, y)
        x1, y1 = max(x1, x + w), max(y1, y + h)
    if not found:
        return None
    x0, y0 = min(max(x0, 0.0), 1.0), min(max(y0, 0.0), 1.0)
    x1, y1 = min(max(x1, x0), 1.0), min(max(y1, y0), 1.0)
    return [round(v, _BOX_DECIMALS) for v in (x0, y0, x1 - x0, y1 - y0)]


def method_of(blocks: Sequence[BlockRef]) -> MethodLiteral:
    """`read` when every block lies on a page with a trustworthy text layer, else `ocr`."""
    if blocks and all(
        b.page_text_quality is not None and b.page_text_quality >= READ_MIN_TEXT_QUALITY for b in blocks
    ):
        return "read"
    return "ocr"


def lowest_confidence(blocks: Iterable[BlockRef]) -> float | None:
    values = [min(max(b.confidence, 0.0), 1.0) for b in blocks if b.confidence is not None]
    return min(values) if values else None


class Citations:
    """Resolves cited block ids of one page group into provenance entries."""

    def __init__(
        self, blocks: Mapping[str, BlockRef], *, document_id: str, page_order: Sequence[int] = ()
    ) -> None:
        self.blocks = blocks
        self.document_id = document_id
        self._order: dict[int, int] = {}
        for page in page_order:
            self._order.setdefault(page, len(self._order))

    def page_key(self, page: int) -> tuple[int, int]:
        """Reading order: the group's pages, then its context pages, then any other page by number."""
        return (self._order.get(page, len(self._order)), page)

    def blocks_of(self, *values: RawValue | None) -> list[BlockRef]:
        """The existing blocks cited by `values`, in citation order, each once."""
        seen: set[str] = set()
        found: list[BlockRef] = []
        for value in values:
            if value is None:
                continue
            for block_id in value.block_ids:
                block = self.blocks.get(block_id)
                if block is not None and block.id not in seen:
                    seen.add(block.id)
                    found.append(block)
        return found

    def locate(self, blocks: Sequence[BlockRef]) -> tuple[int | None, list[float] | None]:
        """First cited page in reading order and the union of the cited boxes on it."""
        if not blocks:
            return None, None
        page = min((b.page for b in blocks), key=self.page_key)
        return page, union_box(b.box for b in blocks if b.page == page)

    def entry(
        self,
        *values: RawValue | None,
        raw: str | _Default | None = DEFAULT_RAW,
        method: MethodLiteral | None = None,
        state: ValueStateLiteral | None = None,
        extra_blocks: Sequence[BlockRef] = (),
    ) -> ProvenanceIn:
        """Provenance for a value printed in (or computed from) `values`.

        `raw` defaults to the printed text of a single value, or the printed texts of several joined by
        " / " (pass None for a value that has no printed text of its own); `state` defaults to the single
        value's state (ok for computed values).
        """
        blocks = self.blocks_of(*values)
        for block in extra_blocks:
            if all(b.id != block.id for b in blocks):
                blocks.append(block)
        page, box = self.locate(blocks)
        present = [v for v in values if v is not None]
        if isinstance(raw, _Default):
            texts = [v.raw.strip() for v in present if v.raw is not None and v.raw.strip()]
            raw = " / ".join(dict.fromkeys(texts)) or None
        if state is None:
            state = _state_of(present[0]) if len(present) == 1 else "ok"
        return ProvenanceIn(
            document_id=self.document_id,
            page=page,
            box=box,
            raw=raw,
            method=method or method_of(blocks),
            confidence=lowest_confidence(blocks),
            state=state,
        )

    def needed(self, value: RawValue | None, result: object) -> bool:
        """Whether a value gets a provenance entry: it has a value, or the model cited blocks for it, or it
        is illegible, or text was printed that could not be read as the field's type."""
        if result is not None:
            return True
        if value is None:
            return False
        if value.state == "illegible" or value.block_ids:
            return True
        return printed(value) is not None


def _state_of(value: RawValue) -> ValueStateLiteral:
    if value.state == "ok" and (value.raw is None or not value.raw.strip()):
        return "not_in_source"
    return value.state
