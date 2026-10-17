"""Fictional pages only: a classifier outlier inside a run of log sheets gets a second opinion."""

from __future__ import annotations

from typing import Any

import pytest

from app.db.models import Page
from app.pipeline import classify as classify_module
from app.pipeline.classify import outliers, stage_classify
from app.pipeline.schemas import PageLabel
from app.providers.fakes import label
from tests.pdf_factory import TextItem, make_pdf
from tests.test_pipeline_classify_ocr import _pages, _upload


def _page(n: int, role: str, handwriting: str = "none", size: tuple[int, int] = (1100, 1600)) -> Page:
    return Page(
        document_id="doc_fictional",
        n=n,
        role=role,
        handwriting=handwriting,
        width_px=size[0],
        height_px=size[1],
        classifier={},
    )


def test_a_handwritten_page_after_log_sheets_is_an_outlier() -> None:
    pages = [
        _page(1, "summary_table", size=(1600, 1100)),
        _page(2, "log_sheet", "partial"),
        _page(3, "log_sheet", "partial"),
        _page(4, "cover_or_toc", "partial"),
        _page(5, "coordinate_table"),
    ]
    assert outliers(pages) == [4]


def test_printed_cover_and_other_sizes_are_not_outliers() -> None:
    pages = [
        _page(1, "cover_or_toc"),  # printed, one log neighbour only
        _page(2, "log_sheet"),
        _page(3, "narrative", "full", size=(1600, 1100)),  # another page size
        _page(4, "log_sheet"),
        _page(5, "photos"),
    ]
    assert outliers(pages) == []


def test_a_page_between_two_log_sheets_is_an_outlier_even_printed() -> None:
    pages = [_page(1, "log_sheet"), _page(2, "other"), _page(3, "log_continuation")]
    assert outliers(pages) == [2]


def test_outliers_are_capped_and_asked_once() -> None:
    pages = [_page(n, "log_sheet" if n % 2 else "other") for n in range(1, 22)]
    assert outliers(pages) == [2, 4, 6]  # 10 % of 21 pages, rounded up
    pages[1].classifier = {"second_opinion": {"first_role": "other"}}
    assert outliers(pages)[0] == 4


class TwoModels:
    """The cheap model calls the hand-filled form a cover page; the extractor model sees the log."""

    def __init__(self) -> None:
        self.cheap = 0
        self.strong = 0

    async def label(self, page: Page, image_png: bytes, text: str | None, *, escalate: bool) -> PageLabel:
        if escalate:
            self.strong += 1
        else:
            self.cheap += 1
        if "BOREHOLE LOG" in (text or "") or (escalate and "FORM" in (text or "")):
            return label("log_sheet", borehole_labels=["FX-9"], handwriting="partial")
        return label("cover_or_toc", handwriting="partial")


pytestmark = pytest.mark.db


async def test_stage_classify_asks_the_outlier_again_once(db: None, monkeypatch: pytest.MonkeyPatch) -> None:
    pdf = make_pdf(
        [
            [TextItem(60, 780, "BOREHOLE LOG FX-8", 14), TextItem(60, 700, "0,00 - 2,10  Sand")],
            [TextItem(60, 780, "BOREHOLE LOG FX-8 SHEET 2", 14), TextItem(60, 700, "2,10 - 4,00  Clay")],
            [TextItem(60, 780, "FORM 7", 14), TextItem(60, 700, "0 - 3  gravel")],
            [TextItem(60, 780, "BOREHOLE LOG FX-10", 14), TextItem(60, 700, "0,00 - 1,00  Silt")],
        ]
    )
    from app.pipeline import orchestrator

    monkeypatch.setattr(orchestrator, "STAGES", ("triage", "classify"))
    doc_id = await _upload(pdf, "doc_secondopinion1")
    model: Any = TwoModels()
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: model)
    await orchestrator.run_pipeline(doc_id)
    pages = await _pages(doc_id)
    assert pages[3].role == "log_sheet"
    assert pages[3].used is True and pages[3].ocr_status == "pending"
    assert pages[3].classifier["second_opinion"] == {"first_role": "cover_or_toc"}
    assert model.strong == 1
    await stage_classify(doc_id)  # a retry asks nobody again
    assert model.strong == 1
