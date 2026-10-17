"""Every route behind the session (contract 1.3.0), actors from the session, logout, AUTH_ENABLED=false."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.auth.deps import LOCAL_USER
from app.config import get_settings
from app.db.models import Clarification, Revision
from app.db.session import get_sessionmaker
from tests.auth_utils import LOGIN, LOGOUT, ME, REVIEWER, SECOND, register
from tests.contract_utils import iter_operations, validate_response
from tests.test_api import DOC_ID, _fixture_document, call

pytestmark = pytest.mark.db

# Public operations: the health checks, register and login. logout answers with or without a session.
PUBLIC = {"getHealth", "getHealthV1", "register", "login", "logout"}
PUBLIC_ROUTES = {
    ("GET", "/api/health"),
    ("GET", "/api/v1/health"),
    ("POST", "/api/v1/auth/register"),
    ("POST", "/api/v1/auth/login"),
    ("POST", "/api/v1/auth/logout"),
}
SAMPLE_PARAMS = {
    "document_id": "doc_01JFAKE0000000000000000API",
    "uid": "bh_01JFAKE00000000000000000BH",
    "result_set_id": "rs_01JFAKE00000000000000000RS",
    "clarification_id": "cl_01JFAKE00000000000000000CL",
    "n": "1",
}
PROTECTED = [
    (method, template, operation["operationId"])
    for method, template, operation in iter_operations()
    if operation["operationId"] not in PUBLIC
]
SOMEONE_ELSE = "Somebody Else"


def _concrete(template: str) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: SAMPLE_PARAMS[m.group(1)], template)


async def _actors(uid: str) -> list[str]:
    async with get_sessionmaker()() as session:
        rows = (
            await session.scalars(select(Revision).where(Revision.uid == uid).order_by(Revision.revision))
        ).all()
    return [r.actor for r in rows]


@pytest.fixture
def chat_key(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("OPENAI_API_KEY", "test-not-a-key")
    get_settings.cache_clear()
    yield
    monkeypatch.undo()
    get_settings.cache_clear()


@pytest.fixture
def finite_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real event stream, ended after the replay (ASGITransport never disconnects)."""
    from app.api.v1 import events as events_api
    from app.events.stream import event_stream

    def finite(after: int | None, document_id: str | None, _: Callable[[], Any]) -> AsyncIterator[str]:
        async def gone() -> bool:
            return True

        return event_stream(after, document_id, gone, ping_interval=0.05)

    monkeypatch.setattr(events_api, "event_stream", finite)


# ------------------------------------------------------------------------------------------------
# Without a session
# ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("method", "template", "op_id"), PROTECTED, ids=[op for *_, op in PROTECTED])
async def test_protected_operation_answers_401_without_a_session(
    anon_client: httpx.AsyncClient, method: str, template: str, op_id: str
) -> None:
    path = _concrete(template)
    response = await anon_client.request(method, path)
    assert response.status_code == 401, f"{op_id}: {response.status_code} {response.text}"
    assert response.json()["code"] == "not_authenticated"
    validate_response(method, path, 401, response.json())


async def test_every_route_of_the_app_except_the_public_ones_needs_a_session(
    anon_client: httpx.AsyncClient,
) -> None:
    """Every /api/v1 route the app serves (also one the contract lacks) answers 401 without a session."""
    from app.main import create_app

    served = create_app(open_queue=False).openapi()["paths"]
    checked = 0
    for template, item in served.items():
        if not template.startswith("/api/v1"):
            continue
        for method in item:
            verb = method.upper()
            if verb not in {"GET", "POST", "PUT", "PATCH", "DELETE"} or (verb, template) in PUBLIC_ROUTES:
                continue
            response = await anon_client.request(verb, _concrete(template))
            assert response.status_code == 401, f"{verb} {template}: {response.status_code}"
            checked += 1
    assert checked >= len(PROTECTED)


async def test_a_forged_or_unknown_cookie_is_not_a_session(anon_client: httpx.AsyncClient) -> None:
    for token in ("forged-token", "x" * 500, ""):
        response = await anon_client.get("/api/v1/documents", headers={"Cookie": f"gm_session={token}"})
        assert response.status_code == 401 and response.json()["code"] == "not_authenticated"


