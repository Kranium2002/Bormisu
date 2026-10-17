"""Where a borehole goes on the map, and why not when it does not.

A borehole is plotted only with WGS84 coordinates from a stated or confirmed coordinate system. Nothing
is ever placed at a default position.

Every transformation of printed coordinates goes through `to_wgs84`, so a system whose printed easting
grows westward (`west_orientated` in data/crs_registry.yaml, e.g. Danish System 34, whose EPSG definition
is an east-orientated reconstruction) is read the same way when it is stated, ranked or confirmed.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache, lru_cache
from typing import Any

import yaml
from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError, ProjError

from app.config import get_settings

PLOTTABLE_CRS_STATUS = frozenset({"stated", "confirmed"})
WGS84 = "EPSG:4326"


class CrsInvalidError(ValueError):
    """The coordinate system code is unknown or cannot be transformed to WGS84."""


def _code_key(code: str) -> str:
    return "".join(ch for ch in code.lower() if ch.isalnum())


@lru_cache(maxsize=1)
def _west_orientated_codes() -> frozenset[str]:
    with (get_settings().data_dir / "crs_registry.yaml").open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle) or {}
    return frozenset(
        _code_key(str(entry["code"]))
        for entry in data.get("systems") or []
        if entry.get("west_orientated") is True
    )


def west_orientated(code: str) -> bool:
    """The system's printed easting grows westward (registry flag `west_orientated`)."""
    return _code_key(code) in _west_orientated_codes()


@cache  # one per registry system (a few hundred); building one takes ~30 ms
def _transformer(code: str) -> Transformer:
    try:
        source = CRS.from_user_input(code)
    except CRSError as exc:
        raise CrsInvalidError(code) from exc
    return Transformer.from_crs(source, CRS.from_epsg(4326), always_xy=True)


_warmed = False


def warm_transformers() -> None:
    """Build the transformer of every registry system once (ranking evaluates all of them), in the
    background at startup so the first coordinate-system question does not wait for it. Once per process."""
    global _warmed
    if _warmed:
        return
    _warmed = True
    with (get_settings().data_dir / "crs_registry.yaml").open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle) or {}
    for entry in data.get("systems") or []:
        try:
            _transformer(str(entry["code"]))
        except (CrsInvalidError, CRSError, ProjError, KeyError):
            continue


def validate_crs(code: str) -> str:
    """Return the normalised `EPSG:<n>` form or raise CrsInvalidError."""
    try:
        crs = CRS.from_user_input(code)
    except CRSError as exc:
        raise CrsInvalidError(code) from exc
    epsg = crs.to_epsg()
    if epsg is None:
        raise CrsInvalidError(code)
    return f"EPSG:{epsg}"


def is_geographic(code: str) -> bool:
    try:
        return bool(CRS.from_user_input(code).is_geographic)
    except CRSError:
        return False


def to_wgs84(code: str, x: float, y: float, *, swap_axes: bool = False) -> tuple[float, float] | None:
    """Transform a source point (easting/longitude first) to (lat, lon); None when it fails.

    `swap_axes` means the printed X is the northing (or latitude), so the pair is swapped first. The
    easting of a west-orientated system is then negated for its east-orientated EPSG definition.
    """
    easting, northing = (y, x) if swap_axes else (x, y)
    if west_orientated(code):
        easting = -easting
    try:
        lon, lat = _transformer(code).transform(easting, northing, errcheck=True)
    except (ProjError, CrsInvalidError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or lat != lat or lon != lon:
        return None
    return float(lat), float(lon)


@dataclass(frozen=True)
class Placement:
    plotted: bool
    unplotted_reason: str | None
    latitude: float | None
    longitude: float | None


def placement(
    coords: dict[str, Any], crs_status: str, *, implausible: bool = False, person_placed: bool = False
) -> Placement:
    """Plot only WGS84 from a stated or confirmed system, or a point a person placed; never (0, 0)."""
    lat, lon = coords.get("latitude"), coords.get("longitude")
    has_wgs84 = isinstance(lat, int | float) and isinstance(lon, int | float)
    has_any = has_wgs84 or any(coords.get(k) is not None for k in ("local_x", "local_y", "x_raw", "y_raw"))
    if not has_any:
        return Placement(False, "no_coordinates", None, None)
    if person_placed and has_wgs84:
        pass
    elif crs_status == "inferred":
        return Placement(False, "crs_unconfirmed", None, None)
    elif crs_status not in PLOTTABLE_CRS_STATUS or not has_wgs84:
        return Placement(False, "crs_unknown", None, None)
    assert isinstance(lat, int | float) and isinstance(lon, int | float)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or implausible or (lat == 0 and lon == 0):
        return Placement(False, "implausible", None, None)
    return Placement(True, None, float(lat), float(lon))
