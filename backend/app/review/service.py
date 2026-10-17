"""The one service that changes borehole records.

Every change (pipeline creation, review PATCH, approve-clean, CRS confirmation, clarification answers)
goes through here: it updates `field_values`, recomputes the record body and the query columns, writes
a `revisions` row, increments `revision` and writes a `borehole.*` event — all in the caller's
transaction. Callers commit.

Lint that compares the boreholes of one document (app.validate.document: positions far from the
document's cluster, identical coordinates, confirmed duplicates) is kept in `boreholes.document_lint`,
merged into `lint` on every recompute and refreshed for the whole document whenever a value of one of its
boreholes changes and when the document is finalised. A borehole whose document lint changes because of
another borehole gets a revision of its own (action `checks`).

An edit of a layer's `spt_raw` (review PATCH or clarification answer) parses the text again and updates the
layer's derived SPT values in the same revision (`rederive_spt`).
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
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
from app.geo.crs_candidates import crs_label
from app.geo.plotting import PLOTTABLE_CRS_STATUS, placement, to_wgs84
from app.ids import new_id
from app.normalize.spt import parse_spt
from app.review.paths import (
    PathError,
    ValueParseError,
    coerce_value,
    get_value,
    parse_path,
    path_exists,
    set_value,
    uncovered_paths,
)
from app.schemas.boreholes import (
    BoreholeBody,
    BoreholeRecord,
    Lint,
    Provenance,
    ProvenanceIn,
    ValuePatch,
)
from app.validate.document import Member, document_lint
from app.validate.rules import lint_body, unplot_rules

LAT = "metadata.coordinates.latitude"
LON = "metadata.coordinates.longitude"
LOCAL_X = "metadata.coordinates.local_x"
LOCAL_Y = "metadata.coordinates.local_y"
X_RAW = "metadata.coordinates.x_raw"
ROCK_HEAD = "rock_head_m"
CRS_CODE = "metadata.coordinates.crs_code"
CRS_LABEL = "metadata.coordinates.crs_label"
# Values the server writes itself; they are never edited through PATCH.
SERVER_MANAGED_PATHS = frozenset({CRS_CODE, CRS_LABEL})
# Patch actions that never change a value (so the lint across the document cannot change either).
REVIEW_ONLY_ACTIONS = frozenset({"approve", "flag", "reset", "set_state"})
# Depth values a sign convention applies to (metadata.borehole_depth_m is never stored negative).
_DEPTH_FIELDS = {
    "stratigraphy": ("depth_from_m", "depth_to_m", "spt_depth_m"),
    "groundwater": ("depth_m",),
    "samples": ("depth_from_m", "depth_to_m"),
}
_STRATIGRAPHY_PATH = re.compile(r"^stratigraphy\[(\d+)\]\.(.+)$")
_SPT_RAW_PATH = re.compile(r"^stratigraphy\[(\d+)\]\.spt_raw$")

_CANON_STRIP = re.compile(r"[\s\-_]+")
_LEADING_ZEROS = re.compile(r"(?<![0-9])0+(?=[0-9])")


def canonical_label(label: str) -> str:
    """Upper case without spaces, dashes and underscores; numeric parts without leading zeros."""
    text = _CANON_STRIP.sub("", label.strip().upper())
    return _LEADING_ZEROS.sub("", text)


def _now() -> datetime:
    return datetime.now(UTC)


# Clarifications that still mark their records: open ones and those a person skipped for later.
UNRESOLVED_CLARIFICATION = ("open", "skipped")

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
                coords[path.rsplit(".", 1)[1]] = None
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
    if existing is not None:
        body["rock_head_m"] = None
        drop.add(ROCK_HEAD)


def _crs_label(coords: dict[str, Any]) -> None:
    """crs_label is the readable name of crs_code, whenever crs_code is set (stated or confirmed)."""
    code = coords.get("crs_code")
    coords["crs_label"] = crs_label(code) if isinstance(code, str) and code else None


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
    _crs_label(body["metadata"]["coordinates"])
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
    lint = lint_body(body) + [dict(item) for item in (bh.document_lint or [])]
    unplot = unplot_rules()
    has_lint_error = any(item["severity"] == "error" and item["rule"] in unplot for item in lint)
    person_placed = all(fvs.get(p) is not None and fvs[p].method == "edited" for p in (LAT, LON))
    place = placement(coords, bh.crs_status, implausible=has_lint_error, person_placed=person_placed)

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


def companion_provenance(
    data: dict[str, Any], provenance: dict[str, ProvenanceIn]
) -> dict[str, ProvenanceIn]:
    """Provenance for a layer's English rendering: the box of its printed description, method guessed."""
    extra: dict[str, ProvenanceIn] = {}
    for i, layer in enumerate(data.get("stratigraphy") or []):
        path = f"stratigraphy[{i}].english_lithology"
        source = provenance.get(f"stratigraphy[{i}].original_description")
        if layer.get("english_lithology") is None or path in provenance or source is None:
            continue
        extra[path] = ProvenanceIn(
            document_id=source.document_id,
            page=source.page,
            box=source.box,
            cell=source.cell,
            raw=None,
            method="guessed",
            confidence=source.confidence,
        )
    return extra


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
    notes: Sequence[str] = (),
) -> Borehole:
    """Insert a new borehole at revision 1 with its provenance; emits `borehole.created`. `notes` (how the
    pipeline read what a person might wonder about) are kept in revision 1.

    Every provenance key must be a valid path that exists in `body`, and every non-null value needs a
    provenance entry (except values the server computes); `ai_value` defaults to the value.
    """
    model = body if isinstance(body, BoreholeBody) else BoreholeBody.model_validate(body)
    data = model.model_dump(mode="json")
    for path in provenance:
        parse_path(path)
        if not path_exists(data, path):
            raise PathError(f"provenance path {path!r} does not exist in the record")
    provenance = {**provenance, **companion_provenance(data, provenance)}
    uncovered = uncovered_paths(data, provenance)
    if uncovered:
        raise PathError(f"values without provenance: {', '.join(uncovered[:10])}")
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
        document_lint=[],
        duplicate_of=None,
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
    changes: dict[str, Any] = {"notes": list(notes)} if notes else {}
    session.add(Revision(uid=bh.uid, revision=1, actor=actor, action="create", changes=changes))
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
    document_checks: bool = True,
) -> None:
    """Recompute, bump the revision, write the revision row and the `borehole.updated` event.

    `document_checks` also refreshes the lint across the boreholes of the document; callers whose change
    cannot touch a value or a label (approve, flag, reset, set_state, aliases) leave it out.
    """
    await _apply_recompute(session, bh, fvs)
    if document_checks:
        own = await _document_checks(session, bh.document_id, actor=actor, current=bh)
        if own is not None and own != list(bh.document_lint or []):
            bh.document_lint = own
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
    return await apply_patches(session, uid, [patch], actor=actor)


