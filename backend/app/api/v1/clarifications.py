"""Clarification inbox: list, answer, skip."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.answers import answer_clarification, skip_clarification
from app.clarify.service import clarification_out
from app.db.models import Clarification
from app.db.session import get_session
from app.schemas.clarifications import ClarificationAnswer, ClarificationOut

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
async def post_answer(clarification_id: str, body: ClarificationAnswer, session: SessionDep) -> ClarificationOut:
    row = await answer_clarification(session, clarification_id, body.values, body.answered_by)
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
