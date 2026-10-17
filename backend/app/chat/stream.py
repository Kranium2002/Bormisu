"""AI SDK UI message stream v1: chunk builders, the frame encoder and an ordered message writer.

Every chunk is one line `data: <json>` followed by a blank line; the stream ends with `data: [DONE]`
(contracts/realtime-and-chat.md section 2). `MessageWriter` keeps the chunk order of one assistant
message valid: steps never nest, text parts are closed, tool parts and data parts sit inside a step,
`error` is always followed by `finish`, and only allowlisted UI commands are sent (transient).
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any

from app.chat.commands import UiCommand, checked

Chunk = dict[str, Any]

DONE_FRAME = "data: [DONE]\n\n"
STREAM_HEADERS = {
    "Content-Type": "text/event-stream",
    "x-vercel-ai-ui-message-stream": "v1",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
}
# Persistent data parts (section 2.2). data-ui-command is the only transient part and has its own method.
PERSISTENT_DATA_PARTS = frozenset({"data-result-set", "data-citation", "data-scope", "data-clarification"})


def encode(chunk: Mapping[str, Any]) -> str:
    """One frame: compact JSON, non-ASCII kept as is, NaN/Infinity refused."""
    payload = json.dumps(chunk, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return f"data: {payload}\n\n"


# Chunk builders. Key order follows contracts/examples/chat/*.sse.


def start(message_id: str) -> Chunk:
    return {"type": "start", "messageId": message_id}


def start_step() -> Chunk:
    return {"type": "start-step"}


def finish_step() -> Chunk:
    return {"type": "finish-step"}


def text_start(part_id: str) -> Chunk:
    return {"type": "text-start", "id": part_id}


def text_delta(part_id: str, delta: str) -> Chunk:
    return {"type": "text-delta", "id": part_id, "delta": delta}


def text_end(part_id: str) -> Chunk:
    return {"type": "text-end", "id": part_id}


def tool_input_available(call_id: str, tool_name: str, tool_input: Mapping[str, Any]) -> Chunk:
    return {
        "type": "tool-input-available",
        "toolCallId": call_id,
        "toolName": tool_name,
        "input": dict(tool_input),
    }


def tool_output_available(call_id: str, output: Mapping[str, Any]) -> Chunk:
    return {"type": "tool-output-available", "toolCallId": call_id, "output": dict(output)}


def data_part(part_type: str, data: Mapping[str, Any], part_id: str | None = None) -> Chunk:
    if part_type not in PERSISTENT_DATA_PARTS:
        raise ValueError(f"unknown data part {part_type!r}")
    chunk: Chunk = {"type": part_type}
    if part_id is not None:
        chunk["id"] = part_id
    chunk["data"] = dict(data)
    return chunk


def ui_command_part(cmd: UiCommand) -> Chunk:
    return {"type": "data-ui-command", "transient": True, "data": checked(cmd).data()}


def error(error_text: str) -> Chunk:
    return {"type": "error", "errorText": error_text}


def finish() -> Chunk:
    return {"type": "finish"}


class MessageWriter:
    """Emits the chunks of one assistant message in protocol order into `sink`."""

    def __init__(self, sink: Callable[[Chunk], None], message_id: str) -> None:
        self._sink = sink
        self.message_id = message_id
        self._started = False
        self._closed = False
        self._in_step = False
        self._text_id: str | None = None
        self._text_parts = 0
        self._scopes = 0

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def in_step(self) -> bool:
        return self._in_step

    def _emit(self, chunk: Chunk) -> None:
        if self._closed:
            raise RuntimeError("the message is already finished")
        self._sink(chunk)

    def start(self) -> None:
        if not self._started:
            self._started = True
            self._emit(start(self.message_id))

    def begin_step(self) -> None:
        self.start()
        if not self._in_step:
            self._in_step = True
            self._emit(start_step())

    def end_step(self) -> None:
        self.end_text()
        if self._in_step:
            self._in_step = False
            self._emit(finish_step())

    def text(self, delta: str) -> None:
        if not delta:
            return
        self.begin_step()
        if self._text_id is None:
            self._text_parts += 1
            self._text_id = f"txt_{self._text_parts}"
            self._emit(text_start(self._text_id))
        self._emit(text_delta(self._text_id, delta))

    def end_text(self) -> None:
        if self._text_id is not None:
            self._emit(text_end(self._text_id))
            self._text_id = None

    def tool_input(self, call_id: str, tool_name: str, tool_input: Mapping[str, Any]) -> None:
        self.end_text()
        self.begin_step()
        self._emit(tool_input_available(call_id, tool_name, tool_input))

    def tool_output(self, call_id: str, output: Mapping[str, Any]) -> None:
        self.begin_step()
        self._emit(tool_output_available(call_id, output))

    def data(self, part_type: str, data: Mapping[str, Any], part_id: str | None = None) -> None:
        self.end_text()
        self.begin_step()
        self._emit(data_part(part_type, data, part_id))

    def scope(self, data: Mapping[str, Any]) -> None:
        self._scopes += 1
        self.data("data-scope", data, f"scope_{self._scopes}")

    def command(self, cmd: UiCommand) -> None:
        self.end_text()
        self.begin_step()
        self._emit(ui_command_part(cmd))

    def finish(self) -> None:
        if self._closed:
            return
        self.start()
        self.end_step()
        self._emit(finish())
        self._closed = True

    def fail(self, error_text: str) -> None:
        """Close what is open, then `error` and `finish` (the text must be safe to show)."""
        if self._closed:
            return
        self.start()
        self.end_step()
        self._emit(error(error_text))
        self._emit(finish())
        self._closed = True
