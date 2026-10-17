"""Test doubles for providers. Never used by the running app; tests inject them.

FakeOcrEngine answers like Mistral OCR from the text layer of the (fictional) PDF it is sent, so its blocks
carry exact boxes. FakeClassifier labels pages from their text with simple keyword rules supplied by the test.
FakeExtractor answers like the extractor model for the fictional log layout the tests generate (one OCR block
per printed line), citing the block ids it read. FakeRereader answers second reads of crops with the OCR text
inside each crop, changed where a test says so.
"""

from __future__ import annotations

import io
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import pypdfium2 as pdfium

from app.db.models import Page
from app.pipeline.reread import CropImage, CropReading, RereadAnswer
from app.pipeline.schemas import (
    ExtractedGroundwater,
    ExtractedHeader,
    ExtractedLayer,
    ExtractionResult,
    PageLabel,
    RawCoordinates,
    RawValue,
)
from app.pipeline.types import ExtractionInput
from app.providers.base import ProviderError, Usage, check_budget, record_usage
from app.providers.ocr_mistral import OcrResponse

FAKE_DPI = 200


def _lines(textpage: pdfium.PdfTextPage) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Group characters into lines (by baseline) with their union boxes in PDF points."""
    count = textpage.count_chars()
    lines: list[tuple[str, tuple[float, float, float, float]]] = []
    text, box = "", None
    for i in range(count):
        ch = textpage.get_text_range(i, 1)
        if ch in ("\r", "\n"):
            if text.strip() and box is not None:
                lines.append((text.strip(), box))
            text, box = "", None
            continue
        left, bottom, right, top = textpage.get_charbox(i)
        if ch.strip():
            box = (
                (left, bottom, right, top)
                if box is None
                else (min(box[0], left), min(box[1], bottom), max(box[2], right), max(box[3], top))
            )
        text += ch
    if text.strip() and box is not None:
        lines.append((text.strip(), box))
    return lines


@dataclass
class FakeOcrEngine:
    """Mistral-shaped OCR from a PDF's own text layer. `confidence` maps a substring to a block confidence."""

    confidence: dict[str, float] = field(default_factory=dict)
    default_confidence: float = 0.97
    calls: int = 0
    pages_seen: int = 0
    # Set by the OCR stage before each call: the document pages in the request. The stage sends image-only
    # PDFs rebuilt from renders, so the fake reads the same pages of the original PDF's text layer instead.
    current_pages: list[int] | None = None

    async def ocr(self, data: bytes, mime: str, *, document_id: str | None, page_count: int) -> OcrResponse:
        self.calls += 1
        original = await _original_pages(document_id, self.current_pages)
        if original is not None:
            data, mime = original, "application/pdf"
        pages: list[dict[str, Any]] = []
        if mime != "application/pdf":
            pages.append({"index": 0, "markdown": "", "tables": [], "blocks": [], "dimensions": None})
        else:
            pdf = pdfium.PdfDocument(io.BytesIO(data))
            try:
                for index in range(len(pdf)):
                    page = pdf[index]
                    width_pt, height_pt = page.get_size()
                    scale = FAKE_DPI / 72
                    width_px, height_px = round(width_pt * scale), round(height_pt * scale)
                    textpage = page.get_textpage()
                    blocks = []
                    for text, (left, bottom, right, top) in _lines(textpage):
                        conf = next(
                            (c for key, c in self.confidence.items() if key in text), self.default_confidence
                        )
                        blocks.append(
                            {
                                "type": "text",
                                "content": text,
                                "top_left_x": round(left * scale),
                                "top_left_y": round((height_pt - top) * scale),
                                "bottom_right_x": round(right * scale),
                                "bottom_right_y": round((height_pt - bottom) * scale),
                                "confidence_scores": {
                                    "average_content_confidence_score": conf,
                                    "minimum_content_confidence_score": conf,
                                },
                            }
                        )
                    textpage.close()
                    page.close()
                    pages.append(
                        {
                            "index": index,
                            "markdown": "\n\n".join(b["content"] for b in blocks),
                            "tables": [],
                            "blocks": blocks,
                            "dimensions": {"dpi": FAKE_DPI, "width": width_px, "height": height_px},
                        }
                    )
            finally:
                pdf.close()
        self.pages_seen += len(pages)
        raw = {"pages": pages, "model": "fake-ocr", "usage_info": {"pages_processed": len(pages)}}
        return OcrResponse(raw, "fake-ocr", len(pages))


