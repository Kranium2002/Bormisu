"""Hand-off types between grouping, extraction and finalisation (BACKEND.md 7.5-7.9).

plan_groups(document_id)              -> list[PageGroup]           (app.pipeline.group)
build_input(document_id, group)       -> ExtractionInput           (app.pipeline.extract)
extract_group(document_id, group, *, extractor=None) -> ExtractionOutcome   (app.pipeline.extract)
finalize_group(document_id, group, outcome) -> str | None (borehole uid)    (app.pipeline.finalize)
finalize_document(document_id)        -> None                      (app.pipeline.finalize)
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.pipeline.schemas import ExtractionResult


@dataclass(frozen=True)
class PageGroup:
    """Pages that describe one borehole, in reading order, plus the document's context pages.

    `key` is stable for the same pages and label; it becomes boreholes.group_key, so re-extraction is
    idempotent.
    A page that names several labels of a multi-hole sheet appears in several groups.
    """

    key: str
    label_raw: str | None
    label_canonical: str | None
    pages: tuple[int, ...]
    context_pages: tuple[int, ...] = ()  # summary/coordinate tables, legends of the same document
    # Reasons for a borehole_boundary clarification (label conflict, missing first sheet ...).
    uncertain: tuple[str, ...] = ()


@dataclass(frozen=True)
class BlockRef:
    """One OCR block as provenance needs it."""

    id: str  # "p{n}.b{i}"
    page: int
    text: str
    box: tuple[float, float, float, float] | None
    confidence: float | None
    page_text_quality: float | None  # text_layer_quality of the page (high -> value may be "read")
    page_handwriting: str | None


@dataclass(frozen=True)
class ExtractionInput:
    """What the extractor model sees for one group."""

    text: str  # OCR markdown of the group's pages with [[p7.b12]] block markers and HTML tables
    context_text: str  # same for context pages ("" when none)
    images: tuple[tuple[int, bytes], ...]  # (page, PNG) for handwritten or low-confidence pages only
    blocks: dict[str, BlockRef]
    estimated_tokens: int


@dataclass(frozen=True)
class ExtractionOutcome:
    result: ExtractionResult
    blocks: dict[str, BlockRef]
    run_id: str | None
    model: str | None
    cost_usd: float = 0.0
    # E.g. block ids the model cited that do not exist.
    warnings: tuple[str, ...] = field(default_factory=tuple)
