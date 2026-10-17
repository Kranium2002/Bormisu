"""Event writer: the event row is written in the caller's transaction, then pushed with NOTIFY.

NOTIFY is transactional in PostgreSQL, so listeners only hear about events whose change committed.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Event

EVENT_CHANNEL = "events"

EVENT_TYPES = frozenset(
    {
        "document.updated",
        "document.deleted",
        "borehole.created",
        "borehole.updated",
        "clarification.created",
        "clarification.resolved",
        "job.failed",
    }
)


async def emit(
    session: AsyncSession, type_: str, payload: dict[str, Any], document_id: str | None = None
) -> int:
    if type_ not in EVENT_TYPES:
        raise ValueError(f"unknown event type {type_!r}")
    event = Event(type=type_, document_id=document_id, payload=payload)
    session.add(event)
    await session.flush()
    await session.execute(
        text("SELECT pg_notify(:channel, :id)"), {"channel": EVENT_CHANNEL, "id": str(event.id)}
    )
    return int(event.id)
