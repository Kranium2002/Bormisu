"""Printed dates -> ISO dates, only when unambiguous (BACKEND.md 7.8).

Accepted: year first ("2026-03-04", "2026/03/04", "2026.03.04", "20260304"), day.month.year with dots
(the dot convention is day first everywhere: "04.03.2026", "4.3.26"), month names in several languages
(data/units.yaml `dates.months`: "4 March 2026", "March 4, 2026", "4. März 2026", "4 de marzo de 2026",
"04-Mar-2026"), day/month-year with a slash then a dash ("19/8-08", day first; data/units.yaml
`slash_dash_day_first`). "03/04/2026" is ambiguous (day/month order differs by country) unless one part
is above 12 or both parts are equal. A time after the date is ignored. Two-digit years follow the documented
pivot in data/units.yaml (YY below the pivot is 20YY, otherwise 19YY).
"""

from __future__ import annotations

import datetime as dt
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from app.normalize.api import DateResult
from app.normalize.numbers import ascii_digits, load_data, str_list

_TIME = re.compile(
    r"(?:[T\s,]+|^)[0-9]{1,2}[:h][0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?\s*(?:[ap]\.?\s?m\.?|uhr|h)?"
    r"(?:\s*(?:Z|[+-][0-9]{2}:?[0-9]{2}))?\s*$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class _Config:
    months: dict[str, int]
    ambiguous_names: frozenset[str]
    pivot: int | None
    year_min: int
    year_max: int
    slash_dash_day_first: bool = False


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).rstrip(".")


@lru_cache(maxsize=1)
def _config() -> _Config:
    data = load_data("units.yaml").get("dates") or {}
    months: dict[str, int] = {}
    ambiguous: set[str] = set()
    for month, names in (data.get("months") or {}).items():
        for name in str_list(names):
            for key in {name.casefold().rstrip("."), _fold(name)}:
                if key in months and months[key] != int(month):
                    ambiguous.add(key)
                months.setdefault(key, int(month))
    for key in ambiguous:
        months.pop(key, None)
    pivot = data.get("two_digit_year_pivot")
    years = data.get("year_range") or [1850, 2100]
    return _Config(
        months=months,
        ambiguous_names=frozenset(ambiguous),
        pivot=None if pivot is None else int(pivot),
        year_min=int(years[0]),
        year_max=int(years[1]),
        slash_dash_day_first=bool(data.get("slash_dash_day_first", False)),
    )


def ambiguous_month_names() -> frozenset[str]:
    """Month names listed under two months in data/units.yaml (must be empty)."""
    return _config().ambiguous_names


def _year(text: str) -> tuple[int | None, str | None]:
    if len(text) == 4:
        return int(text), None
    if len(text) == 2:
        pivot = _config().pivot
        if pivot is None:
            return None, "two-digit year and no century rule configured"
        value = int(text)
        return (2000 + value if value < pivot else 1900 + value), None
    return None, f"'{text}' is not a year"


def _build(raw: str, year: int | None, month: int, day: int, why: str | None = None) -> DateResult:
    if year is None:
        return DateResult(None, raw=raw, reason=why or "no year")
    cfg = _config()
    if not cfg.year_min <= year <= cfg.year_max:
        return DateResult(None, raw=raw, reason=f"year {year} outside {cfg.year_min}-{cfg.year_max}")
    try:
        value = dt.date(year, month, day)
    except ValueError:
        return DateResult(None, raw=raw, reason="not a calendar date")
    return DateResult(value.isoformat(), raw=raw)


