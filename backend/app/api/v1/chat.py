"""Chat turn (AI SDK UI message stream v1). The tool loop ships in M3; until then the endpoint says so."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.system import CHAT_IMPLEMENTED
from app.config import get_settings
from app.errors import ApiError
from app.schemas.clarifications import ChatRequest

router = APIRouter(tags=["chat"])


@router.post("/chat", operation_id="chat", responses={409: {"description": "chat_unavailable"}})
async def chat(body: ChatRequest) -> None:
    if not get_settings().chat_configured:
        raise ApiError(409, "chat_unavailable", "The chat assistant is not configured on this server.")
    if not CHAT_IMPLEMENTED:
        raise ApiError(409, "chat_unavailable", "The chat assistant is not available in this build yet.")
    raise ApiError(409, "chat_unavailable", "The chat assistant is not available.")
