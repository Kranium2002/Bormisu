"""FICTIONAL document-level checks: lint across a document's boreholes and the remaining clarification kinds.

Every label, place, coordinate, note and value below is invented. Families: a German metric site in UTM
zone 32N, an Australian-style log in English, a US-style site in feet, a Pacific site on the antimeridian,
a French and a Scandinavian-style log. No provider is called.

Covered: positions far from the document's cluster (unplotted as implausible, recomputed when a member
changes), identical coordinates, `duplicate` (page copies and repeated boreholes, answered with aliases),
`conflicting_sources` (hand-built readings: the extraction output cannot express two readings yet),
`datum_convention` (sign notes against the printed depths) and `locate_borehole`.
"""

from __future__ import annotations

import hashlib
from typing import Any

import pytest
from sqlalchemy import select

from app.clarify.answers import answer_clarification
from app.clarify.checks import SourceReading, ask_conflicting_sources, distinct_readings, needs_location
from app.clarify.duplicates import page_copies
from app.clarify.service import clarification_out
from app.db.models import Borehole, Clarification, Document, Event, FieldValue, Page, Revision
from app.db.session import get_sessionmaker
from app.normalize.api import DepthOrigin
from app.normalize.datums import parse_depth_origin
from app.pipeline.classify import mark_document_duplicate
from app.pipeline.finalize import finalize_document, finalize_group
from app.pipeline.schemas import ExtractionResult
from app.pipeline.types import BlockRef, PageGroup
from app.review.service import (
    apply_patch,
    apply_patches,
    canonical_label,
    create_borehole,
    refresh_document_checks,
    to_record,
)
from app.schemas.boreholes import BoreholeRecord, ValuePatch
from app.validate.datum import check_datum_convention
from app.validate.document import Member, cluster_outliers, document_lint, shared_coordinates
from tests.contract_utils import validate_schema
from tests.factories import full_provenance
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

# ----------------------------------------------------------------------------------------------
# Pure: positions far from the document's cluster, identical coordinates
# ----------------------------------------------------------------------------------------------

# (latitude, longitude) of one invented site per family, with a few metres of offsets for its boreholes.
SITES = {
    "de_utm": (48.1371, 11.5754),
    "au_mga": (-33.8688, 151.2093),
    "us_feet": (40.7128, -74.0060),
    "pacific": (-17.7134, 179.9990),
}


def member(uid: str, lat: float | None, lon: float | None, **extra: Any) -> Member:
    label = extra.pop("label", uid.upper())
    return Member(
        uid=uid,
        label=label,
        label_canonical=canonical_label(label),
        latitude=lat,
        longitude=lon,
        **extra,
    )


def wrap(lon: float) -> float:
    return (lon + 180.0) % 360.0 - 180.0


@pytest.mark.parametrize("family", sorted(SITES))
def test_a_position_far_from_the_cluster_is_flagged(family: str) -> None:
    lat, lon = SITES[family]
    members = [
        member("a", lat, lon),
        member("b", lat + 0.0021, wrap(lon + 0.0013)),
        member("c", lat - 0.0012, wrap(lon + 0.0024)),
        member("d", lat + 0.0005, wrap(lon - 0.0019)),
        # A digit misread in the printed northing: about 110 km away.
        member("e", lat + 1.0, lon, position_path="metadata.coordinates.x_raw"),
    ]
    lint = document_lint(members)
    assert [item["rule"] for item in lint["e"]] == ["coordinates_far_from_cluster"]
    assert lint["e"][0]["severity"] == "error" and lint["e"][0]["path"] == "metadata.coordinates.x_raw"
    assert "km" in lint["e"][0]["message"]
    assert all(lint[uid] == [] for uid in "abcd")


def test_cluster_needs_enough_points_and_respects_second_sites_and_people() -> None:
    lat, lon = SITES["de_utm"]
    # Two positions: nothing to call a cluster.
    assert cluster_outliers([member("a", lat, lon), member("b", lat + 2.0, lon)]) == {}
    # Three boreholes at one site and two at a second site 60 km away: no outlier.
    two_sites = [
        member("a", lat, lon),
        member("b", lat + 0.001, lon),
        member("c", lat, lon + 0.001),
        member("d", lat + 0.54, lon),
        member("e", lat + 0.541, lon + 0.001),
    ]
    assert cluster_outliers(two_sites) == {}
    # A position a person placed on the map is never flagged.
    placed = [*two_sites[:3], member("f", lat + 3.0, lon, person_placed=True)]
    assert cluster_outliers(placed) == {}
    # Three far-apart positions: no clear cluster.
    spread = [member("a", lat, lon), member("b", lat + 1.0, lon), member("c", lat, lon + 1.5)]
    assert cluster_outliers(spread) == {}
    # Positions without WGS84 values, or the (0, 0) placeholder, take no part.
    partial = [member("a", lat, lon), member("b", None, None), member("c", 0.0, 0.0)]
    assert cluster_outliers(partial) == {}


