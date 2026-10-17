"""Live updates as server-sent events."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, Request
from fastapi.responses import StreamingResponse

from app.events.stream import event_stream

router = APIRouter(tags=["events"])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


def _parse_last_id(value: str | None) -> int | None:
    if value is None:
        return None
    text = value.strip()
    return int(text) if text.isdigit() else None


@router.get(
    "/events",
    operation_id="streamEvents",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}},
)
async def stream_events(
    request: Request,
    document_id: str | None = None,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    frames = event_stream(_parse_last_id(last_event_id), document_id, request.is_disconnected)
    return StreamingResponse(frames, media_type="text/event-stream", headers=SSE_HEADERS)
