"""Coordinate-system names and ranked candidates for printed coordinates without a stated system.

Candidates are the entries of data/crs_registry.yaml (plus, when a reference place is known, the WGS 84
UTM zone of that place), each tried in both axis orders. The evidence that separates them is generic: the
EPSG area of use, the distance of the transformed centroid to a reference place geocoded from the
boreholes' own location text, the compactness of the points and how specific the system is for their
spread. Candidates the evidence cannot separate (same verdict and score, e.g. the two axis orders of
degrees without a reference place) put the reading whose points are on or near land first (app.geo.land).
Every threshold lives in the registry's `ranking` section. Nothing here knows about particular
documents, projects, countries or layouts.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import sys
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import yaml
from pyproj import CRS
from pyproj.exceptions import CRSError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import Borehole, Document, Page
from app.db.session import get_sessionmaker
from app.errors import ApiError
from app.geo.geocoder import nominatim, normalise_query, uploaded_places
from app.geo.land import near_land
from app.geo.plotting import to_wgs84
from app.schemas.documents import CrsCandidate, CrsPoint

logger = logging.getLogger("geomemory.crs")

EARTH_RADIUS_KM = 6371.0088
GLOBE_KM2 = 4 * math.pi * EARTH_RADIUS_KM**2
VERDICT_ORDER = {"match": 0, "shifted": 1, "out_of_range": 2}


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


@lru_cache(maxsize=512)
def crs_label(code: str | None) -> str | None:
    """Human-readable name of a coordinate system: the registry label, else pyproj's CRS name."""
    if not code or not code.strip():
        return None
    key = _norm(code)
    for entry in registry():
        if _norm(entry.code) == key:
            return entry.label
    try:
        name = CRS.from_user_input(code.strip()).name
    except CRSError:
        return None
    return str(name) if name else None


# ----------------------------------------------------------------------------------------------
# Configuration (data/crs_registry.yaml, section `ranking`)
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RankingConfig:
    shift_margin_deg: float
    match_km: float
    weight_area: float
    weight_reference: float
    weight_compactness: float
    reference_scale_km: float
    compact_km: float
    min_spread_km: float
    max_extent_ratio: float
    extent_exponent: float
    extent_floor: float
    worldwide_share: float
    worldwide_factor: float
    bands: dict[str, tuple[float, float]]
    max_candidates: int
    dropped_codes_listed: int
    utm_from_reference: bool
    geocode_max_external: int
    geocode_budget_s: float
    land_margin_km: float
    land_sample: int


@lru_cache
def ranking_config() -> RankingConfig:
    """The ranking thresholds. Every key is required: thresholds live in data, not in code."""
    r = _registry_data()["ranking"]
    weights, extent, worldwide, geocode, land = (
        r["weights"],
        r["extent"],
        r["worldwide"],
        r["geocode"],
        r["land"],
    )
    bands = {
        verdict: (float(r["bands"][verdict][0]), float(r["bands"][verdict][1])) for verdict in VERDICT_ORDER
    }
    return RankingConfig(
        shift_margin_deg=float(r["shift_margin_deg"]),
        match_km=float(r["match_km"]),
        weight_area=float(weights["area"]),
        weight_reference=float(weights["reference"]),
        weight_compactness=float(weights["compactness"]),
        reference_scale_km=float(r["reference_scale_km"]),
        compact_km=float(r["compact_km"]),
        min_spread_km=float(extent["min_spread_km"]),
        max_extent_ratio=float(extent["max_ratio"]),
        extent_exponent=float(extent["exponent"]),
        extent_floor=float(extent["floor"]),
        worldwide_share=float(worldwide["share"]),
        worldwide_factor=float(worldwide["factor"]),
        bands=bands,
        max_candidates=int(r["max_candidates"]),
        dropped_codes_listed=int(r["dropped_codes_listed"]),
        utm_from_reference=bool(r["utm_from_reference"]),
        geocode_max_external=int(geocode["max_external_queries"]),
        geocode_budget_s=float(geocode["budget_s"]),
        land_margin_km=float(land["margin_km"]),
        land_sample=int(land["sample"]),
    )


