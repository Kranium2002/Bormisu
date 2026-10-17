"""Finalisation (BACKEND.md 7.6-7.9): an extraction outcome becomes a borehole, and a document is closed.

finalize_group(document_id, group, outcome)
    Normalises the model's raw text with app.normalize (Python only), builds the record body and one
    provenance entry per value from the OCR blocks the model cited (app.pipeline.provenance), narrowed to
    the printed words when the page has a trustworthy text layer (app.pipeline.textlayer), decides the
    coordinate-system status (a printed system whose area of use holds the point only with easting and
    northing swapped stays stated and is read swapped) and creates the borehole through
    app.review.service.create_borehole.
    Idempotent per (document, group key). Depths printed without any unit are stored as metres with
    method `guessed` and one `unit_ambiguous` question per document; uncertain page groups get a
    `borehole_boundary` question; a printed depth sign or origin note that the printed layer depths
    contradict gets one `datum_convention` question per document and kind (app.validate.datum).

finalize_document(document_id)
    Completeness against the labels printed on summary and coordinate tables, `documents.duplicate_of` and
    one `duplicate` question per earlier document the document repeats (app.clarify.duplicates), one
    `crs_confirm` question per project (or per document without a project label) for boreholes whose
    system was not stated, a `locate_borehole` question for each borehole without coordinates but with a
    printed place, the lint across the document's boreholes (cluster outliers, shared coordinates), the
    `boreholes_extracted` progress counter and the document status (needs_review, or done when every
    borehole is approved).

Unknown stays null with a reason; no value is invented and nothing depends on a particular document.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.checks import EvidenceEntry, ask_datum_convention, ask_locate_boreholes
from app.clarify.duplicates import ask_duplicates, refresh_duplicate_of
from app.clarify.service import clarification_out, create_clarification
from app.db.models import Borehole, Clarification, Document, FieldValue, Page
from app.db.session import get_sessionmaker
from app.events.writer import emit
from app.geo.crs_candidates import area_of_use, candidates_for_boreholes, ranking_config
from app.geo.land import near_land
from app.geo.plotting import to_wgs84
from app.normalize import coordinates as coordinates_parser
from app.normalize import crs as crs_parser
from app.normalize import dates, datums, lithology, numbers, units
from app.normalize import spt as spt_parser
from app.normalize.api import CoordinateResult
from app.pipeline import textlayer
from app.pipeline.provenance import Citations, MethodLiteral, method_of, printed, union_box
from app.pipeline.schemas import ExtractedLayer, ExtractionResult, RawValue
from app.pipeline.textlayer import PageText
from app.pipeline.types import BlockRef, ExtractionOutcome, PageGroup
from app.review.service import (
    canonical_label,
    create_borehole,
    refresh_document_checks,
    refresh_document_status,
)
from app.schemas.boreholes import ProvenanceIn
from app.schemas.documents import Completeness
from app.services.documents import emit_document_updated
from app.storage import StorageKeyError, get_storage
from app.validate.datum import DatumFinding, check_datum_convention
from app.validate.document import section as document_checks_section

logger = logging.getLogger("geomemory.pipeline.finalize")

CrsStatusLiteral = Literal["stated", "inferred", "unknown"]

# Pages whose printed borehole labels list the boreholes a report should contain (BACKEND.md 7.5).
EXPECTED_ID_ROLES = ("summary_table", "coordinate_table")
# Units offered when the document prints its depths without one.
DEPTH_UNIT_OPTIONS = ("m", "ft")
# Evidence entries shown with the depth-unit question.
UNIT_EVIDENCE_MAX = 3
ACTOR = "pipeline"

X_RAW = "metadata.coordinates.x_raw"
Y_RAW = "metadata.coordinates.y_raw"
SYSTEM_RAW = "metadata.coordinates.coordinate_system"


def _now() -> datetime:
    return datetime.now(UTC)


def _digest(text_value: str) -> str:
    return hashlib.sha256(text_value.encode("utf-8")).hexdigest()[:24]


# ----------------------------------------------------------------------------------------------
# Units printed in headers and next to values
# ----------------------------------------------------------------------------------------------

_BRACKETED = re.compile(r"[(\[{]([^)\]}]*)[)\]}]")
_WORD = re.compile(r"[^\W\d_]+")


def _length_key(text_value: str | None) -> str | None:
    unit = units.lookup_unit(text_value)
    return unit.key if unit is not None and unit.dimension == "length" else None


def length_unit_in(text_value: str | None) -> str | None:
    """The length unit a printed header names ("Tiefe [m]", "Depth (ft)", "m bgl", "Depth in metres").

    Bracketed text first, then the whole text, then the last word that names a length unit.
    """
    if text_value is None or not text_value.strip():
        return None
    for candidate in [*(m.group(1) for m in _BRACKETED.finditer(text_value)), text_value]:
        key = _length_key(candidate)
        if key is not None:
            return key
    found = None
    for word in _WORD.findall(text_value):
        key = _length_key(word)
        if key is not None:
            found = key
    return found


def _number_raws(result: ExtractionResult) -> list[str]:
    """Every printed number-like text of a group, for learning its decimal separator."""
    h = result.header
    values: list[RawValue] = [
        h.total_depth,
        h.ground_level,
        h.inclination,
        h.coordinates.x_raw,
        h.coordinates.y_raw,
    ]
    for layer in result.layers:
        values += [layer.from_raw, layer.to_raw]
    for spt in result.spt:
        values += [spt.depth_raw]
    for run in result.core_runs:
        values += [run.from_raw, run.to_raw, run.tcr_raw, run.scr_raw, run.rqd_raw]
    for reading in result.groundwater:
        values += [reading.depth_raw]
    for sample in result.samples:
        values += [sample.from_raw, sample.to_raw]
    for test in result.tests:
        values += [test.value_raw, test.depth_raw]
    return [t for t in (printed(v) for v in values) if t is not None]


# ----------------------------------------------------------------------------------------------
# Record draft (pure: no database)
# ----------------------------------------------------------------------------------------------


@dataclass
class _Item:
    """One array element of the record with provenance keyed by its field name."""

    data: dict[str, Any]
    prov: dict[str, ProvenanceIn] = field(default_factory=dict)
    order: tuple[float, ...] = ()


@dataclass(frozen=True)
class GuessedDepth:
    """A depth stored as metres although no unit was printed for it."""

    raw: str
    value: float
    provenance: ProvenanceIn


@dataclass
class RecordDraft:
    """Everything create_borehole needs, plus what the questions and the run log need."""

    body: dict[str, Any] | None
    provenance: dict[str, ProvenanceIn]
    crs_status: CrsStatusLiteral
    crs_code: str | None
    label: str | None
    label_page: int | None = None
    label_box: list[float] | None = None
    guessed_depths: list[GuessedDepth] = field(default_factory=list)
    crs_note: str | None = None
    # The stated system places the point inside its area of use only with easting and northing swapped.
    swap_axes: bool = False
    warnings: list[str] = field(default_factory=list)
    # A depth sign or origin note that the printed layer depths contradict, with the depth origin the note
    # states (if any) and where the note and the first depths are printed.
    datum_finding: DatumFinding | None = None
    datum_origin: str | None = None
    datum_evidence: list[EvidenceEntry] = field(default_factory=list)


def _swap_on_land(code: str, x: float, y: float) -> bool:
    """The point as read is far from land while the swapped reading is on or near it."""
    margin = ranking_config().land_margin_km
    read, swapped = to_wgs84(code, x, y), to_wgs84(code, x, y, swap_axes=True)
    if read is None or swapped is None:
        return False
    return not near_land(round(read[0], 2), round(read[1], 2), margin) and near_land(
        round(swapped[0], 2), round(swapped[1], 2), margin
    )


def _inside_area(code: str, x: float, y: float, *, swap_axes: bool = False) -> bool:
    """The point transforms with `code` and lies inside its area of use (plus the ranking margin)."""
    point = to_wgs84(code, x, y, swap_axes=swap_axes)
    if point is None:
        return False
    bounds = area_of_use(code)
    if bounds is None:
        return True
    lat, lon = point
    west, south, east, north = bounds
    margin = ranking_config().shift_margin_deg
    if west <= east:
        lon_ok = west - margin <= lon <= east + margin
    else:  # area crosses the antimeridian
        lon_ok = lon >= west - margin or lon <= east + margin
    return lon_ok and south - margin <= lat <= north + margin


_BLOCK_INDEX = re.compile(r"\.b(\d+)$")


def _block_index(block: BlockRef) -> int:
    match = _BLOCK_INDEX.search(block.id)
    return int(match.group(1)) if match else 1 << 30


class _Builder:
    def __init__(
        self,
        document_id: str,
        group: PageGroup,
        outcome: ExtractionOutcome,
        text_layers: Mapping[int, PageText] | None = None,
    ) -> None:
        self.document_id = document_id
        self.group = group
        self.result = outcome.result
        self.cite = Citations(
            outcome.blocks,
            document_id=document_id,
            page_order=(*group.pages, *group.context_pages),
            text_layers=text_layers,
        )
        self.style = numbers.learn_style(_number_raws(self.result))
        self.prov: dict[str, ProvenanceIn] = {}
        self.warnings: list[str] = []
        self.guessed: list[GuessedDepth] = []
        h = self.result.header
        # Known before any depth is read: a printed sign note changes the depth order of the rows.
        origin = datums.parse_depth_origin(printed(h.depth_origin_note), printed(h.elevation_datum))
        self.negative_down = origin.negative_down is True
        self.depth_unit = self._group_depth_unit()
        if text_layers:
            # Where each printed value is in the text layers, resolved once for the whole record. Tight
            # boxes are a refinement: if they cannot be worked out, the values keep their OCR blocks.
            try:
                self.cite.resolution = textlayer.resolve_record(
                    self.result,
                    outcome.blocks,
                    text_layers,
                    page_key=self.cite.page_key,
                    depth_of=lambda value: self.depth(value)[0],
                )
            except Exception:  # never lose a borehole over its evidence boxes
                logger.exception("group %s: text-layer boxes not resolved", group.key)
                self.warnings.append("evidence boxes from the text layer could not be resolved")

    # -- generic helpers -------------------------------------------------------------------------

    def keep(
        self,
        target: dict[str, ProvenanceIn],
        key: str,
        value: RawValue | None,
        result: object,
        *,
        method: MethodLiteral | None = None,
    ) -> None:
        if self.cite.needed(value, result):
            target[key] = self.cite.entry(value, method=method)

    def text(self, target: dict[str, ProvenanceIn], key: str, value: RawValue | None) -> str | None:
        result = printed(value)
        self.keep(target, key, value, result)
        return result

    def _glued_unit(self, raw: str) -> str | None:
        parsed = units.parse_length(raw, style=self.style)
        if parsed.metres is None or parsed.unit_raw is None:
            return None
        return _length_key(parsed.unit_raw)

    def _depth_raws(self) -> list[str]:
        r = self.result
        values: list[RawValue] = [r.header.total_depth]
        for layer in r.layers:
            values += [layer.from_raw, layer.to_raw]
        values += [s.depth_raw for s in r.spt]
        for run in r.core_runs:
            values += [run.from_raw, run.to_raw]
        values += [g.depth_raw for g in r.groundwater]
        for sample in r.samples:
            values += [sample.from_raw, sample.to_raw]
        values += [t.depth_raw for t in r.tests]
        return [t for t in (printed(v) for v in values) if t is not None]

    def _group_depth_unit(self) -> str | None:
        """The unit of the group's depth column: printed in the header, else glued to its values."""
        header_unit = printed(self.result.header.depth_unit)
        key = length_unit_in(header_unit)
        if key is not None:
            return key
        if header_unit is not None:
            self.warnings.append(f"depth unit '{header_unit}' names no length unit")
        glued = {k for k in (self._glued_unit(raw) for raw in self._depth_raws()) if k is not None}
        if len(glued) == 1:
            return glued.pop()
        if len(glued) > 1:
            self.warnings.append(
                f"depths are printed with different units ({', '.join(sorted(glued))}); "
                "values printed without a unit get none of them"
            )
        return None

    def signed_depth(self, value: RawValue | None) -> tuple[float | None, bool]:
        """Metres from a printed depth with its printed sign, and whether its unit was guessed."""
        raw = printed(value)
        if raw is None:
            return None, False
        default = self.depth_unit
        guessed = False
        if default is None and self._glued_unit(raw) is None:
            default, guessed = "m", True
        metres = units.parse_length(raw, default_unit=default, style=self.style).metres
        return (None, False) if metres is None else (metres, guessed)

    def depth(self, value: RawValue | None) -> tuple[float | None, bool]:
        """Metres from a printed depth, and whether its unit was guessed (no unit printed anywhere)."""
        metres, guessed = self.signed_depth(value)
        if metres is None:
            return None, False
        if self.negative_down and metres < 0:
            metres = -metres  # a printed note says negative values denote depth; the raw keeps the sign
        return metres, guessed

    def depth_value(self, target: dict[str, ProvenanceIn], key: str, value: RawValue | None) -> float | None:
        metres, guessed = self.depth(value)
        if self.cite.needed(value, metres):
            entry = self.cite.entry(value, method="guessed" if guessed else None)
            target[key] = entry
            raw = printed(value)
            if guessed and metres is not None and raw is not None:
                self.guessed.append(GuessedDepth(raw, metres, entry))
        return metres

    # -- header ----------------------------------------------------------------------------------

    def label(self) -> tuple[str | None, ProvenanceIn | None]:
        header_label = printed(self.result.header.borehole_label)
        if header_label is not None:
            return header_label, self.cite.entry(self.result.header.borehole_label)
        group_label = (self.group.label_raw or "").strip()
        if not group_label:
            return None, None
        return group_label, self._label_entry(group_label)

    def _label_entry(self, label: str) -> ProvenanceIn:
        """The page classifier read the label: point at a block of the group that prints it, if any."""
        pattern = re.compile(rf"(?<![0-9A-Za-z]){re.escape(label)}(?![0-9A-Za-z])", re.IGNORECASE)
        pages = set(self.group.pages)
        matches = sorted(
            (b for b in self.cite.blocks.values() if b.page in pages and pattern.search(b.text)),
            key=lambda b: (self.cite.page_key(b.page), _block_index(b)),
        )
        if matches:
            block = matches[0]
            box = self.cite.locate([block])[1]
            hit = self.cite.find_text(label, [block])
            if hit is not None and hit.page == block.page and hit.box is not None:
                box = union_box([hit.box])
            return ProvenanceIn(
                document_id=self.document_id,
                page=block.page,
                box=box,
                raw=label,
                method=method_of([block], found_in_text_layer=hit is not None),
                confidence=block.confidence,
            )
        return ProvenanceIn(
            document_id=self.document_id,
            page=self.group.pages[0] if self.group.pages else None,
            box=None,
            raw=label,
            method="ocr",
            confidence=None,
        )

    def depth_origin(self, meta: dict[str, Any]) -> None:
        h = self.result.header
        note, datum = printed(h.depth_origin_note), printed(h.elevation_datum)
        origin = datums.parse_depth_origin(note, datum)
        self.negative_down = origin.negative_down is True
        if origin.origin is None:
            return
        from_note = datums.parse_depth_origin(note).origin if note else None
        sources = (
            [h.depth_origin_note] if from_note == origin.origin else [h.depth_origin_note, h.elevation_datum]
        )
        meta["depth_origin"] = origin.origin
        self.prov["metadata.depth_origin"] = self.cite.entry(
            *[s for s in sources if printed(s) is not None], method="derived"
        )

    def dates(self, meta: dict[str, Any]) -> None:
        h = self.result.header
        printed_dates: list[RawValue] = []
        resolved = True
        for key, value in (("start_date", h.start_date), ("end_date", h.end_date)):
            raw = printed(value)
            iso = dates.parse_date(raw).iso if raw is not None else None
            meta[key] = iso
            self.keep(self.prov, f"metadata.{key}", value, iso)
            if raw is not None:
                printed_dates.append(value)
                resolved = resolved and iso is not None
        if printed_dates and not resolved:
            texts = list(dict.fromkeys(t for t in (printed(v) for v in printed_dates) if t is not None))
            meta["drilling_date"] = " – ".join(texts)
            self.prov["metadata.drilling_date"] = self.cite.entry(*printed_dates, raw=meta["drilling_date"])

    def elevation(self, meta: dict[str, Any]) -> None:
        h = self.result.header
        raw = printed(h.ground_level)
        value: float | None = None
        guessed = False
        if raw is not None:
            default = self._glued_unit(raw) or length_unit_in(printed(h.elevation_datum)) or self.depth_unit
            if default is None:
                default, guessed = "m", True
            value = units.parse_length(raw, default_unit=default, style=self.style).metres
            if value is None:
                self.warnings.append(f"ground level '{raw}' is not a length")
        meta["surface_elevation_mASL"] = value
        self.keep(
            self.prov,
            "metadata.surface_elevation_mASL",
            h.ground_level,
            value,
            method="guessed" if guessed and value is not None else None,
        )

    def inclination(self, meta: dict[str, Any]) -> None:
        h = self.result.header
        raw = printed(h.inclination)
        value: float | None = None
        if raw is not None:
            number = numbers.parse_number(raw, style=self.style)
            if number.value is not None:
                value = (
                    number.value if number.unit is None else units.convert(number.value, number.unit, "deg")
                )
            if value is None:
                self.warnings.append(f"inclination '{raw}' is not an angle")
        meta["inclination_deg"] = value
        self.keep(self.prov, "metadata.inclination_deg", h.inclination, value)

    def coordinates(self, meta: dict[str, Any]) -> tuple[CrsStatusLiteral, str | None, str | None, bool]:
        """(crs_status, crs_code, note, swap_axes) of the printed coordinates.

        A printed system is stated when it places the point inside its area of use as read, or only with
        easting and northing swapped (then read swapped, as a confirmation with swap_axes would); otherwise
        it is asked as unconfirmed.
        """
        c = self.result.header.coordinates
        coords: dict[str, Any] = {}
        for key, value in (
            ("x_raw", c.x_raw),
            ("y_raw", c.y_raw),
            ("axis_labels_raw", c.labels_raw),
            ("coordinate_system", c.system_raw),
        ):
            coords[key] = self.text(self.prov, f"metadata.coordinates.{key}", value)
        meta["coordinates"] = coords
        x_text, y_text = coords["x_raw"], coords["y_raw"]
        if x_text is None and y_text is None:
            return "unknown", None, None, False
        parsed = coordinates_parser.parse_coordinates(x_text, y_text, coords["axis_labels_raw"], self.style)
        point = self._point(parsed)
        if point is None:
            self.warnings.append(f"coordinates not read: {parsed.reason or 'no position'}")
            return "unknown", None, None, False
        # Values in the source system (a geographic system's longitude is its easting-like value); the
        # review service derives WGS84 latitude/longitude once the system is stated or confirmed.
        coords["local_x"], coords["local_y"] = point
        for key, number in (("local_x", point[0]), ("local_y", point[1])):
            self.prov[f"metadata.coordinates.{key}"] = self._axis_entry(number, c.x_raw, c.y_raw)
        system = coords["coordinate_system"]
        resolved = crs_parser.resolve_printed_system(system, parsed)
        code = resolved.code
        order_doubtful = parsed.order_assumed and code is not None and _swap_on_land(code, *point)
        inside = code is not None and _inside_area(code, *point)
        if code is not None and inside and not order_doubtful:
            coords["crs_code"] = code
            return "stated", code, resolved.reason, False
        if code is not None and not inside and _inside_area(code, *point, swap_axes=True):
            swapped_note = (
                f"the printed system '{system}' ({code}) places the point inside its area of use only with "
                "easting and northing swapped; read swapped"
            )
            self.warnings.append(f"coordinate axes swapped: {swapped_note}")
            coords["crs_code"] = code
            return "stated", code, swapped_note, True
        note: str | None
        if order_doubtful:
            note = (
                f"the axis order is not printed and the position read with '{system}' is far from land, "
                "the swapped one is not; asked as unconfirmed"
            )
        elif resolved.code is not None:
            note = (
                f"the printed system '{system}' ({resolved.code}) does not place the point "
                "inside its area of use; asked as unconfirmed"
            )
        else:
            note = resolved.reason
        if system is not None:
            self.warnings.append(f"coordinate system not stated: {note}")
        return "inferred", None, note, False

    @staticmethod
    def _point(parsed: CoordinateResult) -> tuple[float, float] | None:
        if parsed.kind == "projected" and parsed.local_x is not None and parsed.local_y is not None:
            return parsed.local_x, parsed.local_y
        if parsed.kind == "geographic" and parsed.latitude is not None and parsed.longitude is not None:
            return parsed.longitude, parsed.latitude
        return None

    def _axis_entry(self, number: float, x: RawValue, y: RawValue) -> ProvenanceIn:
        """Cite the printed value that reads as `number`, else both printed values."""
        matches = []
        for value in (x, y):
            raw = printed(value)
            parsed = numbers.parse_number(raw, style=self.style).value if raw is not None else None
            if parsed is not None and abs(parsed - number) <= 1e-9 * max(1.0, abs(number)):
                matches.append(value)
        if len(matches) == 1:
            return self.cite.entry(matches[0])
        return self.cite.entry(x, y)

    # -- arrays ----------------------------------------------------------------------------------

    def layer(self, index: int, layer: ExtractedLayer) -> _Item | None:
        item = _Item({})
        top = self.depth_value(item.prov, "depth_from_m", layer.from_raw)
        bottom = self.depth_value(item.prov, "depth_to_m", layer.to_raw)
        if top is None or bottom is None:
            self.warnings.append(
                f"layer {index + 1}: unreadable layer interval "
                f"'{layer.from_raw.raw or ''}' to '{layer.to_raw.raw or ''}'; layer not created"
            )
            dropped = [id(entry) for entry in item.prov.values()]
            self.guessed = [g for g in self.guessed if id(g.provenance) not in dropped]
            return None
        item.data.update({"depth_from_m": top, "depth_to_m": bottom})
        item.order = (top, bottom, float(index))
        description = self.text(item.prov, "original_description", layer.description_raw)
        item.data["original_description"] = description
        language = (layer.description_language or "").strip() or None
        item.data["description_language"] = language
        english = (layer.english_lithology or "").strip() or None
        has_description = description is not None and "original_description" in item.prov
        item.data["english_lithology"] = english if has_description else None
        self._din(item, index, layer, description, language)
        for key, value in (
            ("uscs_group", layer.uscs_raw),
            ("colour", layer.colour_raw),
            ("consistency_density", layer.consistency_raw),
            ("moisture", layer.moisture_raw),
            ("weathering", layer.weathering_raw),
            ("stratigraphic_name", layer.stratigraphic_name_raw),
        ):
            item.data[key] = self.text(item.prov, key, value)
        return item

    def _din(
        self, item: _Item, index: int, layer: ExtractedLayer, description: str | None, language: str | None
    ) -> None:
        model_text = (layer.din4023_code or "").strip() or None
        model_code = lithology.valid_din_code(model_text)
        if model_text is not None and model_code is None:
            self.warnings.append(f"layer {index + 1}: '{model_text}' is not a DIN 4023 code")
        if description is None:
            if model_code is not None:
                self.warnings.append(f"layer {index + 1}: DIN code without a printed description dropped")
            return
        text_code = lithology.din_code_from_text(description, language)
        code: str | None = None
        method: MethodLiteral = "derived"
        if model_code is not None:
            # The model's reading of the description; derived when the vocabulary agrees with it.
            code, method = model_code, "derived" if text_code == model_code else "guessed"
        elif text_code is not None:
            code = text_code
        item.data["din4023_code"] = code
        if code is not None:
            item.prov["din4023_code"] = self.cite.entry(layer.description_raw, method=method, raw=description)
        notation = (layer.din4023_notation or "").strip() or None
        item.data["din4023_notation"] = notation
        if notation is not None:
            item.prov["din4023_notation"] = self.cite.entry(
                layer.description_raw, method="guessed", raw=description
            )

    @staticmethod
    def layer_at(layers: Sequence[_Item], depth: float) -> _Item | None:
        """The first layer whose interval holds `depth` (the deepest layer includes its bottom)."""
        for i, item in enumerate(layers):
            top, bottom = item.data["depth_from_m"], item.data["depth_to_m"]
            low, high = min(top, bottom), max(top, bottom)
            if low <= depth < high or (i == len(layers) - 1 and depth == high):
                return item
        return None

    def spt(self, layers: Sequence[_Item]) -> None:
        window = spt_parser.duplicate_window_m()
        seen: list[tuple[float, str | None, str | None]] = []
        for j, test in enumerate(self.result.spt):
            blows, n_text = printed(test.blows_raw), printed(test.n_raw)
            note = printed(test.increment_note_raw)
            if blows is None and n_text is None:
                continue
            depth, guessed = self.depth(test.depth_raw)
            where = f"SPT {j + 1} ('{blows or n_text}')"
            if depth is None:
                self.warnings.append(f"{where}: depth not readable; not attached to a layer")
                continue
            # One test is printed over its drive interval (e.g. top and base): the same result within one
            # drive length is the same test, listed twice.
            if any(abs(depth - d) <= window and (blows, n_text) == (b, n) for d, b, n in seen):
                self.warnings.append(f"{where} at {depth:g} m repeats a test within {window:g} m; dropped")
                continue
            seen.append((depth, blows, n_text))
            target = self.layer_at(layers, depth)
            if target is None:
                self.warnings.append(f"{where} at {depth:g} m lies outside the logged layers; not attached")
                continue
            if "spt_depth_m" in target.data:
                self.warnings.append(
                    f"{where} at {depth:g} m: the layer already holds the SPT at "
                    f"{target.data['spt_depth_m']:g} m (first kept)"
                )
                continue
            result = spt_parser.parse_spt(blows, n_text, note)
            data, prov = target.data, target.prov
            data["spt_depth_m"] = depth
            entry = self.cite.entry(test.depth_raw, method="guessed" if guessed else None)
            prov["spt_depth_m"] = entry
            raw = printed(test.depth_raw)
            if guessed and raw is not None:
                self.guessed.append(GuessedDepth(raw, depth, entry))
            raw_source = test.blows_raw if blows is not None else test.n_raw
            data["spt_raw"] = blows or n_text
            prov["spt_raw"] = self.cite.entry(raw_source)
            if result.increments is not None:
                data["spt_increments"] = result.increments
                prov["spt_increments"] = self.cite.entry(raw_source)  # increments may sit in the N text
            if result.n_value is not None:
                data["spt_n_value"] = result.n_value
                if result.printed_n is not None and n_text is not None:
                    prov["spt_n_value"] = self.cite.entry(test.n_raw)
                elif result.printed_n is not None:
                    prov["spt_n_value"] = self.cite.entry(test.blows_raw)
                else:  # computed from the increments and the scheme
                    prov["spt_n_value"] = self.cite.entry(
                        test.blows_raw, test.increment_note_raw, raw=blows, method="derived"
                    )
            if result.refusal is not None:
                data["spt_refusal"] = result.refusal
                prov["spt_refusal"] = self.cite.entry(test.blows_raw, test.n_raw, method="derived")
            if result.increment_mm is not None:
                data["spt_increment_mm"] = result.increment_mm
                prov["spt_increment_mm"] = self.cite.entry(
                    test.increment_note_raw, test.blows_raw, method="derived"
                )
            if result.penetration_cm is not None:
                data["spt_penetration_cm"] = result.penetration_cm
                prov["spt_penetration_cm"] = self.cite.entry(test.blows_raw, test.n_raw, method="derived")
            if result.reason:
                self.warnings.append(f"{where}: {result.reason}")

    def core_runs(self, layers: Sequence[_Item]) -> None:
        runs: list[tuple[float, float, int]] = []
        for k, run in enumerate(self.result.core_runs):
            top, _ = self.depth(run.from_raw)
            bottom, _ = self.depth(run.to_raw)
            if top is None or bottom is None:
                self.warnings.append(f"core run {k + 1}: interval not readable; not mapped to layers")
                continue
            runs.append((min(top, bottom), max(top, bottom), k))
        used: set[int] = set()
        for item in layers:
            top, bottom = sorted((item.data["depth_from_m"], item.data["depth_to_m"]))
            best: tuple[float, int] | None = None
            for run_top, run_bottom, k in runs:
                overlap = min(bottom, run_bottom) - max(top, run_top)
                if overlap > 0 and (best is None or overlap > best[0]):
                    best = (overlap, k)
            if best is None:
                continue
            run = self.result.core_runs[best[1]]
            used.add(best[1])
            item.data["is_core"] = True
            item.prov["is_core"] = self.cite.entry(run.from_raw, run.to_raw, method="derived")
            for key, value in (("rqd_pct", run.rqd_raw), ("core_recovery_pct", run.tcr_raw)):
                raw = printed(value)
                number = units.parse_percent(raw, style=self.style).value if raw is not None else None
                if number is not None and number < 0:
                    self.warnings.append(f"core run {best[1] + 1}: negative {key} '{raw}' not stored")
                    number = None
                item.data[key] = number
                self.keep(item.prov, key, value, number)
        for _, _, k in runs:
            if k not in used:
                self.warnings.append(f"core run {k + 1} overlaps no logged layer")

    def groundwater(self) -> list[_Item]:
        items = []
        for reading in self.result.groundwater:
            item = _Item({"type": reading.type})
            depth = self.depth_value(item.prov, "depth_m", reading.depth_raw)
            date_raw = printed(reading.date_raw)
            date_value = (dates.parse_date(date_raw).iso or date_raw) if date_raw is not None else None
            self.keep(item.prov, "date", reading.date_raw, date_value)
            raw = printed(reading.depth_raw)
            self.keep(item.prov, "raw", reading.depth_raw, raw)
            if depth is None and date_value is None and raw is None and not item.prov:
                continue
            item.data.update({"depth_m": depth, "date": date_value, "raw": raw})
            # The model chose the reading type from the printed symbol or words.
            item.prov["type"] = self.cite.entry(
                reading.depth_raw, reading.date_raw, raw=None, method="guessed"
            )
            items.append(item)
        return items

    def samples(self) -> list[_Item]:
        items = []
        for k, sample in enumerate(self.result.samples):
            item = _Item({})
            name = self.text(item.prov, "name", sample.name_raw)
            if name is None:
                if any(printed(v) for v in (sample.type_raw, sample.from_raw, sample.to_raw)):
                    self.warnings.append(f"sample {k + 1} has no printed name; not created")
                continue
            item.data["name"] = name
            item.data["type_code"] = self.text(item.prov, "type_code", sample.type_raw)
            item.data["depth_from_m"] = self.depth_value(item.prov, "depth_from_m", sample.from_raw)
            item.data["depth_to_m"] = self.depth_value(item.prov, "depth_to_m", sample.to_raw)
            items.append(item)
        return items

    def tests(self) -> list[_Item]:
        items = []
        for k, test in enumerate(self.result.tests):
            name = units.match_lab_test(test.name)
            if name is None:
                self.warnings.append(f"test {k + 1}: '{test.name}' is not a Test Results field; not stored")
                continue
            value_raw, unit_raw = printed(test.value_raw), printed(test.unit_raw)
            if value_raw is None and not self.cite.needed(test.value_raw, None):
                continue
            item = _Item({"name": name})
            value: float | None = None
            qualifier: str | None = None
            unit: str | None = unit_raw
            if value_raw is not None:
                parsed = units.normalise_lab_test_value(name, value_raw, unit_raw, style=self.style)
                value, qualifier = parsed.value, parsed.qualifier
                unit = parsed.unit if parsed.value is not None else (unit_raw or parsed.unit)
                if parsed.value is None:
                    self.warnings.append(f"test {name} '{value_raw}': {parsed.reason or 'not a number'}")
            depth, _ = self.depth(test.depth_raw)
            item.data.update(
                {
                    "value": value,
                    "qualifier": qualifier,
                    "unit": unit,
                    "sample_name": printed(test.sample_raw),
                    "depth_m": depth,
                }
            )
            raw = " ".join(t for t in (value_raw, unit_raw) if t) or None
            item.prov["value"] = self.cite.entry(
                test.value_raw, test.unit_raw, raw=raw, state=None if value_raw else test.value_raw.state
            )
            items.append(item)
        return items

    def total_depth(self, meta: dict[str, Any], layers: Sequence[_Item]) -> None:
        h = self.result.header
        depth = self.depth_value(self.prov, "metadata.borehole_depth_m", h.total_depth)
        if depth is not None and depth < 0:
            self.warnings.append(f"total depth '{printed(h.total_depth)}' is negative; not stored")
            self.guessed = [
                g for g in self.guessed if g.provenance is not self.prov.get("metadata.borehole_depth_m")
            ]
            self.prov.pop("metadata.borehole_depth_m", None)
            depth = None
        if depth is not None:
            meta["borehole_depth_m"] = depth
            meta["borehole_depth_source"] = "printed"
            self.prov["metadata.borehole_depth_source"] = self.cite.entry(h.total_depth, method="derived")
            return
        bottoms = [(item.data["depth_to_m"], item) for item in layers if item.data["depth_to_m"] >= 0]
        if not bottoms:
            return
        if printed(h.total_depth) is not None:
            self.warnings.append(
                f"total depth '{printed(h.total_depth)}' not readable; the last layer's bottom is used"
            )
        bottom, item = max(bottoms, key=lambda pair: pair[0])
        source = item.prov["depth_to_m"]
        method: MethodLiteral = "guessed" if source.method == "guessed" else "derived"
        meta["borehole_depth_m"] = bottom
        meta["borehole_depth_source"] = "last_layer"
        self.prov["metadata.borehole_depth_m"] = source.model_copy(update={"method": method})
        self.prov["metadata.borehole_depth_source"] = source.model_copy(update={"method": "derived"})

    # -- assembly --------------------------------------------------------------------------------

    def build(self) -> RecordDraft:
        h = self.result.header
        label, label_entry = self.label()
        if label is None or label_entry is None:
            self.warnings.append("no borehole label printed or classified; borehole not created")
            return RecordDraft(None, {}, "unknown", None, None, warnings=self.warnings)
        meta: dict[str, Any] = {"borehole_id": label}
        self.prov["metadata.borehole_id"] = label_entry
        for key, value in (
            ("project_name", h.project),
            ("client", h.client),
            ("location_name", h.location),
            ("drilling_contractor", h.contractor),
            ("drilling_method", h.method),
            ("elevation_datum", h.elevation_datum),
            ("notes", h.notes),
        ):
            meta[key] = self.text(self.prov, f"metadata.{key}", value)
        self.depth_origin(meta)  # before any depth: a sign note changes how depths are read
        self.dates(meta)
        self.elevation(meta)
        self.inclination(meta)
        crs_status, crs_code, crs_note, swap_axes = self.coordinates(meta)

        layers = [
            item for i, raw in enumerate(self.result.layers) if (item := self.layer(i, raw)) is not None
        ]
        layers.sort(key=lambda item: item.order)
        self.spt(layers)
        self.core_runs(layers)
        self.total_depth(meta, layers)
        sections = {
            "stratigraphy": layers,
            "groundwater": self.groundwater(),
            "samples": self.samples(),
            "test_results": self.tests(),
        }
        body: dict[str, Any] = {"metadata": meta}
        for section, items in sections.items():
            body[section] = [item.data for item in items]
            for i, item in enumerate(items):
                for key, entry in item.prov.items():
                    self.prov[f"{section}[{i}].{key}"] = entry
        finding, origin, evidence = self.datum_check()
        return RecordDraft(
            body=body,
            provenance=self.prov,
            crs_status=crs_status,
            crs_code=crs_code,
            label=label,
            label_page=label_entry.page,
            label_box=label_entry.box,
            guessed_depths=self.guessed,
            crs_note=crs_note,
            swap_axes=swap_axes,
            warnings=self.warnings,
            datum_finding=finding,
            datum_origin=origin,
            datum_evidence=evidence,
        )

    def datum_check(self) -> tuple[DatumFinding | None, str | None, list[EvidenceEntry]]:
        """Does the printed depth note contradict the printed layer depths (sign kept, printed order)?"""
        h = self.result.header
        note, datum = printed(h.depth_origin_note), printed(h.elevation_datum)
        origin = datums.parse_depth_origin(note, datum)
        intervals = [
            (self.signed_depth(layer.from_raw)[0], self.signed_depth(layer.to_raw)[0])
            for layer in self.result.layers
        ]
        finding = check_datum_convention(origin, intervals)
        if finding is None:
            return None, None, []
        evidence: list[EvidenceEntry] = []
        sources: list[RawValue] = [h.depth_origin_note, h.elevation_datum]
        for layer in self.result.layers:
            sources += [layer.from_raw, layer.to_raw]
        limit = int(document_checks_section("datum_convention")["evidence_max"])
        for value in sources:
            text_value = printed(value)
            if text_value is None or len(evidence) >= limit:
                continue
            entry = self.cite.entry(value)
            if entry.page is not None and not any(
                (e.page, e.box) == (entry.page, entry.box) for e in evidence
            ):
                evidence.append(
                    EvidenceEntry(entry.document_id or self.document_id, entry.page, entry.box, text_value)
                )
        return finding, origin.origin, evidence


