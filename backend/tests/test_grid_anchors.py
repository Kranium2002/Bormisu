"""A site grid placed from the document's own boreholes that a map system places (app.clarify.grid_anchors).
Fictional boreholes: two anchors printed in ETRS89 / UTM zone 32N and on the site grid "Fiktiv lokal", and
grid-only boreholes between them."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db.models import Borehole, Clarification, FieldValue
from app.db.session import get_sessionmaker
from app.pipeline.finalize import finalize_document, finalize_group
from app.pipeline.types import PageGroup
from tests.test_demo_questions import gk_blocks, gk_result
from tests.test_finalize import make_document, outcome

pytestmark = pytest.mark.db

DOC = "doc_01JGRIDANCHOR0000000000001"
UTM = "ETRS89 / UTM zone 32N"
GRID = "Fiktiv lokal"
# grid (x east, y north, metres) -> UTM: east = 500000 + x, north = 5400000 + y (scale 1, no rotation)
ANCHORS = {"A1": (1000.0, 2000.0), "A2": (1300.0, 2400.0)}
MEMBERS = {"G1": (1150.0, 2200.0), "G2": (1250.0, 2100.0)}


def utm_of(x: float, y: float) -> tuple[str, str]:
    return f"{500000 + x:.0f}", f"{5400000 + y:.0f}"


async def build(anchor_utm: dict[str, tuple[str, str]]) -> dict[str, str]:
    """The document with its anchors (placed by UTM) and grid-only boreholes; label -> group key."""
    labels = [*anchor_utm, *MEMBERS]
    await make_document(
        DOC, pages={n: ("log_sheet", [label], 0.95) for n, label in enumerate(labels, start=1)}
    )
    keys: dict[str, str] = {}
    for n, label in enumerate(labels, start=1):
        x, y, system = (*anchor_utm[label], UTM) if label in anchor_utm else (*map(str, MEMBERS[label]), GRID)
        group = PageGroup(key=f"{label}:p{n}", label_raw=label, label_canonical=label, pages=(n,))
        uid = await finalize_group(
            DOC, group, outcome(gk_result(n, label, x, y, system), gk_blocks(n, label, x, y, system, True))
        )
        assert uid is not None
        keys[label] = group.key
    return keys


async def state() -> dict[str, tuple[bool, str | None]]:
    async with get_sessionmaker()() as session:
        rows = (await session.scalars(select(Borehole).where(Borehole.document_id == DOC))).all()
        return {bh.label_raw: (bh.plotted, bh.unplotted_reason) for bh in rows}


async def locate_questions() -> list[Clarification]:
    async with get_sessionmaker()() as session:
        query = select(Clarification).where(
            Clarification.kind == "locate_borehole", Clarification.status == "open"
        )
        return list((await session.scalars(query)).all())


async def test_two_anchors_place_the_rest_of_the_grid(db: None) -> None:
    keys = await build({label: utm_of(*point) for label, point in ANCHORS.items()})
    anchors = {keys[label]: (GRID, *point) for label, point in ANCHORS.items()}
    await finalize_document(DOC, grid_anchors=anchors)
    placed = await state()
    assert all(plotted for plotted, _ in placed.values()), placed
    assert await locate_questions() == []
    async with get_sessionmaker()() as session:
        g1 = await session.scalar(select(Borehole).where(Borehole.label_raw == "G1"))
        assert g1 is not None
        lat = await session.get(FieldValue, (g1.uid, "metadata.coordinates.latitude"))
        lon = await session.get(FieldValue, (g1.uid, "metadata.coordinates.longitude"))
    assert lat is not None and lon is not None
    assert (lat.method, lat.status) == ("derived", "flagged") and "A1 and A2" in (lat.flag or "")
    # G1 lies where the grid puts it: the UTM point (501150, 5402200) of the fictional mapping
    from pyproj import Transformer

    east, north = Transformer.from_crs(4326, 25832, always_xy=True).transform(lon.value, lat.value)
    assert abs(east - 501150) < 1 and abs(north - 5402200) < 1


async def test_one_anchor_keeps_the_question(db: None) -> None:
    keys = await build({"A1": utm_of(*ANCHORS["A1"])})
    await finalize_document(DOC, grid_anchors={keys["A1"]: (GRID, *ANCHORS["A1"])})
    placed = await state()
    assert placed["A1"][0] and not placed["G1"][0] and not placed["G2"][0]
    (question,) = await locate_questions()
    assert len(question.borehole_uids) == 2


async def test_anchors_that_disagree_with_the_grid_keep_the_question(db: None) -> None:
    # A2's map point is 2 km off where its grid position puts it: the scale guard refuses the pair
    keys = await build({"A1": utm_of(*ANCHORS["A1"]), "A2": utm_of(3300.0, 2400.0)})
    anchors = {keys[label]: (GRID, *point) for label, point in ANCHORS.items()}
    await finalize_document(DOC, grid_anchors=anchors)
    placed = await state()
    assert not placed["G1"][0] and not placed["G2"][0]
    assert len(await locate_questions()) == 1


async def test_anchors_too_close_for_far_boreholes_keep_the_question(db: None) -> None:
    near = {"A1": (1000.0, 2000.0), "A2": (1010.0, 2005.0)}  # 11 m apart, the others up to 230 m away
    keys = await build({label: utm_of(*point) for label, point in near.items()})
    await finalize_document(DOC, grid_anchors={keys[label]: (GRID, *point) for label, point in near.items()})
    placed = await state()
    assert not placed["G1"][0] and len(await locate_questions()) == 1
