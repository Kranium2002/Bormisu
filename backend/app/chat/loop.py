"""One chat turn: the OpenAI Responses loop behind POST /api/v1/chat.

The model gets the system prompt, a compact context note and the user's text, plus the strict function
tools of `app.chat.registry`. Text deltas stream out as `text-delta`; each completed function call is
validated, run against the database and answered with `function_call_output`, while the UI receives
`tool-input-available`, `tool-output-available` and the tool's data parts. At most MAX_TOOL_ROUNDS
rounds of tool calls run per turn (then the model must answer in text) and the whole turn has
TURN_TIMEOUT_S. Requests use stream=True and store=False, so nothing persists at the provider.

The model client is a callable that takes the request body and yields Responses streaming events as
JSON objects (`openai_model` for the real API; tests inject hand-written fictional events).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import openai
from pydantic import ValidationError
from ulid import ULID

from app.chat.prompts import context_message, system_prompt, user_messages
from app.chat.registry import function_tools, get_tool
from app.chat.stream import DONE_FRAME, Chunk, MessageWriter, encode
from app.chat.tools import ToolError, TurnState, compute_scope, validation_message
from app.config import get_settings
from app.db.session import get_sessionmaker
from app.errors import ApiError
from app.providers.base import BudgetExceededError, Usage, check_budget, record_usage, token_cost
from app.schemas.clarifications import ChatRequest

logger = logging.getLogger("geomemory.chat")

ChatEvent = dict[str, Any]
ChatModel = Callable[[dict[str, Any]], AsyncIterator[ChatEvent]]

MAX_TOOL_ROUNDS = 8
TURN_TIMEOUT_S = 60.0

TIMEOUT_TEXT = "The chat model did not answer in time. Please try again."
FAILED_TEXT = "The chat model could not answer. Please try again."
BUSY_TEXT = "The chat model is busy. Please try again shortly."
UNREACHABLE_TEXT = "The chat model is not reachable. Please try again."
REFUSED_TEXT = "The chat model refused this server's credentials."
BUDGET_TEXT = "The server's provider budget is used up, so the chat cannot answer."
NO_QUESTION_TEXT = "Ask a question to start the chat."
NO_ANSWER_TEXT = "The chat model gave no answer. Please try again."


class ChatError(Exception):
    """Ends the turn with an `error` chunk; the message is safe to show (no internals, no keys)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class FunctionCall:
    call_id: str
    name: str
    arguments: str


def new_message_id() -> str:
    return f"msg_{ULID()}"


# ------------------------------------------------------------------------------------------------
# Tool calls
# ------------------------------------------------------------------------------------------------


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


async def execute_call(call: FunctionCall, state: TurnState, out: MessageWriter) -> dict[str, Any]:
    """Run one function call and return what the model gets back.

    A name outside the registry or arguments its input model rejects never reach the UI: the model
    gets the reason and may try again. Valid calls are shown (input, output, data parts, commands).
    """
    tool = get_tool(call.name)
    if tool is None:
        logger.warning("chat model called an unregistered tool")
        return _error("unknown_tool", "There is no such tool. Use only the tools you were given.")
    try:
        raw = json.loads(call.arguments) if call.arguments.strip() else {}
        if not isinstance(raw, dict):
            raise TypeError("arguments are not an object")
        inp = tool.input_model.model_validate(raw)
        shown = tool.show(inp, state)
    except ValidationError as exc:
        return _error("invalid_arguments", validation_message(exc))
    except (ValueError, TypeError):
        return _error("invalid_arguments", "The arguments are not a JSON object.")
    out.tool_input(call.call_id, tool.name, shown)
    try:
        async with get_sessionmaker()() as session:
            result = await tool.run(inp, state, session)
            await session.commit()
    except ToolError as exc:
        out.tool_output(call.call_id, exc.output())
        return exc.output()
    except ApiError as exc:
        failure = _error(exc.code, exc.detail)
        out.tool_output(call.call_id, failure)
        return failure
    except Exception:
        ref = uuid.uuid4().hex[:12]
        logger.exception("chat tool %s failed ref=%s", tool.name, ref)
        failure = _error("internal_error", f"The tool failed (reference {ref}).")
        out.tool_output(call.call_id, failure)
        return failure
    out.tool_output(call.call_id, result.output)
    for part in result.parts:
        out.data(part.type, part.data, part.id)
    for command in result.commands:
        out.command(command)
    if tool.factual:
        state.factual = True
    return result.model_output if result.model_output is not None else result.output


# ------------------------------------------------------------------------------------------------
# Model rounds
# ------------------------------------------------------------------------------------------------


async def _record(response: Any, *, ok: bool) -> None:
    """Ledger row for one model response (tokens as reported; cost from the price table)."""
    if not isinstance(response, dict):
        return
    reported = response.get("usage")
    usage: dict[str, Any] = reported if isinstance(reported, dict) else {}
    model_id = response.get("model") if isinstance(response.get("model"), str) else None
    tokens_in = usage.get("input_tokens") if isinstance(usage.get("input_tokens"), int) else None
    tokens_out = usage.get("output_tokens") if isinstance(usage.get("output_tokens"), int) else None
    cost = token_cost(model_id, tokens_in, tokens_out) if model_id else 0.0
    try:
        await record_usage(
            Usage("openai", "chat", model_id, tokens_in, tokens_out, cost_usd=cost, ok=ok), None
        )
    except Exception:
        logger.warning("could not record the chat model usage", exc_info=True)


