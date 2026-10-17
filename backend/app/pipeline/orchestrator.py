"""Stage graph as Procrastinate tasks (BACKEND.md section 7).

`process_document` runs the stages in order. Each stage reads what the previous one stored, writes its own
outputs and records itself in `documents.stage`, so a rerun (retry, worker restart) skips finished stages and
never repeats paid calls. A stage that fails marks the document `failed` with a reason a person can read and
emits `job.failed`; `POST /documents/{id}/retry` resumes after the last finished stage.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

from procrastinate.exceptions import AlreadyEnqueued
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Document, Page
from app.db.session import get_sessionmaker
from app.events.writer import emit
from app.pipeline.office import OfficeConversionError, office_to_pdf
from app.pipeline.triage import TriagedPage, triage_image, triage_pdf
from app.queue import queue_app
from app.services.documents import emit_document_updated
from app.storage import FileStorage, get_storage, page_render_key, page_thumb_key

logger = logging.getLogger("geomemory.pipeline")

PIPELINE_QUEUE = "pipeline"
OFFICE_EXTENSIONS = frozenset({".docx", ".doc", ".odt", ".pptx"})
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"})
SPREADSHEET_EXTENSIONS = frozenset({".xlsx", ".csv"})

# Stage order; `documents.stage` holds the last finished one.
STAGES = ("triage",)


class StageError(RuntimeError):
    """A failure whose message is safe to show (no internals)."""

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


def text_layer_key(document_id: str, n: int) -> str:
    return f"pages/{document_id}/text/{n:04d}.json"


def converted_pdf_key(document_id: str) -> str:
    return f"pages/{document_id}/converted.pdf"


def _now() -> datetime:
    return datetime.now(UTC)


def _store_page(storage: FileStorage, document_id: str, page: TriagedPage) -> dict[str, object]:
    storage.put_bytes(page_render_key(document_id, page.n), page.png)
    storage.put_bytes(page_thumb_key(document_id, page.n), page.thumb)
    text_key = None
    if page.words:
        text_key = text_layer_key(document_id, page.n)
        payload = {"text": page.text, "words": [{"t": w.text, "b": list(w.box)} for w in page.words]}
        storage.put_bytes(text_key, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    return {
        "n": page.n,
        "width_px": page.width_px,
        "height_px": page.height_px,
        "render_key": page_render_key(document_id, page.n),
        "thumb_key": page_thumb_key(document_id, page.n),
        "text_layer_quality": page.text_layer_quality,
        "text_layer_key": text_key,
        "phash": page.phash,
    }


def _triage_files(storage: FileStorage, document_id: str, source: Path, kind: str) -> list[dict[str, object]]:
    pages = triage_pdf(source) if kind == "pdf" else triage_image(source)
    return [_store_page(storage, document_id, page) for page in pages]


async def stage_triage(session: AsyncSession, doc: Document) -> None:
    storage = get_storage()
    original = storage.path(doc.storage_key)
    extension = original.suffix.lower()
    if extension in SPREADSHEET_EXTENSIONS:
        raise StageError("Spreadsheets are not processed by this build yet.", retryable=False)
    source, kind = original, "pdf"
    if extension in OFFICE_EXTENSIONS:
        try:
            pdf = await office_to_pdf(original)
        except OfficeConversionError as exc:
            raise StageError(str(exc)) from exc
        key = converted_pdf_key(doc.id)
        await asyncio.to_thread(storage.put_bytes, key, pdf)
        source = storage.path(key)
    elif extension in IMAGE_EXTENSIONS:
        kind = "image"
    elif extension != ".pdf":
        raise StageError(f"Files of type {extension} cannot be processed.", retryable=False)
    try:
        rows = await asyncio.to_thread(_triage_files, storage, doc.id, source, kind)
    except Exception as exc:  # pypdfium2 / Pillow raise many types for broken files
        logger.warning("triage failed for %s: %s", doc.id, type(exc).__name__)
        raise StageError(
            "The file could not be opened as a document. It may be damaged or encrypted."
        ) from exc
    if not rows:
        raise StageError("The file has no pages.", retryable=False)
    await session.execute(delete(Page).where(Page.document_id == doc.id))
    for row in rows:
        session.add(Page(document_id=doc.id, used=False, ocr_status="pending", **row))
    doc.page_count = len(rows)
    doc.progress = {
        "pages_total": len(rows),
        "pages_classified": 0,
        "pages_ocr_total": 0,
        "pages_ocr_done": 0,
        "boreholes_extracted": 0,
    }
    doc.status = "classifying"


StageFn = Callable[[AsyncSession, Document], Awaitable[None]]
STAGE_FUNCTIONS: dict[str, StageFn] = {"triage": stage_triage}


async def _fail(document_id: str, stage: str, message: str, retryable: bool) -> None:
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return
        doc.status = "failed"
        doc.error = message
        doc.updated_at = _now()
        await emit_document_updated(session, doc)
        payload = {"document_id": document_id, "stage": stage, "detail": message, "retryable": retryable}
        await emit(session, "job.failed", payload, document_id=document_id)
        await session.commit()


async def run_pipeline(document_id: str) -> None:
    """Run every unfinished stage of one document; each stage commits on its own."""
    for stage in STAGES:
        async with get_sessionmaker()() as session:
            doc = await session.get(Document, document_id, with_for_update=True)
            if doc is None:
                logger.info("document %s is gone; nothing to do", document_id)
                return
            done = STAGES.index(doc.stage) if doc.stage in STAGES else -1
            if STAGES.index(stage) <= done:
                continue
            if doc.status == "queued":
                doc.status = "classifying"
            try:
                await STAGE_FUNCTIONS[stage](session, doc)
            except StageError as exc:
                await session.rollback()
                await _fail(document_id, stage, str(exc), exc.retryable)
                return
            except Exception:
                logger.exception("stage %s failed for %s", stage, document_id)
                await session.rollback()
                await _fail(
                    document_id, stage, f"Processing stopped during {stage}. Retry the document.", True
                )
                return
            doc.stage = stage
            doc.error = None
            doc.updated_at = _now()
            await emit_document_updated(session, doc)
            await session.commit()


@queue_app.task(name="process_document", queue=PIPELINE_QUEUE, pass_context=False)
async def process_document(document_id: str) -> None:
    await run_pipeline(document_id)


async def enqueue_document(document_id: str) -> None:
    """Queue processing; the queueing lock keeps one pending job per document."""
    try:
        await process_document.configure(lock=document_id, queueing_lock=document_id).defer_async(
            document_id=document_id
        )
    except AlreadyEnqueued:
        logger.info("document %s is already queued", document_id)
