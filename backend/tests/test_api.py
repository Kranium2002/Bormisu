"""HTTP API against PostGIS with fictional data; every response is validated against the contract."""

from __future__ import annotations

import io
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import respx
from PIL import Image
from sqlalchemy import select

from app.clarify.service import create_clarification
from app.config import get_settings
from app.db.models import Borehole, Document, Event, Page, Revision
from app.db.session import get_sessionmaker
from app.review.service import create_borehole
from app.schemas.boreholes import ProvenanceIn
from app.storage import get_storage, page_render_key
from tests.auth_utils import REVIEWER
from tests.contract_utils import validate_response
from tests.factories import full_provenance

pytestmark = pytest.mark.db

DOC_ID = "doc_01JFAKE0000000000000000API"


async def call(
    client: httpx.AsyncClient, method: str, path: str, *, expect: int, **kwargs: Any
) -> httpx.Response:
    response = await client.request(method, path, **kwargs)
    assert response.status_code == expect, response.text
    content_type = response.headers.get("content-type", "application/json").split(";")[0]
    body: Any = response.json() if response.content and "json" in content_type else None
    if path.startswith("/api/"):
        validate_response(method, path.split("?")[0], response.status_code, body, content_type)
    return response


def _png(width: int = 1600, height: int = 2263) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(out, format="PNG")
    return out.getvalue()


async def _fixture_document(*, crs_status: str = "inferred", crs_code: str | None = None) -> tuple[str, str]:
    """One fictional document with one rendered page, one borehole and one CRS question."""
    storage = get_storage()
    async with get_sessionmaker()() as session:
        doc = Document(
            id=DOC_ID,
            file_name="fictional-api-log.pdf",
            project="Fictional API Site",
            sha256="a" * 64,
            mime_type="application/pdf",
            size_bytes=10,
            storage_key="originals/" + "a" * 64 + ".pdf",
            status="needs_review",
            page_count=1,
        )
        session.add(doc)
        key = page_render_key(DOC_ID, 1)
        storage.put_bytes(key, _png())
        session.add(
            Page(
                document_id=DOC_ID,
                n=1,
                width_px=1600,
                height_px=2263,
                render_key=key,
                role="log_sheet",
                type="log",
                used=True,
                ocr_status="done",
                handwriting="none",
                borehole_labels=["FX-9"],
            )
        )
        await session.flush()
        prov = ProvenanceIn(page=1, box=[0.1, 0.1, 0.2, 0.02], raw="v", method="ocr", confidence=0.95)
        body = {
            "metadata": {
                "borehole_id": "FX-9",
                "borehole_depth_m": 8.0,
                "project_name": "Fictional API Site",
                "location_name": "Sampleton",
                "coordinates": {
                    "local_x": 413000.0,
                    "local_y": 5316000.0,
                    "x_raw": "413000",
                    "y_raw": "5316000",
                },
            },
            "stratigraphy": [
                {"depth_from_m": 0.0, "depth_to_m": 3.0, "din4023_code": "G"},
                {"depth_from_m": 3.0, "depth_to_m": 8.0, "din4023_code": "T"},
            ],
        }
        bh = await create_borehole(
            session,
            document=doc,
            group_key="g",
            body=body,
            provenance={
                **full_provenance(body),
                "metadata.borehole_depth_m": prov,
                "metadata.coordinates.local_x": prov,
                "metadata.coordinates.local_y": prov,
                "stratigraphy[0].din4023_code": prov,
                "stratigraphy[1].depth_to_m": prov,
            },
            crs_status=crs_status,
            crs_code=crs_code,
            pages=[1],
        )
        clar = await create_clarification(
            session,
            kind="crs_confirm",
            document_id=DOC_ID,
            question="Which coordinate system do the printed coordinates use?",
            fields=[
                {
                    "name": "crs",
                    "widget": "crs_picker",
                    "label": "Coordinate system",
                    "required": True,
                    "options": [{"value": "EPSG:25832", "label": "ETRS89 / UTM 32N"}],
                },
                {"name": "swap_axes", "widget": "boolean", "label": "Printed X is the northing"},
            ],
            evidence=[{"document_id": DOC_ID, "page": 1, "box": [0.1, 0.1, 0.2, 0.02], "snippet": "413000"}],
            borehole_uids=[bh.uid],
            dedupe_key="test-crs",
        )
        await session.commit()
        return bh.uid, clar.id