async def apply_patches(
    session: AsyncSession,
    uid: str,
    patches: Sequence[ValuePatch],
    *,
    actor: str,
    action: str | None = None,
    note: str | None = None,
) -> Borehole:
    """Apply review patches to one record as one revision (a single patch keeps its own action name)."""
    bh = await get_borehole_for_update(session, uid)
    for patch in patches:
        if patch.if_revision is not None and patch.if_revision != bh.revision:
            raise ApiError(
                409,
                "revision_conflict",
                f"The record is at revision {bh.revision}, not {patch.if_revision}. Reload and try again.",
            )
    fvs = await load_field_values(session, uid)
    applied: list[dict[str, Any]] = []
    for patch in patches:
        entry = _patch_one(bh, fvs, patch)
        index = spt_raw_index(patch.path) if patch.action == "edit" else None
        if index is not None and entry["before"]["value"] != entry["after"]["value"]:
            body = copy.deepcopy(bh.record)
            entry["derived"] = await rederive_spt(session, bh, body, fvs, index)
            bh.record = body
        applied.append(entry)
    name: str
    changes: dict[str, Any]
    if len(applied) == 1 and action is None and note is None:
        name, changes = patches[0].action, applied[0]
    else:
        name = action or "batch"
        changes = {"action": name, "patches": applied, "note": note}
    checks = any(patch.action not in REVIEW_ONLY_ACTIONS for patch in patches)
    await commit_change(session, bh, fvs, actor=actor, action=name, changes=changes, document_checks=checks)
    return bh


def _patch_one(bh: Borehole, fvs: dict[str, FieldValue], patch: ValuePatch) -> dict[str, Any]:
    """Apply one patch to the loaded record and its provenance; returns the revision's change entry."""
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
        if patch.path in SERVER_MANAGED_PATHS:
            raise ApiError(
                422,
                "unparseable_value",
                f"{patch.path} is set by the server; confirm a system with POST /documents/{{id}}/crs.",
            )
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
    return {"path": patch.path, "action": patch.action, "before": before, "after": _snapshot(fv)}


