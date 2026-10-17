"""Fictional values only: locale-aware number parsing across document families (BACKEND.md 7.8)."""

from __future__ import annotations

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.normalize.api import NumberStyle
from app.normalize.numbers import (
    after_field_label,
    analyse_number,
    format_number,
    learn_style,
    parse_number,
)

# (family, printed, value, unit as printed, qualifier as printed)
PARSED = [
    # German / Austrian logs: decimal comma, point grouping
    ("de", "12,00", 12.0, None, None),
    ("de", "1.234,56", 1234.56, None, None),
    ("de", "7.797.153,614", 7797153.614, None, None),
    ("de", "3,20 m", 3.2, "m", None),
    ("de", "12,5m", 12.5, "m", None),
    ("de", "ca. 4,5 m", 4.5, "m", "ca."),
    ("de", "17,5 kN/m³", 17.5, "kN/m³", None),
    ("de", "2,50 m u. GOK", 2.5, "m u. GOK", None),
    # English-language logs: decimal point, comma grouping
    ("en", "1,234.56", 1234.56, None, None),
    ("en", "3.20 m", 3.2, "m", None),
    ("en", "approx. 3.5m", 3.5, "m", "approx."),
    ("en", "> 50", 50.0, None, ">"),
    ("en", "<0.5", 0.5, None, "<"),
    ("en", "50+", 50.0, None, "+"),
    ("en", "(23)", 23.0, None, None),
    ("en", "12.", 12.0, None, None),
    (".5 fraction", ".5", 0.5, None, None),
    # French / Nordic: (narrow) no-break and thin spaces as grouping
    ("fr", "7\u202f797\u202f153,614", 7797153.614, None, None),
    ("fr", "12\u00a0500", 12500.0, None, None),
    ("fr", "env. 2,5 m", 2.5, "m", "env."),
    ("sv", "6\u2009123\u2009456,7", 6123456.7, None, None),
    # Swiss: apostrophe grouping
    ("ch", "1'234.50", 1234.5, None, None),
    ("ch", "1\u2019234.50", 1234.5, None, None),
    # Spanish, Portuguese, Dutch qualifiers
    ("es", "aprox. 12,5", 12.5, None, "aprox."),
    ("pt", "1.234,5 kPa", 1234.5, "kPa", None),
    ("nl", "ong. 3,4 m", 3.4, "m", "ong."),
    # signs
    ("unicode minus", "\u221212,5", -12.5, None, None),
    ("leading plus", "+3.20 m", 3.2, "m", None),
    # lab values: scientific notation, percent
    ("lab", "45%", 45.0, "%", None),
    ("lab", "1.2E-05 m/s", 1.2e-05, "m/s", None),
    ("lab", "1,2·10⁻⁵ m/s", 1.2e-05, "m/s", None),
    ("lab", "2 x 10^-6 m/s", 2e-06, "m/s", None),
    ("lab", "1.2 E-05 m/s", 1.2e-05, "m/s", None),
    ("axis label", "512345 E", 512345.0, "E", None),
    # unambiguous although three decimals follow the separator
    ("decimal by leading zero", "0,123", 0.123, None, None),
    ("decimal by long integer part", "1234,567", 1234.567, None, None),
    ("both separators", "1,234.567", 1234.567, None, None),
]


@pytest.mark.parametrize(("family", "raw", "value", "unit", "qualifier"), PARSED, ids=[c[1] for c in PARSED])
def test_parses_printed_numbers(
    family: str, raw: str, value: float, unit: str | None, qualifier: str | None
) -> None:
    result = parse_number(raw)
    assert result.value == pytest.approx(value), family
    assert result.unit == unit
    assert result.qualifier == qualifier
    assert result.ambiguous is False
    assert result.reason is None


NOT_NUMBERS = [
    ("2-3", "range"),
    ("2 \u2013 3 m", "range"),
    ("12 to 15 m", "range"),
    ("3 bis 4", "range"),
    ("3 a 4", "range"),
    ("12.5-13.0m", "range"),
    ("5 7 9", "grouping"),
    ("1.2.3", "grouping"),
    ("12 m 15", "more than one number"),
    ("50/12cm", "more than one number"),
    ("2 x 105", "more than one number"),
    ("1e5 5", "more than one number"),
    ("n.a.", "no number"),
    ("-", "no number"),
    ("kN/m3", "unexpected text"),
    ("Tiefe 3,5", "unexpected text"),
    ("", "no value"),
    ("   ", "no value"),
    ("1e999", "out of range"),
]


@pytest.mark.parametrize(("raw", "why"), NOT_NUMBERS)
def test_ranges_lists_and_text_are_not_numbers(raw: str, why: str) -> None:
    result = parse_number(raw)
    assert result.value is None
    assert result.reason is not None and why in result.reason


def test_none_is_no_value() -> None:
    assert parse_number(None).value is None
    assert parse_number(None).reason == "no value printed"


@pytest.mark.parametrize("raw", ["1,234", "1.234", "512,345", "12.500 m"])
def test_ambiguous_grouping_is_not_decided_without_a_style(raw: str) -> None:
    result = parse_number(raw)
    assert result.value is None
    assert result.ambiguous is True
    assert result.reason


@pytest.mark.parametrize(
    ("raw", "decimal", "value"),
    [
        ("1,234", ",", 1.234),
        ("1,234", ".", 1234.0),
        ("1.234", ",", 1234.0),
        ("1.234", ".", 1.234),
        ("12.500 m", ",", 12500.0),
    ],
)
def test_document_style_decides_ambiguous_grouping(raw: str, decimal: str, value: float) -> None:
    style = NumberStyle(decimal=decimal)  # type: ignore[arg-type]
    result = parse_number(raw, style=style)
    assert result.value == pytest.approx(value)
    assert result.ambiguous is False


