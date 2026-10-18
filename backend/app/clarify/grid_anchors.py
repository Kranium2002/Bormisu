"""A site grid placed from the document's own boreholes, without a question (BACKEND.md 7.9).

When two or more boreholes of a document are placed by a map system they print (stated or confirmed) and the
document's tables also print them on a local site grid (app.pipeline.positions: `Adjusted.grid`), they anchor
that grid: the similarity fit of app.clarify.grid places every other borehole of the grid. The guards of a
person's answer apply (scale within MAX_SCALE_ERROR, anchors at different grid points), and further anchors
must agree with the fit from the first two. Anchors too close together for the boreholes to be placed are not
used. Each placed point is `derived`, flagged for review, with a revision note naming the anchors, the fitted
scale and rotation. One anchor is never enough (the rotation is unknown): the grid stays a question.
"""

from __future__ import annotations

import cmath
import logging
import math
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.checks import local_grid_of
from app.clarify.grid import (
    MAX_SCALE_ERROR,
    X_NORTH,
    _metric,
    _number,
    default_axes,
    fit,
    grid_name,
    grid_point,
)
from app.db.models import Borehole, Document
from app.normalize.numbers import load_data
from app.review.service import set_manual_location

logger = logging.getLogger("geomemory.clarify.grid_anchors")
SETTLED = ("stated", "confirmed")


@dataclass(frozen=True)
class _Anchor:
    label: str
    grid: tuple[float, float]
    metric: tuple[float, float]


@lru_cache(maxsize=1)
def _limits() -> tuple[float, float]:
    data = load_data("tables.yaml")
    return float(data.get("distance_tolerance_m") or 25.0), float(data.get("anchor_max_lever") or 3.0)


def _key(grid: str) -> str:
    return " ".join(grid.casefold().split())


async def place_from_anchors(
    session: AsyncSession, doc: Document, anchors: Mapping[str, tuple[str, float, float]], *, actor: str
) -> int:
    """Place the boreholes of each site grid of `doc` that two or more anchors fix. `anchors`: group key ->
    (grid name, x, y) printed in the document's tables for boreholes a map system places. Returns how many
    boreholes were placed."""
    if not anchors:
        return 0
    rows = (await session.scalars(select(Borehole).where(Borehole.document_id == doc.id))).all()
    members = {
        bh.uid: grid
        for bh in rows
        if not bh.plotted
        and (grid := local_grid_of(bh.record, bh.crs_status)) is not None
        and grid_point(bh.record) is not None
    }
    names = grid_name([*members.values(), *(a[0] for a in anchors.values())])
    by_grid: dict[str, list[Borehole]] = {}
    for bh in rows:
        if bh.uid in members:
            by_grid.setdefault(_key(names[members[bh.uid]]), []).append(bh)
    fixed: dict[str, list[tuple[str, tuple[float, float], tuple[float, float]]]] = {}
    for bh in rows:
        anchor = anchors.get(bh.group_key)
        coords = (bh.record.get("metadata") or {}).get("coordinates") or {}
        lat, lon = coords.get("latitude"), coords.get("longitude")
        if anchor is None or not bh.plotted or bh.crs_status not in SETTLED:
            continue
        if not isinstance(lat, int | float) or not isinstance(lon, int | float):
            continue
        fixed.setdefault(_key(names[anchor[0]]), []).append(
            (bh.label_raw, (anchor[1], anchor[2]), (float(lat), float(lon)))
        )
    placed = 0
    x_north = await default_axes(session, doc.id) == X_NORTH
    for grid, group in sorted(by_grid.items()):
        found = sorted(fixed.get(grid, []))
        if len(found) < 2:
            continue  # one anchor leaves the rotation unknown: the grid stays a question
        placed += await _place(session, doc, grid, group, found, x_north=x_north, actor=actor)
    return placed


async def _place(
    session: AsyncSession,
    doc: Document,
    grid: str,
    group: list[Borehole],
    found: list[tuple[str, tuple[float, float], tuple[float, float]]],
    *,
    x_north: bool,
    actor: str,
) -> int:
    to_metric, to_wgs84 = _metric(*found[0][2])
    anchors = [_Anchor(label, g, to_metric.transform(lon, lat)) for label, g, (lat, lon) in found]
    first, second = anchors[0], anchors[1]
    baseline = math.dist(first.grid, second.grid)
    if baseline == 0:
        logger.info("site grid %r of %s: anchors at the same grid point; asked instead", grid, doc.id)
        return 0
    a, b = fit([(first.grid, first.metric), (second.grid, second.metric)], x_north)
    scale, rotation = abs(a), math.degrees(cmath.phase(a))
    if not 1 / MAX_SCALE_ERROR <= scale <= MAX_SCALE_ERROR:
        logger.info(
            "site grid %r of %s: anchors %s and %s are %.0f m apart on the grid but %.0f m on the map; asked "
            "instead",
            grid,
            doc.id,
            first.label,
            second.label,
            baseline,
            math.dist(first.metric, second.metric),
        )
        return 0

    def project(point: tuple[float, float]) -> complex:
        x, y = point
        return a * (complex(y, x) if x_north else complex(x, y)) + b

    tolerance, lever = _limits()
    for extra in anchors[2:]:
        off = abs(project(extra.grid) - complex(*extra.metric))
        if off > tolerance:
            logger.info(
                "site grid %r of %s: anchor %s lies %.0f m from where %s and %s put it; asked instead",
                grid,
                doc.id,
                extra.label,
                off,
                first.label,
                second.label,
            )
            return 0
    spread = max(math.dist(p.grid, q.grid) for p in anchors for q in anchors)
    targets = [(bh, point) for bh in group if (point := grid_point(bh.record)) is not None]
    farthest = max((min(math.dist(point, anc.grid) for anc in anchors) for _, point in targets), default=0.0)
    if farthest > lever * spread:
        logger.info(
            "site grid %r of %s: anchors %.0f m apart cannot fix boreholes up to %.0f m away; asked instead",
            grid,
            doc.id,
            spread,
            farthest,
        )
        return 0
    labels = " and ".join(anc.label for anc in anchors)
    axis = "north" if x_north else "east"
    note = (
        f"placed from the site grid '{grid}' by {labels}, which a map system places and the tables print on "
        f"the grid (scale {scale:.3f}, rotation {rotation:.1f} deg, grid X taken as {axis})"
    )
    flag = f"position derived from the site grid '{grid}' by {labels}; check it"
    for bh, point in targets:
        z = project(point)
        lon, lat = to_wgs84.transform(z.real, z.imag)
        source = f"{_number(point[0])} / {_number(point[1])} ({grid})"
        await set_manual_location(
            session, bh.uid, lat=float(lat), lon=float(lon), actor=actor, note=note, derived=(source, flag)
        )
    logger.info("site grid %r of %s: %d borehole(s) placed from %s", grid, doc.id, len(targets), labels)
    return len(targets)
