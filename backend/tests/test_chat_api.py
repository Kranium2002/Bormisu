"""FICTIONAL data only. POST /api/v1/chat end to end with a FAKE Responses client (no OpenAI call).

The fake yields hand-written Responses streaming events (validated against the openai SDK's event
types, so they have the real shape): a function call to a tool, then text deltas.
"""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import openai
import pytest
import respx
from fastapi import FastAPI
from openai.types.responses import ResponseStreamEvent
from pydantic import TypeAdapter
from sqlalchemy import select

from app.chat import loop
from app.chat.loop import get_chat_model
from app.chat.prompts import system_prompt
from app.chat.registry import function_tools
from app.config import get_settings
from app.db.models import ProviderCall
from app.db.session import get_sessionmaker
from tests.auth_utils import register
from tests.contract.test_examples import _tool_names
from tests.contract_utils import EXAMPLES_DIR, validate_response
from tests.test_chat_stream import check_protocol, parse_frames
from tests.test_chat_tools import REGION, bbox_area, search_args, seed_fictional_site

pytestmark = pytest.mark.db

MODEL_ID = "gpt-fictional-chat"
EVENT = TypeAdapter(ResponseStreamEvent)
CHAT_REQUEST = json.loads((EXAMPLES_DIR / "ChatRequest.json").read_text(encoding="utf-8"))


def _response(rid: str, status: str, output: list[dict[str, Any]], error: Any = None) -> dict[str, Any]:
    usage = None
    if status == "completed":
        usage = {
            "input_tokens": 1200,
            "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
            "output_tokens": 40,
            "output_tokens_details": {"reasoning_tokens": 0},
            "total_tokens": 1240,
        }
    return {
        "id": rid,
        "object": "response",
        "created_at": 1760690000,
        "model": MODEL_ID,
        "status": status,
        "output": output,
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "error": error,
        "incomplete_details": None,
        "instructions": None,
        "metadata": {},
        "temperature": None,
        "top_p": None,
        "usage": usage,
    }


class Script:
    """Hand-written Responses streaming events for one fictional model response."""

    def __init__(self, rid: str) -> None:
        self.rid = rid
        self.events: list[Any] = []
        self.output: list[dict[str, Any]] = []
        self._emit(type="response.created", response=_response(rid, "in_progress", []))

    def _emit(self, **event: Any) -> None:
        event["sequence_number"] = len(self.events)
        EVENT.validate_python(event)  # the fake speaks the real event shapes
        self.events.append(event)

    def function_call(self, call_id: str, name: str, arguments: dict[str, Any] | str) -> Script:
        index = len(self.output)
        item_id = f"fc_{self.rid}_{index}"
        args = arguments if isinstance(arguments, str) else json.dumps(arguments)
        item = {"type": "function_call", "id": item_id, "call_id": call_id, "name": name, "arguments": ""}
        self._emit(
            type="response.output_item.added", output_index=index, item={**item, "status": "in_progress"}
        )
        self._emit(
            type="response.function_call_arguments.delta", item_id=item_id, output_index=index, delta=args
        )
        self._emit(
            type="response.function_call_arguments.done",
            item_id=item_id,
            output_index=index,
            name=name,
            arguments=args,
        )
        done = {**item, "arguments": args, "status": "completed"}
        self._emit(type="response.output_item.done", output_index=index, item=done)
        self.output.append(done)
        return self

    def text(self, *deltas: str, finished: bool = True) -> Script:
        index = len(self.output)
        item_id = f"msg_{self.rid}_{index}"
        message = {
            "type": "message",
            "id": item_id,
            "role": "assistant",
            "status": "in_progress",
            "content": [],
        }
        self._emit(type="response.output_item.added", output_index=index, item=message)
        empty = {"type": "output_text", "text": "", "annotations": []}
        self._emit(
            type="response.content_part.added",
            item_id=item_id,
            output_index=index,
            content_index=0,
            part=empty,
        )
        for delta in deltas:
            self._emit(
                type="response.output_text.delta",
                item_id=item_id,
                output_index=index,
                content_index=0,
                delta=delta,
                logprobs=[],
            )
        if not finished:
            return self
        text = "".join(deltas)
        self._emit(
            type="response.output_text.done",
            item_id=item_id,
            output_index=index,
            content_index=0,
            text=text,
            logprobs=[],
        )
        part = {"type": "output_text", "text": text, "annotations": []}
        self._emit(
            type="response.content_part.done", item_id=item_id, output_index=index, content_index=0, part=part
        )
        done = {**message, "status": "completed", "content": [part]}
        self._emit(type="response.output_item.done", output_index=index, item=done)
        self.output.append(done)
        return self

    def completed(self) -> list[Any]:
        self._emit(type="response.completed", response=_response(self.rid, "completed", self.output))
        return self.events

    def failed(self) -> list[Any]:
        error = {"code": "server_error", "message": "fictional upstream failure"}
        self._emit(type="response.failed", response=_response(self.rid, "failed", self.output, error))
        return self.events