def spt_raw_index(path: str) -> int | None:
    """The layer index of a `stratigraphy[i].spt_raw` path; None for every other path."""
    match = _SPT_RAW_PATH.match(path)
    return int(match.group(1)) if match else None


def spt_values(raw: Any) -> tuple[dict[str, Any], str | None]:
    """The derived SPT values of a layer as app.normalize.spt reads `raw` on its own, and why any is null.

    spt_raw holds one printed text; a separately printed N column or increment note is not stored, so a
    re-parse sees the text alone (write the unit of a refusal penetration into it: "50/120mm").
    """
    result = parse_spt(raw if isinstance(raw, str) else None)
    values = {
        "spt_refusal": result.refusal,
        "spt_n_value": result.n_value,
        "spt_increments": list(result.increments) if result.increments is not None else None,
        "spt_increment_mm": result.increment_mm,
        "spt_penetration_cm": result.penetration_cm,
    }
    return values, result.reason


async def _drop_entry(session: AsyncSession, fvs: dict[str, FieldValue], path: str) -> None:
    fv = fvs.pop(path)
    if fv in session.new:
        session.expunge(fv)
    else:
        await session.delete(fv)


async def rederive_spt(
    session: AsyncSession, bh: Borehole, body: dict[str, Any], fvs: dict[str, FieldValue], index: int
) -> dict[str, Any]:
    """The edited spt_raw of layer `index` (already in `body`) is parsed again; the layer's derived SPT
    values follow it in `body` and `fvs`, in the caller's revision. Returns that revision's record of it.

    Every value the text yields gets an entry with method `derived` and the page and box of spt_raw; a value
    that changes is unreviewed again and loses its flag. A value the text no longer yields is removed with
    its entry, except spt_n_value: null on a refusal (entry created or kept, method derived) and null with
    its entry kept when the text gives no N, so N stays editable. An spt_n_value a person edited stands
    unless the text is a refusal.
    """
    layer = body["stratigraphy"][index]
    source = fvs.get(f"stratigraphy[{index}].spt_raw")
    values, reason = spt_values(layer.get("spt_raw"))
    refusal = values["spt_refusal"] is True
    changed: list[dict[str, Any]] = []
    for name, value in values.items():
        path = f"stratigraphy[{index}].{name}"
        fv = fvs.get(path)
        if name == "spt_n_value" and fv is not None and fv.method == "edited" and not refusal:
            continue
        before = _snapshot(fv) if fv is not None else None
        layer[name] = value
        keep_null = name == "spt_n_value" and (refusal or fv is not None)
        if value is None and not keep_null:
            if fv is not None:
                await _drop_entry(session, fvs, path)
                changed.append({"path": path, "before": before, "after": None})
            continue
        if fv is None:
            fv = FieldValue(
                uid=bh.uid,
                path=path,
                value=value,
                raw=None,
                document_id=(source.document_id if source else None) or bh.document_id,
                page=source.page if source else None,
                box=source.box if source else None,
                cell=source.cell if source else None,
                method="derived",
                confidence=None,
                status="unreviewed",
                state="ok",
                ai_value=None,
                flag=None,
                readings=[],
            )
            session.add(fv)
            fvs[path] = fv
        else:
            if fv.value != value:
                fv.value, fv.status, fv.flag = value, "unreviewed", None
            fv.method, fv.state, fv.raw, fv.confidence = "derived", "ok", None, None
            if source is not None:
                fv.document_id, fv.page, fv.box, fv.cell = (
                    source.document_id,
                    source.page,
                    source.box,
                    source.cell,
                )
            fv.updated_at = _now()
        changed.append({"path": path, "before": before, "after": _snapshot(fv)})
    await session.flush()
    return {"values": changed, "reason": reason}


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
        await commit_change(
            session, bh, fvs, actor=actor, action="approve_clean", changes=changes, document_checks=False
        )
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
    coords = body["metadata"].setdefault("coordinates", {})
    coords["crs_code"] = crs_code
    _crs_label(coords)
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
    bh.record = body
    changes = {
        "action": "locate",
        "before": before,
        "after": {"latitude": lat, "longitude": lon},
        "note": note,
    }
    await commit_change(session, bh, fvs, actor=actor, action="locate", changes=changes)
    return bh


