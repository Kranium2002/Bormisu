"""Pipeline triage stage on FICTIONAL documents generated at test time (no provider is called)."""

from __future__ import annotations

import hashlib
import io

import pytest
from PIL import Image
from sqlalchemy import select

from app.db.models import Document, Event, Page
from app.db.session import get_sessionmaker
from app.pipeline.orchestrator import run_pipeline
from app.storage import get_storage, original_key
from tests.pdf_factory import TextItem, make_pdf

pytestmark = pytest.mark.db


async def _document(data: bytes, extension: str, mime: str) -> str:
    digest = hashlib.sha256(data).hexdigest()
    key = original_key(digest, extension)
    get_storage().put_bytes(key, data)
    doc_id = "doc_01JFAKE00000000000000TRIA"
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=doc_id,
                file_name=f"fictional{extension}",
                sha256=digest,
                mime_type=mime,
                size_bytes=len(data),
                storage_key=key,
                status="queued",
            )
        )
        await session.commit()
    return doc_id


async def _pages(doc_id: str) -> list[Page]:
    async with get_sessionmaker()() as session:
        return list(
            (await session.scalars(select(Page).where(Page.document_id == doc_id).order_by(Page.n))).all()
        )


async def test_triage_vector_pdf_and_rerun_is_noop(db: None) -> None:
    pdf = make_pdf([[TextItem(72, 770, f"FICTIONAL SHEET {n}")] for n in range(1, 4)])
    doc_id = await _document(pdf, ".pdf", "application/pdf")
    await run_pipeline(doc_id)
    pages = await _pages(doc_id)
    assert [p.n for p in pages] == [1, 2, 3]
    storage = get_storage()
    assert all(storage.exists(p.render_key or "") and storage.exists(p.thumb_key or "") for p in pages)
    assert all(p.text_layer_key and p.text_layer_quality and p.text_layer_quality > 0.9 for p in pages)
    assert all(p.ocr_status == "pending" and p.used is False and p.role is None for p in pages)
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        assert doc is not None
        assert (doc.status, doc.stage, doc.page_count) == ("classifying", "triage", 3)
        assert doc.progress == {
            "pages_total": 3,
            "pages_classified": 0,
            "pages_ocr_total": 0,
            "pages_ocr_done": 0,
            "boreholes_extracted": 0,
        }
        updated_at = doc.updated_at
    await run_pipeline(doc_id)  # finished stages are skipped
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        assert doc is not None and doc.updated_at == updated_at


async def test_triage_image(db: None) -> None:
    out = io.BytesIO()
    Image.new("RGB", (1200, 900), "white").save(out, format="JPEG")
    doc_id = await _document(out.getvalue(), ".jpg", "image/jpeg")
    await run_pipeline(doc_id)
    pages = await _pages(doc_id)
    assert len(pages) == 1 and pages[0].text_layer_key is None and pages[0].width_px == 1200


async def test_broken_pdf_fails_with_readable_reason(db: None) -> None:
    doc_id = await _document(b"%PDF-1.7\nthis is not a real pdf", ".pdf", "application/pdf")
    await run_pipeline(doc_id)
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        assert doc is not None and doc.status == "failed" and doc.stage is None
        assert doc.error and "damaged" in doc.error and "Traceback" not in doc.error
        event = await session.scalar(select(Event).where(Event.type == "job.failed"))
        assert event is not None and event.payload["stage"] == "triage" and event.payload["retryable"] is True
