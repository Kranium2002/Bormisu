"""Fictional values only: printed coordinate-system names to EPSG codes (BACKEND.md 7.8)."""

from __future__ import annotations

import re

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.normalize.coordinates import parse_coordinates
from app.normalize.crs import resolve_printed_system
from app.normalize.numbers import load_data

STATED = [
    # registry aliases (data/crs_registry.yaml)
    ("au alias", "55H MGA94", "EPSG:28355"),
    ("nz alias", "Mt Eden 2000", "EPSG:2105"),
    ("uk alias", "OSGB36", "EPSG:27700"),
    ("de alias", "UTM32E89", "EPSG:25832"),
    # UTM with datum and hemisphere or latitude band (worldwide)
    ("wgs84 north", "WGS84 UTM 32N", "EPSG:32632"),
    ("wgs84 south", "WGS 84 / UTM zone 55S", "EPSG:32755"),
    ("wgs84 band letter", "UTM Zone 55H WGS84", "EPSG:32755"),
    ("wgs84 band north", "UTM WGS84 32U", "EPSG:32632"),
    ("wgs84 words", "WGS 1984 UTM Zone 18 South", "EPSG:32718"),
    ("etrs89 implied north", "ETRS89 UTM 33", "EPSG:25833"),
    ("etrs89 compact", "ETRS 89 UTM32", "EPSG:25832"),
    ("etrs89 full name", "ETRS89 / UTM zone 31N", "EPSG:25831"),
    ("nad83", "NAD83 UTM 18", "EPSG:26918"),
    ("nad27", "NAD27 / UTM zone 15N", "EPSG:26715"),
    ("ed50", "ED50 UTM 31N", "EPSG:23031"),
    ("sirgas", "SIRGAS 2000 UTM 23S", "EPSG:31983"),
    ("sirgas spanish", "SIRGAS 2000 / UTM zona 23 Sur", "EPSG:31983"),
    # MGA per datum named
    ("mga2020", "MGA2020 Zone 55", "EPSG:7855"),
    ("gda94 mga", "GDA94 MGA Zone 54", "EPSG:28354"),
    ("gda2020 zone only", "Zone 55 (GDA2020)", "EPSG:7855"),
    # Gauss-Krüger
    ("gk words", "Gauß-Krüger Zone 4", "EPSG:31468"),
    ("gk streifen", "DHDN GK Streifen 3", "EPSG:31467"),
    ("gk 6 degree", "Pulkovo 1942 Gauss-Krüger zone 4", "EPSG:28404"),
    # printed codes
    ("epsg", "EPSG:25832", "EPSG:25832"),
    ("epsg code words", "EPSG-Code 31467", "EPSG:31467"),
    ("srid", "SRID 4326", "EPSG:4326"),
    # geographic datum named with degree words
    ("geographic words", "Lat/Long WGS84", "EPSG:4326"),
]


@pytest.mark.parametrize(("family", "printed", "code"), STATED, ids=[c[0] for c in STATED])
def test_stated_systems(family: str, printed: str, code: str) -> None:
    result = resolve_printed_system(printed)
    assert result.code == code, (family, result.reason)
    assert result.label


NOT_STATED = [
    ("UTM zone 32N", "without a datum"),
    ("MGA zone 56", "without a datum"),
    ("UTM 33S", "without a datum"),
    ("WGS84 UTM 32", "hemisphere"),
    ("ETRS89 UTM 32S", "other hemisphere"),
    ("Gauss-Krüger", "zone is not stated"),
    ("WGS84 UTM 75N", "outside"),
    ("ETRS89", "datum only"),
    ("WGS84 / ETRS89 UTM 32N", "more than one datum"),
    ("local grid", "local grid"),
    ("Baustellensystem", "local grid"),
    ("système local", "local grid"),
    ("EPSG 99999", "not in the EPSG database"),
    ("Kartenblatt 7", "no known coordinate system"),
    ("", "no coordinate system printed"),
    (None, "no coordinate system printed"),
]


@pytest.mark.parametrize(("printed", "why"), NOT_STATED)
def test_systems_not_stated_or_ambiguous(printed: str | None, why: str) -> None:
    result = resolve_printed_system(printed)
    assert result.code is None
    assert result.reason is not None and why in result.reason


