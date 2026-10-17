"""OCR planning and OCR (BACKEND.md 7.4): only pages that carry borehole data are sent, in bounded chunks.

A run is keyed by the hash of (model, parameters, document sha256, pages); a stored run with the same key is
reused, so a retry or a worker restart never repeats a paid call. Raw provider JSON is stored on disk; blocks
are normalised (ids p{n}.b{i}, boxes [x, y, w, h] on the page render).

Routes (Settings.ocr_routes): mistral (direct, chunks of pages, boxes and confidence), openrouter (Mistral OCR
through the file-parser plugin) and openai (a vision model transcribes the page render); the last two are
text only and take one page per request. In auto mode a 401/403 moves the rest of the run to the next
configured route, and later runs of this process try the refused route last.

Rate limits: a provider call already waits out a 429 (app.providers.base.post_with_retries). A page still
refused after that is deferred to the end of the run and tried again after a cooldown, up to
OCR_RATE_LIMIT_ROUNDS more rounds, so a burst of 429s never leaves a page unread. Requests on the OpenRouter
route are capped at OCR_OPENROUTER_CONCURRENCY in flight per worker process.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import logging
import weakref
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Protocol

import pypdfium2 as pdfium
from PIL import Image
from sqlalchemy import select

from app.config import Settings, get_settings
from app.db.models import Document, OcrPage, OcrRun, Page
from app.db.session import get_sessionmaker
from app.ids import new_id
from app.pipeline.classify import update_progress
from app.providers import base as providers
from app.providers.base import RATE_LIMITED, ProviderError
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
    # The injected engine, or OCR_PROVIDER's routes without those refused earlier in this process. With none
    # configured, the Mistral client says so.
    chain = ["custom"] if engine is not None else (route_chain(settings) or ["mistral"])
    route = chain[0]
    engine, model, provider = _engine_for(route, engine)

    def plan(pages_left: list[int]) -> list[list[int]]:
        if source is None or route in ONE_PAGE_ROUTES:
            return [[n] for n in pages_left]  # images, and the text-only routes: one page per request
        return plan_chunks(
            pages_left,
            sizes,
            max_pages=settings.ocr_max_pages_per_request,
            max_bytes=settings.ocr_max_request_mb * 1024 * 1024,
        )

    queue = plan(todo)
    attempted = 0
    failures: list[ProviderError] = []
    deferred: list[list[int]] = []  # chunks refused for a rate limit: tried again after a cooldown
    rounds = 0
    while queue or deferred:
        if not queue:
            rounds += 1
            wait = settings.ocr_rate_limit_cooldown_s * rounds
            logger.info(
                "OCR of %s: %d chunk(s) rate-limited; trying again in %.0f s",
                document_id,
                len(deferred),
                wait,
            )
            await providers.pause(wait)
            queue, deferred = deferred, []
        chunk = queue.pop(0)
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
                    provider=provider,
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
                # Always our own renders: broken structure, odd fonts, huge embedded images and rotation
                # metadata of the original never reach the provider, and the provider's page geometry is the
                # render's, so its boxes line up with the page images.
                data, mime = await asyncio.to_thread(request_data, route, [render_keys[n] for n in chunk])
                if hasattr(engine, "current_pages"):
                    engine.current_pages = list(chunk)  # test doubles read the original's text layer
                async with route_limit(route):
                    response = await engine.ocr(data, mime, document_id=document_id, page_count=len(chunk))
                _REFUSED_ROUTES.discard(route)  # reading again: back to its place in the order
            except ProviderError as exc:
                if exc.status == RATE_LIMITED and rounds < settings.ocr_rate_limit_rounds:
                    logger.warning("OCR of %s pages %s rate-limited; deferred", document_id, chunk)
                    deferred.append(chunk)
                    continue
                await _mark_failed(document_id, run.id, chunk, str(exc))
                following = _next_route(chain, route, exc)
                if following is not None:
                    # This route's key is refused: go on with the next configured route for this and every
                    # later page, and for later documents of this worker process.
                    if route not in _REFUSED_ROUTES:
                        logger.warning(
                            "OCR route %s refused the key (%s); using the %s route",
                            route,
                            exc.status,
                            following,
                        )
                    _REFUSED_ROUTES.add(route)
                    route = following
                    engine, model, provider = _engine_for(route, None)
                    queue = plan(sorted({n for c in [chunk, *queue, *deferred] for n in c}))
                    deferred = []
                    continue
                attempted += 1
                logger.warning("OCR failed for %s pages %s: %s", document_id, chunk, exc)
                failures.append(exc)
                if not exc.retryable:
                    break
                continue
        attempted += 1
        await _store_results(document_id, run, chunk, response)
        await update_progress(document_id, emit=True)
    if failures and len(failures) == attempted:
        raise failures[0]


def _engine_for(route: str, engine: OcrEngine | None) -> tuple[OcrEngine, str, str]:
    """(engine, model tag for the run cache key, provider name) of an OCR route."""
    settings = get_settings()
    if route == "custom" and engine is not None:
        return engine, settings.mistral_ocr_model, "mistral"
    if route == "openrouter":
        from app.providers.ocr_openrouter import MODEL_TAG, OpenRouterOcrClient

        return OpenRouterOcrClient(), MODEL_TAG, "openrouter"
    if route == "openai":
        from app.providers.ocr_openai import OpenAIOcrClient, model_tag

        return OpenAIOcrClient(), model_tag(settings.openai_ocr_model_name), "openai"
    from app.providers.ocr_mistral import MistralOcrClient

    return MistralOcrClient(), settings.mistral_ocr_model, "mistral"


# OCR routes whose key was refused (401/403) in this process: auto mode tries them last, until one reads a
# page again.
_REFUSED_ROUTES: set[str] = set()
# In-flight caps per event loop and route; asyncio semaphores belong to one loop.
_LIMITS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Semaphore]] = (
    weakref.WeakKeyDictionary()
)


@contextlib.asynccontextmanager
async def route_limit(route: str) -> AsyncIterator[None]:
    """Hold one of the route's in-flight slots (only the OpenRouter route is capped)."""
    if route != "openrouter":
        yield
        return
    limits = _LIMITS.setdefault(asyncio.get_running_loop(), {})
    limit = limits.get(route)
    if limit is None:
        limit = limits[route] = asyncio.Semaphore(max(1, get_settings().ocr_openrouter_concurrency))
    async with limit:
        yield


