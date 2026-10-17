"""Locale-aware number parsing (BACKEND.md 7.8) and the data-file loader shared by the normalisers.

One parser for every printed number: decimal comma or point, digit grouping by points, commas, spaces
(normal, no-break, figure, thin, narrow no-break) or apostrophes, Unicode minus, a leading "+",
scientific notation, units glued to the number and qualifiers (">", "ca." ...: data/units.yaml).
Ranges and lists are not numbers. When the separator cannot be decided ("1,234") the value is None and
`ambiguous` is True, unless a NumberStyle learned from the same document decides it.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Literal

import yaml

from app.config import get_settings
from app.normalize.api import NumberResult, NumberStyle

GROUP_SPACES = " \u00a0\u2007\u2008\u2009\u200a\u202f"
APOSTROPHES = "'\u2019\u02bc"
MINUS_SIGNS = "-\u2212\u2012\u2013\u2014\ufe63\uff0d"
SUPERSCRIPT_DIGITS = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺", "0123456789-+")

_GROUP_CHARS = GROUP_SPACES + APOSTROPHES
# Digits with separators; a separator only counts when a digit follows it.
_BODY = re.compile(rf"(?:[0-9]|[.,](?=[0-9]))(?:[0-9]|[.,](?=[0-9])|[{re.escape(_GROUP_CHARS)}](?=[0-9]))*")
# "1.2E-05", "1.2e5"; after a space only with a sign ("1.2 E-05"), so "512345 E" stays an axis label.
_EXPONENT = re.compile(r"(?:[eE]([+\-\u2212]?[0-9]{1,3})|\s[eE]([+\-\u2212][0-9]{1,3}))(?![0-9])")
# "x 10^-5", "×10-5", "·10⁻⁵": an exponent needs "^", a sign or superscript digits ("2 x 105" is no power).
_TIMES_TEN = re.compile(
    r"\s*[x×·*]\s*10\s*("
    r"(?:\^|\*\*)\s*[+\-\u2212]?\s*[0-9]{1,3}"
    r"|[+\-\u2212]\s*[0-9]{1,3}"
    r"|[⁻⁺]?[⁰¹²³⁴-⁹]{1,3}"
    r")(?![0-9])"
)
_OPEN_BRACKETS = "([{"
_CLOSE_BRACKETS = ")]}"


# -------------------------------------------------------------------------------------------------
# Data files
# -------------------------------------------------------------------------------------------------


@lru_cache(maxsize=16)
def load_data(name: str) -> dict[str, Any]:
    """A YAML file from backend/data (cached). Every vocabulary of the normalisers lives there."""
    with (get_settings().data_dir / name).open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{name} must hold a mapping")
    return data


def str_list(value: Any) -> list[str]:
    """A YAML list as strings (YAML may read some entries as numbers or booleans)."""
    if value is None:
        return []
    if isinstance(value, list | tuple):
        return [str(item) for item in value if item is not None]
    return [str(value)]


# A short field label printed in the same cell before the value ("EL(+) 5.7 M", "GL. 12,3 m", "H = 4.0"):
# letters and dots, an optional bracketed sign convention, then an optional ":" or "=".
_FIELD_LABEL = re.compile(
    r"^\s*[^\W\d_][^\d+\-\u2212=:()]{0,15}?\s*(?:\(\s*[+\-\u2212\u00b1]\s*\))?\s*[:=]?\s*"
    r"(?=[+\-\u2212]?\s*[0-9])"
)


def after_field_label(raw: str | None) -> str | None:
    """The value after a short field label the cell prints before it, or None when there is no such label.

    Only a fallback for a value that does not parse as printed: a qualifier ("ca.", "approx.") parses on
    its own and keeps its meaning."""
    if raw is None:
        return None
    match = _FIELD_LABEL.match(raw)
    if match is None or match.end() == 0:
        return None
    return raw[match.end() :].strip() or None


def ascii_digits(text: str) -> str:
    """Decimal digits of any script as ASCII digits (superscripts are left alone)."""
    if text.isascii():
        return text
    return "".join(str(unicodedata.decimal(ch)) if ch.isdecimal() and not ch.isascii() else ch for ch in text)


def word_pattern(term: str) -> str:
    """A regex for `term` that only matches at word boundaries where the term starts or ends with a word
    character (so "/tn" may follow a letter, "bgl" may not be part of a longer word)."""
    escaped = re.escape(term)
    start = r"(?<!\w)" if term[:1].isalnum() else ""
    end = r"(?!\w)" if term[-1:].isalnum() else ""
    return f"{start}{escaped}{end}"


# -------------------------------------------------------------------------------------------------
# Vocabulary
# -------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Vocabulary:
    qualifiers: tuple[str, ...]
    range_pattern: re.Pattern[str]
    min_evidence: int
    min_share: float


@lru_cache(maxsize=1)
def _vocabulary() -> _Vocabulary:
    data = load_data("units.yaml")
    qualifiers = sorted(set(str_list(data.get("number_qualifiers"))), key=len, reverse=True)
    words = sorted(set(str_list(data.get("range_words"))), key=len, reverse=True)
    alternatives = "|".join(word_pattern(word) for word in words) or r"(?!)"
    range_pattern = re.compile(
        rf"^\s*(?:{alternatives})\s*[+{re.escape(MINUS_SIGNS)}]?\s*[.,]?[0-9]", re.IGNORECASE
    )
    style = data.get("number_style") or {}
    return _Vocabulary(
        qualifiers=tuple(qualifiers),
        range_pattern=range_pattern,
        min_evidence=int(style.get("min_evidence", 1)),
        min_share=float(style.get("min_share", 0.8)),
    )


# -------------------------------------------------------------------------------------------------
# Parsing
# -------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Body:
    value: float | None
    decimal: str | None = None  # "." or "," decided as the decimal separator by the text itself
    group: str | None = None  # "." or "," decided as the grouping separator by the text itself
    ambiguous: bool = False
    reason: str | None = None
    text: str | None = None  # the digits as "1234.56"


@dataclass(frozen=True)
class NumberParse:
    """A parse with the evidence it gives for the document's number style."""

    result: NumberResult
    decimal_evidence: Literal[",", "."] | None = None


