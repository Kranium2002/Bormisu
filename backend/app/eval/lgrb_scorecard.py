"""Scorecard on public LGRB borehole sheets (docs/superpowers/specs/2026-11-15-lgrb-scorecard-design.md).

The LGRB-BW portal (https://bohrungen.lgrb-bw.de/) publishes, per borehole, the redacted original sheet and its
own structured layer table. `upload` sends one sheet per borehole to a running stack; `score` reads the
documents and records back over the HTTP API and compares them with the portal's table.

Every metric keeps matches, mismatches and "not comparable" apart (app.eval.compare.Tally): a value the
portal does not give, or that cannot be compared fairly, never counts as an error.
"""

from __future__ import annotations

import re
from typing import Any

from pyproj import Geod, Transformer

from app.normalize.lithology import din_code_from_text, valid_din_code

BOTTOM_TOLERANCE_M = 0.15

_NUMBER = re.compile(r"-?\d+(?:[.,]\d+)?")
_UTM32 = re.compile(r"^\s*32U\s+O:\s*(-?\d+(?:\.\d+)?)\s*\|\s*N:\s*(-?\d+(?:\.\d+)?)\s*$")
_LEADING_LETTERS = re.compile(r"^[^\W\d_]+")
_UTM32_TO_WGS84 = Transformer.from_crs(25832, 4326, always_xy=True)
_GEOD = Geod(ellps="WGS84")


def first_number(text: str | None) -> float | None:
    """The first decimal number in a string such as "10,0 m" or "149,0 m ü. NN"."""
    found = _NUMBER.search(text or "")
    return float(found.group(0).replace(",", ".")) if found else None


def match_bottoms(
    truth: list[float], ours: list[float], tol: float = BOTTOM_TOLERANCE_M
) -> tuple[list[tuple[int, int]], float | None]:
    """Index pairs (truth, ours) matched one to one within `tol`, the nearest pairs first, and the mean
    absolute error of the pairs (None without pairs)."""
    candidates = sorted(
        (abs(t - o), i, j)
        for i, t in enumerate(truth)
        for j, o in enumerate(ours)
        if abs(t - o) <= tol + 1e-9
    )
    used_truth: set[int] = set()
    used_ours: set[int] = set()
    pairs: list[tuple[int, int]] = []
    errors: list[float] = []
    for error, i, j in candidates:
        if i in used_truth or j in used_ours:
            continue
        used_truth.add(i)
        used_ours.add(j)
        pairs.append((i, j))
        errors.append(error)
    return sorted(pairs), (sum(errors) / len(errors) if errors else None)


def truth_wgs84(text: str | None) -> tuple[float, float] | None:
    """(latitude, longitude) of the portal's "32U O: … | N: …" (ETRS89 / UTM 32N); None for anything else."""
    found = _UTM32.match(text or "")
    if found is None:
        return None
    lon, lat = _UTM32_TO_WGS84.transform(float(found.group(1)), float(found.group(2)))
    return lat, lon


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Metres between two (latitude, longitude) points."""
    return float(_GEOD.inv(a[1], a[0], b[1], b[0])[2])


def truth_din(layer: dict[str, Any]) -> str | None:
    """The DIN 4023 main code of a portal layer: its own petrography code when that is a DIN code, else the
    code of its words, else None (not comparable)."""
    leading = _LEADING_LETTERS.match(str((layer.get("codes") or {}).get("petro") or "").strip())
    code = valid_din_code(leading.group(0)) if leading else None
    return code or din_code_from_text(layer.get("Petrographie"), "de")