@dataclass(frozen=True)
class SourceRef:
    """Where a value chosen by a person is printed (a clarification option's evidence)."""

    document_id: str | None
    page: int | None
    box: list[float] | None
    raw: str | None


async def set_values(
    session: AsyncSession,
    uid: str,
    values: Mapping[str, Any],
    *,
    actor: str,
    action: str,
    note: str | None = None,
    sources: Mapping[str, SourceRef] | None = None,
) -> Borehole:
    """A person decided these values (clarification answers): one revision, every value approved.

    A value without provenance gets an entry with method `edited`. With a source, the entry points at the
    page and box the person chose; a changed value is `edited`, an unchanged one keeps its method.
    """
    bh = await get_borehole_for_update(session, uid)
    fvs = await load_field_values(session, uid)
    body = copy.deepcopy(bh.record)
    applied: list[dict[str, Any]] = []
    for path, raw_value in values.items():
        if path in SERVER_MANAGED_PATHS or not path_exists(body, path):
            raise ApiError(422, "unparseable_value", f"{path} cannot be set on this record.")
        try:
            value = coerce_value(body, path, raw_value)
        except ValueParseError as exc:
            raise ApiError(422, "unparseable_value", f"The value cannot be used for {path}: {exc}") from exc
        previous = get_value(body, path)
        set_value(body, path, value)
        source = (sources or {}).get(path)
        fv = fvs.get(path)
        before = _snapshot(fv) if fv is not None else None
        if fv is None:
            fv = FieldValue(
                uid=uid,
                path=path,
                value=value,
                raw=source.raw if source else None,
                document_id=(source.document_id if source else None) or bh.document_id,
                page=source.page if source else None,
                box=source.box if source else None,
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
            if fv.value != value:
                fv.value, fv.method = value, "edited"
            if source is not None:
                fv.document_id = source.document_id or fv.document_id
                fv.page, fv.box, fv.raw = source.page, source.box, source.raw
            fv.status, fv.state, fv.flag = "approved", "ok", None
            fv.updated_at = _now()
        change: dict[str, Any] = {"path": path, "before": before, "after": _snapshot(fv)}
        index = spt_raw_index(path)
        if index is not None and previous != value:
            change["derived"] = await rederive_spt(session, bh, body, fvs, index)
        applied.append(change)
    bh.record = body
    changes = {"action": action, "values": applied, "note": note}
    await commit_change(session, bh, fvs, actor=actor, action=action, changes=changes)
    return bh


async def add_aliases(
    session: AsyncSession, uid: str, aliases: Iterable[str], *, actor: str, note: str | None = None
) -> list[str]:
    """Add labels as printed elsewhere to metadata.aliases (server-managed, no provenance). Returns the new
    ones; nothing is written when every label is already the label or an alias."""
    bh = await get_borehole_for_update(session, uid)
    body = copy.deepcopy(bh.record)
    meta = body["metadata"]
    current = list(meta.get("aliases") or [])
    known = {str(meta.get("borehole_id") or "").strip(), *(a.strip() for a in current)}
    added: list[str] = []
    for alias in aliases:
        text = (alias or "").strip()
        if text and text not in known:
            known.add(text)
            added.append(text)
    if not added:
        return []
    meta["aliases"] = [*current, *added]
    bh.record = body
    fvs = await load_field_values(session, uid)
    changes = {"action": "aliases", "added": added, "note": note}
    await commit_change(
        session, bh, fvs, actor=actor, action="aliases", changes=changes, document_checks=False
    )
    return added


async def mark_duplicate(
    session: AsyncSession, uid: str, original_uid: str, *, actor: str, note: str | None = None
) -> bool:
    """A person confirmed that `uid` repeats `original_uid` (an earlier document's borehole)."""
    bh = await get_borehole_for_update(session, uid)
    if bh.duplicate_of == original_uid:
        return False
    before = bh.duplicate_of
    bh.duplicate_of = original_uid
    fvs = await load_field_values(session, uid)
    changes = {"action": "duplicate", "before": before, "after": original_uid, "note": note}
    await commit_change(session, bh, fvs, actor=actor, action="duplicate", changes=changes)
    return True


def _depth_paths(body: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    for section, fields in _DEPTH_FIELDS.items():
        for i, _ in enumerate(body.get(section) or []):
            paths.extend(f"{section}[{i}].{name}" for name in fields)
    return paths


def depth_paths_with_provenance(bh: Borehole, fvs: Mapping[str, FieldValue]) -> list[str]:
    """Layer, SPT, groundwater and sample depth paths of the record that have a provenance entry."""
    return [path for path in _depth_paths(bh.record) if path in fvs]


async def negate_negative_depths(
    session: AsyncSession, uid: str, *, actor: str, note: str | None = None
) -> list[str]:
    """Negative values denote depth (a person said so): store them as positive depths, method `edited`.

    The layers are then put back in depth order; their provenance moves with them. Returns the changed
    paths (empty when nothing was negative; nothing is written then).
    """
    bh = await get_borehole_for_update(session, uid)
    fvs = await load_field_values(session, uid)
    body = copy.deepcopy(bh.record)
    changed: list[dict[str, Any]] = []
    for path in _depth_paths(body):
        value = get_value(body, path)
        if isinstance(value, bool) or not isinstance(value, int | float) or value >= 0:
            continue
        set_value(body, path, -value)
        fv = fvs.get(path)
        if fv is not None:
            before = _snapshot(fv)
            fv.value, fv.method, fv.state = -value, "edited", "ok"
            fv.updated_at = _now()
            changed.append({"path": path, "before": before, "after": _snapshot(fv)})
        else:
            changed.append({"path": path, "before": {"value": value}, "after": {"value": -value}})
    if not changed:
        return []
    layers = list(body.get("stratigraphy") or [])
    order = sorted(
        range(len(layers)),
        key=lambda k: (layers[k].get("depth_from_m") or 0.0, layers[k].get("depth_to_m") or 0.0, k),
    )
    reordered = order != list(range(len(layers)))
    if reordered:
        body["stratigraphy"] = [layers[k] for k in order]
        await _move_layer_provenance(session, fvs, {old: new for new, old in enumerate(order)})
    bh.record = body
    changes = {"action": "datum", "values": changed, "reordered": reordered, "note": note}
    await commit_change(session, bh, fvs, actor=actor, action="datum", changes=changes)
    return [entry["path"] for entry in changed]


async def _move_layer_provenance(
    session: AsyncSession, fvs: dict[str, FieldValue], new_index: Mapping[int, int]
) -> None:
    """Rename `stratigraphy[i].*` provenance rows after the layers were reordered (old index -> new)."""
    moves: dict[str, str] = {}
    for path in fvs:
        match = _STRATIGRAPHY_PATH.match(path)
        if match is None:
            continue
        old = int(match.group(1))
        new = new_index.get(old, old)
        if new != old:
            moves[path] = f"stratigraphy[{new}].{match.group(2)}"
    if not moves:
        return
    moved = {path: fvs.pop(path) for path in moves}
    for fv in moved.values():
        await session.delete(fv)
    await session.flush()
    for old_path, fv in moved.items():
        copy_fv = FieldValue(
            uid=fv.uid,
            path=moves[old_path],
            value=fv.value,
            raw=fv.raw,
            document_id=fv.document_id,
            page=fv.page,
            box=fv.box,
            cell=fv.cell,
            method=fv.method,
            confidence=fv.confidence,
            status=fv.status,
            state=fv.state,
            ai_value=fv.ai_value,
            flag=fv.flag,
            readings=fv.readings,
            updated_at=_now(),
        )
        session.add(copy_fv)
        fvs[copy_fv.path] = copy_fv
    await session.flush()


# ----------------------------------------------------------------------------------------------
# Lint across the boreholes of one document
# ----------------------------------------------------------------------------------------------


async def _document_members(session: AsyncSession, document_id: str) -> tuple[list[Member], dict[str, Any]]:
    """What app.validate.document needs about every borehole of the document, and their stored lint."""
    coords_col = Borehole.record["metadata"]["coordinates"]
    rows = (
        await session.execute(
            select(
                Borehole.uid,
                Borehole.label_raw,
                Borehole.label_canonical,
                coords_col,
                Borehole.duplicate_of,
                Borehole.document_lint,
            )
            .where(Borehole.document_id == document_id)
            .order_by(Borehole.uid)
        )
    ).all()
    uids = [row[0] for row in rows]
    placed: set[str] = set()
    if uids:
        placed = set(
            (
                await session.scalars(
                    select(FieldValue.uid)
                    .where(
                        FieldValue.uid.in_(uids),
                        FieldValue.path.in_((LAT, LON)),
                        FieldValue.method == "edited",
                    )
                    .group_by(FieldValue.uid)
                    .having(func.count() == 2)
                )
            ).all()
        )
    originals = {row[4] for row in rows if row[4]}
    names: dict[str, tuple[str, str]] = {}
    if originals:
        found = await session.execute(
            select(Borehole.uid, Borehole.label_raw, Document.file_name)
            .join(Document, Document.id == Borehole.document_id)
            .where(Borehole.uid.in_(originals))
        )
        names = {str(uid): (str(label), str(name)) for uid, label, name in found.all()}

    def number(value: Any) -> float | None:
        return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None

    members: list[Member] = []
    stored: dict[str, Any] = {}
    for uid, label, canonical, coords, duplicate_of, lint in rows:
        point = coords if isinstance(coords, dict) else {}
        members.append(
            Member(
                uid=uid,
                label=label,
                label_canonical=canonical,
                latitude=number(point.get("latitude")),
                longitude=number(point.get("longitude")),
                local_x=number(point.get("local_x")),
                local_y=number(point.get("local_y")),
                position_path=X_RAW if point.get("x_raw") else LAT,
                person_placed=uid in placed,
                duplicate_of=names.get(duplicate_of) if duplicate_of else None,
            )
        )
        stored[uid] = list(lint or [])
    return members, stored


async def _document_checks(
    session: AsyncSession, document_id: str, *, actor: str, current: Borehole | None
) -> list[dict[str, Any]] | None:
    """Recompute the lint across the document; returns the new document lint of `current`.

    Every other borehole whose document lint changes is recomputed with a revision of its own. Passes of
    one document are serialised by its row lock. A borehole locked by another transaction is skipped
    (SKIP LOCKED, so this never waits and never deadlocks): a value change in that transaction runs this
    pass again once it holds the document lock; otherwise the document's next pass catches up.
    """
    await session.flush()
    await session.execute(
        select(Document.id).where(Document.id == document_id).with_for_update(key_share=True)
    )
    members, stored = await _document_members(session, document_id)
    computed = document_lint(members)
    own: list[dict[str, Any]] | None = None
    for uid in sorted(computed):
        items = computed[uid]
        if current is not None and uid == current.uid:
            own = items
            continue
        if items == stored.get(uid, []):
            continue
        other = await session.scalar(
            select(Borehole)
            .where(Borehole.uid == uid)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
        if other is None:
            continue
        before = [item["rule"] for item in (other.document_lint or [])]
        other.document_lint = items
        fvs = await load_field_values(session, uid)
        await _apply_recompute(session, other, fvs)
        other.revision += 1
        changes = {"action": "checks", "before": before, "after": [item["rule"] for item in items]}
        session.add(Revision(uid=uid, revision=other.revision, actor=actor, action="checks", changes=changes))
        await emit(
            session, "borehole.updated", {"uid": uid, "revision": other.revision}, document_id=document_id
        )
    await session.flush()
    return own


async def refresh_document_checks(
    session: AsyncSession, document_id: str, *, actor: str = "pipeline"
) -> None:
    """Recompute the lint across every borehole of a document (finalisation; callers commit)."""
    await _document_checks(session, document_id, actor=actor, current=None)


async def refresh_document_status(session: AsyncSession, document_id: str) -> None:
    """needs_review <-> done: done when every borehole of the document is approved."""
    doc = await session.scalar(
        select(Document)
        .where(Document.id == document_id)
        .with_for_update(key_share=True)  # NO KEY UPDATE: does not conflict with FK share locks
        .execution_options(populate_existing=True)
    )
    if doc is None or doc.status not in ("needs_review", "done"):
        return
    statuses = (
        await session.scalars(select(Borehole.review_status).where(Borehole.document_id == document_id))
    ).all()
    # done when every borehole is approved, and when there is nothing to review (no borehole logs found)
    new_status = "done" if all(s == "approved" for s in statuses) else "needs_review"
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
    sub = select(uid_col).where(Clarification.status.in_(UNRESOLVED_CLARIFICATION)).subquery()
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
        coords = (data.get("metadata") or {}).get("coordinates")
        if isinstance(coords, dict) and coords.get("crs_code") and not coords.get("crs_label"):
            # Records stored before contract 1.1.0 get their label at read time.
            coords = {**coords}
            _crs_label(coords)
            data["metadata"] = {**data["metadata"], "coordinates": coords}
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
