"""Planned-line files (GeoJSON, KML, GPX, CSV) -> WGS84 line parts. Positions are never guessed.

GeoJSON, KML and GPX are longitude/latitude on WGS84 by definition (a GeoJSON `crs` member naming
another EPSG code is honoured). A CSV names its columns: lon/lat, or x/y together with the EPSG code
the request states. XML is parsed with defusedxml (no entities, no external references).
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree.ElementTree import Element, ParseError

import defusedxml.ElementTree as SafeET
from defusedxml import DefusedXmlException
from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError

from app.errors import ApiError
from app.upload import display_name

MAX_BYTES = 10 * 1024 * 1024
MAX_VERTICES = 50_000
FORMATS = {".geojson": "geojson", ".json": "geojson", ".kml": "kml", ".gpx": "gpx", ".csv": "csv"}
WGS84 = "EPSG:4326"
# Stored precision of a vertex (degrees; 9 decimals is about 0.1 mm), as ST_AsGeoJSON returns it.
COORD_DECIMALS = 9
# A neighbouring vertex this close (degrees, about 1 mm) is the same vertex.
_SAME_VERTEX_DEG = 1e-8

Part = list[tuple[float, float]]


@dataclass(frozen=True)
class ParsedLine:
    format: str
    parts: list[Part]
    source_crs: str
    name: str | None

    @property
    def vertex_count(self) -> int:
        return sum(len(part) for part in self.parts)


def invalid(detail: str) -> ApiError:
    return ApiError(422, "alignment_invalid", detail)


def file_format(file_name: str) -> str:
    extension = Path(display_name(file_name)).suffix.lower()
    if extension not in FORMATS:
        raise ApiError(
            415,
            "unsupported_type",
            f"Files of type {extension or '(none)'} are not accepted for a planned line. "
            "Use GeoJSON, KML, GPX or CSV.",
        )
    return FORMATS[extension]


def parse_line(data: bytes, file_name: str, epsg: int | None = None) -> ParsedLine:
    """The line in `data` as WGS84 parts; ApiError (415/422) with a readable detail otherwise."""
    fmt = file_format(file_name)
    if len(data) > MAX_BYTES:
        raise ApiError(413, "too_large", f"The file is larger than {MAX_BYTES // (1024 * 1024)} MB.")
    if not data.strip():
        raise invalid("The file is empty.")
    if fmt == "geojson":
        parts, name, crs = _geojson(data)
    elif fmt == "kml":
        parts, name = _kml(data)
        crs = None
    elif fmt == "gpx":
        parts, name = _gpx(data)
        crs = None
    else:
        parts, crs = _csv(data, epsg)
        name = None
    if crs is not None and crs != 4326:
        parts = _to_wgs84(parts, crs)
    parts = _clean(parts)
    return ParsedLine(fmt, parts, f"EPSG:{crs}" if crs is not None else WGS84, name)


# --------------------------------------------------------------------------------------------
# GeoJSON
# --------------------------------------------------------------------------------------------

_EPSG_NAME = re.compile(r"EPSG:{1,2}(?:[\d.]*:)?(\d{4,6})$", re.IGNORECASE)


def _geojson_crs(obj: dict[str, Any]) -> int | None:
    """EPSG code of a (2008-style) `crs` member, None for WGS84 or when absent."""
    member = obj.get("crs")
    if not isinstance(member, dict):
        return None
    name = (member.get("properties") or {}).get("name")
    if not isinstance(name, str):
        return None
    if name.upper().endswith("CRS84"):
        return None
    match = _EPSG_NAME.search(name.strip())
    if match is None:
        raise invalid(f"The GeoJSON names the coordinate system {name!r}, which is not an EPSG code.")
    code = int(match.group(1))
    return None if code == 4326 else code


def _positions(value: Any) -> Part:
    if not isinstance(value, list):
        raise invalid("A LineString's coordinates must be a list of positions.")
    out: Part = []
    for position in value:
        if (
            not isinstance(position, list)
            or len(position) < 2
            or not all(isinstance(v, int | float) and not isinstance(v, bool) for v in position[:2])
        ):
            raise invalid("Every position of a line must be [longitude, latitude].")
        out.append((float(position[0]), float(position[1])))
    return out


def _geojson(data: bytes) -> tuple[list[Part], str | None, int | None]:
    try:
        obj = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise invalid("The file is not valid JSON.") from None
    if not isinstance(obj, dict) or not isinstance(obj.get("type"), str):
        raise invalid("The file is not GeoJSON (no object with a type).")
    parts: list[Part] = []
    seen: set[str] = set()
    names: list[str] = []

    def walk(node: Any, depth: int = 0) -> None:
        if not isinstance(node, dict) or depth > 20:
            return
        kind = node.get("type")
        if kind == "FeatureCollection":
            if isinstance(node.get("name"), str):
                names.append(node["name"])
            for feature in node.get("features") or []:
                walk(feature, depth + 1)
        elif kind == "Feature":
            before = len(parts)
            walk(node.get("geometry"), depth + 1)
            props = node.get("properties")
            if len(parts) > before and isinstance(props, dict):
                for key in ("name", "Name", "NAME", "title"):
                    if isinstance(props.get(key), str):
                        names.insert(0, props[key])
                        break
        elif kind == "GeometryCollection":
            for geometry in node.get("geometries") or []:
                walk(geometry, depth + 1)
        elif kind == "LineString":
            parts.append(_positions(node.get("coordinates")))
        elif kind == "MultiLineString":
            lines = node.get("coordinates")
            if not isinstance(lines, list):
                raise invalid("A MultiLineString's coordinates must be a list of lines.")
            parts.extend(_positions(line) for line in lines)
        elif isinstance(kind, str):
            seen.add(kind)

    walk(obj)
    if not parts:
        raise invalid(_no_line_detail(seen, "GeoJSON"))
    return parts, (names[0] if names else None), _geojson_crs(obj)


def _no_line_detail(seen: set[str], what: str) -> str:
    lowered = {kind.lower() for kind in seen}
    if lowered & {"polygon", "multipolygon", "linearring"}:
        return f"The {what} holds polygons but no line. Upload the planned line as a LineString."
    if lowered & {"point", "multipoint", "wpt"}:
        return f"The {what} holds points but no line. Upload the planned line as a LineString."
    return f"The {what} holds no line (LineString)."


# --------------------------------------------------------------------------------------------
# KML and GPX
# --------------------------------------------------------------------------------------------


def _local(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _xml(data: bytes, what: str, root_name: str) -> Element:
    try:
        root: Element = SafeET.fromstring(data)
    except DefusedXmlException:
        raise invalid(
            f"The {what} uses XML entities or external references, which are not accepted."
        ) from None
    except (ParseError, ValueError):
        raise invalid(f"The file is not valid {what} (the XML cannot be read).") from None
    if _local(root.tag) != root_name:
        raise invalid(f"The file is not {what} (the XML root is <{_local(root.tag)}>).")
    return root


def _child_text(element: Element, name: str) -> str | None:
    for child in element:
        if _local(child.tag) == name and child.text and child.text.strip():
            return child.text.strip()
    return None


def _kml_coordinates(text: str) -> Part:
    out: Part = []
    for token in text.split():
        values = token.split(",")
        try:
            out.append((float(values[0]), float(values[1])))
        except (IndexError, ValueError):
            raise invalid(
                f"KML coordinates must be 'longitude,latitude[,altitude]', not {token[:40]!r}."
            ) from None
    return out


def _kml(data: bytes) -> tuple[list[Part], str | None]:
    root = _xml(data, "KML", "kml")
    parts: list[Part] = []
    seen: set[str] = set()
    name: str | None = None
    for element in root.iter():
        kind = _local(element.tag)
        if kind == "Placemark" and name is None:
            if any(_local(e.tag) == "LineString" for e in element.iter()):
                name = _child_text(element, "name")
        elif kind == "LineString":
            coordinates = next((e for e in element if _local(e.tag) == "coordinates"), None)
            parts.append(_kml_coordinates((coordinates.text or "") if coordinates is not None else ""))
        elif kind in ("Point", "Polygon", "LinearRing"):
            seen.add(kind)
    if name is None:
        document = next((e for e in root.iter() if _local(e.tag) == "Document"), None)
        name = _child_text(document, "name") if document is not None else None
    if not any(parts):
        raise invalid(_no_line_detail(seen, "KML"))
    return parts, name


def _gpx_points(container: Element, point_name: str) -> Part:
    out: Part = []
    for point in container:
        if _local(point.tag) != point_name:
            continue
        try:
            out.append((float(point.attrib["lon"]), float(point.attrib["lat"])))
        except (KeyError, ValueError):
            raise invalid(f"A GPX <{point_name}> needs numeric lat and lon attributes.") from None
    return out


def _gpx(data: bytes) -> tuple[list[Part], str | None]:
    root = _xml(data, "GPX", "gpx")
    parts: list[Part] = []
    seen: set[str] = set()
    names: list[str] = []
    for element in root.iter():
        kind = _local(element.tag)
        if kind == "trk":
            parts.extend(_gpx_points(seg, "trkpt") for seg in element if _local(seg.tag) == "trkseg")
            if (text := _child_text(element, "name")) is not None:
                names.append(text)
        elif kind == "rte":
            parts.append(_gpx_points(element, "rtept"))
            if (text := _child_text(element, "name")) is not None:
                names.append(text)
        elif kind == "wpt":
            seen.add("wpt")
    if not any(parts):
        raise invalid(_no_line_detail(seen, "GPX"))
    if not names:
        metadata = next((e for e in root if _local(e.tag) == "metadata"), None)
        if metadata is not None and (text := _child_text(metadata, "name")) is not None:
            names.append(text)
    return parts, (names[0] if names else None)


# --------------------------------------------------------------------------------------------
# CSV
# --------------------------------------------------------------------------------------------

LON_NAMES = {"lon", "lng", "long", "longitude"}
LAT_NAMES = {"lat", "latitude"}
X_NAMES = {"x", "easting", "east", "e", "rechtswert", "ostwert"}
Y_NAMES = {"y", "northing", "north", "n", "hochwert", "nordwert"}


def _column_key(header: str) -> str:
    """'Easting [m]' -> 'easting'; quotes, units and spaces dropped."""
    text = re.sub(r"[\[(].*?[\])]", "", header).strip().strip("\"'").strip().lower()
    return re.sub(r"[\s_-]+", "", text)


def _find(keys: list[str], names: set[str]) -> int | None:
    return next((i for i, key in enumerate(keys) if key in names), None)


def _number(text: str, decimal_comma: bool, row: int) -> float:
    cleaned = text.strip().replace(" ", "").replace(" ", "").replace(" ", "")
    if decimal_comma:
        cleaned = cleaned.replace(".", "").replace(",", ".") if "," in cleaned else cleaned
    try:
        value = float(cleaned)
    except ValueError:
        raise invalid(f"Row {row}: {text.strip()[:40]!r} is not a number.") from None
    if not math.isfinite(value):
        raise invalid(f"Row {row}: {text.strip()[:40]!r} is not a number.")
    return value


def _csv(data: bytes, epsg: int | None) -> tuple[list[Part], int | None]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    lines = text.splitlines()
    header_line = next((line for line in lines if line.strip()), "")
    delimiter = max((";", "\t", ","), key=lambda d: (header_line.count(d), d != ","))
    if header_line.count(delimiter) == 0:
        raise invalid("The CSV needs a header row and at least two columns (lon/lat or x/y).")
    rows = [row for row in csv.reader(io.StringIO(text), delimiter=delimiter) if any(c.strip() for c in row)]
    keys = [_column_key(cell) for cell in rows[0]]
    lon_i, lat_i = _find(keys, LON_NAMES), _find(keys, LAT_NAMES)
    x_i, y_i = _find(keys, X_NAMES), _find(keys, Y_NAMES)
    if lon_i is not None and lat_i is not None:
        first, second, projected = lon_i, lat_i, False
    elif x_i is not None and y_i is not None:
        first, second, projected = x_i, y_i, True
    else:
        raise invalid(
            "The CSV header must name lon/lat columns (lon, longitude / lat, latitude) or x/y columns "
            "(x, easting / y, northing) with the EPSG code."
        )
    if projected and epsg is None:
        raise ApiError(
            422,
            "epsg_required",
            "The CSV has x/y columns. Give the EPSG code of these coordinates (for example 25832 for "
            "ETRS89 / UTM zone 32N, 4326 if they are longitude/latitude); positions are never guessed.",
        )
    decimal_comma = delimiter != ","
    part: Part = []
    for number, row in enumerate(rows[1:], start=2):
        if max(first, second) >= len(row):
            raise invalid(f"Row {number} has fewer columns than the header.")
        part.append((_number(row[first], decimal_comma, number), _number(row[second], decimal_comma, number)))
    return [part], (None if epsg is None or epsg == 4326 else epsg)


# --------------------------------------------------------------------------------------------
# Coordinate systems and checks
# --------------------------------------------------------------------------------------------


def _to_wgs84(parts: list[Part], epsg: int) -> list[Part]:
    try:
        source = CRS.from_epsg(epsg)
    except CRSError:
        raise ApiError(
            422, "crs_invalid", f"EPSG:{epsg} is not a known coordinate reference system."
        ) from None
    transformer = Transformer.from_crs(source, CRS.from_epsg(4326), always_xy=True)
    out: list[Part] = []
    for part in parts:
        xs, ys = transformer.transform([p[0] for p in part], [p[1] for p in part])
        out.append([(float(x), float(y)) for x, y in zip(xs, ys, strict=True)])
    area = source.area_of_use
    if area is not None:
        margin = 1.0
        outside = [
            p
            for part in out
            for p in part
            if not (
                math.isfinite(p[0])
                and math.isfinite(p[1])
                and area.west - margin <= p[0] <= area.east + margin
                and area.south - margin <= p[1] <= area.north + margin
            )
        ]
        if outside and area.west <= area.east:
            raise ApiError(
                422,
                "crs_invalid",
                f"The coordinates fall outside the area where EPSG:{epsg} ({source.name}) is used "
                f"({area.name}). Check the EPSG code.",
            )
    return out


def _clean(parts: list[Part]) -> list[Part]:
    """Drop repeated vertices and empty parts; check ranges, vertex count and the antimeridian."""
    total = sum(len(part) for part in parts)
    if total > MAX_VERTICES:
        raise invalid(f"The line has {total} vertices; at most {MAX_VERTICES} are accepted.")
    out: list[Part] = []
    for part in parts:
        kept: Part = []
        for lon, lat in part:
            if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
                raise invalid(
                    f"The position ({lon:g}, {lat:g}) is not a longitude/latitude. GeoJSON, KML and "
                    "GPX are WGS84 longitude/latitude; projected CSV coordinates need x/y columns and "
                    "the EPSG code."
                )
            if (
                kept
                and abs(kept[-1][0] - lon) <= _SAME_VERTEX_DEG
                and abs(kept[-1][1] - lat) <= _SAME_VERTEX_DEG
            ):
                continue
            if kept and abs(kept[-1][0] - lon) > 180:
                raise invalid("The line crosses the 180° meridian, which is not supported.")
            kept.append((round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)))
        if len(kept) >= 2:
            out.append(kept)
    if not out:
        raise invalid("A line needs at least two distinct vertices.")
    return out
