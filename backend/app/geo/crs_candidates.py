"""Rank coordinate-system candidates for printed coordinates without a stated system.

Every registry entry (data/crs_registry.yaml) is tried in both axis orders; the EPSG area of use decides
the verdict. Nothing here knows about particular documents or places.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import yaml
from pyproj import CRS
from pyproj.exceptions import CRSError

from app.config import get_settings
from app.geo.plotting import to_wgs84
from app.schemas.documents import CrsCandidate, CrsPoint


@dataclass(frozen=True)
class RegistryEntry:
    code: str
    kind: str
    label: str
    aliases: tuple[str, ...]


@lru_cache
def _registry_data() -> dict[str, Any]:
    with (get_settings().data_dir / "crs_registry.yaml").open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle)
    return data


def registry() -> list[RegistryEntry]:
    return [
        RegistryEntry(e["code"], e["kind"], e["label"], tuple(e.get("aliases", [])))
        for e in _registry_data()["systems"]
    ]


def _norm(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalnum())


def match_alias(printed: str | None) -> RegistryEntry | None:
    """The registry entry whose alias equals the printed system name (ignoring case, spaces, punctuation)."""
    if not printed:
        return None
    key = _norm(printed)
    for entry in registry():
        if _norm(entry.label) == key or any(_norm(a) == key for a in entry.aliases):
            return entry
    return None


@lru_cache(maxsize=256)
def _area_of_use(code: str) -> tuple[float, float, float, float] | None:
    try:
        area = CRS.from_user_input(code).area_of_use
    except CRSError:
        return None
    return None if area is None else (area.west, area.south, area.east, area.north)


def _inside(lon: float, lat: float, bounds: tuple[float, float, float, float], margin: float = 0.0) -> bool:
    west, south, east, north = bounds
    if west <= east:
        lon_ok = west - margin <= lon <= east + margin
    else:  # area crosses the antimeridian
        lon_ok = lon >= west - margin or lon <= east + margin
    return lon_ok and south - margin <= lat <= north + margin


def _spread_km(points: list[tuple[float, float]]) -> float:
    if len(points) < 2:
        return 0.0
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    mid = math.radians(sum(lats) / len(lats))
    dy = (max(lats) - min(lats)) * 111.2
    dx = (max(lons) - min(lons)) * 111.2 * max(math.cos(mid), 0.01)
    return math.hypot(dx, dy)


def _plausible_for_kind(kind: str, x: float, y: float) -> bool:
    if kind == "geographic":
        return abs(x) <= 180 and abs(y) <= 180
    return abs(x) > 180 or abs(y) > 180


def rank_candidates(points: list[tuple[str, float, float]]) -> list[CrsCandidate]:
    """`points` are (uid, local_x, local_y) as printed. Returns candidates best first."""
    if not points:
        return []
    ranking = _registry_data().get("ranking", {})
    margin = float(ranking.get("shift_margin_deg", 1.0))
    compact_km = float(ranking.get("compact_km", 50))
    limit = int(ranking.get("max_candidates", 8))
    scored: list[tuple[float, CrsCandidate]] = []
    for entry in registry():
        if not all(_plausible_for_kind(entry.kind, x, y) for _, x, y in points):
            continue
        bounds = _area_of_use(entry.code)
        for swap in (False, True):
            transformed: list[tuple[str, float, float]] = []
            for uid, x, y in points:
                result = to_wgs84(entry.code, x, y, swap_axes=swap)
                if result is not None:
                    transformed.append((uid, result[0], result[1]))
            if not transformed:
                continue
            inside = sum(1 for _, lat, lon in transformed if bounds and _inside(lon, lat, bounds))
            near = sum(1 for _, lat, lon in transformed if bounds and _inside(lon, lat, bounds, margin))
            share = inside / len(points)
            if inside == len(points):
                verdict = "match"
            elif near == len(points):
                verdict = "shifted"
            else:
                verdict = "out_of_range"
            spread = _spread_km([(lat, lon) for _, lat, lon in transformed])
            compactness = 1.0 if spread <= compact_km else compact_km / spread
            score = round(share * (0.7 + 0.3 * compactness) * (len(transformed) / len(points)), 3)
            if verdict == "out_of_range":
                score = round(min(score, 0.2) * 0.5, 3)
            note_parts = [f"{inside} of {len(points)} points inside the system's area of use"]
            if swap:
                note_parts.append("printed X read as northing")
            scored.append(
                (
                    score,
                    CrsCandidate(
                        crs=entry.code,
                        label=entry.label,
                        score=score,
                        verdict=verdict,
                        note="; ".join(note_parts),
                        swap_axes=swap,
                        points=[
                            CrsPoint(uid=uid, lat=round(lat, 6), lon=round(lon, 6))
                            for uid, lat, lon in transformed
                        ],
                    ),
                )
            )
    order = {"match": 0, "shifted": 1, "out_of_range": 2}
    scored.sort(
        key=lambda item: (order[item[1].verdict or "out_of_range"], -item[0], item[1].swap_axes or False)
    )
    return [candidate for _, candidate in scored[:limit]]
