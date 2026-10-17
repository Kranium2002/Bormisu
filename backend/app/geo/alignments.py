"""Planned lines: store them and find the boreholes within a distance of the line, in chainage order.

Distance (filter and offset) is measured on the WGS84 ellipsoid: ST_DWithin / ST_Distance on geography.
Chainage and side need a planar line (PostGIS geography has no line-locate), so they are computed in the
UTM zone of the line's centre, which is conformal (left/right stays true) and distorts lengths by less
than 0.1 % within a few hundred kilometres of the zone's central meridian. Chainage is then scaled by
the ellipsoidal length over the planar length, so the last vertex sits exactly at `length_m`. The
buffer band for drawing is buffered in the same UTM zone.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from geoalchemy2 import Geography, WKTElement
from pyproj import Geod, Transformer
from sqlalchemy import ColumnElement, and_, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Alignment, Borehole, ResultSet
from app.errors import not_found
from app.geo.alignment_files import COORD_DECIMALS, ParsedLine, Part
from app.geo.result_sets import result_set_out
from app.ids import new_id
from app.schemas.alignments import AlignmentHit, AlignmentOut, AlignmentResult
from app.schemas.map import AreaPolygon, BoreholeFilter

_GEOD = Geod(ellps="WGS84")
# A borehole closer than this to the line is on it (no side).
ON_LINE_M = 0.5
MAX_NAME = 200


def utm_epsg(lon: float, lat: float) -> int:
    """EPSG code of the WGS84 UTM zone containing (lon, lat): 326xx north, 327xx south."""
    zone = min(max(math.floor((lon + 180) / 6) + 1, 1), 60)
    return (32600 if lat >= 0 else 32700) + zone


def bbox_of(parts: Sequence[Part]) -> list[float]:
    lons = [p[0] for part in parts for p in part]
    lats = [p[1] for part in parts for p in part]
    return [min(lons), min(lats), max(lons), max(lats)]


def geodesic_length(parts: Sequence[Part]) -> float:
    return float(sum(_GEOD.line_length([p[0] for p in part], [p[1] for p in part]) for part in parts))


@dataclass(frozen=True)
class Station:
    chainage_m: float
    side: str  # left | right (on is decided from the ellipsoidal offset)


class LineFrame:
    """The line in a UTM zone: chainage and side of a point from its nearest segment."""

    def __init__(self, parts: Sequence[Part]) -> None:
        min_lon, min_lat, max_lon, max_lat = bbox_of(parts)
        self.epsg = utm_epsg((min_lon + max_lon) / 2, (min_lat + max_lat) / 2)
        self._to_utm = Transformer.from_crs(4326, self.epsg, always_xy=True)
        # (ax, ay, dx, dy, length, chainage at a) per segment, parts in order.
        self._segments: list[tuple[float, float, float, float, float, float]] = []
        planar = 0.0
        for part in parts:
            xs, ys = self._to_utm.transform([p[0] for p in part], [p[1] for p in part])
            for i in range(len(xs) - 1):
                dx, dy = xs[i + 1] - xs[i], ys[i + 1] - ys[i]
                length = math.hypot(dx, dy)
                if length > 0:
                    self._segments.append((xs[i], ys[i], dx, dy, length, planar))
                    planar += length
        self.planar_length = planar
        self.length_m = geodesic_length(parts)
        self._scale = self.length_m / planar if planar > 0 else 1.0

    def locate(self, lon: float, lat: float) -> Station:
        x, y = self._to_utm.transform(lon, lat)
        best: tuple[float, float, float] | None = None  # (distance², chainage, cross)
        for ax, ay, dx, dy, length, start in self._segments:
            t = min(max(((x - ax) * dx + (y - ay) * dy) / (length * length), 0.0), 1.0)
            fx, fy = ax + t * dx, ay + t * dy
            dist2 = (x - fx) ** 2 + (y - fy) ** 2
            if best is None or dist2 < best[0]:
                best = (dist2, start + t * length, dx * (y - ay) - dy * (x - ax))
        assert best is not None, "a line has at least one segment"
        return Station(best[1] * self._scale, "left" if best[2] > 0 else "right")


def _wkt(parts: Sequence[Part]) -> str:
    return (
        "MULTILINESTRING("
        + ",".join("(" + ",".join(f"{lon!r} {lat!r}" for lon, lat in part) + ")" for part in parts)
        + ")"
    )


def _line_geojson(parts: Sequence[Part]) -> dict[str, Any]:
    coords = [[[lon, lat] for lon, lat in part] for part in parts]
    if len(coords) == 1:
        return {"type": "LineString", "coordinates": coords[0]}
    return {"type": "MultiLineString", "coordinates": coords}


async def create_alignment(
    session: AsyncSession, parsed: ParsedLine, *, name: str | None, file_name: str, buffer_m: float
) -> tuple[Alignment, list[Part]]:
    stem = file_name.rsplit(".", 1)[0] if "." in file_name else file_name
    label = ((name or "").strip() or (parsed.name or "").strip() or stem.strip() or "Planned line")[:MAX_NAME]
    alignment = Alignment(
        id=new_id("aln"),
        name=label,
        file_name=file_name,
        format=parsed.format,
        source_crs=parsed.source_crs,
        geom=WKTElement(_wkt(parsed.parts), srid=4326),
        length_m=geodesic_length(parsed.parts),
        vertex_count=parsed.vertex_count,
        part_count=len(parsed.parts),
        buffer_m=buffer_m,
    )
    session.add(alignment)
    await session.flush()
    await session.refresh(alignment)
    return alignment, parsed.parts


def _parts_of(geojson: str) -> list[Part]:
    geometry = json.loads(geojson)
    lines = geometry["coordinates"] if geometry["type"] == "MultiLineString" else [geometry["coordinates"]]
    return [[(float(p[0]), float(p[1])) for p in line] for line in lines]


async def load_parts(session: AsyncSession, alignment_id: str) -> list[Part]:
    geojson = await session.scalar(
        select(func.ST_AsGeoJSON(Alignment.geom, COORD_DECIMALS)).where(Alignment.id == alignment_id)
    )
    if geojson is None:
        raise not_found("alignment_not_found", "Alignment")
    return _parts_of(geojson)


def alignment_out(alignment: Alignment, parts: Sequence[Part]) -> AlignmentOut:
    return AlignmentOut(
        alignment_id=alignment.id,
        name=alignment.name,
        file_name=alignment.file_name,
        format=alignment.format,
        source_crs=alignment.source_crs,
        geometry=_line_geojson(parts),
        length_m=round(alignment.length_m, 1),
        vertex_count=alignment.vertex_count,
        part_count=alignment.part_count,
        bbox=bbox_of(parts),
        buffer_m=alignment.buffer_m,
        created_at=alignment.created_at,
    )


async def get_alignment(session: AsyncSession, alignment_id: str) -> Alignment:
    alignment = await session.get(Alignment, alignment_id)
    if alignment is None:
        raise not_found("alignment_not_found", "Alignment")
    return alignment


async def list_alignments(session: AsyncSession) -> list[AlignmentOut]:
    rows = (
        await session.execute(
            select(Alignment, func.ST_AsGeoJSON(Alignment.geom, COORD_DECIMALS)).order_by(
                Alignment.created_at.desc(), Alignment.id.desc()
            )
        )
    ).all()
    return [alignment_out(alignment, _parts_of(geojson)) for alignment, geojson in rows]


async def delete_alignment(session: AsyncSession, alignment_id: str) -> None:
    await session.delete(await get_alignment(session, alignment_id))


def _review_scope(include_unreviewed: bool) -> list[ColumnElement[bool]]:
    return [] if include_unreviewed else [Borehole.review_status == "approved"]


async def query_alignment(
    session: AsyncSession, alignment: Alignment, *, buffer_m: float, include_unreviewed: bool
) -> AlignmentResult:
    parts = await load_parts(session, alignment.id)
    frame = LineFrame(parts)
    line = select(Alignment.geom).where(Alignment.id == alignment.id).scalar_subquery()
    line_geog = cast(line, Geography)
    point_geog = cast(Borehole.geom, Geography)
    # Index-friendly box around the line (degrees, generous) before the exact ellipsoidal test.
    _, min_lat, _, max_lat = bbox_of(parts)
    dlat = buffer_m / 110_000 * 1.1
    far_lat = min(max(abs(min_lat), abs(max_lat)) + dlat, 89.9)
    dlon = dlat / max(math.cos(math.radians(far_lat)), 0.01)
    within = and_(
        Borehole.plotted.is_(True),
        Borehole.geom.is_not(None),
        Borehole.geom.op("&&")(func.ST_Expand(line, dlon, dlat)),
        func.ST_DWithin(point_geog, line_geog, buffer_m),
    )
    rows = (
        await session.execute(
            select(
                Borehole,
                func.ST_X(Borehole.geom),
                func.ST_Y(Borehole.geom),
                func.ST_Distance(point_geog, line_geog),
            ).where(within, *_review_scope(include_unreviewed))
        )
    ).all()
    hits: list[AlignmentHit] = []
    for bh, lon, lat, distance in rows:
        offset = float(distance)
        station = frame.locate(float(lon), float(lat))
        hits.append(
            AlignmentHit(
                uid=bh.uid,
                borehole_id=bh.label_raw,
                document_id=bh.document_id,
                project_name=bh.project_name,
                borehole_depth_m=bh.borehole_depth_m,
                review_status=bh.review_status,
                crs_status=bh.crs_status,
                position=[float(lon), float(lat)],
                offset_m=round(offset, 1),
                chainage_m=round(min(max(station.chainage_m, 0.0), frame.length_m), 1),
                side="on" if offset < ON_LINE_M else station.side,
            )
        )
    hits.sort(key=lambda h: (h.chainage_m, h.offset_m, h.uid))
    excluded = 0
    if not include_unreviewed:
        excluded = (
            await session.scalar(
                select(func.count()).select_from(Borehole).where(within, Borehole.review_status != "approved")
            )
            or 0
        )
    not_on_map = (
        await session.scalar(
            select(func.count())
            .select_from(Borehole)
            .where(Borehole.plotted.is_(False), *_review_scope(include_unreviewed))
        )
        or 0
    )
    band = func.ST_Transform(
        func.ST_Buffer(func.ST_Transform(line, frame.epsg), buffer_m, "quad_segs=8"), 4326
    )
    buffer_polygon = json.loads(await session.scalar(select(func.ST_AsGeoJSON(band, 7))) or "null")
    result_set = await _store_result_set(session, hits, buffer_polygon, include_unreviewed, excluded)
    return AlignmentResult(
        alignment_id=alignment.id,
        buffer_m=buffer_m,
        include_unreviewed=include_unreviewed,
        length_m=round(frame.length_m, 1),
        metric_crs=f"EPSG:{frame.epsg}",
        buffer_polygon=buffer_polygon,
        hits=hits,
        excluded_unreviewed=int(excluded),
        not_on_map=int(not_on_map),
        result_set=result_set_out(result_set),
    )


def _polygon_bbox(geometry: dict[str, Any]) -> list[float]:
    polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    points = [p for polygon in polygons for ring in polygon for p in ring]
    return [
        min(p[0] for p in points),
        min(p[1] for p in points),
        max(p[0] for p in points),
        max(p[1] for p in points),
    ]


async def _store_result_set(
    session: AsyncSession,
    hits: list[AlignmentHit],
    buffer_polygon: dict[str, Any],
    include_unreviewed: bool,
    excluded: int,
) -> ResultSet:
    """The hits as a result set (chainage order), so the map highlight and chat treat them as a selection."""
    area = (
        AreaPolygon(type="polygon", polygon=buffer_polygon) if buffer_polygon["type"] == "Polygon" else None
    )
    if hits:
        lons = [h.position[0] for h in hits]
        lats = [h.position[1] for h in hits]
        bbox = [min(lons), min(lats), max(lons), max(lats)]
    else:
        bbox = _polygon_bbox(buffer_polygon)
    definition = BoreholeFilter(include_unreviewed=include_unreviewed, area=area)
    rs = ResultSet(
        id=new_id("rs"),
        definition=definition.model_dump(mode="json"),
        uids=[h.uid for h in hits],
        count=len(hits),
        located_count=len(hits),
        unlocated_count=0,
        excluded_unreviewed=excluded,
        bbox=bbox,
        area=area.model_dump(mode="json") if area is not None else None,
    )
    session.add(rs)
    await session.flush()
    await session.refresh(rs)
    return rs
