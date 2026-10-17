"""Behaviour the frontend asked for (COORDINATION.md, contract requests): CRS confirmation closes the
questions it answers (BE-CRS-1), retry in demo mode (BE-RETRY-1), SPT refusal correction through spt_raw.

Fictional records only; no provider is called.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from sqlalchemy import func, select

from app.clarify.service import create_clarification
from app.db.models import Borehole, BoreholeLayer, Clarification, Document, Event, FieldValue, Revision
from app.db.session import get_sessionmaker
from app.review.service import apply_patch, create_borehole, set_values, to_record
from app.schemas.boreholes import ProvenanceIn, ValuePatch
from tests.auth_utils import REVIEWER
from tests.contract_utils import validate_response
from tests.factories import full_provenance

pytestmark = pytest.mark.db

DOC_A = "doc_01JFAKE00000000000000FRQA"
DOC_B = "doc_01JFAKE00000000000000FRQB"
PICKER = {
    "name": "crs",
    "widget": "crs_picker",
    "label": "Coordinate system",
    "required": True,
    "options": [{"value": "EPSG:25832", "label": "ETRS89 / UTM zone 32N"}],
}
SWAP = {"name": "swap_axes", "widget": "boolean", "label": "Printed X is the northing"}
SPT_RAW_PAGE, SPT_RAW_BOX = 2, [0.61, 0.42, 0.08, 0.015]


async def call(
    client: httpx.AsyncClient, method: str, path: str, *, expect: int, **kwargs: Any
) -> httpx.Response:
    response = await client.request(method, path, **kwargs)
    assert response.status_code == expect, response.text
    content_type = response.headers.get("content-type", "application/json").split(";")[0]
    body = response.json() if response.content else None
    validate_response(method, path.split("?")[0], response.status_code, body, content_type)
    return response


async def _document(session: Any, doc_id: str, *, status: str = "needs_review", **extra: Any) -> Document:
    doc = Document(
        id=doc_id,
        file_name=f"fictional-{doc_id[-4:].lower()}.pdf",
        project="Fictional Request Site",
        sha256=doc_id.ljust(64, "0")[:64],
        mime_type="application/pdf",
        size_bytes=10,
        storage_key=f"originals/{doc_id}.pdf",
        status=status,
        **extra,
    )
    session.add(doc)
    await session.flush()
    return doc


# ----------------------------------------------------------------------------------------------
# BE-CRS-1: a CRS confirmation resolves the crs_confirm questions it settles
# ----------------------------------------------------------------------------------------------


async def _projected(session: Any, doc: Document, label: str, x: float, y: float) -> str:
    body = {
        "metadata": {
            "borehole_id": label,
            "borehole_depth_m": 6.0,
            "coordinates": {"local_x": x, "local_y": y, "x_raw": f"{x:.0f}", "y_raw": f"{y:.0f}"},
        },
        "stratigraphy": [{"depth_from_m": 0.0, "depth_to_m": 6.0, "din4023_code": "S"}],
    }
    bh = await create_borehole(
        session,
        document=doc,
        group_key=label,
        body=body,
        provenance=full_provenance(body),
        crs_status="inferred",
        pages=[1],
    )
    return bh.uid


async def _question(
    session: Any, kind: str, doc_id: str, uids: list[str], key: str, *, skipped: bool = False
) -> str:
    locate = {"name": "point", "widget": "map_point", "label": "Position"}
    fields = [PICKER, SWAP] if kind == "crs_confirm" else [locate]
    row = await create_clarification(
        session,
        kind=kind,
        document_id=doc_id,
        question=f"Fictional {kind} question {key}",
        fields=fields,
        borehole_uids=uids,
        dedupe_key=f"frq-{key}",
    )
    if skipped:
        row.status = "skipped"
    return row.id


async def _crs_site() -> dict[str, str]:
    """Document A with FR-1 and FR-2, document B with FR-3 (one project), and four questions."""
    async with get_sessionmaker()() as session:
        doc_a = await _document(session, DOC_A)
        doc_b = await _document(session, DOC_B)
        ids = {
            "b1": await _projected(session, doc_a, "FR-1", 413000.0, 5316000.0),
            "b2": await _projected(session, doc_a, "FR-2", 413050.0, 5316040.0),
            "b3": await _projected(session, doc_b, "FR-3", 413500.0, 5316400.0),
        }
        ids["q_doc"] = await _question(session, "crs_confirm", DOC_A, [ids["b1"], ids["b2"]], "doc")
        ids["q_project"] = await _question(session, "crs_confirm", DOC_A, [ids["b2"], ids["b3"]], "project")
        ids["q_skipped"] = await _question(session, "crs_confirm", DOC_A, [ids["b1"]], "skip", skipped=True)
        ids["q_locate"] = await _question(session, "locate_borehole", DOC_A, [ids["b1"]], "locate")
        await session.commit()
    return ids


async def _questions(*ids: str) -> dict[str, Clarification]:
    async with get_sessionmaker()() as session:
        rows = (await session.scalars(select(Clarification).where(Clarification.id.in_(ids)))).all()
        return {row.id: row for row in rows}


async def _resolved_events() -> list[dict[str, Any]]:
    async with get_sessionmaker()() as session:
        rows = await session.scalars(
            select(Event.payload).where(Event.type == "clarification.resolved").order_by(Event.id)
        )
        return list(rows.all())


async def test_crs_endpoint_resolves_the_questions_it_settles(client: httpx.AsyncClient) -> None:
    ids = await _crs_site()
    before = (await call(client, "GET", f"/api/v1/documents/{DOC_A}", expect=200)).json()
    assert before["open_clarifications"] == 4

    url = f"/api/v1/documents/{DOC_A}/crs"
    body = {"crs": "EPSG:25832", "confirmed_by": "Example Reviewer"}  # ignored since 1.3.0
    assert (await call(client, "POST", url, expect=200, json=body)).json() == {"updated": 2}

    rows = await _questions(ids["q_doc"], ids["q_project"], ids["q_skipped"], ids["q_locate"])
    for key in ("q_doc", "q_skipped"):
        row = rows[ids[key]]
        assert row.status == "answered" and row.answered_by == REVIEWER.actor
        assert row.answer == {"crs": "EPSG:25832", "swap_axes": False, "via": "crs_endpoint"}
        assert row.resolved_at is not None
    # FR-3 (document B) has no system yet; a question that is not about the system is not touched.
    assert rows[ids["q_project"]].status == "open" and rows[ids["q_locate"]].status == "open"
    resolved = {e["clarification_id"] for e in await _resolved_events()}
    assert resolved == {ids["q_doc"], ids["q_skipped"]}

    records = (await call(client, "GET", f"/api/v1/documents/{DOC_A}/boreholes", expect=200)).json()
    counts = {r["uid"]: r["open_clarifications"] for r in records}
    assert counts == {ids["b1"]: 1, ids["b2"]: 1}  # the locate question; the project question
    assert all(r["crs_status"] == "confirmed" for r in records)
    layer = (await call(client, "GET", "/api/v1/map/boreholes.geojson", expect=200)).json()
    features = {f["id"]: f["properties"]["open_clarifications"] for f in layer["features"]}
    assert features == {ids["b1"]: 1, ids["b2"]: 1}
    after = (await call(client, "GET", f"/api/v1/documents/{DOC_A}", expect=200)).json()
    assert after["open_clarifications"] == 2

    # Confirming document B settles the project question too.
    url_b = f"/api/v1/documents/{DOC_B}/crs"
    await call(client, "POST", url_b, expect=200, json={"crs": "EPSG:25832", "swap_axes": False})
    project = (await _questions(ids["q_project"]))[ids["q_project"]]
    assert project.status == "answered" and project.answered_by == REVIEWER.actor
    assert project.answer == {"crs": "EPSG:25832", "swap_axes": False, "via": "crs_endpoint"}
    final = (await call(client, "GET", f"/api/v1/documents/{DOC_A}", expect=200)).json()
    assert final["open_clarifications"] == 1  # only the locate question


async def test_crs_answer_settles_overlapping_questions(client: httpx.AsyncClient) -> None:
    """Answering one crs_confirm question resolves another one it settles; the answered one keeps the
    person's values."""
    ids = await _crs_site()
    url = f"/api/v1/clarifications/{ids['q_doc']}/answer"
    values = {"crs": "EPSG:25832", "swap_axes": False}
    answered = (
        await call(
            client, "POST", url, expect=200, json={"values": values, "answered_by": "Example Reviewer"}
        )
    ).json()
    assert answered["status"] == "answered" and answered["answer"] == values
    rows = await _questions(ids["q_skipped"], ids["q_project"])
    skipped = rows[ids["q_skipped"]]
    assert skipped.status == "answered" and skipped.answered_by == REVIEWER.actor
    assert skipped.answer == {
        "crs": "EPSG:25832",
        "swap_axes": False,
        "via": "clarification",
        "clarification_id": ids["q_doc"],
    }
    assert rows[ids["q_project"]].status == "open"
    events = [e["clarification_id"] for e in await _resolved_events()]
    assert sorted(events) == sorted([ids["q_doc"], ids["q_skipped"]])  # each resolved once


