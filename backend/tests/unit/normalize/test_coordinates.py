"""Fictional values only: printed coordinate pairs across grids, languages and notations (BACKEND.md 7.8)."""

from __future__ import annotations

import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from app.normalize.api import NumberStyle
from app.normalize.coordinates import parse_coordinates, raised_prefixes
from app.normalize.numbers import format_number

GEOGRAPHIC = [
    # (family, x_raw, y_raw, labels_raw, latitude, longitude)
    ("decimal + letters", "52.5163 N", "13.3777 E", None, 52.5163, 13.3777),
    ("decimal + labels", "52.5163", "13.3777", "Lat Long", 52.5163, 13.3777),
    ("decimal, lon first", "13.3777", "52.5163", "Long/Lat", 52.5163, 13.3777),
    ("decimal, ranges decide", "-33.8688", "151.2093", None, -33.8688, 151.2093),
    ("DMS symbols, south", "33°52\u203207.7\u2033S", "151°12\u203233.5\u2033E", None, -33.868806, 151.209306),
    ("DMS ascii quotes", "48°12'30\"N", "16°22'15\"E", None, 48.208333, 16.370833),
    ("DMS spaces", "52 31 12.5 N", "13 24 18 E", None, 52.520139, 13.405),
    ("DMS d m s", "52d 31m 12s N", "13d 24m 18s E", None, 52.52, 13.405),
    ("DMS colons", "40:25:01.2 N", "3:42:12 W", None, 40.417, -3.703333),
    ("degrees decimal minutes", "N 25° 17.35'", "E 55° 18.12'", None, 25.289167, 55.302),
    ("comma groups d,mm,fff", "25,17,350", "55,18,123", "N, E", 25.289167, 55.30205),
    ("french words", "45,7640 nord", "4,8357 est", None, 45.764, 4.8357),
    ("german words", "47,3769 Nord", "8,5417 Ost", None, 47.3769, 8.5417),
    ("spanish words", "34,6037 Sur", "58,3816 Oeste", None, -34.6037, -58.3816),
    ("label with hemisphere", "33.85", "151.2", "Lat S, Long E", -33.85, 151.2),
    ("degree sign only", "-22.9068°", "-43.1729°", "Lat, Lon", -22.9068, -43.1729),
]


@pytest.mark.parametrize("case", GEOGRAPHIC, ids=[c[0] for c in GEOGRAPHIC])
def test_geographic(case: tuple[str, str, str, str | None, float, float]) -> None:
    _family, x_raw, y_raw, labels, lat, lon = case
    result = parse_coordinates(x_raw, y_raw, labels)
    assert result.kind == "geographic", result.reason
    assert result.latitude == pytest.approx(lat, abs=1e-6)
    assert result.longitude == pytest.approx(lon, abs=1e-6)
    assert result.local_x is None and result.local_y is None


PROJECTED = [
    # (family, x_raw, y_raw, labels_raw, local_x, local_y, swap_suspected)
    (
        "de GK, comma decimals",
        "3.512.345,67",
        "5.412.345,12",
        "Rechtswert Hochwert",
        3512345.67,
        5412345.12,
        False,
    ),
    ("de UTM, spaces", "512 345,67", "5 412 345,12", "E/N", 512345.67, 5412345.12, False),
    ("uk, northing first", "5.412.345,12", "512.345,67", "N, E", 512345.67, 5412345.12, False),
    ("uk easting northing", "530 123", "180 456", "Easting Northing", 530123.0, 180456.0, False),
    ("au mE mN glued", "6 123 456 mN", "412 345 mE", None, 412345.0, 6123456.0, False),
    ("letters as axis labels", "N 5 412 345", "E 512 345", None, 512345.0, 5412345.0, False),
    ("x y in printed order", "512345.67", "5412345.12", "X Y", 512345.67, 5412345.12, False),
    ("x behaves like a northing", "5412345.12", "512345.67", "X Y", 5412345.12, 512345.67, True),
    ("x northing, same magnitude", "548 123.45", "198 765.43", "X Y", 548123.45, 198765.43, False),
    ("thin spaces", "512\u2009345.6", "6\u2009123\u2009456.7", "E N", 512345.6, 6123456.7, False),
    ("apostrophes", "2'600'123.4", "1'200'456.7", "E N", 2600123.4, 1200456.7, False),
    ("feet", "1,012,345.6 ft", "212,345.6 ft", "E N", 1012345.6, 212345.6, True),
    ("small local grid with labels", "105.2", "87.3", "Easting Northing", 105.2, 87.3, False),
]


