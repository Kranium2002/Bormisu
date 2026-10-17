"""Server-sent events from the `events` table (contracts/realtime-and-chat.md section 1).

Event ids are `events.seq` (commit order). Replays events after Last-Event-ID, then follows new ones
with LISTEN on a dedicated asyncpg connection.
A `: ping` comment every 15 s keeps proxies from closing the connection.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

import asyncpg
from sqlalchemy import func, select

from app.config import get_settings
from app.db.models import Event
from app.db.session import get_sessionmaker
from app.events.writer import EVENT_CHANNEL

logger = logging.getLogger("geomemory.events")

PING_INTERVAL_S = 15.0
REPLAY_BATCH = 500


def format_event(event_id: int, type_: str, payload: dict[str, Any]) -> str:
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return f"id: {event_id}\nevent: {type_}\ndata: {data}\n\n"


async def _events_after(after_id: int, document_id: str | None) -> list[Event]:
    async with get_sessionmaker()() as session:
        query = select(Event).where(Event.seq > after_id)
        if document_id is not None:
            query = query.where(Event.document_id == document_id)
        return list((await session.scalars(query.order_by(Event.seq).limit(REPLAY_BATCH))).all())


async def _latest_id() -> int:
    async with get_sessionmaker()() as session:
        latest = await session.scalar(select(func.max(Event.seq)))
        return int(latest or 0)


async def event_stream(
    last_event_id: int | None,
    document_id: str | None,
    is_disconnected: Callable[[], Any],
    ping_interval: float = PING_INTERVAL_S,
) -> AsyncIterator[str]:
    """Yield SSE frames. Without Last-Event-ID the stream starts at the newest event (no history)."""
    wake = asyncio.Event()
    conn: asyncpg.Connection | None = None

    def _on_notify(*_: Any) -> None:
        wake.set()

    try:
        conn = await asyncpg.connect(get_settings().asyncpg_dsn)
        await conn.add_listener(EVENT_CHANNEL, _on_notify)
    except (OSError, asyncpg.PostgresError):
        logger.warning("event stream could not LISTEN; falling back to periodic polling")
        conn = None
    try:
        cursor = last_event_id if last_event_id is not None else await _latest_id()
        yield ": connected\n\n"
        while True:
            while True:
                batch = await _events_after(cursor, document_id)
                for event in batch:
                    cursor = int(event.seq or cursor)
                    yield format_event(cursor, event.type, event.payload)
                if len(batch) < REPLAY_BATCH:
                    break
            if await is_disconnected():
                return
            wake.clear()
            try:
                await asyncio.wait_for(wake.wait(), timeout=ping_interval if conn is not None else 2.0)
            except TimeoutError:
                if conn is not None:
                    yield ": ping\n\n"
    finally:
        if conn is not None:
            try:
                await conn.remove_listener(EVENT_CHANNEL, _on_notify)
            finally:
                await conn.close()
