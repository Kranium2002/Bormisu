"""Clarification inbox: list, answer, skip, and ranked CRS candidates for a crs_confirm question."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser, actor_name
from app.clarify.answers import answer_clarification, skip_clarification
from app.clarify.service import clarification_out
from app.db.models import Borehole, Clarification
from app.db.session import get_session
from app.errors import not_found
from app.geo.crs_candidates import candidates_for_boreholes
from app.schemas.clarifications import ClarificationAnswer, ClarificationOut
from app.schemas.documents import CrsCandidate

router = APIRouter(tags=["clarifications"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]


@router.get("/clarifications", response_model=list[ClarificationOut], operation_id="listClarifications")
async def list_clarifications(
    session: SessionDep,
    status: Literal["open", "answered", "skipped"] = "open",
    document_id: str | None = None,
) -> list[ClarificationOut]:
    query = select(Clarification).where(Clarification.status == status)
    if document_id is not None:
        query = query.where(Clarification.document_id == document_id)
    rows = (await session.scalars(query.order_by(Clarification.created_at, Clarification.id))).all()
    return [clarification_out(row) for row in rows]


@router.post(
    "/clarifications/{clarification_id}/answer",
    response_model=ClarificationOut,
    operation_id="answerClarification",
)
async def post_answer(
    clarification_id: str, body: ClarificationAnswer, session: SessionDep, user: CurrentUser
) -> ClarificationOut:
    # answered_by is the signed-in user (contract 1.4.0); ClarificationAnswer.answered_by is ignored.
    row = await answer_clarification(session, clarification_id, body.values, actor_name(user))
    await session.commit()
    await session.refresh(row)
    return clarification_out(row)


@router.post(
    "/clarifications/{clarification_id}/skip",
    response_model=ClarificationOut,
    operation_id="skipClarification",
)
async def post_skip(clarification_id: str, session: SessionDep) -> ClarificationOut:
    row = await skip_clarification(session, clarification_id)
    await session.commit()
    await session.refresh(row)
    return clarification_out(row)


@router.get(
    "/clarifications/{clarification_id}/crs-candidates",
    response_model=list[CrsCandidate],
    operation_id="listClarificationCrsCandidates",
)
async def list_clarification_crs_candidates(clarification_id: str, session: SessionDep) -> list[CrsCandidate]:
    """Candidates for every borehole the question covers (they may come from several documents)."""
    row = await session.get(Clarification, clarification_id)
    if row is None:
        raise not_found("clarification_not_found", "Clarification")
    if row.kind != "crs_confirm" or not row.borehole_uids:
        return []
    boreholes = (
        await session.scalars(
            select(Borehole).where(Borehole.uid.in_(list(row.borehole_uids))).order_by(Borehole.uid)
        )
    ).all()
    return await candidates_for_boreholes(session, list(boreholes))