def test_identical_coordinates_on_different_boreholes() -> None:
    members = [
        member("a", None, None, label="KB 1", local_x=413210.5, local_y=5316044.2),
        member("b", None, None, label="KB 2", local_x=413210.5000001, local_y=5316044.2),
        member("c", None, None, label="KB-01", local_x=413210.5, local_y=5316044.2),  # same hole as KB 1
        member("d", None, None, label="KB 3", local_x=413480.0, local_y=5316310.7),
        member("e", None, None, label="B-4"),  # no coordinates
    ]
    shared = shared_coordinates(members)
    assert shared == {"a": ["KB 2"], "b": ["KB 1", "KB-01"], "c": ["KB 2"]}
    lint = document_lint(members)
    assert lint["b"][0]["rule"] == "coordinates_shared" and lint["b"][0]["severity"] == "warning"
    assert "KB 1, KB-01" in lint["b"][0]["message"]
    assert lint["d"] == [] and lint["e"] == []
    # A confirmed duplicate is linted on its own record, worded with the original's label and file.
    marked = document_lint([member("x", None, None, duplicate_of=("BH-01", "fictional-a.pdf"))])
    assert marked["x"][0]["rule"] == "duplicate_borehole"
    assert "BH-01" in marked["x"][0]["message"] and "fictional-a.pdf" in marked["x"][0]["message"]


# ----------------------------------------------------------------------------------------------
# Pure: depth notes against the printed depths, conflicting readings
# ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("note", "intervals", "expected"),
    [
        # English: negative values denote depth, but the log prints positive depths.
        (
            "Negative values denote depth below ground level",
            [(0.0, 1.5), (1.5, 3.2)],
            "negative_note_positive_depths",
        ),
        # German: depths are negative downwards and printed negative: consistent.
        ("Tiefen nach unten negativ", [(-0.0, -1.2), (-1.2, -3.4)], None),
        # French: same, consistent.
        ("Profondeurs en valeurs négatives", [(0.0, -2.0), (-2.0, -5.5)], None),
        # Spanish: positive downwards, but printed negative.
        ("Profundidades positivas hacia abajo", [(0.0, -2.0), (-2.0, -5.5)], "positive_note_negative_depths"),
        # No note, negative depths.
        (None, [(-0.5, -2.0), (-2.0, -4.5)], "negative_depths_without_note"),
        # No note, values that fall downwards like elevations.
        (None, [(102.0, 98.5), (98.5, 93.0), (93.0, 90.2)], "depths_decrease"),
        # No note, ordinary depths.
        (None, [(0.0, 0.8), (0.8, 4.5)], None),
        # Too little to judge.
        ("Negative values denote depth", [(0.0, 1.0)], None),
    ],
)
def test_datum_convention_findings(
    note: str | None, intervals: list[tuple[float, float]], expected: str | None
) -> None:
    finding = check_datum_convention(parse_depth_origin(note), intervals)
    assert (finding.kind if finding else None) == expected


def test_datum_convention_ignores_unreadable_values() -> None:
    origin = DepthOrigin("ground", negative_down=True)
    assert check_datum_convention(origin, [(None, None), (None, 2.0)]) is None


def test_distinct_readings_compare_numbers_with_a_tolerance_and_text_without_case() -> None:
    def reading(value: Any, page: int) -> SourceReading:
        return SourceReading(value, str(value), "log_sheet", "doc_x", page, None)

    assert len(distinct_readings([reading(3.42, 5), reading(3.4201, 3)])) == 1
    assert [r.page for r in distinct_readings([reading(3.42, 5), reading(3.24, 3), reading(3.24, 4)])] == [
        5,
        3,
    ]
    assert len(distinct_readings([reading("Fiktivweiler  Nord", 5), reading("fiktivweiler nord", 3)])) == 1
    assert len(distinct_readings([reading(None, 5), reading(12.0, 3)])) == 1


