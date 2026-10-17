"""Where a borehole goes on the map, and why not when it does not.

A borehole is plotted only with WGS84 coordinates from a stated or confirmed coordinate system. Nothing
is ever placed at a default position.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError, ProjError

PLOTTABLE_CRS_STATUS = frozenset({"stated", "confirmed"})
WGS84 = "EPSG:4326"


class CrsInvalidError(ValueError):
    """The coordinate system code is unknown or cannot be transformed to WGS84."""


@lru_cache(maxsize=256)
def _transformer(code: str) -> Transformer:
    try:
        source = CRS.from_user_input(code)
    except CRSError as exc:
        raise CrsInvalidError(code) from exc
    return Transformer.from_crs(source, CRS.from_epsg(4326), always_xy=True)


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

    `swap_axes` means the printed X is the northing (or latitude), so the pair is swapped first.
    """
    easting, northing = (y, x) if swap_axes else (x, y)
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


def placement(coords: dict[str, Any], crs_status: str, *, implausible: bool = False) -> Placement:
    lat, lon = coords.get("latitude"), coords.get("longitude")
    has_wgs84 = isinstance(lat, int | float) and isinstance(lon, int | float)
    has_any = has_wgs84 or any(coords.get(k) is not None for k in ("local_x", "local_y", "x_raw", "y_raw"))
    if not has_any:
        return Placement(False, "no_coordinates", None, None)
    if crs_status == "inferred":
        return Placement(False, "crs_unconfirmed", None, None)
    if crs_status not in PLOTTABLE_CRS_STATUS or not has_wgs84:
        return Placement(False, "crs_unknown", None, None)
    assert isinstance(lat, int | float) and isinstance(lon, int | float)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or implausible:
        return Placement(False, "implausible", None, None)
    return Placement(True, None, float(lat), float(lon))
