"""Fewer needless questions (fictional German logs on a Gauss-Krüger grid near a fictional site):

1. a coordinate system answered for a project places the project's later boreholes that print none;
2. a map-sheet label printed where the system belongs is no system;
3. Gauss-Krüger values with their kilometre prefixes printed apart are joined;
4. the only borehole of a document that covers all its log pages gets no page-grouping question;
5. depths without a unit in a metric-language document are metres, not a question.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select, update

from app.clarify.answers import answer_clarification
from app.clarify.service import create_clarification
from app.db.models import Borehole, Clarification, Page, Revision
from app.db.session import get_sessionmaker
from app.normalize import crs as crs_parser
from app.normalize import units
from app.pipeline.finalize import _system_group, build_record, finalize_document, finalize_group
from app.pipeline.schemas import ExtractionResult
from app.pipeline.types import BlockRef, PageGroup
from tests.test_finalize import (
    blk,
    block_map,
    clarifications,
    header,
    layer,
    make_document,
    outcome,
    record_of,
    result,
    rv,
)

PROJECT = "Fiktive Ortsumgehung"
DOC_A = "doc_01JDEMOQ00000000000000000A"
DOC_B = "doc_01JDEMOQ00000000000000000B"
DOC_C = "doc_01JDEMOQ00000000000000000C"
DOC_D = "doc_01JDEMOQ00000000000000000D"
GK3 = "EPSG:31467"  # DHDN / 3-degree Gauss-Kruger zone 3


def gk_blocks(page: int, label: str, x: str, y: str, system: str | None, unit: bool) -> dict[str, BlockRef]:
    q = 0.95
    items = [
        blk(f"p{page}.b0", f"Bohrung {label}", (0.08, 0.04, 0.2, 0.02), quality=q),
        blk(f"p{page}.b1", f"R {x}", (0.6, 0.12, 0.2, 0.02), quality=q),
        blk(f"p{page}.b2", f"H {y}", (0.6, 0.14, 0.2, 0.02), quality=q),
        blk(f"p{page}.b3", system or "", (0.6, 0.16, 0.2, 0.02), quality=q),
        blk(f"p{page}.b4", "Tiefe [m]" if unit else "Tiefe", (0.08, 0.2, 0.1, 0.02), quality=q),
        blk(f"p{page}.b5", "0,00", (0.08, 0.25, 0.05, 0.02), quality=q),
        blk(f"p{page}.b6", "1,50", (0.08, 0.3, 0.05, 0.02), quality=q),
        blk(f"p{page}.b7", "4,00", (0.08, 0.4, 0.05, 0.02), quality=q),
        blk(f"p{page}.b8", "Sand, kiesig", (0.2, 0.25, 0.3, 0.02), quality=q),
        blk(f"p{page}.b9", "Ton, steif", (0.2, 0.32, 0.3, 0.02), quality=q),
    ]
    return block_map(items)


def gk_result(
    page: int, label: str, x: str, y: str, system: str | None, *, unit: bool = True, bottom: str = "4,00"
) -> ExtractionResult:
    head = header(
        borehole_label=rv(label, f"p{page}.b0"),
        depth_unit=rv("Tiefe [m]", f"p{page}.b4") if unit else rv(None, state="not_in_source"),
        x_raw=rv(x, f"p{page}.b1"),
        y_raw=rv(y, f"p{page}.b2"),
        labels_raw=rv("R, H", f"p{page}.b1", f"p{page}.b2"),
        system_raw=rv(system, f"p{page}.b3") if system else rv(None, state="not_in_source"),
    )
    layers = [
        layer(rv("0,00", f"p{page}.b5"), rv("1,50", f"p{page}.b6"), rv("Sand, kiesig", f"p{page}.b8")),
        layer(rv("1,50", f"p{page}.b6"), rv(bottom, f"p{page}.b7"), rv("Ton, steif", f"p{page}.b9")),
    ]
    return result(head, layers)


def gk_draft(
    x: str, y: str, system: str | None, *, unit: bool = True, language: str | None = None, **kw: str
):
    group = PageGroup(key="g-b1", label_raw="B1", label_canonical="B1", pages=(1,))
    out = outcome(gk_result(1, "B1", x, y, system, unit=unit, **kw), gk_blocks(1, "B1", x, y, system, unit))
    return build_record("doc_fictional", group, out, language=language)


# 2. map sheets -------------------------------------------------------------------------------------------


def test_a_map_sheet_printed_as_the_system_is_no_system() -> None:
    draft = gk_draft("3422925", "5370335", "TK25 7513 Fiktivstadt")
    assert (draft.crs_status, draft.crs_code) == ("inferred", None)
    assert draft.body is not None and _system_group(draft.body) == ""
    coords = draft.body["metadata"]["coordinates"]
    assert coords["coordinate_system"] == "TK25 7513 Fiktivstadt"  # the printed text is kept as printed
    assert any("map sheet" in note for note in draft.notes)
    for text in ("TK 25 Blatt 7513", "Blatt Fiktivstadt", "map sheet 12", "DTK25"):
        assert crs_parser.map_sheet(text), text
    for text in ("Gauss-Krüger Blatt 7513", "TK25 EPSG:31467", "DHDN", "UTM 32N", None, ""):
        assert not crs_parser.map_sheet(text), text


# 3. kilometre prefixes -----------------------------------------------------------------------------------


def test_gauss_krueger_values_with_their_kilometre_prefixes_printed_apart_are_joined() -> None:
    draft = gk_draft("22 925", "70 335", "34 53")
    coords = draft.body["metadata"]["coordinates"] if draft.body else {}
    assert (coords["local_x"], coords["local_y"]) == (3422925.0, 5370335.0)
    assert draft.provenance["metadata.coordinates.local_x"].method == "derived"
    assert draft.provenance["metadata.coordinates.local_x"].raw == "22 925"
    assert (draft.crs_status, draft.crs_code) == ("inferred", None)  # the prefixes name no system
    assert draft.body is not None and _system_group(draft.body) == ""
    assert any("kilometre prefixes" in note for note in draft.notes)
    # prefixes that place the point outside any Gauss-Krüger zone's area of use are not joined
    other = gk_draft("22 925", "70 335", "99 99")
    other_coords = other.body["metadata"]["coordinates"] if other.body else {}
    assert (other_coords["local_x"], other_coords["local_y"]) == (22925.0, 70335.0)
    assert not any("kilometre prefixes" in note for note in other.notes)


# 5. depths without a unit ---------------------------------------------------------------------------------


def test_depths_without_a_unit_in_a_german_document_are_metres_not_a_question() -> None:
    draft = gk_draft("3422925", "5370335", "Gauß-Krüger", unit=False, language="de")
    assert draft.guessed_depths == []
    methods = {
        p.method for path, p in draft.provenance.items() if path.endswith(("depth_from_m", "depth_to_m"))
    }
    assert methods == {"derived"}
    assert any("read as metres" in note and "(de)" in note for note in draft.notes)
    # English (also written where feet are used), no language known, or an implausible depth: still asked
    for kwargs in ({"language": "en"}, {"language": None}, {"language": "de", "bottom": "2500"}):
        asked = gk_draft("3422925", "5370335", "Gauß-Krüger", unit=False, **kwargs)  # type: ignore[arg-type]
        assert asked.guessed_depths, kwargs
    assert units.unitless_depths_in_metres("de", ["Fictional Town, USA"], [4.0]) is None
    assert units.unitless_depths_in_metres("pt-BR", ["Fictional Town"], [4.0]) is not None


# 4. page grouping of a single borehole -------------------------------------------------------------------


async def _revision_notes(uid: str) -> list[str]:
    async with get_sessionmaker()() as session:
        first = await session.scalar(select(Revision).where(Revision.uid == uid, Revision.revision == 1))
    assert first is not None
    return list((first.changes or {}).get("notes") or [])


@pytest.mark.db
async def test_the_only_borehole_covering_every_log_page_gets_no_boundary_question(db: None) -> None:
    await make_document(DOC_A, pages={1: ("cover_or_toc", [], 0.9), 2: ("log_sheet", ["B1"], 0.95)})
    group = PageGroup(
        key="g-b1", label_raw="B1", label_canonical="B1", pages=(2,), uncertain=("missing first sheet",)
    )
    out = outcome(
        gk_result(2, "B1", "3422925", "5370335", "Gauß-Krüger"),
        gk_blocks(2, "B1", "3422925", "5370335", "Gauß-Krüger", True),
    )
    uid = await finalize_group(DOC_A, group, out, alone=True)
    assert uid is not None
    assert await clarifications("borehole_boundary") == []
    assert any("missing first sheet" in note for note in await _revision_notes(uid))


@pytest.mark.db
async def test_a_boundary_question_stays_with_several_boreholes_or_uncovered_log_pages(db: None) -> None:
    await make_document(DOC_B, pages={2: ("log_sheet", ["B1"], 0.95), 3: ("log_continuation", [], 0.4)})
    blocks = gk_blocks(2, "B1", "3422925", "5370335", "Gauß-Krüger", True)
    res = gk_result(2, "B1", "3422925", "5370335", "Gauß-Krüger")
    uncovered = PageGroup(key="g-b1", label_raw="B1", label_canonical="B1", pages=(2,), uncertain=("x",))
    await finalize_group(DOC_B, uncovered, outcome(res, blocks), alone=True)  # page 3 is not covered
    await make_document(DOC_C, pages={2: ("log_sheet", ["B1"], 0.95)})
    several = PageGroup(key="g-b1", label_raw="B1", label_canonical="B1", pages=(2,), uncertain=("y",))
    await finalize_group(DOC_C, several, outcome(res, blocks), alone=False)
    assert len(await clarifications("borehole_boundary")) == 2


@pytest.mark.db
async def test_depths_without_a_unit_ask_no_question_in_a_german_document(db: None) -> None:
    await make_document(DOC_A, pages={1: ("log_sheet", ["B1"], 0.95)})
    async with get_sessionmaker()() as session:
        await session.execute(update(Page).where(Page.document_id == DOC_A).values(language="de"))
        await session.commit()
    group = PageGroup(key="g-b1", label_raw="B1", label_canonical="B1", pages=(1,))
    res = gk_result(1, "B1", "3422925", "5370335", "Gauß-Krüger", unit=False)
    uid = await finalize_group(
        DOC_A, group, outcome(res, gk_blocks(1, "B1", "3422925", "5370335", "Gauß-Krüger", False))
    )
    assert uid is not None
    assert await clarifications("unit_ambiguous") == []
    rec = await record_of(uid)
    assert [(la.depth_from_m, la.depth_to_m) for la in rec.stratigraphy] == [(0.0, 1.5), (1.5, 4.0)]
    assert rec.provenance["stratigraphy[1].depth_to_m"].method == "derived"
    assert any("read as metres" in note for note in await _revision_notes(uid))


# 1. a project's answered coordinate system ---------------------------------------------------------------


async def _finalize(doc_id: str, label: str, x: str, y: str, system: str | None) -> str:
    await make_document(doc_id, pages={1: ("log_sheet", [label], 0.95)}, project=PROJECT)
    group = PageGroup(key=f"g-{label}", label_raw=label, label_canonical=label, pages=(1,))
    uid = await finalize_group(
        doc_id, group, outcome(gk_result(1, label, x, y, system), gk_blocks(1, label, x, y, system, True))
    )
    assert uid is not None
    return uid


@pytest.mark.db
async def test_a_system_answered_for_the_project_places_its_later_boreholes(db: None) -> None:
    first = await _finalize(DOC_A, "B1", "3422925", "5370335", None)
    await finalize_document(DOC_A)
    (question,) = await clarifications("crs_confirm")
    assert question.borehole_uids == [first]
    async with get_sessionmaker()() as session:
        await answer_clarification(
            session, question.id, {"crs": GK3, "swap_axes": False}, "Fictional Reviewer"
        )
        await session.commit()
    assert (await record_of(first)).plotted

    # a later upload of the project prints only a map sheet where its system belongs
    near = await _finalize(DOC_B, "B2", "3423480", "5371020", "TK25 7513")
    # an earlier run had asked about it already: the answer settles that question too
    async with get_sessionmaker()() as session:
        open_question = await create_clarification(
            session,
            kind="crs_confirm",
            document_id=DOC_B,
            question="Which coordinate system? (fictional, from an earlier run)",
            fields=[
                {"name": "crs", "widget": "crs_picker", "label": "System", "required": True, "options": []}
            ],
            evidence=[],
            borehole_uids=[near],
            project=PROJECT,
            dedupe_key="crs_confirm:fictional-earlier-run",
        )
        open_id = open_question.id
        await session.commit()
    await finalize_document(DOC_B)
    rec = await record_of(near)
    assert (rec.crs_status, rec.metadata.coordinates.crs_code, rec.plotted) == ("confirmed", GK3, True)
    async with get_sessionmaker()() as session:
        settled = await session.get(Clarification, open_id)
        assert settled is not None and settled.status == "answered"
        assert settled.answer["crs"] == GK3 and settled.answer["via"] == "project_answer"
        revision = await session.scalar(
            select(Revision)
            .where(Revision.uid == near, Revision.action == "crs")
            .order_by(Revision.revision.desc())
        )
    assert revision is not None and question.id in revision.changes["note"]
    assert len([q for q in await clarifications("crs_confirm") if q.status == "open"]) == 0

    # one more upload prints its values with the kilometre prefixes apart: joined, then placed at once
    prefixed = await _finalize(DOC_D, "B4", "22 610", "69 880", "34 53")
    await finalize_document(DOC_D)
    rec = await record_of(prefixed)
    assert (rec.metadata.coordinates.local_x, rec.metadata.coordinates.local_y) == (3422610.0, 5369880.0)
    assert (rec.crs_status, rec.plotted) == ("confirmed", True)

    # far from every placed borehole of the project: still asked
    far = await _finalize(DOC_C, "B3", "3480000", "5400000", None)
    await finalize_document(DOC_C)
    async with get_sessionmaker()() as session:
        bh = await session.get(Borehole, far)
        assert bh is not None and bh.crs_status == "inferred"
    asked = [q for q in await clarifications("crs_confirm") if q.status == "open"]
    assert len(asked) == 1 and asked[0].borehole_uids == [far]


@pytest.mark.db
async def test_answering_places_the_project_boreholes_left_out_of_that_question(db: None) -> None:
    """A borehole whose own question was skipped is placed when another project question is answered."""
    first = await _finalize(DOC_A, "B1", "3422925", "5370335", None)
    await finalize_document(DOC_A)
    (question,) = await clarifications("crs_confirm")
    skipped_uid = await _finalize(DOC_B, "B2", "3423480", "5371020", "Blatt Fiktivstadt")
    async with get_sessionmaker()() as session:
        skipped = await create_clarification(
            session,
            kind="crs_confirm",
            document_id=DOC_B,
            question="Which coordinate system? (fictional, skipped)",
            fields=[
                {"name": "crs", "widget": "crs_picker", "label": "System", "required": True, "options": []}
            ],
            evidence=[],
            borehole_uids=[skipped_uid],
            project=PROJECT,
            dedupe_key="crs_confirm:fictional-skipped",
        )
        skipped.status = "skipped"
        skipped_id = skipped.id
        await session.commit()
    async with get_sessionmaker()() as session:
        await answer_clarification(
            session, question.id, {"crs": GK3, "swap_axes": False}, "Fictional Reviewer"
        )
        await session.commit()
    for uid in (first, skipped_uid):
        rec = await record_of(uid)
        assert (rec.crs_status, rec.plotted) == ("confirmed", True), uid
    async with get_sessionmaker()() as session:
        settled = await session.get(Clarification, skipped_id)
        assert settled is not None and settled.status == "answered"
        assert settled.answered_by == "Fictional Reviewer"