async def test_health_and_unknown_route(client: httpx.AsyncClient) -> None:
    for path in ("/api/health", "/api/v1/health"):
        body = (await call(client, "GET", path, expect=200)).json()
        assert body["mode"] == "demo"
        assert ".pdf" in body["upload"]["extensions"]
    missing = await client.get("/api/v1/nowhere")
    assert missing.status_code == 404 and missing.json()["code"] == "route_not_found"
    await call(client, "GET", "/api/v1/stats", expect=200)


async def test_upload_demo_mode(client: httpx.AsyncClient) -> None:
    response = await call(
        client, "POST", "/api/v1/documents", expect=409, files={"file": ("a.png", _png(10, 10))}
    )
    assert response.json() == {"detail": "demo_mode", "code": "demo_mode"}


async def test_upload_live(client: httpx.AsyncClient, live_mode: None, queue: Any) -> None:
    png = _png(20, 20)
    first = await call(
        client,
        "POST",
        "/api/v1/documents",
        expect=202,
        files={"file": ("../../etc/passwd.png", png)},
        data={"project": "Fictional Upload"},
    )
    doc_id = first.json()["document_id"]
    assert first.json()["status"] == "queued" and first.json()["duplicate_of"] is None
    again = await call(client, "POST", "/api/v1/documents", expect=200, files={"file": ("other.png", png)})
    assert again.json()["duplicate_of"] == doc_id
    doc = (await call(client, "GET", f"/api/v1/documents/{doc_id}", expect=200)).json()
    assert doc["file_name"] == "passwd.png" and doc["project"] == "Fictional Upload"
    assert doc["mime_type"] == "image/png" and doc["sha256"] and doc["pages"] == []
    assert get_storage().exists(f"originals/{doc['sha256']}.png")
    jobs = list(queue.jobs.values())
    assert [j["args"] for j in jobs] == [{"document_id": doc_id}]

    await call(client, "POST", "/api/v1/documents", expect=415, files={"file": ("x.exe", b"MZ....")})
    await call(client, "POST", "/api/v1/documents", expect=415, files={"file": ("fake.pdf", png)})
    await call(client, "POST", "/api/v1/documents", expect=415, files={"file": ("empty.pdf", b"")})
    missing = await call(client, "POST", "/api/v1/documents", expect=422, data={"project": "x"})
    assert missing.json()["code"] == "validation_error"


async def test_upload_too_large(
    client: httpx.AsyncClient, live_mode: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings

    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    get_settings.cache_clear()
    big = b"%PDF-1.4\n" + b"0" * (2 * 1024 * 1024)
    response = await call(client, "POST", "/api/v1/documents", expect=413, files={"file": ("big.pdf", big)})
    assert response.json()["code"] == "too_large"


async def test_documents_pages_and_boreholes(client: httpx.AsyncClient) -> None:
    uid, _ = await _fixture_document()
    listing = (await call(client, "GET", "/api/v1/documents", expect=200)).json()
    assert [d["document_id"] for d in listing["documents"]] == [DOC_ID]
    doc = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=200)).json()
    assert doc["found"]["boreholes"] == 1 and doc["open_clarifications"] == 1
    image = await call(client, "GET", f"/api/v1/documents/{DOC_ID}/pages/1.png?w=400", expect=200)
    assert image.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(image.content)).size[0] == 400
    clamped = await call(client, "GET", f"/api/v1/documents/{DOC_ID}/pages/1.png?w=50", expect=200)
    assert Image.open(io.BytesIO(clamped.content)).size[0] == 200
    assert (await call(client, "GET", f"/api/v1/documents/{DOC_ID}/pages/2.png", expect=404)).json()[
        "code"
    ] == "page_not_found"
    assert (await call(client, "GET", "/api/v1/documents/doc_nope", expect=404)).json()[
        "code"
    ] == "document_not_found"
    records = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}/boreholes", expect=200)).json()
    assert [r["uid"] for r in records] == [uid]
    await call(client, "GET", f"/api/v1/boreholes/{uid}", expect=200)
    assert (await call(client, "GET", "/api/v1/boreholes/bh_nope", expect=404)).json()[
        "code"
    ] == "borehole_not_found"
    retry = await call(client, "POST", f"/api/v1/documents/{DOC_ID}/retry", expect=409)
    assert retry.json()["code"] == "not_failed"


