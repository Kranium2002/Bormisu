"""Run the real pipeline on the planned files and collect what it stored.

Each file is uploaded with the API's own steps (app.upload.receive: magic bytes, size limit and sha256 while
streaming; the original moved to `originals/{sha256}{ext}`; a document row and its `document.updated`
event), then `orchestrator.run_pipeline` runs in this process as the worker would. Bytes uploaded before
reuse their document, so a finished document costs nothing the second time.

Cost control, in order:
1. Before a file starts: the spend recorded in `provider_calls` since the run began plus the file's estimate
   (pages x USD per page) must stay within `max_usd`, and the whole ledger plus the estimate within
   PROVIDER_BUDGET_USD when that is set. Otherwise the file and every later one are not started.
2. While a file runs: PROVIDER_BUDGET_USD is lowered for this process to the ledger total at the start plus
   `max_usd` (never raised), so the providers' own guard refuses any call that would pass the cap. A file
   stopped that way ends the run.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import tempfile
import time
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select

from app.config import get_settings
from app.db.models import Borehole, BoreholeLayer, Document, Event, Page, ProviderCall
from app.db.session import get_sessionmaker
from app.errors import ApiError
from app.eval.compare import ActualBorehole, FileComparison, compare_file
from app.eval.expected import file_key, mentions, name_keys
from app.eval.plan import PlannedFile, eval_config, excerpt_pdf, prior_usd_per_page
from app.ids import new_id
from app.pipeline.orchestrator import STAGES, run_pipeline
from app.providers.base import BudgetExceededError, spent_usd
from app.review.service import canonical_label
from app.services.documents import emit_document_updated
from app.storage import get_storage, original_key
from app.upload import StoredUpload, display_name, receive

logger = logging.getLogger("geomemory.eval")

STOP_COST_CAP = "cost_cap"
STOP_PROVIDER_BUDGET = "provider_budget"
_CHUNK = 1024 * 1024

Progress = Callable[[str], None]


@contextmanager
def environment(values: Mapping[str, str | None]) -> Iterator[None]:
    """Set (or remove) environment variables and reload the settings; restore both afterwards."""
    old = {key: os.environ.get(key) for key in values}
    try:
        for key, value in values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        get_settings.cache_clear()
        yield
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        get_settings.cache_clear()


# ----------------------------------------------------------------------------------------------
# Results
# ----------------------------------------------------------------------------------------------


@dataclass
class DocumentRun:
    document_id: str | None
    reused: bool = False  # the same bytes were uploaded before
    finished_before: bool = False  # ... and already processed, so nothing was paid for again
    status: str = "not_uploaded"
    failure: str | None = None  # failure category (never the error text)
    budget_stop: bool = False
    pages: int = 0
    pages_ocr: int = 0
    duration_s: float = 0.0
    cost_usd: float = 0.0
    duplicate_docs: frozenset[str] = frozenset()
    boreholes: list[ActualBorehole] = field(default_factory=list)


@dataclass
class FileRun:
    planned: PlannedFile
    not_started: str | None = None  # stop reason when the file was never started
    estimate_usd: float = 0.0
    cost_usd: float = 0.0
    duration_s: float = 0.0
    documents: list[DocumentRun] = field(default_factory=list)
    sources_not_started: int = 0
    calls: Counter[str] = field(default_factory=Counter)
    comparison: FileComparison | None = None

    @property
    def started(self) -> bool:
        return self.not_started is None

    @property
    def short_id(self) -> str:
        return self.planned.short_id

    @property
    def failures(self) -> Counter[str]:
        counts: Counter[str] = Counter(d.failure for d in self.documents if d.failure)
        if self.not_started:
            counts[f"not_started_{self.not_started}"] += 1
        if self.sources_not_started:
            counts[f"not_started_{STOP_COST_CAP}_in_folder"] += self.sources_not_started
        if self.comparison is not None:
            counts.update(self.comparison.failures)
        return counts


@dataclass
class EvalRun:
    max_usd: float
    effective_budget_usd: float
    provider_budget_usd: float | None
    started_at: datetime
    files: list[FileRun] = field(default_factory=list)
    stopped_by: str | None = None
    spent_usd: float = 0.0
    duration_s: float = 0.0
    calls: Counter[str] = field(default_factory=Counter)
    models: dict[str, list[str]] = field(default_factory=dict)

    def charged_pages(self) -> int:
        return sum(d.pages for f in self.files for d in f.documents if not d.finished_before)


# ----------------------------------------------------------------------------------------------
# Ledger
# ----------------------------------------------------------------------------------------------


async def ledger_position() -> tuple[int, float]:
    """Last provider_calls id and the summed cost of all calls so far."""
    async with get_sessionmaker()() as session:
        last = await session.scalar(select(func.max(ProviderCall.id)))
        total = await session.scalar(select(func.coalesce(func.sum(ProviderCall.cost_usd), 0.0)))
    return int(last or 0), float(total or 0.0)


async def spent_since(after_id: int, document_ids: Sequence[str] | None = None) -> float:
    query = select(func.coalesce(func.sum(ProviderCall.cost_usd), 0.0)).where(ProviderCall.id > after_id)
    if document_ids is not None:
        query = query.where(ProviderCall.document_id.in_(list(document_ids)))
    async with get_sessionmaker()() as session:
        return float(await session.scalar(query) or 0.0)


async def calls_since(after_id: int, document_ids: Sequence[str] | None = None) -> Counter[str]:
    query = (
        select(ProviderCall.purpose, func.count())
        .where(ProviderCall.id > after_id)
        .group_by(ProviderCall.purpose)
    )
    if document_ids is not None:
        query = query.where(ProviderCall.document_id.in_(list(document_ids)))
    async with get_sessionmaker()() as session:
        rows = (await session.execute(query)).all()
    return Counter({str(purpose): int(n) for purpose, n in rows})


async def models_since(after_id: int) -> dict[str, list[str]]:
    query = select(ProviderCall.purpose, ProviderCall.model).where(ProviderCall.id > after_id).distinct()
    async with get_sessionmaker()() as session:
        rows = (await session.execute(query)).all()
    models: dict[str, set[str]] = {}
    for purpose, model in rows:
        if model:
            models.setdefault(str(purpose), set()).add(str(model))
    return {purpose: sorted(names) for purpose, names in sorted(models.items())}


# ----------------------------------------------------------------------------------------------
# Upload (the API's steps) and collection
# ----------------------------------------------------------------------------------------------


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


async def finished_document(sha256: str) -> bool:
    """A document with these bytes exists and has finished every stage."""
    async with get_sessionmaker()() as session:
        stage = await session.scalar(select(Document.stage).where(Document.sha256 == sha256))
    return stage == STAGES[-1]


async def upload(path: Path, file_name: str) -> tuple[str, bool]:
    """Store a file like `POST /documents` does; returns (document id, reused). Raises ApiError when the
    upload is refused (type, size)."""
    settings = get_settings()
    storage = get_storage()

    def _receive() -> StoredUpload:
        with path.open("rb") as handle:
            return receive(
                handle,
                file_name=display_name(file_name),
                accepted=settings.extensions,
                max_bytes=settings.max_upload_bytes,
                tmp_dir=storage.path("tmp/x").parent,
            )

    stored = await asyncio.to_thread(_receive)
    async with get_sessionmaker()() as session:
        existing = await session.scalar(select(Document).where(Document.sha256 == stored.sha256))
        if existing is not None:
            stored.path.unlink(missing_ok=True)
            return existing.id, True
        key = original_key(stored.sha256, stored.extension)
        await asyncio.to_thread(storage.put_file, key, stored.path)
        doc = Document(
            id=new_id("doc"),
            file_name=display_name(file_name),
            project=None,
            sha256=stored.sha256,
            mime_type=stored.mime_type,
            size_bytes=stored.size_bytes,
            storage_key=key,
            status="queued",
        )
        session.add(doc)
        await session.flush()
        await emit_document_updated(session, doc)
        await session.commit()
        return doc.id, False


def _coordinates(record: Mapping[str, object]) -> tuple[str | None, str | None]:
    meta = record.get("metadata")
    coords = meta.get("coordinates") if isinstance(meta, dict) else None
    if not isinstance(coords, dict):
        return None, None
    x, y = coords.get("x_raw"), coords.get("y_raw")
    return (x if isinstance(x, str) else None), (y if isinstance(y, str) else None)


async def collect(run: DocumentRun, *, budget_prefix: str, after_id: int) -> None:
    """Fill `run` from what the pipeline stored for its document."""
    assert run.document_id is not None
    doc_id = run.document_id
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        if doc is None:
            run.status, run.failure = "missing", "document_missing"
            return
        run.status = doc.status
        run.pages = int(doc.page_count or 0)
        run.pages_ocr = int(
            await session.scalar(
                select(func.count())
                .select_from(Page)
                .where(Page.document_id == doc_id, Page.ocr_status == "done")
            )
            or 0
        )
        dups = set(
            (
                await session.scalars(
                    select(Page.duplicate_of_doc).where(
                        Page.document_id == doc_id, Page.duplicate_of_doc.is_not(None)
                    )
                )
            ).all()
        )
        if doc.duplicate_of:
            dups.add(doc.duplicate_of)
        run.duplicate_docs = frozenset(str(d) for d in dups if d and d != doc_id)
        if doc.status == "failed":
            if (doc.error or "").startswith(budget_prefix):
                run.budget_stop = True
            else:
                payload = await session.scalar(
                    select(Event.payload)
                    .where(Event.document_id == doc_id, Event.type == "job.failed")
                    .order_by(Event.id.desc())
                    .limit(1)
                )
                stage = payload.get("stage") if isinstance(payload, dict) else None
                run.failure = f"failed_at_{stage}" if stage in STAGES else "failed"
        holes = (
            await session.scalars(
                select(Borehole).where(Borehole.document_id == doc_id).order_by(Borehole.uid)
            )
        ).all()
        uids = [h.uid for h in holes]
        layer_rows = (
            await session.execute(
                select(BoreholeLayer.uid, func.count())
                .where(BoreholeLayer.uid.in_(uids))
                .group_by(BoreholeLayer.uid)
            )
        ).all()
    layers = {str(uid): int(n) for uid, n in layer_rows}
    for hole in holes:
        x_raw, y_raw = _coordinates(hole.record or {})
        run.boreholes.append(
            ActualBorehole(
                canonical=hole.label_canonical,
                aliases=frozenset(canonical_label(a) for a in hole.aliases or () if a.strip()),
                x_raw=x_raw,
                y_raw=y_raw,
                crs_status=hole.crs_status,
                unplotted_reason=hole.unplotted_reason,
                depth_m=hole.borehole_depth_m,
                layer_count=layers.get(hole.uid, 0),
            )
        )
    run.cost_usd = await spent_since(after_id, [doc_id])


# ----------------------------------------------------------------------------------------------
# The run
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Prepared:
    path: Path
    file_name: str
    sha256: str
    pages: int


def _prepare(planned: PlannedFile, tmp: Path, pages_if_unknown: int) -> list[_Prepared]:
    prepared: list[_Prepared] = []
    for source in planned.sources:
        path, name = source.path, source.path.name
        if planned.excerpt is not None:
            first, last = planned.excerpt
            path = tmp / f"excerpt-{len(prepared)}.pdf"
            path.write_bytes(excerpt_pdf(source.path, first, last))
            name = f"{source.path.stem} (pages {first}-{last}).pdf"
        pages = pages_if_unknown if source.pages is None else source.pages
        prepared.append(_Prepared(path, name, sha256_of(path), pages))
    return prepared


def _expected_duplicates(current: FileRun, earlier: Sequence[FileRun]) -> set[str] | None:
    """Ids of earlier files of the run that the expected entry links this file to."""
    expected = current.planned.expected
    if expected is None:
        return None
    others = {
        f.short_id: {
            file_key(f.short_id),
            *(f.planned.expected.keys if f.planned.expected is not None else ()),
        }
        - {""}
        for f in earlier
    }
    if expected.duplicate_of is not None:
        wanted = {key for name in expected.duplicate_of for key in name_keys(name)}
        return {short for short, keys in others.items() if keys & wanted}
    if expected.links_text is not None:
        return {short for short, keys in others.items() if mentions(expected.links_text, keys)}
    return None


def compare_all(run: EvalRun) -> None:
    tolerance = float(eval_config()["compare"]["total_depth_tolerance_m"])
    owner = {d.document_id: f.short_id for f in run.files for d in f.documents if d.document_id}
    for index, current in enumerate(run.files):
        if not current.started:
            continue
        earlier = [f for f in run.files[:index] if f.started]
        earlier_ids = {f.short_id for f in earlier}
        found = {
            owner[doc]
            for d in current.documents
            for doc in d.duplicate_docs
            if doc in owner and owner[doc] in earlier_ids
        }
        current.comparison = compare_file(
            current.planned.expected,
            [b for d in current.documents for b in d.boreholes],
            excerpt=current.planned.excerpt,
            duplicates_expected=_expected_duplicates(current, earlier),
            duplicates_found=found,
            tolerance_m=tolerance,
        )


async def run_eval(
    files: Sequence[PlannedFile],
    *,
    max_usd: float,
    estimate_usd_per_page: float | None = None,
    progress: Progress | None = None,
) -> EvalRun:
    """Process `files` in order within the cost caps and compare each with its expected entry."""
    say = progress or (lambda _text: None)
    settings = get_settings()
    configured = settings.provider_budget_usd
    started = time.perf_counter()
    start_id, spent_before = await ledger_position()
    cap_total = spent_before + max(0.0, max_usd)
    effective = cap_total if configured is None else min(configured, cap_total)
    reason = STOP_COST_CAP if configured is None or cap_total <= configured else STOP_PROVIDER_BUDGET
    run = EvalRun(
        max_usd=max_usd,
        effective_budget_usd=effective,
        provider_budget_usd=configured,
        started_at=datetime.now(UTC),
    )
    pages_if_unknown = int(eval_config()["estimate"]["pages_if_unknown"])
    prior = prior_usd_per_page()
    budget_prefix = str(BudgetExceededError(0.0, effective)).split(" (")[0]

    with environment({"PROVIDER_BUDGET_USD": repr(effective)}):
        for number, planned in enumerate(files, start=1):
            current = FileRun(planned)
            run.files.append(current)
            if run.stopped_by is not None:
                current.not_started = run.stopped_by
                continue
            with tempfile.TemporaryDirectory(prefix="geomemory-eval-") as tmp:
                prepared = _prepare(planned, Path(tmp), pages_if_unknown)
                todo_pages = 0
                for item in prepared:
                    if not await finished_document(item.sha256):
                        todo_pages += item.pages
                spent_run = await spent_since(start_id)
                charged = run.charged_pages()
                per_page = (
                    estimate_usd_per_page
                    if estimate_usd_per_page is not None
                    else (spent_run / charged if charged else prior)
                )
                current.estimate_usd = todo_pages * per_page
                if spent_run + current.estimate_usd > max_usd:
                    run.stopped_by = current.not_started = STOP_COST_CAP
                elif configured is not None and await spent_usd() + current.estimate_usd > configured:
                    run.stopped_by = current.not_started = STOP_PROVIDER_BUDGET
                if current.not_started is not None:
                    say(f"[{number}/{len(files)}] {planned.short_id}: not started ({current.not_started})")
                    continue
                say(
                    f"[{number}/{len(files)}] {planned.short_id}: {len(prepared)} document(s), "
                    f"{todo_pages} page(s) to process, estimate {current.estimate_usd:.3f} USD"
                )
                file_started = time.perf_counter()
                for position, item in enumerate(prepared):
                    doc_run = DocumentRun(document_id=None)
                    current.documents.append(doc_run)
                    try:
                        doc_run.document_id, doc_run.reused = await upload(item.path, item.file_name)
                    except ApiError as exc:
                        doc_run.status, doc_run.failure = "rejected", f"upload_{exc.code}"
                        continue
                    doc_run.finished_before = doc_run.reused and await finished_document(item.sha256)
                    began = time.perf_counter()
                    try:
                        await run_pipeline(doc_run.document_id)  # stage failures end up on the document
                        doc_run.duration_s = time.perf_counter() - began
                        await collect(doc_run, budget_prefix=budget_prefix, after_id=start_id)
                    except Exception:  # database or storage trouble: record it and go on with the run
                        logger.exception("eval: processing %s failed", doc_run.document_id)
                        doc_run.status, doc_run.failure = "error", "harness_error"
                        doc_run.duration_s = time.perf_counter() - began
                        continue
                    if doc_run.budget_stop:
                        doc_run.failure = reason
                        run.stopped_by = reason
                        current.sources_not_started = len(prepared) - position - 1
                        break
                current.duration_s = time.perf_counter() - file_started
                doc_ids = [d.document_id for d in current.documents if d.document_id]
                current.cost_usd = await spent_since(start_id, doc_ids)
                current.calls = await calls_since(start_id, doc_ids)
                say(
                    f"[{number}/{len(files)}] {planned.short_id}: "
                    f"{', '.join(sorted({d.status for d in current.documents}))} in "
                    f"{current.duration_s:.0f} s, {current.cost_usd:.3f} USD"
                )
    run.spent_usd = await spent_since(start_id)
    run.calls = await calls_since(start_id)
    run.models = await models_since(start_id)
    run.duration_s = time.perf_counter() - started
    compare_all(run)
    return run
