"""Printed coordinate-system names -> EPSG codes (BACKEND.md 7.8).

1. An exact alias of data/crs_registry.yaml (app.geo.crs_candidates.match_alias) states the system.
2. Otherwise the generic patterns of data/crs_patterns.yaml: a printed EPSG code; a named system found
   anywhere in the text ("NZTM2000 (NZGD2000)", "System 34 Sjælland"); a datum + grid + zone
   (+ hemisphere or latitude band), turned into the EPSG name ("ETRS89 / UTM zone 32N",
   "GDA2020 / MGA zone 55") and looked up in pyproj's EPSG database; a datum alone for degree values.
3. Anything else, a local grid, or an ambiguous name (a UTM zone without datum or hemisphere, two
   datums, two named systems, "System 34" without its region) gives code None with a reason. Nothing is
   guessed from the coordinates' location: ranking candidates is app.geo.crs_candidates' job.

The printed coordinates (`coords`) only check the result: a geographic system for grid values (or the
reverse) is rejected, a Gauss-Krüger zone may come from the easting's millions digit, grid values printed
with a datum alone are read in that datum's national grid only when they land inside its area of use on
or near land, and a stated system whose area of use holds the points only with swapped axes is named in
`reason` (code kept).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from pyproj import CRS
from pyproj.database import query_crs_info
from pyproj.enums import PJType
from pyproj.exceptions import CRSError

from app.geo.crs_candidates import match_alias, ranking_config
from app.geo.land import near_land
from app.geo.plotting import to_wgs84
from app.normalize.api import CoordinateResult, CrsResult
from app.normalize.numbers import load_data, str_list


def _norm(text: str) -> str:
    folded = unicodedata.normalize("NFC", text).casefold()
    folded = re.sub(r"[-_/,;:()\[\]{}|]", " ", folded)
    return re.sub(r"\s+", " ", folded).strip()


def _term_regex(term: str, *, digits_after: bool = False) -> str:
    """A normalised term as a regex: flexible spaces, no letter before, no letter (and unless
    `digits_after`, no digit) after. Grid words take digits after them ("UTM32N", "GK3")."""
    body = r"\s*".join(re.escape(part) for part in _norm(term).split(" "))
    after = r"(?![^\W\d_])" if digits_after else r"(?![^\W_])"
    return rf"(?<![^\W\d_]){body}{after}"


@dataclass(frozen=True)
class _Datum:
    epsg_name: str
    pattern: re.Pattern[str]
    default_grid: str | None
    hemisphere: str | None
    national_grid: str | None  # EPSG name of the projection grid values printed with the datum alone use


@dataclass(frozen=True)
class _Named:
    epsg_name: str
    datum: str | None  # the datum the system is defined on
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class _Grid:
    id: str
    words: tuple[str, ...]
    template: str
    zones: tuple[int, int]
    needs_hemisphere: bool
    default_datum: str | None
    zone_from_easting_millions: bool
    implied_datums: dict[str, str]
    datum_templates: dict[str, str]


@dataclass(frozen=True)
class _Patterns:
    datums: tuple[_Datum, ...]
    named: tuple[_Named, ...]
    grids: tuple[_Grid, ...]
    grid_words: tuple[tuple[re.Pattern[str], _Grid], ...]  # longest first
    implied: tuple[tuple[re.Pattern[str], _Grid, str], ...]  # grid words that name a datum
    zone_words: str
    north_words: frozenset[str]
    south_words: frozenset[str]
    bands_north: str
    bands_south: str
    north_phrases: tuple[re.Pattern[str], ...]
    south_phrases: tuple[re.Pattern[str], ...]
    epsg_pattern: re.Pattern[str]
    local_patterns: tuple[re.Pattern[str], ...]
    geographic_patterns: tuple[re.Pattern[str], ...]


def _compile_terms(terms: list[str]) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(_term_regex(t)) for t in sorted(terms, key=len, reverse=True) if t.strip())


def _alternation(terms: list[str]) -> re.Pattern[str]:
    """One regex for any of the terms, longest first; matches nothing for an empty list."""
    return re.compile(
        "|".join(_term_regex(t) for t in sorted(terms, key=len, reverse=True) if t.strip()) or r"(?!)"
    )


@lru_cache(maxsize=1)
def _patterns() -> _Patterns:
    data: dict[str, Any] = load_data("crs_patterns.yaml")
    datums = tuple(
        _Datum(
            epsg_name=str(d["epsg_name"]),
            pattern=_alternation(str_list(d.get("aliases"))),
            default_grid=d.get("default_grid"),
            hemisphere=d.get("hemisphere"),
            national_grid=d.get("national_grid"),
        )
        for d in data.get("datums") or []
    )
    named = tuple(
        _Named(
            epsg_name=str(n["epsg_name"]),
            datum=n.get("datum"),
            pattern=_alternation(str_list(n.get("terms"))),
        )
        for n in data.get("named_systems") or []
    )
    grids: list[_Grid] = []
    for g in data.get("grids") or []:
        zones = g.get("zones") or [1, 60]
        grids.append(
            _Grid(
                id=str(g["id"]),
                words=tuple(str_list(g.get("words"))),
                template=str(g["template"]),
                zones=(int(zones[0]), int(zones[1])),
                needs_hemisphere=bool(g.get("needs_hemisphere", "{hemisphere}" in str(g["template"]))),
                default_datum=g.get("default_datum"),
                zone_from_easting_millions=bool(g.get("zone_from_easting_millions", False)),
                implied_datums={str(k): str(v) for k, v in (g.get("implied_datums") or {}).items()},
                datum_templates={str(k): str(v) for k, v in (g.get("datum_templates") or {}).items()},
            )
        )
    grid_words = sorted(
        ((re.compile(_term_regex(w, digits_after=True)), g, len(w)) for g in grids for w in g.words),
        key=lambda item: -item[2],
    )
    implied = sorted(
        ((re.compile(_term_regex(w)), g, d, len(w)) for g in grids for w, d in g.implied_datums.items()),
        key=lambda item: -item[3],
    )
    hemi = data.get("hemisphere_words") or {}
    bands = data.get("latitude_bands") or {}
    phrases = data.get("hemisphere_phrases") or {}
    epsg_words = "|".join(
        _term_regex(w) for w in sorted(str_list(data.get("epsg_words")), key=len, reverse=True)
    )
    return _Patterns(
        datums=datums,
        named=named,
        grids=tuple(grids),
        grid_words=tuple((p, g) for p, g, _ in grid_words),
        implied=tuple((p, g, d) for p, g, d, _ in implied),
        zone_words="|".join(
            re.escape(_norm(w)) for w in sorted(str_list(data.get("zone_words")), key=len, reverse=True)
        )
        or r"(?!)",
        north_words=frozenset(_norm(w) for w in str_list(hemi.get("north"))),
        south_words=frozenset(_norm(w) for w in str_list(hemi.get("south"))),
        bands_north=str(bands.get("north", "")).casefold(),
        bands_south=str(bands.get("south", "")).casefold(),
        north_phrases=_compile_terms(str_list(phrases.get("north"))),
        south_phrases=_compile_terms(str_list(phrases.get("south"))),
        epsg_pattern=re.compile(rf"(?:{epsg_words or '(?!)'})\s*(?:=|#)?\s*([0-9]{{4,6}})(?![0-9])"),
        local_patterns=_compile_terms(str_list(data.get("local_grid_terms"))),
        geographic_patterns=_compile_terms(str_list(data.get("geographic_terms"))),
    )


@lru_cache(maxsize=1)
def _epsg_names() -> dict[str, dict[str, frozenset[str]]]:
    """EPSG CRS names -> codes, per kind ("projected", "geographic"), from pyproj's database."""
    result: dict[str, dict[str, set[str]]] = {"projected": {}, "geographic": {}}
    for kind, pj_type in (("projected", PJType.PROJECTED_CRS), ("geographic", PJType.GEOGRAPHIC_2D_CRS)):
        for info in query_crs_info(auth_name="EPSG", pj_types=[pj_type], allow_deprecated=False):
            result[kind].setdefault(info.name.casefold(), set()).add(info.code)
    return {kind: {name: frozenset(codes) for name, codes in names.items()} for kind, names in result.items()}


