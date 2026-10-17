"""Units and conversions (BACKEND.md 7.8), plus the Test Results field names of the target format.

Unit aliases, dimensions and conversion factors come from data/units.yaml; the Test Results names, their
canonical units and printed aliases from data/test_names.yaml. Conversions are plain factors to one base
unit per dimension (no Pint dependency is needed for linear units). An unknown unit is never guessed:
the result is None with a reason, and a document unit is used only when the caller passes one.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache

from app.normalize.api import LengthResult, NumberResult, NumberStyle
from app.normalize.numbers import load_data, parse_number, str_list


@dataclass(frozen=True)
class Unit:
    key: str  # canonical key in data/units.yaml ("m", "kN/m3", "%")
    dimension: str  # length, stress, unit_weight, ratio, velocity, angle, dimensionless
    factor: float  # one of this unit in the dimension's base unit


def normalise_unit_text(text: str) -> str:
    """The form aliases are compared in: NFKC (m³ -> m3), case-folded, no spaces, no "^", no final "."."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    folded = re.sub(r"\s+", "", folded).replace("^", "")
    return folded.rstrip(".") or folded


@dataclass(frozen=True)
class _UnitTable:
    by_alias: dict[str, Unit]
    by_key: dict[str, Unit]
    collisions: tuple[str, ...]


@lru_cache(maxsize=1)
def _units() -> _UnitTable:
    data = load_data("units.yaml")
    by_alias: dict[str, Unit] = {}
    by_key: dict[str, Unit] = {}
    collisions: list[str] = []
    for key, spec in (data.get("units") or {}).items():
        unit = Unit(str(key), str(spec["dimension"]), float(spec["factor"]))
        by_key[unit.key] = unit
        for alias in [unit.key, *str_list(spec.get("aliases"))]:
            norm = normalise_unit_text(alias)
            existing = by_alias.get(norm)
            if existing is not None and existing.key != unit.key:
                collisions.append(f"{alias!r}: {existing.key} / {unit.key}")
                continue
            by_alias[norm] = unit
    return _UnitTable(by_alias, by_key, tuple(collisions))


def unit_alias_collisions() -> tuple[str, ...]:
    """Aliases listed under two units in data/units.yaml (must be empty)."""
    return _units().collisions


def _strip_unit_text(text: str) -> str:
    text = text.strip().strip(",;:")
    while len(text) >= 2 and text[0] in "([{" and text[-1] in ")]}":
        text = text[1:-1].strip()
    return text


def resolve_unit(text: str | None) -> tuple[Unit, str] | None:
    """The unit named by printed unit text and the part of the text that named it.

    The whole text is tried first ("m bgl", "kN/m³"); then its first word, so a unit followed by a printed
    reference ("m u. GOK", "kN/m3 (dry)") still resolves.
    """
    if text is None:
        return None
    cleaned = _strip_unit_text(text)
    if not cleaned:
        return None
    table = _units().by_alias
    unit = table.get(normalise_unit_text(cleaned))
    if unit is not None:
        return unit, cleaned
    first = cleaned.split()[0]
    unit = table.get(normalise_unit_text(_strip_unit_text(first)))
    if unit is not None:
        return unit, _strip_unit_text(first)
    return None


def lookup_unit(text: str | None) -> Unit | None:
    resolved = resolve_unit(text)
    return None if resolved is None else resolved[0]


def canonical_unit(text: str | None) -> str | None:
    """The canonical key (data/units.yaml) of printed unit text, or None when unknown."""
    unit = lookup_unit(text)
    return None if unit is None else unit.key


def _clean_float(value: float) -> float:
    # Conversion factors leave binary noise (10 ft -> 3.0480000000000005 m); 12 significant digits keep
    # every printed precision.
    return float(f"{value:.12g}")


def convert(value: float, unit: str | None, target: str) -> float | None:
    """`value` in `unit` expressed in `target` (any alias); None for unknown or incompatible units."""
    source = lookup_unit(unit)
    goal = lookup_unit(target)
    if source is None or goal is None or source.dimension != goal.dimension:
        return None
    if source.key == goal.key:
        return value
    return _clean_float(value * source.factor / goal.factor)


def to_metres(value: float, unit: str | None) -> float | None:
    """`value` in metres; None for unknown or non-length units."""
    return convert(value, unit, "m")


