"""Boreholes on one site grid: one question places them all (app.clarify.grid). Fictional site and values."""

from __future__ import annotations

import cmath
import math
from typing import Any

import pytest
from pyproj import Transformer

from app.clarify.grid import X_EAST, X_NORTH, fit, grid_name
from app.db.session import get_sessionmaker
from app.errors import ApiError
from app.pipeline.finalize import finalize_document
from tests.test_checks import add_borehole, answer, assert_contract, new_document
from tests.test_finalize import clarifications, record_of

# A fictional site grid: X is north, Y is east, rotated 3 degrees from UTM 32N, origin near 59.95 N 10.78 E.
ORIGIN_E, ORIGIN_N, TURN = 598000.0, 6646000.0, math.radians(3.0)
GRID = {"T-1": (4890.0, 2875.0), "T-2": (4931.0, 2901.0), "T-3": (5245.0, 3170.5)}
TO_WGS84 = Transformer.from_crs(32632, 4326, always_xy=True)


def truth(x: float, y: float) -> tuple[float, float]:
    """(lat, lon) of grid point (x north, y east) on the fictional site."""
    z = cmath.rect(1.0, TURN) * complex(y, x) + complex(ORIGIN_E - 2000.0, ORIGIN_N - 4000.0)
    lon, lat = TO_WGS84.transform(z.real, z.imag)
    return lat, lon


def grid_body(label: str, x: float, y: float) -> dict[str, Any]:
    return {
        "metadata": {
            "borehole_id": label,
            "coordinates": {
                "x_raw": f"{x:.1f}".replace(".", ","),
                "y_raw": f"{y:.1f}".replace(".", ","),
                "local_x": x,
                "local_y": y,
                "coordinate_system": "Fictional lokal",
            },
        },
        "stratigraphy": [{"depth_from_m": 0.0, "depth_to_m": 5.0}],
        "groundwater": [],
    }


def test_two_anchors_recover_rotation_and_one_anchor_only_shifts() -> None:
    w1, w2 = (0.0, 0.0), (100.0, 0.0)  # x north
    m1, m2 = (500.0, 1000.0), (500.0 - 100 * math.sin(0.1), 1000.0 + 100 * math.cos(0.1))
    a, _ = fit([(w1, m1), (w2, m2)], x_north=True)
    assert abs(abs(a) - 1.0) < 1e-9 and abs(cmath.phase(a) - 0.1) < 1e-9
    a1, b1 = fit([(w1, m1)], x_north=False)
    assert a1 == 1 and b1 == complex(*m1)


def test_an_unnamed_grid_joins_the_only_named_grid_of_the_document() -> None:
    assert grid_name(["unnamed local grid", "Site lokal"]) == {
        "unnamed local grid": "Site lokal",
        "Site lokal": "Site lokal",
    }
    names = grid_name(["unnamed local grid", "A lokal", "B lokal"])
    assert names["unnamed local grid"] == "unnamed local grid"


async def _site() -> tuple[str, dict[str, str]]:
    async with get_sessionmaker()() as session:
        doc = await new_document(session, "doc_01JGRID00000000000000000A1", file_name="fictional-grid.pdf")
        uids = {}
        for n, (label, (x, y)) in enumerate(GRID.items(), start=1):
            bh = await add_borehole(
                session, doc, f"g{n}", grid_body(label, x, y), crs_status="unknown", crs_code=None, page=n
            )
            uids[label] = bh.uid
        await session.commit()
    await finalize_document(doc.id)
    await finalize_document(doc.id)
    return doc.id, uids


@pytest.mark.db
async def test_one_question_per_grid_and_two_anchors_place_every_borehole(db: None) -> None:
    _, uids = await _site()
    (question,) = await clarifications("locate_borehole")
    await assert_contract(question)
    assert sorted(question.borehole_uids) == sorted(uids.values())
    assert [f["name"] for f in question.fields] == [
        "anchor_1",
        "point_1",
        "anchor_2",
        "point_2",
        "axes",
        "source_note",
    ]
    assert "Fictional lokal" in question.question
    lat1, lon1 = truth(*GRID["T-1"])
    lat3, lon3 = truth(*GRID["T-3"])
    await answer(
        question.id,
        {
            "anchor_1": uids["T-1"],
            "point_1": {"lat": lat1, "lon": lon1},
            "anchor_2": uids["T-3"],
            "point_2": {"lat": lat3, "lon": lon3},
            "axes": X_NORTH,
        },
    )
    lat2, lon2 = truth(*GRID["T-2"])
    rec = await record_of(uids["T-2"])
    assert rec.plotted
    north_m = (rec.metadata.coordinates.latitude - lat2) * 111_320
    east_m = (rec.metadata.coordinates.longitude - lon2) * 111_320 * math.cos(math.radians(lat2))
    assert math.hypot(north_m, east_m) < 0.5


@pytest.mark.db
async def test_misplaced_anchors_are_refused_and_one_anchor_shifts_the_grid(db: None) -> None:
    _, uids = await _site()
    (question,) = await clarifications("locate_borehole")
    lat1, lon1 = truth(*GRID["T-1"])
    with pytest.raises(ApiError):
        await answer(
            question.id,
            {
                "anchor_1": uids["T-1"],
                "point_1": {"lat": lat1, "lon": lon1},
                "anchor_2": uids["T-3"],
                "point_2": {"lat": lat1 + 0.05, "lon": lon1},  # 5.5 km away, the grid says 440 m
                "axes": X_NORTH,
            },
        )
    await answer(
        question.id, {"anchor_1": uids["T-1"], "point_1": {"lat": lat1, "lon": lon1}, "axes": X_EAST}
    )
    for uid in uids.values():
        assert (await record_of(uid)).plotted


@pytest.mark.db
async def test_two_anchors_on_the_same_grid_point_are_refused_not_a_server_error(db: None) -> None:
    async with get_sessionmaker()() as session:
        doc = await new_document(session, "doc_01JGRID00000000000000000B2", file_name="fictional-grid-2.pdf")
        uids = {}
        points = {"T-1": GRID["T-1"], "T-1b": GRID["T-1"], "T-2": GRID["T-2"]}  # a hole logged twice
        for n, (label, (x, y)) in enumerate(points.items(), start=1):
            bh = await add_borehole(
                session, doc, f"g{n}", grid_body(label, x, y), crs_status="unknown", crs_code=None, page=n
            )
            uids[label] = bh.uid
        await session.commit()
    await finalize_document(doc.id)
    (question,) = await clarifications("locate_borehole")
    lat1, lon1 = truth(*GRID["T-1"])
    with pytest.raises(ApiError):
        await answer(
            question.id,
            {
                "anchor_1": uids["T-1"],
                "point_1": {"lat": lat1, "lon": lon1},
                "anchor_2": uids["T-1b"],
                "point_2": {"lat": lat1 + 0.001, "lon": lon1},
                "axes": X_NORTH,
            },
        )
