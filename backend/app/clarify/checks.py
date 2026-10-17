"""Questions raised by document-level checks (BACKEND.md 7.8 and 7.9) and what their answers change.

* `locate_borehole`: a borehole without any printed coordinate but with a printed location name. The answer
  (a map point) is applied by app.clarify.answers through app.review.service.set_manual_location.
* `datum_convention`: a depth sign or origin note that the printed layer depths contradict (the finding
  comes from app.validate.datum). One question per document and kind; it grows to cover every borehole of
  the document with the same contradiction.
* `conflicting_sources`: the same header value printed differently on a context page (summary or
  coordinate table) and on the log. The generator takes the readings of both sources; the answer stores
  the chosen reading with its page and box.

Every generator is idempotent (dedupe keys) and generic: labels and thresholds come from data files.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.service import add_boreholes, create_clarification
from app.db.models import Borehole, Clarification, Document, FieldValue
from app.normalize.coordinates import parse_coordinates
from app.normalize.crs import local_grid
from app.review.service import (
    SourceRef,
    apply_patches,
    depth_paths_with_provenance,
    load_field_values,
    negate_negative_depths,
    set_values,
)
from app.schemas.boreholes import ValuePatch
from app.validate.datum import CONVENTION_OPTIONS, DatumFinding
from app.validate.document import section

LOCATION_PATH = "metadata.location_name"
DEPTH_ORIGIN_PATH = "metadata.depth_origin"
COORDINATE_KEYS = ("latitude", "longitude", "local_x", "local_y", "x_raw", "y_raw")

CONVENTION_LABELS = {
    "as_printed": "As printed: keep the depths as they are",
    "negative_down": "Negative values denote depth: store them as positive depths",
    "elevations": "The column holds elevations, not depths: flag the depth values for correction",
}
DEPTH_ORIGINS = {
    "ground": "Ground level",
    "mudline": "Mudline",
    "seabed": "Seabed",
    "relative": "Another reference (relative origin)",
}


@dataclass(frozen=True)
class EvidenceEntry:
    document_id: str
    page: int
    box: list[float] | None
    snippet: str | None

    def as_dict(self) -> dict[str, Any]:
        return {"document_id": self.document_id, "page": self.page, "box": self.box, "snippet": self.snippet}


# ----------------------------------------------------------------------------------------------
# locate_borehole
# ----------------------------------------------------------------------------------------------


def needs_location(record: dict[str, Any]) -> str | None:
    """The printed location name of a record that has no coordinate at all; None otherwise."""
    meta = record.get("metadata") or {}
    coords = meta.get("coordinates") or {}
    if any(coords.get(key) not in (None, "") for key in COORDINATE_KEYS):
        return None
    location = meta.get("location_name")
    return location.strip() if isinstance(location, str) and location.strip() else None


def unplaceable_system(record: dict[str, Any]) -> str:
    """How to name the printed system of coordinates that no listed system places."""
    coords = (record.get("metadata") or {}).get("coordinates") or {}
    system = coords.get("coordinate_system")
    printed = system.strip() if isinstance(system, str) and system.strip() else "no system printed"
    return f"{printed}; the printed values fit no coordinate system"


def local_grid_of(record: dict[str, Any], crs_status: str) -> str | None:
    """The local grid a record's printed coordinates are in, when no system places them; None otherwise."""
    if crs_status not in ("unknown", "inferred"):
        return None
    coords = (record.get("metadata") or {}).get("coordinates") or {}
    parsed = parse_coordinates(coords.get("x_raw"), coords.get("y_raw"), coords.get("axis_labels_raw"))
    return local_grid(coords.get("coordinate_system"), parsed)