# ----------------------------------------------------------------------------------------------
# Geometry
# ----------------------------------------------------------------------------------------------


@lru_cache(maxsize=512)
def area_of_use(code: str) -> tuple[float, float, float, float] | None:
    """(west, south, east, north) in degrees from the EPSG database, or None."""
    try:
        area = CRS.from_user_input(code).area_of_use
    except CRSError:
        return None
    return None if area is None else (area.west, area.south, area.east, area.north)


@lru_cache(maxsize=512)
def area_of_use_km2(code: str) -> float | None:
    """Surface of the area-of-use box on the sphere."""
    bounds = area_of_use(code)
    if bounds is None:
        return None
    west, south, east, north = bounds
    width = east - west if west <= east else 360.0 - west + east
    band = abs(math.sin(math.radians(north)) - math.sin(math.radians(south)))
    return EARTH_RADIUS_KM**2 * math.radians(width) * band


def _inside(lon: float, lat: float, bounds: tuple[float, float, float, float], margin: float = 0.0) -> bool:
    west, south, east, north = bounds
    if west <= east:
        lon_ok = west - margin <= lon <= east + margin
    else:  # area crosses the antimeridian
        lon_ok = lon >= west - margin or lon <= east + margin
    return lon_ok and south - margin <= lat <= north + margin


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def centroid(points: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Mean position of (lat, lon) points on the sphere (safe across the antimeridian)."""
    x = y = z = 0.0
    for lat, lon in points:
        p, lam = math.radians(lat), math.radians(lon)
        x += math.cos(p) * math.cos(lam)
        y += math.cos(p) * math.sin(lam)
        z += math.sin(p)
    lon = math.degrees(math.atan2(y, x))
    lat = math.degrees(math.atan2(z, math.hypot(x, y)))
    return lat, lon


def _spread_km(points: Sequence[tuple[float, float]], center: tuple[float, float]) -> float:
    """Diameter of the point cloud (twice the largest distance from its centroid)."""
    if len(points) < 2:
        return 0.0
    return 2 * max(haversine_km(lat, lon, center[0], center[1]) for lat, lon in points)


def _plausible_for_kind(kind: str, x: float, y: float) -> bool:
    if kind == "geographic":
        return abs(x) <= 180 and abs(y) <= 180
    return abs(x) > 180 or abs(y) > 180


# ----------------------------------------------------------------------------------------------
# Reference place
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Reference:
    """A place the points should be near, geocoded from the boreholes' own location text."""

    lat: float
    lon: float
    label: str
    source: str  # uploaded | geocoder
    bbox: tuple[float, float, float, float] | None = None  # west, south, east, north

    def distance_km(self, lat: float, lon: float) -> float:
        """Distance to the place; 0 inside its bounding box, else to the nearest box edge."""
        if self.bbox is None:
            return haversine_km(lat, lon, self.lat, self.lon)
        west, south, east, north = self.bbox
        if _inside(lon, lat, self.bbox):
            return 0.0
        clamped_lat = min(max(lat, south), north)
        if _inside(lon, clamped_lat, (west, -90.0, east, 90.0)):
            return haversine_km(lat, lon, clamped_lat, lon)
        return min(haversine_km(lat, lon, clamped_lat, edge) for edge in (west, east))


def _by_frequency(values: Iterable[str | None]) -> list[str]:
    counts = Counter(v.strip() for v in values if isinstance(v, str) and v.strip())
    return [value for value, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0].lower()))]


def reference_queries(
    locations: Iterable[str | None], projects: Iterable[str | None], countries: Iterable[str | None]
) -> list[str]:
    """Place queries from the most to the least specific: location (with country), project, country."""
    locs, projs, ctys = _by_frequency(locations), _by_frequency(projects), _by_frequency(countries)
    queries: list[str] = []
    for loc in locs:
        if ctys and normalise_query(ctys[0]) not in normalise_query(loc):
            queries.append(f"{loc}, {ctys[0]}")
        queries.append(loc)
    queries += projs + ctys
    seen: set[str] = set()
    unique = []
    for query in queries:
        key = normalise_query(query)
        if len(key) >= 2 and key not in seen:
            seen.add(key)
            unique.append(query)
    return unique