def test_needs_location_only_without_any_coordinate() -> None:
    assert (
        needs_location({"metadata": {"location_name": " Fictional Quarry Road "}}) == "Fictional Quarry Road"
    )
    assert needs_location({"metadata": {"location_name": "X", "coordinates": {"x_raw": "413210"}}}) is None
    assert needs_location({"metadata": {"coordinates": {}}}) is None


# ----------------------------------------------------------------------------------------------
# Database helpers
# ----------------------------------------------------------------------------------------------


async def new_document(session: Any, doc_id: str, *, file_name: str, project: str | None = None) -> Document:
    doc = Document(
        id=doc_id,
        file_name=file_name,
        project=project,
        sha256=hashlib.sha256(doc_id.encode()).hexdigest(),
        mime_type="application/pdf",
        size_bytes=1000,
        storage_key=f"originals/{doc_id}.pdf",
        status="needs_review",
    )
    session.add(doc)
    await session.flush()
    return doc


def utm_body(label: str, x: float, y: float, **meta: Any) -> dict[str, Any]:
    return {
        "metadata": {
            "borehole_id": label,
            "borehole_depth_m": 6.0,
            "coordinates": {
                "x_raw": f"{x:.1f}",
                "y_raw": f"{y:.1f}",
                "local_x": x,
                "local_y": y,
                "coordinate_system": "ETRS89 / UTM 32N",
            },
            **meta,
        },
        "stratigraphy": [{"depth_from_m": 0.0, "depth_to_m": 6.0, "original_description": "Sand, kiesig"}],
        "groundwater": [],
    }


async def add_borehole(
    session: Any,
    doc: Document,
    key: str,
    body: dict[str, Any],
    *,
    crs_status: str = "stated",
    crs_code: str | None = "EPSG:25832",
    page: int = 1,
) -> Borehole:
    return await create_borehole(
        session,
        document=doc,
        group_key=key,
        body=body,
        provenance=full_provenance(body, page=page),
        crs_status=crs_status,
        crs_code=crs_code,
        pages=[page],
    )


async def records(uids: list[str]) -> dict[str, BoreholeRecord]:
    out = {}
    for uid in uids:
        out[uid] = await record_of(uid)
    return out


async def revisions_of(uid: str) -> list[tuple[int, str, str]]:
    async with get_sessionmaker()() as session:
        rows = (
            await session.scalars(select(Revision).where(Revision.uid == uid).order_by(Revision.revision))
        ).all()
        return [(r.revision, r.actor, r.action) for r in rows]


async def answer(question_id: str, values: dict[str, Any], who: str = "fictional reviewer") -> None:
    async with get_sessionmaker()() as session:
        await answer_clarification(session, question_id, values, who)
        await session.commit()


async def assert_contract(question: Clarification) -> None:
    async with get_sessionmaker()() as session:
        row = await session.get(Clarification, question.id)
        assert row is not None
        validate_schema(clarification_out(row).model_dump(mode="json"), "Clarification")


# ----------------------------------------------------------------------------------------------
# Lint across a document, through the review service
# ----------------------------------------------------------------------------------------------

DE_POINTS = {
    "KB 1": (413210.5, 5316044.2),
    "KB 2": (413480.0, 5316310.7),
    "KB 3": (413352.4, 5316120.9),
    "KB 4": (413301.0, 5416210.0),  # northing misread: 100 km north
}