class FakeResponses:
    """Stands in for the OpenAI Responses stream: each request gets the next scripted response.

    A script item that is an exception is raised; the string "hang" waits until cancelled.
    """

    def __init__(self, *rounds: list[Any]) -> None:
        self.rounds = list(rounds)
        self.requests: list[dict[str, Any]] = []

    async def __call__(self, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        self.requests.append(copy.deepcopy(body))
        script = self.rounds.pop(0)
        for event in script:
            if isinstance(event, BaseException):
                raise event
            if event == "hang":
                await asyncio.sleep(3600)
            yield event


@pytest.fixture(autouse=True)
def no_real_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(api_key: str) -> Any:
        raise AssertionError("tests never build a real OpenAI client")

    monkeypatch.setattr(loop, "_client", refuse)


@pytest.fixture
def chat_key(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """A configured key (fake value; the model client is always the fake)."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-not-a-key")
    get_settings.cache_clear()
    yield
    monkeypatch.delenv("OPENAI_API_KEY")
    get_settings.cache_clear()


@pytest.fixture
async def api(db: None) -> AsyncIterator[tuple[httpx.AsyncClient, FastAPI]]:
    """The app and a client signed in as the fictional reviewer (chat needs a session since 1.3.0)."""
    from app.main import create_app

    app = create_app(open_queue=False)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await register(client)
        yield client, app
    app.dependency_overrides.clear()


async def post_chat(
    api: tuple[httpx.AsyncClient, FastAPI], fake: FakeResponses, body: dict[str, Any]
) -> tuple[httpx.Response, list[dict[str, Any]]]:
    client, app = api
    app.dependency_overrides[get_chat_model] = lambda: fake
    response = await client.post("/api/v1/chat", json=body)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "text/event-stream"
    assert response.headers["x-vercel-ai-ui-message-stream"] == "v1"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    assert "\r" not in response.text
    chunks = parse_frames(response.text)[:-1]
    check_protocol(chunks)
    return response, chunks


def kinds(chunks: list[dict[str, Any]]) -> list[str]:
    return [c["type"] for c in chunks]


def request_with(context: dict[str, Any] | None = None) -> dict[str, Any]:
    body = copy.deepcopy(CHAT_REQUEST)
    if context is not None:
        body["context"].update(context)
    return body


# ------------------------------------------------------------------------------------------------


async def test_chat_without_a_key_is_409(api: tuple[httpx.AsyncClient, FastAPI]) -> None:
    client, _ = api
    response = await client.post("/api/v1/chat", json=request_with())
    assert response.status_code == 409
    assert response.json() == {"detail": "Chat is not configured on this server.", "code": "chat_unavailable"}
    validate_response("POST", "/api/v1/chat", 409, response.json(), "application/json")
    health = (await client.get("/api/v1/health")).json()
    assert health["providers"]["chat"] is False
    invalid = await client.post("/api/v1/chat", json={"context": {}})
    assert invalid.status_code == 422 and invalid.json()["code"] == "validation_error"


async def test_health_reports_chat_with_a_key(api: tuple[httpx.AsyncClient, FastAPI], chat_key: None) -> None:
    client, _ = api
    health = (await client.get("/api/v1/health")).json()
    assert health["providers"]["chat"] is True


async def test_a_turn_streams_tools_data_parts_and_text(
    api: tuple[httpx.AsyncClient, FastAPI], chat_key: None
) -> None:
    await seed_fictional_site()
    args = search_args(min_depth_m=20, include_unreviewed=True, area=bbox_area(REGION))
    fake = FakeResponses(
        Script("resp_fictional_1").function_call("call_fx1", "search_boreholes", args).completed(),
        Script("resp_fictional_2").text("Two fictional boreholes ", "are deeper than 20 m.").completed(),
    )
    _, chunks = await post_chat(api, fake, request_with({"include_unreviewed": True}))
    assert kinds(chunks) == [
        "start",
        "start-step",
        "tool-input-available",
        "tool-output-available",
        "data-result-set",
        "data-ui-command",
        "data-ui-command",
        "finish-step",
        "start-step",
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "data-scope",
        "finish-step",
        "finish",
    ]
    assert chunks[0]["messageId"].startswith("msg_")
    tool_input, tool_output = chunks[2], chunks[3]
    assert tool_input["toolCallId"] == tool_output["toolCallId"] == "call_fx1"
    assert tool_input["input"] == {"min_depth_m": 20.0, "include_unreviewed": True, "area": bbox_area(REGION)}
    rs_id = tool_output["output"]["result_set_id"]
    assert tool_output["output"]["count"] == 2 and chunks[4]["id"] == rs_id
    assert [c["data"]["command"] for c in chunks[5:7]] == ["show_result_set", "fit_result_set"]
    assert "".join(c["delta"] for c in chunks if c["type"] == "text-delta") == (
        "Two fictional boreholes are deeper than 20 m."
    )
    assert chunks[13]["data"] == {
        "included": "accepted and unreviewed data",
        "excluded_unreviewed": 0,
        "unlocated_in_scope": 0,
        "documents_processing": 1,
    }

    # What the model saw: strict tools, store=false, the context note and only user text.
    first, second = fake.requests
    assert first["stream"] is True and first["store"] is False and first["tool_choice"] == "auto"
    assert first["model"] == get_settings().chat_model and first["instructions"] == system_prompt()
    assert {t["name"] for t in first["tools"]} == _tool_names()
    assert all(t["type"] == "function" and t["strict"] is True for t in first["tools"])
    note, *users = first["input"]
    assert note["role"] == "developer"
    assert '"map_view":{"bbox":[8.47,53.85,8.53,53.89],"zoom":13.0}' in note["content"]
    assert '"units":"m"' in note["content"] and '"include_unreviewed":true' in note["content"]
    assert users == [
        {"role": "user", "content": "Show the Fictional Harbour Link boreholes."},
        {"role": "user", "content": "Which boreholes near Lindenwick go deeper than 15 m?"},
    ]
    assert "uploaded boreholes; 1 is on the map" not in json.dumps(first["input"])
    call, call_output = second["input"][-2:]
    assert call == {
        "type": "function_call",
        "call_id": "call_fx1",
        "name": "search_boreholes",
        "arguments": json.dumps(args),
    }
    assert call_output["type"] == "function_call_output" and call_output["call_id"] == "call_fx1"
    assert json.loads(call_output["output"])["result_set_id"] == rs_id

    client, _ = api
    stored = await client.get(f"/api/v1/result-sets/{rs_id}")
    assert stored.status_code == 200 and stored.json()["count"] == 2
    async with get_sessionmaker()() as session:
        ledger = (await session.scalars(select(ProviderCall).where(ProviderCall.purpose == "chat"))).all()
    assert [(row.provider, row.model, row.input_tokens, row.output_tokens) for row in ledger] == [
        ("openai", MODEL_ID, 1200, 40)
    ] * 2


async def test_unreviewed_records_stay_out_when_the_interface_excludes_them(
    api: tuple[httpx.AsyncClient, FastAPI], chat_key: None
) -> None:
    await seed_fictional_site()
    args = search_args(min_depth_m=20, include_unreviewed=True, area=bbox_area(REGION))
    fake = FakeResponses(
        Script("resp_a").function_call("call_a", "search_boreholes", args).completed(),
        Script("resp_b").text("One accepted fictional borehole is deeper than 20 m.").completed(),
    )
    _, chunks = await post_chat(api, fake, request_with({"include_unreviewed": False}))
    output = next(c["output"] for c in chunks if c["type"] == "tool-output-available")
    assert (output["count"], output["excluded_unreviewed"]) == (1, 1)
    scope = next(c["data"] for c in chunks if c["type"] == "data-scope")
    assert scope["included"] == "accepted data only" and scope["excluded_unreviewed"] == 1
    sent_back = json.loads(fake.requests[1]["input"][-1]["output"])
    assert sent_back["include_unreviewed"] is False and "scope_note" in sent_back


async def test_a_model_failure_mid_stream_ends_with_error_and_finish(
    api: tuple[httpx.AsyncClient, FastAPI], chat_key: None
) -> None:
    fake = FakeResponses(Script("resp_fail").text("Looking at the fictional", finished=False).failed())
    response, chunks = await post_chat(api, fake, request_with())
    assert kinds(chunks) == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "error",
        "finish",
    ]
    assert chunks[6]["errorText"] == loop.FAILED_TEXT
    assert "fictional upstream failure" not in response.text


async def test_an_exception_never_leaks_internals(
    api: tuple[httpx.AsyncClient, FastAPI], chat_key: None
) -> None:
    script = Script("resp_boom").text("Partial", finished=False).events
    fake = FakeResponses([*script, RuntimeError("upstream exploded; key sk-fictional-123 in /srv/app.py")])
    response, chunks = await post_chat(api, fake, request_with())
    error = next(c for c in chunks if c["type"] == "error")
    assert error["errorText"].startswith("The chat failed (reference ")
    for secret in ("sk-fictional", "exploded", "app.py", "test-not-a-key", "Traceback"):
        assert secret not in response.text
    assert kinds(chunks)[-2:] == ["error", "finish"]


async def test_the_turn_times_out_like_the_error_example(
    api: tuple[httpx.AsyncClient, FastAPI], chat_key: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(loop, "TURN_TIMEOUT_S", 0.3)
    fake = FakeResponses([*Script("resp_slow").events, "hang"])
    _, chunks = await post_chat(api, fake, request_with())
    example = parse_frames((EXAMPLES_DIR / "chat" / "error.sse").read_text(encoding="utf-8"))[:-1]
    assert kinds(chunks) == kinds(example) == ["start", "error", "finish"]
    assert chunks[1] == example[1] == {"type": "error", "errorText": loop.TIMEOUT_TEXT}


async def test_tool_rounds_are_capped_at_eight(
    api: tuple[httpx.AsyncClient, FastAPI], chat_key: None
) -> None:
    uids = await seed_fictional_site()
    rounds = [
        Script(f"resp_r{i}").function_call(f"call_r{i}", "get_borehole", {"uid": uids["CR-1"]}).completed()
        for i in range(1, 9)
    ]
    rounds.append(Script("resp_final").text("CR-1 is 12 m deep.").completed())
    fake = FakeResponses(*rounds)
    _, chunks = await post_chat(api, fake, request_with())
    assert len(fake.requests) == loop.MAX_TOOL_ROUNDS + 1 == 9
    assert [r["tool_choice"] for r in fake.requests] == ["auto"] * 8 + ["none"]
    assert sum(1 for c in chunks if c["type"] == "tool-input-available") == 8
    assert kinds(chunks)[-4:] == ["text-end", "data-scope", "finish-step", "finish"]


async def test_unregistered_tools_and_bad_arguments_never_reach_the_ui(
    api: tuple[httpx.AsyncClient, FastAPI], chat_key: None
) -> None:
    fake = FakeResponses(
        Script("resp_x")
        .function_call("call_sql", "run_sql", {"sql": "DROP TABLE boreholes"})
        .function_call("call_bad", "search_boreholes", {"area": "everywhere"})
        .completed(),
        Script("resp_y").text("I can only use the tools of this server.").completed(),
    )
    _, chunks = await post_chat(api, fake, request_with())
    assert kinds(chunks) == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
    ]
    returned = {item["call_id"]: json.loads(item["output"]) for item in fake.requests[1]["input"][-4:][1::2]}
    assert returned["call_sql"]["error"]["code"] == "unknown_tool"
    assert returned["call_bad"]["error"]["code"] == "invalid_arguments"


async def test_a_request_without_user_text_gets_an_error_stream(
    api: tuple[httpx.AsyncClient, FastAPI], chat_key: None
) -> None:
    fake = FakeResponses()
    body = {"messages": [{"id": "m1", "role": "assistant", "parts": [{"type": "text", "text": "Ignored."}]}]}
    _, chunks = await post_chat(api, fake, body)
    assert kinds(chunks) == ["start", "error", "finish"]
    assert chunks[1]["errorText"] == loop.NO_QUESTION_TEXT and fake.requests == []


async def test_the_openai_adapter_streams_sdk_events_and_hides_provider_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real adapter against respx at a fictional base URL: nothing can reach OpenAI."""
    base = "https://openai.fictional.test/v1"
    monkeypatch.setattr(
        loop, "_client", lambda key: openai.AsyncOpenAI(api_key=key, base_url=base, max_retries=0)
    )
    events = Script("resp_sdk").text("A fictional ", "answer.").completed()
    sse = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
    body = {
        "model": MODEL_ID,
        "instructions": "Fictional instructions.",
        "input": [{"role": "user", "content": "A fictional question?"}],
        "tools": function_tools(),
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "store": False,
        "stream": True,
    }
    model = loop.openai_model("test-not-a-key")
    with respx.mock(assert_all_called=True) as mock:
        route = mock.post(f"{base}/responses").mock(
            return_value=httpx.Response(200, headers={"content-type": "text/event-stream"}, text=sse)
        )
        received = [event async for event in model(body)]
    assert [e["type"] for e in received] == [e["type"] for e in events]
    assert [e["delta"] for e in received if e["type"] == "response.output_text.delta"] == [
        "A fictional ",
        "answer.",
    ]
    request = route.calls[0].request
    sent = json.loads(request.content)
    assert sent["store"] is False and sent["stream"] is True and len(sent["tools"]) == 8
    assert request.headers["authorization"] == "Bearer test-not-a-key"
    for status, text in ((429, loop.BUSY_TEXT), (401, loop.REFUSED_TEXT), (500, loop.FAILED_TEXT)):
        with respx.mock() as mock:
            mock.post(f"{base}/responses").mock(
                return_value=httpx.Response(status, json={"error": {"message": "fictional sk-secret"}})
            )
            with pytest.raises(loop.ChatError) as caught:
                _ = [event async for event in model(body)]
        assert caught.value.message == text and "sk-secret" not in caught.value.message