@pytest.mark.parametrize("case", PROJECTED, ids=[c[0] for c in PROJECTED])
def test_projected(case: tuple[str, str, str, str | None, float, float, bool]) -> None:
    _family, x_raw, y_raw, labels, local_x, local_y, swap = case
    result = parse_coordinates(x_raw, y_raw, labels)
    assert result.kind == "projected", result.reason
    assert result.local_x == pytest.approx(local_x)
    assert result.local_y == pytest.approx(local_y)
    assert result.swap_suspected is swap
    assert result.latitude is None and result.longitude is None


def test_printed_order_is_noted_and_feet_kept() -> None:
    result = parse_coordinates("5.412.345,12", "512.345,67", "N, E")
    assert "printed order: northing first" in result.notes
    result = parse_coordinates("1,012,345.6 ft", "212,345.6 ft", "E N")
    assert any("ft" in note for note in result.notes)


def test_both_values_in_one_field() -> None:
    result = parse_coordinates("52°31'N 13°24'E", None)
    assert result.kind == "geographic"
    assert result.latitude == pytest.approx(52.516667, abs=1e-6)
    result = parse_coordinates("512345.6; 5412345.1", None)
    assert (result.local_x, result.local_y) == (512345.6, 5412345.1)
    result = parse_coordinates(None, "52,5163, 13,3777", "Lat, Lon")
    assert (result.latitude, result.longitude) == (52.5163, 13.3777)


UNREADABLE = [
    ("0", "0", None, "placeholder"),
    ("0.0", "0,000", "E N", "placeholder"),
    ("foo", "bar", None, "unrecognised"),
    ("52.52", "13.40", None, "local grid"),  # few decimals, no marks: degrees or a site grid
    ("1,234", "5,678", None, "decimal or as thousands"),
    ("13 O", "52 N", None, "east or west"),
    ("45.1234", "200.5", "Lat, Long", "longitude"),
    ("512345", "5412345", "Lat Long", "latitude"),
    ("52°31'N", "5412345", None, "degrees"),
    ("52°75'N", "13°24'E", None, "60 or more"),
    (None, None, None, "no coordinates"),
    ("512345.6", None, None, "only one coordinate"),
]


@pytest.mark.parametrize(("x_raw", "y_raw", "labels", "why"), UNREADABLE)
def test_unreadable_pairs_say_why(x_raw: str | None, y_raw: str | None, labels: str | None, why: str) -> None:
    result = parse_coordinates(x_raw, y_raw, labels)
    assert result.latitude is None and result.local_x is None
    assert result.reason is not None and why in result.reason


def test_degrees_without_an_axis_order_read_latitude_first_and_say_so() -> None:
    result = parse_coordinates("52.5163", "13.3777")
    assert (result.latitude, result.longitude, result.order_assumed) == (52.5163, 13.3777, True)
    # X/Y labels do not state the order of degrees either (geodetic X is often the latitude): X is read as the
    # longitude, but the order stays to be confirmed.
    labelled = parse_coordinates("-32.929816", "27.437978", "X, Y")
    assert (labelled.latitude, labelled.longitude, labelled.order_assumed) == (27.437978, -32.929816, True)
    # Labels, marks and value ranges do state it.
    assert not parse_coordinates("52.5163", "13.3777", "Lat Long").order_assumed
    assert not parse_coordinates("52.5163 N", "13.3777 E").order_assumed
    assert not parse_coordinates("151.2093", "-33.8688").order_assumed


def test_labelled_latitude_above_90_is_a_suspected_swap() -> None:
    result = parse_coordinates("151.2093", "-33.8688", "Lat, Long")
    assert result.kind == "geographic"
    assert result.swap_suspected is True
    assert result.latitude is None


def test_style_decides_grouping() -> None:
    result = parse_coordinates("512,345", "5412,345", "E N", NumberStyle(decimal=","))
    assert (result.local_x, result.local_y) == (512.345, 5412.345)


# -------------------------------------------------------------------------------------------------
# Properties
# -------------------------------------------------------------------------------------------------


@st.composite
def _dms(draw: st.DrawFn, max_degrees: int) -> tuple[int, int, float]:
    return (
        draw(st.integers(min_value=0, max_value=max_degrees)),
        draw(st.integers(min_value=0, max_value=59)),
        draw(st.integers(min_value=0, max_value=5999)) / 100,
    )


