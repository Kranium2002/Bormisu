"""The LGRB scorecard (app.eval.lgrb_scorecard): comparison rules, scoring, the upload and score commands.

No network and no portal file: HTTP is mocked, PDFs are made here. Petrography phrases and codes are the
kind the public LGRB-BW borehole portal (https://bohrungen.lgrb-bw.de/) shows.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from typing import Any

import httpx
import pypdfium2 as pdfium
import pytest
import respx

from app.eval import lgrb_scorecard as sc

# One fictional borehole that agrees with itself: the portal's truth, and what the app would return for it.
POSITION = "32U O: 500000.0 | N: 5400000.0"


def truth(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "0000-7",
        "name": "Fictional B 7",
        "date": "01.02.1990",
        "coordinates": POSITION,
        "endteufe": "2,5 m",
        "ansatzhoehe": "100,0 m ü. NN",
        "layers": [
            {"von": "0.0", "bis": "1.0", "Petrographie": "Sand", "codes": {"petro": "S"}},
            {"von": "1.0", "bis": "2.5", "Petrographie": "Kies", "codes": {"petro": "G"}},
        ],
    }
    return {**base, **over}


def layer(depth_to_m: float | None, din4023_code: str | None) -> dict[str, Any]:
    return {"depth_from_m": None, "depth_to_m": depth_to_m, "din4023_code": din4023_code}


def record(**over: Any) -> dict[str, Any]:
    position = sc.truth_wgs84(POSITION)
    assert position is not None
    base: dict[str, Any] = {
        "revision": 1,
        "plotted": True,
        "unplotted_reason": None,
        "crs_status": "stated",
        "metadata": {
            "borehole_id": "FICTIONAL B-07",
            "aliases": [],
            "borehole_depth_m": 2.5,
            "surface_elevation_mASL": 100.0,
            "drilling_date": None,
            "start_date": "1990-02-01",
            "end_date": None,
            "coordinates": {"latitude": position[0], "longitude": position[1]},
        },
        "stratigraphy": [layer(1.0, "S"), layer(2.5, "G")],
    }
    return {**base, **over}


def record_with(**metadata: Any) -> dict[str, Any]:
    """`record()` with some metadata fields replaced."""
    base = record()
    base["metadata"] = {**base["metadata"], **metadata}
    return base


def document(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "status": "needs_review",
        "failed_stage": None,
        "pages": [{"n": 1, "role": "log_sheet", "used": True, "unused_reason": None}],
        "open_clarifications": 0,
        "created_at": "2026-11-15T10:00:00Z",
        "updated_at": "2026-11-15T10:04:00Z",
    }
    return {**base, **over}


def test_first_number_reads_german_decimals() -> None:
    assert sc.first_number("10,0 m") == 10.0
    assert sc.first_number("149,0 m ü. NN") == 149.0
    assert sc.first_number("") is None and sc.first_number(None) is None


def test_match_bottoms_one_to_one_within_tolerance() -> None:
    pairs, mae = sc.match_bottoms([1.0, 2.0], [1.1, 2.4])
    assert pairs == [(0, 0)] and mae == pytest.approx(0.1)
    assert sc.match_bottoms([1.0], [1.05, 1.1])[0] == [(0, 0)]  # the nearer one, the other stays free
    assert sc.match_bottoms([], [1.0]) == ([], None)


def test_truth_wgs84_on_the_central_meridian() -> None:
    position = sc.truth_wgs84("32U O: 500000.0 | N: 5400000.0")
    assert position is not None
    lat, lon = position
    assert lon == pytest.approx(9.0, abs=1e-6) and lat == pytest.approx(48.753, abs=0.01)
    assert sc.truth_wgs84("33U O: 500000.0 | N: 5400000.0") is None
    assert sc.truth_wgs84("") is None


def test_truth_din_prefers_the_code_then_the_words() -> None:
    assert (
        sc.truth_din({"Petrographie": "Kies [gerundet] (stark sandig)", "codes": {"petro": "G(s4)"}}) == "G"
    )
    assert sc.truth_din({"Petrographie": "Kies [gerundet] (stark sandig)", "codes": {"petro": ""}}) == "G"
    assert sc.truth_din({"Petrographie": "", "codes": {"petro": ""}}) is None


def test_a_clean_borehole_scores_every_metric() -> None:
    row = sc.score_borehole(truth(), document(), [record()])
    assert row["count"].match == 1 and row["final_depth"].match == 1
    assert (row["boundaries"].match, row["boundaries"].mismatch, row["boundary_extra"]) == (2, 0, 0)
    assert row["din"].match == 2 and row["position"].match == 1 and row["date"].match == 1
    assert row["elevation"].match == 1 and row["name"].match == 1  # "FICTIONAL B-07" is "Fictional B 7"
    assert row["minutes"] == pytest.approx(4.0) and row["revision"] == 1 and row["pages_unused"] == 0


def test_a_failed_document_gives_no_accuracy_numbers() -> None:
    row = sc.score_borehole(truth(), document(status="failed"), [])
    assert row["status"] == "failed" and all(row[m].compared == 0 for m in sc.METRICS)


def test_two_records_are_a_count_failure_and_nothing_else_is_compared() -> None:
    row = sc.score_borehole(truth(), document(), [record(), record()])
    assert row["count"].mismatch == 1
    assert all(row[m].compared == 0 for m in sc.METRICS if m != "count")


def test_uncodable_truth_petrography_is_not_comparable() -> None:
    t = truth(layers=[{"von": "0.0", "bis": "1.0", "Petrographie": "", "codes": {"petro": ""}}])
    row = sc.score_borehole(t, document(), [record(stratigraphy=[layer(1.0, "S")])])
    assert (row["din"].match, row["din"].mismatch, row["din"].not_comparable) == (0, 0, 1)


def test_a_layer_without_a_bottom_is_left_out() -> None:
    layers = [layer(None, "S"), layer(1.0, "S"), layer(2.5, "G")]
    row = sc.score_borehole(truth(), document(), [record(stratigraphy=layers)])
    assert row["boundaries"].match == 2 and row["boundary_extra"] == 0


def test_an_unplotted_borehole_is_not_a_position_error() -> None:
    # held back by the app and with no printed coordinates returned: not read, never wrong
    row = sc.score_borehole(truth(), document(), [record(plotted=False, unplotted_reason="crs_unconfirmed")])
    assert (row["position"].mismatch, row["position"].missing) == (0, 1)
    assert row["unplotted_reason"] == "crs_unconfirmed"


def test_render_names_the_denominators() -> None:
    text = sc.render([sc.score_borehole(truth(), document(), [record()])], {"0000-2": "no own sheet"})
    assert "not comparable" in text and "0000-2" in text and "no own sheet" in text


# The cases below come from checking the first real run by eye against the portal (public LGRB records).


def test_the_portals_first_of_month_is_a_month_not_a_day() -> None:
    # 7513-1041: the portal says 01.03.1982, the sheet prints 24.03.1982
    row = sc.score_borehole(truth(date="01.03.1982"), document(), [record_with(start_date="1982-03-24")])
    assert row["date"].match == 1
    # 7513-66: portal 30.08.1963, read as 1965: a real day in the portal must match exactly
    row = sc.score_borehole(truth(date="30.08.1963"), document(), [record_with(start_date="1965-08-30")])
    assert row["date"].mismatch == 1


def test_a_value_the_app_did_not_read_is_not_read_rather_than_wrong() -> None:
    row = sc.score_borehole(truth(), document(), [record_with(surface_elevation_mASL=None)])
    elevation = row["elevation"]
    assert (elevation.match, elevation.mismatch, elevation.missing) == (0, 0, 1) and elevation.compared == 1
    text = sc.render([row], {})
    assert "| Not read |" in text


def test_the_sheets_label_inside_the_portals_site_name_is_the_same_borehole() -> None:
    portal = truth(name="Bohlsbach In den Matten B 5")  # 7513-1041
    assert sc.score_borehole(portal, document(), [record_with(borehole_id="5")])["name"].match == 1
    assert sc.score_borehole(portal, document(), [record_with(borehole_id="B 7")])["name"].mismatch == 1


def test_truth_din_reads_mixtures_and_compares_the_soil_type() -> None:
    assert sc.truth_din({"Petrographie": "", "codes": {"petro": "(G-S)(u2,s4)"}}) == "G"  # 7513-66
    fine_gravel = truth(
        layers=[{"von": "0.0", "bis": "1.0", "Petrographie": "", "codes": {"petro": "fG(gs,ms)"}}]
    )
    row = sc.score_borehole(fine_gravel, document(), [record(stratigraphy=[layer(1.0, "G")])])
    assert row["din"].match == 1  # the grain-size prefix is the portal's refinement, not a different soil


def test_printed_coordinates_are_checked_even_when_the_borehole_is_not_placed() -> None:
    # 7513-66: the sheet prints Gauss-Krüger zone 3, the app waits for a person to confirm the system
    portal = truth(coordinates="32U O: 422765.354 | N: 5365952.254")
    unplaced = record_with(
        coordinates={"latitude": None, "longitude": None, "x_raw": "34 22 810", "y_raw": "5367 660"}
    )
    unplaced.update(plotted=False, unplotted_reason="crs_unconfirmed")
    assert sc.score_borehole(portal, document(), [unplaced])["position"].match == 1
    far = record_with(
        coordinates={"latitude": None, "longitude": None, "x_raw": "34 29 810", "y_raw": "5367 660"}
    )
    far.update(plotted=False, unplotted_reason="crs_unconfirmed")
    assert sc.score_borehole(portal, document(), [far])["position"].mismatch == 1
    none = record_with(coordinates={"latitude": None, "longitude": None, "x_raw": None, "y_raw": None})
    none.update(plotted=False, unplotted_reason="no_coordinates")
    assert sc.score_borehole(portal, document(), [none])["position"].missing == 1


# Findings of the whole-branch review.


def test_a_label_matches_the_portals_name_on_its_whole_number_only() -> None:
    portal = truth(name="Bohlsbach In den Matten B 15")

    def judged(label: str) -> tuple[int, int]:
        tally = sc.score_borehole(portal, document(), [record_with(borehole_id=label)])["name"]
        return tally.match, tally.mismatch

    assert judged("B 15") == (1, 0) and judged("15") == (1, 0)
    # part of the number, or a label with no number at all, is not this borehole
    assert [judged(label) for label in ("B 1", "1", "5", "IN", "B")] == [(0, 1)] * 5


def test_a_portal_date_on_the_first_of_january_is_a_year() -> None:
    # 7513-1596: the portal says 01.01.1953
    row = sc.score_borehole(truth(date="01.01.1953"), document(), [record_with(start_date="1953-06-12")])
    assert row["date"].match == 1
    row = sc.score_borehole(truth(date="01.01.1953"), document(), [record_with(start_date="1954-06-12")])
    assert row["date"].mismatch == 1


def test_the_report_says_which_values_it_scored() -> None:
    text = sc.render([sc.score_borehole(truth(), document(), [record()])], {})
    assert "as first extracted" not in text and "as the app holds it now" in text


@respx.mock
def test_score_stops_when_the_app_does_not_answer_for_the_boreholes(tmp_path: Path) -> None:
    make_data(tmp_path, "0000-7", uploaded_as="doc_1")
    respx.get("http://app.test/api/v1/documents/doc_1").mock(
        return_value=httpx.Response(200, json=document())
    )
    respx.get("http://app.test/api/v1/documents/doc_1/boreholes").mock(return_value=httpx.Response(500))
    # an expired session or a server error must not be scored as "this sheet gave no borehole"
    with httpx.Client(base_url="http://app.test") as client, pytest.raises(httpx.HTTPStatusError):
        sc.score(client, tmp_path)


def one_page_pdf() -> bytes:
    pdf = pdfium.PdfDocument.new()
    pdf.new_page(595, 842)
    out = io.BytesIO()
    pdf.save(out)
    pdf.close()
    return out.getvalue()


def make_data(tmp_path: Path, borehole_id: str, uploaded_as: str | None = None) -> None:
    """truth/<id>.json, one own sheet under pdf/<id>/ and, when uploaded, scorecard/uploads.csv."""
    tk25, arnum = borehole_id.split("-")
    (tmp_path / "truth").mkdir()
    (tmp_path / "truth" / f"{borehole_id}.json").write_text(json.dumps(truth(id=borehole_id)), "utf-8")
    sheet = tmp_path / "pdf" / borehole_id / f"BO_{tk25}_{int(arnum):05d}_SV_1_x.pdf"
    sheet.parent.mkdir(parents=True)
    sheet.write_bytes(one_page_pdf())
    if uploaded_as is not None:
        (tmp_path / "scorecard").mkdir()
        with (tmp_path / "scorecard" / "uploads.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["id", "file", "document_id", "reason"])
            writer.writeheader()
            writer.writerow({"id": borehole_id, "file": sheet.name, "document_id": uploaded_as, "reason": ""})
            writer.writerow({"id": "0000-2", "file": "", "document_id": "", "reason": "no own sheet"})


def test_own_sheets_ignore_shared_and_profile_files_and_parts_are_joined(tmp_path: Path) -> None:
    folder = tmp_path / "0000-7"
    folder.mkdir()
    for name in ("BO_0000_00005-00009_SV_1_x.pdf", "BO_0000_00007_BP_1_x.pdf"):
        (folder / name).write_bytes(one_page_pdf())
    assert sc.sheet_for_upload(folder, "0000-7", tmp_path / "joined") == "no own sheet"
    for name in ("BO_0000_00007_SV_2_x.pdf", "BO_0000_00007_SV_1_x.pdf"):
        (folder / name).write_bytes(one_page_pdf())
    names = [p.name for p in sc.own_sheets(folder, "0000-7")]
    assert names == ["BO_0000_00007_SV_1_x.pdf", "BO_0000_00007_SV_2_x.pdf"]
    joined = sc.sheet_for_upload(folder, "0000-7", tmp_path / "joined")
    assert isinstance(joined, Path) and joined == tmp_path / "joined" / "0000-7.pdf"
    pages = pdfium.PdfDocument(str(joined))
    assert len(pages) == 2
    pages.close()
    before = joined.read_bytes()
    again = sc.sheet_for_upload(folder, "0000-7", tmp_path / "joined")
    assert isinstance(again, Path) and again.read_bytes() == before  # reused, not rebuilt


@respx.mock
def test_upload_twice_reuses_the_document(tmp_path: Path) -> None:
    make_data(tmp_path, "0000-7")
    route = respx.post("http://app.test/api/v1/documents").mock(
        side_effect=[
            httpx.Response(202, json={"document_id": "doc_1", "status": "queued", "duplicate_of": None}),
            httpx.Response(
                200, json={"document_id": "doc_1", "status": "needs_review", "duplicate_of": "doc_1"}
            ),
        ]
    )
    with httpx.Client(base_url="http://app.test") as client:
        sc.upload(client, tmp_path, "Fictional project")
        sc.upload(client, tmp_path, "Fictional project")
    with (tmp_path / "scorecard" / "uploads.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert route.call_count == 2 and [r["document_id"] for r in rows] == ["doc_1"]


@respx.mock
def test_demo_mode_ends_the_upload_with_one_line(tmp_path: Path) -> None:
    make_data(tmp_path, "0000-7")
    respx.post("http://app.test/api/v1/documents").mock(return_value=httpx.Response(409, json={}))
    with httpx.Client(base_url="http://app.test") as client, pytest.raises(SystemExit, match="demo mode"):
        sc.upload(client, tmp_path, "Fictional project")


@respx.mock
def test_a_wrong_password_ends_with_one_line() -> None:
    respx.post("http://app.test/api/v1/auth/login").mock(return_value=httpx.Response(401, json={}))
    with (
        httpx.Client(base_url="http://app.test") as client,
        pytest.raises(SystemExit, match="Sign-in failed"),
    ):
        sc.sign_in(client, "someone@example.org", "wrong")


@respx.mock
def test_score_writes_report_and_rows(tmp_path: Path) -> None:
    make_data(tmp_path, "0000-7", uploaded_as="doc_1")
    respx.get("http://app.test/api/v1/documents/doc_1").mock(
        return_value=httpx.Response(200, json=document())
    )
    respx.get("http://app.test/api/v1/documents/doc_1/boreholes").mock(
        return_value=httpx.Response(200, json=[record()])
    )
    with httpx.Client(base_url="http://app.test") as client:
        report = sc.score(client, tmp_path)
    text = report.read_text(encoding="utf-8")
    assert text.startswith("# LGRB scorecard") and "0000-2: no own sheet" in text
    with (tmp_path / "scorecard" / "rows.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert [(r["id"], r["boundaries_right"], r["boundaries_wrong"]) for r in rows] == [("0000-7", "2", "0")]
