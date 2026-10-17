"""Lint rules and map placement (fictional records)."""

from __future__ import annotations

import pytest

from app.geo.plotting import CrsInvalidError, placement, to_wgs84, validate_crs
from app.review.service import canonical_label, review_status_of
from app.validate.rules import lint_body


def _rules(body: dict) -> dict[str, str]:
    return {f["rule"]: f["path"] for f in lint_body(body)}


def test_clean_record_has_no_findings() -> None:
    body = {
        "metadata": {"borehole_id": "FX-1", "borehole_depth_m": 6.0},
        "stratigraphy": [
            {"depth_from_m": 0.0, "depth_to_m": 2.0, "rqd_pct": 100},
            {"depth_from_m": 2.0, "depth_to_m": 6.0},
        ],
        "groundwater": [{"type": "rest", "depth_m": 3.0}],
    }
    assert lint_body(body) == []


def test_gap_overlap_inverted_and_total_depth() -> None:
    body = {
        "metadata": {"borehole_id": "FX-2", "borehole_depth_m": 5.0},
        "stratigraphy": [
            {"depth_from_m": 0.0, "depth_to_m": 2.0},
            {"depth_from_m": 2.5, "depth_to_m": 3.0},  # gap
            {"depth_from_m": 2.8, "depth_to_m": 2.8},  # overlap and inverted
            {"depth_from_m": 2.8, "depth_to_m": 5.5},  # beyond total depth
        ],
    }
    rules = _rules(body)
    assert rules["layer_gap"] == "stratigraphy[1].depth_from_m"
    assert rules["layer_overlap"] == "stratigraphy[2].depth_from_m"
    assert rules["layer_inverted"] == "stratigraphy[2].depth_to_m"
    assert rules["last_layer_beyond_total_depth"] == "stratigraphy[3].depth_to_m"


def test_values_are_kept_and_linted_not_capped() -> None:
    body = {
        "metadata": {"borehole_id": "FX-3", "borehole_depth_m": 10.0},
        "stratigraphy": [
            {"depth_from_m": 0.0, "depth_to_m": 10.0, "rqd_pct": 104, "core_recovery_pct": 101,
             "ucs_mpa": 420, "spt_refusal": True, "spt_n_value": 50, "spt_depth_m": 11.0},
        ],
        "groundwater": [{"type": "strike", "depth_m": 12.0}],
        "test_results": [{"name": "CAI", "value": 7.1}, {"name": "UCS", "value": 350, "unit": "MPa"}],
    }
    rules = set(_rules(body))
    assert {
        "rqd_above_100",
        "recovery_above_100",
        "ucs_above_300",
        "cai_above_6_5",
        "spt_refusal_with_n",
        "spt_below_total_depth",
        "groundwater_below_total_depth",
    } <= rules
    assert body["stratigraphy"][0]["rqd_pct"] == 104


def test_ucs_in_other_units_is_not_compared_with_mpa_limit() -> None:
    body = {"metadata": {"borehole_id": "FX-4"}, "test_results": [{"name": "UCS", "value": 900, "unit": "kPa"}]}
    assert "ucs_above_300" not in _rules(body)


@pytest.mark.parametrize(
    ("coords", "crs_status", "plotted", "reason"),
    [
        ({}, "unknown", False, "no_coordinates"),
        ({"x_raw": "4 512 300"}, "inferred", False, "crs_unconfirmed"),
        ({"x_raw": "4 512 300", "y_raw": "5 400 100"}, "unknown", False, "crs_unknown"),
        ({"latitude": 47.99, "longitude": 7.85}, "stated", True, None),
        ({"latitude": 47.99, "longitude": 7.85}, "confirmed", True, None),
        ({"latitude": 47.99, "longitude": 7.85}, "inferred", False, "crs_unconfirmed"),
        ({"latitude": 95.0, "longitude": 7.85}, "stated", False, "implausible"),
    ],
)
def test_placement(coords: dict, crs_status: str, plotted: bool, reason: str | None) -> None:
    result = placement(coords, crs_status)
    assert (result.plotted, result.unplotted_reason) == (plotted, reason)


def test_placement_never_uses_zero_defaults() -> None:
    result = placement({"latitude": None, "longitude": None}, "stated")
    assert result.latitude is None and result.longitude is None and not result.plotted


@pytest.mark.parametrize(
    ("code", "x", "y", "lat", "lon"),
    [
        # Projected systems on three continents (fictional points).
        ("EPSG:25832", 413_000.0, 5_316_000.0, 47.99, 7.84),
        ("EPSG:28355", 320_000.0, 5_810_000.0, -37.83, 144.95),
        ("EPSG:32618", 583_000.0, 4_507_000.0, 40.71, -74.01),
    ],
)
def test_to_wgs84(code: str, x: float, y: float, lat: float, lon: float) -> None:
    result = to_wgs84(code, x, y)
    assert result is not None
    assert result[0] == pytest.approx(lat, abs=0.02)
    assert result[1] == pytest.approx(lon, abs=0.02)
    swapped = to_wgs84(code, y, x, swap_axes=True)
    assert swapped == pytest.approx(result)


def test_crs_validation() -> None:
    assert validate_crs("epsg:25832") == "EPSG:25832"
    with pytest.raises(CrsInvalidError):
        validate_crs("EPSG:999999")
    assert to_wgs84("EPSG:999999", 1.0, 2.0) is None


@pytest.mark.parametrize(
    ("label", "canonical"),
    [("BH-01", "BH1"), ("bh 1", "BH1"), ("B.H. 010", "BH10"), ("RC_002A", "RC2A"), ("SB 12-3", "SB123"), ("P10", "P10")],
)
def test_canonical_label(label: str, canonical: str) -> None:
    assert canonical_label(label) == canonical


class _Fv:
    def __init__(self, status: str) -> None:
        self.status = status


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([], "unreviewed"),
        (["unreviewed", "unreviewed"], "unreviewed"),
        (["approved", "unreviewed"], "in_review"),
        (["approved", "flagged"], "in_review"),
        (["flagged"], "in_review"),
        (["approved", "approved"], "approved"),
    ],
)
def test_review_status(statuses: list[str], expected: str) -> None:
    assert review_status_of([_Fv(s) for s in statuses]) == expected  # type: ignore[misc]