async def test_crs_confirmation_without_a_transform_resolves_nothing(client: httpx.AsyncClient) -> None:
    ids = await _crs_site()
    url = f"/api/v1/documents/{DOC_A}/crs"
    invalid = await call(client, "POST", url, expect=422, json={"crs": "EPSG:999999"})
    assert invalid.json()["code"] == "crs_invalid"
    rows = await _questions(ids["q_doc"], ids["q_skipped"])
    assert rows[ids["q_doc"]].status == "open" and rows[ids["q_skipped"]].status == "skipped"


# ----------------------------------------------------------------------------------------------
# BE-RETRY-1: retry answers demo_mode in demo mode
# ----------------------------------------------------------------------------------------------


async def test_retry_in_demo_mode_leaves_the_document_alone(client: httpx.AsyncClient, queue: Any) -> None:
    async with get_sessionmaker()() as session:
        await _document(session, DOC_A, status="failed", error="Fictional extraction failure.")
        await session.commit()
    response = await call(client, "POST", f"/api/v1/documents/{DOC_A}/retry", expect=409)
    assert response.json() == {"detail": "demo_mode", "code": "demo_mode"}
    async with get_sessionmaker()() as session:
        stored = await session.get(Document, DOC_A)
        assert stored is not None
        assert (stored.status, stored.error) == ("failed", "Fictional extraction failure.")
        assert await session.scalar(select(func.count()).select_from(Event)) == 0  # no document.updated
    assert queue.jobs == {}
    missing = await call(client, "POST", "/api/v1/documents/doc_nope/retry", expect=404)
    assert missing.json()["code"] == "document_not_found"


