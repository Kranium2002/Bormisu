"""The LGRB scorecard (app.eval.lgrb_scorecard): comparison rules, scoring, the upload and score commands.

No network and no portal file: HTTP is mocked, PDFs are made here. Petrography phrases and codes are the
kind the public LGRB-BW borehole portal (https://bohrungen.lgrb-bw.de/) shows.
"""

from __future__ import annotations

import pytest

from app.eval import lgrb_scorecard as sc


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
