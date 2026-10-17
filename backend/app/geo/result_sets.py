"""Result sets: immutable snapshots of a filter's matches, shared by Explore, map selection and chat."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Borehole, Clarification, ResultSet
from app.errors import not_found
from app.geo.filters import filter_conditions
from app.ids import new_id
from app.schemas.map import (
    AreaBbox,
    AreaCircle,
    AreaPolygon,
    BoreholeFilter,
    Feature,
    FeatureCollection,
    FeatureProperties,
    PointGeometry,
    ResultSetOut,
)


def _area_bbox(area: AreaBbox | AreaPolygon | AreaCircle | None) -> list[float] | None:
    if area is None:
        return None
    if isinstance(area, AreaBbox):
        return list(area.bbox)
    if isinstance(area, AreaPolygon):
        lons = [p[0] for ring in area.polygon["coordinates"] for p in ring]
        lats = [p[1] for ring in area.polygon["coordinates"] for p in ring]
        return [min(lons), min(lats), max(lons), max(lats)]
    import math

    lon, lat = area.center
    dlat = area.radius_m / 111_320
    dlon = area.radius_m / (111_320 * max(math.cos(math.radians(lat)), 0.01))
    return [max(lon - dlon, -180), max(lat - dlat, -90), min(lon + dlon, 180), min(lat + dlat, 90)]


async def create_result_set(session: AsyncSession, filt: BoreholeFilter) -> ResultSet:
    conds = filter_conditions(filt)
    uids = list((await session.scalars(select(Borehole.uid).where(*conds).order_by(Borehole.uid))).all())
    excluded = 0
    if not filt.include_unreviewed:
        everything = filter_conditions(filt, apply_review_scope=False)
        total_any = await session.scalar(select(func.count()).select_from(Borehole).where(*everything)) or 0
        excluded = total_any - len(uids)
    located = 0
    bbox: list[float] | None = None
    if uids:
        row = (
            await session.execute(
                select(
                    func.count(Borehole.geom),
                    func.ST_XMin(func.ST_Extent(Borehole.geom)),
                    func.ST_YMin(func.ST_Extent(Borehole.geom)),
                    func.ST_XMax(func.ST_Extent(Borehole.geom)),
                    func.ST_YMax(func.ST_Extent(Borehole.geom)),
                ).where(Borehole.uid.in_(uids), Borehole.plotted.is_(True))
            )
        ).one()
        located = int(row[0] or 0)
        if located:
            bbox = [float(row[1]), float(row[2]), float(row[3]), float(row[4])]
    if bbox is None:
        bbox = _area_bbox(filt.area)
    rs = ResultSet(
        id=new_id("rs"),
        definition=filt.model_dump(mode="json"),
        uids=uids,
        count=len(uids),
        located_count=located,
        unlocated_count=len(uids) - located,
        excluded_unreviewed=excluded,
        bbox=bbox,
        area=filt.area.model_dump(mode="json") if filt.area is not None else None,
    )
    session.add(rs)
    await session.flush()
    await session.refresh(rs)
    return rs


async def get_result_set(session: AsyncSession, result_set_id: str) -> ResultSet:
    rs = await session.scalar(
        select(ResultSet).where(ResultSet.id == result_set_id, ResultSet.expires_at > func.now())
    )
    if rs is None:
        raise not_found("result_set_not_found", "Result set")
    return rs


def result_set_out(rs: ResultSet) -> ResultSetOut:
    return ResultSetOut(
        result_set_id=rs.id,
        count=rs.count,
        located_count=rs.located_count,
        unlocated_count=rs.unlocated_count,
        excluded_unreviewed=rs.excluded_unreviewed,
        uids=list(rs.uids),
        bbox=rs.bbox,
        area=rs.area,
        definition=BoreholeFilter.model_validate(rs.definition),
        created_at=rs.created_at,
    )


async def feature_collection(session: AsyncSession, conds: Sequence[Any]) -> FeatureCollection:
    """Plotted boreholes as light point features (no layers, no provenance)."""
    open_counts = (
        select(func.unnest(Clarification.borehole_uids).label("uid"))
        .where(Clarification.status == "open")
        .subquery()
    )
    counts = select(open_counts.c.uid, func.count().label("n")).group_by(open_counts.c.uid).subquery()
    rows = (
        await session.execute(
            select(
                Borehole,
                func.ST_X(Borehole.geom),
                func.ST_Y(Borehole.geom),
                func.coalesce(counts.c.n, 0),
            )
            .outerjoin(counts, counts.c.uid == Borehole.uid)
            .where(Borehole.plotted.is_(True), Borehole.geom.is_not(None), *conds)
            .order_by(Borehole.uid)
        )
    ).all()
    features = []
    for bh, lon, lat, n_open in rows:
        features.append(
            Feature(
                id=bh.uid,
                geometry=PointGeometry(coordinates=[float(lon), float(lat)]),
                properties=FeatureProperties(
                    uid=bh.uid,
                    borehole_id=bh.label_raw,
                    project_name=bh.project_name,
                    document_id=bh.document_id,
                    borehole_depth_m=bh.borehole_depth_m,
                    review_status=bh.review_status,
                    crs_status=bh.crs_status,
                    revision=bh.revision,
                    attention=bool(bh.needs_attention or n_open),
                    open_clarifications=int(n_open),
                ),
            )
        )
    return FeatureCollection(features=features)