def _bbox(raw: Any) -> tuple[float, float, float, float] | None:
    if isinstance(raw, list | tuple) and len(raw) == 4 and all(isinstance(v, int | float) for v in raw):
        return (float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]))
    return None


async def find_reference(
    session: AsyncSession, queries: Sequence[str], cfg: RankingConfig
) -> Reference | None:
    """Uploaded places (exact name) first, then the cached, rate-limited geocoder proxy."""
    for query in queries:
        key = normalise_query(query)
        for place in await uploaded_places(session, query, 5):
            if place.kind != "borehole" and normalise_query(place.label) == key:
                return Reference(place.lat, place.lon, place.label, "uploaded", _bbox(place.bbox))
    if not get_settings().geocoder_configured:
        return None
    for query in queries[: cfg.geocode_max_external]:
        try:
            results = await nominatim(session, query, 1)
        except ApiError as exc:
            logger.info("geocoder unavailable (%s); ranking without a reference place", exc.code)
            return None
        if results:
            best = results[0]
            label = str(best.get("label") or query)[:120]
            return Reference(
                float(best["lat"]), float(best["lon"]), label, "geocoder", _bbox(best.get("bbox"))
            )
    return None


async def reference_for(queries: Sequence[str]) -> Reference | None:
    """Never raises: a geocoder outage, a timeout or a database error only means no reference place.

    Runs in its own session so a failure cannot disturb the caller's transaction; commits to keep the
    geocoder cache.
    """
    if not queries:
        return None
    cfg = ranking_config()
    try:
        async with asyncio.timeout(cfg.geocode_budget_s), get_sessionmaker()() as session:
            reference = await find_reference(session, queries, cfg)
            await session.commit()
            return reference
    except Exception:
        logger.warning("reference place lookup failed; ranking without it", exc_info=True)
        return None


# ----------------------------------------------------------------------------------------------
# Ranking
# ----------------------------------------------------------------------------------------------


