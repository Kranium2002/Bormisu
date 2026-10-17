"""Planned-line files (GeoJSON, KML, GPX, CSV) and the line geometry; fictional coordinates only."""

from __future__ import annotations

import json

import pytest
from pyproj import Geod, Transformer

from app.errors import ApiError
from app.geo.alignment_files import MAX_BYTES, parse_line
from app.geo.alignments import LineFrame, geodesic_length, utm_epsg

LINE = [(9.40, 50.20), (9.41, 50.205), (9.42, 50.20)]
GEOD = Geod(ellps="WGS84")


def _error(data: bytes | str, name: str, epsg: int | None = None) -> ApiError:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    with pytest.raises(ApiError) as caught:
        parse_line(raw, name, epsg)
    return caught.value


def _geojson(obj: object) -> bytes:
    return json.dumps(obj).encode("utf-8")


# --------------------------------------------------------------------------------------------
# GeoJSON
# --------------------------------------------------------------------------------------------


def test_geojson_linestring_geometry() -> None:
    parsed = parse_line(_geojson({"type": "LineString", "coordinates": [list(p) for p in LINE]}), "a.geojson")
    assert parsed.format == "geojson" and parsed.source_crs == "EPSG:4326"
    assert parsed.parts == [LINE] and parsed.name is None and parsed.vertex_count == 3


def test_geojson_feature_collection_keeps_lines_ignores_points_and_takes_the_name() -> None:
    data = _geojson(
        {
            "type": "FeatureCollection",
            "name": "layer",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"name": "Shaft A"},
                    "geometry": {"type": "Point", "coordinates": [9.4, 50.2]},
                },
                {
                    "type": "Feature",
                    "properties": {"name": "Fictional tunnel"},
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[9.40, 50.20, 101.5], [9.41, 50.205, 99.0]],
                    },
                },
                {
                    "type": "Feature",
                    "properties": {},
                    "geometry": {"type": "MultiLineString", "coordinates": [[[9.42, 50.20], [9.43, 50.21]]]},
                },
            ],
        }
    )
    parsed = parse_line(data, "Line.JSON")
    assert parsed.parts == [[(9.40, 50.20), (9.41, 50.205)], [(9.42, 50.20), (9.43, 50.21)]]
    assert parsed.name == "Fictional tunnel"


def test_geojson_geometry_collection_and_repeated_vertices() -> None:
    data = _geojson(
        {
            "type": "GeometryCollection",
            "geometries": [{"type": "LineString", "coordinates": [[9.4, 50.2], [9.4, 50.2], [9.41, 50.2]]}],
        }
    )
    assert parse_line(data, "g.geojson").parts == [[(9.4, 50.2), (9.41, 50.2)]]


def test_geojson_crs_member_naming_epsg_is_honoured() -> None:
    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    coords = [list(to_utm.transform(lon, lat)) for lon, lat in LINE]
    data = _geojson(
        {
            "type": "Feature",
            "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}},
            "properties": {},
            "geometry": {"type": "LineString", "coordinates": coords},
        }
    )
    parsed = parse_line(data, "projected.geojson")
    assert parsed.source_crs == "EPSG:25832"
    for (lon, lat), (elon, elat) in zip(parsed.parts[0], LINE, strict=True):
        assert lon == pytest.approx(elon, abs=1e-7) and lat == pytest.approx(elat, abs=1e-7)


@pytest.mark.parametrize(
    ("geometry", "words"),
    [
        (
            {"type": "Polygon", "coordinates": [[[9.4, 50.2], [9.41, 50.2], [9.41, 50.21], [9.4, 50.2]]]},
            "polygons",
        ),
        ({"type": "MultiPoint", "coordinates": [[9.4, 50.2], [9.41, 50.2]]}, "points"),
        ({"type": "LineString", "coordinates": [[9.4, 50.2]]}, "two distinct vertices"),
        ({"type": "LineString", "coordinates": [[9.4, 50.2], [9.4, 50.2]]}, "two distinct vertices"),
        (
            {"type": "LineString", "coordinates": [[529519.9, 5561840.3], [529889.8, 5562010.3]]},
            "longitude/latitude",
        ),
        ({"type": "LineString", "coordinates": [[179.9, 10.0], [-179.9, 10.0]]}, "180° meridian"),
        ({"type": "LineString", "coordinates": [["9.4", "50.2"], [9.41, 50.2]]}, "[longitude, latitude]"),
    ],
)
def test_geojson_without_a_usable_line_is_refused(geometry: dict[str, object], words: str) -> None:
    error = _error(_geojson({"type": "Feature", "properties": {}, "geometry": geometry}), "x.geojson")
    assert error.status_code == 422 and error.code == "alignment_invalid"
    assert words in error.detail


@pytest.mark.parametrize("data", ["{not json", "[1, 2]", '{"features": []}', "   "])
def test_garbage_json_is_refused(data: str) -> None:
    error = _error(data, "x.json")
    assert (error.status_code, error.code) == (422, "alignment_invalid")


# --------------------------------------------------------------------------------------------
# KML and GPX
# --------------------------------------------------------------------------------------------

KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Doc name</name>
  <Placemark><name>Marker</name><Point><coordinates>9.4,50.2</coordinates></Point></Placemark>
  <Placemark><name>Fictional pipeline</name><MultiGeometry>
    <LineString><coordinates>9.40,50.20,0 9.41,50.205,0
      9.42,50.20,0</coordinates></LineString>
    <LineString><coordinates>9.43,50.20 9.44,50.21</coordinates></LineString>
  </MultiGeometry></Placemark>
</Document></kml>"""


def test_kml_linestrings_inside_placemark_and_multigeometry() -> None:
    parsed = parse_line(KML.encode(), "line.kml")
    assert parsed.format == "kml"
    assert parsed.parts == [LINE, [(9.43, 50.20), (9.44, 50.21)]]
    assert parsed.name == "Fictional pipeline"


def test_kml_without_namespace_and_document_name() -> None:
    data = (
        b"<kml><Document><name>Plain</name>"
        b"<LineString><coordinates>9.4,50.2 9.41,50.2</coordinates></LineString></Document></kml>"
    )
    parsed = parse_line(data, "plain.kml")
    assert parsed.parts == [[(9.4, 50.2), (9.41, 50.2)]] and parsed.name == "Plain"


@pytest.mark.parametrize(
    ("data", "words"),
    [
        ("<kml><Placemark><Point><coordinates>9.4,50.2</coordinates></Point></Placemark></kml>", "points"),
        (
            "<kml><Polygon><outerBoundaryIs><LinearRing><coordinates>9.4,50.2 9.41,50.2 9.41,50.21 9.4,50.2"
            "</coordinates></LinearRing></outerBoundaryIs></Polygon></kml>",
            "polygons",
        ),
        ("<kml><Document><LineString><coordinates>9.4,50.2", "not valid KML"),
        ("<gpx><trk/></gpx>", "not KML"),
        (
            "<kml><LineString><coordinates>9.4;50.2 9.41;50.2</coordinates></LineString></kml>",
            "longitude,latitude",
        ),
    ],
)
def test_bad_kml_is_refused(data: str, words: str) -> None:
    error = _error(data, "x.kml")
    assert error.code == "alignment_invalid" and words in error.detail


def test_xml_entities_are_refused() -> None:
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>'
        "<kml><Document><name>&b;</name></Document></kml>"
    )
    error = _error(bomb, "bomb.kml")
    assert error.code == "alignment_invalid" and "entities" in error.detail


def test_external_entities_are_refused() -> None:
    xxe = '<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx>&x;</gpx>'
    assert _error(xxe, "xxe.gpx").code == "alignment_invalid"


GPX = """<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Meta</name></metadata>
  <wpt lat="50.3" lon="9.5"><name>Camp</name></wpt>
  <trk><name>Fictional drilling line</name>
    <trkseg><trkpt lat="50.20" lon="9.40"/><trkpt lat="50.205" lon="9.41"/></trkseg>
    <trkseg><trkpt lat="50.205" lon="9.41"/><trkpt lat="50.20" lon="9.42"/></trkseg>
  </trk>
  <rte><rtept lat="50.21" lon="9.43"/><rtept lat="50.22" lon="9.44"/></rte>
