"""Fictional values only: printed dates to ISO dates, only when unambiguous (BACKEND.md 7.8)."""

from __future__ import annotations

import datetime as dt

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.normalize.dates import ambiguous_month_names, parse_date
from app.normalize.numbers import load_data

DATES = [
    # ISO and year-first forms
    ("iso", "2026-03-04", "2026-03-04"),
    ("iso slashes", "2026/3/4", "2026-03-04"),
    ("iso compact", "20260304", "2026-03-04"),
    ("iso with time", "2026-03-04T10:30:00Z", "2026-03-04"),
    # day.month.year (German, Swiss, Nordic, Eastern European logs)
    ("de", "04.03.2026", "2026-03-04"),
    ("de short year", "4.3.26", "2026-03-04"),
    ("de last century", "04.03.87", "1987-03-04"),
    ("de with time", "04.03.2026 14:30", "2026-03-04"),
    # slashes decided by a part above 12, or equal parts
    ("uk", "13/04/2026", "2026-04-13"),
    ("us", "04/13/2026", "2026-04-13"),
    ("equal parts", "04/04/2026", "2026-04-04"),
    # day/month, a dash, then the year (handwritten form style): day first
    ("slash dash short year", "3/7-11", "2011-07-03"),
    ("slash dash both small", "5/9-99", "1999-09-05"),
    ("slash dash full year", "23/1-2004", "2004-01-23"),
    # month names in several languages
    ("en", "4 March 2026", "2026-03-04"),
    ("en us", "March 4, 2026", "2026-03-04"),
    ("en ordinal", "4th of July 2026", "2026-07-04"),
    ("en weekday", "Mon, 4 Mar 2026", "2026-03-04"),
    ("en abbreviated", "04-Mar-2026", "2026-03-04"),
    ("en short year", "4-Mar-26", "2026-03-04"),
    ("de", "4. März 2026", "2026-03-04"),
    ("de abbreviated", "15 Dez. 2026", "2026-12-15"),
    ("at", "3. Jänner 2026", "2026-01-03"),
    ("fr", "le 4 mars 2026", "2026-03-04"),
    ("fr no accent", "4 fevrier 2026", "2026-02-04"),
    ("es", "4 de marzo de 2026", "2026-03-04"),
    ("pt", "4 de fevereiro de 2026", "2026-02-04"),
    ("it", "4 ottobre 2026", "2026-10-04"),
    ("nl", "4 mei 2026", "2026-05-04"),
    ("sv", "12 juli 2026", "2026-07-12"),
    ("no", "1. desember 2026", "2026-12-01"),
]


@pytest.mark.parametrize(("family", "raw", "iso"), DATES, ids=[f"{c[0]}:{c[1]}" for c in DATES])
def test_unambiguous_dates(family: str, raw: str, iso: str) -> None:
    result = parse_date(raw)
    assert result.iso == iso, (family, result.reason)
    assert result.raw == raw
    assert result.reason is None


UNDECIDED = [
    ("03/04/2026", "ambiguous"),
    ("03-04-2026", "ambiguous"),
    ("05/06/26", "ambiguous"),
    ("31.02.2026", "not a calendar date"),
    ("04.03.1700", "outside"),
    ("Mar 2026", "no day"),
    ("03/2026", "no day"),
    ("2026", "no day"),
    ("04.-06.03.2026", "range"),
    ("4 to 6 March 2026", "range"),
    ("2026-03-04 - 2026-03-06", "range"),
    ("4 Mar 26 Mar 2026", "one day and one year"),
    ("Mar 4 26", "two-digit year"),
    ("13/14/2026", "neither part"),
    ("3/14-11", "not a calendar date"),
    ("abc", "not a date"),
    ("", "no date"),
    (None, "no date"),
]


@pytest.mark.parametrize(("raw", "why"), UNDECIDED)
def test_undecided_dates_say_why(raw: str | None, why: str) -> None:
    result = parse_date(raw)
    assert result.iso is None
    assert result.reason is not None and why in result.reason


def test_month_names_are_not_shared_between_months() -> None:
    assert ambiguous_month_names() == frozenset()


def test_century_rule_is_documented_in_data() -> None:
    dates = load_data("units.yaml")["dates"]
    pivot = dates["two_digit_year_pivot"]
    assert isinstance(pivot, int)
    assert parse_date(f"01.01.{pivot - 1:02d}").iso == f"20{pivot - 1:02d}-01-01"
    assert parse_date(f"01.01.{pivot:02d}").iso == f"19{pivot:02d}-01-01"


# -------------------------------------------------------------------------------------------------
# Properties
# -------------------------------------------------------------------------------------------------

_MONTHS = load_data("units.yaml")["dates"]["months"]


@settings(max_examples=300, deadline=None)
@given(
    day=st.dates(min_value=dt.date(1950, 1, 1), max_value=dt.date(2099, 12, 31)),
    form=st.sampled_from(["iso", "dots", "name", "name first", "iso slashes"]),
    data=st.data(),
)
def test_formatted_dates_parse_back(day: dt.date, form: str, data: st.DataObject) -> None:
    if form == "iso":
        text = day.isoformat()
    elif form == "iso slashes":
        text = f"{day.year}/{day.month}/{day.day}"
    elif form == "dots":
        text = f"{day.day:02d}.{day.month:02d}.{day.year}"
    else:
        name = data.draw(st.sampled_from([str(n) for n in _MONTHS[day.month]]))
        text = f"{day.day} {name} {day.year}" if form == "name" else f"{name} {day.day}, {day.year}"
    assert parse_date(text).iso == day.isoformat(), text


@settings(max_examples=200, deadline=None)
@given(
    first=st.integers(min_value=1, max_value=12),
    second=st.integers(min_value=1, max_value=12),
    year=st.integers(min_value=1950, max_value=2099),
    sep=st.sampled_from(["/", "-"]),
)
def test_slash_dates_with_two_month_candidates_are_never_guessed(
    first: int, second: int, year: int, sep: str
) -> None:
    result = parse_date(f"{first:02d}{sep}{second:02d}{sep}{year}")
    if first == second:
        assert result.iso == f"{year}-{first:02d}-{first:02d}"
    else:
        assert result.iso is None


@settings(max_examples=500, deadline=None)
@given(st.one_of(st.none(), st.text(max_size=30)))
def test_never_raises_and_iso_is_a_real_date(text: str | None) -> None:
    result = parse_date(text)
    if result.iso is None:
        assert result.reason
    else:
        assert dt.date.fromisoformat(result.iso)


@settings(max_examples=200, deadline=None)
@given(st.text(alphabet="0123456789./- marchMaiJunOkt", max_size=20))
def test_parsing_an_iso_result_is_idempotent(text: str) -> None:
    result = parse_date(text)
    if result.iso is not None:
        assert parse_date(result.iso).iso == result.iso
