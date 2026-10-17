"""BoreholeFilter -> SQLAlchemy Core with typed parameters only (shared by lists, result sets, chat tools)."""

from __future__ import annotations

import json
from typing import Any

from geoalchemy2 import Geography
from sqlalchemy import (
    ColumnElement,
    Select,
    and_,
    cast,
    exists,
    false,
    func,
    literal,
    or_,
    select,
)

from app.db.models import Borehole, BoreholeGroundwater, BoreholeLayer, Document
from app.schemas.map import AreaBbox, AreaCircle, AreaPolygon, BoreholeFilter


def _ilike_any(text: str, *columns: Any) -> ColumnElement[bool]:
    pattern = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return or_(*(col.ilike(pattern, escape="\\") for col in columns))


def area_condition(area: AreaBbox | AreaPolygon | AreaCircle) -> ColumnElement[bool]:
    if isinstance(area, AreaBbox):
        min_lon, min_lat, max_lon, max_lat = area.bbox
        if min_lon <= max_lon:
            return func.ST_Intersects(
                Borehole.geom, func.ST_MakeEnvelope(min_lon, min_lat, max_lon, max_lat, 4326)
            )
        # The box crosses the antimeridian: split it in two.
        west = func.ST_MakeEnvelope(min_lon, min_lat, 180, max_lat, 4326)
        east = func.ST_MakeEnvelope(-180, min_lat, max_lon, max_lat, 4326)
        return or_(func.ST_Intersects(Borehole.geom, west), func.ST_Intersects(Borehole.geom, east))
    if isinstance(area, AreaPolygon):
        geometry = func.ST_SetSRID(func.ST_GeomFromGeoJSON(literal(json.dumps(area.polygon))), 4326)
        return func.ST_Intersects(Borehole.geom, geometry)
    lon, lat = area.center
    center = cast(func.ST_SetSRID(func.ST_MakePoint(lon, lat), 4326), Geography)
    return func.ST_DWithin(cast(Borehole.geom, Geography), center, area.radius_m)


def filter_conditions(f: BoreholeFilter, *, apply_review_scope: bool = True) -> list[ColumnElement[bool]]:
    """WHERE conditions for a filter. With `apply_review_scope`, include_unreviewed=false keeps approved."""
    conds: list[ColumnElement[bool]] = []
    if f.search:
        text = f.search.strip()
        if text:
            conds.append(
                _ilike_any(
                    text,
                    Borehole.label_raw,
                    Borehole.label_canonical,
                    Borehole.project_name,
                    Borehole.location_name,
                    func.array_to_string(Borehole.aliases, " "),
                )
            )
    if f.country:
        conds.append(func.lower(Borehole.country) == f.country.strip().lower())
    if f.project:
        project = f.project.strip()
        doc_match = exists(
            select(Document.id).where(
                Document.id == Borehole.document_id, func.lower(Document.project) == project.lower()
            )
        )
        conds.append(or_(func.lower(Borehole.project_name) == project.lower(), doc_match))
    if f.document_id:
        conds.append(Borehole.document_id == f.document_id)
    if f.min_depth_m is not None:
        conds.append(Borehole.borehole_depth_m >= f.min_depth_m)
    if f.max_depth_m is not None:
        conds.append(Borehole.borehole_depth_m <= f.max_depth_m)
    if f.din4023_codes:
        layer = select(BoreholeLayer.uid).where(
            BoreholeLayer.uid == Borehole.uid, BoreholeLayer.din4023_code.in_(list(f.din4023_codes))
        )
        if f.lithology_min_depth_m is not None:
            layer = layer.where(BoreholeLayer.depth_to_m > f.lithology_min_depth_m)
        conds.append(exists(layer))
    if f.has_spt is not None:
        spt = exists(
            select(BoreholeLayer.uid).where(
                BoreholeLayer.uid == Borehole.uid,
                or_(BoreholeLayer.spt_n_value.is_not(None), BoreholeLayer.spt_refusal.is_(True)),
            )
        )
        conds.append(spt if f.has_spt else ~spt)
    if f.has_groundwater is not None:
        gw = exists(select(BoreholeGroundwater.uid).where(BoreholeGroundwater.uid == Borehole.uid))
        conds.append(gw if f.has_groundwater else ~gw)
    if f.review_status:
        conds.append(Borehole.review_status.in_(list(f.review_status)))
    if f.area is not None:
        conds.append(and_(Borehole.geom.is_not(None), area_condition(f.area)))
    if apply_review_scope and not f.include_unreviewed:
        conds.append(Borehole.review_status == "approved")
    return conds


def boreholes_query(f: BoreholeFilter, *, apply_review_scope: bool = True) -> Select[Any]:
    return select(Borehole).where(*filter_conditions(f, apply_review_scope=apply_review_scope))


def nothing() -> ColumnElement[bool]:
    return false()
