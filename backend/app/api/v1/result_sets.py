"""Result sets: create from a validated filter, read, and GeoJSON of the plotted members."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.map import GEOJSON, geojson_response
from app.db.models import Borehole
from app.db.session import get_session
from app.geo.result_sets import create_result_set, feature_collection, get_result_set, result_set_out
from app.schemas.map import BoreholeFilter, ResultSetOut

router = APIRouter(tags=["map"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]


@router.post("/result-sets", response_model=ResultSetOut, status_code=201, operation_id="createResultSet")
async def post_result_set(filt: BoreholeFilter, session: SessionDep) -> ResultSetOut:
    rs = await create_result_set(session, filt)
    await session.commit()
    return result_set_out(rs)


@router.get("/result-sets/{result_set_id}", response_model=ResultSetOut, operation_id="getResultSet")
async def read_result_set(result_set_id: str, session: SessionDep) -> ResultSetOut:
    return result_set_out(await get_result_set(session, result_set_id))


@router.get(
    "/result-sets/{result_set_id}/geojson",
    operation_id="getResultSetGeojson",
    response_class=JSONResponse,
    responses={200: {"content": {GEOJSON: {}}}},
)
async def result_set_geojson(result_set_id: str, session: SessionDep) -> JSONResponse:
    rs = await get_result_set(session, result_set_id)
    fc = await feature_collection(session, [Borehole.uid.in_(list(rs.uids))])
    return geojson_response(fc.model_dump(mode="json"))