async def _model_round(
    model: ChatModel, body: dict[str, Any], out: MessageWriter
) -> tuple[list[FunctionCall], str]:
    """Stream one model response: forward text, collect completed function calls."""
    calls: list[FunctionCall] = []
    text: list[str] = []
    events = model(body)
    try:
        async for event in events:
            kind = event.get("type") if isinstance(event, dict) else None
            if kind in ("response.output_text.delta", "response.refusal.delta"):
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    out.text(delta)
                    text.append(delta)
            elif kind == "response.output_item.done":
                item = event.get("item")
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "function_call":
                    call_id = item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex[:16]}"
                    calls.append(
                        FunctionCall(
                            str(call_id), str(item.get("name") or ""), str(item.get("arguments") or "")
                        )
                    )
                elif item.get("type") == "message":
                    out.end_text()
            elif kind in ("response.completed", "response.incomplete"):
                await _record(event.get("response"), ok=True)
            elif kind in ("response.failed", "error"):
                await _record(event.get("response"), ok=False)
                logger.warning("chat model response failed: %s", kind)
                raise ChatError(FAILED_TEXT)
    finally:
        close = getattr(events, "aclose", None)
        if close is not None:
            await close()
    out.end_text()
    return calls, "".join(text)


async def run_turn(request: ChatRequest, model: ChatModel, out: MessageWriter) -> None:
    out.start()
    users = user_messages(request.messages)
    if not users:
        raise ChatError(NO_QUESTION_TEXT)
    state = TurnState(context=request.context)
    items: list[dict[str, Any]] = [context_message(request.context), *users]
    tools = function_tools()
    instructions = system_prompt()
    answered = False
    for round_index in range(MAX_TOOL_ROUNDS + 1):
        final = round_index == MAX_TOOL_ROUNDS
        try:
            await check_budget()
        except BudgetExceededError as exc:
            raise ChatError(BUDGET_TEXT) from exc
        body: dict[str, Any] = {
            "model": get_settings().chat_model,
            "instructions": instructions,
            "input": list(items),
            "tools": tools,
            "tool_choice": "none" if final else "auto",
            "parallel_tool_calls": True,
            "store": False,
            "stream": True,
        }
        calls, text = await _model_round(model, body, out)
        if text:
            answered = True
            items.append({"role": "assistant", "content": text})
        if not calls or final:
            break
        for call in calls:
            items.append(
                {
                    "type": "function_call",
                    "call_id": call.call_id,
                    "name": call.name,
                    "arguments": call.arguments,
                }
            )
            result = await execute_call(call, state, out)
            output = json.dumps(result, ensure_ascii=False, separators=(",", ":"), default=str)
            items.append({"type": "function_call_output", "call_id": call.call_id, "output": output})
        out.end_step()
    if not answered:
        raise ChatError(NO_ANSWER_TEXT)
    if state.factual:
        async with get_sessionmaker()() as session:
            scope = await compute_scope(session, state)
        out.scope(scope)
    out.finish()


async def _produce(
    request: ChatRequest, model: ChatModel, out: MessageWriter, queue: asyncio.Queue[Chunk | None]
) -> None:
    try:
        async with asyncio.timeout(TURN_TIMEOUT_S):
            await run_turn(request, model, out)
    except TimeoutError:
        out.fail(TIMEOUT_TEXT)
    except ChatError as exc:
        out.fail(exc.message)
    except Exception:
        ref = uuid.uuid4().hex[:12]
        logger.exception("chat turn failed ref=%s", ref)
        out.fail(f"The chat failed (reference {ref}). Please try again.")
    finally:
        queue.put_nowait(None)


async def chat_stream(request: ChatRequest, model: ChatModel) -> AsyncIterator[str]:
    """The response body: frames of one assistant message, then `data: [DONE]`.

    The turn runs in its own task so the turn timeout never cancels the response writer; when the
    client goes away, the turn is cancelled.
    """
    queue: asyncio.Queue[Chunk | None] = asyncio.Queue()
    out = MessageWriter(queue.put_nowait, new_message_id())
    task = asyncio.create_task(_produce(request, model, out, queue))
    try:
        while True:
            chunk = await queue.get()
            if chunk is None:
                break
            yield encode(chunk)
        yield DONE_FRAME
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


# ------------------------------------------------------------------------------------------------
# The real client (OpenAI Responses API)
# ------------------------------------------------------------------------------------------------


@lru_cache(maxsize=2)
def _client(api_key: str) -> openai.AsyncOpenAI:
    return openai.AsyncOpenAI(api_key=api_key, max_retries=1, timeout=TURN_TIMEOUT_S)


def openai_model(api_key: str) -> ChatModel:
    """Responses API streaming as JSON events; provider errors become safe ChatErrors."""
    client = _client(api_key)

    async def stream(body: dict[str, Any]) -> AsyncIterator[ChatEvent]:
        create: Any = client.responses.create
        try:
            response = await create(**body)
            async with response:
                async for event in response:
                    yield dict(event.to_dict(mode="json"))
        except openai.APITimeoutError as exc:
            raise ChatError(TIMEOUT_TEXT) from exc
        except openai.RateLimitError as exc:
            raise ChatError(BUSY_TEXT) from exc
        except (openai.AuthenticationError, openai.PermissionDeniedError) as exc:
            raise ChatError(REFUSED_TEXT) from exc
        except openai.APIConnectionError as exc:
            raise ChatError(UNREACHABLE_TEXT) from exc
        except openai.APIError as exc:
            logger.warning("chat model request failed (status %s)", getattr(exc, "status_code", None))
            raise ChatError(FAILED_TEXT) from exc

    return stream


def get_chat_model() -> ChatModel | None:
    """FastAPI dependency: the configured chat model client, or None without OPENAI_API_KEY."""
    key = get_settings().openai_api_key
    return None if key is None else openai_model(key.get_secret_value())