def build_record(
    document_id: str,
    group: PageGroup,
    outcome: ExtractionOutcome,
    *,
    text_layers: Mapping[int, PageText] | None = None,
) -> RecordDraft:
    """Normalise one group's extraction into a record body with provenance (no database access).

    `text_layers`: trustworthy text layers of the cited pages by page number; values printed in them get
    the box of their words and method `read`.
    """
    return _Builder(document_id, group, outcome, text_layers).build()


# ----------------------------------------------------------------------------------------------
# Database helpers
# ----------------------------------------------------------------------------------------------


async def _lock_document(session: AsyncSession, document_id: str) -> Document | None:
    """FOR NO KEY UPDATE: finalisation of one document runs one step at a time."""
    return await session.scalar(
        select(Document)
        .where(Document.id == document_id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )


async def load_text_layers(
    session: AsyncSession, document_id: str, pages: Iterable[int]
) -> dict[int, PageText]:
    """Stored text layers of `pages` whose quality makes them trustworthy. A missing or unreadable file is
    skipped: the values on that page keep the boxes of their OCR blocks."""
    wanted = sorted(set(pages))
    if not wanted:
        return {}
    threshold = textlayer.config().read_min_text_quality
    rows = (
        await session.execute(
            select(Page.n, Page.text_layer_key, Page.text_layer_quality).where(
                Page.document_id == document_id,
                Page.n.in_(wanted),
                Page.text_layer_key.is_not(None),
                Page.text_layer_quality >= threshold,
            )
        )
    ).all()
    storage = get_storage()
    layers: dict[int, PageText] = {}
    for n, key, quality in rows:
        if key is None:
            continue
        try:
            payload = json.loads(await asyncio.to_thread(storage.get_bytes, key))
        except (OSError, ValueError, StorageKeyError) as exc:
            logger.warning(
                "document %s page %s: text layer not readable (%s)", document_id, n, type(exc).__name__
            )
            continue
        if isinstance(payload, dict):
            layers[n] = textlayer.page_text_from_payload(n, payload, quality=quality)
    return layers


async def _existing_uid(session: AsyncSession, document_id: str, group_key: str) -> str | None:
    return await session.scalar(
        select(Borehole.uid).where(Borehole.document_id == document_id, Borehole.group_key == group_key)
    )


async def _reemit(session: AsyncSession, row: Clarification) -> None:
    """A changed question is sent again in full (the inbox replaces it by id)."""
    await session.flush()
    await emit(
        session,
        "clarification.created",
        clarification_out(row).model_dump(mode="json"),
        document_id=row.document_id,
    )


async def _set_boreholes_extracted(session: AsyncSession, doc: Document) -> None:
    count = await session.scalar(
        select(func.count()).select_from(Borehole).where(Borehole.document_id == doc.id)
    )
    progress = dict(doc.progress or {})
    if not {"pages_total", "pages_classified", "pages_ocr_total", "pages_ocr_done"} <= set(progress):
        row = (
            await session.execute(
                select(
                    func.count(),
                    func.count().filter(Page.role.is_not(None)),
                    func.count().filter(Page.used.is_(True)),
                    func.count().filter(Page.ocr_status == "done"),
                ).where(Page.document_id == doc.id)
            )
        ).one()
        for key, value in zip(
            ("pages_total", "pages_classified", "pages_ocr_total", "pages_ocr_done"), row, strict=True
        ):
            progress.setdefault(key, int(value))
    progress["boreholes_extracted"] = int(count or 0)
    doc.progress = progress
    doc.updated_at = _now()


def _evidence(document_id: str, entry: ProvenanceIn, snippet: str | None) -> dict[str, Any] | None:
    if entry.page is None:
        return None
    return {
        "document_id": entry.document_id or document_id,
        "page": entry.page,
        "box": entry.box,
        "snippet": snippet,
    }


async def _ask_depth_unit(session: AsyncSession, doc: Document, uid: str, draft: RecordDraft) -> None:
    """One question per document: its depths were printed without a unit and are stored as metres."""
    key = f"unit_ambiguous:depth:{doc.id}"
    existing = await session.scalar(select(Clarification).where(Clarification.dedupe_key == key))
    if existing is not None:
        if existing.status != "answered" and uid not in (existing.borehole_uids or []):
            existing.borehole_uids = [*(existing.borehole_uids or []), uid]
            await _reemit(session, existing)
        return
    # The deepest value illustrates the question best; its source comes first in the evidence.
    example = max(draft.guessed_depths, key=lambda g: abs(g.value))
    shown = [example, *(g for g in draft.guessed_depths if g is not example)][:UNIT_EVIDENCE_MAX]
    evidence = [e for g in shown if (e := _evidence(doc.id, g.provenance, g.raw)) is not None]
    await create_clarification(
        session,
        kind="unit_ambiguous",
        document_id=doc.id,
        question=(
            f"The depths in {doc.file_name} are printed without a unit (for example '{example.raw}'). "
            "They are stored as metres for now and marked as guessed. Which unit are they in?"
        ),
        fields=[
            {
                "name": "depth_unit",
                "widget": "number_unit",
                "label": "Depth unit",
                "help": f"Borehole {draft.label}: the value printed as '{example.raw}'.",
                "required": True,
                "unit_options": list(DEPTH_UNIT_OPTIONS),
                "default": example.value,
            }
        ],
        evidence=evidence,
        borehole_uids=[uid],
        project=doc.project,
        dedupe_key=key,
    )


async def _ask_boundary(
    session: AsyncSession, doc: Document, uid: str, group: PageGroup, draft: RecordDraft
) -> None:
    reasons = "; ".join(r.strip() for r in group.uncertain if r.strip())
    pages = sorted(set(group.pages))
    evidence = [
        {
            "document_id": doc.id,
            "page": page,
            "box": draft.label_box if page == draft.label_page else None,
            "snippet": draft.label if page == draft.label_page else None,
        }
        for page in pages
    ]
    span = f"pages {pages[0]}-{pages[-1]}" if len(pages) > 1 else f"page {pages[0]}" if pages else "no pages"
    await create_clarification(
        session,
        kind="borehole_boundary",
        document_id=doc.id,
        question=(
            f"Borehole {draft.label} was read from {span}, but the grouping is uncertain"
            f"{f' ({reasons})' if reasons else ''}. Which pages belong to {draft.label}?"
        ),
        fields=[
            {
                "name": "pages",
                "widget": "page_range",
                "label": f"Pages of {draft.label}",
                "required": True,
                "default": [pages[0], pages[-1]] if pages else None,
            }
        ],
        evidence=evidence,
        borehole_uids=[uid],
        project=doc.project,
        dedupe_key=f"borehole_boundary:{doc.id}:{group.key}",
    )


# ----------------------------------------------------------------------------------------------
# Public stages
# ----------------------------------------------------------------------------------------------


async def finalize_group(document_id: str, group: PageGroup, outcome: ExtractionOutcome) -> str | None:
    """Create the borehole of one page group; returns its uid (the existing one on a rerun).

    Returns None when the document is gone or the group has no label to create a borehole under.
    """
    async with get_sessionmaker()() as session:
        doc = await _lock_document(session, document_id)
        if doc is None:
            return None
        existing = await _existing_uid(session, document_id, group.key)
        if existing is not None:
            return existing
        cited_pages = {block.page for block in outcome.blocks.values()}
        layers = await load_text_layers(session, document_id, cited_pages)
        draft = build_record(document_id, group, outcome, text_layers=layers)
        for warning in draft.warnings:
            logger.warning("document %s group %s: %s", document_id, group.key, warning)
        if draft.body is None:
            return None
        try:
            bh = await create_borehole(
                session,
                document=doc,
                group_key=group.key,
                body=draft.body,
                provenance=draft.provenance,
                crs_status=draft.crs_status,
                crs_code=draft.crs_code,
                swap_axes=draft.swap_axes,
                pages=group.pages,
                actor=ACTOR,
            )
        except IntegrityError:
            # Created by a concurrent run between our check and insert: that one stands.
            await session.rollback()
            return await _existing_uid(session, document_id, group.key)
        if draft.guessed_depths:
            await _ask_depth_unit(session, doc, bh.uid, draft)
        if group.uncertain:
            await _ask_boundary(session, doc, bh.uid, group, draft)
        if draft.datum_finding is not None:
            await ask_datum_convention(
                session,
                doc,
                uid=bh.uid,
                label=draft.label or bh.label_raw,
                finding=draft.datum_finding,
                origin=draft.datum_origin,
                evidence=draft.datum_evidence,
            )
        await _set_boreholes_extracted(session, doc)
        await emit_document_updated(session, doc)
        await session.commit()
        return bh.uid


async def _completeness(session: AsyncSession, doc: Document) -> dict[str, Any] | None:
    """Labels printed on the document's summary and coordinate tables against its boreholes' labels.

    None when the document prints no such list (nothing to compare with).
    """
    label_lists = (
        await session.scalars(
            select(Page.borehole_labels)
            .where(Page.document_id == doc.id, Page.role.in_(EXPECTED_ID_ROLES))
            .order_by(Page.n)
        )
    ).all()
    expected = _unique_labels(label for labels in label_lists for label in (labels or []))
    if not expected:
        return None
    rows = (
        await session.execute(
            select(Borehole.label_raw, Borehole.aliases)
            .where(Borehole.document_id == doc.id)
            .order_by(Borehole.label_canonical, Borehole.uid)
        )
    ).all()
    found = _unique_labels(label for label, _ in rows)
    found_keys = {
        canonical_label(name) for label, aliases in rows for name in [label, *(aliases or [])] if name
    }
    expected_keys = {canonical_label(label) for label in expected}
    return Completeness(
        expected_ids=expected,
        found_ids=found,
        missing=[label for label in expected if canonical_label(label) not in found_keys],
        unexpected=[label for label in found if canonical_label(label) not in expected_keys],
    ).model_dump(mode="json")


def _unique_labels(labels: Iterable[str | None]) -> list[str]:
    """Labels as printed, first spelling of each canonical label, in order."""
    seen: set[str] = set()
    out: list[str] = []
    for label in labels:
        text_value = (label or "").strip()
        key = canonical_label(text_value) if text_value else ""
        if key and key not in seen:
            seen.add(key)
            out.append(text_value)
    return out


async def _crs_question_parts(
    session: AsyncSession, doc: Document, boreholes: Sequence[Borehole], project: str | None
) -> dict[str, Any]:
    uids = [bh.uid for bh in boreholes]
    rows = (
        await session.scalars(
            select(FieldValue).where(
                FieldValue.uid.in_(uids), FieldValue.path.in_((X_RAW, Y_RAW, SYSTEM_RAW))
            )
        )
    ).all()
    by_uid: dict[str, dict[str, FieldValue]] = {}
    for fv in rows:
        by_uid.setdefault(fv.uid, {})[fv.path] = fv
    evidence: list[dict[str, Any]] = []
    systems: list[str] = []
    for bh in boreholes:
        fvs = by_uid.get(bh.uid, {})
        x, y, system = fvs.get(X_RAW), fvs.get(Y_RAW), fvs.get(SYSTEM_RAW)
        if system is not None and isinstance(system.value, str) and system.value not in systems:
            systems.append(system.value)
        if x is None or x.page is None:
            continue
        snippet = " ".join(str(v.value) for v in (x, y) if v is not None and v.value is not None) or None
        evidence.append(
            {"document_id": x.document_id or bh.document_id, "page": x.page, "box": x.box, "snippet": snippet}
        )
    candidates = await candidates_for_boreholes(session, boreholes)
    options: list[dict[str, Any]] = []
    for candidate in candidates:
        if any(option["value"] == candidate.crs for option in options):
            continue  # the swapped reading of a system already offered: chosen with swap_axes
        option: dict[str, Any] = {"value": candidate.crs, "label": candidate.label}
        if evidence:
            option["evidence"] = evidence[0]
        options.append(option)
    count = len(boreholes)
    subject = f"{count} borehole{'s' if count != 1 else ''}"
    where = f"project '{project}'" if project else doc.file_name
    printed_systems = (
        f" The logs print {', '.join(repr(s) for s in systems)}, which does not place them."
        if systems
        else ""
    )
    return {
        "question": (
            f"Which coordinate system do the printed coordinates of {subject} in {where} use?"
            f"{printed_systems}"
        ),
        "fields": [
            {
                "name": "crs",
                "widget": "crs_picker",
                "label": "Coordinate system",
                "help": candidates[0].note if candidates else "No listed system fits the printed values.",
                "required": True,
                "options": options,
            },
            {
                "name": "swap_axes",
                "widget": "boolean",
                "label": "Swap easting and northing",
                "required": False,
                "default": bool(candidates[0].swap_axes) if candidates else False,
            },
        ],
        "evidence": evidence,
    }


async def _ask_crs(session: AsyncSession, doc: Document) -> None:
    """One crs_confirm question per project (or per document) for boreholes without a stated system.

    An open question of the project grows to cover boreholes of later documents; boreholes already asked
    about in another question (open, skipped or answered) are not asked about again.
    """
    project = (doc.project or "").strip() or None
    scope = f"project:{project.casefold()}" if project else f"document:{doc.id}"
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": f"crs_confirm:{scope}"}
    )
    query = select(Borehole).where(Borehole.crs_status == "inferred")
    questions_query = select(Clarification).where(Clarification.kind == "crs_confirm")
    if project is not None:
        query = query.join(Document, Document.id == Borehole.document_id).where(
            func.lower(func.btrim(Document.project)) == project.casefold()
        )
        questions_query = questions_query.where(
            func.lower(func.btrim(Clarification.project)) == project.casefold()
        )
    else:
        query = query.where(Borehole.document_id == doc.id)
        questions_query = questions_query.where(
            Clarification.document_id == doc.id, Clarification.project.is_(None)
        )
    boreholes = (await session.scalars(query.order_by(Borehole.document_id, Borehole.uid))).all()
    if not boreholes:
        return
    questions = (
        await session.scalars(questions_query.order_by(Clarification.created_at, Clarification.id))
    ).all()
    open_question = next((q for q in questions if q.status == "open"), None)
    asked = {uid for q in questions if q is not open_question for uid in (q.borehole_uids or [])}
    targets = [bh for bh in boreholes if bh.uid not in asked]
    if not targets:
        return
    target_uids = [bh.uid for bh in targets]
    if open_question is not None and set(target_uids) <= set(open_question.borehole_uids or []):
        return
    parts = await _crs_question_parts(session, doc, targets, project)
    if open_question is not None:
        open_question.borehole_uids = target_uids
        open_question.question = parts["question"]
        open_question.fields = parts["fields"]
        open_question.evidence = parts["evidence"]
        await _reemit(session, open_question)
        return
    documents = sorted({bh.document_id for bh in targets})
    await create_clarification(
        session,
        kind="crs_confirm",
        document_id=doc.id,
        question=parts["question"],
        fields=parts["fields"],
        evidence=parts["evidence"],
        borehole_uids=target_uids,
        project=project,
        dedupe_key=f"crs_confirm:{_digest(scope + '|' + ','.join(documents) + '|' + ','.join(target_uids))}",
    )


async def finalize_document(document_id: str) -> None:
    """Completeness, duplicates of earlier documents, coordinate-system and location questions, the lint
    across the document's boreholes, progress and status after every group is finalised."""
    async with get_sessionmaker()() as session:
        doc = await _lock_document(session, document_id)
        if doc is None:
            return
        doc.completeness = await _completeness(session, doc)
        await refresh_duplicate_of(session, doc)
        await ask_duplicates(session, doc)
        await _ask_crs(session, doc)
        await ask_locate_boreholes(session, doc)
        await refresh_document_checks(session, doc.id, actor=ACTOR)
        await _set_boreholes_extracted(session, doc)
        doc.status = "needs_review"
        await session.flush()
        # done when every borehole is approved; refresh_document_status emits when it changes the status
        await refresh_document_status(session, doc.id)
        if doc.status == "needs_review":
            await emit_document_updated(session, doc)
        await session.commit()
