"""Fictional data only. Demo seed (app.seed): contract shapes, state coverage, idempotency, removal."""

from __future__ import annotations

import re
from io import BytesIO
from pathlib import Path
from typing import Any

import pytest
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.service import clarification_out
from app.db.models import Borehole, Clarification, Document, Event, FieldValue, Page, Revision
from app.geo.crs_service import confirm_crs
from app.review.paths import get_value, uncovered_paths
from app.review.service import approve_clean, companion_provenance, to_records
from app.schemas.boreholes import BoreholeBody
from app.seed import anchor_of, build_provenance, load_seed, remove_seed, render_documents
from app.seed_pages import LONG_EDGE
from app.services.documents import documents_out
from app.storage import get_storage
from tests.contract_utils import validate_schema

pytestmark = pytest.mark.db

EXPECTED_UNPLOTTED = {
    "BH03": "no_coordinates",
    "WH-1": "crs_unconfirmed",
    "WH-2": "crs_unconfirmed",
    "WH-3": "crs_unconfirmed",
    "SV-04": "crs_unknown",
    "SV-03": "implausible",
}


async def _seed_docs(session: AsyncSession) -> list[Document]:
    return list((await session.scalars(select(Document).where(Document.is_seed.is_(True)))).all())


def _box_ok(box: list[float] | None) -> bool:
    if box is None:
        return True
    x, y, w, h = box
    return all(0 <= v <= 1 for v in box) and w > 0 and h > 0 and x + w <= 1 + 1e-6 and y + h <= 1 + 1e-6