@dataclass
class FakeClassifier:
    """Labels a page with `rule(text)`; counts calls. Text comes from the page's text layer when present."""

    rule: Callable[[str], PageLabel]
    calls: int = 0
    escalations: int = 0

    async def label(self, page: Page, image_png: bytes, text: str | None, *, escalate: bool) -> PageLabel:
        self.calls += 1
        if escalate:
            self.escalations += 1
        return self.rule(text or "")


def label(role: str, **fields: Any) -> PageLabel:
    """A PageLabel with neutral defaults for tests."""
    base: dict[str, Any] = {
        "role": role,
        "borehole_labels": [],
        "sheet_label": None,
        "sheet_index": None,
        "sheet_total": None,
        "handwriting": "none",
        "language": "en",
        "has_coordinates": False,
        "has_depth_scale": False,
        "is_continuation": False,
        "confidence": 0.95,
        "reason": "fictional test label",
    }
    base.update(fields)
    return PageLabel.model_validate(base)


# ----------------------------------------------------------------------------------------------
# Extraction
# ----------------------------------------------------------------------------------------------

# The fictional layout of the test PDFs, one printed line per OCR block:
#   BOREHOLE LOG FX-1
#   Project: Fictional Depot Extension
#   Easting 413 210,5  Northing 5 316 044,2  (ETRS89 / UTM 32N)     the system in brackets is optional
#   Depth (m)
#   0,00 - 1,20  Sand, schluffig
#   Groundwater at 2,10
#   Final depth 6,00 m
_BLOCK_LINE = re.compile(r"^\[\[(?P<id>p\d+\.b\d+)\]\] ")
_LABEL = re.compile(r"^BOREHOLE LOG\s+(?P<value>\S+)$")
_PROJECT = re.compile(r"^Project:\s*(?P<value>\S.*)$")
_COORDINATES = re.compile(
    r"^(?P<x_label>Easting)\s+(?P<x>\d[\d ,.]*\d)\s+(?P<y_label>Northing)\s+(?P<y>\d[\d ,.]*\d)"
    r"(?:\s+\((?P<system>[^)]+)\))?$"
)
_DEPTH_UNIT = re.compile(r"^Depth\s*[(\[][^)\]]+[)\]]$")
_LAYER = re.compile(r"^(?P<top>\d+(?:[.,]\d+)?)\s*-\s*(?P<base>\d+(?:[.,]\d+)?)\s+(?P<description>\D.*)$")
_GROUNDWATER = re.compile(r"^Groundwater at\s+(?P<value>\d+(?:[.,]\d+)?)$")
_TOTAL_DEPTH = re.compile(r"^Final depth\s+(?P<value>\S.*)$")


def _printed(raw: str, block_id: str) -> RawValue:
    return RawValue(raw=raw, block_ids=[block_id], state="ok")


def _absent() -> RawValue:
    return RawValue(raw=None, block_ids=[], state="not_in_source")


def _log_lines(inp: ExtractionInput) -> list[tuple[str, str]]:
    """(block id, printed text) of the group's log pages in reading order; context pages are not read."""
    lines: list[tuple[str, str]] = []
    for line in inp.text.splitlines():
        match = _BLOCK_LINE.match(line)
        if match is None:
            continue
        block = inp.blocks.get(match.group("id"))
        text = block.text if block is not None else line[match.end() :]
        lines.append((match.group("id"), " ".join(text.split())))
    return lines


def fake_extraction(inp: ExtractionInput) -> ExtractionResult:
    """What a careful model would return for the fictional layout above: raw text plus cited block ids."""
    head: dict[str, RawValue] = {}
    coordinates: dict[str, RawValue] = {}
    layers: list[ExtractedLayer] = []
    groundwater: list[ExtractedGroundwater] = []
    for block_id, text in _log_lines(inp):
        if (m := _LABEL.match(text)) is not None:
            head.setdefault("borehole_label", _printed(m.group("value"), block_id))
        elif (m := _PROJECT.match(text)) is not None:
            head.setdefault("project", _printed(m.group("value"), block_id))
        elif (m := _COORDINATES.match(text)) is not None and not coordinates:
            system = m.group("system")
            coordinates = {
                "x_raw": _printed(m.group("x"), block_id),
                "y_raw": _printed(m.group("y"), block_id),
                "labels_raw": _printed(f"{m.group('x_label')}, {m.group('y_label')}", block_id),
                "system_raw": _printed(system, block_id) if system else _absent(),
            }
        elif _DEPTH_UNIT.match(text) is not None:
            head.setdefault("depth_unit", _printed(text, block_id))
        elif (m := _TOTAL_DEPTH.match(text)) is not None:
            head.setdefault("total_depth", _printed(m.group("value"), block_id))
        elif (m := _GROUNDWATER.match(text)) is not None:
            groundwater.append(
                ExtractedGroundwater(
                    type="strike", depth_raw=_printed(m.group("value"), block_id), date_raw=_absent()
                )
            )
        elif (m := _LAYER.match(text)) is not None:
            layers.append(
                ExtractedLayer(
                    from_raw=_printed(m.group("top"), block_id),
                    to_raw=_printed(m.group("base"), block_id),
                    description_raw=_printed(m.group("description"), block_id),
                    description_language=None,
                    english_lithology=None,
                    din4023_code=None,
                    din4023_notation=None,
                    uscs_raw=_absent(),
                    colour_raw=_absent(),
                    consistency_raw=_absent(),
                    moisture_raw=_absent(),
                    weathering_raw=_absent(),
                    stratigraphic_name_raw=_absent(),
                )
            )
    header = ExtractedHeader(
        coordinates=RawCoordinates(
            **{key: coordinates.get(key, _absent()) for key in ("x_raw", "y_raw", "labels_raw", "system_raw")}
        ),
        **{name: head.get(name, _absent()) for name in ExtractedHeader.model_fields if name != "coordinates"},
    )
    return ExtractionResult(
        header=header, layers=layers, spt=[], core_runs=[], groundwater=groundwater, samples=[], tests=[]
    )