# ----------------------------------------------------------------------------------------------
# SPT refusal correction through stratigraphy[i].spt_raw
# ----------------------------------------------------------------------------------------------

SPT_FIELDS = ("spt_refusal", "spt_n_value", "spt_increments", "spt_increment_mm", "spt_penetration_cm")


async def _spt_borehole(session: Any, spt: dict[str, Any], *, derived: tuple[str, ...] = ()) -> Borehole:
    """One fictional layer with an SPT; `spt` holds the stored values, `derived` the paths whose entries
    the pipeline wrote as derived (the others are printed, method ocr)."""
    doc = await session.get(Document, DOC_A) or await _document(session, DOC_A)
    layer = {"depth_from_m": 0.0, "depth_to_m": 4.0, "din4023_code": "S", "spt_depth_m": 1.5, **spt}
    body = {"metadata": {"borehole_id": "FR-SPT", "borehole_depth_m": 4.0}, "stratigraphy": [layer]}
    prov = full_provenance(body)
    prov["stratigraphy[0].spt_raw"] = ProvenanceIn(
        page=SPT_RAW_PAGE, box=SPT_RAW_BOX, raw=spt["spt_raw"], method="ocr", confidence=0.93
    )
    for name in derived:
        prov[f"stratigraphy[0].{name}"] = ProvenanceIn(
            page=SPT_RAW_PAGE, box=SPT_RAW_BOX, raw=None, method="derived", confidence=0.93
        )
    bh = await create_borehole(
        session,
        document=doc,
        group_key=f"spt-{spt['spt_raw']}",
        body=body,
        provenance=prov,
        crs_status="unknown",
    )
    await session.commit()
    return bh


