"""Shared fixtures. Fictional data only. No test calls a real provider.

Database tests need PostgreSQL with PostGIS, pgvector and pg_trgm at TEST_DATABASE_URL (the compose `db`
service works: postgresql+asyncpg://geomemory:geomemory@localhost:5432/geomemory_test). The database is
created when missing and its schema is rebuilt once per test session. Tests marked `db` are skipped
when it is unreachable, unless REQUIRE_DB=1 (CI) turns that into a failure.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

_STORAGE = Path(tempfile.mkdtemp(prefix="geomemory-test-storage-"))
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://geomemory:geomemory@localhost:5432/geomemory_test"
)

# Settings are read from the environment: pin everything before the app is imported.
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["STORAGE_DIR"] = str(_STORAGE)
os.environ["GEOCODER"] = "none"
# The classic extractor unless a test opts into bh3 with a fake bridge (bh3 would call a vision model).
os.environ["EXTRACTOR"] = "classic"
for _key in ("OPENROUTER_API_KEY", "OPEN_ROUTER_KEY", "MISTRAL_API_KEY", "OPENAI_API_KEY"):
    os.environ[_key] = ""

import asyncpg  # noqa: E402
import httpx  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import dispose_engine, get_engine, get_sessionmaker  # noqa: E402

EXTENSIONS = ("postgis", "vector", "pg_trgm")


def _plain_dsn(url: str, database: str | None = None) -> str:
    parsed = make_url(url).set(drivername="postgresql")
    if database is not None:
        parsed = parsed.set(database=database)
    return parsed.render_as_string(hide_password=False)


async def _ensure_database() -> None:
    target = make_url(TEST_DATABASE_URL).database
    conn = await asyncpg.connect(_plain_dsn(TEST_DATABASE_URL, "postgres"), timeout=5)
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", target)
        if not exists:
            await conn.execute(f'CREATE DATABASE "{target}"')
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def storage_dir() -> Path:
    return _STORAGE


@pytest.fixture(scope="session")
async def database() -> AsyncIterator[None]:
    """Rebuild the test schema once per session (extensions, tables, Procrastinate schema)."""
    try:
        await _ensure_database()
    except (OSError, asyncpg.PostgresError, TimeoutError) as exc:
        if os.environ.get("REQUIRE_DB") == "1":
            raise
        pytest.skip(f"PostgreSQL not reachable at TEST_DATABASE_URL ({type(exc).__name__})")
    get_settings.cache_clear()
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        for ext in EXTENSIONS:
            await conn.execute(text(f"CREATE EXTENSION IF NOT EXISTS {ext}"))
        await conn.run_sync(Base.metadata.create_all)
    yield
    await dispose_engine()


@pytest.fixture(autouse=True)
def fresh_provider_failover() -> Iterator[None]:
    """Every test starts without the per-process memory of refused keys, refused OpenAI parameters and models
    that required reasoning."""
    from app.bh3 import llm as bh3_llm
    from app.pipeline import ocr
    from app.providers import llm, reasoning

    def clear() -> None:
        ocr._REFUSED_ROUTES.clear()
        llm._REFUSED.clear()
        llm._PLAIN_OPENAI_MODELS.clear()
        llm._OPENAI_EFFORT.clear()
        reasoning._LEARNED.clear()
        bh3_llm._REASONING_REQUIRED.clear()

    clear()
    yield
    clear()


@pytest.fixture
async def db(database: None) -> AsyncIterator[None]:
    """Empty every application table before the test."""
    tables = ", ".join(f'"{t.name}"' for t in reversed(Base.metadata.sorted_tables))
    async with get_engine().begin() as conn:
        await conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    yield


@pytest.fixture
async def session(db: None) -> AsyncIterator[object]:
    async with get_sessionmaker()() as s:
        yield s


@pytest.fixture
def queue() -> Iterator[object]:
    """Procrastinate with an in-memory connector: deferred jobs are recorded, nothing runs."""
    from procrastinate.testing import InMemoryConnector

    from app.queue import queue_app

    connector = InMemoryConnector()
    with queue_app.replace_connector(connector):
        yield connector


@asynccontextmanager
async def app_client() -> AsyncIterator[httpx.AsyncClient]:
    """A fresh app and an HTTP client with no session, the queue open."""
    from app.main import create_app
    from app.queue import queue_app

    app = create_app(open_queue=False)
    async with queue_app.open_async():
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac


@pytest.fixture
async def anon_client(db: None, queue: object) -> AsyncIterator[httpx.AsyncClient]:
    """Not signed in: every route except health, register and login answers 401 not_authenticated."""
    async with app_client() as ac:
        yield ac


@pytest.fixture
async def client(db: None, queue: object) -> AsyncIterator[httpx.AsyncClient]:
    """Signed in as the fictional tests.auth_utils.REVIEWER, registered first (so its role is admin).

    Its revisions, answers and CRS confirmations carry the actor REVIEWER.actor ("Fictional Reviewer").
    """
    from tests.auth_utils import register

    async with app_client() as ac:
        await register(ac)
        yield ac


@pytest.fixture
def live_mode(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Pretend provider keys are configured (values are fake; providers are never called in tests). OCR is
    forced to the Mistral route, the client the tests replace with their fake OCR engine."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-not-a-key")
    monkeypatch.setenv("MISTRAL_API_KEY", "test-not-a-key")
    monkeypatch.setenv("OCR_PROVIDER", "mistral")
    get_settings.cache_clear()
    yield
    monkeypatch.undo()
    get_settings.cache_clear()


@pytest.fixture
def auth_off(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """AUTH_ENABLED=false: no route needs a session; every request acts as the fixed local user."""
    monkeypatch.setenv("AUTH_ENABLED", "false")
    get_settings.cache_clear()
    yield
    monkeypatch.undo()
    get_settings.cache_clear()
