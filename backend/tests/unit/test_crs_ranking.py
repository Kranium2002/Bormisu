"""FICTIONAL points only. CRS candidate ranking (app.geo.crs_candidates), no database.

Points are made by projecting invented positions near fictional places with a known system, so each case
knows its right answer. Three continents, so nothing depends on one region's grids.
"""

from __future__ import annotations

import itertools
import math

import pytest
from pyproj import Transformer

from app.geo.crs_candidates import (
    Reference,
    area_of_use_km2,
    crs_label,
    match_alias,
    rank_candidates,
    ranking_config,
    reference_queries,
)
from app.schemas.documents import CrsCandidate

# (system the points are printed in, fictional place near which they lie: lat, lon)
CASES = {
    "europe": ("EPSG:25832", 53.88, 8.51),
    "asia": ("EPSG:32640", 25.2, 55.4),
    "south_america": ("EPSG:31983", -23.6, -46.7),
}


def _points(code: str, lat: float, lon: float) -> list[tuple[str, float, float]]:
    """Three boreholes of one fictional site, printed (easting, northing) in `code`."""
    to_grid = Transformer.from_crs("EPSG:4326", code, always_xy=True)
    offsets = ((0.0, 0.0), (0.004, 0.006), (-0.003, 0.009))
    points = []
    for i, (dlat, dlon) in enumerate(offsets):
        x, y = to_grid.transform(lon + dlon, lat + dlat)
        points.append((f"bh_fictional_{i}", round(x, 2), round(y, 2)))
    return points


def _reference(lat: float, lon: float) -> Reference:
    return Reference(lat + 0.02, lon - 0.03, "Fictional Town", "geocoder")


def _key(candidate: CrsCandidate) -> tuple[int, float]:
    order = {"match": 0, "shifted": 1, "out_of_range": 2}
    return order[candidate.verdict or "out_of_range"], -(candidate.score or 0.0)


@pytest.mark.parametrize("case", sorted(CASES))
def test_reference_place_puts_the_right_system_first(case: str) -> None:
    code, lat, lon = CASES[case]
    ranked = rank_candidates(_points(code, lat, lon), reference=_reference(lat, lon))
    best = ranked[0]
    assert best.crs == code and best.verdict == "match" and best.swap_axes is False
    assert "Fictional Town" in (best.note or "")
    # Every other system that also lands inside its area of use is far from the place: shifted, lower.
    for other in ranked[1:]:
        if other.crs != code and other.verdict == "match":
            # only a system with the same grid parameters (another datum of the same zone) may also match
            assert abs(other.points[0].lat - best.points[0].lat) < 0.01, other.crs
        assert (other.score or 0) <= (best.score or 0)
    assert all(p.uid.startswith("bh_fictional_") for p in best.points)


@pytest.mark.parametrize("case", sorted(CASES))
def test_without_reference_ties_are_ordered_by_area_then_code(case: str) -> None:
    code, lat, lon = CASES[case]
    ranked = rank_candidates(_points(code, lat, lon))
    assert ranked and ranked[0].verdict == "match"
    assert any(c.crs == code and c.verdict == "match" for c in ranked), "the right system stays listed"
    for a, b in itertools.pairwise(ranked):
        assert _key(a) <= _key(b)
        if _key(a) == _key(b):
            area_a, area_b = area_of_use_km2(a.crs) or math.inf, area_of_use_km2(b.crs) or math.inf
            assert area_a <= area_b, (a.crs, b.crs)
            if area_a == area_b and a.crs != b.crs:
                assert int(a.crs.split(":")[1]) < int(b.crs.split(":")[1])
    assert all("no reference place found" in (c.note or "") for c in ranked)


def test_ties_between_datums_of_one_zone_go_to_the_smaller_area() -> None:
    """NAD83 and WGS 84 UTM 18N place the points within a metre of each other: a tie, broken by area."""
    points = _points("EPSG:26918", 40.75, -73.98)
    for reference in (None, _reference(40.75, -73.98)):
        ranked = rank_candidates(points, reference=reference)
        codes = [c.crs for c in ranked if not c.swap_axes]
        assert "EPSG:26918" in codes and "EPSG:32618" in codes
        nad83 = next(c for c in ranked if c.crs == "EPSG:26918" and not c.swap_axes)
        wgs84 = next(c for c in ranked if c.crs == "EPSG:32618" and not c.swap_axes)
        assert nad83.score == wgs84.score and nad83.verdict == wgs84.verdict == "match"
        assert codes.index("EPSG:26918") < codes.index("EPSG:32618")
        assert (area_of_use_km2("EPSG:26918") or 0) < (area_of_use_km2("EPSG:32618") or 0)