async def test_seed_matches_contract_and_covers_every_state(session: AsyncSession, storage_dir: Path) -> None:
    summary = await load_seed(session)
    assert summary is not None
    assert (summary.documents, summary.boreholes) == (8, 15)

    docs = await _seed_docs(session)
    doc_ids = {d.id for d in docs}
    out = [d.model_dump(mode="json") for d in await documents_out(session, docs)]
    for payload in out:
        validate_schema(payload, "Document")
    by_name = {d["file_name"]: d for d in out}
    statuses = [d["status"] for d in out]
    assert {"needs_review", "done", "classifying", "failed"} <= set(statuses)
    assert statuses.count("done") == 1
    failed = next(d for d in out if d["status"] == "failed")
    assert failed["error"] and "Traceback" not in failed["error"]
    classifying = next(d for d in out if d["status"] == "classifying")
    progress = classifying["progress"]
    assert 0 < progress["pages_classified"] < progress["pages_total"] and classifying["found"] is None
    projects = [d["project"] for d in out if d["project"]]
    assert any(projects.count(p) == 2 for p in projects)
    missing = [d["completeness"]["missing"] for d in out if d["completeness"]]
    assert ["KB-4"] in missing

    pages = [p for d in out for p in d["pages"]]
    assert {p["type"] for p in pages} == {"log", "lab_table", "text", "drawing", "photo", "unknown"}
    assert {p["ocr"] for p in pages if "ocr" in p} == {"done", "skipped", "pending", "failed"}
    assert {p["handwriting"] for p in pages if "handwriting" in p} == {
        "none",
        "annotations",
        "partial",
        "full",
    }
    assert len({p["language"] for p in pages if p["language"]}) >= 4
    assert any(p["sheet_label"] == "BLATT 2 VON 2" for p in pages)
    assert len({p.get("role") for p in pages if p.get("role")}) >= 12
    duplicates = [p for p in pages if p.get("role") == "duplicate"]
    assert len(duplicates) == 1 and duplicates[0]["duplicate_of"] and not duplicates[0]["used"]
    assert duplicates[0]["unused_reason"].startswith("duplicate of fictional-")
    assert all(p["unused_reason"] for p in pages if not p["used"] and p.get("role"))

    # Stored files: original PDF, 1600 px renders and 300 px thumbnails.
    storage = get_storage()
    page_rows = (await session.scalars(select(Page).where(Page.document_id.in_([d.id for d in docs])))).all()
    for doc in docs:
        assert storage.exists(doc.storage_key)
        assert storage.path(doc.storage_key).stat().st_size == doc.size_bytes
    for page in page_rows:
        assert page.render_key and page.thumb_key
        assert storage.exists(page.render_key) and storage.exists(page.thumb_key)
        assert max(page.width_px or 0, page.height_px or 0) == LONG_EDGE
    landscape = [p for p in page_rows if (p.width_px or 0) > (p.height_px or 0)]
    assert landscape and all(p.type == "drawing" for p in landscape)
    with Image.open(BytesIO(storage.get_bytes(page_rows[0].thumb_key))) as thumb:
        assert max(thumb.size) == 300

    boreholes = list(
        (await session.scalars(select(Borehole).where(Borehole.document_id.in_([d.id for d in docs])))).all()
    )
    records = [r.model_dump(mode="json") for r in await to_records(session, boreholes)]
    for record in records:
        validate_schema(record, "BoreholeRecord")
    by_label = {r["metadata"]["borehole_id"]: r for r in records}

    unplotted = {r["metadata"]["borehole_id"]: r["unplotted_reason"] for r in records if not r["plotted"]}
    assert unplotted == EXPECTED_UNPLOTTED
    plotted = [r for r in records if r["plotted"]]
    assert len(plotted) == 9
    assert len({r["metadata"]["country"] for r in plotted}) == 4
    assert all(-90 <= r["metadata"]["coordinates"]["latitude"] <= 90 for r in plotted)
    assert {r["review_status"] for r in records} == {"unreviewed", "in_review", "approved"}
    done = next(d for d in out if d["status"] == "done")
    assert all(r["review_status"] == "approved" for r in records if r["document_id"] == done["document_id"])

    provs: list[tuple[str, dict[str, Any]]] = [
        (path, p) for r in records for path, p in r["provenance"].items()
    ]
    assert {p["status"] for _, p in provs} == {"unreviewed", "approved", "flagged"}
    assert all(p["flag"] for _, p in provs if p["status"] == "flagged")
    assert {p["state"] for _, p in provs} == {"ok", "not_in_source", "illegible"}
    assert {p["method"] for _, p in provs} == {"read", "ocr", "derived", "guessed", "edited"}
    confidences = [p["confidence"] for _, p in provs if p["confidence"] is not None]
    assert min(confidences) < 0.9 < max(confidences)
    edited = [p for _, p in provs if p["method"] == "edited"]
    assert edited and all(p["ai_value"] != by_label["KB-1"]["stratigraphy"][0]["depth_to_m"] for p in edited)
    # Every seeded value is drawn on a page of a seeded document: page and box, never a spreadsheet cell.
    assert all(p["page"] is not None and p["box"] is not None and p["cell"] is None for _, p in provs)
    assert all(p["document_id"] in doc_ids for _, p in provs)
    assert any(p["document_id"] != r["document_id"] for r in records for p in r["provenance"].values())
    # Every non-null value has a provenance entry (values the server computes need none).
    assert {r["metadata"]["borehole_id"]: uncovered_paths(r, r["provenance"]) for r in records} == {
        r["metadata"]["borehole_id"]: [] for r in records
    }
    disagreeing = [p for _, p in provs if len(p["readings"]) >= 2]
    assert disagreeing and all(len({r["text"] for r in p["readings"]}) == 2 for p in disagreeing)
    assert all(_box_ok(p["box"]) for _, p in provs)
    assert all(p["page"] is not None for _, p in provs if p["box"] is not None)

    layers = [layer for r in records for layer in r["stratigraphy"]]
    refusal = [x for x in layers if x["spt_refusal"]]
    assert refusal == [x for x in layers if x["spt_raw"] == "50/120"]
    assert refusal[0]["spt_n_value"] is None
    assert any((x["core_recovery_pct"] or 0) > 100 for x in layers)
    rules = {lint["rule"] for r in records for lint in r["lint"]}
    assert {"recovery_above_100", "coordinates_out_of_range", "layer_gap", "cai_above_6_5"} <= rules
    assert any(x["din4023_code"] == "mG" for x in layers)
    assert {g["type"] for r in records for g in r["groundwater"]} >= {"strike", "rest"}
    assert {t["name"] for r in records for t in r["test_results"]} >= {
        "UCS",
        "Watercontent",
        "LiquidLimit",
        "CAI",
    }
    assert any(r["rock_head_m"] is not None for r in records)

    clars = list((await session.scalars(select(Clarification))).all())
    clar_out = [clarification_out(c).model_dump(mode="json") for c in clars]
    for payload in clar_out:
        validate_schema(payload, "Clarification")
    assert {c["kind"] for c in clar_out} == {
        "crs_confirm",
        "choose_reading",
        "datum_convention",
        "unit_ambiguous",
        "borehole_boundary",
        "duplicate",
        "conflicting_sources",
        "locate_borehole",
    }
    assert {c["status"] for c in clar_out} == {"open", "answered", "skipped"}
    for c in clar_out:
        for ev in [*c["evidence"], *(o.get("evidence") or {} for f in c["fields"] for o in f["options"])]:
            assert _box_ok(ev.get("box")) if ev else True

    # The CRS question spans every borehole of the shared-project documents; its first candidate plots all.
    crs = next(c for c in clar_out if c["kind"] == "crs_confirm")
    shared = {r["uid"] for r in records if r["crs_status"] == "inferred"}
    assert set(crs["borehole_uids"]) == shared and len(shared) == 3
    assert crs["fields"][0]["widget"] == "crs_picker" and crs["fields"][1]["widget"] == "boolean"
    assert (
        await confirm_crs(session, crs["borehole_uids"], crs="EPSG:2193", swap_axes=False, actor="test") == 3
    )
    moved = await session.scalars(select(Borehole).where(Borehole.uid.in_(crs["borehole_uids"])))
    for bh in moved:
        lat, lon = (
            bh.record["metadata"]["coordinates"]["latitude"],
            bh.record["metadata"]["coordinates"]["longitude"],
        )
        assert bh.plotted and -39.0 < lat < -38.4 and 177.8 < lon < 178.3
    await session.rollback()

    # approve-clean has work on the review documents.
    for d in out:
        if d["file_name"] in ("fictional-kesselbach-talbruecke-bohrprofile.pdf", AU_FILE):
            assert await approve_clean(session, d["document_id"], dry_run=True, actor="test") > 0
    assert by_name[AU_FILE]["found"]["spt"] >= 1

    events = (await session.execute(select(Event.type, Event.document_id))).all()
    updated = {doc_id for t, doc_id in events if t == "document.updated"}
    assert doc_ids <= updated
    assert {"borehole.created", "clarification.created", "clarification.resolved", "job.failed"} <= {
        t for t, _ in events
    }