async def _edit_raw(session: Any, uid: str, text: str | None) -> Any:
    await apply_patch(
        session, uid, ValuePatch(path="stratigraphy[0].spt_raw", action="edit", value=text), actor="tester"
    )
    await session.commit()
    bh = await session.get(Borehole, uid)
    return await to_record(session, bh)


def _spt(record: Any) -> dict[str, Any]:
    layer = record.stratigraphy[0]
    return {name: getattr(layer, name) for name in SPT_FIELDS}


def _assert_derived_from_raw(record: Any, *names: str) -> None:
    for name in names:
        entry = record.provenance[f"stratigraphy[0].{name}"]
        assert entry.method == "derived", name
        assert (entry.page, entry.box) == (SPT_RAW_PAGE, SPT_RAW_BOX), name


async def _layer_row(session: Any, uid: str) -> tuple[Any, Any]:
    row = (await session.execute(select(BoreholeLayer).where(BoreholeLayer.uid == uid))).scalar_one()
    await session.refresh(row)
    return row.spt_n_value, row.spt_refusal


async def test_spt_3x150_numeric_to_refusal_and_back(session: Any) -> None:
    bh = await _spt_borehole(
        session,
        {
            "spt_raw": "5/7/9",
            "spt_increments": [5, 7, 9],
            "spt_n_value": 16,
            "spt_refusal": False,
            "spt_increment_mm": 150,
        },
        derived=("spt_n_value", "spt_refusal", "spt_increment_mm"),
    )
    uid, start = bh.uid, bh.revision
    # The increments were approved and N flagged before the correction.
    await apply_patch(
        session, uid, ValuePatch(path="stratigraphy[0].spt_increments", action="approve"), actor="t"
    )
    await apply_patch(
        session,
        uid,
        ValuePatch(path="stratigraphy[0].spt_n_value", action="flag", reason="refusal?"),
        actor="t",
    )
    await session.commit()

    record = await _edit_raw(session, uid, "12 25 50/100mm")
    assert record.revision == start + 3  # the re-derivation is part of the edit's revision
    assert _spt(record) == {
        "spt_refusal": True,
        "spt_n_value": None,
        "spt_increments": [12, 25, 50],
        "spt_increment_mm": None,
        "spt_penetration_cm": 10.0,
    }
    _assert_derived_from_raw(record, "spt_refusal", "spt_n_value", "spt_increments", "spt_penetration_cm")
    n_entry = record.provenance["stratigraphy[0].spt_n_value"]
    assert n_entry.status == "unreviewed" and n_entry.flag is None  # its value changed: reviewed again
    assert record.provenance["stratigraphy[0].spt_increments"].status == "unreviewed"
    assert "stratigraphy[0].spt_increment_mm" not in record.provenance  # no scheme stated in the text
    assert record.provenance["stratigraphy[0].spt_raw"].method == "edited"
    assert not any(lint.rule == "spt_refusal_with_n" for lint in record.lint)
    assert await _layer_row(session, uid) == (None, True)
    revision = await session.scalar(
        select(Revision).where(Revision.uid == uid, Revision.revision == start + 3)
    )
    assert revision is not None and revision.actor == "tester"
    derived = {entry["path"] for entry in revision.changes["derived"]["values"]}
    assert derived == {f"stratigraphy[0].{name}" for name in SPT_FIELDS}

    record = await _edit_raw(session, uid, "5/7/9")
    assert _spt(record) == {
        "spt_refusal": False,
        "spt_n_value": 16,
        "spt_increments": [5, 7, 9],
        "spt_increment_mm": 150,
        "spt_penetration_cm": None,
    }
    _assert_derived_from_raw(record, "spt_refusal", "spt_n_value", "spt_increments", "spt_increment_mm")
    assert "stratigraphy[0].spt_penetration_cm" not in record.provenance
    assert await _layer_row(session, uid) == (16, False)


