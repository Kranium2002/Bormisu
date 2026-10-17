"""Live updates as server-sent events."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse

from app.events.stream import event_stream

router = APIRouter(tags=["events"])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


def _parse_last_id(value: str | None) -> int | None:
    if value is None:
        return None
    text = value.strip()
    return int(text) if text.isdigit() else None


def resume_after(header: str | None, query: int | None) -> int | None:
    """The event id to replay after (contract 1.2.0): the Last-Event-ID header wins over ?last_event_id=.

    A header that is not a whole number is ignored, so the query parameter (or the newest event) applies.
    """
    from_header = _parse_last_id(header)
    return from_header if from_header is not None else query


@router.get(
    "/events",
    operation_id="streamEvents",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
async def stream_events(
    request: Request,
    document_id: str | None = None,
    last_event_id_query: Annotated[
        int | None,
        Query(
            alias="last_event_id",
            ge=0,
            description="Replay every stored event after this id; the Last-Event-ID header wins.",
        ),
    ] = None,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    after = resume_after(last_event_id, last_event_id_query)
    frames = event_stream(after, document_id, request.is_disconnected)
    return StreamingResponse(frames, media_type="text/event-stream", headers=SSE_HEADERS)
