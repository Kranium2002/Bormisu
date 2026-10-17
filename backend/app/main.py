"""FastAPI app factory: routers, contract errors, CORS from settings."""

from __future__ import annotations

import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.v1 import (
    alignments,
    auth,
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
from app.auth import bootstrap
from app.auth.deps import current_user
from app.config import get_settings
from app.db.session import dispose_engine
from app.errors import CatchAllMiddleware, install_error_handlers
from app.geo.plotting import warm_transformers

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
    # coordinate-system ranking evaluates every registry system; build their transformers off the event loop
    threading.Thread(target=warm_transformers, name="crs-warm", daemon=True).start()
    await bootstrap.provision(settings)  # AUTH_BOOTSTRAP_EMAIL / AUTH_BOOTSTRAP_PASSWORD, when set
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
    # Public: the health checks (system; its /api/v1/stats needs a session itself) and sign-in (auth:
    # register and login are public, logout answers with or without a session, me needs one).
    app.include_router(system.router)
    app.include_router(auth.router, prefix=API_V1)
    # Everything else needs a signed-in user (401 not_authenticated), including page images, the event
    # stream and chat. With AUTH_ENABLED=false current_user returns the fixed local user instead.
    signed_in = [Depends(current_user)]
    for module in (documents, boreholes, map, result_sets, alignments, geocode, clarifications, events, chat):
        app.include_router(module.router, prefix=API_V1, dependencies=signed_in)
    return app


app = create_app()