def _code_for(name: str, kind: str) -> tuple[str | None, str | None]:
    codes = _epsg_names()[kind].get(name.casefold())
    if not codes:
        return None, f"no EPSG system is named '{name}'"
    if len(codes) > 1:
        return None, f"several EPSG systems are named '{name}'"
    return f"EPSG:{next(iter(codes))}", None


def _crs_info(code: str) -> tuple[str | None, bool | None, tuple[float, float, float, float] | None]:
    try:
        crs = CRS.from_user_input(code)
    except CRSError:
        return None, None, None
    area = crs.area_of_use
    bounds = None if area is None else (area.west, area.south, area.east, area.north)
    return crs.name, bool(crs.is_geographic), bounds


def _inside(lat: float, lon: float, bounds: tuple[float, float, float, float]) -> bool:
    west, south, east, north = bounds
    lon_ok = west <= lon <= east if west <= east else (lon >= west or lon <= east)
    return lon_ok and south <= lat <= north


# -------------------------------------------------------------------------------------------------
# Reading the printed name
# -------------------------------------------------------------------------------------------------


@dataclass
class _Reading:
    datums: list[str]
    grid: _Grid | None = None
    zone: int | None = None
    hemisphere: str | None = None  # "N" / "S"
    hemisphere_source: str | None = None