async def test_spt_6x75_refusal_to_numeric(session: Any) -> None:
    bh = await _spt_borehole(
        session,
        {
            "spt_raw": "3 5 8 12 25 50/40mm",
            "spt_increments": [3, 5, 8, 12, 25, 50],
            "spt_refusal": True,
            "spt_penetration_cm": 4.0,
        },
        derived=("spt_refusal", "spt_penetration_cm"),
    )
    record = await to_record(session, bh)
    assert "stratigraphy[0].spt_n_value" not in record.provenance  # a refusal has no N
    record = await _edit_raw(session, bh.uid, "2 3 4 5 6 7")
    assert _spt(record) == {
        "spt_refusal": False,
        "spt_n_value": 22,  # the four test increments of 6 x 75 mm
        "spt_increments": [2, 3, 4, 5, 6, 7],
        "spt_increment_mm": 75,
        "spt_penetration_cm": None,
    }
    _assert_derived_from_raw(record, "spt_refusal", "spt_n_value", "spt_increments", "spt_increment_mm")
    created = record.provenance["stratigraphy[0].spt_n_value"]
    assert created.status == "unreviewed" and created.ai_value is None and created.raw is None
    assert "stratigraphy[0].spt_penetration_cm" not in record.provenance
    assert await _layer_row(session, bh.uid) == (22, False)


async def test_spt_n_only_with_a_person_edited_n(session: Any) -> None:
    bh = await _spt_borehole(session, {"spt_raw": "N=23", "spt_n_value": 23, "spt_refusal": False})
    uid = bh.uid
    await apply_patch(
        session, uid, ValuePatch(path="stratigraphy[0].spt_n_value", action="edit", value=25), actor="t"
    )
    await session.commit()
    # A numeric text keeps the N a person entered.
    record = await _edit_raw(session, uid, "N=24")
    assert record.stratigraphy[0].spt_n_value == 25
    assert record.provenance["stratigraphy[0].spt_n_value"].method == "edited"
    assert record.stratigraphy[0].spt_refusal is False
    # A refusal replaces it: N null, derived.
    record = await _edit_raw(session, uid, "50/120mm")
    assert _spt(record) == {
        "spt_refusal": True,
        "spt_n_value": None,
        "spt_increments": [50],
        "spt_increment_mm": None,
        "spt_penetration_cm": 12.0,
    }
    _assert_derived_from_raw(record, "spt_refusal", "spt_n_value", "spt_increments", "spt_penetration_cm")
    # Back to a printed N: derived from the text now.
    record = await _edit_raw(session, uid, "N=30")
    assert _spt(record) == {
        "spt_refusal": False,
        "spt_n_value": 30,
        "spt_increments": None,
        "spt_increment_mm": None,
        "spt_penetration_cm": None,
    }
    _assert_derived_from_raw(record, "spt_refusal", "spt_n_value")
    assert "stratigraphy[0].spt_increments" not in record.provenance


