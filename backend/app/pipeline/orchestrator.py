"""Stage graph as Procrastinate tasks (BACKEND.md section 7).

`process_document` runs the stages in order. Each stage reads what the previous one stored, writes its own
outputs and records itself in `documents.stage`, so a rerun (retry, worker restart) skips finished stages and
never repeats paid calls. A stage that fails marks the document `failed` with a reason a person can read and
emits `job.failed`; `POST /documents/{id}/retry` resumes after the last finished stage.

The `extract` stage plans the page groups and extracts each (bounded by CONCURRENCY_EXTRACT); once all are
read, parts of one borehole are merged under the ID the document's tables list (app.pipeline.identity) and
every borehole is committed separately. A crash resumes with the groups that have no borehole yet; a group
extracted but not finalised reuses its stored extraction run.
A group is extracted only once all of its pages and the document's context pages have OCR text, because a
finished group is never extracted again. Groups held back that way do not stop the rest: the document is
finalised with what was read (pins, questions) and goes to review with a warning naming the unread pages
(Document.warnings); a retry reads only those pages again (finished OCR runs and boreholes are kept). Only
when nothing at all could be extracted does the document fail, with a readable reason, rewound to before OCR.

With EXTRACTOR=bh3 (and the app.bh3 package installed) the `extract` stage first reads the log pages with
bh3 (app.pipeline.bh3_adapter) and finalises its boreholes the same way; the classic extractor then takes
only the page groups none of whose pages is in a bh3 borehole (pages bh3 could not read, or did not take for
a log).

The `reread` stage (app.pipeline.reread) reads handwritten and low-confidence values a second time. It does
nothing when there are none, never fails the document and leaves its status and progress as they are.

Spreadsheets (.xlsx, .csv) take their own stages instead (app.pipeline.spreadsheet, BACKEND.md 7.10):
`sheet_read` opens the file (no pages, page_count null), `sheet_map` asks the extractor model once for a
declarative column mapping (cached), `sheet_extract` applies it to every row and creates the boreholes.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from procrastinate.exceptions import AlreadyEnqueued
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import Borehole, Document, Page
from app.db.session import get_sessionmaker
from app.events.writer import emit
from app.pipeline.office import OfficeConversionError, office_to_pdf
from app.pipeline.triage import TriagedPage, triage_image, triage_pdf
from app.providers.base import ProviderError
from app.queue import queue_app
from app.services.documents import emit_document_updated
from app.services.page_images import prewarm_page
from app.storage import FileStorage, get_storage, page_render_key, page_thumb_key

if TYPE_CHECKING:
    from app.pipeline.extract import Extractor
    from app.pipeline.types import ExtractionOutcome, PageGroup

logger = logging.getLogger("geomemory.pipeline")

PIPELINE_QUEUE = "pipeline"
OFFICE_EXTENSIONS = frozenset({".docx", ".doc", ".odt", ".pptx"})
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"})
SPREADSHEET_EXTENSIONS = frozenset({".xlsx", ".csv"})

# Stage order; `documents.stage` holds the last finished one.
STAGES = ("triage", "classify", "ocr", "extract", "reread")
SPREADSHEET_STAGES = ("sheet_read", "sheet_map", "sheet_extract")
# Statuses a finished document can have; the last stage never moves a document out of them.
REVIEW_STATUSES = frozenset({"needs_review", "done"})


class StageError(RuntimeError):
    """A failure whose message is safe to show (no internals).

    `rewind_to` names the last stage that still counts as finished, so a retry runs the later ones again.
    """

    def __init__(self, message: str, *, retryable: bool = True, rewind_to: str | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.rewind_to = rewind_to


def stages_for(storage_key: str) -> tuple[str, ...]:
    """The stage order of a document, by the stored original's extension."""
    return SPREADSHEET_STAGES if Path(storage_key).suffix.lower() in SPREADSHEET_EXTENSIONS else STAGES


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
    rows: list[dict[str, object]] = []
    # The review screens show the original scan at once, not after a resize on first view (best effort:
    # a width that is missing is made on request).
    with ThreadPoolExecutor(max_workers=4) as pool:
        for page in pages:
            rows.append(_store_page(storage, document_id, page))
            pool.submit(prewarm_page, storage, document_id, page.n, page.png)
    return rows


async def stage_triage(session: AsyncSession, doc: Document) -> None:
    storage = get_storage()
    original = storage.path(doc.storage_key)
    extension = original.suffix.lower()
    if extension in SPREADSHEET_EXTENSIONS:  # run_pipeline sends these to SPREADSHEET_STAGES instead
        raise StageError("Spreadsheets are read by the spreadsheet stages, not as pages.", retryable=False)
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