# Text-only routes: one page per request, so every text maps to its page.
ONE_PAGE_ROUTES = frozenset({"openrouter", "openai"})
OCR_PDF_DPI = 150.0  # page size of the rebuilt PDF; the pixels are the stored render's


def route_chain(settings: Settings) -> list[str]:
    """OCR_PROVIDER's routes in the order they are tried, the routes refused earlier in this process moved to
    the end."""
    routes: list[str] = list(settings.ocr_routes)
    return [r for r in routes if r not in _REFUSED_ROUTES] + [r for r in routes if r in _REFUSED_ROUTES]


def _next_route(chain: Sequence[str], route: str, exc: ProviderError) -> str | None:
    """The next configured route when this route's key is refused (401/403). Only auto mode has more than one
    route, so an explicit OCR_PROVIDER never moves."""
    if route == "custom" or exc.status not in (401, 403) or route not in chain:
        return None
    index = chain.index(route)
    return chain[index + 1] if index + 1 < len(chain) else None


def request_data(route: str, render_keys: Sequence[str | None]) -> tuple[bytes, str]:
    """What a route is sent: the stored page render itself on the OpenAI route (a vision model reads images),
    else the renders rebuilt as a PDF."""
    if route == "openai":
        if len(render_keys) != 1 or not render_keys[0]:
            raise ProviderError("A page has no rendered image to read.", retryable=False)
        return get_storage().get_bytes(render_keys[0]), "image/png"
    return renders_pdf(render_keys), "application/pdf"


def renders_pdf(render_keys: Sequence[str | None]) -> bytes:
    """A PDF with one page per stored render, in order."""
    storage = get_storage()
    images = []
    for key in render_keys:
        if not key:
            raise ProviderError("A page has no rendered image to read.", retryable=False)
        with Image.open(io.BytesIO(storage.get_bytes(key))) as img:
            images.append(img.convert("RGB"))
    out = io.BytesIO()
    images[0].save(out, format="PDF", save_all=True, append_images=images[1:], resolution=OCR_PDF_DPI)
    return out.getvalue()


async def _mark_failed(document_id: str, run_id: str, chunk: Sequence[int], error: str) -> None:
    async with get_sessionmaker()() as session:
        for n in chunk:
            page = await session.get(Page, (document_id, n))
            if page is not None:
                page.ocr_status = "failed"
        failed = await session.get(OcrRun, run_id)
        if failed is not None:
            failed.status, failed.error = "failed", error
        await session.commit()