def _valid_groups(text: str, sep: str) -> bool:
    groups = text.split(sep)
    return re.fullmatch(r"[0-9]{1,3}", groups[0]) is not None and all(
        re.fullmatch(r"[0-9]{3}", g) is not None for g in groups[1:]
    )


def _body_of(
    int_part: str,
    frac: str = "",
    *,
    decimal: str | None = None,
    group: str | None = None,
) -> _Body:
    """A decided digit run; `text` keeps the digits so an exponent is applied without rounding twice."""
    text = f"{int_part or '0'}.{frac}" if frac else (int_part or "0")
    return _Body(float(text), decimal=decimal, group=group, text=text)


def _interpret(body: str, style: NumberStyle | None) -> _Body:
    """Decide decimal and grouping separators of a digit run."""
    parts = re.split(f"[{re.escape(_GROUP_CHARS)}]", body)
    if len(parts) > 1:
        head, *middle, last = parts
        match = re.fullmatch(r"([0-9]{3})(?:([.,])([0-9]+))?", last)
        if (
            re.fullmatch(r"[0-9]{1,3}", head) is None
            or any(re.fullmatch(r"[0-9]{3}", p) is None for p in middle)
            or match is None
        ):
            return _Body(None, reason="unrecognised digit grouping")
        digits = head + "".join(middle) + match.group(1)
        sep, frac = match.group(2), match.group(3) or ""
        return _body_of(digits, frac, decimal=sep)

    dots, commas = body.count("."), body.count(",")
    if dots == 0 and commas == 0:
        return _body_of(body)
    if dots and commas:
        decimal = "." if body.rfind(".") > body.rfind(",") else ","
        group = "," if decimal == "." else "."
        if body.count(decimal) != 1:
            return _Body(None, reason="unrecognised digit grouping")
        int_part, frac = body.split(decimal)
        if not _valid_groups(int_part, group):
            return _Body(None, reason="unrecognised digit grouping")
        return _body_of(int_part.replace(group, ""), frac, decimal=decimal, group=group)

    sep = "." if dots else ","
    if body.count(sep) > 1:
        if not _valid_groups(body, sep):
            return _Body(None, reason="unrecognised digit grouping")
        return _body_of(body.replace(sep, ""), group=sep)

    int_part, frac = body.split(sep)
    # three digits after a single separator could be thousands, except after "0", "" or a 4+ digit run
    unambiguous_decimal = len(frac) != 3 or int_part == "" or len(int_part) > 3 or int_part.startswith("0")
    if unambiguous_decimal:
        return _body_of(int_part, frac, decimal=sep)
    if style is not None and style.decimal is not None:
        if style.decimal == sep:
            return _body_of(int_part, frac)
        return _body_of(int_part + frac)
    return _Body(
        None,
        ambiguous=True,
        reason=f"'{body}' can be read with '{sep}' as decimal or as thousands separator",
    )


def _take_qualifier(text: str) -> tuple[str | None, str]:
    lowered = text.casefold()
    for qualifier in _vocabulary().qualifiers:
        q = qualifier.casefold()
        if not lowered.startswith(q):
            continue
        after = text[len(qualifier) :]
        if qualifier[-1:].isalpha() and after[:1].isalpha():
            continue  # "ca" must not match "cave"
        return text[: len(qualifier)], after.lstrip()
    return None, text


def _strip_brackets(text: str) -> str:
    text = text.strip()
    while len(text) >= 2 and text[0] in _OPEN_BRACKETS and text[-1] in _CLOSE_BRACKETS:
        text = text[1:-1].strip()
    return text


