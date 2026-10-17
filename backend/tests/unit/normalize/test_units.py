"""Fictional values only: units, lengths, percentages and Test Results names (BACKEND.md 7.8)."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.normalize.api import NumberStyle
from app.normalize.numbers import format_number, load_data
from app.normalize.units import (
    canonical_unit,
    convert,
    lab_tests,
    lookup_unit,
    match_lab_test,
    normalise_lab_test_value,
    parse_length,
    parse_percent,
    to_metres,
    unit_alias_collisions,
)

LENGTHS = [
    # metric logs (de, fr, en)
    ("de", "12,50 m", None, 12.5, "m"),
    ("de", "2,5 m u. GOK", None, 2.5, "m u. GOK"),
    ("de", "150 mm", None, 0.15, "mm"),
    ("fr", "45 cm", None, 0.45, "cm"),
    ("fr", "3,20 mètres", None, 3.2, "mètres"),
    ("en", "3.0 mbgl", None, 3.0, "mbgl"),
    ("en", "12.5", "m", 12.5, "m"),  # document unit from a column header
    ("es", "4,5 mts", None, 4.5, "mts"),
    # imperial logs
    ("us", "10 ft", None, 3.048, "ft"),
    ("us", "10'", None, 3.048, "'"),
    ("us", "5' 6\"", None, 1.6764, "' \""),
    ("us", "5 ft 6 in", None, 1.6764, "ft in"),
    ("us", "24 in", None, 0.6096, "in"),
    ("us", "12.5", "ft", 3.81, "ft"),
]


@pytest.mark.parametrize(
    ("family", "raw", "default", "metres", "unit_raw"), LENGTHS, ids=[f"{c[0]}:{c[1]}" for c in LENGTHS]
)
def test_lengths_in_metres(family: str, raw: str, default: str | None, metres: float, unit_raw: str) -> None:
    result = parse_length(raw, default_unit=default)
    assert result.metres == pytest.approx(metres), family
    assert result.unit_raw == unit_raw
    assert result.reason is None


@pytest.mark.parametrize(
    ("raw", "default", "why"),
    [
        ("12.5", None, "no unit printed"),
        ("12.5 kPa", None, "not a length"),
        ("12 Std", None, "unknown unit"),
        ("12.5", "kPa", "not a length"),
        ("1,234 m", None, "decimal or as thousands"),
        ("2 - 3 m", "m", "range"),
        ("", "m", "no value"),
        (None, "m", "no value"),
        ("5' 14\"", None, "inches"),
    ],
)
def test_lengths_without_a_decidable_value(raw: str | None, default: str | None, why: str) -> None:
    result = parse_length(raw, default_unit=default)
    assert result.metres is None
    assert result.reason is not None and why in result.reason


def test_printed_unit_wins_over_the_document_unit() -> None:
    assert parse_length("150 mm", default_unit="m").metres == pytest.approx(0.15)


def test_qualified_length_keeps_its_number_and_names_the_qualifier() -> None:
    result = parse_length("> 12 m")
    assert result.metres == 12.0
    assert result.reason is not None and ">" in result.reason


def test_style_reaches_lengths() -> None:
    assert parse_length("1,250 m").metres is None
    assert parse_length("1,250 m", style=NumberStyle(decimal=",")).metres == pytest.approx(1.25)


CONVERSIONS = [
    # unit weight from densities (de, fr, us)
    ("de", 2.0, "t/m³", "kN/m3", 19.6133),
    ("fr", 1.9, "g/cm3", "kN/m3", 18.632635),
    ("us", 120.0, "pcf", "kN/m3", 18.850495656),
    ("si", 19.0, "kN/m^3", "kN/m3", 19.0),
    # strength
    ("de", 41.2, "N/mm²", "MPa", 41.2),
    ("br", 1.0, "kg/cm2", "kPa", 98.0665),
    ("us", 100.0, "psi", "kPa", 689.4757293),
    ("si", 1500.0, "kPa", "MPa", 1.5),
    ("tsf", 2.0, "tsf", "kPa", 191.52103592),
    # hydraulic conductivity
    ("de", 1.0, "m/d", "m/s", 1.1574074074e-05),
    ("us", 1e-4, "cm/s", "m/s", 1e-06),
    # lengths, angles, ratios
    ("us", 10.0, "feet", "m", 3.048),
    ("us survey", 1000.0, "ftUS", "m", 304.8006096),
    ("gon", 100.0, "gon", "°", 90.0),
    ("permille", 5.0, "‰", "%", 0.5),
]


@pytest.mark.parametrize(("family", "value", "unit", "target", "expected"), CONVERSIONS)
def test_convert(family: str, value: float, unit: str, target: str, expected: float) -> None:
    assert convert(value, unit, target) == pytest.approx(expected, rel=1e-9), family


@pytest.mark.parametrize(
    ("value", "unit", "target"),
    [(1.0, "m", "kPa"), (1.0, "furlong", "m"), (1.0, None, "m"), (1.0, "m", "parsec"), (1.0, "%", "m")],
)
def test_convert_refuses_unknown_or_incompatible_units(value: float, unit: str | None, target: str) -> None:
    assert convert(value, unit, target) is None


def test_to_metres() -> None:
    assert to_metres(250.0, "mm") == pytest.approx(0.25)
    assert to_metres(3.0, "ft") == pytest.approx(0.9144)
    assert to_metres(3.0, "kPa") is None
    assert to_metres(3.0, None) is None


def test_aliases_are_case_and_superscript_insensitive() -> None:
    assert canonical_unit("KPA") == "kPa"
    assert canonical_unit("kN/m³") == canonical_unit("kn/m3") == "kN/m3"
    assert canonical_unit("Mg/m3") == "t/m3"
    assert canonical_unit("m (approx.)") == "m"
    assert canonical_unit("furlongs") is None
    assert lookup_unit(None) is None


def test_unit_aliases_do_not_collide() -> None:
    assert unit_alias_collisions() == ()


def test_every_unit_has_a_known_dimension_with_a_base_unit() -> None:
    data = load_data("units.yaml")
    dimensions = data["dimensions"]
    for key, spec in data["units"].items():
        assert spec["dimension"] in dimensions, key
        base = lookup_unit(dimensions[spec["dimension"]])
        assert base is not None and base.factor == 1.0, key


@pytest.mark.parametrize(
    ("raw", "value", "unit"),
    [("45 %", 45.0, "%"), ("4,5", 4.5, None), ("3 ‰", 0.3, "‰"), ("12 Prozent", 12.0, "Prozent")],
)
def test_percent(raw: str, value: float, unit: str | None) -> None:
    result = parse_percent(raw)
    assert result.value == pytest.approx(value)
    assert result.unit == unit


def test_percent_rejects_other_units() -> None:
    assert parse_percent("5 m").value is None
    assert parse_percent("5 parsec").value is None


TARGET_TEST_NAMES = [
    "Watercontent",
    "Consistency",
    "Unitweight",
    "UCS",
    "Tensile strength",
    "CAI",
    "RMR",
    "Q",
    "GSI",
    "FrictionAngle",
    "Cohesion",
    "Grainsize-fines",
    "LiquidLimit",
    "PlasticityLimit",
    "PlasticityIndex",
    "ConsistencyIndex",
    "HydraulicCoefficient",
    "E-Modulus",
    "PoissonsRatio",
]


def test_test_names_are_the_target_format_fields_in_order() -> None:
    assert [spec.name for spec in lab_tests()] == TARGET_TEST_NAMES
    for spec in lab_tests():
        assert lookup_unit(spec.unit) is not None, spec.name


@pytest.mark.parametrize(
    ("printed", "name"),
    [
        ("Wassergehalt", "Watercontent"),
        ("moisture content", "Watercontent"),
        ("teneur en eau", "Watercontent"),
        ("Einaxiale Druckfestigkeit", "UCS"),
        ("resistência à compressão simples", "UCS"),
        ("Fließgrenze", "LiquidLimit"),
        ("limite de liquidité", "LiquidLimit"),
        ("Durchlässigkeitsbeiwert", "HydraulicCoefficient"),
        ("coefficient of permeability", "HydraulicCoefficient"),
        ("Reibungswinkel", "FrictionAngle"),
        ("ángulo de fricción", "FrictionAngle"),
        ("E-Modul", "E-Modulus"),
        ("  plasticity   index ", "PlasticityIndex"),
        ("Cerchar abrasivity index", "CAI"),
        ("SPT", None),
        ("", None),
    ],
)
def test_match_lab_test(printed: str, name: str | None) -> None:
    assert match_lab_test(printed) == name


@pytest.mark.parametrize(
    ("name", "value", "unit", "expected", "canonical"),
    [
        ("UCS", "41,2", "N/mm²", 41.2, "MPa"),
        ("UCS", "41200 kPa", None, 41.2, "MPa"),
        ("Unitweight", "2,05", "t/m3", 20.1036325, "kN/m3"),
        ("Unitweight", "19.5 kN/m³", None, 19.5, "kN/m3"),
        ("Cohesion", "0.25", "kg/cm2", 24.516625, "kPa"),
        ("HydraulicCoefficient", "1.2E-05", "m/s", 1.2e-05, "m/s"),
        ("HydraulicCoefficient", "0,5", "m/d", 5.787037037e-06, "m/s"),
        ("PlasticityIndex", "23", "%", 23.0, "-"),
        ("CAI", "2.1", None, 2.1, "-"),
        ("Watercontent", "23,4 %", None, 23.4, "%"),
        ("FrictionAngle", "32°", None, 32.0, "deg"),
    ],
)
def test_lab_values_in_canonical_units(
    name: str, value: str, unit: str | None, expected: float, canonical: str
) -> None:
    result = normalise_lab_test_value(name, value, unit)
    assert result.value == pytest.approx(expected, rel=1e-9)
    assert result.unit == canonical


@pytest.mark.parametrize(
    ("name", "value", "unit", "why"),
    [
        ("UCS", "41", None, "no unit printed"),
        ("Cohesion", "12", "m", "does not convert"),
        ("Colour", "12", None, "not a Test Results field"),
        ("UCS", "30-40", "MPa", "range"),
    ],
)
def test_lab_values_that_cannot_be_normalised(name: str, value: str, unit: str | None, why: str) -> None:
    result = normalise_lab_test_value(name, value, unit)
    assert result.value is None
    assert result.reason is not None and why in result.reason


# -------------------------------------------------------------------------------------------------
# Properties
# -------------------------------------------------------------------------------------------------

_DIMENSION_UNITS = {
    "length": ["m", "cm", "mm", "ft", "in", "km"],
    "stress": ["kPa", "MPa", "kg/cm2", "psi", "bar", "t/m2"],
    "unit_weight": ["kN/m3", "t/m3", "g/cm3", "pcf"],
    "velocity": ["m/s", "cm/s", "m/d"],
}


@settings(max_examples=200, deadline=None)
@given(
    value=st.floats(min_value=-1e6, max_value=1e6, allow_nan=False),
    data=st.data(),
    dimension=st.sampled_from(sorted(_DIMENSION_UNITS)),
)
def test_convert_round_trips(value: float, data: st.DataObject, dimension: str) -> None:
    unit = data.draw(st.sampled_from(_DIMENSION_UNITS[dimension]))
    target = data.draw(st.sampled_from(_DIMENSION_UNITS[dimension]))
    there = convert(value, unit, target)
    assert there is not None
    back = convert(there, target, unit)
    assert back == pytest.approx(value, rel=1e-9, abs=1e-9)


@settings(max_examples=200, deadline=None)
@given(
    metres=st.floats(min_value=0, max_value=5000, allow_nan=False),
    decimal=st.sampled_from([",", "."]),
    unit=st.sampled_from(["m", "cm", "mm"]),
)
def test_printed_length_parses_back(metres: float, decimal: str, unit: str) -> None:
    factor = {"m": 1, "cm": 100, "mm": 1000}[unit]
    printed = format_number(metres * factor, decimal=decimal, decimals=2)  # type: ignore[arg-type]
    result = parse_length(f"{printed} {unit}", style=NumberStyle(decimal=decimal))  # type: ignore[arg-type]
    assert result.metres == pytest.approx(round(metres * factor, 2) / factor, abs=1e-6)


@settings(max_examples=300, deadline=None)
@given(st.text(max_size=30), st.sampled_from([None, "m", "ft", "kPa"]))
def test_parse_length_never_raises(text: str, default: str | None) -> None:
    result = parse_length(text, default_unit=default)
    assert result.metres is not None or result.reason