@settings(max_examples=200, deadline=None)
@given(
    lat=_dms(89),
    lon=_dms(179),
    north=st.booleans(),
    east=st.booleans(),
    notation=st.sampled_from(["symbols", "spaces", "dms letters", "colons"]),
)
def test_dms_round_trip(
    lat: tuple[int, int, float], lon: tuple[int, int, float], north: bool, east: bool, notation: str
) -> None:
    def text(dms: tuple[int, int, float], letter: str) -> str:
        d, m, s = dms
        if notation == "symbols":
            return f"{d}°{m:02d}'{s:05.2f}\"{letter}"
        if notation == "spaces":
            return f"{d} {m:02d} {s:05.2f} {letter}"
        if notation == "colons":
            return f"{d}:{m:02d}:{s:05.2f} {letter}"
        return f"{d}d {m}m {s}s {letter}"

    expected_lat = (lat[0] + lat[1] / 60 + lat[2] / 3600) * (1 if north else -1)
    expected_lon = (lon[0] + lon[1] / 60 + lon[2] / 3600) * (1 if east else -1)
    assume(abs(expected_lat) > 0 or abs(expected_lon) > 0)
    result = parse_coordinates(text(lat, "N" if north else "S"), text(lon, "E" if east else "W"))
    assert result.kind == "geographic", result.reason
    assert result.latitude == pytest.approx(expected_lat, abs=1e-8)
    assert result.longitude == pytest.approx(expected_lon, abs=1e-8)


@settings(max_examples=200, deadline=None)
@given(
    easting=st.floats(min_value=100_000, max_value=899_999.99, allow_nan=False),
    northing=st.floats(min_value=1_000_000, max_value=9_999_999.99, allow_nan=False),
    decimal=st.sampled_from([",", "."]),
    group=st.sampled_from([None, " ", "\u202f", "thousands"]),
)
def test_projected_round_trip(easting: float, northing: float, decimal: str, group: str | None) -> None:
    if group == "thousands":
        group = "." if decimal == "," else ","
    x = format_number(easting, decimal=decimal, group=group, decimals=2)  # type: ignore[arg-type]
    y = format_number(northing, decimal=decimal, group=group, decimals=2)  # type: ignore[arg-type]
    result = parse_coordinates(x, y, "E N", NumberStyle(decimal=decimal))  # type: ignore[arg-type]
    assert result.kind == "projected", (x, y, result.reason)
    assert result.local_x == pytest.approx(round(easting, 2), abs=0.006)
    assert result.local_y == pytest.approx(round(northing, 2), abs=0.006)
    assert result.swap_suspected is False


@settings(max_examples=500, deadline=None)
@given(
    st.one_of(st.none(), st.text(max_size=25)),
    st.one_of(st.none(), st.text(max_size=25)),
    st.one_of(st.none(), st.text(max_size=15)),
)
def test_never_raises_and_never_returns_zero_zero(x: str | None, y: str | None, labels: str | None) -> None:
    result = parse_coordinates(x, y, labels)
    assert (result.latitude, result.longitude) != (0, 0)
    assert (result.local_x, result.local_y) != (0, 0)
    if result.kind is None:
        assert result.reason
    if result.latitude is not None:
        assert -90 <= result.latitude <= 90
        assert result.longitude is not None and -180 <= result.longitude <= 180


@settings(max_examples=300, deadline=None)
@given(
    st.text(alphabet="0123456789.,° '\"NSEWdms-", max_size=20),
    st.text(alphabet="0123456789.,° '\"NSEWdms-", max_size=20),
)
def test_coordinate_like_garbage_is_deterministic(x: str, y: str) -> None:
    first = parse_coordinates(x, y)
    assert first == parse_coordinates(x, y)
    assert (first.latitude, first.longitude) != (0, 0)


def test_a_note_in_parentheses_after_a_coordinate_is_not_part_of_it() -> None:
    result = parse_coordinates("314957.000", "5819600.000 (55H MGA94)")  # fictional grid values
    assert (result.kind, result.local_x, result.local_y) == ("projected", 314957.0, 5819600.0)
    assert any("parentheses" in note for note in result.notes)
    assert parse_coordinates("12 (34)", "5").kind is None  # numbers in parentheses are not a note


@pytest.mark.parametrize(
    ("system", "x", "y", "joined"),
    [
        ("35 57", "12 345", "45 678", ("3512345", "5745678")),
        ("35 57", "R: 12345", "H: 45 678,5", ("R: 3512345", "H: 5745678,5")),
        ("35 57", "1234", "45 678", None),  # four digits: not the raised style
        ("35 57", "312 345", "45 678", None),  # six digits: a value of its own
        ("Zone 35", "12 345", "45 678", None),  # a printed system name
        ("3557", "12 345", "45 678", None),
        (None, "12 345", "45 678", None),
        ("35 57", None, "45 678", None),
    ],
)
def test_raised_leading_digits_read_as_the_system_go_in_front_of_the_values(
    system: str | None, x: str | None, y: str | None, joined: tuple[str, str] | None
) -> None:
    assert raised_prefixes(system, x, y) == joined