async def test_borehole_list_filters(client: httpx.AsyncClient) -> None:
    uid, _ = await _fixture_document(crs_status="stated", crs_code="EPSG:25832")
    everything = (await call(client, "GET", "/api/v1/boreholes", expect=200)).json()
    assert everything["count"] == 1 and everything["boreholes"][0]["plotted"] is True
    coords = everything["boreholes"][0]["metadata"]["coordinates"]
    assert coords["crs_code"] == "EPSG:25832" and coords["crs_label"] == "ETRS89 / UTM zone 32N"
    cases = {
        "?search=fx-9": 1,
        "?search=nothing-like-this": 0,
        "?min_depth_m=5": 1,
        "?max_depth_m=5": 0,
        "?din4023_code=T": 1,
        "?din4023_code=Kst&din4023_code=G": 1,
        "?din4023_code=Kst": 0,
        "?plotted=false": 0,
        "?include_unreviewed=false": 0,
        f"?document_id={DOC_ID}": 1,
    }
    for query, expected in cases.items():
        body = (await call(client, "GET", "/api/v1/boreholes" + query, expect=200)).json()
        assert body["count"] == expected, query
    page = (await call(client, "GET", "/api/v1/boreholes?limit=1", expect=200)).json()
    assert page["next_cursor"] is None and page["boreholes"][0]["uid"] == uid
    bad = await call(client, "GET", "/api/v1/boreholes?limit=0", expect=422)
    assert bad.json()["code"] == "validation_error" and bad.json()["errors"]


async def test_review_patch_flow(client: httpx.AsyncClient) -> None:
    uid, _ = await _fixture_document()
    path = f"/api/v1/boreholes/{uid}/values"
    approved = (
        await call(
            client, "PATCH", path, expect=200, json={"path": "metadata.borehole_depth_m", "action": "approve"}
        )
    ).json()
    assert approved["revision"] == 2 and approved["review_status"] == "in_review"
    edited = (
        await call(
            client,
            "PATCH",
            path,
            expect=200,
            json={"path": "stratigraphy[1].depth_to_m", "action": "edit", "value": 8.4, "if_revision": 2},
        )
    ).json()
    prov = edited["provenance"]["stratigraphy[1].depth_to_m"]
    assert (
        prov["method"] == "edited"
        and prov["ai_value"] == 8.0
        and edited["stratigraphy"][1]["depth_to_m"] == 8.4
    )
    conflict = await call(
        client,
        "PATCH",
        path,
        expect=409,
        json={"path": "metadata.borehole_depth_m", "action": "reset", "if_revision": 1},
    )
    assert conflict.json()["code"] == "revision_conflict"
    unknown = await call(
        client, "PATCH", path, expect=404, json={"path": "metadata.client", "action": "approve"}
    )
    assert unknown.json()["code"] == "path_not_found"
    bad = await call(
        client,
        "PATCH",
        path,
        expect=422,
        json={"path": "stratigraphy[0].din4023_code", "action": "edit", "value": "gravel"},
    )
    assert bad.json()["code"] == "unparseable_value"
    invalid = await call(client, "PATCH", path, expect=422, json={"path": "x", "action": "explode"})
    assert invalid.json()["code"] == "validation_error"
    flagged = (
        await call(
            client,
            "PATCH",
            path,
            expect=200,
            json={"path": "stratigraphy[0].din4023_code", "action": "flag", "reason": "unclear"},
        )
    ).json()
    assert flagged["provenance"]["stratigraphy[0].din4023_code"]["flag"] == "unclear"
    state = (
        await call(
            client,
            "PATCH",
            path,
            expect=200,
            json={"path": "stratigraphy[0].din4023_code", "action": "set_state", "state": "illegible"},
        )
    ).json()
    assert state["provenance"]["stratigraphy[0].din4023_code"]["state"] == "illegible"
    reset = (
        await call(
            client,
            "PATCH",
            path,
            expect=200,
            json={"path": "stratigraphy[0].din4023_code", "action": "reset"},
        )
    ).json()
    assert reset["provenance"]["stratigraphy[0].din4023_code"]["status"] == "unreviewed"
    reloaded = (await call(client, "GET", f"/api/v1/boreholes/{uid}", expect=200)).json()
    assert reloaded["revision"] == reset["revision"] == 6
    clean = (await call(client, "POST", f"/api/v1/documents/{DOC_ID}/approve-clean", expect=200)).json()
    assert clean["count"] >= 1
    done = (
        await call(client, "POST", f"/api/v1/documents/{DOC_ID}/approve-clean?dry_run=false", expect=200)
    ).json()
    assert done["count"] == clean["count"]
    async with get_sessionmaker()() as session:
        last = await session.scalar(
            select(Revision).where(Revision.uid == uid).order_by(Revision.revision.desc()).limit(1)
        )
    assert last is not None and last.action == "approve_clean" and last.actor == REVIEWER.actor