def test_coordinates_check_the_kind() -> None:
    grid = parse_coordinates("512345.6", "5412345.1", "E N")
    degrees = parse_coordinates("52.5 N", "13.4 E")
    assert resolve_printed_system("WGS84", grid).code is None
    assert resolve_printed_system("WGS84", degrees).code == "EPSG:4326"
    assert resolve_printed_system("ETRS89", degrees).code == "EPSG:4258"
    assert resolve_printed_system("UTM32E89", degrees).code is None
    assert resolve_printed_system("ETRS89", grid).code is None


def test_gauss_krueger_zone_from_the_easting() -> None:
    coords = parse_coordinates("3512345", "5412345", "Rechtswert Hochwert")
    result = resolve_printed_system("Gauss-Krüger", coords)
    assert result.code == "EPSG:31467"
    assert result.reason is not None and "leading digit" in result.reason


def test_swapped_axes_are_named_but_the_code_is_kept() -> None:
    coords = parse_coordinates("5412345.1", "512345.6", "X Y")
    result = resolve_printed_system("ETRS89 UTM 32N", coords)
    assert result.code == "EPSG:25832"
    assert result.reason is not None and "swapped" in result.reason


def test_point_outside_the_area_is_named() -> None:
    coords = parse_coordinates("-33.85 S", "151.2 E")
    result = resolve_printed_system("ETRS89 geographic", coords)
    assert result.code == "EPSG:4258"
    assert result.reason is not None and "outside" in result.reason


def test_patterns_name_only_existing_epsg_templates() -> None:
    data = load_data("crs_patterns.yaml")
    for grid in data["grids"]:
        assert "{zone}" in grid["template"] and "{datum}" in grid["template"]
    datum_names = {d["epsg_name"] for d in data["datums"]}
    for datum in data["datums"]:
        assert datum.get("default_grid") in (None, *(g["id"] for g in data["grids"])), datum
    for grid in data["grids"]:
        assert grid.get("default_datum") in (None, *datum_names), grid


# -------------------------------------------------------------------------------------------------
# Properties
# -------------------------------------------------------------------------------------------------


@settings(max_examples=120, deadline=None)
@given(
    zone=st.integers(min_value=1, max_value=60),
    north=st.booleans(),
    datum=st.sampled_from(["WGS84", "WGS 84", "WGS-84", "WGS 1984"]),
    form=st.sampled_from(
        ["{d} UTM {z}{h}", "UTM zone {z}{h} ({d})", "{d} / UTM Zone {z} {hw}", "UTM{z}{h} {d}"]
    ),
)
def test_wgs84_utm_codes_follow_the_epsg_numbering(zone: int, north: bool, datum: str, form: str) -> None:
    printed = form.format(d=datum, z=zone, h="N" if north else "S", hw="North" if north else "South")
    result = resolve_printed_system(printed)
    assert result.code == f"EPSG:{(32600 if north else 32700) + zone}", (printed, result.reason)


@settings(max_examples=40, deadline=None)
@given(
    zone=st.integers(min_value=28, max_value=37),
    form=st.sampled_from(["ETRS89 UTM {z}", "ETRS89 / UTM zone {z}N"]),
)
def test_etrs89_utm_codes_follow_the_epsg_numbering(zone: int, form: str) -> None:
    result = resolve_printed_system(form.format(z=zone))
    assert result.code == f"EPSG:{25800 + zone}"


@settings(max_examples=300, deadline=None)
@given(st.one_of(st.none(), st.text(max_size=40)))
def test_never_raises_and_codes_are_epsg(text: str | None) -> None:
    result = resolve_printed_system(text)
    if result.code is None:
        assert result.reason
    else:
        assert re.fullmatch(r"EPSG:[0-9]{4,6}", result.code)


@settings(max_examples=150, deadline=None)
@given(
    st.lists(
        st.sampled_from(
            ["UTM", "WGS84", "ETRS89", "MGA", "GDA94", "zone", " ", "32", "55", "N", "S", "H", "/", "GK", "3"]
        ),
        max_size=8,
    ).map("".join)
)
def test_system_like_text_never_raises(text: str) -> None:
    result = resolve_printed_system(text)
    assert result.code is not None or result.reason
