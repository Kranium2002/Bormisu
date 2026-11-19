"""Scorecard on public LGRB borehole sheets (docs/superpowers/specs/2026-11-15-lgrb-scorecard-design.md).

The LGRB-BW portal (https://bohrungen.lgrb-bw.de/) publishes, per borehole, the redacted original sheet and
its own structured layer table. `upload` sends one sheet per borehole to a running stack; `score` reads the
documents and records back over the HTTP API and compares them with the portal's table.

Every metric keeps matches, mismatches and "not comparable" apart (app.eval.compare.Tally): a value the
portal does not give, or that cannot be compared fairly, never counts as an error.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import pypdfium2 as pdfium
from pyproj import Geod, Transformer

from app.normalize.lithology import din_code_from_text, valid_din_code


@dataclass
class Tally:
    """Counts of one metric. The shape of app.eval.compare.Tally; that module imports the database layer,
    and this scorer must run from a plain interpreter against a stack somewhere else."""

    match: int = 0
    mismatch: int = 0  # the app returned a different value
    missing: int = 0  # the portal has a value, the app returned none
    not_comparable: int = 0

    def add(self, other: Tally) -> None:
        self.match += other.match
        self.mismatch += other.mismatch
        self.missing += other.missing
        self.not_comparable += other.not_comparable

    @property
    def compared(self) -> int:
        return self.match + self.mismatch + self.missing


BOTTOM_TOLERANCE_M = 0.15
FINAL_DEPTH_TOLERANCE_M = 0.10
ELEVATION_TOLERANCE_M = 0.05
POSITION_TOLERANCE_M = 25.0
METRICS = ("count", "final_depth", "boundaries", "din", "position", "elevation", "date", "name")
METRIC_LABELS = {
    "count": "One sheet gives one borehole",
    "final_depth": "Final depth within 0.10 m",
    "boundaries": "Layer bottoms found within 0.15 m",
    "din": "DIN 4023 soil type on matched layers (grain-size prefix ignored)",
    "position": "Coordinates within 25 m (placed, or as printed in Gauss-Krüger 3 / UTM 32)",
    "elevation": "Collar elevation within 0.05 m",
    "date": "Drilling date (the month where the portal has no day)",
    "name": "Sheet's borehole label found in the portal's name",
}
FINISHED = ("needs_review", "done")  # document statuses with a result to score

_NUMBER = re.compile(r"-?\d+(?:[.,]\d+)?")
_GERMAN_DATE = re.compile(r"^\s*(\d{2})\.(\d{2})\.(\d{4})\s*$")
# the rule of app.review.service.canonical_label, kept here because that module needs the database layer
_CANON_STRIP = re.compile(r"[\s\-_]+")
_LEADING_ZEROS = re.compile(r"(?<![0-9])0+(?=[0-9])")
_UTM32 = re.compile(r"^\s*32U\s+O:\s*(-?\d+(?:\.\d+)?)\s*\|\s*N:\s*(-?\d+(?:\.\d+)?)\s*$")
_LEADING_LETTERS = re.compile(r"^\(?([^\W\d_]+)")  # "U(fs4)" and the mixture "(G-S)(u2,s4)" both start a code
_NOT_A_DIGIT = re.compile(r"[^\d.,]")
_UTM32_TO_WGS84 = Transformer.from_crs(25832, 4326, always_xy=True)
_UTM32_TO_GK3 = Transformer.from_crs(25832, 31467, always_xy=True)  # what older sheets of the area print
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


def truth_utm32(text: str | None) -> tuple[float, float] | None:
    """(easting, northing) of the portal's "32U O: … | N: …" (ETRS89 / UTM 32N); None for anything else."""
    found = _UTM32.match(text or "")
    return (float(found.group(1)), float(found.group(2))) if found else None


def truth_wgs84(text: str | None) -> tuple[float, float] | None:
    """(latitude, longitude) of the portal's coordinates."""
    utm = truth_utm32(text)
    if utm is None:
        return None
    lon, lat = _UTM32_TO_WGS84.transform(*utm)
    return lat, lon