def _hemisphere_of(token: str | None) -> str | None:
    if not token:
        return None
    p = _patterns()
    key = _norm(token)
    if key in p.north_words:
        return "N"
    if key in p.south_words:
        return "S"
    if len(key) == 1:
        if key in p.bands_south:
            return "S"
        if key in p.bands_north:
            return "N"
    return None


def _read(text: str) -> _Reading:
    p = _patterns()
    reading = _Reading(datums=[])
    for pattern, implied_grid, implied_datum in p.implied:
        match = pattern.search(text)
        if match:
            reading.grid = implied_grid
            reading.datums.append(implied_datum)
            text = (
                text[: match.start()]
                + f" {_norm(implied_grid.words[0]) if implied_grid.words else implied_grid.id} "
                + text[match.end() :]
            )
            break
    for datum in p.datums:
        match = datum.pattern.search(text)
        if match:
            if datum.epsg_name not in reading.datums:
                reading.datums.append(datum.epsg_name)
            text = datum.pattern.sub(" ", text)
    grid_end = None
    if reading.grid is None:
        for pattern, grid in p.grid_words:
            match = pattern.search(text)
            if match:
                reading.grid, grid_end = grid, match.end()
                break
    else:
        for pattern, grid in p.grid_words:
            if grid is reading.grid and (match := pattern.search(text)):
                grid_end = match.end()
                break

    zone_regexes: list[str] = []
    if grid_end is not None:
        zone_regexes.append(
            rf"\G\s*(?:(?:{p.zone_words})\s*)?[#.]?\s*([0-9]{{1,2}})(?:\s*([^\W\d_]+))?(?![^\W_])"
        )
    zone_regexes.append(
        rf"(?<![^\W\d_])(?:{p.zone_words})\s*[#.]?\s*([0-9]{{1,2}})(?:\s*([^\W\d_]+))?(?![^\W_])"
    )
    zone_regexes.append(rf"(?<![^\W_])([0-9]{{1,2}})\s*\.?\s*(?:{p.zone_words})(?![^\W_])()")
    if reading.grid is not None:
        zone_regexes.append(r"(?<![^\W_])([0-9]{1,2})\s?([c-hj-np-x])(?![^\W_])")
    for regex in zone_regexes:
        if regex.startswith(r"\G"):
            match = re.compile(regex[2:]).match(text, grid_end or 0)
        else:
            match = re.search(regex, text)
        if match:
            reading.zone = int(match.group(1))
            hemisphere = _hemisphere_of(match.group(2)) if match.lastindex and match.lastindex >= 2 else None
            if hemisphere:
                reading.hemisphere, reading.hemisphere_source = hemisphere, match.group(2)
            break
    if reading.hemisphere is None:
        if any(ph.search(text) for ph in p.north_phrases):
            reading.hemisphere, reading.hemisphere_source = "N", "phrase"
        elif any(ph.search(text) for ph in p.south_phrases):
            reading.hemisphere, reading.hemisphere_source = "S", "phrase"
    return reading


