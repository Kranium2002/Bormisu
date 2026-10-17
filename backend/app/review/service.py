"""The one service that changes borehole records.

Every change (pipeline creation, review PATCH, approve-clean, CRS confirmation, clarification answers)
goes through here: it updates `field_values`, recomputes the record body and the query columns, writes
a `revisions` row, increments `revision` and writes a `borehole.*` event — all in the caller's
transaction. Callers commit.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any

from geoalchemy2.elements import WKTElement
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import (
    Borehole,
    BoreholeGroundwater,
    BoreholeLayer,
    Clarification,
    Document,
    FieldValue,
    Revision,
)
from app.din import din_kind
from app.errors import ApiError, not_found
from app.events.writer import emit
from app.geo.plotting import PLOTTABLE_CRS_STATUS, placement, to_wgs84
from app.ids import new_id
from app.review.paths import (
    PathError,
    ValueParseError,
    coerce_value,
    get_value,
    parse_path,
    path_exists,
    set_value,
)
from app.schemas.boreholes import (
    BoreholeBody,
    BoreholeRecord,
    Lint,
    Provenance,
    ProvenanceIn,
    ValuePatch,
)
from app.validate.rules import lint_body

LAT = "metadata.coordinates.latitude"
LON = "metadata.coordinates.longitude"
LOCAL_X = "metadata.coordinates.local_x"
LOCAL_Y = "metadata.coordinates.local_y"
ROCK_HEAD = "rock_head_m"

_CANON_STRIP = re.compile(r"[\s\-_./]+")
_LEADING_ZEROS = re.compile(r"(?<![0-9])0+(?=[0-9])")


def canonical_label(label: str) -> str:
    """Upper case without spaces, dashes and underscores; numeric parts without leading zeros."""
    text = _CANON_STRIP.sub("", label.strip().upper())
    return _LEADING_ZEROS.sub("", text)


def _now() -> datetime:
    return datetime.now(UTC)


# ----------------------------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------------------------


async def load_field_values(session: AsyncSession, uid: str) -> dict[str, FieldValue]:
    rows = (await session.scalars(select(FieldValue).where(FieldValue.uid == uid))).all()
    return {fv.path: fv for fv in rows}


async def get_borehole_for_update(session: AsyncSession, uid: str) -> Borehole:
    """Lock the row so parallel PATCHes on one record serialise."""
    bh = await session.scalar(select(Borehole).where(Borehole.uid == uid).with_for_update())
    if bh is None:
        raise not_found("borehole_not_found", "Borehole")
    return bh


# ----------------------------------------------------------------------------------------------
# Recompute (pure, apart from mutating the ORM objects it is given)
# ----------------------------------------------------------------------------------------------


def _first_source(fvs: dict[str, FieldValue], paths: Sequence[str]) -> FieldValue | None:
    for path in paths:
        fv = fvs.get(path)
        if fv is not None and fv.page is not None:
            return fv
    for path in paths:
        if path in fvs:
            return fvs[path]
    return None


def _min_confidence(fvs: Iterable[FieldValue | None]) -> float | None:
    values = [fv.confidence for fv in fvs if fv is not None and fv.confidence is not None]
    return min(values) if values else None


def _set_derived(
    bh: Borehole,
    fvs: dict[str, FieldValue],
    path: str,
    value: Any,
    sources: Sequence[FieldValue | None],
    new_rows: list[FieldValue],
) -> None:
    """Create or update a `derived` provenance entry; an approved entry whose value changes is re-opened."""
    source = next((s for s in sources if s is not None), None)
    fv = fvs.get(path)
    if fv is None:
        fv = FieldValue(
            uid=bh.uid,
            path=path,
            value=value,
            raw=None,
            document_id=source.document_id if source else bh.document_id,
            page=source.page if source else None,
            box=source.box if source else None,
            cell=source.cell if source else None,
            method="derived",
            confidence=_min_confidence(sources),
            status="unreviewed",
            state="ok",
            ai_value=value,
            flag=None,
            readings=[],
        )
        fvs[path] = fv
        new_rows.append(fv)
        return
    if fv.value != value:
        fv.value = value
        fv.ai_value = value
        fv.confidence = _min_confidence(sources)
        if source is not None:
            fv.page, fv.box, fv.cell, fv.document_id = (
                source.page,
                source.box,
                source.cell,
                source.document_id,
            )
        if fv.status == "approved":
            fv.status = "unreviewed"
        fv.updated_at = _now()


def _derive_wgs84(
    bh: Borehole, body: dict[str, Any], fvs: dict[str, FieldValue], new_rows: list[FieldValue], drop: set[str]
) -> None:
    coords = body["metadata"].setdefault("coordinates", {})
    derivable = all(fvs.get(p) is None or fvs[p].method == "derived" for p in (LAT, LON))
    if not derivable:
        return
    x, y = coords.get("local_x"), coords.get("local_y")
    result = None
    if (
        bh.crs_code
        and bh.crs_status in PLOTTABLE_CRS_STATUS
        and isinstance(x, int | float)
        and isinstance(y, int | float)
    ):
        result = to_wgs84(bh.crs_code, float(x), float(y), swap_axes=bh.swap_axes)
    if result is None:
        # Derived WGS84 values only exist while a stated or confirmed system supports them.
        for path in (LAT, LON):
            if path in fvs:
                drop.add(path)
        coords["latitude"] = None
        coords["longitude"] = None
        return
    lat, lon = round(result[0], 7), round(result[1], 7)
    coords["latitude"], coords["longitude"] = lat, lon
    coords["crs_code"] = bh.crs_code
    sources = [fvs.get(LOCAL_X), fvs.get(LOCAL_Y)]
    _set_derived(bh, fvs, LAT, lat, sources, new_rows)
    _set_derived(bh, fvs, LON, lon, sources, new_rows)


def _derive_rock_head(
    bh: Borehole, body: dict[str, Any], fvs: dict[str, FieldValue], new_rows: list[FieldValue], drop: set[str]
) -> None:
    existing = fvs.get(ROCK_HEAD)
    if existing is not None and existing.method != "derived":
        return  # printed or edited by a person: keep it
    for i, layer in enumerate(body.get("stratigraphy") or []):
        if din_kind(layer.get("din4023_code")) == "rock" and isinstance(
            layer.get("depth_from_m"), int | float
        ):
            value = float(layer["depth_from_m"])
            body["rock_head_m"] = value
            sources = [fvs.get(f"stratigraphy[{i}].din4023_code"), fvs.get(f"stratigraphy[{i}].depth_from_m")]
            _set_derived(bh, fvs, ROCK_HEAD, value, sources, new_rows)
            return
    body["rock_head_m"] = None
    if existing is not None:
        drop.add(ROCK_HEAD)


def _thicknesses(body: dict[str, Any]) -> None:
    for layer in body.get("stratigraphy") or []:
        top, bottom = layer.get("depth_from_m"), layer.get("depth_to_m")
        if isinstance(top, int | float) and isinstance(bottom, int | float) and bottom >= top:
            layer["thickness_m"] = round(float(bottom) - float(top), 3)
        else:
            layer["thickness_m"] = None


def review_status_of(fvs: Iterable[FieldValue]) -> str:
    statuses = [fv.status for fv in fvs]
    if not statuses or all(s == "unreviewed" for s in statuses):
        return "unreviewed"
    if all(s == "approved" for s in statuses):
        return "approved"
    return "in_review"


def recompute(bh: Borehole, fvs: dict[str, FieldValue]) -> tuple[list[FieldValue], set[str]]:
    """Recompute derived values, placement, lint and status. Returns (new rows, paths to delete)."""
    body = copy.deepcopy(bh.record)
    body.setdefault("metadata", {}).setdefault("coordinates", {})
    new_rows: list[FieldValue] = []
    drop: set[str] = set()
    _thicknesses(body)
    _derive_wgs84(bh, body, fvs, new_rows, drop)
    _derive_rock_head(bh, body, fvs, new_rows, drop)
    for path in drop:
        fvs.pop(path, None)

    # Keep provenance values in step with the body (edits and derivations write both).
    for path, fv in fvs.items():
        if path_exists(body, path):
            current = get_value(body, path)
            if fv.value != current:
                fv.value = current

    # Validate the body against the contract types (raises for programming errors, never silently fixes).
    body = BoreholeBody.model_validate(body).model_dump(mode="json")

    meta = body["metadata"]
    coords = meta["coordinates"]
    lint = lint_body(body)
    has_lint_error = any(
        item["severity"] == "error" and item["rule"] == "coordinates_out_of_range" for item in lint
    )
    place = placement(coords, bh.crs_status, implausible=has_lint_error)

    bh.record = body
    bh.lint = lint
    bh.plotted = place.plotted
    bh.unplotted_reason = place.unplotted_reason
    bh.geom = (
        WKTElement(f"POINT({place.longitude} {place.latitude})", srid=4326)
        if place.plotted and place.longitude is not None and place.latitude is not None
        else None
    )
    bh.label_raw = str(meta.get("borehole_id") or bh.label_raw)
    bh.label_canonical = canonical_label(bh.label_raw)
    bh.aliases = list(meta.get("aliases") or [])
    bh.borehole_depth_m = meta.get("borehole_depth_m")
    bh.rock_head_m = body.get("rock_head_m")
    bh.project_name = meta.get("project_name")
    bh.country = meta.get("country")
    bh.location_name = meta.get("location_name")
    bh.review_status = review_status_of(fvs.values())
    bh.needs_attention = any(fv.status == "flagged" for fv in fvs.values()) or any(
        item["severity"] == "error" for item in lint
    )
    bh.updated_at = _now()
    return new_rows, drop


async def _rebuild_query_rows(session: AsyncSession, bh: Borehole) -> None:
    await session.execute(delete(BoreholeLayer).where(BoreholeLayer.uid == bh.uid))
    await session.execute(delete(BoreholeGroundwater).where(BoreholeGroundwater.uid == bh.uid))
    for i, layer in enumerate(bh.record.get("stratigraphy") or []):
        session.add(
            BoreholeLayer(
                uid=bh.uid,
                idx=i,
                depth_from_m=layer.get("depth_from_m"),
                depth_to_m=layer.get("depth_to_m"),
                din4023_code=layer.get("din4023_code"),
                english_lithology=layer.get("english_lithology"),
                spt_n_value=layer.get("spt_n_value"),
                spt_refusal=layer.get("spt_refusal"),
                rqd_pct=layer.get("rqd_pct"),
                core_recovery_pct=layer.get("core_recovery_pct"),
            )
        )
    for i, reading in enumerate(bh.record.get("groundwater") or []):
        session.add(
            BoreholeGroundwater(
                uid=bh.uid,
                idx=i,
                type=reading["type"],
                depth_m=reading.get("depth_m"),
                date=reading.get("date"),
            )
        )


async def _apply_recompute(session: AsyncSession, bh: Borehole, fvs: dict[str, FieldValue]) -> None:
    new_rows, drop = recompute(bh, fvs)
    if drop:
        await session.execute(delete(FieldValue).where(FieldValue.uid == bh.uid, FieldValue.path.in_(drop)))
    for fv in new_rows:
        session.add(fv)
    await session.flush()
    await _rebuild_query_rows(session, bh)


# ----------------------------------------------------------------------------------------------
# Writes
# ----------------------------------------------------------------------------------------------


async def create_borehole(
    session: AsyncSession,
    *,
    document: Document,
    group_key: str,
    body: BoreholeBody | dict[str, Any],
    provenance: dict[str, ProvenanceIn],
    crs_status: str,
    crs_code: str | None = None,
    swap_axes: bool = False,
    pages: Sequence[int] = (),
    actor: str = "pipeline",
) -> Borehole:
    """Insert a new borehole at revision 1 with its provenance; emits `borehole.created`.

    Every provenance key must be a valid path that exists in `body`; `ai_value` defaults to the value.
    """
    model = body if isinstance(body, BoreholeBody) else BoreholeBody.model_validate(body)
    data = model.model_dump(mode="json")
    for path in provenance:
        parse_path(path)
        if not path_exists(data, path):
            raise PathError(f"provenance path {path!r} does not exist in the record")
    label = str(data["metadata"]["borehole_id"])
    bh = Borehole(
        uid=new_id("bh"),
        document_id=document.id,
        group_key=group_key,
        label_raw=label,
        label_canonical=canonical_label(label),
        aliases=list(data["metadata"].get("aliases") or []),
        revision=1,
        review_status="unreviewed",
        crs_status=crs_status,
        crs_code=crs_code,
        swap_axes=swap_axes,
        plotted=False,
        pages=sorted(set(pages)),
        record=data,
        lint=[],
        needs_attention=False,
    )
    session.add(bh)
    await session.flush()
    fvs: dict[str, FieldValue] = {}
    for path, prov in provenance.items():
        value = get_value(data, path)
        fv = FieldValue(
            uid=bh.uid,
            path=path,
            value=value,
            raw=prov.raw,
            document_id=prov.document_id or document.id,
            page=prov.page,
            box=prov.box,
            cell=prov.cell,
            method=prov.method,
            confidence=prov.confidence,
            status=prov.status,
            state=prov.state,
            ai_value=prov.ai_value if "ai_value" in prov.model_fields_set else value,
            flag=prov.flag,
            readings=[r.model_dump(mode="json") for r in prov.readings],
        )
        session.add(fv)
        fvs[path] = fv
    await session.flush()
    await _apply_recompute(session, bh, fvs)
    session.add(Revision(uid=bh.uid, revision=1, actor=actor, action="create", changes={}))
    await emit(
        session,
        "borehole.created",
        {"uid": bh.uid, "document_id": bh.document_id, "revision": 1, "plotted": bh.plotted},
        document_id=bh.document_id,
    )
    await session.flush()
    return bh


async def commit_change(
    session: AsyncSession,
    bh: Borehole,
    fvs: dict[str, FieldValue],
    *,
    actor: str,
    action: str,
    changes: dict[str, Any],
) -> None:
    """Recompute, bump the revision, write the revision row and the `borehole.updated` event."""
    await _apply_recompute(session, bh, fvs)
    bh.revision += 1
    session.add(Revision(uid=bh.uid, revision=bh.revision, actor=actor, action=action, changes=changes))
    await emit(
        session, "borehole.updated", {"uid": bh.uid, "revision": bh.revision}, document_id=bh.document_id
    )
    await session.flush()
    await refresh_document_status(session, bh.document_id)


def _snapshot(fv: FieldValue) -> dict[str, Any]:
    return {"value": fv.value, "status": fv.status, "state": fv.state, "method": fv.method, "flag": fv.flag}


async def apply_patch(session: AsyncSession, uid: str, patch: ValuePatch, *, actor: str) -> Borehole:
    bh = await get_borehole_for_update(session, uid)
    if patch.if_revision is not None and patch.if_revision != bh.revision:
        raise ApiError(
            409,
            "revision_conflict",
            f"The record is at revision {bh.revision}, not {patch.if_revision}. Reload and try again.",
        )
    fvs = await load_field_values(session, uid)
    fv = fvs.get(patch.path)
    if fv is None:
        raise ApiError(404, "path_not_found", "This record has no value at that path.")
    before = _snapshot(fv)
    if patch.action == "approve":
        fv.status = "approved"
        fv.flag = None
    elif patch.action == "flag":
        fv.status = "flagged"
        fv.flag = patch.reason
    elif patch.action == "reset":
        fv.status = "unreviewed"
        fv.flag = None
    elif patch.action == "set_state":
        if patch.state is None:
            raise ApiError(
                422,
                "validation_error",
                "set_state needs a state.",
                [{"loc": ["body", "state"], "msg": "Field required for action set_state"}],
            )
        fv.state = patch.state
    elif patch.action == "edit":
        body = copy.deepcopy(bh.record)
        try:
            value = coerce_value(body, patch.path, patch.value)
        except ValueParseError as exc:
            raise ApiError(
                422, "unparseable_value", f"The value cannot be used for {patch.path}: {exc}"
            ) from exc
        set_value(body, patch.path, value)
        bh.record = body
        fv.value = value
        fv.method = "edited"
        if value is not None:
            fv.state = "ok"
    fv.updated_at = _now()
    changes = {"path": patch.path, "action": patch.action, "before": before, "after": _snapshot(fv)}
    await commit_change(session, bh, fvs, actor=actor, action=patch.action, changes=changes)
    return bh


def _lint_paths(bh: Borehole) -> set[str]:
    return {item["path"] for item in (bh.lint or [])}


def is_clean(fv: FieldValue, lint_paths: set[str], clean_confidence: float) -> bool:
    if fv.status != "unreviewed" or fv.state != "ok" or fv.flag is not None or fv.path in lint_paths:
        return False
    if fv.method == "read":
        return True
    return fv.method == "ocr" and fv.confidence is not None and fv.confidence >= clean_confidence


async def approve_clean(session: AsyncSession, document_id: str, *, dry_run: bool, actor: str) -> int:
    threshold = get_settings().clean_confidence
    query = select(Borehole).where(Borehole.document_id == document_id).order_by(Borehole.uid)
    if not dry_run:
        query = query.with_for_update()
    boreholes = (await session.scalars(query)).all()
    total = 0
    for bh in boreholes:
        fvs = await load_field_values(session, bh.uid)
        lint_paths = _lint_paths(bh)
        clean = [fv for fv in fvs.values() if is_clean(fv, lint_paths, threshold)]
        total += len(clean)
        if dry_run or not clean:
            continue
        for fv in clean:
            fv.status = "approved"
            fv.updated_at = _now()
        changes = {"action": "approve_clean", "paths": sorted(fv.path for fv in clean)}
        await commit_change(session, bh, fvs, actor=actor, action="approve_clean", changes=changes)
    return total


async def set_crs(
    session: AsyncSession,
    bh: Borehole,
    *,
    crs_code: str,
    crs_status: str,
    swap_axes: bool,
    actor: str,
    note: str | None = None,
) -> None:
    """Apply a stated or confirmed coordinate system to one borehole (locked by the caller)."""
    fvs = await load_field_values(session, bh.uid)
    before = {"crs_status": bh.crs_status, "crs_code": bh.crs_code, "swap_axes": bh.swap_axes}
    bh.crs_code = crs_code
    bh.crs_status = crs_status
    bh.swap_axes = swap_axes
    body = copy.deepcopy(bh.record)
    body["metadata"].setdefault("coordinates", {})["crs_code"] = crs_code
    bh.record = body
    changes = {
        "action": "crs",
        "before": before,
        "after": {"crs_status": crs_status, "crs_code": crs_code, "swap_axes": swap_axes},
        "note": note,
    }
    await commit_change(session, bh, fvs, actor=actor, action="crs", changes=changes)


async def set_manual_location(
    session: AsyncSession, uid: str, *, lat: float, lon: float, actor: str, note: str | None = None
) -> Borehole:
    """A person placed the borehole on the map: WGS84 point, method edited, system confirmed as EPSG:4326."""
    bh = await get_borehole_for_update(session, uid)
    fvs = await load_field_values(session, uid)
    body = copy.deepcopy(bh.record)
    coords = body["metadata"].setdefault("coordinates", {})
    before = {
        "latitude": coords.get("latitude"),
        "longitude": coords.get("longitude"),
        "crs_status": bh.crs_status,
    }
    for path, value in ((LAT, lat), (LON, lon)):
        set_value(body, path, value)
        fv = fvs.get(path)
        if fv is None:
            fv = FieldValue(
                uid=uid,
                path=path,
                value=value,
                raw=None,
                document_id=bh.document_id,
                page=None,
                box=None,
                cell=None,
                method="edited",
                confidence=None,
                status="approved",
                state="ok",
                ai_value=None,
                flag=None,
                readings=[],
            )
            session.add(fv)
            fvs[path] = fv
        else:
            fv.value, fv.method, fv.status, fv.state, fv.flag = value, "edited", "approved", "ok", None
            fv.updated_at = _now()
    if bh.crs_status not in PLOTTABLE_CRS_STATUS or not bh.crs_code:
        bh.crs_status, bh.crs_code, bh.swap_axes = "confirmed", "EPSG:4326", False
        coords["crs_code"] = "EPSG:4326"
    bh.record = body
    changes = {
        "action": "locate",
        "before": before,
        "after": {"latitude": lat, "longitude": lon},
        "note": note,
    }
    await commit_change(session, bh, fvs, actor=actor, action="locate", changes=changes)
    return bh


async def refresh_document_status(session: AsyncSession, document_id: str) -> None:
    """needs_review <-> done: done when every borehole of the document is approved."""
    doc = await session.get(Document, document_id)
    if doc is None or doc.status not in ("needs_review", "done"):
        return
    statuses = (
        await session.scalars(select(Borehole.review_status).where(Borehole.document_id == document_id))
    ).all()
    new_status = "done" if statuses and all(s == "approved" for s in statuses) else "needs_review"
    if new_status != doc.status:
        doc.status = new_status
        doc.updated_at = _now()
        from app.services.documents import emit_document_updated

        await emit_document_updated(session, doc)


# ----------------------------------------------------------------------------------------------
# Reads: BoreholeRecord responses
# ----------------------------------------------------------------------------------------------


def _provenance_out(fv: FieldValue) -> Provenance:
    return Provenance.model_validate(
        {
            "document_id": fv.document_id,
            "page": fv.page,
            "box": fv.box,
            "raw": fv.raw,
            "cell": fv.cell,
            "method": fv.method,
            "confidence": fv.confidence,
            "status": fv.status,
            "state": fv.state,
            "ai_value": fv.ai_value,
            "flag": fv.flag,
            "readings": fv.readings or [],
        }
    )


async def open_clarification_counts(session: AsyncSession, uids: Sequence[str]) -> dict[str, int]:
    if not uids:
        return {}
    uid_col = func.unnest(Clarification.borehole_uids).label("uid")
    sub = select(uid_col).where(Clarification.status == "open").subquery()
    rows = await session.execute(
        select(sub.c.uid, func.count()).where(sub.c.uid.in_(list(uids))).group_by(sub.c.uid)
    )
    return {str(uid): int(count) for uid, count in rows.all()}


async def to_records(session: AsyncSession, boreholes: Sequence[Borehole]) -> list[BoreholeRecord]:
    """Build contract records for many boreholes with three batched queries."""
    if not boreholes:
        return []
    uids = [bh.uid for bh in boreholes]
    fv_rows = (await session.scalars(select(FieldValue).where(FieldValue.uid.in_(uids)))).all()
    by_uid: dict[str, dict[str, FieldValue]] = {}
    for fv in fv_rows:
        by_uid.setdefault(fv.uid, {})[fv.path] = fv
    doc_ids = {bh.document_id for bh in boreholes}
    names = dict(
        (await session.execute(select(Document.id, Document.file_name).where(Document.id.in_(doc_ids)))).all()
    )
    open_counts = await open_clarification_counts(session, uids)
    records = []
    for bh in boreholes:
        fvs = by_uid.get(bh.uid, {})
        data = dict(bh.record)
        data.update(
            {
                "uid": bh.uid,
                "document_id": bh.document_id,
                "source_file": names.get(bh.document_id, ""),
                "pages": list(bh.pages or []),
                "revision": bh.revision,
                "updated_at": bh.updated_at,
                "review_status": bh.review_status,
                "crs_status": bh.crs_status,
                "plotted": bh.plotted,
                "unplotted_reason": bh.unplotted_reason,
                "provenance": {path: _provenance_out(fv) for path, fv in sorted(fvs.items())},
                "lint": [Lint.model_validate(item) for item in (bh.lint or [])],
                "open_clarifications": open_counts.get(bh.uid, 0),
            }
        )
        records.append(BoreholeRecord.model_validate(data))
    return records


async def to_record(session: AsyncSession, bh: Borehole) -> BoreholeRecord:
    return (await to_records(session, [bh]))[0]