async def test_spt_text_without_an_n_keeps_n_editable(session: Any) -> None:
    bh = await _spt_borehole(session, {"spt_raw": "23", "spt_n_value": 23, "spt_refusal": False})
    record = await _edit_raw(session, bh.uid, "illegible smudge")
    # Nothing can be read: N becomes null but keeps its (derived) entry, so a person can still enter it.
    assert record.stratigraphy[0].spt_n_value is None and record.stratigraphy[0].spt_refusal is None
    assert record.provenance["stratigraphy[0].spt_n_value"].method == "derived"
    assert "stratigraphy[0].spt_refusal" not in record.provenance
    await apply_patch(
        session, bh.uid, ValuePatch(path="stratigraphy[0].spt_n_value", action="edit", value=21), actor="t"
    )
    await session.commit()
    record = await to_record(session, await session.get(Borehole, bh.uid))
    assert record.stratigraphy[0].spt_n_value == 21


async def test_unchanged_spt_raw_is_not_parsed_again(session: Any) -> None:
    bh = await _spt_borehole(
        session,
        {"spt_raw": "50/12", "spt_increments": [50], "spt_refusal": True, "spt_penetration_cm": 12.0},
        derived=("spt_refusal", "spt_penetration_cm"),
    )
    # Read with the log's increment note (cm), the pipeline knew the penetration; the text alone does not.
    record = await _edit_raw(session, bh.uid, "50/12")
    assert record.stratigraphy[0].spt_penetration_cm == 12.0
    assert record.provenance["stratigraphy[0].spt_increments"].method == "ocr"


async def test_spt_raw_set_by_a_clarification_answer_is_parsed(session: Any) -> None:
    bh = await _spt_borehole(session, {"spt_raw": "5/7/9", "spt_increments": [5, 7, 9], "spt_n_value": 16})
    await set_values(
        session, bh.uid, {"stratigraphy[0].spt_raw": "R"}, actor="tester", action="clarification"
    )
    await session.commit()
    record = await to_record(session, await session.get(Borehole, bh.uid))
    assert record.stratigraphy[0].spt_refusal is True and record.stratigraphy[0].spt_n_value is None
    assert record.provenance["stratigraphy[0].spt_n_value"].method == "derived"
    assert "stratigraphy[0].spt_increments" not in record.provenance
    stored = await session.scalars(select(FieldValue.path).where(FieldValue.uid == bh.uid))
    assert "stratigraphy[0].spt_increments" not in set(stored.all())


async def test_refusal_text_for_spt_n_value_points_to_spt_raw(client: httpx.AsyncClient) -> None:
    async with get_sessionmaker()() as session:
        bh = await _spt_borehole(
            session, {"spt_raw": "5/7/9", "spt_increments": [5, 7, 9], "spt_n_value": 16}
        )
        uid = bh.uid
    patch = {"path": "stratigraphy[0].spt_n_value", "action": "edit", "value": "50/12"}
    refused = (await call(client, "PATCH", f"/api/v1/boreholes/{uid}/values", expect=422, json=patch)).json()
    assert refused["code"] == "unparseable_value"
    assert "'50/12' is an SPT refusal" in refused["detail"]
    assert "stratigraphy[0].spt_raw" in refused["detail"]
    text = {**patch, "value": "five"}
    other = (await call(client, "PATCH", f"/api/v1/boreholes/{uid}/values", expect=422, json=text)).json()
    assert other["code"] == "unparseable_value" and "stratigraphy[0].spt_raw" in other["detail"]
    # The correction the message names works over HTTP and answers the whole record.
    fix = {"path": "stratigraphy[0].spt_raw", "action": "edit", "value": "50/120mm"}
    fixed = (await call(client, "PATCH", f"/api/v1/boreholes/{uid}/values", expect=200, json=fix)).json()
    layer = fixed["stratigraphy"][0]
    assert (
        layer["spt_refusal"] is True and layer["spt_n_value"] is None and layer["spt_penetration_cm"] == 12.0
    )
    assert fixed["provenance"]["stratigraphy[0].spt_n_value"]["method"] == "derived"
