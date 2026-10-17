"""On or near land: a coarse plausibility check for coordinate readings (boreholes are on land or near the
coast). The outline is data/land_110m.json (Natural Earth 1:110m land, public domain); at that scale a coast
can be some kilometres off, so callers allow a margin. Used only to break ties between readings that the
other evidence cannot separate, never to drop one.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache

from app.config import get_settings

EARTH_RADIUS_KM = 6371.0088
PROBE_BEARINGS = tuple(range(0, 360, 45))

Ring = tuple[tuple[float, float, float, float], tuple[tuple[float, float], ...]]


@lru_cache
def _rings() -> tuple[Ring, ...]:
    with (get_settings().data_dir / "land_110m.json").open(encoding="utf-8") as handle:
        data = json.load(handle)
    rings = []
    for ring in data["rings"]:
        points = tuple((float(x), float(y)) for x, y in ring)
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        rings.append(((min(xs), min(ys), max(xs), max(ys)), points))
    return tuple(rings)


def _inside(points: tuple[tuple[float, float], ...], lon: float, lat: float) -> bool:
    inside = False
    j = len(points) - 1
    for i in range(len(points)):
        xi, yi = points[i]
        xj, yj = points[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def on_land(lat: float, lon: float) -> bool:
    for (west, south, east, north), points in _rings():
        if west <= lon <= east and south <= lat <= north and _inside(points, lon, lat):
            return True
    return False


def _destination(lat: float, lon: float, bearing_deg: float, distance_km: float) -> tuple[float, float]:
    p1, l1, b = math.radians(lat), math.radians(lon), math.radians(bearing_deg)
    d = distance_km / EARTH_RADIUS_KM
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


@lru_cache(maxsize=4096)
def near_land(lat: float, lon: float, margin_km: float) -> bool:
    """On land, or land within about `margin_km` (probed on a circle of that radius)."""
    if on_land(lat, lon):
        return True
    return margin_km > 0 and any(on_land(*_destination(lat, lon, b, margin_km)) for b in PROBE_BEARINGS)
