"""Value path grammar and typed edits (fictional records)."""

from __future__ import annotations

import pytest

from app.review.paths import (
    PathError,
    ValueParseError,
    coerce_value,
    get_value,
    iter_paths,
    parse_path,
    path_exists,
    set_value,
)

BODY = {
    "metadata": {
        "borehole_id": "FX-01",
        "borehole_depth_m": 12.5,
        "coordinates": {"local_x": 512345.6, "local_y": 5412345.1, "x_raw": "512 345,6"},
    },
    "stratigraphy": [
        {"depth_from_m": 0.0, "depth_to_m": 1.2, "din4023_code": "mG"},
        {"depth_from_m": 1.2, "depth_to_m": 4.0, "din4023_code": None, "spt_n_value": 14},
    ],
    "groundwater": [{"type": "strike", "depth_m": 2.4}],
    "samples": [{"name": "S1", "depth_from_m": 1.0}],
    "test_results": [{"name": "UCS", "value": 41.0, "unit": "MPa"}],
    "rock_head_m": None,
}


@pytest.mark.parametrize(
    "path",
    [
        "rock_head_m",
        "metadata.borehole_id",
        "metadata.surface_elevation_mASL",
        "metadata.coordinates.x_raw",
        "stratigraphy[1].spt_n_value",
        "groundwater[0].depth_m",
        "samples[0].name",
        "test_results[0].value",
    ],
)
def test_valid_paths_round_trip(path: str) -> None:
    assert str(parse_path(path)) == path
    assert path_exists(BODY, path)


@pytest.mark.parametrize(
    "path",
    [
        "metadata.coordinates",
        "metadata",
        "metadata.unknown_field",
        "stratigraphy[01].depth_to_m",
        "stratigraphy[-1].depth_to_m",
        "stratigraphy[0].unknown",
        "test_results[0].name",
        "layers[0].depth_to_m",
        "stratigraphy.0.depth_to_m",
        "",
    ],
)
def test_invalid_paths(path: str) -> None:
    with pytest.raises(PathError):
        parse_path(path)


def test_out_of_range_index_does_not_exist() -> None:
    assert not path_exists(BODY, "stratigraphy[2].depth_to_m")
    with pytest.raises(PathError):
        get_value(BODY, "stratigraphy[2].depth_to_m")


@pytest.mark.parametrize(
    ("path", "value", "expected"),
    [
        ("stratigraphy[0].depth_to_m", "1,35", 1.35),
        ("stratigraphy[0].depth_to_m", "1.35", 1.35),
        ("stratigraphy[0].depth_to_m", "−1.5", -1.5),
        ("stratigraphy[0].depth_to_m", 2, 2.0),
        ("metadata.borehole_id", 7, "7"),
        ("stratigraphy[1].spt_n_value", 23, 23),
        ("stratigraphy[0].din4023_code", "Kst", "Kst"),
        ("stratigraphy[0].din4023_code", None, None),
        ("metadata.start_date", "2026-03-04", "2026-03-04"),
        ("groundwater[0].depth_m", None, None),
        ("rock_head_m", "3,5", 3.5),
    ],
)
def test_coerce_accepts(path: str, value: object, expected: object) -> None:
    assert coerce_value(BODY, path, value) == expected


@pytest.mark.parametrize(
    ("path", "value"),
    [
        ("stratigraphy[0].din4023_code", "sand"),
        ("stratigraphy[0].din4023_code", "MG"),  # keys are case-sensitive
        ("stratigraphy[1].spt_n_value", -1),
        ("stratigraphy[1].spt_n_value", 12.5),
        ("stratigraphy[0].depth_to_m", "twelve"),
        ("stratigraphy[0].depth_from_m", None),  # layer depths are required numbers
        ("metadata.borehole_depth_m", -3),
        ("metadata.start_date", "04/03/2026"),
        ("metadata.depth_origin", "sky"),
        ("groundwater[0].type", "lake"),
        ("rock_head_m", -1),
    ],
)
def test_coerce_rejects(path: str, value: object) -> None:
    with pytest.raises(ValueParseError):
        coerce_value(BODY, path, value)


def test_set_value_never_reorders() -> None:
    import copy

    body = copy.deepcopy(BODY)
    set_value(body, "stratigraphy[0].depth_from_m", 9.0)
    assert [layer["depth_from_m"] for layer in body["stratigraphy"]] == [9.0, 1.2]


def test_iter_paths_covers_arrays() -> None:
    paths = set(iter_paths(BODY))
    assert "stratigraphy[1].spt_n_value" in paths
    assert "test_results[0].value" in paths
    assert "test_results[0].name" not in paths
    assert all(path_exists(BODY, p) for p in paths)