def printed_position_matches(utm: tuple[float, float], x_raw: Any, y_raw: Any) -> bool | None:
    """Whether the coordinates a sheet prints are the portal's point, read as UTM 32 or Gauss-Krüger zone 3
    in either axis order. None when the two printed values are not both numbers."""
    printed = []
    for raw in (x_raw, y_raw):
        digits = _NOT_A_DIGIT.sub("", str(raw or "")).replace(",", ".")
        try:
            printed.append(float(digits))
        except ValueError:
            return None
    for east, north in (utm, _UTM32_TO_GK3.transform(*utm)):
        for x, y in (printed, printed[::-1]):
            if ((x - east) ** 2 + (y - north) ** 2) ** 0.5 <= POSITION_TOLERANCE_M:
                return True
    return False


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Metres between two (latitude, longitude) points."""
    return float(_GEOD.inv(a[1], a[0], b[1], b[0])[2])


def truth_din(layer: dict[str, Any]) -> str | None:
    """The DIN 4023 main code of a portal layer: its own petrography code when that is a DIN code, else the
    code of its words, else None (not comparable)."""
    leading = _LEADING_LETTERS.match(str((layer.get("codes") or {}).get("petro") or "").strip())
    code = valid_din_code(leading.group(1)) if leading else None
    return code or din_code_from_text(layer.get("Petrographie"), "de")


def _soil(code: str | None) -> str | None:
    """A DIN code without its grain-size prefix ("fG" and "G" are both gravel)."""
    if code and len(code) == 2 and code[0] in "fmg" and code[1].isupper():
        return code[1]
    return code


def _canonical(label: str) -> str:
    return _LEADING_ZEROS.sub("", _CANON_STRIP.sub("", label.strip().upper()))


def _names(label: str, portal_name: str) -> bool:
    """Whether a sheet's (canonical) label is the hole in the portal's (canonical) name: it must carry a
    number and be found with that number whole, so "B1", "1" and "5" are not "B15"."""
    if not any(ch.isdigit() for ch in label):
        return False
    return re.search(rf"(?<!\d){re.escape(label)}(?!\d)", portal_name) is not None


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
    elif not isinstance(ours, int | float):
        tally.missing += 1
    elif abs(expected - float(ours)) <= tolerance + 1e-9:
        tally.match += 1
    else:
        tally.mismatch += 1


def _judge(tally: Tally, comparable: bool, ours_present: bool, same: bool) -> None:
    if not comparable:
        tally.not_comparable += 1
    elif not ours_present:
        tally.missing += 1
    elif same:
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
    # the portal writes the first of the month where it knows no day, and the first of January where it
    # knows the year only: then the month, or the year, is what can be compared
    width = 10
    if day and day.group(1) == "01":
        width = 4 if day.group(2) == "01" else 7
    expected_day = f"{day.group(3)}-{day.group(2)}-{day.group(1)}"[:width] if day else None
    our_days = {
        str(meta[key])[:width] for key in ("drilling_date", "start_date", "end_date") if meta.get(key)
    }
    _judge(row["date"], day is not None, bool(our_days), expected_day in our_days)
    # the portal's name is the site and the hole ("Bohlsbach In den Matten B 5"); a sheet prints the hole
    portal_name = _canonical(str(truth.get("name") or ""))
    our_names = {_canonical(str(n)) for n in (meta.get("borehole_id"), *(meta.get("aliases") or [])) if n}
    _judge(
        row["name"],
        bool(portal_name),
        bool(our_names),
        any(_names(label, portal_name) for label in our_names),
    )

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
        portal_code, our_code = truth_din(truth_layers[i][1]), our_layers[j].get("din4023_code")
        _judge(row["din"], portal_code is not None, bool(our_code), _soil(portal_code) == _soil(our_code))

    # A placed borehole is compared on the map. One the app holds back until a person confirms the
    # coordinate system is compared on the numbers its sheet prints.
    utm = truth_utm32(truth.get("coordinates"))
    coordinates = meta.get("coordinates") or {}
    lat, lon = coordinates.get("latitude"), coordinates.get("longitude")
    if utm is not None and record.get("plotted") and lat is not None and lon is not None:
        portal_point = _UTM32_TO_WGS84.transform(*utm)[::-1]
        placed = distance_m(portal_point, (float(lat), float(lon))) <= POSITION_TOLERANCE_M
        _judge(row["position"], True, True, placed)
    else:
        printed = (
            None if utm is None else printed_position_matches(utm, *map(coordinates.get, ("x_raw", "y_raw")))
        )
        _judge(row["position"], utm is not None, printed is not None, bool(printed))
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
        "borehole (https://bohrungen.lgrb-bw.de/). Scored: what the app returns for the sheet,",
        "as the app holds it now; records revised since extraction are named under the side facts.",
        "Wrong: the app returned a different value. Not read: the portal has a value and the app",
        "returned none (the sheet may not print it; the portal also holds registry data). A value the portal",
        "does not give, or that cannot be compared fairly, is not comparable and never counts against the",
        "app. A sheet that came back as no borehole or as several is counted in the first row only.",
        "",
        "| Metric | Right | Wrong | Not read | Not comparable | Right of compared |",
        "|---|---|---|---|---|---|",
    ]
    for metric in METRICS:
        tally = total[metric]
        share = f"{100 * tally.match / tally.compared:.0f} %" if tally.compared else "-"
        counts = f"{tally.match} | {tally.mismatch} | {tally.missing} | {tally.not_comparable}"
        out.append(f"| {METRIC_LABELS[metric]} | {counts} | {share} |")
    scored = [row for row in rows if row["status"] in FINISHED]
    unfinished = Counter(str(row["status"]) for row in rows if row["status"] not in FINISHED)
    unplotted = Counter(str(row["unplotted_reason"]) for row in scored if row["plotted"] is False)
    changed = [str(row["id"]) for row in scored if row["revision"] not in (None, 1)]
    maes = [row["boundary_mae"] for row in scored if row["boundary_mae"] is not None]
    extra = sum(row["boundary_extra"] for row in scored)
    mae_line = f"{sum(maes) / len(maes):.3f} m" if maes else "none matched"
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
        "- Records revised after extraction, by the pipeline's second read or by a person (revision > 1): "
        f"{', '.join(changed) or 'none'}",
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


def own_sheets(folder: Path, borehole_id: str) -> list[Path]:
    """The borehole's own Schichtenverzeichnis files in part order. A file whose name holds a range of
    boreholes is shared with its neighbours and never counts, nor does a profile or construction drawing."""
    tk25, _, arnum = borehole_id.partition("-")
    if not arnum.isdigit() or not folder.is_dir():
        return []
    name = re.compile(rf"^BO_{re.escape(tk25)}_{int(arnum):05d}_SV_(\d+)(?:_x)?\.pdf$", re.IGNORECASE)
    parts = [(int(found.group(1)), path) for path in folder.iterdir() if (found := name.match(path.name))]
    return [path for _, path in sorted(parts)]


def sheet_for_upload(folder: Path, borehole_id: str, joined_dir: Path) -> Path | str:
    """The one PDF to upload for a borehole, or the reason there is none. Several part files are joined in
    order; a joined file that exists is reused, so a second run uploads the same bytes."""
    sheets = own_sheets(folder, borehole_id)
    if not sheets:
        return "no own sheet"
    if len(sheets) == 1:
        return sheets[0]
    target = joined_dir / f"{borehole_id}.pdf"
    if not target.exists():
        joined = pdfium.PdfDocument.new()
        for sheet in sheets:
            part = pdfium.PdfDocument(str(sheet))
            joined.import_pages(part)
            part.close()
        joined_dir.mkdir(parents=True, exist_ok=True)
        joined.save(str(target))
        joined.close()
    return target


def sign_in(client: httpx.Client, email: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    if response.status_code != 200:
        raise SystemExit(f"Sign-in failed: the app answered {response.status_code}.")


UPLOAD_COLUMNS = ("id", "file", "document_id", "reason")


def upload(client: httpx.Client, data_dir: Path, project: str) -> None:
    """Send one sheet per borehole of `data_dir/truth` and write scorecard/uploads.csv. Bytes the app
    already has come back with the existing document, so a second run starts no second read."""
    out_dir = data_dir / "scorecard"
    out_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, str]] = []
    for truth_file in sorted((data_dir / "truth").glob("*.json")):
        borehole_id = truth_file.stem
        sheet = sheet_for_upload(data_dir / "pdf" / borehole_id, borehole_id, out_dir / "joined")
        if isinstance(sheet, str):
            rows.append({"id": borehole_id, "file": "", "document_id": "", "reason": sheet})
            continue
        with sheet.open("rb") as handle:
            response = client.post(
                "/api/v1/documents",
                files={"file": (sheet.name, handle, "application/pdf")},
                data={"project": project},
            )
        if response.status_code == 409:
            raise SystemExit("The app is in demo mode: set a provider key.")
        if response.status_code not in (200, 202):
            raise SystemExit(f"Upload of {sheet.name} failed: the app answered {response.status_code}.")
        document_id = str(response.json()["document_id"])
        rows.append({"id": borehole_id, "file": sheet.name, "document_id": document_id, "reason": ""})
    with (out_dir / "uploads.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=UPLOAD_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def _flat(row: dict[str, Any]) -> dict[str, Any]:
    flat = {key: value for key, value in row.items() if key not in METRICS}
    for metric in METRICS:
        tally: Tally = row[metric]
        flat[f"{metric}_right"] = tally.match
        flat[f"{metric}_wrong"] = tally.mismatch
        flat[f"{metric}_not_read"] = tally.missing
        flat[f"{metric}_not_comparable"] = tally.not_comparable
    return flat


def score(client: httpx.Client, data_dir: Path) -> Path:
    """Read every uploaded document and its records, score them, write scorecard/report.md and rows.csv."""
    out_dir = data_dir / "scorecard"
    with (out_dir / "uploads.csv").open(encoding="utf-8", newline="") as handle:
        uploads = list(csv.DictReader(handle))
    rows: list[dict[str, Any]] = []
    excluded: dict[str, str] = {}
    for item in uploads:
        if not item["document_id"]:
            excluded[item["id"]] = item["reason"]
            continue
        truth = json.loads((data_dir / "truth" / f"{item['id']}.json").read_text(encoding="utf-8"))
        document = client.get(f"/api/v1/documents/{item['document_id']}")
        document.raise_for_status()
        records = client.get(f"/api/v1/documents/{item['document_id']}/boreholes")
        records.raise_for_status()  # an expired session or a server error is not "no borehole on this sheet"
        rows.append(score_borehole(truth, document.json(), records.json()))
    report = out_dir / "report.md"
    report.write_text(render(rows, excluded), encoding="utf-8")
    flat = [_flat(row) for row in rows]
    with (out_dir / "rows.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(flat[0]) if flat else ["id"])
        writer.writeheader()
        writer.writerows(flat)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("command", choices=("upload", "score"))
    parser.add_argument("--data", type=Path, required=True, help="folder with truth/ and pdf/")
    parser.add_argument("--base-url", default="http://localhost:8000")
    parser.add_argument("--project", default="LGRB Offenburg")
    parser.add_argument("--email", required=True)
    args = parser.parse_args(argv)
    password = os.environ.get("LGRB_SCORECARD_PASSWORD")
    if not password:
        raise SystemExit("Set LGRB_SCORECARD_PASSWORD to the account's password.")
    with httpx.Client(base_url=args.base_url, timeout=120) as client:
        sign_in(client, args.email, password)
        if args.command == "upload":
            upload(client, args.data, args.project)
            print(args.data / "scorecard" / "uploads.csv")
        else:
            print(score(client, args.data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