@dataclass
class FakeExtractor:
    """The extractor model for tests: `fake_extraction` of the input; counts calls.

    Like the real client it checks PROVIDER_BUDGET_USD before every call and, when `cost_usd` is set,
    records the call in the provider ledger.
    """

    cost_usd: float = 0.0
    model: str = "fake-extractor"
    calls: int = 0
    inputs: list[ExtractionInput] = field(default_factory=list)

    async def extract(
        self, inp: ExtractionInput, *, document_id: str
    ) -> tuple[ExtractionResult, str | None, float]:
        await check_budget(self.cost_usd)
        self.calls += 1
        self.inputs.append(inp)
        if self.cost_usd > 0:
            usage = Usage("fake", "extract", self.model, inp.estimated_tokens, None, None, self.cost_usd)
            await record_usage(usage, document_id)
        return fake_extraction(inp), self.model, self.cost_usd


# ----------------------------------------------------------------------------------------------
# Second reads
# ----------------------------------------------------------------------------------------------


@dataclass
class FakeRereader:
    """The second reader for tests: each crop is "transcribed" as the OCR text inside it (the fake OCR reads
    the fictional PDF exactly), or as the printed text of its values when no OCR block lies in it (a box
    tighter than its block), after the `replace` substitutions; `rule(crop)` overrides that and returns
    (text or None, legibility). `fail` makes every call raise it. Counts calls and the crops of each call.

    Like the real client it checks PROVIDER_BUDGET_USD before every call and, when `cost_usd` is set,
    records the call in the provider ledger.
    """

    replace: dict[str, str] = field(default_factory=dict)
    rule: Callable[[CropImage], tuple[str | None, str]] | None = None
    legibility: str = "clear"
    fail: ProviderError | None = None
    cost_usd: float = 0.0
    model: str = "fake-rereader"
    calls: int = 0
    batches: list[int] = field(default_factory=list)
    crops: list[CropImage] = field(default_factory=list)

    async def reread(
        self, crops: Sequence[CropImage], *, document_id: str
    ) -> tuple[RereadAnswer, str | None, float]:
        await check_budget(self.cost_usd)
        self.calls += 1
        self.batches.append(len(crops))
        self.crops.extend(crops)
        if self.fail is not None:
            raise self.fail
        if self.cost_usd > 0:
            await record_usage(
                Usage("fake", "reread", self.model, None, None, None, self.cost_usd), document_id
            )
        readings = []
        for crop in crops:
            if self.rule is not None:
                text, legibility = self.rule(crop)
            else:
                text = crop.ocr_text or crop.printed
                for old, new in self.replace.items():
                    text = text.replace(old, new)
                legibility = self.legibility
            readings.append(
                CropReading.model_validate({"id": crop.id, "text": text, "legibility": legibility})
            )
        return RereadAnswer(readings=readings), self.model, self.cost_usd


async def _original_pages(document_id: str | None, pages: list[int] | None) -> bytes | None:
    """The given pages of a document's original PDF (None when it is not a PDF or the pages are unknown)."""
    if document_id is None or not pages:
        return None
    from app.db.models import Document
    from app.db.session import get_sessionmaker
    from app.pipeline.ocr import sub_pdf
    from app.storage import get_storage

    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
    if doc is None or not doc.storage_key.lower().endswith(".pdf"):
        return None
    return sub_pdf(get_storage().path(doc.storage_key), pages)
