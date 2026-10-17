"""Record service against PostGIS: create, patch actions, derived values, revisions, events (fictional)."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.db.models import Borehole, BoreholeLayer, Document, Event, FieldValue, Revision
from app.errors import ApiError
from app.geo.crs_service import confirm_crs
from app.review.service import apply_patch, approve_clean, create_borehole, to_record
from app.schemas.boreholes import ProvenanceIn, ValuePatch

pytestmark = pytest.mark.db


async def _doc(session) -> Document:
    doc = Document(
        id="doc_01JFAKE0000000000000000001",
        file_name="fictional-vector-log.pdf",
        sha256="0" * 64,
        mime_type="application/pdf",
        size_bytes=1,
        storage_key="originals/x.pdf",
        status="needs_review",
    )
    session.add(doc)
    await session.flush()
    return doc


def _prov(page: int = 1, method: str = "ocr", confidence: float = 0.95) -> ProvenanceIn:
    return ProvenanceIn(page=page, box=[0.1, 0.2, 0.1, 0.02], raw="x", method=method, confidence=confidence)


async def _borehole(session, *, crs_status: str = "inferred", crs_code: str | None = None) -> Borehole:
    doc = await _doc(session)
    body = {
        "metadata": {
            "borehole_id": "FX-01",
            "borehole_depth_m": 6.0,
            "coordinates": {"local_x": 413000.0, "local_y": 5316000.0, "x_raw": "413000", "y_raw": "5316000"},
        },
        "stratigraphy": [
            {"depth_from_m": 0.0, "depth_to_m": 2.0, "din4023_code": "S"},
            {"depth_from_m": 2.0, "depth_to_m": 6.0, "din4023_code": "Kst", "rqd_pct": 104},
        ],
        "groundwater": [{"type": "strike", "depth_m": 1.5}],
    }
    prov = {
        "metadata.borehole_id": _prov(method="read"),
        "metadata.borehole_depth_m": _prov(confidence=0.97),
        "metadata.coordinates.local_x": _prov(),
        "metadata.coordinates.local_y": _prov(),
        "stratigraphy[0].depth_to_m": _prov(confidence=0.5),
        "stratigraphy[1].din4023_code": _prov(),
        "stratigraphy[1].depth_from_m": _prov(),
        "stratigraphy[1].rqd_pct": _prov(),
        "groundwater[0].depth_m": _prov(),
    }
    bh = await create_borehole(
        session,
        document=doc,
        group_key="g1",
        body=body,
        provenance=prov,
        crs_status=crs_status,
        crs_code=crs_code,
    )
    await session.commit()
    return bh


async def test_create_derives_values_and_lints(session) -> None:
    bh = await _borehole(session)
    record = await to_record(session, bh)
    assert record.revision == 1
    assert record.review_status == "unreviewed"
    assert record.plotted is False and record.unplotted_reason == "crs_unconfirmed"
    assert record.metadata.coordinates.latitude is None
    assert record.rock_head_m == 2.0
    assert record.provenance["rock_head_m"].method == "derived"
    assert record.stratigraphy[1].thickness_m == 4.0
    assert {lint.rule for lint in record.lint} == {"rqd_above_100"}
    assert await session.scalar(select(func.count()).select_from(BoreholeLayer)) == 2
    types = (await session.scalars(select(Event.type))).all()
    assert types == ["borehole.created"]


async def test_patch_actions_revisions_and_conflict(session) -> None:
    bh = await _borehole(session)
    uid = bh.uid
    await apply_patch(session, uid, ValuePatch(path="metadata.borehole_depth_m", action="approve"), actor="t")
    await apply_patch(
        session,
        uid,
        ValuePatch(path="stratigraphy[0].depth_to_m", action="edit", value="2,5", if_revision=2),
        actor="t",
    )
    await session.commit()
    record = await to_record(session, bh)
    assert record.revision == 3
    assert record.review_status == "in_review"
    edited = record.provenance["stratigraphy[0].depth_to_m"]
    assert (edited.method, edited.ai_value, record.stratigraphy[0].depth_to_m) == ("edited", 2.0, 2.5)
    assert any(lint.rule == "layer_overlap" for lint in record.lint)

    with pytest.raises(ApiError) as conflict:
        await apply_patch(
            session, uid, ValuePatch(path="metadata.borehole_id", action="approve", if_revision=1), actor="t"
        )
    assert conflict.value.code == "revision_conflict"
    await session.rollback()
    with pytest.raises(ApiError) as missing:
        await apply_patch(session, uid, ValuePatch(path="metadata.client", action="approve"), actor="t")
    assert missing.value.code == "path_not_found"
    await session.rollback()
    with pytest.raises(ApiError) as bad:
        await apply_patch(
            session,
            uid,
            ValuePatch(path="stratigraphy[1].din4023_code", action="edit", value="rock"),
            actor="t",
        )
    assert bad.value.code == "unparseable_value"
    await session.rollback()

    await apply_patch(
        session, uid, ValuePatch(path="groundwater[0].depth_m", action="flag", reason="smudged"), actor="t"
    )
    await apply_patch(session, uid, ValuePatch(path="groundwater[0].depth_m", action="reset"), actor="t")
    await session.commit()
    fv = await session.get(FieldValue, (uid, "groundwater[0].depth_m"))
    assert fv is not None and fv.status == "unreviewed" and fv.flag is None
    revisions = (
        await session.scalars(
            select(Revision.revision).where(Revision.uid == uid).order_by(Revision.revision)
        )
    ).all()
    assert revisions == [1, 2, 3, 4, 5]


async def test_approve_clean_rule(session) -> None:
    bh = await _borehole(session)
    # Clean: read, or ocr >= 0.9, unreviewed, state ok, no flag, no lint on the path.
    # Not clean: derived rock head, ocr 0.5 depth, rqd (linted).
    dry = await approve_clean(session, bh.document_id, dry_run=True, actor="t")
    assert dry == 7
    assert await approve_clean(session, bh.document_id, dry_run=False, actor="t") == 7
    await session.commit()
    assert await approve_clean(session, bh.document_id, dry_run=True, actor="t") == 0


async def test_confirm_crs_plots_and_derives_wgs84(session) -> None:
    bh = await _borehole(session)
    with pytest.raises(ApiError) as invalid:
        await confirm_crs(session, [bh.uid], crs="EPSG:999999", swap_axes=False, actor="t")
    assert invalid.value.code == "crs_invalid"
    await session.rollback()
    assert await confirm_crs(session, [bh.uid], crs="EPSG:25832", swap_axes=False, actor="t") == 1
    await session.commit()
    record = await to_record(session, bh)
    assert record.crs_status == "confirmed" and record.plotted is True
    assert record.metadata.coordinates.latitude == pytest.approx(47.99, abs=0.02)
    assert record.provenance["metadata.coordinates.latitude"].method == "derived"
    assert record.provenance["metadata.coordinates.latitude"].page == 1
    located = await session.scalar(
        select(func.count()).select_from(Borehole).where(Borehole.geom.is_not(None))
    )
    assert located == 1
