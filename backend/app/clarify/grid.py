"""Boreholes on one local site grid: one question places them all (BACKEND.md 7.9).

A report that gives positions only on its own site grid ("Oslo lokal", an unnamed X/Y grid) cannot be put on
the map by any coordinate system. Instead of one map question per borehole, the document gets one question per
grid: a person places one or two of its boreholes on the map and every borehole of the grid follows from its
grid coordinates by a similarity transform. With two anchors the shift, rotation and scale are fitted; with
one, only the shift (grid north taken as north, grid units metres). Which grid axis points north is asked as
well: surveyors' x points north in much of Europe and East Asia (data/crs_patterns.yaml
local_grid.x_north_languages gives the default from the document's language).

Every placement is a revision by the answering person (app.review.service.set_manual_location) whose note
names the anchors, the fitted scale and rotation.
"""

from __future__ import annotations

import cmath
import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from pyproj import Transformer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.service import create_clarification
from app.db.models import Borehole, Clarification, Document, Page
from app.errors import ApiError
from app.normalize.numbers import load_data
from app.review.service import set_manual_location

KIND = "locate_borehole"
UNNAMED = "unnamed local grid"
X_NORTH = "x_north"
X_EAST = "x_east"
# Two anchors whose map distance differs from their grid distance by more than this factor are misplaced.
MAX_SCALE_ERROR = 1.25


@dataclass(frozen=True)
class GridMember:
    uid: str
    label: str
    x: float  # first printed grid value
    y: float  # second printed grid value


def grid_point(record: dict[str, Any]) -> tuple[float, float] | None:
    """The printed grid coordinates of a record (local_x, local_y), when both are numbers."""
    coords = (record.get("metadata") or {}).get("coordinates") or {}
    x, y = coords.get("local_x"), coords.get("local_y")
    if (
        isinstance(x, bool)
        or isinstance(y, bool)
        or not isinstance(x, int | float)
        or not isinstance(y, int | float)
    ):
        return None
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    return float(x), float(y)


def grid_name(grids: Sequence[str]) -> dict[str, str]:
    """Grid name per printed name: an unnamed grid is the document's only named grid when it has one."""
    named = sorted({g for g in grids if g != UNNAMED})
    return {g: (named[0] if g == UNNAMED and len(named) == 1 else g) for g in grids}


def _x_north_languages() -> frozenset[str]:
    data = (load_data("crs_patterns.yaml") or {}).get("local_grid") or {}
    return frozenset(str(code).lower() for code in data.get("x_north_languages") or [])


async def default_axes(session: AsyncSession, document_id: str) -> str:
    languages = (
        await session.scalars(
            select(Page.language).where(Page.document_id == document_id, Page.used.is_(True))
        )
    ).all()
    counted = Counter(str(code).lower().split("-")[0] for code in languages if code)
    if not counted:
        return X_EAST
    return X_NORTH if counted.most_common(1)[0][0] in _x_north_languages() else X_EAST


def _number(value: float) -> str:
    return f"{value:,.2f}".rstrip("0").rstrip(".").replace(",", " ")


async def ask_grid(session: AsyncSession, doc: Document, grid: str, members: Sequence[GridMember]) -> bool:
    """One question that places every member of `grid` from one or two anchors. True when newly asked."""
    key = f"{KIND}:grid:{doc.id}:{grid.casefold()}"
    if await session.scalar(select(Clarification.id).where(Clarification.dedupe_key == key)) is not None:
        return False
    options = [
        {"value": m.uid, "label": f"{m.label}  (grid {_number(m.x)} / {_number(m.y)})"} for m in members
    ]
    axes = await default_axes(session, doc.id)
    names = ", ".join(m.label for m in members[:8]) + (" …" if len(members) > 8 else "")
    await create_clarification(
        session,
        kind=KIND,
        document_id=doc.id,
        question=(
            f"{len(members)} boreholes of {doc.file_name} ({names}) are positioned on the site grid "
            f"'{grid}', which no map coordinate system places. Place one or two of them on the map: the "
            "others follow from their grid coordinates."
        ),
        fields=[
            {
                "name": "anchor_1",
                "widget": "select",
                "label": "A borehole you can place",
                "required": True,
                "options": options,
            },
            {"name": "point_1", "widget": "map_point", "label": "Where it was drilled", "required": True},
            {
                "name": "anchor_2",
                "widget": "select",
                "label": "A second borehole (optional)",
                "required": False,
                "options": options,
                "help": "With two boreholes the grid's rotation and scale are fitted too; with one, grid "
                "north is taken as north.",
            },
            {
                "name": "point_2",
                "widget": "map_point",
                "label": "Where the second one was drilled",
                "required": False,
            },
            {
                "name": "axes",
                "widget": "select",
                "label": "Which grid axis points north?",
                "required": True,
                "default": axes,
                "options": [
                    {"value": X_NORTH, "label": "The first value (X) is north, the second (Y) east"},
                    {"value": X_EAST, "label": "The first value (X) is east, the second (Y) north"},
                ],
            },
            {
                "name": "source_note",
                "widget": "text",
                "label": "Where do these positions come from?",
                "required": False,
            },
        ],
        borehole_uids=[m.uid for m in members],
        project=doc.project,
        dedupe_key=key,
    )
    return True


