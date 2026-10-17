"""Sign-in core (contract 1.3.0, minimal): register, login, logout, me, sessions, any Origin, the CLI.

Fictional accounts only (example.test). There are no rate limits, no Origin check and no password change
in the browser; the only password rule is 8 to 128 characters.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select

from app import users as users_cli
from app.auth.passwords import hash_password, verify_password
from app.config import get_settings
from app.db.models import AuthSession, User
from app.db.session import get_sessionmaker
from tests.auth_utils import (
    LOGIN,
    LOGOUT,
    ME,
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


async def test_two_simultaneous_first_registrations_make_exactly_one_admin(db: None, queue: object) -> None:
    async with app_client() as one, app_client() as two:
        answers = await asyncio.gather(register(one, REVIEWER), register(two, SECOND))
        assert sorted(str(a["role"]) for a in answers) == ["admin", "reviewer"]
        for client in (one, two):
            assert (await client.get(ME)).status_code == 200
    async with get_sessionmaker()() as session:
        roles = (await session.scalars(select(User.role))).all()
    assert sorted(roles) == ["admin", "reviewer"]


async def test_registration_rules_answer_one_message_per_field(anon_client: httpx.AsyncClient) -> None:
    cases: list[tuple[dict[str, Any], dict[str, str]]] = [
        ({"email": "not-an-email", "password": "short"}, {"email": "", "password": "at least 8"}),
        ({"email": "a@example.test", "password": "seven-7"}, {"password": "at least 8"}),
        ({"email": "", "password": "x" * 129}, {"email": "Enter your email", "password": "at most 128"}),
        ({"email": "a@example.test", "password": ""}, {"password": "Enter a password"}),
        (
            {"email": "a@example.test", "password": "fine-fictional-pass", "display_name": "n" * 81},
            {"display_name": "80"},
        ),
        ({"email": "a b@example.test", "password": "fine-fictional-pass"}, {"email": "name@example.org"}),
        ({"email": "a@b@example.test", "password": "fine-fictional-pass"}, {"email": "name@example.org"}),
        ({"email": "@example.test", "password": "fine-fictional-pass"}, {"email": "name@example.org"}),
    ]
    for body, expected in cases:
        response = await call(anon_client, "POST", REGISTER, expect=422, json=body)
        fields = _fields(response)
        assert set(fields) == set(expected), (body, fields)
        for field, words in expected.items():
            assert words in fields[field], (field, fields[field])
            assert not fields[field].startswith("Value error"), fields[field]
    assert await _session_count() == 0


async def test_any_password_of_8_to_128_characters_is_accepted(anon_client: httpx.AsyncClient) -> None:
    """Length is the only rule: no common-password list, and the email itself is allowed."""
    accepted = [
        Account("eight@example.test", "12345678", None),
        Account("longest@example.test", "p" * 128, None),
        Account("common@example.test", "password", None),
        Account("same.as.email@example.test", "same.as.email@example.test", None),
    ]
    for account in accepted:
        await register(anon_client, account)
        await call(anon_client, "POST", LOGOUT, expect=204)
        assert (await login(anon_client, account)).status_code == 200


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
# No limits, no Origin check
# ------------------------------------------------------------------------------------------------


async def test_failed_sign_ins_are_never_locked_out(anon_client: httpx.AsyncClient) -> None:
    await register(anon_client)
    await call(anon_client, "POST", LOGOUT, expect=204)
    proxied = {"X-Forwarded-For": "198.51.100.7"}
    for _ in range(12):
        wrong = {"email": REVIEWER.email, "password": "nope-nope-1"}
        await call(anon_client, "POST", LOGIN, expect=401, json=wrong, headers=proxied)
    assert (await login(anon_client)).status_code == 200
    for n in range(12):
        account = Account(f"user{n}@example.test", "fictional-pass-phrase-1", None)
        body = {"email": account.email, "password": account.password}
        await call(anon_client, "POST", REGISTER, expect=201, json=body, headers=proxied)


async def test_writes_work_with_any_or_no_origin_header(anon_client: httpx.AsyncClient) -> None:
    """Behind the web proxy the Origin may name any host: no write is refused because of it."""
    client = anon_client
    headers: list[dict[str, str]] = [
        {},
        {"Origin": "https://elsewhere.example"},
        {"Referer": "https://elsewhere.example/page"},
        {"Origin": "http://192.0.2.10:8080"},
        {"Origin": "null"},
    ]
    body = {"email": REVIEWER.email, "password": REVIEWER.password, "display_name": REVIEWER.display_name}
    await call(client, "POST", REGISTER, expect=201, json=body, headers=headers[1])
    for sent in headers:
        await call(client, "POST", "/api/v1/result-sets", expect=201, json={}, headers=sent)
        await call(client, "POST", LOGOUT, expect=204, headers=sent)
        assert (await client.get(ME)).status_code == 401
        signed_in = await client.post(
            LOGIN, json={"email": REVIEWER.email, "password": REVIEWER.password}, headers=sent
        )
        assert signed_in.status_code == 200, (sent, signed_in.text)


# ------------------------------------------------------------------------------------------------
# Passwords and the command line
# ------------------------------------------------------------------------------------------------


def test_password_hashes() -> None:
    hashed = hash_password("fictional-pass-phrase-1")
    assert hashed.startswith("$argon2id$") and "fictional" not in hashed
    assert verify_password(hashed, "fictional-pass-phrase-1")
    assert not verify_password(hashed, "fictional-pass-phrase-2")
    assert not verify_password("not-a-hash", "fictional-pass-phrase-1")


async def test_users_cli(db: None, queue: object) -> None:
    assert "No accounts yet" in await users_cli.list_users()
    created = await users_cli.create("Lead@Example.test", "fictional-pass-phrase-1", "Fictional Lead", None)
    assert "admin lead@example.test" in created
    assert "reviewer" in await users_cli.create("helper@example.test", "fictional-pass-phrase-2", None, None)
    with pytest.raises(users_cli.UsageError, match="exists already"):
        await users_cli.create("lead@example.test", "fictional-pass-phrase-3", None, None)
    with pytest.raises(users_cli.UsageError, match="at least 8"):
        await users_cli.create("third@example.test", "seven-7", None, None)
    with pytest.raises(users_cli.UsageError, match=r"name@example\.org"):
        await users_cli.create("not-an-email", "fictional-pass-phrase-3", None, None)
    assert "now admin" in await users_cli.set_role("HELPER@example.test", "admin")
    async with app_client() as client:
        assert (
            await login(client, Account("lead@example.test", "fictional-pass-phrase-1", None))
        ).status_code == 200
        with pytest.raises(users_cli.UsageError, match="at most 128"):
            await users_cli.reset_password("lead@example.test", "x" * 129)
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