@pytest.mark.db
async def test_far_position_is_unplotted_and_recomputed_when_a_member_changes(db: None) -> None:
    async with get_sessionmaker()() as session:
        doc = await new_document(session, "doc_01JCHECKS0000000000000DE1", file_name="fictional-site.pdf")
        uids = {}
        for i, (label, (x, y)) in enumerate(DE_POINTS.items()):
            uids[label] = (await add_borehole(session, doc, f"g{i}", utm_body(label, x, y))).uid
        await session.commit()
        await refresh_document_checks(session, doc.id)
        await session.commit()

    recs = await records(list(uids.values()))
    far = recs[uids["KB 4"]]
    assert (far.plotted, far.unplotted_reason, far.revision) == (False, "implausible", 2)
    assert [(lint.rule, lint.path) for lint in far.lint] == [
        ("coordinates_far_from_cluster", "metadata.coordinates.x_raw")
    ]
    for label in ("KB 1", "KB 2", "KB 3"):
        assert (recs[uids[label]].plotted, recs[uids[label]].revision, recs[uids[label]].lint) == (
            True,
            1,
            [],
        )
    assert await revisions_of(uids["KB 4"]) == [(1, "pipeline", "create"), (2, "pipeline", "checks")]
    async with get_sessionmaker()() as session:
        bh = await session.get(Borehole, uids["KB 4"])
        assert bh is not None and bh.needs_attention and bh.document_lint and bh.geom is None
        updated = (await session.scalars(select(Event.payload).where(Event.type == "borehole.updated"))).all()
        assert updated == [{"uid": uids["KB 4"], "revision": 2}]
        # A rerun changes nothing.
        await refresh_document_checks(session, doc.id)
        await session.commit()
    assert (await record_of(uids["KB 4"])).revision == 2

    # A person corrects the northing: the position joins the cluster and plots again.
    async with get_sessionmaker()() as session:
        await apply_patch(
            session,
            uids["KB 4"],
            ValuePatch(path="metadata.coordinates.local_y", action="edit", value="5316210,0"),
            actor="fictional reviewer",
        )
        await session.commit()
    fixed = await record_of(uids["KB 4"])
    assert (fixed.plotted, fixed.unplotted_reason, fixed.lint, fixed.revision) == (True, None, [], 3)

    # KB 2 is edited onto the position of KB 3: both carry the warning, KB 3 through a revision of its own.
    async with get_sessionmaker()() as session:
        x3, y3 = DE_POINTS["KB 3"]
        await apply_patches(
            session,
            uids["KB 2"],
            [
                ValuePatch(path="metadata.coordinates.local_x", action="edit", value=x3),
                ValuePatch(path="metadata.coordinates.local_y", action="edit", value=y3),
            ],
            actor="fictional reviewer",
        )
        await session.commit()
    recs = await records([uids["KB 2"], uids["KB 3"]])
    assert [lint.rule for lint in recs[uids["KB 2"]].lint] == ["coordinates_shared"]
    assert "KB 3" in recs[uids["KB 2"]].lint[0].message
    assert [lint.rule for lint in recs[uids["KB 3"]].lint] == ["coordinates_shared"]
    assert recs[uids["KB 2"]].plotted and recs[uids["KB 3"]].plotted  # a warning does not unplot
    assert (await revisions_of(uids["KB 2"]))[-1] == (2, "fictional reviewer", "batch")
    assert (await revisions_of(uids["KB 3"]))[-1] == (2, "fictional reviewer", "checks")

    # Approving a value cannot change the lint across the document and writes nothing else.
    async with get_sessionmaker()() as session:
        await apply_patch(
            session, uids["KB 1"], ValuePatch(path="metadata.borehole_id", action="approve"), actor="t"
        )
        await session.commit()
    assert (await record_of(uids["KB 3"])).revision == 2


@pytest.mark.db
async def test_pacific_site_across_the_antimeridian_has_no_false_outlier(db: None) -> None:
    lat, lon = SITES["pacific"]
    points = {"P-1": (lon, lat), "P-2": (wrap(lon + 0.0025), lat + 0.001), "P-3": (wrap(lon + 0.002), lat)}
    async with get_sessionmaker()() as session:
        doc = await new_document(session, "doc_01JCHECKS0000000000000PC1", file_name="fictional-atoll.pdf")
        uids = []
        for i, (label, (x, y)) in enumerate(points.items()):
            body = utm_body(label, x, y)
            body["metadata"]["coordinates"]["coordinate_system"] = "WGS 84"
            uids.append((await add_borehole(session, doc, f"g{i}", body, crs_code="EPSG:4326")).uid)
        await session.commit()
        await refresh_document_checks(session, doc.id)
        await session.commit()
    for rec in (await records(uids)).values():
        assert rec.plotted and rec.lint == [] and rec.revision == 1


# ----------------------------------------------------------------------------------------------
# duplicate
# ----------------------------------------------------------------------------------------------

AU_POINTS = {"BH-01": (320512.0, 5812334.0), "BH-02": (320600.5, 5812401.25)}