def test_world_wide_systems_are_demoted() -> None:
    code, lat, lon = CASES["europe"]
    ranked = rank_candidates(_points(code, lat, lon))
    regional = [c for c in ranked if c.verdict == "match" and c.crs != "EPSG:3857"]
    assert regional
    mercator = [c for c in ranked if c.crs == "EPSG:3857"]
    for candidate in mercator:
        assert (candidate.score or 0) < min(c.score or 0 for c in regional)
        assert "world-wide" in (candidate.note or "")
    if not mercator:  # cut by the cap: then it is named in the last note
        assert "EPSG:3857" in (ranked[-1].note or "")


def test_far_reference_makes_inside_candidates_shifted() -> None:
    code, lat, lon = CASES["asia"]
    far = Reference(lat + 5.0, lon + 5.0, "Fictional Elsewhere", "geocoder")
    ranked = rank_candidates(_points(code, lat, lon), reference=far)
    right = next(c for c in ranked if c.crs == code and not c.swap_axes)
    assert right.verdict == "shifted" and "km from 'Fictional Elsewhere'" in (right.note or "")


def test_reference_bounding_box_counts_as_distance_zero() -> None:
    place = Reference(50.0, 10.0, "Fictional Region", "geocoder", (8.0, 49.0, 12.0, 51.0))
    assert place.distance_km(50.9, 8.1) == 0.0
    assert place.distance_km(52.0, 10.0) == pytest.approx(111.2, rel=0.01)
    point = Reference(50.0, 10.0, "Fictional Point", "uploaded")
    assert point.distance_km(50.0, 10.0) == 0.0


def test_cap_keeps_matching_ties_and_names_what_it_drops() -> None:
    code, lat, lon = CASES["europe"]
    ranked = rank_candidates(_points(code, lat, lon))
    limit = ranking_config().max_candidates
    matches = [c for c in ranked if c.verdict == "match"]
    if len(ranked) > limit:
        tail = ranked[limit - 1 :]
        assert all((c.verdict, c.score) == (tail[0].verdict, tail[0].score) for c in tail)
    assert "more candidates not listed" in (ranked[-1].note or "")
    assert len(matches) >= 2


def test_cap_cuts_weak_ties_with_a_note() -> None:
    code, lat, lon = CASES["asia"]
    ranked = rank_candidates(_points(code, lat, lon), reference=_reference(lat, lon))
    assert len(ranked) == ranking_config().max_candidates
    note = ranked[-1].note or ""
    assert "more candidates not listed" in note and "EPSG:" in note


def test_geographic_points_rank_geographic_systems_only() -> None:
    points = [("bh_fictional_0", 8.51, 53.88), ("bh_fictional_1", 8.52, 53.885)]
    ranked = rank_candidates(points)
    assert ranked and all(
        c.crs in {"EPSG:4326", "EPSG:4258", "EPSG:4283", "EPSG:7844", "EPSG:4167"} for c in ranked
    )
    assert ranked[0].crs == "EPSG:4258"  # smallest area of use that holds the points (ETRS89, Europe)


def test_no_points_no_candidates() -> None:
    assert rank_candidates([]) == []


def test_reference_utm_zone_is_tried_when_the_registry_lacks_it() -> None:
    lat, lon = -33.5, 21.0  # fictional site; UTM zone 34S is not in the registry
    ranked = rank_candidates(_points("EPSG:32734", lat, lon), reference=_reference(lat, lon))
    assert ranked[0].crs == "EPSG:32734" and ranked[0].verdict == "match"
    assert "UTM zone of the reference place" in (ranked[0].note or "")


def test_reference_queries_go_from_specific_to_general() -> None:
    queries = reference_queries(
        ["Lindenwick, Nordkai", "Lindenwick, Nordkai", None, "  "],
        ["Fictional Harbour Link", "fictional harbour link", None],
        ["Germany", None],
    )
    assert queries == [
        "Lindenwick, Nordkai, Germany",
        "Lindenwick, Nordkai",
        "Fictional Harbour Link",
        "Germany",
    ]
    assert reference_queries([], [], []) == []


def test_crs_label_prefers_the_registry_then_pyproj() -> None:
    assert crs_label("EPSG:2154") == "RGF93 / Lambert-93"  # registry label
    assert crs_label("epsg:25832") == "ETRS89 / UTM zone 32N"
    assert crs_label("EPSG:32654") == "WGS 84 / UTM zone 54N"  # not in the registry: EPSG name
    assert crs_label("EPSG:999999") is None
    assert crs_label(None) is None and crs_label("") is None


def test_match_alias_is_unchanged() -> None:
    entry = match_alias("55H MGA94")
    assert entry is not None and entry.code == "EPSG:28355"
    assert match_alias("no such system") is None and match_alias(None) is None


def test_ranking_thresholds_come_from_the_registry() -> None:
    cfg = ranking_config()
    assert cfg.max_candidates >= 1 and cfg.match_km > 0 and cfg.reference_scale_km > 0
    assert set(cfg.bands) == {"match", "shifted", "out_of_range"}
    low_match = cfg.bands["match"][0]
    assert cfg.bands["shifted"][1] <= low_match and cfg.bands["out_of_range"][1] <= cfg.bands["shifted"][0]