# -------------------------------------------------------------------------------------------------
# Lengths and percentages
# -------------------------------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _feet_inches_pattern() -> re.Pattern[str]:
    units = load_data("units.yaml").get("units") or {}

    def alternatives(key: str) -> str:
        aliases = [key, *str_list((units.get(key) or {}).get("aliases"))]
        return "|".join(re.escape(a) for a in sorted(set(aliases), key=len, reverse=True))

    feet, inches = alternatives("ft"), alternatives("in")
    return re.compile(
        rf"^\s*([0-9]+)\s*(?P<ft>{feet})\s*([0-9]+(?:[.,][0-9]+)?)\s*(?P<inch>{inches})?\s*$", re.IGNORECASE
    )


def _feet_and_inches(raw: str) -> LengthResult | None:
    match = _feet_inches_pattern().match(raw)
    if match is None:
        return None
    feet = float(match.group(1))
    inches = float(match.group(3).replace(",", "."))
    if inches >= 12:
        return LengthResult(None, unit_raw=match.group("ft"), reason="inches of 12 or more after feet")
    metres = to_metres(feet, "ft")
    inch_metres = to_metres(inches, "in")
    if metres is None or inch_metres is None:
        return None
    unit_raw = f"{match.group('ft')} {match.group('inch') or ''}".strip()
    return LengthResult(_clean_float(metres + inch_metres), unit_raw=unit_raw)


def _qualifier_note(qualifier: str | None) -> str | None:
    return None if qualifier is None else f"printed with the qualifier '{qualifier}'; value kept as printed"


def parse_length(
    raw: str | None, *, default_unit: str | None = None, style: NumberStyle | None = None
) -> LengthResult:
    """A printed length in metres. The printed unit wins; `default_unit` (a unit the document states, for
    example in a column header) is used only for values printed without one. A value printed with a
    qualifier (">12 m", "ca. 3 m") keeps its number and names the qualifier in `reason`."""
    if raw is None or not raw.strip():
        return LengthResult(None, reason="no value printed")
    feet_inches = _feet_and_inches(raw)
    if feet_inches is not None:
        return feet_inches
    number = parse_number(raw, style=style)
    if number.value is None:
        return LengthResult(None, unit_raw=number.unit, ambiguous=number.ambiguous, reason=number.reason)
    note = _qualifier_note(number.qualifier)
    if number.unit is not None:
        resolved = resolve_unit(number.unit)
        if resolved is None:
            return LengthResult(None, unit_raw=number.unit, reason=f"unknown unit '{number.unit}'")
        unit, printed = resolved
        if unit.dimension != "length":
            return LengthResult(None, unit_raw=printed, reason=f"'{printed}' is not a length unit")
        return LengthResult(_clean_float(number.value * unit.factor), unit_raw=printed, reason=note)
    if default_unit is None:
        return LengthResult(None, reason="no unit printed and no document unit given")
    unit_default = lookup_unit(default_unit)
    if unit_default is None or unit_default.dimension != "length":
        return LengthResult(
            None, unit_raw=default_unit, reason=f"document unit '{default_unit}' is not a length"
        )
    return LengthResult(_clean_float(number.value * unit_default.factor), unit_raw=default_unit, reason=note)


def parse_percent(raw: str | None, *, style: NumberStyle | None = None) -> NumberResult:
    """A printed percentage in %. A value without a unit is returned as printed (unit None)."""
    number = parse_number(raw, style=style)
    if number.value is None or number.unit is None:
        return number
    resolved = resolve_unit(number.unit)
    if resolved is None:
        return NumberResult(
            None, unit=number.unit, qualifier=number.qualifier, reason=f"unknown unit '{number.unit}'"
        )
    unit, printed = resolved
    if unit.dimension != "ratio":
        return NumberResult(
            None, unit=number.unit, qualifier=number.qualifier, reason=f"'{printed}' is not a percentage"
        )
    value = convert(number.value, unit.key, "%")
    return NumberResult(value, unit=printed, qualifier=number.qualifier)


# -------------------------------------------------------------------------------------------------
# Test Results names (data/test_names.yaml)
# -------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class LabTestSpec:
    name: str  # Test Results field name of the target format ("UCS", "Watercontent")
    unit: str  # canonical unit key in data/units.yaml ("-" for dimensionless)
    aliases: tuple[str, ...]
    same_number_units: tuple[str, ...] = ()  # printed units accepted without conversion


