"""Health and stats."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.config import get_settings
from app.db.models import Borehole, BoreholeLayer, Document
from app.db.session import get_session
from app.schemas.documents import Health, HealthProviders, HealthUpload, Stats

router = APIRouter()

# The chat assistant (app.chat) is built; providers.chat is true exactly when OPENAI_API_KEY is set.
CHAT_IMPLEMENTED = True


def build_health() -> Health:
    settings = get_settings()
    return Health(
        status="ok",
        mode=settings.mode,
        version=__version__,
        providers=HealthProviders(
            ocr=settings.ocr_configured,
            classifier=settings.classifier_configured,
            extractor=settings.extractor_configured,
            chat=settings.chat_configured and CHAT_IMPLEMENTED,
            geocoder=settings.geocoder_configured,
        ),
        upload=HealthUpload(max_mb=settings.max_upload_mb, extensions=settings.extensions),
    )


@router.get("/api/health", response_model=Health, tags=["system"], operation_id="getHealth")
async def get_health() -> Health:
    return build_health()


@router.get("/api/v1/health", response_model=Health, tags=["system"], operation_id="getHealthV1")
async def get_health_v1() -> Health:
    return build_health()


@router.get("/api/v1/stats", response_model=Stats, tags=["system"], operation_id="getStats")
async def get_stats(session: AsyncSession = Depends(get_session)) -> Stats:
    documents = await session.scalar(select(func.count()).select_from(Document))
    boreholes = await session.scalar(select(func.count()).select_from(Borehole))
    plotted = await session.scalar(select(func.count()).select_from(Borehole).where(Borehole.plotted))
    layers = await session.scalar(select(func.count()).select_from(BoreholeLayer))
    return Stats(
        documents=documents or 0,
        boreholes=boreholes or 0,
        plotted_boreholes=plotted or 0,
        layers=layers or 0,
    )