def _stray_digit(unit: str) -> bool:
    """A digit in the unit text that is not an exponent of a unit symbol ("m3", "m s-1", "m^2")."""
    for index, ch in enumerate(unit):
        if not ch.isdigit() or not ch.isascii():
            continue
        if index == 0:
            return True
        prev = unit[index - 1]
        if prev.isalpha() or prev in "^²³" or prev.isdigit():
            continue
        if prev in MINUS_SIGNS + "⁻" and index >= 2 and unit[index - 2].isalpha():
            continue
        return True
    return False


def _exponent(rest: str) -> tuple[int | None, str]:
    match = _EXPONENT.match(rest)
    if match:
        return int((match.group(1) or match.group(2)).replace("\u2212", "-")), rest[match.end() :]
    match = _TIMES_TEN.match(rest)
    if match:
        raw = (
            match.group(1)
            .translate(SUPERSCRIPT_DIGITS)
            .replace("\u2212", "-")
            .replace("^", "")
            .replace("*", "")
            .replace(" ", "")
        )
        try:
            return int(raw), rest[match.end() :]
        except ValueError:
            return None, rest
    return None, rest


def analyse_number(raw: str | None, *, style: NumberStyle | None = None) -> NumberParse:
    """parse_number plus the decimal-separator evidence the text gives (used by learn_style)."""
    if raw is None or not raw.strip():
        return NumberParse(NumberResult(None, reason="no value printed"))
    text = _strip_brackets(ascii_digits(unicodedata.normalize("NFC", raw)))
    if not any(ch.isdigit() and ch.isascii() for ch in text):
        return NumberParse(NumberResult(None, reason="no number in the text"))

    qualifier, text = _take_qualifier(text)
    sign = 1.0
    if text and text[0] in MINUS_SIGNS:
        sign, text = -1.0, text[1:]
    elif text.startswith("+"):
        text = text[1:]
    match = _BODY.match(text)
    if match is None:
        return NumberParse(
            NumberResult(None, qualifier=qualifier, reason="unexpected text before the number")
        )
    body = _interpret(match.group(0), style)
    rest = text[match.end() :]

    exponent, rest = _exponent(rest)
    stripped = rest.strip()
    if stripped.startswith("+") and not stripped[1:].lstrip()[:1].isdigit():
        qualifier = qualifier or "+"
        stripped = stripped[1:].strip()
    if _vocabulary().range_pattern.match(rest):
        return NumberParse(NumberResult(None, qualifier=qualifier, reason="a range is not a single number"))
    unit = stripped.strip(" ,;:") or None
    if unit is not None and all(ch in ".,;:!?" for ch in unit):
        unit = None  # sentence punctuation after the number
    if unit is not None and _stray_digit(unit):
        return NumberParse(NumberResult(None, qualifier=qualifier, reason="more than one number in the text"))

    evidence: Literal[",", "."] | None = None
    if body.decimal in (",", "."):
        evidence = "," if body.decimal == "," else "."
    elif body.group in (",", "."):
        evidence = "." if body.group == "," else ","
    if body.value is None:
        result = NumberResult(
            None, unit=unit, qualifier=qualifier, ambiguous=body.ambiguous, reason=body.reason
        )
        return NumberParse(result, evidence)
    value = sign * (float(f"{body.text}e{exponent}") if exponent is not None else body.value)
    if not math.isfinite(value):
        return NumberParse(NumberResult(None, unit=unit, qualifier=qualifier, reason="number out of range"))
    if value == 0:
        value = 0.0  # no negative zero
    return NumberParse(NumberResult(value, unit=unit, qualifier=qualifier), evidence)


def parse_number(raw: str | None, *, style: NumberStyle | None = None) -> NumberResult:
    """The number in `raw`, with the unit text and qualifier as printed; None with a reason otherwise."""
    return analyse_number(raw, style=style).result


def learn_style(raws: Iterable[str]) -> NumberStyle:
    """The document's dominant decimal separator, from its numbers whose separators are unambiguous."""
    votes: Counter[str] = Counter()
    for raw in raws:
        if not isinstance(raw, str):
            continue
        evidence = analyse_number(raw).decimal_evidence
        if evidence is not None:
            votes[evidence] += 1
    total = sum(votes.values())
    vocabulary = _vocabulary()
    if total < vocabulary.min_evidence or not votes:
        return NumberStyle()
    decimal, count = votes.most_common(1)[0]
    if count / total < vocabulary.min_share:
        return NumberStyle()
    return NumberStyle(decimal="," if decimal == "," else ".")


def format_number(
    value: float, *, decimal: Literal[",", "."] = ".", group: str | None = None, decimals: int = 2
) -> str:
    """Format a number the way documents print it (used by tests and for display of normalised values)."""
    text = f"{abs(value):.{decimals}f}"
    int_part, _, frac = text.partition(".")
    if group:
        chunks: list[str] = []
        while len(int_part) > 3:
            chunks.insert(0, int_part[-3:])
            int_part = int_part[:-3]
        chunks.insert(0, int_part)
        int_part = group.join(chunks)
    sign = "-" if value < 0 and float(text) != 0 else ""
    return f"{sign}{int_part}{decimal + frac if frac else ''}"