@pytest.mark.db
async def test_repeated_boreholes_of_an_earlier_document_become_aliases(db: None) -> None:
    async with get_sessionmaker()() as session:
        first = await new_document(
            session, "doc_01JCHECKS0000000000000AU1", file_name="fictional-factual.pdf"
        )
        originals = {}
        for i, (label, (x, y)) in enumerate(AU_POINTS.items()):
            body = utm_body(label, x, y)
            originals[label] = (
                await add_borehole(session, first, f"g{i}", body, crs_status="inferred", crs_code=None)
            ).uid
        # A third borehole with the same label as a later one but another position: not a repeat.
        other = await add_borehole(
            session, first, "g9", utm_body("BH-03", 1.0, 2.0), crs_status="inferred", crs_code=None
        )
        await session.commit()
    async with get_sessionmaker()() as session:  # a later upload, its own transaction (later created_at)
        second = await new_document(session, "doc_01JCHECKS0000000000000AU2", file_name="fictional-scan.pdf")
        later = {}
        for i, (label, (x, y)) in enumerate(AU_POINTS.items()):
            printed = label.replace("-0", " ")  # "BH 1": same canonical label, printed differently
            body = utm_body(printed, x, y)
            later[label] = (
                await add_borehole(
                    session, second, f"g{i}", body, crs_status="inferred", crs_code=None, page=4
                )
            ).uid
        await add_borehole(
            session, second, "g9", utm_body("BH 3", 5.0, 6.0), crs_status="inferred", crs_code=None, page=5
        )
        await session.commit()

    await finalize_document(second.id)
    await finalize_document(second.id)  # idempotent
    await finalize_document(first.id)  # the earlier document asks nothing
    questions = await clarifications("duplicate")
    assert len(questions) == 1
    question = questions[0]
    await assert_contract(question)
    assert question.document_id == second.id
    assert sorted(question.borehole_uids) == sorted([*originals.values(), *later.values()])
    assert other.uid not in question.borehole_uids
    assert "fictional-factual.pdf" in question.question and "BH 1" in question.question
    assert {e["document_id"] for e in question.evidence} == {first.id, second.id}
    assert [o["value"] for o in question.fields[0]["options"]] == ["same_boreholes", "keep_both"]

    await answer(question.id, {"resolution": "same_boreholes"})
    recs = await records([*originals.values(), *later.values()])
    for label, uid in originals.items():
        printed = label.replace("-0", " ")
        assert recs[uid].metadata.aliases == [printed]
        assert (await revisions_of(uid))[-1] == (2, "fictional reviewer", "aliases")
    async with get_sessionmaker()() as session:
        for label, uid in later.items():
            bh = await session.get(Borehole, uid)
            assert bh is not None and bh.duplicate_of == originals[label]
            assert [lint.rule for lint in recs[uid].lint] == ["duplicate_borehole"]
            assert "fictional-factual.pdf" in recs[uid].lint[0].message
            assert (await revisions_of(uid))[-1] == (2, "fictional reviewer", "duplicate")
    # A marked duplicate is not asked about again.
    await finalize_document(second.id)
    assert len(await clarifications("duplicate")) == 1


@pytest.mark.db
async def test_keep_both_changes_nothing(db: None) -> None:
    async with get_sessionmaker()() as session:
        first = await new_document(session, "doc_01JCHECKS0000000000000US1", file_name="fictional-yard-a.pdf")
        a = await add_borehole(
            session, first, "g1", utm_body("B-1", 1012345.2, 212345.6), crs_status="inferred", crs_code=None
        )
        await session.commit()
    async with get_sessionmaker()() as session:
        second = await new_document(
            session, "doc_01JCHECKS0000000000000US2", file_name="fictional-yard-b.pdf"
        )
        b = await add_borehole(
            session, second, "g1", utm_body("B1", 1012345.2, 212345.6), crs_status="inferred", crs_code=None
        )
        await session.commit()
    await finalize_document(second.id)
    (question,) = await clarifications("duplicate")
    await answer(question.id, {"resolution": "keep_both"})
    recs = await records([a.uid, b.uid])
    assert recs[a.uid].metadata.aliases == [] and recs[a.uid].revision == 1
    assert recs[b.uid].lint == [] and recs[b.uid].revision == 1


