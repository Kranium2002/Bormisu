"""FICTIONAL data only. The chat stream encoder against contracts/examples/chat/*.sse (no database, no model).

`check_protocol` validates a chunk sequence against contracts/realtime-and-chat.md section 2 (chunk
vocabulary, step and text nesting, tool parts, data-part payloads, allowlisted UI commands); the chat
tool and API tests reuse it.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.chat import stream as s
from app.chat.commands import UiCommand, UiCommandError, ui_command
from app.chat.stream import DONE_FRAME, STREAM_HEADERS, MessageWriter, encode
from tests.contract.test_examples import (
    DATA_PART_SCHEMAS,
    EXAMPLES_DIR,
    _check_tool_input,
    _check_tool_output,
    _chunk_types,
    _inline_errors,
    _tool_names,
    _ui_commands,
)

TURN = EXAMPLES_DIR / "chat" / "turn.sse"
ERROR = EXAMPLES_DIR / "chat" / "error.sse"


def parse_frames(body: str) -> list[Any]:
    """Split a response body into chunk objects (the final [DONE] as the string "[DONE]")."""
    assert body.endswith("\n\n"), "every frame ends with a blank line"
    chunks: list[Any] = []
    for frame in body[:-2].split("\n\n"):
        assert "\n" not in frame and frame.startswith("data: "), frame
        payload = frame[len("data: ") :]
        chunks.append(payload if payload == "[DONE]" else json.loads(payload))
    assert chunks and chunks[-1] == "[DONE]" and "[DONE]" not in chunks[:-1]
    return chunks


def check_protocol(chunks: list[dict[str, Any]], *, complete: bool = True) -> None:
    """Contract rules for one assistant message (complete: from start to finish)."""
    allowed, commands, tools = _chunk_types(), _ui_commands(), _tool_names()
    if complete:
        assert chunks[0]["type"] == "start" and isinstance(chunks[0].get("messageId"), str)
        assert chunks[-1]["type"] == "finish"
    in_step = not complete
    open_text: set[str] = set()
    calls: dict[str, str] = {}
    answered: set[str] = set()
    for index, chunk in enumerate(chunks):
        kind = chunk["type"]
        where = f"chunk {index} ({kind})"
        assert kind in allowed, f"{where}: type not in the contract"
        if kind == "start-step":
            assert not in_step, f"{where}: nested step"
            in_step = True
        elif kind == "finish-step":
            assert in_step and not open_text, f"{where}: finish-step outside a step or with open text"
            in_step = False
        elif kind == "text-start":
            assert in_step and chunk["id"] not in open_text, where
            open_text.add(chunk["id"])
        elif kind == "text-delta":
            assert chunk["id"] in open_text and isinstance(chunk["delta"], str), where
        elif kind == "text-end":
            assert chunk["id"] in open_text, where
            open_text.discard(chunk["id"])
        elif kind == "tool-input-available":
            assert in_step and chunk["toolName"] in tools, f"{where}: unknown tool {chunk['toolName']!r}"
            assert chunk["toolCallId"] not in calls and isinstance(chunk["input"], dict), where
            calls[chunk["toolCallId"]] = chunk["toolName"]
            _check_tool_input(chunk["toolName"], chunk["input"], where)
        elif kind == "tool-output-available":
            call = chunk["toolCallId"]
            assert in_step and call in calls and call not in answered, f"{where}: output without input"
            answered.add(call)
            if "error" not in chunk["output"]:
                _check_tool_output(calls[call], chunk["output"], where)
        elif kind == "data-ui-command":
            assert in_step and chunk.get("transient") is True, f"{where}: ui commands are transient"
            command, args = chunk["data"]["command"], chunk["data"]["args"]
            assert command in commands, f"{where}: {command!r} is not allowlisted"
            required, known = commands[command]
            assert required <= set(args) <= known, f"{where}: args {sorted(args)} for {command}"
        elif kind.startswith("data-"):
            assert in_step and chunk.get("transient") is not True, where
            errors = _inline_errors(chunk["data"], DATA_PART_SCHEMAS[kind])
            assert not errors, f"{where}: {errors}"
        elif kind == "error":
            assert isinstance(chunk["errorText"], str) and chunk["errorText"], where
            assert chunks[index + 1]["type"] == "finish", f"{where}: error is followed by finish"
            assert not in_step and not open_text, f"{where}: error inside an open step"
    if complete:
        assert not in_step and not open_text, "unclosed step or text part"
    assert set(calls) == answered, "tool calls without output"


def _example_chunks(path: Any) -> list[dict[str, Any]]:
    return [c for c in parse_frames(path.read_text(encoding="utf-8")) if c != "[DONE]"]


@pytest.mark.parametrize("path", [TURN, ERROR], ids=["turn", "error"])
def test_encoder_reproduces_the_example_frames(path: Any) -> None:
    text = path.read_bytes().decode("utf-8")
    chunks = _example_chunks(path)
    assert "".join(encode(c) for c in chunks) + DONE_FRAME == text
    check_protocol(chunks)


def _turn_through_the_writer() -> str:
    """Rebuild contracts/examples/chat/turn.sse with the writer the chat loop uses."""
    turn = _example_chunks(TURN)
    by_type: dict[str, list[dict[str, Any]]] = {}
    for chunk in turn:
        by_type.setdefault(chunk["type"], []).append(chunk)
    inputs, outputs = by_type["tool-input-available"], by_type["tool-output-available"]
    frames: list[str] = []
    out = MessageWriter(lambda c: frames.append(encode(c)), turn[0]["messageId"])
    out.begin_step()
    for i in (0, 1):
        out.tool_input(inputs[i]["toolCallId"], inputs[i]["toolName"], inputs[i]["input"])
        out.tool_output(outputs[i]["toolCallId"], outputs[i]["output"])
    result_set = by_type["data-result-set"][0]
    out.data("data-result-set", result_set["data"], result_set["id"])
    for command in by_type["data-ui-command"]:
        out.command(ui_command(command["data"]["command"], command["data"]["args"]))
    out.end_step()
    out.tool_input(inputs[2]["toolCallId"], inputs[2]["toolName"], inputs[2]["input"])
    out.tool_output(outputs[2]["toolCallId"], outputs[2]["output"])
    citation = by_type["data-citation"][0]
    out.data("data-citation", citation["data"], citation["id"])
    out.end_step()
    for delta in by_type["text-delta"]:
        out.text(delta["delta"])
    out.scope(by_type["data-scope"][0]["data"])
    out.finish()
    return "".join(frames) + DONE_FRAME


def test_writer_builds_the_turn_example_byte_for_byte() -> None:
    assert _turn_through_the_writer() == TURN.read_text(encoding="utf-8")


def test_writer_builds_the_error_example_byte_for_byte() -> None:
    example = _example_chunks(ERROR)
    frames: list[str] = []
    out = MessageWriter(lambda c: frames.append(encode(c)), example[0]["messageId"])
    out.start()
    out.fail(example[1]["errorText"])
    assert "".join(frames) + DONE_FRAME == ERROR.read_text(encoding="utf-8")


def test_error_closes_the_open_text_and_step_first() -> None:
    chunks: list[dict[str, Any]] = []
    out = MessageWriter(chunks.append, "msg_fictional")
    out.text("Looking at the fictional site")
    out.fail("The chat model could not answer. Please try again.")
    assert [c["type"] for c in chunks] == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "error",
        "finish",
    ]
    check_protocol(chunks)
    out.fail("again")  # a finished message ignores further failures
    with pytest.raises(RuntimeError):
        out.text("after the end")


def test_text_parts_get_new_ids_after_a_tool_call() -> None:
    chunks: list[dict[str, Any]] = []
    out = MessageWriter(chunks.append, "msg_fictional")
    out.text("First ")
    out.tool_input("call_a", "get_borehole", {"uid": "bh_fictional"})
    out.tool_output("call_a", {"uid": "bh_fictional"})
    out.end_step()
    out.text("Second")
    out.finish()
    starts = [c["id"] for c in chunks if c["type"] == "text-start"]
    assert starts == ["txt_1", "txt_2"]
    check_protocol(chunks)


def test_headers_and_frame_format() -> None:
    assert STREAM_HEADERS == {
        "Content-Type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    assert encode({"type": "text-delta", "id": "txt_1", "delta": "Tiefe 12,5 m – Ü"}) == (
        'data: {"type":"text-delta","id":"txt_1","delta":"Tiefe 12,5 m – Ü"}\n\n'
    )
    with pytest.raises(ValueError):
        encode({"type": "text-delta", "delta": float("nan")})


def test_only_contract_data_parts_and_allowlisted_commands_are_built() -> None:
    with pytest.raises(ValueError):
        s.data_part("data-ui-command", {"command": "fit_bounds", "args": {}})
    with pytest.raises(ValueError):
        s.data_part("data-run-sql", {"sql": "fictional"})
    with pytest.raises(UiCommandError):
        ui_command("delete_document", {"document_id": "doc_fictional"})
    with pytest.raises(UiCommandError):
        ui_command("fit_bounds", {"bbox": [1, 2, 3, 4], "script": "fictional"})
    forged = UiCommand("navigate_to_url", {"url": "https://fictional.test"})
    out = MessageWriter(lambda c: None, "msg_fictional")
    with pytest.raises(UiCommandError):
        out.command(forged)
    part = s.ui_command_part(ui_command("fit_bounds", {"bbox": [1.0, 2.0, 3.0, 4.0], "outline": True}))
    assert part == {
        "type": "data-ui-command",
        "transient": True,
        "data": {"command": "fit_bounds", "args": {"bbox": [1.0, 2.0, 3.0, 4.0], "outline": True}},
    }