def _utm_entry(reference: Reference) -> RegistryEntry:
    zone = min(int((reference.lon + 180.0) // 6) + 1, 60)
    code = f"EPSG:{(32600 if reference.lat >= 0 else 32700) + zone}"
    return RegistryEntry(code, "projected", crs_label(code) or code, ())


_UTM_ZONE = re.compile(r"(?i)\butm\b\D{0,12}?(\d{1,2})\s*([NS])?\b")


def offerable(candidate: CrsCandidate) -> bool:
    """A candidate worth offering in a question: not out of range, and not a world-wide projected system
    (Pseudo-Mercator places any pair of numbers somewhere; it is never a survey system)."""
    if candidate.verdict == "out_of_range":
        return False
    kinds = {entry.code: entry.kind for entry in registry()}
    area = area_of_use_km2(candidate.crs)
    worldwide = area is not None and area / GLOBE_KM2 >= ranking_config().worldwide_share
    return not (worldwide and kinds.get(candidate.crs, "projected") == "projected")


def printed_zone_systems(printed: Iterable[str | None]) -> list[RegistryEntry]:
    """WGS 84 north and south (and ETRS89 in Europe's zones) for a UTM zone printed without a datum or a
    hemisphere ("UTM Sone 32", "WGS 84 UTM Zone 32"): ranked like the registry, so area of use, the
    reference place and land decide between them."""
    codes: list[str] = []
    for text in printed:
        match = _UTM_ZONE.search(text or "")
        if match is None or not 1 <= int(match.group(1)) <= 60:
            continue
        zone, hemisphere = int(match.group(1)), (match.group(2) or "").upper()
        if hemisphere != "S":
            codes.append(f"EPSG:{32600 + zone}")
            if 28 <= zone <= 38:
                codes.append(f"EPSG:{25800 + zone}")
        if hemisphere != "N":
            codes.append(f"EPSG:{32700 + zone}")
    entries: list[RegistryEntry] = []
    for code in dict.fromkeys(codes):
        entries.append(RegistryEntry(code, "projected", crs_label(code) or code, ()))
    return entries


def _systems(
    reference: Reference | None, cfg: RankingConfig, extra: Sequence[RegistryEntry] = ()
) -> tuple[list[RegistryEntry], set[str]]:
    entries = registry()
    generated: set[str] = set()
    for entry in extra:
        if all(_norm(e.code) != _norm(entry.code) for e in entries):
            entries.append(entry)
    if reference is not None and cfg.utm_from_reference:
        utm = _utm_entry(reference)
        if all(_norm(e.code) != _norm(utm.code) for e in entries):
            entries.append(utm)
            generated.add(utm.code)
    return entries, generated


def _code_key(code: str) -> tuple[str, int, str]:
    authority, _, number = code.partition(":")
    return (authority.upper(), int(number) if number.isdigit() else sys.maxsize, code)


def _specificity(area_km2: float | None, spread_km: float, cfg: RankingConfig) -> tuple[float, str | None]:
    """Factor (0..1] for systems whose area of use is too large to say where the points are."""
    if area_km2 is None:
        return 1.0, None
    factor, note = 1.0, None
    if area_km2 / GLOBE_KM2 >= cfg.worldwide_share:
        factor *= cfg.worldwide_factor
        note = "world-wide system: its area of use says nothing about the location"
    ratio = math.sqrt(area_km2) / max(spread_km, cfg.min_spread_km)
    if ratio > cfg.max_extent_ratio:
        factor *= max(cfg.extent_floor, (cfg.max_extent_ratio / ratio) ** cfg.extent_exponent)
        note = note or "area of use is very large for the spread of the points"
    return factor, note


@dataclass(frozen=True)
class _Scored:
    candidate: CrsCandidate
    verdict: str
    score: float
    area_km2: float | None
    code: str
    swap: bool

    def sort_key(self, ashore: float = 1.0) -> tuple[int, float, float, float, tuple[str, int, str], bool]:
        """`ashore`: share of the points on or near land (only computed within a tie)."""
        area = self.area_km2 if self.area_km2 is not None else math.inf
        return (VERDICT_ORDER[self.verdict], -self.score, -ashore, area, _code_key(self.code), self.swap)


def _ashore(item: _Scored, cfg: RankingConfig) -> float:
    """Share of (a sample of) the candidate's points on land or within the margin of it."""
    points = item.candidate.points[: max(1, cfg.land_sample)]
    if not points:
        return 1.0
    hits = sum(1 for p in points if near_land(round(p.lat, 2), round(p.lon, 2), cfg.land_margin_km))
    return hits / len(points)


def _evaluate(
    entry: RegistryEntry,
    swap: bool,
    points: Sequence[tuple[str, float, float]],
    reference: Reference | None,
    cfg: RankingConfig,
    generated: bool,
) -> _Scored | None:
    transformed: list[tuple[str, float, float]] = []
    for uid, x, y in points:
        result = to_wgs84(entry.code, x, y, swap_axes=swap)
        if result is not None:
            transformed.append((uid, result[0], result[1]))
    if not transformed:
        return None
    total = len(points)
    bounds = area_of_use(entry.code)
    inside = sum(1 for _, lat, lon in transformed if bounds and _inside(lon, lat, bounds))
    near = sum(1 for _, lat, lon in transformed if bounds and _inside(lon, lat, bounds, cfg.shift_margin_deg))
    latlon = [(lat, lon) for _, lat, lon in transformed]
    center = centroid(latlon)
    spread = _spread_km(latlon, center)
    distance = reference.distance_km(*center) if reference is not None else None

    if inside == total and (distance is None or distance <= cfg.match_km):
        verdict = "match"
    elif near == total:
        verdict = "shifted"
    else:
        verdict = "out_of_range"

    compact = 1.0 if spread <= cfg.compact_km else cfg.compact_km / spread
    # Without a reference place its share of the evidence is missing, so no candidate scores full marks.
    proximity = math.exp(-distance / cfg.reference_scale_km) if distance is not None else 0.0
    weighted = (
        cfg.weight_area * inside / total + cfg.weight_compactness * compact + cfg.weight_reference * proximity
    )
    weight_sum = cfg.weight_area + cfg.weight_compactness + cfg.weight_reference
    area_km2 = area_of_use_km2(entry.code)
    size_factor, size_note = _specificity(area_km2, spread, cfg)
    evidence = weighted / weight_sum * (len(transformed) / total) * size_factor
    low, high = cfg.bands[verdict]
    score = round(low + (high - low) * min(max(evidence, 0.0), 1.0), 3)

    notes = [f"{inside} of {total} points inside the system's area of use"]
    if reference is not None and distance is not None:
        where = f"'{reference.label}' ({reference.source})"
        notes.append(
            f"centroid inside {where}" if distance == 0.0 else f"centroid {distance:.0f} km from {where}"
        )
    else:
        notes.append("no reference place found")
    if spread > cfg.compact_km:
        notes.append(f"points spread over {spread:.0f} km")
    if size_note:
        notes.append(size_note)
    if generated:
        notes.append("UTM zone of the reference place")
    if swap:
        notes.append("printed X read as northing")
    candidate = CrsCandidate(
        crs=entry.code,
        label=entry.label,
        score=score,
        verdict=verdict,
        note="; ".join(notes),
        swap_axes=swap,
        points=[CrsPoint(uid=uid, lat=round(lat, 6), lon=round(lon, 6)) for uid, lat, lon in transformed],
    )
    return _Scored(candidate, verdict, score, area_km2, entry.code, swap)


def _with_land_note(item: _Scored, ashore: float | None, cfg: RankingConfig) -> CrsCandidate:
    if ashore is None or ashore >= 1.0:
        return item.candidate
    far = "all points" if ashore == 0.0 else f"{1 - ashore:.0%} of the points"
    note = f"{far} more than {cfg.land_margin_km:.0f} km from land"
    candidate = item.candidate
    return candidate.model_copy(update={"note": f"{candidate.note}; {note}" if candidate.note else note})


def _cap(items: list[_Scored], limit: int) -> tuple[list[_Scored], list[_Scored]]:
    """Keep `limit` candidates; a tie of matches (same score) at the cut stays whole.

    Equally good matches are all shown so a person can choose; a cut through a tie of weaker candidates
    is named in the last kept candidate's note by the caller.
    """
    if len(items) <= limit:
        return items, []
    cut = max(limit, 1)
    last = items[cut - 1]
    if last.verdict == "match":
        while cut < len(items) and (items[cut].verdict, items[cut].score) == (last.verdict, last.score):
            cut += 1
    return items[:cut], items[cut:]


def rank_candidates(
    points: list[tuple[str, float, float]],
    *,
    reference: Reference | None = None,
    extra: Sequence[RegistryEntry] = (),
) -> list[CrsCandidate]:
    """`points` are (uid, local_x, local_y) as printed. Returns candidates best first.

    Order: verdict, score, then within a tie more points on or near land, smaller area of use, EPSG code,
    unswapped before swapped.
    """
    if not points:
        return []
    cfg = ranking_config()
    entries, generated = _systems(reference, cfg, extra)
    scored: list[_Scored] = []
    for entry in entries:
        if not all(_plausible_for_kind(entry.kind, x, y) for _, x, y in points):
            continue
        for swap in (False, True):
            item = _evaluate(entry, swap, points, reference, cfg, entry.code in generated)
            if item is not None:
                scored.append(item)
    tied_scores = Counter((item.verdict, item.score) for item in scored)
    ashore = {id(item): _ashore(item, cfg) for item in scored if tied_scores[(item.verdict, item.score)] > 1}
    printed = {e.code for e in extra}  # the zone the document prints: first among the matches
    scored.sort(
        key=lambda item: (
            item.verdict != "match" or item.code not in printed,
            *item.sort_key(ashore.get(id(item), 1.0)),
        )
    )
    kept, dropped = _cap(scored, cfg.max_candidates)
    out = [_with_land_note(item, ashore.get(id(item)), cfg) for item in kept]
    if dropped and out:
        last_kept = kept[-1]
        tied = sum(
            1 for item in dropped if (item.verdict, item.score) == (last_kept.verdict, last_kept.score)
        )
        codes = list(dict.fromkeys(item.code for item in dropped))
        listed = ", ".join(codes[: cfg.dropped_codes_listed])
        more = (
            f" and {len(codes) - cfg.dropped_codes_listed} more"
            if len(codes) > cfg.dropped_codes_listed
            else ""
        )
        ties = f" ({tied} with the same score as this one)" if tied else ""
        dropped_note = f"{len(dropped)} more candidates not listed{ties}: {listed}{more}"
        last = out[-1]
        out[-1] = last.model_copy(
            update={"note": f"{last.note}; {dropped_note}" if last.note else dropped_note}
        )
    return out


# ----------------------------------------------------------------------------------------------
# Boreholes -> candidates (used by the document and the clarification endpoints)
# ----------------------------------------------------------------------------------------------


def _language_countries() -> dict[str, str]:
    from app.normalize.numbers import load_data

    raw = (load_data("crs_patterns.yaml") or {}).get("language_countries") or {}
    return {str(k).lower(): str(v) for k, v in raw.items()}


async def language_country(session: AsyncSession, document_ids: Sequence[str]) -> str | None:
    """The country the documents' main page language points to (data/crs_patterns.yaml), if any."""
    languages = (
        await session.scalars(
            select(Page.language).where(Page.document_id.in_(list(document_ids)), Page.used.is_(True))
        )
    ).all()
    counted = Counter(str(code).lower().split("-")[0] for code in languages if code)
    if not counted:
        return None
    return _language_countries().get(counted.most_common(1)[0][0])


def local_points(boreholes: Iterable[Borehole]) -> list[tuple[str, float, float]]:
    """(uid, local_x, local_y) of every borehole with a printed coordinate pair, by uid."""
    points = []
    for bh in boreholes:
        coords = (bh.record.get("metadata") or {}).get("coordinates") or {}
        x, y = coords.get("local_x"), coords.get("local_y")
        if isinstance(x, int | float) and isinstance(y, int | float):
            points.append((bh.uid, float(x), float(y)))
    return sorted(points)


async def candidates_for_boreholes(
    session: AsyncSession, boreholes: Sequence[Borehole]
) -> list[CrsCandidate]:
    """Rank systems for the printed coordinates of `boreholes` (which may span several documents).

    The reference place comes from their location names, project names (and the upload's project label)
    and countries. Without one, or when the geocoder is down, ranking still works on the other evidence.
    """
    points = local_points(boreholes)
    if not points:
        return []
    doc_ids = sorted({bh.document_id for bh in boreholes})
    doc_projects = list(
        (await session.scalars(select(Document.project).where(Document.id.in_(doc_ids)))).all()
    )
    metas = [bh.record.get("metadata") or {} for bh in boreholes]
    countries = [m.get("country") for m in metas]
    if not any(isinstance(c, str) and c.strip() for c in countries):
        countries.append(await language_country(session, doc_ids))
    queries = reference_queries(
        (m.get("location_name") for m in metas),
        [*(m.get("project_name") for m in metas), *doc_projects],
        countries,
    )
    reference = await reference_for(queries)
    printed = [((m.get("coordinates") or {}).get("coordinate_system")) for m in metas]
    extra = printed_zone_systems(p if isinstance(p, str) else None for p in printed)
    return await asyncio.to_thread(rank_candidates, points, reference=reference, extra=extra)
