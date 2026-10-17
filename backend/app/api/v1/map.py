"""Map layer: plotted boreholes as GeoJSON."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Borehole
from app.db.session import get_session
from app.geo.result_sets import feature_collection

router = APIRouter(tags=["map"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]
GEOJSON = "application/geo+json"


def geojson_response(payload: dict[str, Any]) -> JSONResponse:
    return JSONResponse(payload, media_type=GEOJSON)


@router.get(
    "/map/boreholes.geojson",
    operation_id="getMapLayer",
    response_class=JSONResponse,
    responses={200: {"content": {GEOJSON: {}}}},
)
async def get_map_layer(
    session: SessionDep, include_unreviewed: bool = True, document_id: str | None = None
) -> JSONResponse:
    conds = []
    if not include_unreviewed:
        conds.append(Borehole.review_status == "approved")
    if document_id is not None:
        conds.append(Borehole.document_id == document_id)
    fc = await feature_collection(session, conds)
    return geojson_response(fc.model_dump(mode="json"))
