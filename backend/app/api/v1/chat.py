"""Chat turn: streams the AI SDK UI message stream v1 (contracts/realtime-and-chat.md section 2)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.v1.system import CHAT_IMPLEMENTED
from app.chat.loop import ChatModel, chat_stream, get_chat_model
from app.chat.stream import STREAM_HEADERS
from app.config import get_settings
from app.errors import ApiError
from app.schemas.clarifications import ChatRequest

router = APIRouter(tags=["chat"])


@router.post(
    "/chat",
    operation_id="chat",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "text/event-stream with header x-vercel-ai-ui-message-stream v1.",
            "content": {"text/event-stream": {}},
        },
        409: {"description": "chat_unavailable"},
    },
)
async def chat(
    body: ChatRequest, model: Annotated[ChatModel | None, Depends(get_chat_model)]
) -> StreamingResponse:
    if not CHAT_IMPLEMENTED or model is None or not get_settings().chat_configured:
        raise ApiError(409, "chat_unavailable", "Chat is not configured on this server.")
    return StreamingResponse(chat_stream(body, model), headers=STREAM_HEADERS)
