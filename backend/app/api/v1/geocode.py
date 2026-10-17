"""Place search for any town or address (uploaded places first, then the server-side geocoder)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.geo.geocoder import geocode
from app.schemas.map import PlaceCandidate

router = APIRouter(tags=["map"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]


@router.get("/geocode", response_model=list[PlaceCandidate], operation_id="geocode")
async def get_geocode(
    session: SessionDep,
    q: Annotated[str, Query(min_length=2, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=10)] = 5,
) -> list[PlaceCandidate]:
    results = await geocode(session, q, limit)
    await session.commit()  # keeps the geocoder cache
    return results
