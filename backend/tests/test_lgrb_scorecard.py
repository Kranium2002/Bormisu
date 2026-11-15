"""The LGRB scorecard (app.eval.lgrb_scorecard): comparison rules, scoring, the upload and score commands.

No network and no portal file: HTTP is mocked, PDFs are made here. Petrography phrases and codes are the
kind the public LGRB-BW borehole portal (https://bohrungen.lgrb-bw.de/) shows.
"""

from __future__ import annotations

from typing import Any

import pytest

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
    row = sc.score_borehole(truth(), document(), [record(plotted=False, unplotted_reason="crs_unconfirmed")])
    assert row["position"].not_comparable == 1 and row["unplotted_reason"] == "crs_unconfirmed"


def test_render_names_the_denominators() -> None:
    text = sc.render([sc.score_borehole(truth(), document(), [record()])], {"0000-2": "no own sheet"})
    assert "not comparable" in text and "0000-2" in text and "no own sheet" in text
