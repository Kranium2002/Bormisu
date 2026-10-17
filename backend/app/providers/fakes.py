"""Test doubles for providers. Never used by the running app; tests inject them.

FakeOcrEngine answers like Mistral OCR from the text layer of the (fictional) PDF it is sent, so its blocks
carry exact boxes. FakeClassifier labels pages from their text with simple keyword rules supplied by the test.
"""

from __future__ import annotations

import io
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pypdfium2 as pdfium

from app.db.models import Page
from app.pipeline.schemas import PageLabel
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

    async def ocr(self, data: bytes, mime: str, *, document_id: str | None, page_count: int) -> OcrResponse:
        self.calls += 1
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