def is_grid_answer(values: dict[str, Any]) -> bool:
    return "anchor_1" in values


def _metric(lat: float, lon: float) -> tuple[Transformer, Transformer]:
    """WGS84 <-> the UTM zone of a point (metres), both directions, x = east."""
    zone = min(60, max(1, int((lon + 180) // 6) + 1))
    epsg = (32600 if lat >= 0 else 32700) + zone
    return (
        Transformer.from_crs(4326, epsg, always_xy=True),
        Transformer.from_crs(epsg, 4326, always_xy=True),
    )


def fit(
    anchors: Sequence[tuple[tuple[float, float], tuple[float, float]]], x_north: bool
) -> tuple[complex, complex]:
    """(a, b) of z = a*w + b from grid points w to map points z (east + i*north, metres)."""

    def w(point: tuple[float, float]) -> complex:
        x, y = point
        return complex(y, x) if x_north else complex(x, y)

    (g1, m1), *rest = anchors
    z1 = complex(*m1)
    if not rest:
        return 1 + 0j, z1 - w(g1)
    g2, m2 = rest[0]
    a = (complex(*m2) - z1) / (w(g2) - w(g1))
    return a, z1 - a * w(g1)


def _invalid(message: str, field: str) -> ApiError:
    return ApiError(422, "answer_invalid", message, [{"loc": ["body", "values", field], "msg": message}])


async def apply_grid_answer(
    session: AsyncSession, row: Clarification, values: dict[str, Any], actor: str
) -> None:
    """Place every borehole of the question from the anchors the person placed."""
    boreholes = {
        bh.uid: bh
        for bh in (
            await session.scalars(select(Borehole).where(Borehole.uid.in_(list(row.borehole_uids or []))))
        ).all()
    }
    picks: list[tuple[Any, dict[str, Any]]] = [(values.get("anchor_1"), values["point_1"])]
    if values.get("anchor_2") is not None or values.get("point_2") is not None:
        if values.get("anchor_2") is None or values.get("point_2") is None:
            raise _invalid("Give both the second borehole and where it was drilled, or neither.", "anchor_2")
        if values["anchor_2"] == values.get("anchor_1"):
            raise _invalid("Choose a different borehole as the second one.", "anchor_2")
        picks.append((values["anchor_2"], values["point_2"]))
    first_point = picks[0][1]
    to_metric, to_wgs84 = _metric(float(first_point["lat"]), float(first_point["lon"]))
    anchors: list[tuple[tuple[float, float], tuple[float, float]]] = []
    labels: list[str] = []
    for uid, point in picks:
        bh = boreholes.get(str(uid))
        grid = grid_point(bh.record) if bh is not None else None
        if bh is None or grid is None:
            raise _invalid("That borehole has no grid coordinates to place it by.", "anchor_1")
        if anchors and math.dist(anchors[0][0], grid) == 0:
            raise _invalid(
                "The two boreholes have the same grid coordinates; choose another second one.", "anchor_2"
            )
        anchors.append((grid, to_metric.transform(float(point["lon"]), float(point["lat"]))))
        labels.append(bh.label_raw)
    x_north = values.get("axes", X_NORTH) == X_NORTH
    a, b = fit(anchors, x_north)
    scale, rotation = abs(a), math.degrees(cmath.phase(a))
    if len(anchors) == 2 and not (1 / MAX_SCALE_ERROR <= scale <= MAX_SCALE_ERROR):
        grid_m = math.dist(anchors[0][0], anchors[1][0])
        map_m = math.dist(anchors[0][1], anchors[1][1])
        raise _invalid(
            f"The two boreholes are {grid_m:.0f} m apart on the grid but {map_m:.0f} m apart on the map; "
            "check the two points.",
            "point_2",
        )
    source = values.get("source_note")
    note = (
        f"clarification {row.id}: placed from site grid by {' and '.join(labels)}"
        + (f" (scale {scale:.3f}, rotation {rotation:.1f} deg)" if len(anchors) == 2 else " (shift only)")
        + (f"; {source.strip()[:200]}" if isinstance(source, str) and source.strip() else "")
    )
    for uid, bh in sorted(boreholes.items()):
        grid = grid_point(bh.record)
        if grid is None:
            continue
        x, y = grid
        z = a * (complex(y, x) if x_north else complex(x, y)) + b
        lon, lat = to_wgs84.transform(z.real, z.imag)
        await set_manual_location(session, uid, lat=float(lat), lon=float(lon), actor=actor, note=note)
