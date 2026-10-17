"""Answering a clarification: validate values against its form, then apply them via the review service.

Every applied answer becomes a revision with the answering person as actor (the signed-in user's name,
passed in by the route; app.auth.deps.actor_name).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.checks import apply_conflict_answer, apply_datum_answer
from app.clarify.duplicates import apply_duplicate_answer
from app.clarify.service import resolve_clarification
from app.db.models import Borehole, Clarification
from app.errors import ApiError
from app.geo.crs_service import VIA_CLARIFICATION, confirm_crs
from app.review.service import apply_patch, set_manual_location
from app.schemas.boreholes import ValuePatch
from app.schemas.common import review_actor


def _invalid(message: str, field: str | None = None) -> ApiError:
    loc: list[str | int] = ["body", "values"]
    if field:
        loc.append(field)
    return ApiError(422, "answer_invalid", message, [{"loc": loc, "msg": message}])


def validate_answer(fields: list[dict[str, Any]], values: dict[str, Any]) -> dict[str, Any]:
    """Check required fields, option membership and simple widget types. Returns the accepted values."""
    by_name = {f["name"]: f for f in fields}
    unknown = sorted(set(values) - set(by_name))
    if unknown:
        raise _invalid(f"Unknown field(s): {', '.join(unknown)}.", unknown[0])
    accepted: dict[str, Any] = {}
    for name, spec in by_name.items():
        value = values.get(name)
        if value is None or value == "":
            if spec.get("required"):
                raise _invalid(f"{spec.get('label') or name} is required.", name)
            continue
        widget = spec.get("widget")
        options = [o.get("value") for o in spec.get("options") or []]
        if widget in ("select", "choose_reading") and options and value not in options:
            raise _invalid(f"{spec.get('label') or name}: choose one of the offered options.", name)
        if widget == "boolean" and not isinstance(value, bool):
            raise _invalid(f"{spec.get('label') or name} must be true or false.", name)
        if widget == "crs_picker" and not isinstance(value, str):
            raise _invalid(f"{spec.get('label') or name} must be a coordinate system code.", name)
        if widget == "map_point" and not (
            isinstance(value, dict)
            and isinstance(value.get("lat"), int | float)
            and isinstance(value.get("lon"), int | float)
            and -90 <= value["lat"] <= 90
            and -180 <= value["lon"] <= 180
        ):
            raise _invalid(f"{spec.get('label') or name} must be a point {{lat, lon}} in WGS84.", name)
        if widget == "number_unit":
            number = value.get("value") if isinstance(value, dict) else value
            if isinstance(number, bool) or not isinstance(number, int | float):
                raise _invalid(f"{spec.get('label') or name} must be a number.", name)
            unit_options = spec.get("unit_options") or []
            if isinstance(value, dict) and unit_options and value.get("unit") not in unit_options:
                raise _invalid(f"{spec.get('label') or name}: choose one of the offered units.", name)
        if widget == "page_range" and not (isinstance(value, dict | list | str)):
            raise _invalid(f"{spec.get('label') or name} must be a page range.", name)
        accepted[name] = value
    return accepted


async def _apply(session: AsyncSession, row: Clarification, values: dict[str, Any], actor: str) -> None:
    """Kind-specific effects. Kinds without a direct record change only store the answer."""
    if row.kind == "crs_confirm" and isinstance(values.get("crs"), str):
        # Other questions this confirmation settles are resolved with it; this one gets the person's values.
        await confirm_crs(
            session,
            list(row.borehole_uids),
            crs=values["crs"],
            swap_axes=bool(values.get("swap_axes", False)),
            actor=actor,
            note=f"clarification {row.id}",
            via=VIA_CLARIFICATION,
            answering=row.id,
        )
        return
    if row.kind == "choose_reading" and row.path and row.borehole_uids:
        reading_field = next((f for f in row.fields if f.get("widget") == "choose_reading"), None)
        if reading_field is None or reading_field["name"] not in values:
            return
        chosen = values[reading_field["name"]]
        for uid in row.borehole_uids:
            await apply_patch(
                session, uid, ValuePatch(path=row.path, action="edit", value=chosen), actor=actor
            )
            await apply_patch(session, uid, ValuePatch(path=row.path, action="approve"), actor=actor)
        return
    if row.kind == "locate_borehole" and row.borehole_uids:
        point = next((v for v in values.values() if isinstance(v, dict) and "lat" in v and "lon" in v), None)
        if point is None:
            return
        source_note = values.get("source_note")
        note = f"clarification {row.id}" + (
            f": {source_note.strip()[:200]}" if isinstance(source_note, str) and source_note.strip() else ""
        )
        for uid in row.borehole_uids:
            if await session.get(Borehole, uid) is None:
                continue
            await set_manual_location(
                session,
                uid,
                lat=float(point["lat"]),
                lon=float(point["lon"]),
                actor=actor,
                note=note,
            )
        return
    if row.kind == "duplicate":
        await apply_duplicate_answer(session, row, values, actor)
        return
    if row.kind == "datum_convention":
        await apply_datum_answer(session, row, values, actor)
        return
    if row.kind == "conflicting_sources":
        await apply_conflict_answer(session, row, values, actor)


async def answer_clarification(
    session: AsyncSession, clarification_id: str, values: dict[str, Any], actor: str
) -> Clarification:
    """Validate and apply an answer; `actor` (who answers) is stored as answered_by and revision actor."""
    row = await session.scalar(
        select(Clarification).where(Clarification.id == clarification_id).with_for_update()
    )
    if row is None:
        raise ApiError(404, "clarification_not_found", "Clarification not found.")
    if row.status == "answered":
        raise ApiError(409, "already_resolved", "This question has already been answered.")
    accepted = validate_answer(list(row.fields or []), values)
    who = review_actor(actor)
    await _apply(session, row, accepted, who)
    await resolve_clarification(session, row, status="answered", answer=accepted, answered_by=who)
    return row


async def skip_clarification(session: AsyncSession, clarification_id: str) -> Clarification:
    row = await session.scalar(
        select(Clarification).where(Clarification.id == clarification_id).with_for_update()
    )
    if row is None:
        raise ApiError(404, "clarification_not_found", "Clarification not found.")
    if row.status == "answered":
        raise ApiError(409, "already_resolved", "This question has already been answered.")
    if row.status != "skipped":
        await resolve_clarification(session, row, status="skipped")
    return row
