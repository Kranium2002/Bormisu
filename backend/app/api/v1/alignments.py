"""Planned lines: upload (GeoJSON, KML, GPX, CSV), list, get, delete, and the boreholes along a line."""

from __future__ import annotations

import math
from typing import Annotated

from fastapi import APIRouter, Body, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException

from app.db.session import get_session
from app.errors import ApiError
from app.geo.alignment_files import MAX_BYTES, file_format, parse_line
from app.geo.alignments import (
    alignment_out,
    create_alignment,
    delete_alignment,
    get_alignment,
    list_alignments,
    load_parts,
    query_alignment,
)
from app.schemas.alignments import (
    DEFAULT_BUFFER_M,
    MAX_BUFFER_M,
    AlignmentList,
    AlignmentOut,
    AlignmentQuery,
    AlignmentResult,
)
from app.upload import display_name

router = APIRouter(tags=["alignments"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]
_MULTIPART_SLACK = 64 * 1024


def _field_error(name: str, msg: str) -> ApiError:
    return ApiError(
        422, "validation_error", "The request is not valid.", [{"loc": ["body", name], "msg": msg}]
    )


def _buffer(raw: object) -> float:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return DEFAULT_BUFFER_M
    try:
        value = float(str(raw).strip().replace(",", "."))
    except ValueError:
        raise _field_error("buffer_m", "must be a number of metres") from None
    if not (math.isfinite(value) and 0 < value <= MAX_BUFFER_M):
        raise _field_error("buffer_m", f"must be greater than 0 and at most {MAX_BUFFER_M:g}")
    return value


def _epsg(raw: object) -> int | None:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    text = str(raw).strip().upper().removeprefix("EPSG:").strip()
    if not text.isdigit():
        raise _field_error("epsg", "must be an EPSG code such as 25832")
    return int(text)


@router.get("/alignments", response_model=AlignmentList, operation_id="listAlignments")
async def get_alignments(session: SessionDep) -> AlignmentList:
    return AlignmentList(alignments=await list_alignments(session))


@router.post("/alignments", response_model=AlignmentOut, status_code=201, operation_id="uploadAlignment")
async def upload_alignment(request: Request, session: SessionDep) -> AlignmentOut:
    length = request.headers.get("content-length")
    if length is not None and length.isdigit() and int(length) > MAX_BYTES + _MULTIPART_SLACK:
        raise ApiError(413, "too_large", f"The file is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    try:
        form = await request.form(max_files=1, max_fields=5)
    except MultiPartException as exc:
        raise ApiError(
            422,
            "validation_error",
            "The upload is not valid multipart form data.",
            [{"loc": ["body"], "msg": str(exc)}],
        ) from exc
    try:
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise _field_error("file", "Field required")
        file_name = display_name(upload.filename)
        file_format(file_name)  # 415 before reading an unsupported file
        buffer_m = _buffer(form.get("buffer_m"))
        epsg = _epsg(form.get("epsg"))
        name_raw = form.get("name")
        name = name_raw if isinstance(name_raw, str) else None
        data = await upload.read(MAX_BYTES + 1)
    finally:
        await form.close()
    parsed = parse_line(data, file_name, epsg)
    alignment, parts = await create_alignment(
        session, parsed, name=name, file_name=file_name, buffer_m=buffer_m
    )
    await session.commit()
    return alignment_out(alignment, parts)


@router.get("/alignments/{alignment_id}", response_model=AlignmentOut, operation_id="getAlignment")
async def read_alignment(alignment_id: str, session: SessionDep) -> AlignmentOut:
    alignment = await get_alignment(session, alignment_id)
    return alignment_out(alignment, await load_parts(session, alignment_id))


@router.delete("/alignments/{alignment_id}", status_code=204, operation_id="deleteAlignment")
async def remove_alignment(alignment_id: str, session: SessionDep) -> Response:
    await delete_alignment(session, alignment_id)
    await session.commit()
    return Response(status_code=204)


@router.post(
    "/alignments/{alignment_id}/query", response_model=AlignmentResult, operation_id="queryAlignment"
)
async def post_alignment_query(
    alignment_id: str, session: SessionDep, query: Annotated[AlignmentQuery | None, Body()] = None
) -> AlignmentResult:
    query = query or AlignmentQuery()
    alignment = await get_alignment(session, alignment_id)
    result = await query_alignment(
        session,
        alignment,
        buffer_m=query.buffer_m if query.buffer_m is not None else alignment.buffer_m,
        include_unreviewed=query.include_unreviewed,
    )
    await session.commit()
    return result