async def test_event_stream_and_chat_answer_401_without_a_session(
    anon_client: httpx.AsyncClient, chat_key: None
) -> None:
    events = await anon_client.get("/api/v1/events", headers={"Last-Event-ID": "0"})
    assert events.status_code == 401
    assert events.headers["content-type"].startswith("application/json")
    assert events.json()["code"] == "not_authenticated"
    chat = await anon_client.post("/api/v1/chat", json={"messages": [], "context": {}})
    assert chat.status_code == 401, chat.text  # not 409 chat_unavailable: the key is configured
    assert chat.json()["code"] == "not_authenticated"
    validate_response("POST", "/api/v1/chat", 401, chat.json())
    await _fixture_document()
    page = await anon_client.get(f"/api/v1/documents/{DOC_ID}/pages/1.png")
    assert page.status_code == 401 and page.json()["code"] == "not_authenticated"


async def test_health_stays_public(anon_client: httpx.AsyncClient) -> None:
    for path in ("/api/health", "/api/v1/health"):
        health = await call(anon_client, "GET", path, expect=200)
        assert health.json()["auth"] == {"enabled": True, "registration": "open"}


# ------------------------------------------------------------------------------------------------
# Signed in
# ------------------------------------------------------------------------------------------------


async def test_signed_in_reviewer_does_the_full_review_flow(
    anon_client: httpx.AsyncClient, finite_stream: None
) -> None:
    client = anon_client
    await register(client, REVIEWER)  # the first account (admin)
    second = await register(client, SECOND)  # this client now acts as the second account
    assert second["role"] == "reviewer" and second["display_name"] is None
    me = (await call(client, "GET", ME, expect=200)).json()["user"]
    assert me["email"] == SECOND.email and me["role"] == "reviewer"

    uid, clar_id = await _fixture_document()
    documents = (await call(client, "GET", "/api/v1/documents", expect=200)).json()
    assert [d["document_id"] for d in documents["documents"]] == [DOC_ID]
    await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=200)
    page = await call(client, "GET", f"/api/v1/documents/{DOC_ID}/pages/1.png?w=400", expect=200)
    assert page.headers["content-type"] == "image/png"
    stream = await call(client, "GET", "/api/v1/events?last_event_id=0", expect=200)
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert "event: borehole.created" in stream.text
    await call(client, "GET", f"/api/v1/documents/{DOC_ID}/boreholes", expect=200)
    await call(client, "GET", f"/api/v1/boreholes/{uid}", expect=200)

    path = f"/api/v1/boreholes/{uid}/values"
    patches = [
        {"path": "metadata.borehole_depth_m", "action": "approve", "confirmed_by": SOMEONE_ELSE},
        {"path": "stratigraphy[1].depth_to_m", "action": "edit", "value": 8.4},
        {"path": "stratigraphy[0].din4023_code", "action": "flag", "reason": "unclear"},
        {"path": "stratigraphy[0].din4023_code", "action": "reset"},
    ]
    for patch in patches:
        await call(client, "PATCH", path, expect=200, json=patch)
    candidates = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}/crs-candidates", expect=200)).json()
    assert any(c["crs"] == "EPSG:25832" for c in candidates)
    inbox = (await call(client, "GET", "/api/v1/clarifications", expect=200)).json()
    assert [c["clarification_id"] for c in inbox] == [clar_id]
    answer = {"values": {"crs": "EPSG:25832", "swap_axes": False}, "answered_by": SOMEONE_ELSE}
    answered = (
        await call(client, "POST", f"/api/v1/clarifications/{clar_id}/answer", expect=200, json=answer)
    ).json()
    assert answered["answered_by"] == SECOND.actor == SECOND.email
    clean = await call(
        client,
        "POST",
        f"/api/v1/documents/{DOC_ID}/approve-clean?dry_run=false&confirmed_by=Somebody",
        expect=200,
    )
    assert clean.json()["count"] >= 1
    layer = (await call(client, "GET", "/api/v1/map/boreholes.geojson", expect=200)).json()
    assert [f["id"] for f in layer["features"]] == [uid]
    created = (
        await call(
            client,
            "POST",
            "/api/v1/result-sets",
            expect=201,
            json={"include_unreviewed": True, "area": {"type": "bbox", "bbox": [7, 47, 9, 49]}},
        )
    ).json()
    assert created["uids"] == [uid]
    await call(client, "GET", f"/api/v1/result-sets/{created['result_set_id']}/geojson", expect=200)
    await call(client, "GET", "/api/v1/stats", expect=200)

    actors = await _actors(uid)
    assert actors[0] == "pipeline" and len(actors) >= 7
    assert set(actors[1:]) == {SECOND.email}, actors
    async with get_sessionmaker()() as session:
        row = await session.get(Clarification, clar_id)
    assert row is not None and row.answered_by == SECOND.email