@pytest.mark.db
async def test_a_document_whose_log_pages_are_all_copies_is_a_duplicate(db: None) -> None:
    original, copy = "doc_01JCHECKS0000000000000PG1", "doc_01JCHECKS0000000000000PG2"
    await make_document(original, pages={1: ("cover_or_toc", [], None), 2: ("log_sheet", ["S-7"], None)})
    async with get_sessionmaker()() as session:
        page = await session.get(Page, (original, 1))
        assert page is not None
        page.used = False
        doc = await session.get(Document, original)
        assert doc is not None
        bh = await add_borehole(session, doc, "g1", utm_body("S-7", 600100.0, 6643200.0), page=2)
        await session.commit()
    await make_document(
        copy, pages={1: ("duplicate", [], None), 2: ("blank", [], None)}, file_name="photo.png"
    )
    async with get_sessionmaker()() as session:
        dup = await session.get(Page, (copy, 1))
        blank = await session.get(Page, (copy, 2))
        assert dup is not None and blank is not None
        dup.duplicate_of_doc, dup.duplicate_of_n, dup.used = original, 2, False
        blank.used = False
        await session.commit()
        assert await page_copies(session, copy) == {original: [(1, 2)]}
        assert await page_copies(session, original) == {}

    await mark_document_duplicate(copy)  # what the classify stage does once every page is labelled
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, copy)
        assert doc is not None and doc.duplicate_of == original
    await finalize_document(copy)
    await finalize_document(copy)
    (question,) = await clarifications("duplicate")
    await assert_contract(question)
    assert question.borehole_uids == [bh.uid] and "page 2 of fictional-report.pdf" in question.question
    assert [(e["document_id"], e["page"]) for e in question.evidence] == [(copy, 1), (original, 2)]
    await answer(question.id, {"resolution": "same_boreholes"})
    assert (await record_of(bh.uid)).revision == 1  # the copy has no boreholes of its own: nothing to mark

    # A page that only copies the original's unused cover page does not make a document a duplicate.
    async with get_sessionmaker()() as session:
        dup = await session.get(Page, (copy, 1))
        assert dup is not None
        dup.duplicate_of_n = 1
        await session.commit()
        assert await page_copies(session, copy) == {}


# ----------------------------------------------------------------------------------------------
# conflicting_sources (hand-built readings)
# ----------------------------------------------------------------------------------------------


@pytest.mark.db
async def test_conflicting_sources_question_and_answer(db: None) -> None:
    async with get_sessionmaker()() as session:
        doc = await new_document(session, "doc_01JCHECKS0000000000000CF1", file_name="fictional-harbour.pdf")
        body = utm_body("FHL-BH01", 563000.5, 5933000.25, surface_elevation_mASL=3.42)
        bh = await add_borehole(session, doc, "g1", body, page=5)
        readings = [
            SourceReading(3.42, "+3,42 m NHN", "log_sheet", doc.id, 5, [0.08, 0.13, 0.2, 0.03]),
            SourceReading(3.24, "3,24", "summary_table", doc.id, 3, [0.55, 0.22, 0.08, 0.02]),
        ]
        path = "metadata.surface_elevation_mASL"
        question = await ask_conflicting_sources(
            session, doc, uid=bh.uid, label="FHL-BH01", path=path, readings=readings
        )
        again = await ask_conflicting_sources(
            session, doc, uid=bh.uid, label="FHL-BH01", path=path, readings=readings
        )
        agreeing = await ask_conflicting_sources(
            session,
            doc,
            uid=bh.uid,
            label="FHL-BH01",
            path="metadata.borehole_depth_m",
            readings=readings[:1],
        )
        await session.commit()
    assert question is not None and again is not None and again.id == question.id and agreeing is None
    await assert_contract(question)
    assert question.path == path and question.borehole_uids == [bh.uid]
    assert "log and the summary table" in question.question and "ground level" in question.question
    options = question.fields[0]["options"]
    assert [o["value"] for o in options] == [3.42, 3.24]
    assert options[1]["label"] == "3,24 (summary table, page 3)" and options[1]["evidence"]["page"] == 3
    assert [e["page"] for e in question.evidence] == [5, 3]

    await answer(question.id, {"value": 3.24})
    rec = await record_of(bh.uid)
    prov = rec.provenance[path]
    assert rec.metadata.surface_elevation_mASL == 3.24
    assert (prov.page, prov.box, prov.raw, prov.method, prov.status) == (
        3,
        [0.55, 0.22, 0.08, 0.02],
        "3,24",
        "edited",
        "approved",
    )
    assert prov.ai_value == 3.42  # what was read first stays visible
    assert (await revisions_of(bh.uid))[-1] == (2, "fictional reviewer", "clarification")


# ----------------------------------------------------------------------------------------------
# datum_convention, through finalisation
# ----------------------------------------------------------------------------------------------


def log_blocks(
    page: int, label: str, note: str | None, depths: list[str], texts: list[str]
) -> dict[str, BlockRef]:
    items = [blk(f"p{page}.b0", f"BOREHOLE {label}", (0.05, 0.03, 0.25, 0.02), quality=None)]
    if note is not None:
        items.append(blk(f"p{page}.b1", note, (0.05, 0.06, 0.5, 0.02), quality=None))
    items.append(blk(f"p{page}.b2", "Depth (m)", (0.05, 0.1, 0.1, 0.02), quality=None))
    for i, depth in enumerate(depths):
        items.append(blk(f"p{page}.d{i}", depth, (0.05, 0.15 + 0.08 * i, 0.06, 0.02), quality=None))
    for i, text in enumerate(texts):
        items.append(blk(f"p{page}.t{i}", text, (0.2, 0.17 + 0.08 * i, 0.4, 0.02), quality=None))
    return block_map(items)


