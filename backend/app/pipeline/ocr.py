"""OCR planning and OCR (BACKEND.md 7.4): only pages that carry borehole data are sent, in bounded chunks.

A run is keyed by the hash of (model, parameters, document sha256, pages); a stored run with the same key is
reused, so a retry or a worker restart never repeats a paid call. Raw provider JSON is stored on disk; blocks
are normalised (ids p{n}.b{i}, boxes [x, y, w, h] on the page render).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Protocol

import pypdfium2 as pdfium
from sqlalchemy import select

from app.config import get_settings
from app.db.models import Document, OcrPage, OcrRun, Page
from app.db.session import get_sessionmaker
from app.ids import new_id
from app.pipeline.classify import update_progress
from app.providers.base import ProviderError
from app.providers.ocr_mistral import OcrResponse, normalise_page
from app.storage import get_storage

logger = logging.getLogger("geomemory.pipeline.ocr")

OCR_PARAMS_VERSION = "1"
OFFICE_EXTENSIONS = frozenset({".docx", ".doc", ".odt", ".pptx"})


class OcrEngine(Protocol):
    async def ocr(
        self, data: bytes, mime: str, *, document_id: str | None, page_count: int
    ) -> OcrResponse: ...


def raw_key(document_id: str, run_id: str) -> str:
    return f"ocr/{document_id}/{run_id}.json"


def plan_chunks(
    pages: Sequence[int], sizes: dict[int, int], *, max_pages: int, max_bytes: int
) -> list[list[int]]:
    """Consecutive groups of at most `max_pages` pages and roughly `max_bytes` (estimated per page)."""
    chunks: list[list[int]] = []
    current: list[int] = []
    current_bytes = 0
    for n in pages:
        size = sizes.get(n, 0)
        if current and (len(current) >= max_pages or current_bytes + size > max_bytes):
            chunks.append(current)
            current, current_bytes = [], 0
        current.append(n)
        current_bytes += size
    if current:
        chunks.append(current)
    return chunks


def sub_pdf(source: Path, pages: Sequence[int]) -> bytes:
    """A new PDF holding the given 1-based pages of `source`, in order."""
    src = pdfium.PdfDocument(str(source))
    out = pdfium.PdfDocument.new()
    try:
        out.import_pages(src, [n - 1 for n in pages])
        buffer = io.BytesIO()
        out.save(buffer)
        return buffer.getvalue()
    finally:
        out.close()
        src.close()


def params_hash(model: str, sha256: str, pages: Sequence[int]) -> str:
    key = json.dumps(
        {"v": OCR_PARAMS_VERSION, "model": model, "sha": sha256, "pages": list(pages)}, sort_keys=True
    )
    return hashlib.sha256(key.encode()).hexdigest()


def _source_pdf(doc: Document) -> Path | None:
    storage = get_storage()
    original = storage.path(doc.storage_key)
    if original.suffix.lower() == ".pdf":
        return original
    if original.suffix.lower() in OFFICE_EXTENSIONS:
        converted = storage.path(f"pages/{doc.id}/converted.pdf")
        return converted if converted.exists() else None
    return None


async def _store_results(doc_id: str, run: OcrRun, chunk: Sequence[int], response: OcrResponse) -> None:
    storage = get_storage()
    await asyncio.to_thread(
        storage.put_bytes, raw_key(doc_id, run.id), json.dumps(response.raw).encode("utf-8")
    )
    raw_pages = sorted(response.raw.get("pages") or [], key=lambda p: int(p.get("index", 0)))
    by_index = {int(p.get("index", i)): p for i, p in enumerate(raw_pages)}
    async with get_sessionmaker()() as session:
        run.status = "done"
        run.raw_key = raw_key(doc_id, run.id)
        run.model = response.model
        run.pages_processed = response.pages_processed
        session.add(run)
        for i, n in enumerate(chunk):
            raw_page = by_index.get(i)
            page = await session.get(Page, (doc_id, n))
            if page is None:
                continue
            if raw_page is None:
                page.ocr_status = "failed"
                continue
            result = normalise_page(raw_page, n)
            existing = await session.get(OcrPage, (doc_id, n))
            row = existing or OcrPage(document_id=doc_id, n=n, ocr_run_id=run.id)
            row.ocr_run_id = run.id
            row.markdown = result.markdown
            row.tables = result.tables
            row.blocks = [b.model_dump(mode="json") for b in result.blocks]
            row.dimensions = raw_page.get("dimensions")
            row.raw_key = run.raw_key
            if existing is None:
                session.add(row)
            page.ocr_status = "done"
            page.ocr_run_id = run.id
        await session.commit()


async def stage_ocr(document_id: str, engine: OcrEngine | None = None) -> None:
    settings = get_settings()
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return
        pages = (
            await session.scalars(
                select(Page)
                .where(
                    Page.document_id == document_id,
                    Page.used.is_(True),
                    Page.ocr_status.in_(("pending", "failed")),
                )
                .order_by(Page.n)
            )
        ).all()
        todo = [p.n for p in pages]
        sizes = {p.n: (p.width_px or 0) * (p.height_px or 0) // 6 for p in pages}  # rough bytes per page
        sha256 = doc.sha256
        source = _source_pdf(doc)
        render_keys = {p.n: p.render_key for p in pages}
    if not todo:
        await update_progress(document_id, emit=True)
        return
    if engine is None:
        from app.providers.ocr_mistral import MistralOcrClient

        engine = MistralOcrClient()
    model = settings.mistral_ocr_model
    if source is not None:
        chunks = plan_chunks(
            todo,
            sizes,
            max_pages=settings.ocr_max_pages_per_request,
            max_bytes=settings.ocr_max_request_mb * 1024 * 1024,
        )
    else:
        chunks = [[n] for n in todo]  # images: one page per request
    failures: list[ProviderError] = []
    for chunk in chunks:
        key = params_hash(model, sha256, chunk)
        async with get_sessionmaker()() as session:
            stored = await session.scalar(
                select(OcrRun).where(OcrRun.document_id == document_id, OcrRun.params_hash == key)
            )
            if stored is not None and stored.status == "done" and stored.raw_key:
                raw = json.loads(await asyncio.to_thread(get_storage().get_bytes, stored.raw_key))
                response = OcrResponse(raw, stored.model, stored.pages_processed or len(chunk))
                run = stored
            else:
                run = stored or OcrRun(
                    id=new_id("ocr"),
                    document_id=document_id,
                    provider="mistral",
                    model=model,
                    params_hash=key,
                    pages=list(chunk),
                    status="running",
                )
                if stored is None:
                    session.add(run)
                await session.commit()
                response = None
        if response is None:
            try:
                if source is not None:
                    data = await asyncio.to_thread(sub_pdf, source, chunk)
                    response = await engine.ocr(
                        data, "application/pdf", document_id=document_id, page_count=len(chunk)
                    )
                else:
                    data = await asyncio.to_thread(get_storage().get_bytes, render_keys[chunk[0]] or "")
                    response = await engine.ocr(data, "image/png", document_id=document_id, page_count=1)
            except ProviderError as exc:
                logger.warning("OCR failed for %s pages %s: %s", document_id, chunk, exc)
                failures.append(exc)
                async with get_sessionmaker()() as session:
                    for n in chunk:
                        page = await session.get(Page, (document_id, n))
                        if page is not None:
                            page.ocr_status = "failed"
                    failed = await session.get(OcrRun, run.id)
                    if failed is not None:
                        failed.status, failed.error = "failed", str(exc)
                    await session.commit()
                if not exc.retryable:
                    break
                continue
        await _store_results(document_id, run, chunk, response)
        await update_progress(document_id, emit=True)
    if failures and len(failures) == len(chunks):
        raise failures[0]