def _name_key(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()


@lru_cache(maxsize=1)
def lab_tests() -> tuple[LabTestSpec, ...]:
    """The Test Results fields in target-format order."""
    data = load_data("test_names.yaml")
    return tuple(
        LabTestSpec(
            name=str(entry["name"]),
            unit=str(entry.get("unit") or "-"),
            aliases=tuple(str_list(entry.get("aliases"))),
            same_number_units=tuple(str_list(entry.get("same_number_units"))),
        )
        for entry in data.get("tests") or []
    )


@lru_cache(maxsize=1)
def _lab_test_index() -> dict[str, LabTestSpec]:
    index: dict[str, LabTestSpec] = {}
    for spec in lab_tests():
        for text in (spec.name, *spec.aliases):
            index.setdefault(_name_key(text), spec)
    return index


def match_lab_test(raw: str | None) -> str | None:
    """The Test Results field name for a printed test name or symbol, or None when it names none."""
    if raw is None or not raw.strip():
        return None
    spec = _lab_test_index().get(_name_key(raw))
    return None if spec is None else spec.name


def normalise_lab_test_value(
    name: str, value_raw: str | None, unit_raw: str | None = None, *, style: NumberStyle | None = None
) -> NumberResult:
    """A test value in the field's canonical unit; `unit` of the result is that canonical unit.

    The printed unit (`unit_raw`, else the unit glued to the value) must convert to the canonical one;
    a value without a printed unit is accepted only for dimensionless fields.
    """
    field = match_lab_test(name)
    spec = next((s for s in lab_tests() if s.name == field), None)
    if spec is None:
        return NumberResult(None, reason=f"'{name}' is not a Test Results field")
    number = parse_number(value_raw, style=style)
    if number.value is None:
        return number
    printed = unit_raw.strip() if unit_raw and unit_raw.strip() else number.unit
    target = lookup_unit(spec.unit)
    if target is None:
        return NumberResult(None, qualifier=number.qualifier, reason=f"unknown canonical unit '{spec.unit}'")
    if printed is None:
        if target.dimension == "dimensionless":
            return NumberResult(number.value, unit=spec.unit, qualifier=number.qualifier)
        return NumberResult(None, qualifier=number.qualifier, reason=f"no unit printed for {spec.name}")
    if any(normalise_unit_text(printed) == normalise_unit_text(u) for u in spec.same_number_units):
        return NumberResult(number.value, unit=spec.unit, qualifier=number.qualifier)
    value = convert(number.value, printed, spec.unit)
    if value is None:
        return NumberResult(
            None,
            unit=printed,
            qualifier=number.qualifier,
            reason=f"'{printed}' does not convert to {spec.unit} for {spec.name}",
        )
    return NumberResult(value, unit=spec.unit, qualifier=number.qualifier)


@lru_cache(maxsize=1)
def _unitless_rule() -> tuple[frozenset[str], re.Pattern[str], float]:
    data = load_data("units.yaml").get("unitless_depths") or {}
    languages = frozenset(str(lang).casefold() for lang in str_list(data.get("ask_languages")))
    countries = sorted(str_list(data.get("feet_countries")), key=len, reverse=True)
    pattern = re.compile(
        r"(?<!\w)(?:" + "|".join(re.escape(c) for c in countries) + r")(?!\w)" if countries else r"(?!)",
        re.IGNORECASE,
    )
    return languages, pattern, float(data.get("max_metres") or 0.0)


def unitless_depths_in_metres(
    language: str | None, printed_texts: Iterable[object], values: Iterable[float]
) -> str | None:
    """Why depths printed without a unit are metres here (data/units.yaml unitless_depths), or None when
    they are to be asked about: no language known, a language also written where feet are used, a printed
    country that logs in feet, or a depth too large for metres."""
    ask_languages, feet_countries, max_metres = _unitless_rule()
    primary = (language or "").split("-")[0].strip().casefold()
    if not primary or primary in ask_languages:
        return None
    if any(isinstance(t, str) and feet_countries.search(t) for t in printed_texts):
        return None
    if max_metres > 0 and any(abs(v) > max_metres for v in values):
        return None
    return f"the document is in a language ({primary}) of countries that log boreholes in metres"
