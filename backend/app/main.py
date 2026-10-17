"""FastAPI app factory: routers, contract errors, CORS from settings."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.v1 import (
    alignments,
    boreholes,
    chat,
    clarifications,
    documents,
    events,
    geocode,
    map,
    result_sets,
    system,
)
from app.config import get_settings
from app.db.session import dispose_engine
from app.errors import CatchAllMiddleware, install_error_handlers

API_V1 = "/api/v1"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("geomemory").info(
        "api starting: mode=%s providers ocr=%s classifier=%s extractor=%s chat=%s geocoder=%s",
        settings.mode,
        settings.ocr_configured,
        settings.classifier_configured,
        settings.extractor_configured,
        settings.chat_configured,
        settings.geocoder_configured,
    )
    if app.state.open_queue:
        from app.queue import queue_app

        async with queue_app.open_async():
            yield
    else:
        yield
    await dispose_engine()


def create_app(*, open_queue: bool = True) -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="GeoMemory API",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.open_queue = open_queue
    install_error_handlers(app)
    app.add_middleware(CatchAllMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Last-Event-ID", "Accept"],
    )
    app.include_router(system.router)
    for module in (documents, boreholes, map, result_sets, alignments, geocode, clarifications, events, chat):
        app.include_router(module.router, prefix=API_V1)
    return app


app = create_app()
