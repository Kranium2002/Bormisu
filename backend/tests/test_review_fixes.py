"""Regression tests for the M0 adversarial review findings (fictional data)."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.db.models import Borehole, Document
from app.db.session import get_sessionmaker
from app.errors import ApiError
from app.events.stream import event_stream
from app.events.writer import emit
from app.geo.plotting import placement
from app.review.paths import PathError
from app.review.service import (
    apply_patch,
    create_borehole,
    refresh_document_status,
    set_manual_location,
    to_record,
)
from app.schemas.boreholes import ProvenanceIn, ValuePatch
from tests.factories import full_provenance

pytestmark = pytest.mark.db


async def _doc(session: Any, doc_id: str = "doc_01JFAKE000000000000000FIX1") -> Document:
    doc = Document(
        id=doc_id,
        file_name="fictional-fix.pdf",
        sha256=doc_id.ljust(64, "0")[:64],
        mime_type="application/pdf",
        size_bytes=1,
        storage_key="originals/x.pdf",
        status="needs_review",
    )
    session.add(doc)
    await session.flush()
    return doc


def _body(**coords: Any) -> dict[str, Any]:
    return {
        "metadata": {"borehole_id": "FX-1", "borehole_depth_m": 5.0, "coordinates": coords},
        "stratigraphy": [{"depth_from_m": 0.0, "depth_to_m": 5.0, "din4023_code": "S"}],
    }


async def test_values_need_provenance_and_lithology_inherits(session: Any) -> None:
    doc = await _doc(session)
    body = _body()
    body["stratigraphy"][0]["original_description"] = "Sand, mittel"
    body["stratigraphy"][0]["english_lithology"] = "Medium sand"
    prov = full_provenance(body)
    del prov["stratigraphy[0].english_lithology"]
    bh = await create_borehole(
        session, document=doc, group_key="a", body=body, provenance=prov, crs_status="unknown"
    )
    record = await to_record(session, bh)
    inherited = record.provenance["stratigraphy[0].english_lithology"]
    assert (
        inherited.method == "guessed" and inherited.page == prov["stratigraphy[0].original_description"].page
    )
    with pytest.raises(PathError, match="without provenance"):
        bare = _body()
        await create_borehole(
            session, document=doc, group_key="b", body=bare, provenance={}, crs_status="unknown"
        )


async def test_bad_numbers_crs_code_and_zero_point(session: Any) -> None:
    doc = await _doc(session)
    body = _body(latitude=0.0, longitude=0.0, crs_code="EPSG:4326")
    bh = await create_borehole(
        session,
        document=doc,
        group_key="z",
        body=body,
        provenance=full_provenance(body),
        crs_status="stated",
        crs_code="EPSG:4326",
    )
    await session.commit()
    uid = bh.uid
    record = await to_record(session, bh)
    assert record.plotted is False and record.unplotted_reason == "implausible"
    assert any(lint.rule == "coordinates_zero" for lint in record.lint)
    for path, value in (
        ("metadata.borehole_depth_m", "inf"),
        ("metadata.borehole_depth_m", "NaN"),
        ("metadata.borehole_depth_m", True),
        ("stratigraphy[0].depth_to_m", float("inf")),
        ("metadata.coordinates.crs_code", "EPSG:25832"),
    ):
        with pytest.raises(ApiError) as err:
            await apply_patch(session, uid, ValuePatch(path=path, action="edit", value=value), actor="t")
        assert err.value.code in ("unparseable_value", "path_not_found"), (path, value)
        await session.rollback()


async def test_person_placed_point_plots_without_inventing_a_system(session: Any) -> None:
    doc = await _doc(session)
    body = _body(local_x=413000.0, local_y=5316000.0, x_raw="413000", y_raw="5316000")
    bh = await create_borehole(
        session,
        document=doc,
        group_key="p",
        body=body,
        provenance=full_provenance(body),
        crs_status="inferred",
    )
    await session.commit()
    await set_manual_location(session, bh.uid, lat=47.99, lon=7.84, actor="t")
    await session.commit()
    record = await to_record(session, bh)
    assert record.plotted is True and record.crs_status == "inferred"
    assert record.metadata.coordinates.crs_code is None and record.metadata.coordinates.local_x == 413000.0
    assert placement({"latitude": 0, "longitude": 0}, "stated").plotted is False


async def test_document_done_when_last_two_boreholes_approved_concurrently(db: None) -> None:
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        doc = await _doc(session, "doc_01JFAKE000000000000000FIX2")
        uids = []
        for key in ("one", "two"):
            body = _body()
            bh = await create_borehole(
                session,
                document=doc,
                group_key=key,
                body=body,
                provenance=full_provenance(body),
                crs_status="unknown",
            )
            uids.append(bh.uid)
        await session.commit()

    async def approve_all(uid: str) -> None:
        async with sessionmaker() as s:
            record = await to_record(s, await s.get(Borehole, uid))
            for path in record.provenance:
                await apply_patch(s, uid, ValuePatch(path=path, action="approve"), actor="t")
            await s.commit()

    await asyncio.gather(*(approve_all(uid) for uid in uids))
    async with sessionmaker() as session:
        await refresh_document_status(session, "doc_01JFAKE000000000000000FIX2")
        doc = await session.scalar(select(Document).where(Document.id == "doc_01JFAKE000000000000000FIX2"))
        assert doc is not None and doc.status == "done"


async def test_late_commit_is_streamed(db: None) -> None:
    sessionmaker = get_sessionmaker()
    first, second = sessionmaker(), sessionmaker()
    try:
        await emit(
            first, "job.failed", {"document_id": "doc_x", "stage": "a", "detail": "a", "retryable": True}
        )
        await emit(
            second, "job.failed", {"document_id": "doc_x", "stage": "b", "detail": "b", "retryable": True}
        )
        await second.commit()  # commits first although its row id is higher

        async def frames(after: int) -> list[str]:
            async def disconnected() -> bool:
                return True

            return [
                f
                async for f in event_stream(after, None, disconnected, ping_interval=0.05)
                if f.startswith("id:")
            ]

        seen = await frames(0)
        assert len(seen) == 1 and '"stage":"b"' in seen[0]
        last = int(seen[0].split("\n", 1)[0].removeprefix("id: "))
        await first.commit()
        later = await frames(last)
        assert len(later) == 1 and '"stage":"a"' in later[0]
    finally:
        await first.close()
        await second.close()


async def test_skip_keeps_badge_and_upload_edge_cases(client: httpx.AsyncClient, live_mode: None) -> None:
    from app.clarify.service import create_clarification

    async with get_sessionmaker()() as session:
        doc = await _doc(session, "doc_01JFAKE000000000000000FIX3")
        body = _body()
        bh = await create_borehole(
            session,
            document=doc,
            group_key="s",
            body=body,
            provenance=full_provenance(body),
            crs_status="unknown",
        )
        clar = await create_clarification(
            session,
            kind="duplicate",
            document_id=doc.id,
            question="Same hole?",
            borehole_uids=[bh.uid],
            fields=[{"name": "same", "widget": "boolean", "label": "Same borehole"}],
        )
        await session.commit()
    await client.post(f"/api/v1/clarifications/{clar.id}/skip")
    record = (await client.get(f"/api/v1/boreholes/{bh.uid}")).json()
    assert record["open_clarifications"] == 1  # skipped questions keep the badge
    document = (await client.get(f"/api/v1/documents/{doc.id}")).json()
    assert document["open_clarifications"] == 1

    two = await client.post(
        "/api/v1/documents", files=[("file", ("a.pdf", b"%PDF-1.4 a")), ("file", ("b.pdf", b"%PDF-1.4 b"))]
    )
    assert two.status_code == 422 and two.json()["code"] == "validation_error"

    async def chunks() -> Any:
        boundary = b"--fixbound\r\n"
        yield boundary + b'Content-Disposition: form-data; name="file"; filename="big.pdf"\r\n\r\n%PDF-1.4\n'
        for _ in range(300):
            yield b"0" * 1024 * 1024

    from app.config import get_settings

    get_settings().__dict__["max_upload_mb"] = 1
    try:
        big = await client.post(
            "/api/v1/documents",
            content=chunks(),
            headers={"content-type": "multipart/form-data; boundary=fixbound"},
        )
    finally:
        get_settings.cache_clear()
    assert big.status_code == 413 and big.json()["code"] == "too_large"


async def test_provenance_in_rejects_unknown_method() -> None:
    with pytest.raises(ValueError):
        ProvenanceIn(method="magic")  # type: ignore[arg-type]
