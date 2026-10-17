"""Depth sign and origin notes against the printed layer depths (BACKEND.md 7.8). Pure: no database.

`check_datum_convention` compares what a printed note says about depths (from
app.normalize.datums.parse_depth_origin) with the arithmetic of the printed layer depths, read with their
sign and in printed order:

* `negative_note_positive_depths`: the note says negative values denote depth, but the depths are positive;
* `positive_note_negative_depths`: the note says depths are positive downwards, but they are negative;
* `negative_depths_without_note`: the depths are negative and no note says what the sign means;
* `depths_decrease`: positive values that decrease downwards, as elevations do, where depths increase.

At most one finding is returned, the first in that order. The minimum number of values and the share that
must contradict the note are data (document_checks.yaml `datum_convention`).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from app.normalize.api import DepthOrigin
from app.validate.document import section

DatumKind = Literal[
    "negative_note_positive_depths",
    "positive_note_negative_depths",
    "negative_depths_without_note",
    "depths_decrease",
]

# Answers a person can give, by finding. `as_printed` keeps the values, `negative_down` stores negative
# values as positive depths, `elevations` flags the depth values for correction.
CONVENTION_OPTIONS: dict[DatumKind, tuple[str, ...]] = {
    "negative_note_positive_depths": ("as_printed", "elevations"),
    "positive_note_negative_depths": ("negative_down", "as_printed", "elevations"),
    "negative_depths_without_note": ("negative_down", "as_printed", "elevations"),
    "depths_decrease": ("as_printed", "elevations"),
}


@dataclass(frozen=True)
class DatumFinding:
    kind: DatumKind
    explanation: str  # one sentence a person can read, without values from a particular document


def _thresholds() -> tuple[int, int, float]:
    cfg = section("datum_convention")
    return int(cfg["min_values"]), int(cfg["min_intervals"]), float(cfg["min_share"])


def check_datum_convention(
    origin: DepthOrigin, intervals: Sequence[tuple[float | None, float | None]]
) -> DatumFinding | None:
    """The contradiction between the printed note and the printed layer depths, if any.

    `intervals` are the layers' (from, to) depths in metres as printed (sign kept), in printed order.
    """
    min_values, min_intervals, min_share = _thresholds()
    values = [v for pair in intervals for v in pair if v is not None and v != 0]
    if len(values) >= min_values:
        negative = sum(1 for v in values if v < 0) / len(values)
        positive = 1.0 - negative
        if origin.negative_down is True and positive >= min_share:
            return DatumFinding(
                "negative_note_positive_depths",
                "A printed note says negative values denote depth, but the layer depths are printed as "
                "positive numbers.",
            )
        if origin.negative_down is False and negative >= min_share:
            return DatumFinding(
                "positive_note_negative_depths",
                "A printed note says depths are counted positive downwards, but the layer depths are "
                "printed as negative numbers.",
            )
        if origin.negative_down is None and negative >= min_share:
            return DatumFinding(
                "negative_depths_without_note",
                "The layer depths are printed as negative numbers and no note says what the sign means.",
            )
    pairs = [(a, b) for a, b in intervals if a is not None and b is not None and a >= 0 and b >= 0 and a != b]
    if len(pairs) >= min_intervals:
        decreasing = sum(1 for a, b in pairs if b < a) / len(pairs)
        if decreasing >= min_share:
            return DatumFinding(
                "depths_decrease",
                "The printed layer values decrease downwards, as elevations do, while depths increase.",
            )
    return None