</gpx>"""


def test_gpx_tracks_segments_and_routes() -> None:
    parsed = parse_line(GPX.encode(), "walk.gpx")
    assert parsed.format == "gpx" and parsed.name == "Fictional drilling line"
    assert parsed.parts == [
        [(9.40, 50.20), (9.41, 50.205)],
        [(9.41, 50.205), (9.42, 50.20)],
        [(9.43, 50.21), (9.44, 50.22)],
    ]


def test_gpx_waypoints_only_are_refused() -> None:
    error = _error('<gpx><wpt lat="50.2" lon="9.4"/><wpt lat="50.3" lon="9.5"/></gpx>', "w.gpx")
    assert error.code == "alignment_invalid" and "points" in error.detail


def test_gpx_point_without_coordinates_is_refused() -> None:
    error = _error('<gpx><rte><rtept lat="50.2"/><rtept lat="50.3" lon="9.5"/></rte></gpx>', "r.gpx")
    assert error.code == "alignment_invalid" and "lat and lon" in error.detail


# --------------------------------------------------------------------------------------------
# CSV
# --------------------------------------------------------------------------------------------


def test_csv_lon_lat_columns_in_row_order() -> None:
    data = "id,Latitude,Longitude\n1,50.20,9.40\n2,50.205,9.41\n\n3,50.20,9.42\n"
    parsed = parse_line(data.encode(), "line.csv")
    assert parsed.parts == [LINE] and parsed.source_crs == "EPSG:4326" and parsed.name is None


def test_csv_semicolon_decimal_comma_and_bom() -> None:
    data = "﻿Lon;Lat\n9,40;50,20\n9,41;50,205\n9,42;50,20\n"
    assert parse_line(data.encode("utf-8"), "line.csv").parts == [LINE]


def test_projected_csv_with_epsg() -> None:
    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    rows = [to_utm.transform(lon, lat) for lon, lat in LINE]
    data = "Easting [m];Northing [m]\n" + "".join(f"{x:.3f};{y:.3f}\n".replace(".", ",") for x, y in rows)
    parsed = parse_line(data.encode(), "utm.csv", 25832)
    assert parsed.source_crs == "EPSG:25832"
    for (lon, lat), (elon, elat) in zip(parsed.parts[0], LINE, strict=True):
        assert lon == pytest.approx(elon, abs=1e-6) and lat == pytest.approx(elat, abs=1e-6)


def test_projected_csv_without_epsg_is_refused() -> None:
    error = _error("x,y\n529519.9,5561840.3\n529889.8,5562010.3\n", "utm.csv")
    assert (error.status_code, error.code) == (422, "epsg_required")
    assert "never guessed" in error.detail


def test_projected_csv_with_an_unknown_or_wrong_epsg_is_refused() -> None:
    data = "x,y\n529519.9,5561840.3\n529889.8,5562010.3\n"
    assert _error(data, "utm.csv", 999999).code == "crs_invalid"
    # Valid UTM 32N values read as New Zealand Transverse Mercator land far outside NZ.
    wrong = _error(data, "utm.csv", 2193)
    assert wrong.code == "crs_invalid" and "area" in wrong.detail


@pytest.mark.parametrize(
    ("data", "words"),
    [
        ("lon,lat\n9.4,50.2\n", "two distinct vertices"),
        ("a,b\n9.4,50.2\n9.41,50.2\n", "header"),
        ("9.4\n9.41\n", "header row"),
        ("lon,lat\n9.4,50.2\n9.41,north\n", "Row 3"),
        ("lon,lat,z\n9.4,50.2,1\n9.41\n", "fewer columns"),
        ("lon,lat\n200,50.2\n201,50.2\n", "longitude/latitude"),
    ],
)
def test_bad_csv_is_refused(data: str, words: str) -> None:
    error = _error(data, "x.csv")
    assert error.code == "alignment_invalid" and words in error.detail


# --------------------------------------------------------------------------------------------
# Type, size
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["line.kmz", "line.shp", "line.xml", "line"])
def test_unsupported_extensions_are_415(name: str) -> None:
    error = _error("lon,lat\n9.4,50.2\n9.41,50.2\n", name)
    assert (error.status_code, error.code) == (415, "unsupported_type")


def test_files_over_the_limit_are_413() -> None:
    error = _error(b" " * (MAX_BYTES + 1), "big.geojson")
    assert (error.status_code, error.code) == (413, "too_large")


def test_empty_file_is_refused() -> None:
    assert _error(b"", "empty.gpx").code == "alignment_invalid"


# --------------------------------------------------------------------------------------------
# Geometry: UTM zone, chainage, side
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("lon", "lat", "epsg"),
    [
        (9.42, 50.21, 32632),
        (-1.97, 53.67, 32630),
        (144.62, -37.71, 32755),
        (-180.0, 0.0, 32601),
        (180.0, -1.0, 32760),
    ],
)
def test_utm_zone_of_the_centre(lon: float, lat: float, epsg: int) -> None:
    assert utm_epsg(lon, lat) == epsg


def _offset(lon: float, lat: float, azimuth: float, metres: float) -> tuple[float, float]:
    out_lon, out_lat, _ = GEOD.fwd(lon, lat, azimuth, metres)
    return out_lon, out_lat


def test_chainage_runs_along_the_line_and_side_looks_forward() -> None:
    line = [(9.40, 50.20), (9.42, 50.20)]
    frame = LineFrame([line])
    assert frame.epsg == 32632
    assert frame.length_m == pytest.approx(geodesic_length([line]))
    north = frame.locate(*_offset(9.405, 50.20, 0, 50))
    south = frame.locate(*_offset(9.415, 50.20, 180, 30))
    assert north.side == "left" and south.side == "right"
    assert north.chainage_m == pytest.approx(GEOD.inv(9.40, 50.20, 9.405, 50.20)[2], abs=0.5)
    assert south.chainage_m == pytest.approx(GEOD.inv(9.40, 50.20, 9.415, 50.20)[2], abs=0.5)
    # Behind the start and past the end: clamped to the ends.
    assert frame.locate(9.399, 50.2).chainage_m == 0
    assert frame.locate(9.421, 50.2).chainage_m == pytest.approx(frame.length_m)
    # Reversed line: sides swap.
    assert LineFrame([line[::-1]]).locate(*_offset(9.405, 50.20, 0, 50)).side == "right"


def test_chainage_continues_across_parts() -> None:
    first = [(9.40, 50.20), (9.41, 50.20)]
    second = [(9.42, 50.20), (9.43, 50.20)]
    frame = LineFrame([first, second])
    first_length = geodesic_length([first])
    station = frame.locate(9.425, 50.2001)
    expected = first_length + GEOD.inv(9.42, 50.20, 9.425, 50.20)[2]
    assert station.chainage_m == pytest.approx(expected, abs=1.0)
    assert frame.length_m == pytest.approx(first_length + geodesic_length([second]))
