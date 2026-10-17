"""Contract 1.2.0 against PostGIS with fictional data: Document.failed_stage, ?last_event_id= on the event
stream and the document and boreholes of `clarification.resolved`. No provider is called; failing stages are
fakes. Every HTTP response is validated against contracts/openapi.yaml."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import httpx
import pytest
from jsonschema import Draft202012Validator
from sqlalchemy import select

from app.clarify.service import create_clarification, resolve_clarification
from app.db.models import Clarification, Document, Event
from app.db.session import get_sessionmaker
from app.events.writer import emit
from app.pipeline import orchestrator
from app.pipeline.orchestrator import StageError, run_pipeline
from app.providers.base import ProviderError
from tests.contract.test_examples import EVENT_SCHEMAS
from tests.contract_utils import schema_errors, validate_response

pytestmark = pytest.mark.db

DOC_ID = "doc_01JFAKE0000000000000000C12"
UID_A = "bh_01JFAKE0000000000000000C1A"
UID_B = "bh_01JFAKE0000000000000000C1B"
StageFn = Callable[[str], Awaitable[None]]


async def call(
    client: httpx.AsyncClient, method: str, path: str, *, expect: int, **kwargs: Any
) -> httpx.Response:
    response = await client.request(method, path, **kwargs)
    assert response.status_code == expect, response.text
    content_type = response.headers.get("content-type", "application/json").split(";")[0]
    body: Any = response.json() if response.content and "json" in content_type else None
    validate_response(method, path.split("?")[0], response.status_code, body, content_type)
    return response


async def _document(*, storage_key: str, stage: str | None, status: str) -> None:
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=DOC_ID,
                file_name="fictional-contract-12" + storage_key[storage_key.rindex(".") :],
                project="Fictional Contract Site",
                sha256="c" * 64,
                mime_type="application/pdf",
                size_bytes=10,
                storage_key=storage_key,
                status=status,
                stage=stage,
                page_count=None,
            )
        )
        await session.commit()


def _fails_with(exc: Exception) -> StageFn:
    async def stage(_: str) -> None:
        raise exc

    return stage


async def _passes(_: str) -> None:
    return None


async def _stored(document_id: str) -> Document:
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        assert doc is not None
        return doc


async def _events(type_: str) -> list[dict[str, Any]]:
    async with get_sessionmaker()() as session:
        rows = await session.scalars(select(Event.payload).where(Event.type == type_).order_by(Event.id))
        return list(rows.all())


# ------------------------------------------------------------------------------------------------
# Document.failed_stage
# ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("storage_key", "done", "failing", "exc", "retryable"),
    [
        ("originals/" + "c" * 64 + ".pdf", "classify", "ocr", StageError("Fictional OCR outage."), True),
        (
            "originals/" + "c" * 64 + ".pdf",
            "triage",
            "classify",
            ProviderError("The fictional classifier is down.", retryable=False),
            False,
        ),
        ("originals/" + "c" * 64 + ".pdf", "ocr", "extract", RuntimeError("internal detail"), True),
        (
            "originals/" + "c" * 64 + ".xlsx",
            "sheet_read",
            "sheet_map",
            ProviderError("The fictional mapping model is down.", retryable=True),
            True,
        ),
    ],
    ids=["stage-error-ocr", "provider-error-classify", "crash-extract", "spreadsheet-sheet-map"],
)
async def test_failed_document_names_the_failed_stage(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    storage_key: str,
    done: str,
    failing: str,
    exc: Exception,
    retryable: bool,
) -> None:
    await _document(storage_key=storage_key, stage=done, status="extracting")
    monkeypatch.setitem(orchestrator.STAGE_FUNCTIONS, failing, _fails_with(exc))
    await run_pipeline(DOC_ID)

    body = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=200)).json()
    assert body["status"] == "failed" and body["failed_stage"] == failing
    assert "internal detail" not in (body["error"] or "")
    listed = (await call(client, "GET", "/api/v1/documents", expect=200)).json()["documents"]
    assert [d["failed_stage"] for d in listed] == [failing]
    # The failure events agree with the read model.
    (job_failed,) = await _events("job.failed")
    assert (job_failed["stage"], job_failed["retryable"]) == (failing, retryable)
    updated = (await _events("document.updated"))[-1]
    assert not schema_errors(updated, "Document")
    assert (updated["status"], updated["failed_stage"]) == ("failed", failing)


async def test_retry_and_success_clear_the_failed_stage(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, live_mode: None
) -> None:
    # live_mode: fake keys so retry is allowed (demo mode answers 409); the stages below are fakes.
    await _document(storage_key="originals/" + "c" * 64 + ".pdf", stage="classify", status="extracting")
    monkeypatch.setitem(orchestrator.STAGE_FUNCTIONS, "ocr", _fails_with(StageError("Fictional OCR outage.")))
    await run_pipeline(DOC_ID)
    assert (await _stored(DOC_ID)).failed_stage == "ocr"

    accepted = (await call(client, "POST", f"/api/v1/documents/{DOC_ID}/retry", expect=202)).json()
    assert accepted["status"] == "queued"
    # Not failed any more: the read model names no failed stage, whatever the column still holds.
    body = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=200)).json()
    assert (body["status"], body["failed_stage"]) == ("queued", None)

    for stage in ("ocr", "extract", "reread"):
        monkeypatch.setitem(orchestrator.STAGE_FUNCTIONS, stage, _passes)
    await run_pipeline(DOC_ID)
    stored = await _stored(DOC_ID)
    assert (stored.status, stored.stage, stored.failed_stage, stored.error) == (
        "needs_review",
        "reread",
        None,
        None,
    )
    body = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=200)).json()
    assert body["failed_stage"] is None
    assert all(e["failed_stage"] is None for e in (await _events("document.updated"))[-4:])


async def test_documents_that_never_failed_send_null(client: httpx.AsyncClient) -> None:
    await _document(storage_key="originals/" + "c" * 64 + ".pdf", stage=None, status="queued")
    body = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=200)).json()
    assert "failed_stage" in body and body["failed_stage"] is None


# ------------------------------------------------------------------------------------------------
# GET /events?last_event_id=
# ------------------------------------------------------------------------------------------------


@pytest.fixture
def finite_stream(monkeypatch: pytest.MonkeyPatch) -> list[int | None]:
    """The real stream (replay from the database), ended after the replay: ASGITransport never disconnects."""
    from app.api.v1 import events as events_api
    from app.events.stream import event_stream

    resumed: list[int | None] = []

    def finite(after: int | None, document_id: str | None, _: Callable[[], Any]) -> AsyncIterator[str]:
        resumed.append(after)

        async def gone() -> bool:
            return True

        return event_stream(after, document_id, gone, ping_interval=0.05)

    monkeypatch.setattr(events_api, "event_stream", finite)
    return resumed


async def _three_events() -> list[int]:
    for n in range(3):
        async with get_sessionmaker()() as session:
            await emit(session, "document.deleted", {"document_id": f"doc_01JFAKE00000000000000000D{n}"})
            await session.commit()
    async with get_sessionmaker()() as session:
        seqs = (await session.scalars(select(Event.seq).order_by(Event.seq))).all()
    assert len(seqs) == 3 and all(s is not None for s in seqs)
    return [int(s) for s in seqs if s is not None]


async def _replayed(client: httpx.AsyncClient, path: str, **kwargs: Any) -> list[int]:
    response = await call(client, "GET", path, expect=200, **kwargs)
    assert response.headers["content-type"].startswith("text/event-stream")
    return [int(m) for m in re.findall(r"^id: (\d+)$", response.text, flags=re.MULTILINE)]


async def test_last_event_id_query_parameter_replays_like_the_header(
    client: httpx.AsyncClient, finite_stream: list[int | None]
) -> None:
    first, second, third = await _three_events()
    assert await _replayed(client, f"/api/v1/events?last_event_id={first}") == [second, third]
    assert await _replayed(client, "/api/v1/events", headers={"Last-Event-ID": str(first)}) == [second, third]
    assert await _replayed(client, "/api/v1/events?last_event_id=0") == [first, second, third]
    # The header wins when both are sent.
    both = await _replayed(
        client, f"/api/v1/events?last_event_id={first}", headers={"Last-Event-ID": str(second)}
    )
    assert both == [third]
    # A header that is not a whole number is ignored; the query parameter applies.
    assert await _replayed(
        client, f"/api/v1/events?last_event_id={second}", headers={"Last-Event-ID": "not-an-id"}
    ) == [third]
    # Without either, the stream starts at the newest event (no history).
    assert await _replayed(client, "/api/v1/events") == []
    assert finite_stream == [first, first, 0, second, second, None]
    # document_id still narrows the replay.
    assert await _replayed(client, f"/api/v1/events?last_event_id=0&document_id={DOC_ID}") == []


@pytest.mark.parametrize("value", ["-1", "abc", "1.5"])
async def test_invalid_last_event_id_is_a_validation_error(
    client: httpx.AsyncClient, finite_stream: list[int | None], value: str
) -> None:
    response = await call(client, "GET", f"/api/v1/events?last_event_id={value}", expect=422)
    assert response.json()["code"] == "validation_error"
    assert finite_stream == []


# ------------------------------------------------------------------------------------------------
# clarification.resolved carries document_id and borehole_uids
# ------------------------------------------------------------------------------------------------


async def _question() -> str:
    await _document(storage_key="originals/" + "c" * 64 + ".pdf", stage="reread", status="needs_review")
    async with get_sessionmaker()() as session:
        row = await create_clarification(
            session,
            kind="unit_ambiguous",
            document_id=DOC_ID,
            question="Which unit does the fictional unit weight use?",
            fields=[
                {
                    "name": "value",
                    "widget": "number_unit",
                    "label": "Unit weight",
                    "required": True,
                    "unit_options": ["kN/m³", "t/m³"],
                }
            ],
            borehole_uids=[UID_A, UID_B],
            path="test_results[0].value",
        )
        await session.commit()
        return row.id


def _event_errors(payload: dict[str, Any]) -> list[str]:
    schema = EVENT_SCHEMAS["clarification.resolved"]
    assert isinstance(schema, dict)
    validator = Draft202012Validator(schema)
    return [f"{list(e.absolute_path)}: {e.message}" for e in validator.iter_errors(payload)]


async def test_skipped_question_event_names_document_and_boreholes(client: httpx.AsyncClient) -> None:
    clar_id = await _question()
    await call(client, "POST", f"/api/v1/clarifications/{clar_id}/skip", expect=200)
    (payload,) = await _events("clarification.resolved")
    assert payload == {
        "clarification_id": clar_id,
        "status": "skipped",
        "document_id": DOC_ID,
        "borehole_uids": [UID_A, UID_B],
    }
    assert not _event_errors(payload)


async def test_answered_question_event_names_document_and_boreholes(client: httpx.AsyncClient) -> None:
    clar_id = await _question()
    answer = {"values": {"value": {"value": 18.5, "unit": "kN/m³"}}, "answered_by": "Fictional Reviewer"}
    body = (
        await call(client, "POST", f"/api/v1/clarifications/{clar_id}/answer", expect=200, json=answer)
    ).json()
    assert body["status"] == "answered"
    (payload,) = await _events("clarification.resolved")
    assert payload == {
        "clarification_id": clar_id,
        "status": "answered",
        "document_id": DOC_ID,
        "borehole_uids": [UID_A, UID_B],
    }
    assert not _event_errors(payload)


async def test_resolved_event_without_boreholes_sends_an_empty_list(db: None) -> None:
    await _document(storage_key="originals/" + "c" * 64 + ".pdf", stage="reread", status="needs_review")
    async with get_sessionmaker()() as session:
        row = await create_clarification(
            session,
            kind="chat_parameter",
            document_id=DOC_ID,
            question="Which fictional town did you mean?",
            fields=[{"name": "place", "widget": "select", "label": "Place", "required": True}],
        )
        await session.flush()
        stored = await session.get(Clarification, row.id)
        assert stored is not None
        await resolve_clarification(session, stored, status="skipped")
        await session.commit()
    (payload,) = await _events("clarification.resolved")
    assert payload["document_id"] == DOC_ID and payload["borehole_uids"] == []
    assert not _event_errors(payload)