async def ask_locate_boreholes(session: AsyncSession, doc: Document) -> int:
    """One `locate_borehole` question per borehole of `doc` without coordinates but with a printed place.
    Returns how many questions were asked for the first time."""
    boreholes = (
        await session.scalars(
            select(Borehole)
            .where(Borehole.document_id == doc.id, Borehole.plotted.is_(False))
            .order_by(Borehole.uid)
        )
    ).all()
    asked = 0
    covered = {
        uid
        for uids in (
            await session.scalars(
                select(Clarification.borehole_uids).where(
                    Clarification.kind == "crs_confirm", Clarification.document_id == doc.id
                )
            )
        ).all()
        for uid in (uids or [])
    }
    for bh in boreholes:
        grid = local_grid_of(bh.record, bh.crs_status)
        if grid is None and bh.crs_status == "inferred" and bh.uid not in covered:
            grid = unplaceable_system(bh.record)  # printed values no coordinate system places
        location = needs_location(bh.record) if grid is None else grid
        if location is None:
            continue
        key = f"locate_borehole:{bh.uid}"
        if await session.scalar(select(Clarification.id).where(Clarification.dedupe_key == key)) is not None:
            continue
        source = await session.get(FieldValue, (bh.uid, LOCATION_PATH))
        evidence = []
        where = ""
        if source is not None and source.page is not None:
            evidence.append(
                EvidenceEntry(source.document_id or doc.id, source.page, source.box, source.raw or location)
            )
            where = f" (page {source.page})"
        await create_clarification(
            session,
            kind="locate_borehole",
            document_id=doc.id,
            question=(
                f"{bh.label_raw} has no coordinates in {doc.file_name}; the log names the place "
                f"'{location}'. Where was it drilled?"
                if grid is None
                else f"{bh.label_raw} in {doc.file_name} is positioned in the local grid '{grid}', which no "
                "map coordinate system places. Where was it drilled?"
            ),
            fields=[
                {
                    "name": "location",
                    "widget": "map_point",
                    "label": "Click the borehole position on the map",
                    "help": f"Printed location: {location}{where}.",
                    "required": True,
                },
                {
                    "name": "source_note",
                    "widget": "text",
                    "label": "Where does this position come from?",
                    "required": False,
                },
            ],
            evidence=[e.as_dict() for e in evidence],
            borehole_uids=[bh.uid],
            project=doc.project,
            dedupe_key=key,
        )
        asked += 1
    return asked


# ----------------------------------------------------------------------------------------------
# datum_convention
# ----------------------------------------------------------------------------------------------


async def ask_datum_convention(
    session: AsyncSession,
    doc: Document,
    *,
    uid: str,
    label: str,
    finding: DatumFinding,
    origin: str | None,
    evidence: Sequence[EvidenceEntry],
) -> Clarification:
    """One question per document and kind of contradiction; later boreholes join the open question."""
    key = f"datum_convention:{finding.kind}:{doc.id}"
    existing = await session.scalar(select(Clarification).where(Clarification.dedupe_key == key))
    if existing is not None:
        await add_boreholes(session, existing, [uid])
        return existing
    evidence_max = int(section("datum_convention")["evidence_max"])
    origin_field: dict[str, Any] = {
        "name": "depth_origin",
        "widget": "select",
        "label": "Depths are measured from",
        "help": "Leave empty when the log does not say.",
        "required": False,
        "options": [{"value": value, "label": text} for value, text in DEPTH_ORIGINS.items()],
    }
    if origin in DEPTH_ORIGINS:
        origin_field["default"] = origin
    return await create_clarification(
        session,
        kind="datum_convention",
        document_id=doc.id,
        question=f"{finding.explanation} How should the depths of {label} in {doc.file_name} be read?",
        fields=[
            {
                "name": "convention",
                "widget": "select",
                "label": "The printed depths are",
                "required": True,
                "options": [
                    {"value": value, "label": CONVENTION_LABELS[value]}
                    for value in CONVENTION_OPTIONS[finding.kind]
                ],
            },
            origin_field,
        ],
        evidence=[e.as_dict() for e in evidence[:evidence_max]],
        borehole_uids=[uid],
        project=doc.project,
        dedupe_key=key,
    )


async def apply_datum_answer(
    session: AsyncSession, row: Clarification, values: dict[str, Any], actor: str
) -> None:
    """Depth origin set as answered; negative depths stored as positive (`negative_down`) or the depth
    values flagged for correction (`elevations`). Each borehole gets its revisions."""
    note = f"clarification {row.id}"
    convention, origin = values.get("convention"), values.get("depth_origin")
    for uid in row.borehole_uids or []:
        bh = await session.get(Borehole, uid)
        if bh is None:
            continue
        if isinstance(origin, str) and origin in DEPTH_ORIGINS:
            await set_values(
                session, uid, {DEPTH_ORIGIN_PATH: origin}, actor=actor, action="datum", note=note
            )
        if convention == "negative_down":
            await negate_negative_depths(session, uid, actor=actor, note=note)
        elif convention == "elevations":
            fvs = await load_field_values(session, uid)
            reason = f"{note}: the column holds elevations, not depths"
            patches = [
                ValuePatch(path=path, action="flag", reason=reason)
                for path in depth_paths_with_provenance(bh, fvs)
            ]
            if patches:
                await apply_patches(session, uid, patches, actor=actor, action="datum", note=note)