async def test_crs_answer_plots_and_map(client: httpx.AsyncClient) -> None:
    uid, clar_id = await _fixture_document()
    layer = (await call(client, "GET", "/api/v1/map/boreholes.geojson", expect=200)).json()
    assert layer["features"] == []
    candidates = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}/crs-candidates", expect=200)).json()
    assert candidates and candidates[0]["verdict"] == "match"
    assert any(c["crs"] == "EPSG:25832" for c in candidates)
    inbox = (await call(client, "GET", "/api/v1/clarifications", expect=200)).json()
    assert [c["clarification_id"] for c in inbox] == [clar_id]
    wrong = await call(
        client,
        "POST",
        f"/api/v1/clarifications/{clar_id}/answer",
        expect=422,
        json={"values": {"crs": "EPSG:4326", "swap_axes": False}},
    )
    assert (
        wrong.json()["code"] == "crs_invalid"
    )  # the picker allows any system; this one cannot place the points
    answered = (
        await call(
            client,
            "POST",
            f"/api/v1/clarifications/{clar_id}/answer",
            expect=200,
            json={"values": {"crs": "EPSG:25832", "swap_axes": False}, "answered_by": "tester"},
        )
    ).json()
    # answered_by in the body is ignored since 1.4.0: the signed-in user answered.
    assert answered["status"] == "answered" and answered["answered_by"] == REVIEWER.actor
    again = await call(
        client,
        "POST",
        f"/api/v1/clarifications/{clar_id}/answer",
        expect=409,
        json={"values": {"crs": "EPSG:25832"}},
    )
    assert again.json()["code"] == "already_resolved"
    record = (await call(client, "GET", f"/api/v1/boreholes/{uid}", expect=200)).json()
    assert record["plotted"] is True and record["crs_status"] == "confirmed"
    layer = (await call(client, "GET", "/api/v1/map/boreholes.geojson", expect=200)).json()
    assert [f["id"] for f in layer["features"]] == [uid]
    lon, lat = layer["features"][0]["geometry"]["coordinates"]
    assert 7.0 < lon < 9.0 and 47.0 < lat < 49.0
    invalid = await call(
        client, "POST", f"/api/v1/documents/{DOC_ID}/crs", expect=422, json={"crs": "EPSG:999999"}
    )
    assert invalid.json()["code"] == "crs_invalid"
    confirmed = (
        await call(client, "POST", f"/api/v1/documents/{DOC_ID}/crs", expect=200, json={"crs": "EPSG:25832"})
    ).json()
    assert confirmed["updated"] == 1