def _datum_spec(name: str) -> _Datum | None:
    return next((d for d in _patterns().datums if d.epsg_name == name), None)


def _named_system(named: list[_Named], text: str, printed: str) -> CrsResult:
    """The one system the text names, unless it names two or a datum the system is not defined on."""
    names = list(dict.fromkeys(n.epsg_name for n in named))
    if len(names) > 1:
        return CrsResult(None, reason=f"'{printed}' names more than one system ({', '.join(names)})")
    system = named[0]
    rest = system.pattern.sub(" ", text)
    others = [
        d.epsg_name for d in _patterns().datums if d.pattern.search(rest) and d.epsg_name != system.datum
    ]
    if others:
        return CrsResult(
            None,
            reason=f"'{printed}' names {system.epsg_name} and the datum {', '.join(others)}, which disagree",
        )
    code, why = _code_for(system.epsg_name, "projected")
    return CrsResult(code, label=system.epsg_name if code else None, reason=why)


def _national_grid(datum: _Datum, coords: CoordinateResult) -> CrsResult | None:
    """The datum's national grid for grid values printed with the datum alone, when the values land inside
    its area of use (as printed or swapped) on or near land; None otherwise."""
    if datum.national_grid is None or coords.local_x is None or coords.local_y is None:
        return None
    code, _ = _code_for(datum.national_grid, "projected")
    bounds = _crs_info(code)[2] if code is not None else None
    if code is None or bounds is None:
        return None
    margin = ranking_config().land_margin_km
    for swap in (False, True):
        point = to_wgs84(code, coords.local_x, coords.local_y, swap_axes=swap)
        if (
            point is not None
            and _inside(point[0], point[1], bounds)
            and near_land(round(point[0], 2), round(point[1], 2), margin)
        ):
            return CrsResult(
                code,
                label=datum.national_grid,
                reason=f"grid values with the {datum.epsg_name} datum alone read in its national grid",
            )
    return None


