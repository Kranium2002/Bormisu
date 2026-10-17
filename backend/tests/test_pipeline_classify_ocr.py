"""Triage -> classify -> OCR on FICTIONAL generated PDFs with fake providers (no paid call)."""

from __future__ import annotations

import hashlib
from typing import Any

import pytest
from sqlalchemy import select, update

from app.db.models import Document, OcrPage, OcrRun, Page
from app.db.session import get_sessionmaker
from app.pipeline import classify as classify_module
from app.pipeline.orchestrator import run_pipeline
from app.pipeline.schemas import PageLabel
from app.providers import ocr_mistral
from app.providers.fakes import FakeClassifier, FakeOcrEngine, label
from app.storage import get_storage, original_key
from tests.pdf_factory import TextItem, make_pdf

pytestmark = pytest.mark.db


@pytest.fixture(autouse=True)
def stages_until_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests stop after OCR; extraction has its own tests."""
    from app.pipeline import orchestrator

    monkeypatch.setattr(orchestrator, "STAGES", ("triage", "classify", "ocr"))


def fictional_report() -> bytes:
    return make_pdf(
        [
            [TextItem(150, 700, "FICTIONAL SITE INVESTIGATION REPORT", 16), TextItem(150, 670, "COVER PAGE")],
            [
                TextItem(60, 780, "BOREHOLE LOG FX-1", 14),
                TextItem(60, 760, "Easting 413 210.5  Northing 5 316 044.2  (ETRS89 / UTM 32N)"),
                TextItem(60, 700, "0,00 - 1,20  Sand, schluffig"),
                TextItem(60, 680, "1,20 - 3,40  Kies, sandig"),
            ],
            [
                TextItem(60, 780, "BOREHOLE FX-1 SHEET 2 OF 2", 14),
                TextItem(60, 700, "3,40 - 6,00  Ton, steif"),
            ],
            [
                TextItem(60, 780, "INTRODUCTION", 14),
                TextItem(60, 750, "This fictional text explains the works."),
            ],
        ]
    )


def rule(text: str) -> PageLabel:
    if "BOREHOLE LOG" in text:
        return label(
            "log_sheet", borehole_labels=["FX-1"], has_coordinates=True, sheet_index=1, sheet_total=2
        )
    if "SHEET 2 OF 2" in text:
        return label("log_continuation", borehole_labels=["FX-1"], sheet_label="SHEET 2 OF 2", sheet_index=2)
    if "COVER" in text:
        return label("cover_or_toc")
    return label("narrative", confidence=0.4)  # low confidence: escalated


async def _upload(data: bytes, doc_id: str) -> str:
    digest = hashlib.sha256(data).hexdigest()
    key = original_key(digest, ".pdf")
    get_storage().put_bytes(key, data)
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=doc_id,
                file_name="fictional.pdf",
                sha256=digest,
                mime_type="application/pdf",
                size_bytes=len(data),
                storage_key=key,
                status="queued",
            )
        )
        await session.commit()
    return doc_id


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch) -> tuple[FakeClassifier, FakeOcrEngine]:
    classifier = FakeClassifier(rule)
    engine = FakeOcrEngine(confidence={"Kies": 0.6})
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: classifier)
    monkeypatch.setattr(ocr_mistral, "MistralOcrClient", lambda: engine)
    return classifier, engine


async def _pages(doc_id: str) -> dict[int, Page]:
    async with get_sessionmaker()() as session:
        rows = (await session.scalars(select(Page).where(Page.document_id == doc_id))).all()
        return {p.n: p for p in rows}


async def test_only_borehole_pages_are_ocred_and_reruns_are_free(db: None, fakes: Any) -> None:
    classifier, engine = fakes
    doc_id = await _upload(fictional_report(), "doc_01JFAKE0000000000000CLAS1")
    await run_pipeline(doc_id)
    pages = await _pages(doc_id)
    assert {n: p.role for n, p in pages.items()} == {
        1: "cover_or_toc",
        2: "log_sheet",
        3: "log_continuation",
        4: "narrative",
    }
    assert {n: p.ocr_status for n, p in pages.items()} == {1: "skipped", 2: "done", 3: "done", 4: "skipped"}
    assert {n: p.type for n, p in pages.items()} == {1: "text", 2: "log", 3: "log", 4: "text"}
    assert (
        pages[1].unused_reason == "cover or contents page"
        and pages[2].used
        and pages[2].unused_reason is None
    )
    assert pages[2].borehole_labels == ["FX-1"] and pages[3].sheet_label == "SHEET 2 OF 2"
    assert classifier.calls == 5 and classifier.escalations == 1  # 4 pages + 1 escalation
    assert engine.calls == 1 and engine.pages_seen == 2  # one chunk with the two log pages

    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        assert doc is not None and (doc.status, doc.stage) == ("extracting", "ocr")
        assert doc.progress is not None and doc.progress["pages_classified"] == 4
        assert doc.progress["pages_ocr_total"] == 2 and doc.progress["pages_ocr_done"] == 2
        ocr2 = await session.get(OcrPage, (doc_id, 2))
        assert ocr2 is not None and ocr2.blocks
        blocks = {b["text"]: b for b in ocr2.blocks}
        title = blocks["BOREHOLE LOG FX-1"]
        assert title["id"] == "p2.b0"
        x, y, w, h = title["box"]
        assert 0.08 < x < 0.12 and 0.05 < y < 0.08 and 0.15 < w < 0.4 and 0 < h < 0.03
        assert blocks["1,20 - 3,40 Kies, sandig"]["confidence"] == 0.6
        assert (await session.scalar(select(OcrRun.status))) == "done"

    await run_pipeline(doc_id)  # finished: nothing is called again
    assert (classifier.calls, engine.calls) == (5, 1)

    # A retry after a crash between the OCR call and the page update reuses the stored OCR run.
    async with get_sessionmaker()() as session:
        await session.execute(
            update(Page).where(Page.document_id == doc_id, Page.used).values(ocr_status="pending")
        )
        await session.execute(update(Document).where(Document.id == doc_id).values(stage="classify"))
        await session.commit()
    await run_pipeline(doc_id)
    assert engine.calls == 1
    assert {n: p.ocr_status for n, p in (await _pages(doc_id)).items()}[2] == "done"


async def test_duplicate_pages_skip_the_classifier(db: None, fakes: Any) -> None:
    classifier, _engine = fakes
    first = await _upload(fictional_report(), "doc_01JFAKE0000000000000CLAS2")
    await run_pipeline(first)
    calls = classifier.calls
    # Same log pages saved again with different metadata bytes -> different sha256, same renders.
    again = fictional_report().replace(b"%PDF-1.7\n", b"%PDF-1.7\n%fictional copy\n", 1)
    second = await _upload(again, "doc_01JFAKE0000000000000CLAS3")
    await run_pipeline(second)
    pages = await _pages(second)
    assert pages[2].role == "duplicate" and (pages[2].duplicate_of_doc, pages[2].duplicate_of_n) == (first, 2)
    assert pages[2].used is False and pages[2].ocr_status == "skipped"
    assert pages[2].unused_reason == "duplicate of fictional.pdf p. 2"
    assert classifier.calls == calls  # every page of the copy matched a stored page
