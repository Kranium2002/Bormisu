"""Sign-in core (contract 1.3.0): register, login, limits, password change, Origin check, sessions, CLI.

Fictional accounts only (example.test). Rate limits are lowered through the environment per test.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select

from app import users as users_cli
from app.auth.limits import SlidingWindow
from app.auth.passwords import common_passwords, hash_password, needs_rehash, verify_password
from app.config import get_settings
from app.db.models import AuthSession, User
from app.db.session import get_sessionmaker
from tests.auth_utils import (
    LOGIN,
    LOGOUT,
    ME,
    PASSWORD,
    REGISTER,
    REVIEWER,
    SECOND,
    Account,
    login,
    register,
)
from tests.conftest import app_client
from tests.contract_utils import validate_response

pytestmark = pytest.mark.db


async def call(
    client: httpx.AsyncClient, method: str, path: str, *, expect: int, **kwargs: Any
) -> httpx.Response:
    response = await client.request(method, path, **kwargs)
    assert response.status_code == expect, response.text
    body = response.json() if response.content else None
    validate_response(method, path, response.status_code, body)
    return response


def _fields(response: httpx.Response) -> dict[str, str]:
    body = response.json()
    assert body["code"] == "validation_error"
    return {e["loc"][-1]: e["msg"] for e in body["errors"]}


async def _session_count(email: str | None = None) -> int:
    async with get_sessionmaker()() as session:
        query = select(func.count()).select_from(AuthSession)
        if email is not None:
            query = query.join(User, User.id == AuthSession.user_id).where(User.email == email)
        return await session.scalar(query) or 0


@pytest.fixture
def settings_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[pytest.MonkeyPatch]:
    """Set sign-in settings for one test (before the app that reads them is built)."""
    yield monkeypatch
    monkeypatch.undo()
    get_settings.cache_clear()


def _set(monkeypatch: pytest.MonkeyPatch, **values: str) -> None:
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()


# ------------------------------------------------------------------------------------------------
# Register, login, me, logout
# ------------------------------------------------------------------------------------------------


async def test_first_account_is_admin_later_ones_reviewer(anon_client: httpx.AsyncClient) -> None:
    body = {"email": "  Reviewer@Example.TEST ", "password": REVIEWER.password, "display_name": "  "}
    first = await call(anon_client, "POST", REGISTER, expect=201, json=body)
    user = first.json()["user"]
    assert user["email"] == "reviewer@example.test" and user["display_name"] is None
    assert user["role"] == "admin" and user["user_id"].startswith("usr_")
    cookie = first.headers["set-cookie"]
    assert "gm_session=" in cookie and "HttpOnly" in cookie and "Path=/" in cookie
    assert "samesite=lax" in cookie.lower() and "secure" not in cookie.lower()
    me = await call(anon_client, "GET", ME, expect=200)
    assert me.json() == {"user": user}
    second = await register(anon_client, SECOND)
    assert second["role"] == "reviewer"
    taken = await call(
        anon_client,
        "POST",
        REGISTER,
        expect=409,
        json={"email": "REVIEWER@example.test", "password": "a-different-fictional-pass"},
    )
    assert taken.json()["code"] == "email_taken"


async def test_registration_rules_answer_one_message_per_field(anon_client: httpx.AsyncClient) -> None:
    cases: list[tuple[dict[str, Any], dict[str, str]]] = [
        ({"email": "not-an-email", "password": "short"}, {"email": "", "password": "at least 10"}),
        ({"email": "", "password": "x" * 129}, {"email": "Enter your email", "password": "at most 128"}),
        ({"email": "a@example.test", "password": "QWERTYUIOP"}, {"password": "too common"}),
        (
            {"email": "long.name@example.test", "password": "Long.Name@example.test"},
            {"password": "your email"},
        ),
        (
            {"email": "a@example.test", "password": "fine-fictional-pass", "display_name": "n" * 81},
            {"display_name": "80"},
        ),
        ({"email": "a b@example.test", "password": "fine-fictional-pass"}, {"email": "name@example.org"}),
    ]
    for body, expected in cases:
        response = await call(anon_client, "POST", REGISTER, expect=422, json=body)
        fields = _fields(response)
        assert set(fields) == set(expected), (body, fields)
        for field, words in expected.items():
            assert words in fields[field], (field, fields[field])
            assert not fields[field].startswith("Value error"), fields[field]
    assert await _session_count() == 0


async def test_login_logout_and_the_same_answer_for_unknown_email(anon_client: httpx.AsyncClient) -> None:
    await register(anon_client)
    await call(anon_client, "POST", LOGOUT, expect=204)
    await call(anon_client, "GET", ME, expect=401)
    wrong = await call(
        anon_client, "POST", LOGIN, expect=401, json={"email": REVIEWER.email, "password": "wrong-password-1"}
    )
    unknown = await call(
        anon_client,
        "POST",
        LOGIN,
        expect=401,
        json={"email": "nobody@example.test", "password": "whatever-1"},
    )
    assert wrong.json() == unknown.json() == {**wrong.json(), "code": "invalid_credentials"}
    empty = await call(anon_client, "POST", LOGIN, expect=422, json={"email": " ", "password": ""})
    assert set(_fields(empty)) == {"email", "password"}
    response = await call(
        anon_client,
        "POST",
        LOGIN,
        expect=200,
        json={"email": "  REVIEWER@example.test", "password": REVIEWER.password},
    )
    assert response.json()["user"]["display_name"] == REVIEWER.display_name
    await call(anon_client, "GET", ME, expect=200)
    # Every sign-in is a new session; the stored key is the token's SHA-256, never the token.
    async with app_client() as other:
        assert (await login(other)).status_code == 200
        token = other.cookies.get("gm_session")
    assert token and await _session_count(REVIEWER.email) == 2
    async with get_sessionmaker()() as session:
        hashes = set((await session.scalars(select(AuthSession.token_hash))).all())
    assert hashlib.sha256(token.encode()).hexdigest() in hashes and token not in hashes


async def test_secure_cookie_behind_https(settings_env: pytest.MonkeyPatch, db: None, queue: object) -> None:
    _set(settings_env, COOKIE_SECURE="true")
    async with app_client() as client:
        response = await client.post(REGISTER, json={"email": REVIEWER.email, "password": REVIEWER.password})
    assert response.status_code == 201 and "secure" in response.headers["set-cookie"].lower()


async def test_closed_registration_allows_only_the_first_account(
    settings_env: pytest.MonkeyPatch, db: None, queue: object
) -> None:
    _set(settings_env, AUTH_REGISTRATION="closed")
    async with app_client() as client:
        health = await call(client, "GET", "/api/health", expect=200)
        assert health.json()["auth"] == {"enabled": True, "registration": "closed"}
        await register(client)
        refused = await call(
            client,
            "POST",
            REGISTER,
            expect=403,
            json={"email": SECOND.email, "password": SECOND.password},
        )
    assert refused.json()["code"] == "forbidden"


# ------------------------------------------------------------------------------------------------
# Limits
# ------------------------------------------------------------------------------------------------


async def test_failed_sign_ins_are_limited_per_email(
    settings_env: pytest.MonkeyPatch, db: None, queue: object
) -> None:
    _set(settings_env, AUTH_LOGIN_FAILURES_PER_EMAIL="3")
    async with app_client() as client:
        await register(client)
        for _ in range(3):
            await call(
                client, "POST", LOGIN, expect=401, json={"email": REVIEWER.email, "password": "nope-nope-1"}
            )
        limited = await call(
            client, "POST", LOGIN, expect=429, json={"email": REVIEWER.email, "password": REVIEWER.password}
        )
        assert limited.json()["code"] == "rate_limited"
        assert 1 <= int(limited.headers["retry-after"]) <= 900
        # Another email is not affected.
        await call(client, "POST", LOGIN, expect=401, json={"email": SECOND.email, "password": "nope-nope-1"})


async def test_failed_sign_ins_are_limited_per_client_address(
    settings_env: pytest.MonkeyPatch, db: None, queue: object
) -> None:
    _set(settings_env, AUTH_LOGIN_FAILURES_PER_IP="2")
    async with app_client() as client:
        proxied = {"X-Forwarded-For": "198.51.100.7"}
        for n in range(2):
            body = {"email": f"guess{n}@example.test", "password": "nope-nope-1"}
            await call(client, "POST", LOGIN, expect=401, json=body, headers=proxied)
        body = {"email": "guess9@example.test", "password": "nope-nope-1"}
        await call(client, "POST", LOGIN, expect=429, json=body, headers=proxied)
        # The address our proxy appends last counts, so a different client is not limited.
        await call(client, "POST", LOGIN, expect=401, json=body, headers={"X-Forwarded-For": "198.51.100.8"})


async def test_registrations_are_limited_per_client_address(
    settings_env: pytest.MonkeyPatch, db: None, queue: object
) -> None:
    _set(settings_env, AUTH_REGISTRATIONS_PER_IP="2")
    async with app_client() as client:
        for n in range(2):
            await register(client, Account(f"user{n}@example.test", "fictional-pass-phrase-1", None))
        limited = await call(
            client,
            "POST",
            REGISTER,
            expect=429,
            json={"email": "user9@example.test", "password": "fictional-pass-phrase-1"},
        )
    assert limited.headers["retry-after"].isdigit()


def test_sliding_window_counts_within_its_window() -> None:
    now = [1000.0]
    window = SlidingWindow(2, 60, clock=lambda: now[0])
    assert window.retry_after("k") is None
    window.hit("k")
    window.hit("k")
    assert window.retry_after("k") == 60
    now[0] += 30
    assert window.retry_after("k") == 30
    now[0] += 31
    assert window.retry_after("k") is None
    window.hit("k")
    window.reset("k")
    assert window.retry_after("k") is None


# ------------------------------------------------------------------------------------------------
# Password change
# ------------------------------------------------------------------------------------------------


async def test_password_change_ends_the_other_sessions(client: httpx.AsyncClient) -> None:
    async with app_client() as other:
        assert (await login(other)).status_code == 200
        wrong = await call(
            client,
            "POST",
            PASSWORD,
            expect=401,
            json={"current_password": "not-the-password", "new_password": "a-new-fictional-pass"},
        )
        assert wrong.json()["code"] == "invalid_credentials"
        await call(client, "GET", ME, expect=200)  # a wrong current password keeps the session
        weak = await call(
            client,
            "POST",
            PASSWORD,
            expect=422,
            json={"current_password": REVIEWER.password, "new_password": "1234567890"},
        )
        assert set(_fields(weak)) == {"new_password"}
        new = "a-new-fictional-pass"
        await call(
            client,
            "POST",
            PASSWORD,
            expect=204,
            json={"current_password": REVIEWER.password, "new_password": new},
        )
        await call(client, "GET", ME, expect=200)
        assert (await other.get(ME)).status_code == 401
    old = await client.post(LOGIN, json={"email": REVIEWER.email, "password": REVIEWER.password})
    assert old.status_code == 401
    assert (await login(client, Account(REVIEWER.email, new, None))).status_code == 200


# ------------------------------------------------------------------------------------------------
# Writes from other sites
# ------------------------------------------------------------------------------------------------


async def test_writes_from_a_foreign_page_are_refused(client: httpx.AsyncClient) -> None:
    foreign = {"Origin": "https://evil.example"}
    refused = await client.post("/api/v1/result-sets", json={}, headers=foreign)
    assert refused.status_code == 403 and refused.json()["code"] == "forbidden"
    by_referer = await client.post(
        "/api/v1/result-sets", json={}, headers={"Referer": "https://evil.example/page"}
    )
    assert by_referer.status_code == 403
    login_from_elsewhere = await client.post(
        LOGIN, json={"email": REVIEWER.email, "password": REVIEWER.password}, headers=foreign
    )
    assert login_from_elsewhere.status_code == 403
    assert (await client.get("/api/v1/documents", headers=foreign)).status_code == 200  # reads pass
    for allowed in ("http://testserver", "http://localhost:8080", "http://localhost:5173"):
        response = await client.post("/api/v1/result-sets", json={}, headers={"Origin": allowed})
        assert response.status_code == 201, (allowed, response.text)
    proxied = await client.post(
        "/api/v1/result-sets",
        json={},
        headers={"Origin": "http://192.0.2.10:8080", "Host": "192.0.2.10:8080"},
    )
    assert proxied.status_code == 201  # the page and the API share the host behind the web proxy


# ------------------------------------------------------------------------------------------------
# Passwords and the command line
# ------------------------------------------------------------------------------------------------


def test_password_hashes() -> None:
    hashed = hash_password("fictional-pass-phrase-1")
    assert hashed.startswith("$argon2id$") and "fictional" not in hashed
    assert verify_password(hashed, "fictional-pass-phrase-1")
    assert not verify_password(hashed, "fictional-pass-phrase-2")
    assert not verify_password("not-a-hash", "fictional-pass-phrase-1")
    assert not needs_rehash(hashed) and needs_rehash("not-a-hash")
    assert "qwertyuiop" in common_passwords() and all(p == p.lower() for p in common_passwords())


async def test_users_cli(db: None, queue: object) -> None:
    assert "No accounts yet" in await users_cli.list_users()
    created = await users_cli.create("Lead@Example.test", "fictional-pass-phrase-1", "Fictional Lead", None)
    assert "admin lead@example.test" in created
    assert "reviewer" in await users_cli.create("helper@example.test", "fictional-pass-phrase-2", None, None)
    with pytest.raises(users_cli.UsageError, match="exists already"):
        await users_cli.create("lead@example.test", "fictional-pass-phrase-3", None, None)
    with pytest.raises(users_cli.UsageError, match="too common"):
        await users_cli.create("third@example.test", "password123", None, None)
    assert "now admin" in await users_cli.set_role("HELPER@example.test", "admin")
    async with app_client() as client:
        assert (
            await login(client, Account("lead@example.test", "fictional-pass-phrase-1", None))
        ).status_code == 200
        reset = await users_cli.reset_password("lead@example.test", "a-new-fictional-pass")
        assert "ended" in reset
        assert (await client.get(ME)).status_code == 401
        assert (
            await login(client, Account("lead@example.test", "a-new-fictional-pass", None))
        ).status_code == 200
        assert "ended" in await users_cli.sign_out_everywhere("lead@example.test")
        assert (await client.get(ME)).status_code == 401
    listing = await users_cli.list_users()
    assert "lead@example.test" in listing and "Fictional Lead" in listing
    with pytest.raises(users_cli.UsageError, match="No account"):
        await users_cli.set_role("nobody@example.test", "reviewer")
    with pytest.raises(SystemExit):
        users_cli.main(["create"])  # --email is required
