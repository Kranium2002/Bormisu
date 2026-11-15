"""Scorecard on public LGRB borehole sheets (docs/superpowers/specs/2026-11-15-lgrb-scorecard-design.md).

The LGRB-BW portal (https://bohrungen.lgrb-bw.de/) publishes, per borehole, the redacted original sheet and
its own structured layer table. `upload` sends one sheet per borehole to a running stack; `score` reads the
documents and records back over the HTTP API and compares them with the portal's table.

Every metric keeps matches, mismatches and "not comparable" apart (app.eval.compare.Tally): a value the
portal does not give, or that cannot be compared fairly, never counts as an error.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pyproj import Geod, Transformer

from app.normalize.lithology import din_code_from_text, valid_din_code


@dataclass
class Tally:
    """Counts of one metric. The shape of app.eval.compare.Tally; that module imports the database layer,
    and this scorer must run from a plain interpreter against a stack somewhere else."""

    match: int = 0
    mismatch: int = 0
    not_comparable: int = 0

    def add(self, other: Tally) -> None:
        self.match += other.match
        self.mismatch += other.mismatch
        self.not_comparable += other.not_comparable

    @property
    def compared(self) -> int:
        return self.match + self.mismatch


BOTTOM_TOLERANCE_M = 0.15
FINAL_DEPTH_TOLERANCE_M = 0.10
ELEVATION_TOLERANCE_M = 0.05
POSITION_TOLERANCE_M = 25.0
METRICS = ("count", "final_depth", "boundaries", "din", "position", "elevation", "date", "name")
METRIC_LABELS = {
    "count": "One sheet gives one borehole",
    "final_depth": "Final depth within 0.10 m",
    "boundaries": "Layer bottoms found within 0.15 m",
    "din": "DIN 4023 main code on matched layers",
    "position": "Position within 25 m (plotted boreholes)",
    "elevation": "Collar elevation within 0.05 m",
    "date": "Drilling date",
    "name": "Borehole name",
}
FINISHED = ("needs_review", "done")  # document statuses with a result to score

_NUMBER = re.compile(r"-?\d+(?:[.,]\d+)?")
_GERMAN_DATE = re.compile(r"^\s*(\d{2})\.(\d{2})\.(\d{4})\s*$")
# the rule of app.review.service.canonical_label, kept here because that module needs the database layer
_CANON_STRIP = re.compile(r"[\s\-_]+")
_LEADING_ZEROS = re.compile(r"(?<![0-9])0+(?=[0-9])")
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


def _canonical(label: str) -> str:
    return _LEADING_ZEROS.sub("", _CANON_STRIP.sub("", label.strip().upper()))


def _minutes(document: dict[str, Any]) -> float | None:
    try:
        start = datetime.fromisoformat(str(document.get("created_at")).replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(document.get("updated_at")).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (end - start).total_seconds() / 60


def _within(tally: Tally, expected: float | None, ours: Any, tolerance: float) -> None:
    if expected is None:
        tally.not_comparable += 1
    elif isinstance(ours, int | float) and abs(expected - float(ours)) <= tolerance + 1e-9:
        tally.match += 1
    else:
        tally.mismatch += 1


def _equal(tally: Tally, expected: str | None, ours: set[str]) -> None:
    if expected is None:
        tally.not_comparable += 1
    elif expected in ours:
        tally.match += 1
    else:
        tally.mismatch += 1


def score_borehole(
    truth: dict[str, Any], document: dict[str, Any], records: list[dict[str, Any]]
) -> dict[str, Any]:
    """One scorecard row: the portal's borehole against the records of the document its sheet became."""
    row: dict[str, Any] = {
        "id": truth.get("id"),
        "status": document.get("status"),
        "n_records": len(records),
        **{metric: Tally() for metric in METRICS},
        "boundary_extra": 0,
        "boundary_mae": None,
        "plotted": None,
        "unplotted_reason": None,
        "crs_status": None,
        "open_clarifications": int(document.get("open_clarifications") or 0),
        "pages_unused": sum(1 for page in document.get("pages") or [] if not page.get("used")),
        "revision": None,
        "minutes": _minutes(document),
    }
    if row["status"] not in FINISHED:
        return row  # failed or still processing: no accuracy numbers from it
    if len(records) != 1:
        row["count"].mismatch += 1
        for metric in METRICS[1:]:
            row[metric].not_comparable += 1
        return row
    row["count"].match += 1
    record = records[0]
    meta = record.get("metadata") or {}
    row["plotted"] = record.get("plotted")
    row["unplotted_reason"] = record.get("unplotted_reason")
    row["crs_status"] = record.get("crs_status")
    row["revision"] = record.get("revision")

    depth, elevation = first_number(truth.get("endteufe")), first_number(truth.get("ansatzhoehe"))
    _within(row["final_depth"], depth, meta.get("borehole_depth_m"), FINAL_DEPTH_TOLERANCE_M)
    _within(row["elevation"], elevation, meta.get("surface_elevation_mASL"), ELEVATION_TOLERANCE_M)
    day = _GERMAN_DATE.match(str(truth.get("date") or ""))
    our_days = {str(meta[key])[:10] for key in ("drilling_date", "start_date", "end_date") if meta.get(key)}
    _equal(row["date"], f"{day.group(3)}-{day.group(2)}-{day.group(1)}" if day else None, our_days)
    name = str(truth.get("name") or "").strip()
    our_names = {_canonical(str(n)) for n in (meta.get("borehole_id"), *(meta.get("aliases") or [])) if n}
    _equal(row["name"], _canonical(name) if name else None, our_names)

    truth_layers = [
        (bottom, lay)
        for lay in truth.get("layers") or []
        if (bottom := first_number(lay.get("bis"))) is not None
    ]
    our_layers = [lay for lay in record.get("stratigraphy") or [] if lay.get("depth_to_m") is not None]
    pairs, mae = match_bottoms([b for b, _ in truth_layers], [float(lay["depth_to_m"]) for lay in our_layers])
    row["boundaries"].match = len(pairs)
    row["boundaries"].mismatch = len(truth_layers) - len(pairs)
    row["boundary_extra"] = len(our_layers) - len(pairs)
    row["boundary_mae"] = mae
    for i, j in pairs:
        _equal(row["din"], truth_din(truth_layers[i][1]), {str(our_layers[j].get("din4023_code"))})

    expected = truth_wgs84(truth.get("coordinates"))
    coordinates = meta.get("coordinates") or {}
    lat, lon = coordinates.get("latitude"), coordinates.get("longitude")
    if expected is None or not record.get("plotted") or lat is None or lon is None:
        row["position"].not_comparable += 1
    elif distance_m(expected, (float(lat), float(lon))) <= POSITION_TOLERANCE_M:
        row["position"].match += 1
    else:
        row["position"].mismatch += 1
    return row


