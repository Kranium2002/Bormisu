"""The startup account (app.auth.bootstrap): AUTH_BOOTSTRAP_* in the environment give a working sign-in
with no command. Fictional account only (example.test)."""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest
from sqlalchemy import func, select

from app.auth import bootstrap
from app.config import Settings, get_settings
from app.db.models import User
from app.db.session import get_sessionmaker
from tests.auth_utils import LOGIN, ME, REGISTER, REVIEWER, register

EMAIL = "startup.account@example.test"
PASSWORD = "fictional-startup-phrase"
NEW_PASSWORD = "another-startup-phrase"


@pytest.fixture
def startup_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[pytest.MonkeyPatch]:
    """AUTH_BOOTSTRAP_EMAIL / AUTH_BOOTSTRAP_PASSWORD set."""
    monkeypatch.setenv("AUTH_BOOTSTRAP_EMAIL", EMAIL)
    monkeypatch.setenv("AUTH_BOOTSTRAP_PASSWORD", PASSWORD)
    get_settings.cache_clear()
    yield monkeypatch
    monkeypatch.undo()
    get_settings.cache_clear()


async def _accounts(email: str = EMAIL) -> list[User]:
    async with get_sessionmaker()() as session:
        return list((await session.scalars(select(User).where(User.email == email))).all())


async def _sign_in(client: httpx.AsyncClient, password: str) -> int:
    response = await client.post(LOGIN, json={"email": EMAIL, "password": password})
    return response.status_code


def test_bootstrap_account_names() -> None:
    assert Settings().bootstrap_account is None
    assert Settings(auth_bootstrap_email="a@example.test").bootstrap_account is None  # no password
    account = Settings(
        auth_bootstrap_username=" a@example.test ", auth_bootstrap_password="secret-phrase"
    ).bootstrap_account
    assert account is not None and account[0] == "a@example.test"
    assert account[1].get_secret_value() == "secret-phrase"
    # a blank email falls back to the username alias; a blank password means no account
    settings = Settings(
        auth_bootstrap_email=" ",
        auth_bootstrap_username="b@example.test",
        auth_bootstrap_password="first-phrase",
    )
    assert settings.bootstrap_account is not None
    assert settings.bootstrap_account[0] == "b@example.test"
    assert settings.bootstrap_account[1].get_secret_value() == "first-phrase"
    assert "first-phrase" not in repr(settings.bootstrap_account)
    no_password = Settings(auth_bootstrap_email="c@example.test", auth_bootstrap_password="")
    assert no_password.bootstrap_account is None


@pytest.mark.db
async def test_startup_creates_the_account_once(
    db: None, queue: object, startup_env: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("INFO", logger="geomemory.auth")
    assert await bootstrap.provision(get_settings()) == "created"
    assert await bootstrap.provision(get_settings()) == "unchanged"
    accounts = await _accounts()
    assert len(accounts) == 1 and accounts[0].role == "admin"
    assert PASSWORD not in accounts[0].password_hash and PASSWORD not in caplog.text
    from tests.conftest import app_client

    async with app_client() as client:  # the sign-in form's request works with no other step
        assert await _sign_in(client, PASSWORD) == 200
        me = await client.get(ME)
        assert me.status_code == 200 and me.json()["user"]["email"] == EMAIL


@pytest.mark.db
async def test_a_changed_password_updates_the_account(
    db: None, queue: object, startup_env: pytest.MonkeyPatch
) -> None:
    assert await bootstrap.provision(get_settings()) == "created"
    startup_env.setenv("AUTH_BOOTSTRAP_PASSWORD", NEW_PASSWORD)
    get_settings.cache_clear()
    assert await bootstrap.provision(get_settings()) == "updated"
    assert len(await _accounts()) == 1
    from tests.conftest import app_client

    async with app_client() as client:
        assert await _sign_in(client, PASSWORD) == 401
        assert await _sign_in(client, NEW_PASSWORD) == 200


@pytest.mark.db
async def test_an_existing_reviewer_becomes_admin(
    db: None, queue: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tests.conftest import app_client

    async with app_client() as client:
        await register(client)  # the first account (admin)
    async with app_client() as other:
        second = await other.post(REGISTER, json={"email": EMAIL, "password": PASSWORD})
        assert second.status_code == 201 and second.json()["user"]["role"] == "reviewer"
    monkeypatch.setenv("AUTH_BOOTSTRAP_EMAIL", EMAIL)
    monkeypatch.setenv("AUTH_BOOTSTRAP_PASSWORD", PASSWORD)
    get_settings.cache_clear()
    try:
        assert await bootstrap.provision(get_settings()) == "updated"
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
    assert [u.role for u in await _accounts()] == ["admin"]
    assert [u.role for u in await _accounts(REVIEWER.email)] == ["admin"]


@pytest.mark.db
async def test_a_password_against_the_rules_is_refused(
    db: None, startup_env: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    startup_env.setenv("AUTH_BOOTSTRAP_PASSWORD", "tiny-pw")
    get_settings.cache_clear()
    assert await bootstrap.provision(get_settings()) is None
    assert "tiny-pw" not in caplog.text and "8 characters" in caplog.text
    async with get_sessionmaker()() as session:
        assert await session.scalar(select(func.count()).select_from(User)) == 0