async def test_result_sets(client: httpx.AsyncClient) -> None:
    uid, _ = await _fixture_document(crs_status="stated", crs_code="EPSG:25832")
    created = (
        await call(
            client,
            "POST",
            "/api/v1/result-sets",
            expect=201,
            json={"include_unreviewed": True, "area": {"type": "bbox", "bbox": [7, 47, 9, 49]}},
        )
    ).json()
    assert created["uids"] == [uid] and created["located_count"] == 1
    scoped = (await call(client, "POST", "/api/v1/result-sets", expect=201, json={"min_depth_m": 1})).json()
    assert scoped["count"] == 0 and scoped["excluded_unreviewed"] == 1
    empty = (
        await call(
            client,
            "POST",
            "/api/v1/result-sets",
            expect=201,
            json={
                "include_unreviewed": True,
                "area": {"type": "circle", "center": [151.2, -33.9], "radius_m": 5000},
            },
        )
    ).json()
    assert empty["count"] == 0 and empty["bbox"] is not None and empty["area"]["type"] == "circle"
    polygon = {"type": "Polygon", "coordinates": [[[7, 47], [9, 47], [9, 49], [7, 49], [7, 47]]]}
    poly = (
        await call(
            client,
            "POST",
            "/api/v1/result-sets",
            expect=201,
            json={"include_unreviewed": True, "area": {"type": "polygon", "polygon": polygon}},
        )
    ).json()
    assert poly["count"] == 1
    rs_id = created["result_set_id"]
    await call(client, "GET", f"/api/v1/result-sets/{rs_id}", expect=200)
    geo = (await call(client, "GET", f"/api/v1/result-sets/{rs_id}/geojson", expect=200)).json()
    assert [f["id"] for f in geo["features"]] == [uid]
    listed = (await call(client, "GET", f"/api/v1/boreholes?result_set_id={rs_id}", expect=200)).json()
    assert listed["count"] == 1
    assert (await call(client, "GET", "/api/v1/result-sets/rs_nope", expect=404)).json()[
        "code"
    ] == "result_set_not_found"
    bad = await call(
        client, "POST", "/api/v1/result-sets", expect=422, json={"area": {"type": "bbox", "bbox": [1, 2]}}
    )
    assert bad.json()["code"] == "validation_error"


async def test_geocode_uploaded_places_only(client: httpx.AsyncClient) -> None:
    await _fixture_document(crs_status="stated", crs_code="EPSG:25832")
    places = (await call(client, "GET", "/api/v1/geocode?q=Sampleton", expect=200)).json()
    assert places and places[0]["source"] == "uploaded" and places[0]["borehole_count"] == 1
    assert (await call(client, "GET", "/api/v1/geocode?q=zzzz-nowhere", expect=200)).json() == []
    await call(client, "GET", "/api/v1/geocode?q=a", expect=422)


async def test_skip_delete_chat_and_events(client: httpx.AsyncClient) -> None:
    _, clar_id = await _fixture_document()
    skipped = (await call(client, "POST", f"/api/v1/clarifications/{clar_id}/skip", expect=200)).json()
    assert skipped["status"] == "skipped"
    listed = (await call(client, "GET", "/api/v1/clarifications?status=skipped", expect=200)).json()
    assert [c["clarification_id"] for c in listed] == [clar_id]
    chat = await call(client, "POST", "/api/v1/chat", expect=409, json={"messages": []})
    assert chat.json()["code"] == "chat_unavailable"
    await call(client, "DELETE", f"/api/v1/documents/{DOC_ID}", expect=204)
    await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=404)
    async with get_sessionmaker()() as session:
        assert await session.scalar(select(Borehole).limit(1)) is None
        types = (await session.scalars(select(Event.type).order_by(Event.id))).all()
    assert types[0] == "borehole.created" and types[-1] == "document.deleted"
    assert "clarification.created" in types and "clarification.resolved" in types


