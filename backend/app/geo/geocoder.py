"""Place search: places from uploaded documents first, then Nominatim through this server.

Nominatim usage policy: at most 1 request per second, an identifying User-Agent, results cached, no
typeahead (the UI calls on submit). Only the typed query leaves the server.
"""

from __future__ import annotations

import asyncio
import time
import unicodedata
from typing import Any

import httpx
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import Borehole, Document, GeocodeCache
from app.errors import ApiError
from app.schemas.map import PlaceCandidate

_lock = asyncio.Lock()
_last_call = 0.0
MIN_INTERVAL_S = 1.0
TIMEOUT_S = 8.0


def normalise_query(query: str) -> str:
    text = unicodedata.normalize("NFKC", query).strip().lower()
    return " ".join(text.split())


async def uploaded_places(session: AsyncSession, query: str, limit: int) -> list[PlaceCandidate]:
    """Projects, locations and borehole labels of uploaded boreholes that match the query."""
    q = query.strip()
    if not q:
        return []
    pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    candidates: list[PlaceCandidate] = []
    groupings = (
        ("project_site", func.coalesce(Borehole.project_name, Document.project)),
        ("location", Borehole.location_name),
    )
    for kind, column in groupings:
        rows = (
            await session.execute(
                select(
                    column.label("name"),
                    func.count(Borehole.uid),
                    func.ST_XMin(func.ST_Extent(Borehole.geom)),
                    func.ST_YMin(func.ST_Extent(Borehole.geom)),
                    func.ST_XMax(func.ST_Extent(Borehole.geom)),
                    func.ST_YMax(func.ST_Extent(Borehole.geom)),
                )
                .join(Document, Document.id == Borehole.document_id)
                .where(Borehole.plotted.is_(True), column.ilike(pattern, escape="\\"))
                .group_by(column)
                .order_by(func.count(Borehole.uid).desc())
                .limit(limit)
            )
        ).all()
        for name, count, xmin, ymin, xmax, ymax in rows:
            if name is None or xmin is None:
                continue
            candidates.append(
                PlaceCandidate(
                    label=str(name),
                    lat=(float(ymin) + float(ymax)) / 2,
                    lon=(float(xmin) + float(xmax)) / 2,
                    bbox=[float(xmin), float(ymin), float(xmax), float(ymax)],
                    source="uploaded",
                    kind=kind,
                    borehole_count=int(count),
                )
            )
    label_rows = (
        await session.execute(
            select(Borehole.label_raw, func.ST_X(Borehole.geom), func.ST_Y(Borehole.geom))
            .where(
                Borehole.plotted.is_(True),
                or_(
                    Borehole.label_raw.ilike(pattern, escape="\\"),
                    Borehole.label_canonical.ilike(pattern, escape="\\"),
                ),
            )
            .order_by(Borehole.label_canonical)
            .limit(limit)
        )
    ).all()
    for label, lon, lat in label_rows:
        candidates.append(
            PlaceCandidate(
                label=str(label),
                lat=float(lat),
                lon=float(lon),
                bbox=None,
                source="uploaded",
                kind="borehole",
                borehole_count=1,
            )
        )
    return candidates[:limit]


def _parse_nominatim(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for item in items:
        try:
            lat, lon = float(item["lat"]), float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        bbox = None
        raw = item.get("boundingbox")
        if isinstance(raw, list) and len(raw) == 4:
            try:
                south, north, west, east = (float(v) for v in raw)
                bbox = [west, south, east, north]
            except (TypeError, ValueError):
                bbox = None
        out.append(
            {
                "label": str(item.get("display_name") or "")[:300] or f"{lat:.4f}, {lon:.4f}",
                "lat": lat,
                "lon": lon,
                "bbox": bbox,
                "source": "geocoder",
                "kind": item.get("addresstype") or item.get("type"),
                "borehole_count": None,
            }
        )
    return out


async def _count_inside(session: AsyncSession, bbox: list[float] | None) -> int | None:
    if bbox is None:
        return None
    west, south, east, north = bbox
    count = await session.scalar(
        select(func.count())
        .select_from(Borehole)
        .where(
            Borehole.plotted.is_(True),
            func.ST_Intersects(Borehole.geom, func.ST_MakeEnvelope(west, south, east, north, 4326)),
        )
    )
    return int(count or 0)


async def nominatim(session: AsyncSession, query: str, limit: int) -> list[dict[str, Any]]:
    settings = get_settings()
    key = f"{normalise_query(query)}|{limit}"
    cached = await session.get(GeocodeCache, key)
    if cached is not None:
        return list(cached.response)
    global _last_call
    async with _lock:
        wait = MIN_INTERVAL_S - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(
                timeout=TIMEOUT_S, headers={"User-Agent": settings.geocoder_user_agent}
            ) as client:
                response = await client.get(
                    f"{settings.nominatim_url.rstrip('/')}/search",
                    params={"q": query, "format": "jsonv2", "limit": limit, "addressdetails": 0},
                )
        except httpx.HTTPError as exc:
            raise ApiError(503, "geocoder_unavailable", "The place search service is not reachable.") from exc
        finally:
            _last_call = time.monotonic()
    if response.status_code == 429:
        raise ApiError(503, "geocoder_unavailable", "The place search service is busy. Try again shortly.")
    if response.status_code != 200:
        raise ApiError(503, "geocoder_unavailable", "The place search service did not answer.")
    try:
        items = response.json()
    except ValueError as exc:
        raise ApiError(
            503, "geocoder_unavailable", "The place search service sent an unreadable answer."
        ) from exc
    parsed = _parse_nominatim(items if isinstance(items, list) else [])
    session.add(GeocodeCache(query_norm=key, response=parsed))
    await session.flush()
    return parsed


async def geocode(session: AsyncSession, query: str, limit: int) -> list[PlaceCandidate]:
    results = await uploaded_places(session, query, limit)
    if len(results) < limit and get_settings().geocoder_configured:
        for item in await nominatim(session, query, limit - len(results)):
            item = dict(item)
            item["borehole_count"] = await _count_inside(session, item.get("bbox"))
            results.append(PlaceCandidate.model_validate(item))
    return results[:limit]
