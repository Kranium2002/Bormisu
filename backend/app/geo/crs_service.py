"""Confirm a coordinate system for a set of boreholes (POST /documents/{id}/crs and crs_confirm answers).

A confirmation also settles the `crs_confirm` questions it answers: an open or skipped question whose
boreholes all have a stated or confirmed system afterwards is resolved as answered, by the confirming
actor, with the confirmed system as its answer. A question that still covers a borehole without one
stays open. The `locate_borehole` questions of boreholes the confirmation puts on the map are settled the
same way: nobody is asked where a borehole was drilled once the map shows it.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.service import resolve_clarification
from app.db.models import Borehole, Clarification
from app.errors import ApiError
from app.geo.plotting import CrsInvalidError, to_wgs84, validate_crs
from app.review.service import UNRESOLVED_CLARIFICATION, set_crs

# How a confirmation reached the server; stored as `via` in the answer of the questions it settles.
VIA_CRS_ENDPOINT = "crs_endpoint"
VIA_CLARIFICATION = "clarification"
# A borehole with one of these systems needs no crs_confirm answer any more.
SETTLED_CRS_STATUS = frozenset({"stated", "confirmed"})


def _has_local_point(bh: Borehole) -> bool:
    coords = (bh.record.get("metadata") or {}).get("coordinates") or {}
    return isinstance(coords.get("local_x"), int | float) and isinstance(coords.get("local_y"), int | float)


async def confirm_crs(
    session: AsyncSession,
    uids: Sequence[str],
    *,
    crs: str,
    swap_axes: bool,
    actor: str,
    note: str | None = None,
    via: str = VIA_CRS_ENDPOINT,
    answering: str | None = None,
) -> int:
    """Confirm `crs` for every listed borehole that has printed coordinates. Returns how many changed.

    Afterwards the crs_confirm questions about these boreholes that are now settled are resolved
    (`settle_crs_questions`); `answering` is the question whose own answer triggered this confirmation
    (its caller resolves it with the person's values). Raises 422 crs_invalid when the code is unknown or
    no point of the set transforms into WGS84 bounds.
    """
    try:
        code = validate_crs(crs)
    except CrsInvalidError as exc:
        raise ApiError(422, "crs_invalid", f"Unknown coordinate system {crs!r}.") from exc
    if not uids:
        return 0
    rows = (
        await session.scalars(
            select(Borehole).where(Borehole.uid.in_(list(uids))).order_by(Borehole.uid).with_for_update()
        )
    ).all()
    targets = [bh for bh in rows if _has_local_point(bh)]
    if not targets:
        return 0
    transformed = 0
    for bh in targets:
        coords = bh.record["metadata"]["coordinates"]
        if (
            to_wgs84(code, float(coords["local_x"]), float(coords["local_y"]), swap_axes=swap_axes)
            is not None
        ):
            transformed += 1
    if transformed == 0:
        raise ApiError(422, "crs_invalid", f"No coordinate of these boreholes transforms with {code}.")
    for bh in targets:
        await set_crs(
            session, bh, crs_code=code, crs_status="confirmed", swap_axes=swap_axes, actor=actor, note=note
        )
    answer: dict[str, Any] = {"crs": code, "swap_axes": swap_axes, "via": via}
    if answering is not None:
        answer["clarification_id"] = answering
    await settle_crs_questions(
        session, [bh.uid for bh in targets], answer=answer, actor=actor, exclude=answering
    )
    await settle_locate_questions(session, [bh.uid for bh in targets], answer=answer, actor=actor)
    return len(targets)


async def settle_crs_questions(
    session: AsyncSession,
    uids: Sequence[str],
    *,
    answer: dict[str, Any],
    actor: str,
    exclude: str | None = None,
) -> list[str]:
    """Resolve the open or skipped crs_confirm questions about `uids` whose boreholes are all settled.

    A borehole that no longer exists does not hold a question open (nothing is left to confirm). A
    question locked by another transaction (being answered or skipped right now) is left to it. Returns
    the ids of the resolved questions.
    """
    if not uids:
        return []
    questions = (
        await session.scalars(
            select(Clarification)
            .where(
                Clarification.kind == "crs_confirm",
                Clarification.status.in_(UNRESOLVED_CLARIFICATION),
                Clarification.borehole_uids.overlap(list(uids)),
            )
            .order_by(Clarification.created_at, Clarification.id)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
    ).all()
    questions = [q for q in questions if q.id != exclude]
    if not questions:
        return []
    covered = sorted({uid for q in questions for uid in (q.borehole_uids or [])})
    status = dict(
        (
            await session.execute(select(Borehole.uid, Borehole.crs_status).where(Borehole.uid.in_(covered)))
        ).all()
    )
    resolved: list[str] = []
    for question in questions:
        if any(
            uid in status and status[uid] not in SETTLED_CRS_STATUS for uid in question.borehole_uids or []
        ):
            continue
        await resolve_clarification(
            session, question, status="answered", answer=dict(answer), answered_by=actor
        )
        resolved.append(question.id)
    return resolved


async def settle_locate_questions(
    session: AsyncSession, uids: Sequence[str], *, answer: dict[str, Any], actor: str
) -> list[str]:
    """Resolve the open or skipped locate_borehole questions about `uids` whose boreholes are all on the map.

    A question asked before the borehole's system was confirmed (by the project's answer, or another
    question) no longer needs a person's point. A borehole that no longer exists does not hold a question
    open; a question locked by another transaction is left to it. Returns the ids of the resolved questions.
    """
    if not uids:
        return []
    questions = (
        await session.scalars(
            select(Clarification)
            .where(
                Clarification.kind == "locate_borehole",
                Clarification.status.in_(UNRESOLVED_CLARIFICATION),
                Clarification.borehole_uids.overlap(list(uids)),
            )
            .order_by(Clarification.created_at, Clarification.id)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
    ).all()
    if not questions:
        return []
    covered = sorted({uid for q in questions for uid in (q.borehole_uids or [])})
    plotted = dict(
        (await session.execute(select(Borehole.uid, Borehole.plotted).where(Borehole.uid.in_(covered)))).all()
    )
    resolved: list[str] = []
    for question in questions:
        if any(uid in plotted and not plotted[uid] for uid in question.borehole_uids or []):
            continue
        await resolve_clarification(
            session, question, status="answered", answer={**answer, "settled": "placed"}, answered_by=actor
        )
        resolved.append(question.id)
    return resolved