async def _fail(
    document_id: str, stage: str, message: str, retryable: bool, *, rewind_to: str | None = None
) -> None:
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return
        doc.status = "failed"
        doc.error = message
        doc.failed_stage = stage  # contract 1.2.0 Document.failed_stage, the same name as job.failed.stage
        doc.updated_at = _now()
        stages = stages_for(doc.storage_key)
        if rewind_to in stages and doc.stage in stages and stages.index(doc.stage) > stages.index(rewind_to):
            doc.stage = rewind_to
        await emit_document_updated(session, doc)
        payload = {"document_id": document_id, "stage": stage, "detail": message, "retryable": retryable}
        await emit(session, "job.failed", payload, document_id=document_id)
        await session.commit()


async def _triage(document_id: str) -> None:
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return
        await stage_triage(session, doc)
        await session.commit()


async def _classify(document_id: str) -> None:
    from app.pipeline.classify import stage_classify

    await stage_classify(document_id)


async def _ocr(document_id: str) -> None:
    from app.pipeline.ocr import stage_ocr

    await stage_ocr(document_id)


def _numbers(pages: Sequence[int]) -> str:
    return ", ".join(str(n) for n in pages)


async def _extraction_state(document_id: str) -> tuple[set[str], set[int]]:
    """Group keys that already have a borehole, and used pages whose OCR did not finish."""
    async with get_sessionmaker()() as session:
        finished = set(
            (
                await session.scalars(select(Borehole.group_key).where(Borehole.document_id == document_id))
            ).all()
        )
        unread = set(
            (
                await session.scalars(
                    select(Page.n).where(
                        Page.document_id == document_id,
                        Page.used.is_(True),
                        Page.ocr_status.in_(("pending", "failed")),
                    )
                )
            ).all()
        )
    return finished, unread


async def stage_extract(document_id: str, extractor: Extractor | None = None) -> None:
    """Extract and finalise every page group without a borehole, then close the document.

    Raises the first ProviderError (or other failure) after the groups already started have finished; no
    new group starts once one has failed. Groups without readable text are held back and reported together
    as a StageError that rewinds the document to before OCR.
    """
    from app.pipeline import bh3_adapter, identity
    from app.pipeline import extract as extract_module
    from app.pipeline import finalize as finalize_module
    from app.pipeline import group as group_module

    groups = await group_module.plan_groups(document_id)
    finished, unread = await _extraction_state(document_id)
    # Every outcome is collected first: parts of one borehole (a log and its drilling plot, a name read in a
    # header and the ID the document's tables list) are merged before they are stored (app.pipeline.identity).
    ready: list[tuple[PageGroup, ExtractionOutcome]] = []
    if extractor is None and bh3_adapter.active():
        # bh3 reads the log pages; the classic extractor takes the groups it covers no page of.
        read = await bh3_adapter.extract_document(document_id)
        if read is not None:
            ready.extend((g, o) for g, o in read.boreholes if g.key not in finished)
            groups = bh3_adapter.covered(groups, read.pages)
    todo: list[PageGroup] = []
    unread_pages: set[int] = set()
    for group in groups:
        if group.key in finished:
            continue  # finalised by an earlier run: nothing is called again
        missing = unread.intersection((*group.pages, *group.context_pages))
        if missing:
            unread_pages |= missing
            continue
        todo.append(group)
    held: list[str] = []
    empty_pages: set[int] = set()  # pages of groups with no readable text at all
    if unread_pages:
        held.append(
            f"Text could not be read on page(s) {_numbers(sorted(unread_pages))}, so the boreholes on them "
            "were not extracted yet. Retry the document to read these pages again."
        )
    if todo and extractor is None:
        # Built once per run and before any run is stored, so a missing configuration fails cleanly.
        extractor = extract_module.OpenRouterExtractor()
    limit = asyncio.Semaphore(max(1, get_settings().concurrency_extract))
    stopped = False

    async def one(group: PageGroup) -> None:
        nonlocal stopped
        async with limit:
            if stopped:
                return
            try:
                outcome = await extract_module.extract_group(document_id, group, extractor=extractor)
            except extract_module.NothingToExtractError as exc:
                held.append(str(exc))
                empty_pages.update(group.pages)
                return
            except Exception:
                stopped = True
                raise
            ready.append((group, outcome))

    results = await asyncio.gather(*(one(group) for group in todo), return_exceptions=True)
    errors = [r for r in results if isinstance(r, BaseException)]
    # Stored only when every group was read: a part stored alone would become a second borehole once the
    # rest is merged on the retry (which reuses the stored extraction runs and bh3's cache, so it is free).
    tables = await identity.document_tables(document_id) if not errors else identity.Tables({})
    for item in identity.reconcile(ready, tables) if not errors else []:
        if item.group.key in finished:
            continue
        uid = await finalize_module.finalize_group(document_id, item.group, item.outcome)
        if uid is None:
            logger.warning("document %s group %s produced no borehole", document_id, item.group.key)
        elif item.aliases:
            await finalize_module.add_label_aliases(uid, item.aliases)
    if errors:
        provider_errors = [e for e in errors if isinstance(e, ProviderError)]
        raise (provider_errors or errors)[0]
    if empty_pages:
        await _mark_unread(document_id, empty_pages)
    if held:
        if not await _has_boreholes(document_id):
            raise StageError(" ".join(dict.fromkeys(held)), retryable=True, rewind_to="classify")
        # Keep what was read: the document goes to review with the unread pages named in its warnings.
        logger.warning(
            "document %s finalised without pages %s", document_id, sorted(unread_pages | empty_pages)
        )
    await finalize_module.finalize_document(document_id)