def log_result(
    page: int, label: str, note: str | None, depths: list[str], texts: list[str]
) -> ExtractionResult:
    head = header(
        borehole_label=rv(label, f"p{page}.b0"),
        depth_unit=rv("Depth (m)", f"p{page}.b2"),
        **({"depth_origin_note": rv(note, f"p{page}.b1")} if note is not None else {}),
    )
    layers = [
        layer(
            rv(depths[i], f"p{page}.d{i}"), rv(depths[i + 1], f"p{page}.d{i + 1}"), rv(text, f"p{page}.t{i}")
        )
        for i, text in enumerate(texts)
    ]
    return result(head, layers)


async def finalize_log(
    doc_id: str, page: int, label: str, note: str | None, depths: list[str], texts: list[str]
) -> str:
    group = PageGroup(
        key=f"g-{label}", label_raw=label, label_canonical=canonical_label(label), pages=(page,)
    )
    uid = await finalize_group(
        doc_id,
        group,
        outcome(log_result(page, label, note, depths, texts), log_blocks(page, label, note, depths, texts)),
    )
    assert uid is not None
    return uid


@pytest.mark.db
async def test_a_negative_depth_note_with_positive_depths_is_asked_once_per_document(db: None) -> None:
    doc_id = "doc_01JCHECKS0000000000000AU3"
    note = "Negative values denote depth below ground level"
    await make_document(doc_id, pages={1: ("log_sheet", ["BH-21"], None), 2: ("log_sheet", ["BH-22"], None)})
    texts = ["SAND, fine, grey", "CLAY, stiff, brown"]
    first = await finalize_log(doc_id, 1, "BH-21", note, ["0.00", "1.50", "3.20"], texts)
    second = await finalize_log(doc_id, 2, "BH-22", note, ["0.00", "0.90", "2.70"], texts)
    (question,) = await clarifications("datum_convention")
    await assert_contract(question)
    assert question.borehole_uids == [first, second]
    assert "negative values denote depth" in question.question.lower() and "BH-21" in question.question
    convention, origin = question.fields
    assert [o["value"] for o in convention["options"]] == ["as_printed", "elevations"]
    assert origin["default"] == "ground" and origin["required"] is False
    assert question.evidence[0]["snippet"] == note and question.evidence[0]["page"] == 1

    await answer(question.id, {"convention": "elevations", "depth_origin": "ground"})
    for uid in (first, second):
        rec = await record_of(uid)
        flagged = {p for p, prov in rec.provenance.items() if prov.status == "flagged"}
        assert flagged == {
            "stratigraphy[0].depth_from_m",
            "stratigraphy[0].depth_to_m",
            "stratigraphy[1].depth_from_m",
            "stratigraphy[1].depth_to_m",
        }
        assert rec.provenance["metadata.depth_origin"].status == "approved"
        assert [action for _, _, action in await revisions_of(uid)] == ["create", "datum", "datum"]


@pytest.mark.db
async def test_negative_depths_without_a_note_become_depths_when_a_person_says_so(db: None) -> None:
    doc_id = "doc_01JCHECKS0000000000000NO1"
    await make_document(doc_id, pages={1: ("log_sheet", ["K-7"], None)})
    texts = ["Leire, bløt", "Sand, middels fast", "Morene"]
    uid = await finalize_log(doc_id, 1, "K-7", None, ["-0,50", "-2,00", "-4,50", "-7,00"], texts)
    before = await record_of(uid)
    assert before.stratigraphy[0].depth_from_m == -4.5  # stored as printed, in sorted order
    assert any(lint.rule == "layer_inverted" for lint in before.lint)
    (question,) = await clarifications("datum_convention")
    assert [o["value"] for o in question.fields[0]["options"]] == [
        "negative_down",
        "as_printed",
        "elevations",
    ]

    await answer(question.id, {"convention": "negative_down"})
    rec = await record_of(uid)
    assert [(la.depth_from_m, la.depth_to_m, la.original_description) for la in rec.stratigraphy] == [
        (0.5, 2.0, "Leire, bløt"),
        (2.0, 4.5, "Sand, middels fast"),
        (4.5, 7.0, "Morene"),
    ]
    # Provenance moved with its layer: each description still points at its own printed block.
    assert rec.provenance["stratigraphy[0].original_description"].raw == "Leire, bløt"
    assert rec.provenance["stratigraphy[0].depth_from_m"].raw == "-0,50"
    assert rec.provenance["stratigraphy[0].depth_from_m"].method == "edited"
    assert rec.provenance["stratigraphy[0].depth_from_m"].ai_value == -0.5
    assert not [lint for lint in rec.lint if lint.rule.startswith("layer_")]
    assert (await revisions_of(uid))[-1][2] == "datum"