def totals(rows: list[dict[str, Any]]) -> dict[str, Tally]:
    total = {metric: Tally() for metric in METRICS}
    for row in rows:
        for metric in METRICS:
            total[metric].add(row[metric])
    return total


def _cell(tally: Tally) -> str:
    return f"{tally.match}/{tally.compared}" if tally.compared else "-"


def render(rows: list[dict[str, Any]], excluded: dict[str, str]) -> str:
    """The report: totals with their denominators, the side facts, one line per borehole, the excluded."""
    total = totals(rows)
    out = [
        "# LGRB scorecard",
        "",
        f"{len(rows)} boreholes uploaded, {len(excluded)} excluded. Truth: the LGRB-BW portal's own data per",
        "borehole (https://bohrungen.lgrb-bw.de/). Scored: what the app returned for the sheet, as first",
        "extracted. A value the portal does not give, or that cannot be compared fairly, is not comparable",
        "and never counts as wrong.",
        "",
        "| Metric | Right | Wrong | Not comparable | Right of compared |",
        "|---|---|---|---|---|",
    ]
    for metric in METRICS:
        tally = total[metric]
        share = f"{100 * tally.match / tally.compared:.0f} %" if tally.compared else "-"
        counts = f"{tally.match} | {tally.mismatch} | {tally.not_comparable}"
        out.append(f"| {METRIC_LABELS[metric]} | {counts} | {share} |")
    scored = [row for row in rows if row["status"] in FINISHED]
    unfinished = Counter(str(row["status"]) for row in rows if row["status"] not in FINISHED)
    unplotted = Counter(str(row["unplotted_reason"]) for row in scored if row["plotted"] is False)
    changed = [str(row["id"]) for row in scored if row["revision"] not in (None, 1)]
    maes = [row["boundary_mae"] for row in scored if row["boundary_mae"] is not None]
    minutes = [row["minutes"] for row in rows if row["minutes"] is not None]
    extra = sum(row["boundary_extra"] for row in scored)
    mae_line = f"{sum(maes) / len(maes):.3f} m" if maes else "none matched"
    minutes_line = f"{sum(minutes) / len(minutes):.1f}" if minutes else "unknown"
    out += [
        "",
        "## Side facts (not part of the score)",
        "",
        f"- Documents without a result: {sum(unfinished.values())} {dict(unfinished) or ''}".rstrip(),
        f"- Boreholes not placed on the map: {sum(unplotted.values())} {dict(unplotted) or ''}".rstrip(),
        f"- Open questions for a person: {sum(row['open_clarifications'] for row in rows)}",
        f"- Pages the classifier left unused: {sum(row['pages_unused'] for row in rows)}",
        f"- Our layer bottoms with no partner in the portal's table: {extra}",
        f"- Mean error of matched layer bottoms: {mae_line}",
        f"- Records changed after the first extraction (revision > 1): {', '.join(changed) or 'none'}",
        f"- Mean minutes per document (created to last update): {minutes_line}",
        "",
        "## Per borehole",
        "",
        "| Borehole | Status | Records | Final depth | Bottoms found | Extra bottoms | DIN | Position "
        "| Elevation | Date | Name |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        cells = [_cell(row[m]) for m in ("final_depth", "boundaries")] + [str(row["boundary_extra"])]
        cells += [_cell(row[m]) for m in ("din", "position", "elevation", "date", "name")]
        out.append(f"| {row['id']} | {row['status']} | {row['n_records']} | " + " | ".join(cells) + " |")
    if excluded:
        out += ["", "## Excluded", ""] + [f"- {key}: {reason}" for key, reason in sorted(excluded.items())]
    return "\n".join(out) + "\n"