def test_unambiguous_text_wins_over_the_style() -> None:
    assert parse_number("1,234.56", style=NumberStyle(decimal=",")).value == pytest.approx(1234.56)
    assert parse_number("12,5", style=NumberStyle(decimal=".")).value == pytest.approx(12.5)


@pytest.mark.parametrize(
    ("family", "raws", "decimal"),
    [
        ("de log", ["12,50", "3,20 m", "1.234", "7.797.153", "1,234"], ","),
        ("en log", ["12.50", "1,234,567", "0.5 m", "1,234"], "."),
        ("fr log", ["2,5 m", "7\u202f797\u202f153,614", "1,234"], ","),
        ("mixed", ["12.5", "12,5", "3.2", "3,2"], None),
        ("only ambiguous", ["1,234", "5.678"], None),
        ("no numbers", ["n.a.", "-", ""], None),
    ],
)
def test_learn_style_from_unambiguous_numbers(family: str, raws: list[str], decimal: str | None) -> None:
    assert learn_style(raws).decimal == decimal, family


def test_learned_style_resolves_the_documents_ambiguous_numbers() -> None:
    page = ["Tiefe 12,50 m", "3,20", "1,234", "512,345"]
    style = learn_style(page)
    assert parse_number("1,234", style=style).value == pytest.approx(1.234)
    assert parse_number("512,345", style=style).value == pytest.approx(512.345)


def test_evidence_of_grouping_counts_for_the_other_separator() -> None:
    assert analyse_number("7.797.153").decimal_evidence == ","
    assert analyse_number("1,234,567").decimal_evidence == "."
    assert analyse_number("1,234").decimal_evidence is None


# -------------------------------------------------------------------------------------------------
# Properties
# -------------------------------------------------------------------------------------------------

_GROUPS = {",": [None, ".", " ", "\u202f", "'"], ".": [None, ",", " ", "\u00a0", "\u2019"]}


@settings(max_examples=300, deadline=None)
@given(
    value=st.floats(min_value=-1e9, max_value=1e9, allow_nan=False, allow_infinity=False),
    decimals=st.integers(min_value=0, max_value=4),
    decimal=st.sampled_from([",", "."]),
    data=st.data(),
)
def test_format_then_parse_round_trips(
    value: float, decimals: int, decimal: str, data: st.DataObject
) -> None:
    group = data.draw(st.sampled_from(_GROUPS[decimal]))
    text = format_number(value, decimal=decimal, group=group, decimals=decimals)  # type: ignore[arg-type]
    result = parse_number(text, style=NumberStyle(decimal=decimal))  # type: ignore[arg-type]
    assert result.value is not None, (text, result.reason)
    assert result.value == pytest.approx(float(f"{value:.{decimals}f}"), rel=1e-12, abs=10.0**-decimals)
    assert result.ambiguous is False


@settings(max_examples=200, deadline=None)
@given(value=st.floats(min_value=-1e12, max_value=1e12, allow_nan=False, allow_infinity=False))
def test_repr_parses_to_the_same_float(value: float) -> None:
    result = parse_number(repr(value), style=NumberStyle(decimal="."))
    assert result.value == value


@settings(max_examples=500, deadline=None)
@given(st.text(max_size=40))
def test_never_raises_and_values_are_finite(text: str) -> None:
    result = parse_number(text)
    assert result.value is None or math.isfinite(result.value)
    if result.value is None:
        assert result.reason


@settings(max_examples=200, deadline=None)
@given(
    st.text(alphabet="0123456789.,' \u00a0\u202f-+~<>mkN%/abc", max_size=20),
    st.sampled_from([None, ",", "."]),
)
def test_parse_is_deterministic_and_style_never_creates_ambiguity(text: str, decimal: str | None) -> None:
    style = NumberStyle(decimal=decimal)  # type: ignore[arg-type]
    first, second = parse_number(text, style=style), parse_number(text, style=style)
    assert first == second
    if decimal is not None:
        assert first.ambiguous is False


@settings(max_examples=100, deadline=None)
@given(
    st.lists(st.floats(min_value=0.01, max_value=1e6, allow_nan=False), min_size=1, max_size=8),
    st.sampled_from([",", "."]),
)
def test_learn_style_finds_the_decimal_of_unambiguous_numbers(values: list[float], decimal: str) -> None:
    raws = [format_number(v, decimal=decimal, decimals=2) for v in values]  # type: ignore[arg-type]
    assert learn_style(raws).decimal == decimal


@pytest.mark.parametrize(
    ("raw", "value"),
    [
        ("EL(+) 7.3 M", "7.3 M"),
        ("EL.(+) -12.6 M", "-12.6 M"),
        ("GL(-)3.1 m", "3.1 m"),
        ("Kote: +41,25 m", "+41,25 m"),
        ("H = 88.4", "88.4"),
    ],
)
def test_value_after_a_field_label(raw: str, value: str) -> None:
    """A cell that prints its own label before the value ("EL(+) 7.3 M"): the value after the label."""
    assert after_field_label(raw) == value


@pytest.mark.parametrize("raw", ["7.3", "-12.6 m", "(+) 4.0", "", None])
def test_no_field_label_no_value(raw: str | None) -> None:
    assert after_field_label(raw) is None