def _from_patterns(system_raw: str, coords: CoordinateResult | None) -> CrsResult:
    p = _patterns()
    text = _norm(system_raw)
    printed = system_raw.strip()

    epsg = p.epsg_pattern.search(text)
    if epsg:
        printed_code = f"EPSG:{epsg.group(1)}"
        name, _, _ = _crs_info(printed_code)
        if name is None:
            return CrsResult(None, reason=f"printed code {printed_code} is not in the EPSG database")
        return CrsResult(printed_code, label=name)
    if any(pattern.search(text) for pattern in p.local_patterns):
        return CrsResult(None, reason=f"'{printed}' is a local grid without an EPSG transform")
    named = [system for system in p.named if system.pattern.search(text)]
    if named:
        return _named_system(named, text, printed)

    reading = _read(text)
    if len(reading.datums) > 1:
        return CrsResult(None, reason=f"'{printed}' names more than one datum ({', '.join(reading.datums)})")
    datum_name = reading.datums[0] if reading.datums else None
    datum = _datum_spec(datum_name) if datum_name else None
    grid = reading.grid
    if grid is None and datum is not None and reading.zone is not None and datum.default_grid:
        grid = next((g for g in p.grids if g.id == datum.default_grid), None)

    if grid is None:
        if datum is None:
            return CrsResult(None, reason=f"'{printed}' names no known coordinate system")
        geographic_words = any(pattern.search(text) for pattern in p.geographic_patterns)
        if coords is not None and coords.kind == "projected":
            national = _national_grid(datum, coords)
            if national is not None:
                return national
            return CrsResult(
                None, reason=f"'{printed}' names a datum but no projection or zone for grid values"
            )
        if geographic_words or (coords is not None and coords.kind == "geographic"):
            code, why = _code_for(datum.epsg_name, "geographic")
            return CrsResult(code, label=datum.epsg_name if code else None, reason=why)
        return CrsResult(None, reason=f"'{printed}' names a datum only; projection and zone are not stated")

    datum_name = datum_name or grid.default_datum
    if datum_name is None:
        return CrsResult(None, reason=f"'{printed}': a {grid.id.upper()} zone without a datum is ambiguous")
    datum = _datum_spec(datum_name)

    zone = reading.zone
    zone_note = None
    easting_zone = None
    if (
        grid.zone_from_easting_millions
        and coords is not None
        and coords.local_x is not None
        and 1_000_000 <= abs(coords.local_x) < 10_000_000
    ):
        easting_zone = int(abs(coords.local_x) // 1_000_000)
    if zone is None and easting_zone is not None:
        zone, zone_note = easting_zone, f"zone {easting_zone} from the easting's leading digit"
    elif zone is not None and easting_zone is not None and zone != easting_zone:
        zone_note = (
            f"the easting's leading digit suggests zone {easting_zone}, the printed zone {zone} is used"
        )
    if zone is None:
        return CrsResult(None, reason=f"'{printed}': the zone is not stated")
    if not grid.zones[0] <= zone <= grid.zones[1]:
        return CrsResult(None, reason=f"'{printed}': zone {zone} is outside {grid.zones[0]}-{grid.zones[1]}")

    hemisphere = reading.hemisphere
    datum_hemisphere = None if datum is None or datum.hemisphere is None else datum.hemisphere[:1].upper()
    if hemisphere and datum_hemisphere and hemisphere != datum_hemisphere:
        return CrsResult(None, reason=f"'{printed}': {datum_name} grids lie in the other hemisphere")
    hemisphere = hemisphere or datum_hemisphere
    if grid.needs_hemisphere and hemisphere is None:
        return CrsResult(None, reason=f"'{printed}': the hemisphere of zone {zone} is not stated")

    template = grid.datum_templates.get(datum_name, grid.template)
    name = template.format(datum=datum_name, zone=zone, hemisphere=hemisphere or "")
    code, why = _code_for(name, "projected")
    if code is None:
        return CrsResult(None, reason=why)
    return CrsResult(code, label=name, reason=zone_note)


def _check_against(result: CrsResult, coords: CoordinateResult | None) -> CrsResult:
    if result.code is None or coords is None or coords.kind is None:
        return result
    name, geographic, bounds = _crs_info(result.code)
    if geographic is None:
        return result
    if geographic and coords.kind == "projected":
        return CrsResult(
            None, reason=f"{result.label or result.code} is in degrees but the coordinates are grid values"
        )
    if not geographic and coords.kind == "geographic":
        return CrsResult(
            None, reason=f"{result.label or result.code} is a grid but the coordinates are degrees"
        )
    if bounds is None:
        return result
    notes = [result.reason] if result.reason else []
    if coords.kind == "geographic" and coords.latitude is not None and coords.longitude is not None:
        if not _inside(coords.latitude, coords.longitude, bounds):
            notes.append("the point lies outside the system's area of use")
    elif coords.kind == "projected" and coords.local_x is not None and coords.local_y is not None:
        straight = to_wgs84(result.code, coords.local_x, coords.local_y)
        swapped = to_wgs84(result.code, coords.local_x, coords.local_y, swap_axes=True)
        inside = straight is not None and _inside(straight[0], straight[1], bounds)
        inside_swapped = swapped is not None and _inside(swapped[0], swapped[1], bounds)
        if not inside and inside_swapped:
            notes.append("the point lies inside the system's area of use only with the axes swapped")
        elif not inside:
            notes.append("the point lies outside the system's area of use")
    return CrsResult(result.code, label=result.label or name, reason="; ".join(notes) or None)


def resolve_printed_system(system_raw: str | None, coords: CoordinateResult | None = None) -> CrsResult:
    """The EPSG code a printed system name states, or None with a reason when it states none."""
    if system_raw is None or not system_raw.strip():
        return CrsResult(None, reason="no coordinate system printed")
    if len(system_raw) > 300:
        return CrsResult(None, reason="system text too long to be a name")
    entry = match_alias(system_raw.strip())
    if entry is not None:
        return _check_against(CrsResult(entry.code, label=entry.label), coords)
    return _check_against(_from_patterns(system_raw, coords), coords)