@pytest.mark.db
async def test_a_consistent_note_asks_nothing(db: None) -> None:
    doc_id = "doc_01JCHECKS0000000000000DE2"
    await make_document(doc_id, pages={1: ("log_sheet", ["RKS 4"], None)})
    uid = await finalize_log(
        doc_id, 1, "RKS 4", "Tiefen nach unten negativ", ["0,00", "-1,20", "-3,40"], ["Ton", "Kies"]
    )
    rec = await record_of(uid)
    assert [(la.depth_from_m, la.depth_to_m) for la in rec.stratigraphy] == [(0.0, 1.2), (1.2, 3.4)]
    await finalize_document(doc_id)
    assert await clarifications("datum_convention") == []


# ----------------------------------------------------------------------------------------------
# locate_borehole
# ----------------------------------------------------------------------------------------------


@pytest.mark.db
async def test_a_borehole_without_coordinates_but_with_a_place_is_asked_to_be_located(db: None) -> None:
    async with get_sessionmaker()() as session:
        doc = await new_document(session, "doc_01JCHECKS0000000000000LC1", file_name="fictional-quarry.pdf")
        unplaced = {
            "metadata": {"borehole_id": "Q-3", "location_name": "Fictional Quarry Road"},
            "stratigraphy": [{"depth_from_m": 0.0, "depth_to_m": 2.0}],
            "groundwater": [],
        }
        nowhere = {"metadata": {"borehole_id": "Q-4"}, "stratigraphy": [], "groundwater": []}
        a = await add_borehole(session, doc, "g1", unplaced, crs_status="unknown", crs_code=None, page=2)
        b = await add_borehole(session, doc, "g2", nowhere, crs_status="unknown", crs_code=None, page=3)
        c = await add_borehole(session, doc, "g3", utm_body("Q-5", 320512.0, 5812334.0, location_name="X"))
        await session.commit()
    await finalize_document(doc.id)
    await finalize_document(doc.id)
    (question,) = await clarifications("locate_borehole")
    await assert_contract(question)
    assert question.borehole_uids == [a.uid] and "Fictional Quarry Road" in question.question
    assert [f["widget"] for f in question.fields] == ["map_point", "text"]
    assert question.evidence[0]["page"] == 2 and question.evidence[0]["snippet"] == "Fictional Quarry Road"
    assert b.uid and c.uid  # no coordinates and no place, or printed coordinates: nothing to ask

    await answer(
        question.id, {"location": {"lat": -33.91, "lon": 151.07}, "source_note": "site plan, sheet 2"}
    )
    rec = await record_of(a.uid)
    assert rec.plotted and rec.metadata.coordinates.latitude == -33.91
    assert rec.provenance["metadata.coordinates.latitude"].method == "edited"
    async with get_sessionmaker()() as session:
        last = await session.scalar(
            select(Revision).where(Revision.uid == a.uid).order_by(Revision.revision.desc()).limit(1)
        )
        assert last is not None and last.action == "locate" and "site plan, sheet 2" in last.changes["note"]
        assert (await session.get(Clarification, question.id)).status == "answered"  # type: ignore[union-attr]


@pytest.mark.db
async def test_lint_objects_keep_the_contract_shape(db: None) -> None:
    async with get_sessionmaker()() as session:
        doc = await new_document(session, "doc_01JCHECKS0000000000000SH1", file_name="fictional-shape.pdf")
        uids = [
            (await add_borehole(session, doc, f"g{i}", utm_body(label, x, y))).uid
            for i, (label, (x, y)) in enumerate(DE_POINTS.items())
        ]
        await session.commit()
        await refresh_document_checks(session, doc.id)
        await session.commit()
        rows = (await session.scalars(select(Borehole).where(Borehole.uid.in_(uids)))).all()
        for bh in rows:
            validate_schema((await to_record(session, bh)).model_dump(mode="json"), "BoreholeRecord")
        prov = (await session.scalars(select(FieldValue.path).where(FieldValue.uid == uids[-1]))).all()
        assert "metadata.coordinates.x_raw" in prov  # the lint path points at a value with a source
