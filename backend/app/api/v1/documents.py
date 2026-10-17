"""Documents: upload, list, detail, page images, per-document boreholes, approve-clean, CRS, retry, delete."""

from __future__ import annotations

import asyncio
import io
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from PIL import Image
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException
from starlette.types import Message

from app.config import get_settings
from app.db.models import Borehole, Document, Page
from app.db.session import get_session
from app.errors import ApiError, error_response, not_found
from app.events.writer import emit
from app.geo.crs_candidates import rank_candidates
from app.geo.crs_service import confirm_crs
from app.ids import new_id
from app.pipeline.orchestrator import enqueue_document
from app.review.service import approve_clean, to_records
from app.schemas.boreholes import BoreholeRecord
from app.schemas.documents import (
    ApproveCleanResult,
    CrsCandidate,
    CrsConfirmRequest,
    CrsConfirmResult,
    DocumentList,
    DocumentOut,
    UploadAccepted,
)
from app.services.documents import document_out, documents_out, emit_document_updated
from app.storage import document_prefix, get_storage, original_key, page_resized_key
from app.upload import display_name, receive

logger = logging.getLogger("geomemory.documents")
router = APIRouter(tags=["documents"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
# Multipart framing around the file is small; anything far above the limit is refused before parsing.
_MULTIPART_SLACK = 1024 * 1024
DEFAULT_PAGE_WIDTH = 1400
MIN_PAGE_WIDTH, MAX_PAGE_WIDTH = 200, 2400
ACTOR_API = "api"


def _limit_body(request: Request, limit: int, limit_mb: int) -> None:
    """Abort reading the request body once it passes `limit` bytes."""
    receive = request._receive
    seen = 0

    async def counting_receive() -> Message:
        nonlocal seen
        message = await receive()
        if message["type"] == "http.request":
            seen += len(message.get("body", b""))
            if seen > limit:
                raise ApiError(413, "too_large", f"The file is larger than {limit_mb} MB.")
        return message

    request._receive = counting_receive


async def _document(session: AsyncSession, document_id: str) -> Document:
    doc = await session.get(Document, document_id)
    if doc is None:
        raise not_found("document_not_found", "Document")
    return doc


@router.get("/documents", response_model=DocumentList, operation_id="listDocuments")
async def list_documents(session: SessionDep) -> DocumentList:
    docs = (await session.scalars(select(Document).order_by(Document.created_at.desc(), Document.id.desc()))).all()
    return DocumentList(documents=await documents_out(session, docs))


@router.post(
    "/documents",
    response_model=UploadAccepted,
    status_code=202,
    operation_id="uploadDocument",
    responses={200: {"model": UploadAccepted}},
)
async def upload_document(request: Request, session: SessionDep) -> Response:
    settings = get_settings()
    if settings.mode != "live":
        return error_response(409, "demo_mode", "demo_mode")
    length = request.headers.get("content-length")
    if length is not None and length.isdigit() and int(length) > settings.max_upload_bytes + _MULTIPART_SLACK:
        raise ApiError(413, "too_large", f"The file is larger than {settings.max_upload_mb} MB.")
    _limit_body(request, settings.max_upload_bytes + _MULTIPART_SLACK, settings.max_upload_mb)
    try:
        form = await request.form(max_files=1, max_fields=5)
    except MultiPartException as exc:
        raise ApiError(
            422, "validation_error", "The upload is not valid multipart form data.", [{"loc": ["body"], "msg": str(exc)}]
        ) from exc
    try:
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise ApiError(
                422,
                "validation_error",
                "The request is not valid.",
                [{"loc": ["body", "file"], "msg": "Field required"}],
            )
        project_raw = form.get("project")
        project = project_raw.strip()[:200] or None if isinstance(project_raw, str) else None
        file_name = display_name(upload.filename)
        storage = get_storage()
        stored = await asyncio.to_thread(
            receive,
            upload.file,
            file_name=file_name,
            accepted=settings.extensions,
            max_bytes=settings.max_upload_bytes,
            tmp_dir=storage.path("tmp/x").parent,
        )
    finally:
        await form.close()

    existing = await session.scalar(select(Document).where(Document.sha256 == stored.sha256))
    if existing is not None:
        stored.path.unlink(missing_ok=True)
        body = UploadAccepted(document_id=existing.id, status=existing.status, duplicate_of=existing.id)
        return JSONResponse(body.model_dump(mode="json"), status_code=200)

    key = original_key(stored.sha256, stored.extension)
    await asyncio.to_thread(storage.put_file, key, stored.path)
    doc = Document(
        id=new_id("doc"),
        file_name=file_name,
        project=project,
        sha256=stored.sha256,
        mime_type=stored.mime_type,
        size_bytes=stored.size_bytes,
        storage_key=key,
        status="queued",
    )
    session.add(doc)
    try:
        await session.flush()
    except IntegrityError:
        # Same bytes uploaded concurrently: answer like a duplicate.
        await session.rollback()
        twin = await session.scalar(select(Document).where(Document.sha256 == stored.sha256))
        if twin is None:
            raise
        body = UploadAccepted(document_id=twin.id, status=twin.status, duplicate_of=twin.id)
        return JSONResponse(body.model_dump(mode="json"), status_code=200)
    await emit_document_updated(session, doc)
    await session.commit()
    try:
        await enqueue_document(doc.id)
    except Exception:
        logger.exception("could not queue document %s", doc.id)
        doc.status = "failed"
        doc.error = "Processing could not be queued. Retry the document."
        await emit_document_updated(session, doc)
        await session.commit()
    body = UploadAccepted(document_id=doc.id, status=doc.status, duplicate_of=None)
    return JSONResponse(body.model_dump(mode="json"), status_code=202)


@router.get("/documents/{document_id}", response_model=DocumentOut, operation_id="getDocument")
async def get_document(document_id: str, session: SessionDep) -> DocumentOut:
    return await document_out(session, await _document(session, document_id))


@router.delete("/documents/{document_id}", status_code=204, operation_id="deleteDocument")
async def delete_document(document_id: str, session: SessionDep) -> Response:
    doc = await _document(session, document_id)
    storage = get_storage()
    original = doc.storage_key
    await session.delete(doc)
    await emit(session, "document.deleted", {"document_id": document_id}, document_id=document_id)
    await session.commit()
    await asyncio.to_thread(storage.delete_prefix, document_prefix(document_id))
    await asyncio.to_thread(storage.delete, original)
    return Response(status_code=204)


@router.post(
    "/documents/{document_id}/retry", response_model=UploadAccepted, status_code=202, operation_id="retryDocument"
)
async def retry_document(document_id: str, session: SessionDep) -> UploadAccepted:
    doc = await _document(session, document_id)
    if doc.status != "failed":
        raise ApiError(409, "not_failed", "Only failed documents can be retried.")
    doc.status = "queued"
    doc.error = None
    await emit_document_updated(session, doc)
    await session.commit()
    try:
        await enqueue_document(doc.id)
    except Exception:
        logger.exception("could not queue document %s", doc.id)
        doc.status = "failed"
        doc.error = "Processing could not be queued. Retry the document."
        await emit_document_updated(session, doc)
        await session.commit()
        raise ApiError(503, "internal_error", "Processing could not be queued. Try again shortly.") from None
    return UploadAccepted(document_id=doc.id, status="queued", duplicate_of=None)


def _resize(source: bytes, width: int) -> bytes:
    with Image.open(io.BytesIO(source)) as img:
        if img.width <= width:
            return source
        height = max(1, round(img.height * width / img.width))
        resized = img.resize((width, height), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        resized.save(out, format="PNG", optimize=True)
        return out.getvalue()


@router.get(
    "/documents/{document_id}/pages/{n}.png",
    operation_id="getPageImage",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
)
async def get_page_image(
    document_id: str,
    n: int,
    session: SessionDep,
    w: Annotated[int | None, Query()] = None,
) -> Response:
    await _document(session, document_id)
    page = await session.get(Page, (document_id, n)) if n >= 1 else None
    storage = get_storage()
    if page is None or page.render_key is None or not storage.exists(page.render_key):
        raise not_found("page_not_found", "Page")
    width = min(max(w if w is not None else DEFAULT_PAGE_WIDTH, MIN_PAGE_WIDTH), MAX_PAGE_WIDTH)
    cache_key = page_resized_key(document_id, n, width)
    if storage.exists(cache_key):
        data = await asyncio.to_thread(storage.get_bytes, cache_key)
    else:
        source = await asyncio.to_thread(storage.get_bytes, page.render_key)
        data = await asyncio.to_thread(_resize, source, width)
        await asyncio.to_thread(storage.put_bytes, cache_key, data)
    return Response(content=data, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.get(
    "/documents/{document_id}/boreholes",
    response_model=list[BoreholeRecord],
    operation_id="listDocumentBoreholes",
)
async def list_document_boreholes(document_id: str, session: SessionDep) -> list[BoreholeRecord]:
    await _document(session, document_id)
    rows = (await session.scalars(select(Borehole).where(Borehole.document_id == document_id).order_by(Borehole.uid))).all()
    return await to_records(session, rows)


@router.post(
    "/documents/{document_id}/approve-clean", response_model=ApproveCleanResult, operation_id="approveClean"
)
async def approve_clean_values(
    document_id: str, session: SessionDep, dry_run: Annotated[bool, Query()] = True
) -> ApproveCleanResult:
    await _document(session, document_id)
    count = await approve_clean(session, document_id, dry_run=dry_run, actor=ACTOR_API)
    if not dry_run:
        await session.commit()
    return ApproveCleanResult(count=count)


def _local_points(boreholes: list[Borehole]) -> list[tuple[str, float, float]]:
    points = []
    for bh in boreholes:
        coords = (bh.record.get("metadata") or {}).get("coordinates") or {}
        x, y = coords.get("local_x"), coords.get("local_y")
        if isinstance(x, int | float) and isinstance(y, int | float):
            points.append((bh.uid, float(x), float(y)))
    return points


@router.get(
    "/documents/{document_id}/crs-candidates", response_model=list[CrsCandidate], operation_id="listCrsCandidates"
)
async def list_crs_candidates(document_id: str, session: SessionDep) -> list[CrsCandidate]:
    await _document(session, document_id)
    rows = list((await session.scalars(select(Borehole).where(Borehole.document_id == document_id))).all())
    return await asyncio.to_thread(rank_candidates, _local_points(rows))


@router.post("/documents/{document_id}/crs", response_model=CrsConfirmResult, operation_id="confirmCrs")
async def confirm_document_crs(document_id: str, body: CrsConfirmRequest, session: SessionDep) -> CrsConfirmResult:
    await _document(session, document_id)
    uids = list((await session.scalars(select(Borehole.uid).where(Borehole.document_id == document_id))).all())
    actor = (body.confirmed_by or "").strip()[:100] or ACTOR_API
    updated = await confirm_crs(session, uids, crs=body.crs, swap_axes=body.swap_axes, actor=actor, note=body.note)
    await session.commit()
    return CrsConfirmResult(updated=updated)
