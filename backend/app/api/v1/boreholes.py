"""Boreholes: filtered list, one record by exact uid, review PATCH."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser, actor_name
from app.db.models import Borehole, ResultSet
from app.db.session import get_session
from app.errors import ApiError, not_found
from app.geo.filters import filter_conditions
from app.review.service import apply_patch, to_record, to_records
from app.schemas.boreholes import BoreholeList, BoreholeRecord, ValuePatch
from app.schemas.map import BoreholeFilter

router = APIRouter(tags=["boreholes"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]


@router.get("/boreholes", response_model=BoreholeList, operation_id="listBoreholes")
async def list_boreholes(
    session: SessionDep,
    search: str | None = None,
    country: str | None = None,
    min_depth_m: Annotated[float | None, Query(ge=0)] = None,
    max_depth_m: Annotated[float | None, Query(ge=0)] = None,
    din4023_code: Annotated[list[str] | None, Query()] = None,
    document_id: str | None = None,
    result_set_id: str | None = None,
    plotted: bool | None = None,
    include_unreviewed: bool = True,
    limit: Annotated[int, Query(ge=1, le=5000)] = 5000,
    cursor: str | None = None,
) -> BoreholeList:
    filt = BoreholeFilter(
        search=search,
        country=country,
        min_depth_m=min_depth_m,
        max_depth_m=max_depth_m,
        din4023_codes=din4023_code or [],
        document_id=document_id,
        include_unreviewed=include_unreviewed,
    )
    conds = filter_conditions(filt)
    if plotted is not None:
        conds.append(Borehole.plotted.is_(plotted))
    if result_set_id is not None:
        rs = await session.scalar(
            select(ResultSet).where(ResultSet.id == result_set_id, ResultSet.expires_at > func.now())
        )
        if rs is None:
            raise not_found("result_set_not_found", "Result set")
        conds.append(Borehole.uid.in_(list(rs.uids)))
    total = await session.scalar(select(func.count()).select_from(Borehole).where(*conds)) or 0
    query = select(Borehole).where(*conds)
    if cursor:
        query = query.where(Borehole.uid > cursor)
    rows = list((await session.scalars(query.order_by(Borehole.uid).limit(limit + 1))).all())
    next_cursor = rows[limit - 1].uid if len(rows) > limit else None
    return BoreholeList(
        count=total, boreholes=await to_records(session, rows[:limit]), next_cursor=next_cursor
    )


@router.get("/boreholes/{uid}", response_model=BoreholeRecord, operation_id="getBorehole")
async def get_borehole(uid: str, session: SessionDep) -> BoreholeRecord:
    bh = await session.get(Borehole, uid)
    if bh is None:
        raise not_found("borehole_not_found", "Borehole")
    return await to_record(session, bh)


@router.patch("/boreholes/{uid}/values", response_model=BoreholeRecord, operation_id="patchValue")
async def patch_value(uid: str, patch: ValuePatch, session: SessionDep, user: CurrentUser) -> BoreholeRecord:
    if patch.action == "flag" and patch.reason is not None and len(patch.reason) > 2000:
        errors = [{"loc": ["body", "reason"], "msg": "At most 2000 characters"}]
        raise ApiError(422, "validation_error", "The flag reason is too long.", errors)
    # The actor is the signed-in user (contract 1.3.0); ValuePatch.confirmed_by is ignored.
    bh = await apply_patch(session, uid, patch, actor=actor_name(user))
    await session.commit()
    return await to_record(session, bh)