async def test_event_stream_replay() -> None:
    from app.events.stream import event_stream

    await _fixture_document()
    frames = []

    async def disconnected() -> bool:
        return True

    async for frame in event_stream(0, None, disconnected, ping_interval=0.1):
        frames.append(frame)
    events = [f for f in frames if f.startswith("id: ")]
    assert events and "event: borehole.created" in events[0]
    assert all(f.endswith("\n\n") for f in frames)


# ------------------------------------------------------------------------------------------------
# Contract 1.1.0: review actor, crs_label, skipped questions, CRS candidates per clarification
# ------------------------------------------------------------------------------------------------

SITE = "Fictional API Site"
GEOCODER_URL = "https://geocoder.fictional.test"
# A fictional geocoder answer for "Sampleton" near the fixture's printed coordinates (UTM 32N).
SAMPLETON = [
    {
        "lat": "47.995",
        "lon": "7.835",
        "display_name": "Sampleton, Fictional County",
        "boundingbox": ["47.97", "48.02", "7.80", "7.87"],
        "addresstype": "town",
    }
]


async def _extra_borehole(
    doc_id: str, label: str, x: float, y: float, *, crs_status: str = "inferred", crs_code: str | None = None
) -> str:
    """A second fictional document of the same site with one borehole (no page images)."""
    async with get_sessionmaker()() as session:
        doc = Document(
            id=doc_id,
            file_name=f"fictional-{label.lower()}.pdf",
            project=SITE,
            sha256=doc_id[-1].lower() * 64,
            mime_type="application/pdf",
            size_bytes=10,
            storage_key="originals/" + doc_id[-1].lower() * 64 + ".pdf",
            status="needs_review",
            page_count=1,
        )
        session.add(doc)
        await session.flush()
        body = {
            "metadata": {
                "borehole_id": label,
                "project_name": SITE,
                "location_name": "Sampleton",
                "coordinates": {"local_x": x, "local_y": y, "x_raw": str(x), "y_raw": str(y)},
            },
            "stratigraphy": [{"depth_from_m": 0.0, "depth_to_m": 2.0, "din4023_code": "S"}],
        }
        bh = await create_borehole(
            session,
            document=doc,
            group_key="g",
            body=body,
            provenance=full_provenance(body),
            crs_status=crs_status,
            crs_code=crs_code,
            pages=[1],
        )
        await session.commit()
        return bh.uid


