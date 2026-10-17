"""Confirm a coordinate system for a set of boreholes (POST /documents/{id}/crs and crs_confirm answers)."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Borehole
from app.errors import ApiError
from app.geo.plotting import CrsInvalidError, to_wgs84, validate_crs
from app.review.service import set_crs


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
) -> int:
    """Confirm `crs` for every listed borehole that has printed coordinates. Returns how many changed.

    Raises 422 crs_invalid when the code is unknown or no point of the set transforms into WGS84 bounds.
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
    return len(targets)
