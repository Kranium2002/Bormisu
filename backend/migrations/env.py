"""Alembic environment for GeoMemory: async SQLAlchemy 2 engine (asyncpg), PostGIS-aware.

The database URL comes from ``app.config.get_settings().database_url`` (env ``DATABASE_URL``) and
is never written to logs. Two hooks for tests and tools:

* ``config.attributes["connection"]``: an open *sync* ``Connection`` (for example the one passed to
  ``AsyncConnection.run_sync``) is used as is, so migrations can run inside a test's event loop;
* ``config.set_main_option("sqlalchemy.url", ...)`` migrates another database (escape ``%`` as ``%%``).

Autogenerate compares only what the models own. Objects created by extensions or other tools
(PostGIS ``spatial_ref_sys``, the ``tiger`` and ``topology`` schemas, Procrastinate's
``procrastinate_*`` tables with their types and functions) are never reflected, so autogenerate
never proposes to drop them.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from logging.config import fileConfig
from typing import Any

from alembic import context
from geoalchemy2 import alembic_helpers
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.schema import SchemaItem

import app.db.models  # noqa: F401  (imports every model so its table is on Base.metadata)
from app.config import get_settings
from app.db.base import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _database_url() -> str:
    """URL set on the Alembic Config (tests), otherwise the application's DATABASE_URL."""
    return config.get_main_option("sqlalchemy.url") or get_settings().database_url


def _model_schemas() -> set[str | None]:
    """Schemas that hold model tables; ``None`` is the connection's default schema."""
    return {None} | {table.schema for table in target_metadata.tables.values()}


def include_name(name: str | None, type_: str, parent_names: Mapping[str, str | None]) -> bool:
    """Reflect only schemas and tables that exist in the models' metadata."""
    if type_ == "schema":
        return name in _model_schemas()
    if type_ == "table":
        return parent_names.get("schema_qualified_table_name") in target_metadata.tables
    return True


def include_object(
    obj: SchemaItem,
    name: str | None,
    type_: str,
    reflected: bool,
    compare_to: SchemaItem | None,
) -> bool:
    """Second guard: skip database tables without a model, then GeoAlchemy2's spatial filters."""
    if type_ == "table" and reflected and compare_to is None:
        return False
    return bool(alembic_helpers.include_object(obj, name, type_, reflected, compare_to))


def _configure_options() -> dict[str, Any]:
    return {
        "target_metadata": target_metadata,
        "compare_type": True,
        "include_name": include_name,
        "include_object": include_object,
        # GeoAlchemy2: spatial columns, tables and indexes render and migrate correctly.
        "process_revision_directives": alembic_helpers.writer,
        "render_item": alembic_helpers.render_item,
    }


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of connecting (``alembic upgrade head --sql``)."""
    context.configure(
        url=_database_url(),
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **_configure_options(),
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, **_configure_options())
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    engine = create_async_engine(_database_url(), poolclass=pool.NullPool)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(do_run_migrations)
    finally:
        await engine.dispose()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if isinstance(connection, Connection):
        do_run_migrations(connection)
        return
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