async def _has_boreholes(document_id: str) -> bool:
    async with get_sessionmaker()() as session:
        found = await session.scalar(select(Borehole.uid).where(Borehole.document_id == document_id).limit(1))
    return found is not None


async def _mark_unread(document_id: str, pages: set[int]) -> None:
    """Pages whose text gave nothing to extract count as not read, so a retry reads them again."""
    async with get_sessionmaker()() as session:
        for n in sorted(pages):
            page = await session.get(Page, (document_id, n))
            if page is not None and page.used:
                page.ocr_status = "failed"
        await session.commit()


async def _extract(document_id: str) -> None:
    await stage_extract(document_id)


async def _reread(document_id: str) -> None:
    from app.pipeline.reread import stage_reread

    await stage_reread(document_id)  # logs and swallows its own failures: the document stays as it is


async def _sheet_read(document_id: str) -> None:
    from app.pipeline.spreadsheet import stage_sheet_read

    await stage_sheet_read(document_id)


async def _sheet_map(document_id: str) -> None:
    from app.pipeline.spreadsheet import stage_sheet_map

    await stage_sheet_map(document_id)


async def _sheet_extract(document_id: str) -> None:
    from app.pipeline.spreadsheet import stage_sheet_extract

    await stage_sheet_extract(document_id)


StageFn = Callable[[str], Awaitable[None]]
STAGE_FUNCTIONS: dict[str, StageFn] = {
    "triage": _triage,
    "classify": _classify,
    "ocr": _ocr,
    "extract": _extract,
    "reread": _reread,
    "sheet_read": _sheet_read,
    "sheet_map": _sheet_map,
    "sheet_extract": _sheet_extract,
}
# Document status once a stage has finished (the UI maps classifying=0, extracting=1, needs_review=2).
STATUS_AFTER: dict[str, str] = {
    "triage": "classifying",
    "classify": "extracting",
    "ocr": "extracting",
    "extract": "needs_review",
    "reread": "needs_review",
    "sheet_read": "extracting",
    "sheet_map": "extracting",
    "sheet_extract": "needs_review",
}


async def run_pipeline(document_id: str) -> None:
    """Run every unfinished stage of one document. Stages manage their own transactions; the Procrastinate
    job lock (one job per document) keeps two workers off the same document. Spreadsheets take
    SPREADSHEET_STAGES instead of the page stages."""
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            logger.info("document %s is gone; nothing to do", document_id)
            return
        stages = stages_for(doc.storage_key)
    for stage in stages:
        async with get_sessionmaker()() as session:
            doc = await session.get(Document, document_id)
            if doc is None:
                logger.info("document %s is gone; nothing to do", document_id)
                return
            done = stages.index(doc.stage) if doc.stage in stages else -1
            if stages.index(stage) <= done:
                continue
            if doc.status in ("queued", "failed"):
                doc.status = "classifying" if doc.stage in (None, "triage") else "extracting"
                doc.error = None
                doc.failed_stage = None
                await emit_document_updated(session, doc)
                await session.commit()
        try:
            await STAGE_FUNCTIONS[stage](document_id)
        except StageError as exc:
            await _fail(document_id, stage, str(exc), exc.retryable, rewind_to=exc.rewind_to)
            return
        except ProviderError as exc:
            await _fail(document_id, stage, str(exc), exc.retryable)
            return
        except Exception:
            logger.exception("stage %s failed for %s", stage, document_id)
            await _fail(document_id, stage, f"Processing stopped during {stage}. Retry the document.", True)
            return
        async with get_sessionmaker()() as session:
            doc = await session.get(Document, document_id)
            if doc is None:
                return
            doc.stage = stage
            if doc.status not in REVIEW_STATUSES:  # finalisation decides needs_review or done
                doc.status = STATUS_AFTER.get(stage, doc.status)
            doc.error = None
            doc.failed_stage = None
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