def _numeric(raw: str, text: str) -> DateResult | None:
    if match := re.fullmatch(r"([0-9]{4})([-/.])([0-9]{1,2})\2([0-9]{1,2})", text):
        return _build(raw, int(match.group(1)), int(match.group(3)), int(match.group(4)))
    if match := re.fullmatch(r"(19[0-9]{2}|20[0-9]{2})([0-9]{2})([0-9]{2})", text):
        return _build(raw, int(match.group(1)), int(match.group(2)), int(match.group(3)))
    if match := re.fullmatch(r"([0-9]{1,2})\.\s?([0-9]{1,2})\.\s?([0-9]{4}|[0-9]{2})", text):
        year, why = _year(match.group(3))
        return _build(raw, year, int(match.group(2)), int(match.group(1)), why)
    if match := re.fullmatch(r"([0-9]{1,2})([-/])([0-9]{1,2})\2([0-9]{4}|[0-9]{2})", text):
        first, second = int(match.group(1)), int(match.group(3))
        year, why = _year(match.group(4))
        if first == second:
            return _build(raw, year, first, second, why)
        if first > 12 >= second:
            return _build(raw, year, second, first, why)
        if second > 12 >= first:
            return _build(raw, year, first, second, why)
        if first > 12 and second > 12:
            return DateResult(None, raw=raw, reason="neither part can be a month")
        return DateResult(None, raw=raw, reason="day and month order is ambiguous")
    if (match := re.fullmatch(r"([0-9]{1,2})/([0-9]{1,2})-([0-9]{4}|[0-9]{2})", text)) and (
        _config().slash_dash_day_first
    ):
        year, why = _year(match.group(3))
        return _build(raw, year, int(match.group(2)), int(match.group(1)), why)
    if re.fullmatch(r"[0-9]{1,2}[-/.][0-9]{4}|[0-9]{4}[-/.][0-9]{1,2}", text):
        return DateResult(None, raw=raw, reason="month and year only; no day printed")
    if re.fullmatch(r"[0-9]{4}", text):
        return DateResult(None, raw=raw, reason="year only; no day printed")
    return None


def _with_month_name(raw: str, text: str) -> DateResult:
    tokens = re.findall(r"[0-9]+|[^\W\d_]+\.?", text)
    months = _config().months
    month_positions = [(i, months[_fold(t)]) for i, t in enumerate(tokens) if _fold(t) in months]
    if not month_positions:
        return DateResult(None, raw=raw, reason="not a date")
    if len({m for _, m in month_positions}) > 1:
        return DateResult(None, raw=raw, reason="more than one month named")
    position, month = month_positions[0]
    numbers = [(i, t) for i, t in enumerate(tokens) if t.isdigit()]
    four = [(i, t) for i, t in numbers if len(t) == 4]
    if len(numbers) == 1 and four:
        return DateResult(None, raw=raw, reason="month and year only; no day printed")
    if len(numbers) != 2:
        return DateResult(None, raw=raw, reason="a date with a month name needs one day and one year")
    year: int | None
    why: str | None = None
    if len(four) == 1:
        day_text = next(t for i, t in numbers if (i, t) != four[0])
        year = int(four[0][1])
    else:
        before = [t for i, t in numbers if i < position]
        after = [t for i, t in numbers if i > position]
        if len(before) == 1 and len(after) == 1 and len(after[0]) == 2:
            day_text = before[0]
            year, why = _year(after[0])
        else:
            return DateResult(None, raw=raw, reason="cannot tell the day from a two-digit year")
    if len(day_text) > 2:
        return DateResult(None, raw=raw, reason=f"'{day_text}' is not a day")
    return _build(raw, year, month, int(day_text), why)


def parse_date(raw: str | None) -> DateResult:
    """An ISO date (YYYY-MM-DD) when the printed date is unambiguous; None with a reason otherwise."""
    if raw is None or not raw.strip():
        return DateResult(None, raw=raw, reason="no date printed")
    if len(raw) > 80:
        return DateResult(None, raw=raw, reason="text too long to be a date")
    text = ascii_digits(unicodedata.normalize("NFKC", raw)).strip()
    text = _TIME.sub("", text).strip(" ,;")
    text = re.sub(r"\s+", " ", text)
    numeric = _numeric(raw, text)
    if numeric is not None:
        return numeric
    if re.search(r"[0-9]\.?\s*(?:-|\u2013|\u2014|/|bis|to|until|till|au|al|a|à|até|tot)\s*[0-9]", text, re.I):
        return DateResult(None, raw=raw, reason="a range or list of dates, not one date")
    if not any(ch.isalpha() for ch in text):
        return DateResult(None, raw=raw, reason="not a date")
    return _with_month_name(raw, text)