async def test_revision_actor_is_the_session_users_name(client: httpx.AsyncClient) -> None:
    """The display name of the signed-in user, whatever a body or query parameter says."""
    uid, _ = await _fixture_document()
    await call(
        client,
        "PATCH",
        f"/api/v1/boreholes/{uid}/values",
        expect=200,
        json={"path": "metadata.borehole_depth_m", "action": "approve", "confirmed_by": SOMEONE_ELSE},
    )
    confirmed = await call(
        client,
        "POST",
        f"/api/v1/documents/{DOC_ID}/crs",
        expect=200,
        json={"crs": "EPSG:25832", "confirmed_by": SOMEONE_ELSE},
    )
    assert confirmed.json() == {"updated": 1}
    actors = await _actors(uid)
    assert actors[1:] == [REVIEWER.actor, REVIEWER.actor] and REVIEWER.actor == "Fictional Reviewer"
    async with get_sessionmaker()() as session:
        question = await session.scalar(select(Clarification).where(Clarification.document_id == DOC_ID))
    # The CRS confirmation resolved the question it settles, in the signed-in user's name.
    assert question is not None and question.status == "answered"
    assert question.answered_by == REVIEWER.actor


async def test_logout_then_401(client: httpx.AsyncClient, anon_client: httpx.AsyncClient) -> None:
    token = client.cookies.get("gm_session")
    assert token
    await call(client, "GET", "/api/v1/documents", expect=200)
    out = await call(client, "POST", LOGOUT, expect=204)
    assert "Max-Age=0" in out.headers["set-cookie"] or "max-age=0" in out.headers["set-cookie"].lower()
    for method, path in (("GET", "/api/v1/documents"), ("GET", ME), ("POST", "/api/v1/result-sets")):
        response = await client.request(method, path)
        assert response.status_code == 401 and response.json()["code"] == "not_authenticated"
    # The ended session's token is refused even when a client keeps sending it.
    kept = await anon_client.get("/api/v1/documents", headers={"Cookie": f"gm_session={token}"})
    assert kept.status_code == 401
    await call(client, "POST", LOGOUT, expect=204)  # idempotent
    await call(anon_client, "POST", LOGOUT, expect=204)  # also without any session


# ------------------------------------------------------------------------------------------------
# AUTH_ENABLED=false
# ------------------------------------------------------------------------------------------------


async def test_auth_disabled_keeps_everything_open(
    auth_off: None, anon_client: httpx.AsyncClient, finite_stream: None
) -> None:
    client = anon_client
    health = (await call(client, "GET", "/api/health", expect=200)).json()
    assert health["auth"]["enabled"] is False
    me = (await call(client, "GET", ME, expect=200)).json()["user"]
    assert me == {**me, "user_id": LOCAL_USER.user_id, "role": "admin", "display_name": "Local user"}
    uid, clar_id = await _fixture_document()
    for method, template, op_id in PROTECTED:
        if method != "GET" or op_id in {"getMe"}:
            continue
        path = _concrete(template)
        if op_id == "geocode":
            path += "?q=Sampleton"
        response = await client.get(path)
        assert response.status_code != 401, f"{op_id}: {response.text}"
    await call(client, "GET", f"/api/v1/documents/{DOC_ID}/pages/1.png", expect=200)
    await call(client, "GET", "/api/v1/events?last_event_id=0", expect=200)
    await call(
        client,
        "PATCH",
        f"/api/v1/boreholes/{uid}/values",
        expect=200,
        json={"path": "metadata.borehole_depth_m", "action": "approve"},
    )
    answered = (
        await call(
            client,
            "POST",
            f"/api/v1/clarifications/{clar_id}/answer",
            expect=200,
            json={"values": {"crs": "EPSG:25832"}},
        )
    ).json()
    assert answered["answered_by"] == "Local user"
    assert (await _actors(uid))[1:] == ["Local user", "Local user"]
    created = await client.post(
        "/api/v1/result-sets", json={}, headers={"Origin": "https://elsewhere.example"}
    )
    assert created.status_code == 201, created.text


async def test_there_is_no_password_change_route(client: httpx.AsyncClient) -> None:
    """Minimal sign-in: a password is reset on the server (python -m app.users), not in the browser."""
    body = {"current_password": REVIEWER.password, "new_password": "a-new-fictional-pass"}
    response = await client.post("/api/v1/auth/password", json=body)
    assert response.status_code == 404 and response.json()["code"] == "route_not_found"
    signed_in = await client.post(LOGIN, json={"email": REVIEWER.email, "password": REVIEWER.password})
    assert signed_in.status_code == 200
