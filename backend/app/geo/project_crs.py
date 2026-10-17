"""A coordinate system confirmed for a project applies to the project's other boreholes that print none.

When a crs_confirm question of a project (of a document, without a project) was answered, the project's
boreholes still without a system (`crs_status` inferred) whose printed coordinates name no system, or only a
map sheet, get the answered system when their values fit it: the point lies inside its area of use and near
a borehole of the project already on the map (crs_registry.yaml project_answer). It is applied through
`confirm_crs`, with a revision note naming the earlier answer, so the open crs_confirm questions it settles
are resolved and new uploads of the project plot at once. A borehole that two answered systems fit, or that
prints a system of its own, is still asked about.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Borehole, Clarification, Document
from app.geo.crs_candidates import _registry_data, crs_label, haversine_km, inside_area_of_use
from app.geo.crs_service import confirm_crs
from app.geo.plotting import to_wgs84
from app.normalize import crs as crs_parser

logger = logging.getLogger("geomemory.geo.project_crs")

VIA_PROJECT_ANSWER = "project_answer"


@dataclass(frozen=True)
class Answer:
    clarification_id: str
    crs: str
    swap_axes: bool


@lru_cache(maxsize=1)
def near_km() -> float:
    return float(_registry_data()["project_answer"]["near_km"])


async def answers(session: AsyncSession, project: str | None, document_id: str) -> list[Answer]:
    """The answered crs_confirm questions of the project (else of the document), newest first."""
    query = select(Clarification).where(
        Clarification.kind == "crs_confirm", Clarification.status == "answered"
    )
    if project:
        query = query.where(func.lower(func.btrim(Clarification.project)) == project.casefold())
    else:
        query = query.where(Clarification.document_id == document_id, Clarification.project.is_(None))
    rows = (await session.scalars(query.order_by(Clarification.resolved_at.desc().nulls_last()))).all()
    out: list[Answer] = []
    for row in rows:
        answer = row.answer if isinstance(row.answer, dict) else {}
        if isinstance(answer.get("crs"), str):
            out.append(Answer(row.id, answer["crs"], bool(answer.get("swap_axes", False))))
    return out


async def _boreholes(session: AsyncSession, project: str | None, document_id: str) -> list[Borehole]:
    query = select(Borehole)
    if project:
        query = query.join(Document, Document.id == Borehole.document_id).where(
            func.lower(func.btrim(Document.project)) == project.casefold()
        )
    else:
        query = query.where(Borehole.document_id == document_id)
    return list((await session.scalars(query.order_by(Borehole.uid))).all())


def prints_no_system(coords: dict[str, Any]) -> bool:
    """The printed coordinates name no system: none printed, a map sheet, or the kilometre prefixes of the
    values (app.normalize.crs)."""
    system = coords.get("coordinate_system")
    if not isinstance(system, str) or not system.strip():
        return True
    return crs_parser.map_sheet(system) or crs_parser.km_prefix_text(system)


def _local_point(bh: Borehole) -> tuple[float, float] | None:
    coords = (bh.record.get("metadata") or {}).get("coordinates") or {}
    x, y = coords.get("local_x"), coords.get("local_y")
    if isinstance(x, int | float) and isinstance(y, int | float):
        return float(x), float(y)
    return None


def _map_point(bh: Borehole) -> tuple[float, float] | None:
    coords = (bh.record.get("metadata") or {}).get("coordinates") or {}
    lat, lon = coords.get("latitude"), coords.get("longitude")
    if bh.plotted and isinstance(lat, int | float) and isinstance(lon, int | float):
        return float(lat), float(lon)
    return None


def fits(answer: Answer, point: tuple[float, float], references: Sequence[tuple[float, float]]) -> bool:
    """The local point lies inside the answered system's area of use and near a placed borehole."""
    x, y = point
    if not inside_area_of_use(answer.crs, x, y, swap_axes=answer.swap_axes):
        return False
    wgs = to_wgs84(answer.crs, x, y, swap_axes=answer.swap_axes)
    if wgs is None:
        return False
    return any(haversine_km(wgs[0], wgs[1], lat, lon) <= near_km() for lat, lon in references)


async def apply_project_crs(
    session: AsyncSession, *, project: str | None, document_id: str, actor: str
) -> list[str]:
    """Confirm the project's answered system for its boreholes that print none and fit it; their uids."""
    project = (project or "").strip() or None
    found = await answers(session, project, document_id)
    if not found:
        return []
    boreholes = await _boreholes(session, project, document_id)
    references = [p for bh in boreholes if (p := _map_point(bh)) is not None]
    applied: list[str] = []
    for bh in boreholes:
        coords = (bh.record.get("metadata") or {}).get("coordinates") or {}
        point = _local_point(bh)
        if bh.crs_status != "inferred" or point is None or not prints_no_system(coords):
            continue
        fitting = {(a.crs, a.swap_axes): a for a in found if fits(a, point, references)}
        if len(fitting) != 1:
            continue  # none fits, or two answered systems do: the question stays
        answer = next(iter(fitting.values()))
        where = f"project '{project}'" if project else "this document"
        note = (
            f"coordinate system {crs_label(answer.crs) or answer.crs} ({answer.crs}) confirmed for {where} "
            "in "
            f"clarification {answer.clarification_id}; the printed values fit it"
        )
        await confirm_crs(
            session,
            [bh.uid],
            crs=answer.crs,
            swap_axes=answer.swap_axes,
            actor=actor,
            note=note,
            via=VIA_PROJECT_ANSWER,
        )
        applied.append(bh.uid)
        references.extend(p for p in [_map_point(bh)] if p is not None)
    if applied:
        logger.info("project %s: answered coordinate system applied to %d borehole(s)", project, len(applied))
    return applied
