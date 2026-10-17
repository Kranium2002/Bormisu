"""Procrastinate app (PostgreSQL task queue). Tasks are registered in app.pipeline.orchestrator."""

from __future__ import annotations

from procrastinate import App, PsycopgConnector

from app.config import get_settings

queue_app = App(
    connector=PsycopgConnector(conninfo=get_settings().sync_database_url),
    import_paths=["app.pipeline.orchestrator"],
)
