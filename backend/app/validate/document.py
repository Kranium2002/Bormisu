"""Lint across the boreholes of one document (BACKEND.md 7.9). Pure: no database.

`document_lint(members)` returns, per borehole uid, the findings that depend on the other boreholes of its
document:

* `coordinates_far_from_cluster` (error, unplots): a WGS84 position far from the document's robust centre
  (median latitude and longitude) and from every other position. The distance threshold scales with the
  document's own spread and never falls below a floor; both live in data/lint_rules.yaml. A position a
  person placed is never flagged.
* `coordinates_shared` (warning): identical printed coordinates on boreholes with different labels.
* `duplicate_borehole` (warning): a person confirmed that the borehole repeats one of an earlier document.

Thresholds are data (lint_rules.yaml, document_checks.yaml); nothing depends on a particular document.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from statistics import median
from typing import Any

import yaml

from app.config import get_settings
from app.validate.rules import lint_item, rule_config

EARTH_RADIUS_KM = 6371.0088
FAR = "coordinates_far_from_cluster"
SHARED = "coordinates_shared"
DUPLICATE = "duplicate_borehole"
DOCUMENT_RULES = frozenset({FAR, SHARED, DUPLICATE})


@lru_cache
def document_checks() -> dict[str, Any]:
    """data/document_checks.yaml (thresholds of the document-level checks and questions)."""
    path = get_settings().data_dir / "document_checks.yaml"
    with path.open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle)
    return data


def section(name: str) -> dict[str, Any]:
    value = document_checks().get(name) or {}
    if not isinstance(value, dict):
        raise ValueError(f"document_checks.yaml: {name} must be a mapping")
    return value


@dataclass(frozen=True)
class Member:
    """What the document-level rules need to know about one borehole."""

    uid: str
    label: str  # as printed
    label_canonical: str
    latitude: float | None = None
    longitude: float | None = None
    local_x: float | None = None  # in the printed system
    local_y: float | None = None
    # Path the position findings point at: the printed first coordinate when there is one.
    position_path: str = "metadata.coordinates.latitude"
    person_placed: bool = False
    # (label, file name) of the borehole this one repeats, when a person confirmed it.
    duplicate_of: tuple[str, str] | None = None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def _located(member: Member) -> tuple[float, float] | None:
    lat, lon = member.latitude, member.longitude
    if lat is None or lon is None or not (math.isfinite(lat) and math.isfinite(lon)):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return None  # linted on its own record (coordinates_out_of_range / coordinates_zero)
    return lat, lon


def _km(value: float) -> str:
    return f"{value:.1f}" if value < 100 else f"{value:.0f}"


def _wrap(lon: float) -> float:
    return (lon + 180.0) % 360.0 - 180.0


def robust_centre(points: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Median latitude and median longitude, the longitudes unwrapped around the first point so a site on
    the antimeridian keeps its centre there. A few wild points do not move it."""
    reference = points[0][1]
    lat = median(p[0] for p in points)
    lon = median(reference + _wrap(p[1] - reference) for p in points)
    return lat, _wrap(lon)


def cluster_outliers(members: Sequence[Member]) -> dict[str, tuple[float, float]]:
    """uid -> (distance to the centre in km, typical spread in km) for every implausible position.

    The spread is the median distance of the positions to their robust centre. A position is an outlier
    when it lies farther than the threshold from the centre and from every other position. Runs in
    O(n log n) plus O(n) per candidate, so it is cheap enough to repeat on every change.
    """
    cfg = rule_config(FAR)
    located = [(m, point) for m in members if (point := _located(m)) is not None]
    if len(located) < int(cfg["min_points"]):
        return {}
    centre = robust_centre([point for _, point in located])
    to_centre = [haversine_km(*centre, *point) for _, point in located]
    spread = median(to_centre)
    threshold = max(float(cfg["min_distance_km"]), float(cfg["median_factor"]) * spread)
    flagged: dict[str, tuple[float, float]] = {}
    for i, (member, (lat, lon)) in enumerate(located):
        if member.person_placed or to_centre[i] <= threshold:
            continue
        nearest = min(haversine_km(lat, lon, *other) for j, (_, other) in enumerate(located) if j != i)
        if nearest > threshold:
            flagged[member.uid] = (to_centre[i], spread)
    if len(flagged) > float(cfg["max_outlier_share"]) * len(located):
        return {}  # no clear cluster: several far-apart groups, nothing to call an outlier
    return flagged


def shared_coordinates(members: Sequence[Member]) -> dict[str, list[str]]:
    """uid -> labels of the other boreholes (different canonical label) printed at the same position."""
    decimals = int(rule_config(SHARED)["decimals"])
    by_point: dict[tuple[float, float], list[Member]] = defaultdict(list)
    for member in members:
        x, y = member.local_x, member.local_y
        if x is None or y is None or not (math.isfinite(x) and math.isfinite(y)):
            continue
        by_point[(round(x, decimals), round(y, decimals))].append(member)
    shared: dict[str, list[str]] = {}
    for group in by_point.values():
        for member in group:
            others = [m.label for m in group if m.label_canonical != member.label_canonical]
            if others:
                shared[member.uid] = list(dict.fromkeys(others))
    return shared


def document_lint(members: Sequence[Member]) -> dict[str, list[dict[str, Any]]]:
    """Contract `Lint` objects per uid (every member has an entry, possibly empty), in a stable order."""
    out: dict[str, list[dict[str, Any]]] = {m.uid: [] for m in members}
    by_uid = {m.uid: m for m in members}
    for uid, (distance, spread) in cluster_outliers(members).items():
        params = {"distance": _km(distance), "spread": _km(spread)}
        out[uid].append(lint_item(by_uid[uid].position_path, FAR, params))
    for uid, others in shared_coordinates(members).items():
        out[uid].append(lint_item(by_uid[uid].position_path, SHARED, {"others": ", ".join(others)}))
    for member in members:
        if member.duplicate_of is not None:
            label, file_name = member.duplicate_of
            out[member.uid].append(
                lint_item("metadata.borehole_id", DUPLICATE, {"label": label, "file": file_name})
            )
    return out
