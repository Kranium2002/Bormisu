"""Public interface of the normalisers (Python only, no model). Implemented in the sibling modules.

Every function takes raw printed text and returns a typed result with `value=None` and a `reason` when it
cannot decide: unknown is never replaced by a default. Vocabularies (unit aliases, SPT schemes, DIN terms,
CRS names) come from backend/data/*.yaml, never from code branches for particular documents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class NumberResult:
    value: float | None
    unit: str | None = None  # unit text glued to or following the number, as printed ("m", "ft", "%")
    qualifier: str | None = None  # ">", "<", "~", "ca." as printed
    ambiguous: bool = False  # grouping/decimal separator could not be decided (e.g. "1,234")
    reason: str | None = None


@dataclass(frozen=True)
class LengthResult:
    metres: float | None
    unit_raw: str | None = None  # unit as printed (or the document default used)
    ambiguous: bool = False
    reason: str | None = None


@dataclass(frozen=True)
class SptResult:
    n_value: int | None  # never set on refusal
    refusal: bool | None
    increments: list[int] | None = None
    increment_mm: int | None = None
    penetration_cm: float | None = None  # penetration of the refusal increment(s), when printed
    printed_n: int | None = None
    computed_n: int | None = None  # from increments and the scheme; differs from printed_n -> lint
    reason: str | None = None


@dataclass(frozen=True)
class CoordinateResult:
    kind: Literal["geographic", "projected"] | None
    latitude: float | None = None  # geographic only, decimal degrees
    longitude: float | None = None
    local_x: float | None = None  # projected: easting-like value
    local_y: float | None = None  # projected: northing-like value
    swap_suspected: bool = False  # the axis labelled X behaves like a latitude or northing
    # Degrees whose axis order nothing printed decides (no N/E/lat/lon mark or label, both values fit a
    # latitude): read latitude first (X/Y labels: X as longitude) until the coordinate-system question, which
    # offers both orders, confirms it.
    order_assumed: bool = False
    notes: list[str] = field(default_factory=list)
    reason: str | None = None


@dataclass(frozen=True)
class CrsResult:
    code: str | None  # EPSG:<n> when the printed system names one unambiguously
    label: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class DateResult:
    iso: str | None  # YYYY-MM-DD only when unambiguous
    raw: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class DepthOrigin:
    origin: Literal["ground", "mudline", "seabed", "relative"] | None
    negative_down: bool | None = None  # a printed note says negative values denote depth
    reason: str | None = None


@dataclass(frozen=True)
class NumberStyle:
    """A document's dominant number format, learned from its unambiguous numbers."""

    decimal: Literal[",", "."] | None = None


# Function signatures (implemented in the modules named in the docstrings):
#
# normalize.numbers.parse_number(raw: str | None, *, style: NumberStyle | None = None) -> NumberResult
# normalize.numbers.learn_style(raws: Iterable[str]) -> NumberStyle
# normalize.units.to_metres(value: float, unit: str | None) -> float | None        (None for unknown units)
# normalize.units.parse_length(raw: str | None, *, default_unit: str | None = None,
#                              style: NumberStyle | None = None) -> LengthResult
# normalize.units.parse_percent(raw: str | None, *, style: NumberStyle | None = None) -> NumberResult
# normalize.units.convert(value: float, unit: str | None, target: str) -> float | None
#                              (kN/m3, MPa, kPa, %, m/s ... ; aliases from data/units.yaml)
# normalize.spt.parse_spt(blows_raw: str | None, n_raw: str | None = None,
#                         increment_note_raw: str | None = None) -> SptResult
# normalize.coordinates.parse_coordinates(x_raw: str | None, y_raw: str | None,
#                         labels_raw: str | None = None, style: NumberStyle | None = None) -> CoordinateResult
# normalize.crs.resolve_printed_system(system_raw: str | None,
#                                     coords: CoordinateResult | None = None) -> CrsResult
# normalize.dates.parse_date(raw: str | None) -> DateResult
# normalize.datums.parse_depth_origin(note_raw: str | None, datum_raw: str | None = None) -> DepthOrigin
# normalize.lithology.din_code_from_text(description: str | None, language: str | None = None) -> str | None
# normalize.lithology.valid_din_code(code: str | None) -> str | None   (case-sensitive key of din_codes.json)