@pytest.fixture
def geocoder_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The server-side geocoder is configured, at a fictional URL that respx answers."""
    monkeypatch.setenv("GEOCODER", "nominatim")
    monkeypatch.setenv("NOMINATIM_URL", GEOCODER_URL)
    get_settings.cache_clear()
    yield
    monkeypatch.undo()
    get_settings.cache_clear()


async def test_review_actor_is_recorded(client: httpx.AsyncClient) -> None:
    """The actor is the signed-in user (1.4.0); confirmed_by in a body or the query is ignored."""
    uid, _ = await _fixture_document()
    path = f"/api/v1/boreholes/{uid}/values"
    patches = [
        {"path": "metadata.borehole_depth_m", "action": "approve", "confirmed_by": "  Example Reviewer  "},
        {"path": "stratigraphy[1].depth_to_m", "action": "flag", "reason": "unclear", "confirmed_by": "   "},
        {"path": "stratigraphy[0].din4023_code", "action": "approve", "confirmed_by": "R" * 150},
        {"path": "metadata.coordinates.local_x", "action": "approve", "confirmed_by": None},
    ]
    for patch in patches:
        await call(client, "PATCH", path, expect=200, json=patch)
    clean = await call(
        client,
        "POST",
        f"/api/v1/documents/{DOC_ID}/approve-clean",
        expect=200,
        params={"dry_run": "false", "confirmed_by": " Field Lead "},
    )
    assert clean.json()["count"] >= 1
    async with get_sessionmaker()() as session:
        rows = (
            await session.scalars(select(Revision).where(Revision.uid == uid).order_by(Revision.revision))
        ).all()
    actors = [r.actor for r in rows]
    assert actors == ["pipeline", *[REVIEWER.actor] * 5]
    assert rows[-1].action == "approve_clean"


async def test_crs_label_follows_crs_code(client: httpx.AsyncClient) -> None:
    uid, clar_id = await _fixture_document()
    record = (await call(client, "GET", f"/api/v1/boreholes/{uid}", expect=200)).json()
    assert record["metadata"]["coordinates"]["crs_code"] is None
    assert record["metadata"]["coordinates"]["crs_label"] is None
    await call(
        client,
        "POST",
        f"/api/v1/clarifications/{clar_id}/answer",
        expect=200,
        json={"values": {"crs": "EPSG:25832", "swap_axes": False}},
    )
    record = (await call(client, "GET", f"/api/v1/boreholes/{uid}", expect=200)).json()
    coords = record["metadata"]["coordinates"]
    assert coords["crs_code"] == "EPSG:25832" and coords["crs_label"] == "ETRS89 / UTM zone 32N"
    assert "metadata.coordinates.crs_label" not in record["provenance"]
    refused = await call(
        client,
        "PATCH",
        f"/api/v1/boreholes/{uid}/values",
        expect=404,
        json={"path": "metadata.coordinates.crs_label", "action": "edit", "value": "Anything"},
    )
    assert refused.json()["code"] == "path_not_found"
    # A record stored before contract 1.1.0 (no crs_label) gets its label when it is read.
    async with get_sessionmaker()() as session:
        bh = await session.get(Borehole, uid)
        assert bh is not None
        legacy = dict(bh.record)
        legacy["metadata"] = dict(legacy["metadata"])
        legacy["metadata"]["coordinates"] = {
            k: v for k, v in legacy["metadata"]["coordinates"].items() if k != "crs_label"
        }
        bh.record = legacy
        await session.commit()
    record = (await call(client, "GET", f"/api/v1/boreholes/{uid}", expect=200)).json()
    assert record["metadata"]["coordinates"]["crs_label"] == "ETRS89 / UTM zone 32N"


async def test_skipped_question_stays_unresolved_and_can_be_answered(client: httpx.AsyncClient) -> None:
    uid, clar_id = await _fixture_document()
    await call(client, "POST", f"/api/v1/clarifications/{clar_id}/skip", expect=200)
    doc = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=200)).json()
    record = (await call(client, "GET", f"/api/v1/boreholes/{uid}", expect=200)).json()
    assert doc["open_clarifications"] == 1 and record["open_clarifications"] == 1
    answered = (
        await call(
            client,
            "POST",
            f"/api/v1/clarifications/{clar_id}/answer",
            expect=200,
            json={"values": {"crs": "EPSG:25832"}, "answered_by": "Example Reviewer"},
        )
    ).json()
    assert answered["status"] == "answered" and answered["answered_by"] == REVIEWER.actor
    doc = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}", expect=200)).json()
    assert doc["open_clarifications"] == 0
    again = await call(client, "POST", f"/api/v1/clarifications/{clar_id}/skip", expect=409)
    assert again.json()["code"] == "already_resolved"


async def test_clarification_crs_candidates_span_documents(client: httpx.AsyncClient) -> None:
    uid, _ = await _fixture_document()
    other = await _extra_borehole("doc_01JFAKE00000000000000API2", "FX-10", 413500.0, 5316400.0)
    picker = {
        "name": "crs",
        "widget": "crs_picker",
        "label": "Coordinate system",
        "required": True,
        "options": [{"value": "EPSG:25832", "label": "ETRS89 / UTM zone 32N"}],
    }
    async with get_sessionmaker()() as session:
        both = await create_clarification(
            session,
            kind="crs_confirm",
            document_id=DOC_ID,
            question="Which coordinate system do the coordinates of the Fictional API Site use?",
            fields=[picker],
            borehole_uids=[uid, other],
            dedupe_key="test-crs-both",
        )
        locate = await create_clarification(
            session,
            kind="locate_borehole",
            document_id=DOC_ID,
            question="Where is FX-9?",
            fields=[{"name": "point", "widget": "map_point", "label": "Position"}],
            borehole_uids=[uid],
            dedupe_key="test-locate",
        )
        await session.commit()
    url = f"/api/v1/clarifications/{both.id}/crs-candidates"
    candidates = (await call(client, "GET", url, expect=200)).json()
    assert candidates and candidates[0]["verdict"] == "match"
    assert {p["uid"] for p in candidates[0]["points"]} == {uid, other}
    assert any(c["crs"] == "EPSG:25832" for c in candidates)
    url = f"/api/v1/clarifications/{locate.id}/crs-candidates"
    assert (await call(client, "GET", url, expect=200)).json() == []
    missing = await call(client, "GET", "/api/v1/clarifications/cl_nope/crs-candidates", expect=404)
    assert missing.json()["code"] == "clarification_not_found"


async def test_crs_candidates_use_uploaded_places_first(client: httpx.AsyncClient) -> None:
    """A plotted borehole of the same site (stated system) is the reference; no geocoder is configured."""
    await _fixture_document()
    await _extra_borehole(
        "doc_01JFAKE00000000000000API3",
        "FX-11",
        413400.0,
        5316300.0,
        crs_status="stated",
        crs_code="EPSG:25832",
    )
    candidates = (await call(client, "GET", f"/api/v1/documents/{DOC_ID}/crs-candidates", expect=200)).json()
    assert candidates[0]["crs"] == "EPSG:25832" and candidates[0]["verdict"] == "match"
    assert "(uploaded)" in candidates[0]["note"]
    same_zone = {"EPSG:25832", "EPSG:32632"}
    assert all(c["verdict"] != "match" for c in candidates if c["crs"] not in same_zone)


async def test_crs_candidates_rank_with_the_geocoded_place(
    client: httpx.AsyncClient, geocoder_on: None
) -> None:
    _, clar_id = await _fixture_document()
    with respx.mock(assert_all_called=True) as router:
        route = router.get(f"{GEOCODER_URL}/search").mock(return_value=httpx.Response(200, json=SAMPLETON))
        by_document = (
            await call(client, "GET", f"/api/v1/documents/{DOC_ID}/crs-candidates", expect=200)
        ).json()
        url = f"/api/v1/clarifications/{clar_id}/crs-candidates"
        by_question = (await call(client, "GET", url, expect=200)).json()
    assert by_document[0]["crs"] == "EPSG:25832" and by_document[0]["verdict"] == "match"
    assert "Sampleton, Fictional County" in by_document[0]["note"]
    assert by_question[0]["crs"] == "EPSG:25832"
    assert route.call_count == 1, "the second ranking reads the geocoder cache"
    assert route.calls[0].request.url.params["q"] == "Sampleton"


@pytest.mark.parametrize("failure", ["status_503", "connect_error"])
async def test_crs_candidates_survive_a_geocoder_outage(
    client: httpx.AsyncClient, geocoder_on: None, failure: str
) -> None:
    _, clar_id = await _fixture_document()
    with respx.mock(assert_all_called=True) as router:
        route = router.get(f"{GEOCODER_URL}/search")
        if failure == "status_503":
            route.mock(return_value=httpx.Response(503))
        else:
            route.mock(side_effect=httpx.ConnectError("fictional outage"))
        by_document = (
            await call(client, "GET", f"/api/v1/documents/{DOC_ID}/crs-candidates", expect=200)
        ).json()
        url = f"/api/v1/clarifications/{clar_id}/crs-candidates"
        by_question = (await call(client, "GET", url, expect=200)).json()
    for candidates in (by_document, by_question):
        assert candidates and candidates[0]["verdict"] == "match"
        assert any(c["crs"] == "EPSG:25832" for c in candidates)
        assert all("no reference place found" in c["note"] for c in candidates)
    assert route.call_count == 2, "one attempt per ranking, then no further queries"