# ----------------------------------------------------------------------------------------------
# conflicting_sources
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SourceReading:
    """One printed reading of a header value: the log's, or a context page's."""

    value: Any  # normalised for the value path (a number in metres, a text ...)
    raw: str | None  # as printed
    role: str | None  # page role of its source (log_sheet, summary_table, coordinate_table ...)
    document_id: str
    page: int | None
    box: list[float] | None


_SPACES = re.compile(r"\s+")


def _same(a: Any, b: Any, tolerance: float) -> bool:
    numbers = (int, float)
    if (
        isinstance(a, numbers)
        and isinstance(b, numbers)
        and not isinstance(a, bool)
        and not isinstance(b, bool)
    ):
        return math.isclose(float(a), float(b), rel_tol=0.0, abs_tol=tolerance)
    if isinstance(a, str) and isinstance(b, str):
        return _SPACES.sub(" ", a).strip().casefold() == _SPACES.sub(" ", b).strip().casefold()
    return bool(a == b)


def distinct_readings(readings: Sequence[SourceReading]) -> list[SourceReading]:
    """The readings that disagree, one per distinct value, in the given order (log first by convention)."""
    tolerance = float(section("conflicting_sources")["number_tolerance"])
    out: list[SourceReading] = []
    for reading in readings:
        if reading.value is None:
            continue
        if not any(_same(reading.value, kept.value, tolerance) for kept in out):
            out.append(reading)
    return out


def _source_name(role: str | None) -> str:
    names = section("conflicting_sources").get("sources") or {}
    return str(names.get(role or "", "page"))


def _field_label(path: str) -> str:
    labels = section("conflicting_sources").get("fields") or {}
    return str(labels.get(path, path))


async def ask_conflicting_sources(
    session: AsyncSession,
    doc: Document,
    *,
    uid: str,
    label: str,
    path: str,
    readings: Sequence[SourceReading],
) -> Clarification | None:
    """A `conflicting_sources` question when the readings disagree; None when they agree."""
    distinct = distinct_readings(readings)
    if len(distinct) < 2:
        return None
    options: list[dict[str, Any]] = []
    evidence: list[dict[str, Any]] = []
    for reading in distinct:
        where = _source_name(reading.role) + (f", page {reading.page}" if reading.page is not None else "")
        option: dict[str, Any] = {
            "value": reading.value,
            "label": f"{reading.raw or reading.value} ({where})",
        }
        if reading.page is not None:
            entry = EvidenceEntry(reading.document_id, reading.page, reading.box, reading.raw).as_dict()
            option["evidence"] = entry
            evidence.append(entry)
        options.append(option)
    field_label = _field_label(path)
    sources = " and the ".join(dict.fromkeys(_source_name(r.role) for r in distinct))
    return await create_clarification(
        session,
        kind="conflicting_sources",
        document_id=doc.id,
        question=(
            f"The {sources} give different values of {field_label.lower()} for {label}. Which one is right?"
        ),
        fields=[
            {"name": "value", "widget": "select", "label": field_label, "required": True, "options": options}
        ],
        evidence=evidence,
        borehole_uids=[uid],
        path=path,
        project=doc.project,
        dedupe_key=f"conflicting_sources:{uid}:{path}",
    )


async def apply_conflict_answer(
    session: AsyncSession, row: Clarification, values: dict[str, Any], actor: str
) -> None:
    """The chosen reading becomes the value, approved, with the page and box of its source."""
    if not row.path or "value" not in values:
        return
    chosen = values["value"]
    field = next((f for f in row.fields or [] if f.get("name") == "value"), None)
    option = next((o for o in (field or {}).get("options") or [] if o.get("value") == chosen), None)
    source = None
    evidence = (option or {}).get("evidence")
    if isinstance(evidence, dict):
        source = SourceRef(
            document_id=evidence.get("document_id"),
            page=evidence.get("page"),
            box=evidence.get("box"),
            raw=evidence.get("snippet"),
        )
    for uid in row.borehole_uids or []:
        if await session.get(Borehole, uid) is None:
            continue
        await set_values(
            session,
            uid,
            {row.path: chosen},
            actor=actor,
            action="clarification",
            note=f"clarification {row.id}",
            sources={row.path: source} if source is not None else None,
        )