AU_FILE = "fictional-marrowbank-creek-pipeline-borehole-logs.pdf"


async def test_seed_twice_then_remove_leaves_other_documents(
    session: AsyncSession, storage_dir: Path
) -> None:
    storage = get_storage()
    other = Document(
        id="doc_01NOTSEEDFICTIONAL000000000",
        file_name="fictional-user-upload.pdf",
        sha256="0" * 64,
        mime_type="application/pdf",
        size_bytes=4,
        storage_key="originals/" + "0" * 64 + ".pdf",
        status="queued",
    )
    session.add(other)
    await session.commit()
    storage.put_bytes(other.storage_key, b"%PDF")

    assert await load_seed(session) is not None
    assert await load_seed(session) is None  # second run: nothing added
    docs = await _seed_docs(session)
    assert len(docs) == 8
    keys = [d.storage_key for d in docs]
    page_keys = (
        await session.scalars(select(Page.render_key).where(Page.document_id.in_([d.id for d in docs])))
    ).all()
    n_boreholes = await session.scalar(select(func.count()).select_from(Borehole))
    assert n_boreholes == 15

    assert await remove_seed(session) == 8
    assert await _seed_docs(session) == []
    for model in (Page, Borehole, FieldValue, Revision, Clarification):
        assert await session.scalar(select(func.count()).select_from(model)) == 0
    assert not any(storage.exists(k) for k in keys)
    assert not any(storage.exists(k) for k in page_keys if k)
    assert await session.get(Document, other.id) is not None
    assert storage.exists(other.storage_key)
    deleted = (await session.scalars(select(Event.document_id).where(Event.type == "document.deleted"))).all()
    assert set(deleted) == {d.id for d in docs}
    assert await remove_seed(session) == 0


# Values written in another form than printed: ISO dates, enum codes and English country names.
NORMALISED = (".start_date", ".end_date", ".date", ".depth_origin", ".country")


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def test_every_seed_value_points_at_its_drawn_text() -> None:
    """No database: each spec's provenance resolves to drawn anchors and covers every non-null value."""
    rendered = render_documents()
    sheets = {r.spec.key: r.sheets for r in rendered}
    doc_ids = {r.spec.key: f"doc_{r.spec.key}" for r in rendered}
    checked = 0
    for doc in rendered:
        for spec in doc.spec.boreholes:
            body = BoreholeBody.model_validate(spec.body).model_dump(mode="json")
            prov = build_provenance(doc.spec, sheets, spec.prov, doc_ids)
            assert uncovered_paths(body, {**prov, **companion_provenance(body, prov)}) == [], spec.label
            for path, pv in spec.prov.items():
                entry = prov[path]
                assert entry.page is not None and entry.box == anchor_of(sheets, doc.spec.key, pv.ref).box
                value = get_value(body, path)
                if entry.raw is None or not isinstance(value, str) or path.endswith(NORMALISED):
                    continue
                # A copied text value is shown by the text its box covers.
                assert _words(value) <= _words(entry.raw), (spec.label, path, value, entry.raw)
                checked += 1
    assert checked > 200


def test_rendering_is_deterministic() -> None:
    first = render_documents()
    second = render_documents()
    assert [r.sha256 for r in first] == [r.sha256 for r in second]
    assert len({r.sha256 for r in first}) == len(first)
    for doc in first:
        assert doc.pdf.startswith(b"%PDF")
        for sheet in doc.sheets:
            assert max(sheet.image.size) == LONG_EDGE
            assert all(_box_ok(a.box) for a in sheet.anchors.values())
