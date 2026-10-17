"""Clarification requests: creation (idempotent), read model and events."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Clarification
from app.events.writer import emit
from app.ids import new_id
from app.schemas.clarifications import ClarificationOut, Evidence, FormField


def clarification_out(row: Clarification) -> ClarificationOut:
    return ClarificationOut.model_validate(
        {
            "clarification_id": row.id,
            "kind": row.kind,
            "status": row.status,
            "document_id": row.document_id,
            "borehole_uids": list(row.borehole_uids or []),
            "path": row.path,
            "question": row.question,
            "fields": row.fields or [],
            "evidence": row.evidence or [],
            "answer": row.answer,
            "answered_by": row.answered_by,
            "created_at": row.created_at,
            "resolved_at": row.resolved_at,
        }
    )


async def create_clarification(
    session: AsyncSession,
    *,
    kind: str,
    document_id: str,
    question: str,
    fields: Sequence[FormField | dict[str, Any]],
    evidence: Sequence[Evidence | dict[str, Any]] = (),
    borehole_uids: Sequence[str] = (),
    path: str | None = None,
    project: str | None = None,
    dedupe_key: str | None = None,
) -> Clarification:
    """Create an open clarification and emit `clarification.created`.

    With `dedupe_key`, asking the same question again returns the existing row (pipeline reruns are no-ops).
    """
    if dedupe_key is not None:
        existing = await session.scalar(select(Clarification).where(Clarification.dedupe_key == dedupe_key))
        if existing is not None:
            return existing
    field_models = [f if isinstance(f, FormField) else FormField.model_validate(f) for f in fields]
    evidence_models = [e if isinstance(e, Evidence) else Evidence.model_validate(e) for e in evidence]
    row = Clarification(
        id=new_id("cl"),
        kind=kind,
        status="open",
        document_id=document_id,
        project=project,
        borehole_uids=list(borehole_uids),
        path=path,
        question=question,
        fields=[f.model_dump(mode="json") for f in field_models],
        evidence=[e.model_dump(mode="json") for e in evidence_models],
        dedupe_key=dedupe_key,
    )
    session.add(row)
    await session.flush()
    await session.refresh(row)
    payload = clarification_out(row).model_dump(mode="json")
    await emit(session, "clarification.created", payload, document_id=document_id)
    return row


async def reemit_clarification(session: AsyncSession, row: Clarification) -> None:
    """A changed question is sent again in full (the inbox replaces it by id)."""
    await session.flush()
    await emit(
        session,
        "clarification.created",
        clarification_out(row).model_dump(mode="json"),
        document_id=row.document_id,
    )


async def add_boreholes(session: AsyncSession, row: Clarification, uids: Sequence[str]) -> bool:
    """An unanswered question of a document grows to cover more of its boreholes (re-sent when it does)."""
    if row.status == "answered":
        return False
    new = [uid for uid in uids if uid not in (row.borehole_uids or [])]
    if not new:
        return False
    row.borehole_uids = [*(row.borehole_uids or []), *new]
    await reemit_clarification(session, row)
    return True


async def resolve_clarification(
    session: AsyncSession,
    row: Clarification,
    *,
    status: str,
    answer: Any = None,
    answered_by: str | None = None,
) -> None:
    """Mark answered or skipped and emit `clarification.resolved` (skip keeps it listable under `skipped`).

    The event names the question's document and boreholes (contract 1.2.0) for a targeted refresh.
    """
    row.status = status
    if status == "answered":
        row.answer = answer
        row.answered_by = answered_by
        row.resolved_at = datetime.now(UTC)
    await session.flush()
    payload = {
        "clarification_id": row.id,
        "status": status,
        "document_id": row.document_id,
        "borehole_uids": list(row.borehole_uids or []),
    }
    await emit(session, "clarification.resolved", payload, document_id=row.document_id)
