"""Fictional demo seed. FICTIONAL DEMO DATA ONLY: every project, site, client, company and value is invented.

    python -m app.seed            load the demo documents (skipped when they are already loaded)
    python -m app.seed --remove   delete exactly the seeded documents (is_seed) and their files

Nothing seeds itself on start. The data covers every state the UI shows: document statuses, page types
and roles, handwriting, duplicates, review statuses, provenance status/state/method, readings that
disagree, lint findings, every unplotted reason and every clarification kind except chat_parameter.
Boreholes are created only through `app.review.service.create_borehole`, so WGS84 positions, rock head,
lint and placement come from the same code the pipeline uses. Values that are not printed stay null.

Coordinates are plausible positions in Germany, Australia, New Zealand, the USA and Chile (so the map
shows several clusters); nothing is copied from a real report.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import zlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.service import create_clarification, resolve_clarification
from app.db.models import Borehole, Clarification, Document, Page
from app.db.session import dispose_engine, get_sessionmaker
from app.events.writer import emit
from app.ids import new_id
from app.review.service import apply_patch, commit_change, create_borehole, load_field_values
from app.schemas.boreholes import ProvenanceIn, Reading, ValuePatch
from app.seed_pages import (
    Anchor,
    BlankPage,
    Cell,
    Column,
    Correction,
    Hand,
    MultiLogPage,
    PageSpec,
    PhotoPage,
    PlanPage,
    Sheet,
    Smudge,
    TablePage,
    TextPage,
    draw_page,
    pdf_bytes,
    png_bytes,
    thumbnail_png,
)
from app.services.documents import emit_document_updated, page_type_for, unused_reason_for
from app.storage import (
    FileStorage,
    document_prefix,
    get_storage,
    original_key,
    page_render_key,
    page_thumb_key,
)

REVIEWER = "Demo Reviewer (fictional)"
FT = 0.3048

# --------------------------------------------------------------------------------------------------
# Spec types
# --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Ref:
    """A drawn value: page number and anchor key on that page."""

    page: int
    key: str


@dataclass
class Pv:
    """Provenance of one value; box and raw text come from the drawn anchor."""

    ref: Ref | None
    method: str | None = None  # None: the document's default (read or ocr)
    confidence: float | None = None  # None: from the method and whether the value is handwritten
    status: str = "unreviewed"
    state: str = "ok"
    flag: str | None = None
    readings: list[tuple[str, str, float]] = field(default_factory=list)
    raw: str | None = "<anchor>"
    cell: str | None = None


@dataclass
class PageMeta:
    spec: PageSpec
    role: str | None
    language: str | None = "en"
    handwriting: str | None = "none"
    labels: list[str] = field(default_factory=list)
    sheet: tuple[str, int, int] | None = None  # label as printed, index, total
    has_coordinates: bool | None = False
    ocr: str | None = "done"
    used: bool = True
    confidence: float | None = 0.95
    reason: str = ""
    duplicate_of: tuple[str, int] | None = None  # (document key, page n)


@dataclass
class BoreholeSpec:
    label: str
    body: dict[str, Any]
    prov: dict[str, Pv]
    pages: list[int]
    crs_status: str
    crs_code: str | None = None
    edits: list[tuple[str, Any]] = field(default_factory=list)  # reviewer edits applied after creation
    approve_all: bool = False


@dataclass
class DocSpec:
    key: str
    file_name: str
    project: str | None
    status: str
    stage: str | None
    method: str  # default provenance method: read (good text layer) or ocr (scans)
    text_layer_quality: float
    pages: list[PageMeta]
    boreholes: list[BoreholeSpec] = field(default_factory=list)
    expected_ids: list[str] | None = None
    error: str | None = None
    progress: dict[str, int] | None = None


@dataclass
class RenderedDoc:
    spec: DocSpec
    sheets: list[Sheet]
    pdf: bytes
    sha256: str


@dataclass
class SeedSummary:
    documents: int
    boreholes: int
    plotted: int
    clarifications: int
    open_clarifications: int


# --------------------------------------------------------------------------------------------------
# Small builders shared by the documents
# --------------------------------------------------------------------------------------------------


def text_of(cell: Cell) -> str | None:
    if cell is None:
        return None
    if isinstance(cell, Correction):
        return cell.hand.text
    if isinstance(cell, Hand | Smudge):
        return cell.text
    return cell


def num(cell: Cell, factor: float = 1.0) -> float | None:
    """Parse a printed depth/percentage ('2,10', '9.45', '18,00 m'); decimal comma or point."""
    text = text_of(cell)
    if text is None:
        return None
    cleaned = text.replace("m", "").replace(" ", "").replace(",", ".").strip()
    value = float(cleaned)
    return round(value * factor, 3) if factor != 1.0 else value


@dataclass
class LayerDef:
    top: Cell
    bottom: Cell
    desc: Cell
    code: str | None  # din4023_code for the record (printed in the DIN column, or derived from the text)
    en: str
    din: Cell = None  # printed DIN column
    notation: str | None = None
    uscs: Cell = None
    spt: Cell = None  # printed blows / N
    n: Cell = None  # printed N in its own column
    spt_n: int | None = None
    refusal: bool | None = None
    increments: list[int] | None = None
    increment_mm: int | None = None
    penetration_cm: float | None = None
    tcr: Cell = None
    rqd: Cell = None
    colour: str | None = None
    consistency: str | None = None


def layer_rows(layers: Sequence[LayerDef], start: int = 0) -> list[tuple[str, dict[str, Cell]]]:
    rows = []
    for i, layer in enumerate(layers, start=start):
        cells: dict[str, Cell] = {
            "from": layer.top,
            "to": layer.bottom,
            "desc": layer.desc,
            "din": layer.din,
            "uscs": layer.uscs,
            "spt": layer.spt,
            "n": layer.n,
            "tcr": layer.tcr,
            "rqd": layer.rqd,
        }
        rows.append((f"L{i}", cells))
    return rows


def layer_records(
    layers: Sequence[LayerDef], pages: Sequence[int], *, language: str, factor: float = 1.0
) -> tuple[list[dict[str, Any]], dict[str, Pv]]:
    """Record layers and their provenance; `pages[i]` is the page layer i is drawn on (anchor `L{i}.*`)."""
    records: list[dict[str, Any]] = []
    prov: dict[str, Pv] = {}
    for i, layer in enumerate(layers):
        n = pages[i]
        base = f"stratigraphy[{i}]"
        spt_text = text_of(layer.spt)
        has_spt = layer.spt is not None and spt_text not in ("-", "")
        legible = has_spt and not isinstance(layer.spt, Smudge)
        records.append(
            {
                "depth_from_m": num(layer.top, factor),
                "depth_to_m": num(layer.bottom, factor),
                "original_description": text_of(layer.desc),
                "description_language": language,
                "english_lithology": layer.en,
                "din4023_code": layer.code,
                "din4023_notation": layer.notation or layer.code,
                "uscs_group": text_of(layer.uscs),
                "colour": layer.colour,
                "consistency_density": layer.consistency,
                "is_core": True if layer.tcr is not None else None,
                "core_recovery_pct": num(layer.tcr) if layer.tcr is not None else None,
                "rqd_pct": num(layer.rqd) if layer.rqd is not None else None,
                "spt_n_value": layer.spt_n,
                "spt_raw": spt_text if legible else None,
                "spt_refusal": bool(layer.refusal) if legible else None,
                "spt_increments": layer.increments,
                "spt_increment_mm": layer.increment_mm,
                "spt_penetration_cm": layer.penetration_cm,
            }
        )
        prov[f"{base}.depth_from_m"] = Pv(Ref(n, f"L{i}.from"))
        prov[f"{base}.depth_to_m"] = Pv(Ref(n, f"L{i}.to"))
        prov[f"{base}.original_description"] = Pv(Ref(n, f"L{i}.desc"))
        if layer.code is not None:
            if layer.din is not None:
                prov[f"{base}.din4023_code"] = Pv(Ref(n, f"L{i}.din"))
            else:
                # Not printed: mapped from the description by the DIN vocabulary.
                prov[f"{base}.din4023_code"] = Pv(
                    Ref(n, f"L{i}.desc"), method="derived", confidence=0.86, raw=None
                )
        if layer.uscs is not None:
            prov[f"{base}.uscs_group"] = Pv(Ref(n, f"L{i}.uscs"))
        if has_spt:
            if layer.refusal:
                prov[f"{base}.spt_refusal"] = Pv(Ref(n, f"L{i}.spt"))
                prov[f"{base}.spt_raw"] = Pv(Ref(n, f"L{i}.spt"))
            elif isinstance(layer.spt, Smudge):
                prov[f"{base}.spt_n_value"] = Pv(
                    Ref(n, f"L{i}.spt"), state="illegible", confidence=0.31, raw=None
                )
            else:
                key = f"L{i}.n" if layer.n is not None else f"L{i}.spt"
                prov[f"{base}.spt_n_value"] = Pv(Ref(n, key))
        if layer.tcr is not None:
            prov[f"{base}.core_recovery_pct"] = Pv(Ref(n, f"L{i}.tcr"))
        if layer.rqd is not None:
            prov[f"{base}.rqd_pct"] = Pv(Ref(n, f"L{i}.rqd"))
    return records, prov


def metadata(**values: Any) -> dict[str, Any]:
    meta: dict[str, Any] = {"aliases": [], "coordinates": {}}
    coords = values.pop("coordinates", {})
    meta.update(values)
    meta["coordinates"].update(coords)
    return meta


def header_prov(n: int, mapping: dict[str, str], **overrides: Pv) -> dict[str, Pv]:
    """`mapping`: record path -> anchor key on page n."""
    prov = {path: Pv(Ref(n, key)) for path, key in mapping.items()}
    prov.update({path.replace("__", "."): pv for path, pv in overrides.items()})
    return prov


def merge(*parts: dict[str, Pv]) -> dict[str, Pv]:
    out: dict[str, Pv] = {}
    for part in parts:
        out.update(part)
    return out


# --------------------------------------------------------------------------------------------------
# Document 1: Germany, scanned bridge investigation (needs_review, completeness with a missing hole)
# --------------------------------------------------------------------------------------------------

DE_CO = "Geotechnik Brandt & Okafor GmbH (fictional)"
DE_PROJECT = "Talbruecke Kesselbach"
DE_CLIENT = "Strassenbauamt Musterland (fictional)"
DE_FILE = "fictional-kesselbach-talbruecke-bohrprofile.pdf"
DE_CONTRACTOR = "Bohrtechnik Lenz KG (fictional)"

DE_SOIL_COLS = [
    Column("from", "von\n(m)", 90),
    Column("to", "bis\n(m)", 90),
    Column("desc", "Bodenart / Beschreibung", 560),
    Column("din", "DIN\n4023", 90),
    Column("spt", "SPT\nN30", 90),
]
DE_ROCK_COLS = [
    Column("from", "von\n(m)", 90),
    Column("to", "bis\n(m)", 90),
    Column("desc", "Gestein / Beschreibung", 470),
    Column("din", "DIN\n4023", 90),
    Column("tcr", "TCR\n(%)", 90),
    Column("rqd", "RQD\n(%)", 90),
]

KB1_LAYERS = [
    LayerDef(
        "0,00",
        "0,30",
        "Mutterboden, Schluff, humos, dunkelbraun",
        "Mu",
        "Topsoil: humic silt, dark brown",
        din="Mu",
    ),
    LayerDef(
        "0,30",
        "2,10",
        "Schluff, tonig, schwach feinsandig, braun, steif",
        "U",
        "Clayey silt, slightly fine sandy, brown, stiff",
        din="U",
        notation="U, t, fs'",
        spt="9",
        spt_n=9,
        colour="braun",
        consistency="steif",
    ),
    LayerDef(
        "2,10",
        "4,60",
        "Mittelkies, sandig, schwach schluffig, graubraun, mitteldicht",
        "mG",
        "Medium gravel, sandy, slightly silty, grey-brown, medium dense",
        din="mG",
        notation="mG, s, u'",
        spt="24",
        spt_n=24,
        consistency="mitteldicht",
    ),
    LayerDef(
        "4,60",
        "7,80",
        "Feinsand, schluffig, grau, dicht",
        "fS",
        "Fine sand, silty, grey, dense",
        din="fS",
        notation="fS, u",
        spt="38",
        spt_n=38,
        consistency="dicht",
    ),
    LayerDef(
        "7,80",
        "9,50",
        "Tonstein, stark verwittert bis zersetzt, rotbraun",
        "Tst",
        "Claystone, highly weathered to decomposed, red-brown",
        din="Tst",
        tcr="92",
        rqd="15",
    ),
    LayerDef(
        "9,50",
        "14,20",
        "Sandstein, maessig verwittert, feinkoernig, rotbraun, kluftig",
        "Sst",
        "Sandstone, moderately weathered, fine grained, red-brown, jointed",
        din="Sst",
        tcr="104",
        rqd="61",
    ),
    LayerDef(
        "14,20",
        "18,00",
        "Sandstein, frisch, mittelkoernig, rotgrau",
        "Sst",
        "Sandstone, fresh, medium grained, red-grey",
        din="Sst",
        tcr="98",
        rqd="83",
    ),
]
KB2_LAYERS = [
    LayerDef(
        "0,00",
        "0,50",
        "Auffuellung: Kies, sandig, mit Ziegelresten, braun",
        "A",
        "Made ground: sandy gravel with brick fragments, brown",
        din="A",
    ),
    LayerDef(
        "0,50",
        "3,30",
        "Schluff, sandig, schwach kiesig, braun, weich bis steif",
        "U",
        "Silt, sandy, slightly gravelly, brown, soft to stiff",
        din="U",
        spt="6",
        spt_n=6,
    ),
    LayerDef(
        "3,30",
        "7,40",
        "Kies, sandig, grau, dicht",
        "G",
        "Gravel, sandy, grey, dense",
        din="G",
        spt=Correction("21", Hand("27", seed=4)),
        spt_n=27,
    ),
    LayerDef(
        "7,40",
        "12,00",
        "Ton, schluffig, grau, halbfest",
        "T",
        "Clay, silty, grey, very stiff",
        din="T",
        spt="29",
        spt_n=29,
    ),
]
KB3_LAYERS = [
    LayerDef("0,00", "0,20", "Mutterboden", "Mu", "Topsoil", din="Mu"),
    LayerDef(
        "0,20",
        "1,60",
        "Hanglehm: Schluff, sandig, braun",
        "L",
        "Slope loam: sandy silt, brown",
        din="L",
        spt=Hand("7", seed=1),
        spt_n=7,
    ),
    LayerDef(
        "1,60",
        "3,90",
        "Hangschutt: Steine und Kies, kantig, in sandiger Matrix",
        "Lx",
        "Scree: angular cobbles and gravel in a sandy matrix",
        din="Lx",
        spt=Hand("33", seed=2),
        spt_n=33,
    ),
    LayerDef(
        "3,90",
        "10,00",
        "Sandstein, verwittert bis frisch, rotbraun",
        "Sst",
        "Sandstone, weathered to fresh, red-brown",
        din="Sst",
    ),
]


def _de_header(
    label: str, ost: str, nord: str, z: str, start: str, end: str, depth: str
) -> list[tuple[str, str, Cell]]:
    return [
        ("Bohrung", "bh", label),
        ("Projekt", "project", DE_PROJECT),
        ("Auftraggeber", "client", DE_CLIENT),
        ("Bohrfirma", "contractor", DE_CONTRACTOR),
        ("Ostwert (E)", "c1", ost),
        ("Nordwert (N)", "c2", nord),
        ("Lagesystem", "crs", "ETRS89 / UTM Zone 32N"),
        ("Ansatzhoehe", "z", z),
        ("Bohrbeginn", "start", start),
        ("Bohrende", "end", end),
        ("Bohrverfahren", "method", "Rotationskernbohrung"),
        ("Endteufe", "depth", depth),
    ]


def _de_meta(
    label: str,
    x: float,
    y: float,
    xr: str,
    yr: str,
    z: float,
    start: str,
    end: str,
    depth: float,
    location: str,
) -> dict[str, Any]:
    return metadata(
        borehole_id=label,
        location_name=location,
        country="Germany",
        project_name=DE_PROJECT,
        client=DE_CLIENT,
        drilling_contractor=DE_CONTRACTOR,
        drilling_method="Rotationskernbohrung",
        start_date=start,
        end_date=end,
        surface_elevation_mASL=z,
        elevation_datum="NHN",
        depth_origin="ground",
        borehole_depth_m=depth,
        borehole_depth_source="printed",
        coordinates={
            "local_x": x,
            "local_y": y,
            "x_raw": xr,
            "y_raw": yr,
            "axis_labels_raw": "Ostwert, Nordwert",
            "coordinate_system": "ETRS89 / UTM Zone 32N",
            "crs_code": "EPSG:25832",
        },
    )


DE_HEADER_PATHS = {
    "metadata.borehole_id": "bh",
    "metadata.project_name": "project",
    "metadata.client": "client",
    "metadata.drilling_contractor": "contractor",
    "metadata.coordinates.local_x": "c1",
    "metadata.coordinates.local_y": "c2",
    "metadata.coordinates.x_raw": "c1",
    "metadata.coordinates.y_raw": "c2",
    "metadata.coordinates.coordinate_system": "crs",
    "metadata.surface_elevation_mASL": "z",
    "metadata.elevation_datum": "z",
    "metadata.start_date": "start",
    "metadata.end_date": "end",
    "metadata.drilling_method": "method",
    "metadata.borehole_depth_m": "depth",
    "metadata.depth_origin": "origin",
}


def _de_doc() -> DocSpec:
    footer = DE_FILE
    origin_note = ("Tiefenangaben:", "origin", "m unter Gelaendeoberkante (GOK)")
    p1 = TextPage(
        DE_CO,
        "Baugrundgutachten - Anlage 2",
        subtitle_lines=[
            f"Projekt: {DE_PROJECT}",
            f"Auftraggeber: {DE_CLIENT}",
            "Inhalt: Bohrprofile, Laborergebnisse, Lageplan, Kernfotos",
            "Stand: 14.03.2025",
        ],
        paragraphs=[
            "Dieses Dokument ist frei erfunden. Es dient ausschliesslich als Testdatensatz fuer die "
            "Entwicklung von Bormisu und beschreibt kein reales Bauvorhaben.",
            "Anlage 2.1: Uebersicht der Aufschluesse. Anlage 2.2 bis 2.5: Bohrprofile KB-1 bis KB-3. "
            "Anlage 2.6: Laborergebnisse. Anlage 2.7: Lageplan. Anlage 2.8: Kernfotos.",
        ],
        footer=footer,
    )
    p2 = TablePage(
        DE_CO,
        "Uebersicht der Aufschluesse",
        intro="Lagesystem: ETRS89 / UTM Zone 32N. Hoehen in m NHN. Die Bohrung KB-4 wurde abgeteuft; "
        "das Bohrprofil wird nachgereicht.",
        columns=[
            Column("bh", "Bohrung", 130),
            Column("e", "Ostwert (m)", 190),
            Column("n", "Nordwert (m)", 210),
            Column("z", "Ansatzhoehe\n(m NHN)", 160),
            Column("d", "Endteufe\n(m)", 130),
            Column("rem", "Bemerkung", 180),
        ],
        rows=[
            (
                "KB-1",
                {
                    "bh": "KB-1",
                    "e": "530 039,85",
                    "n": "5 562 120,29",
                    "z": "312,45",
                    "d": "18,00",
                    "rem": "Kernbohrung",
                },
            ),
            (
                "KB-2",
                {
                    "bh": "KB-2",
                    "e": "530 224,36",
                    "n": "5 562 299,24",
                    "z": "309,80",
                    "d": "12,00",
                    "rem": "-",
                },
            ),
            (
                "KB-3",
                {
                    "bh": "KB-3",
                    "e": "530 411,33",
                    "n": "5 562 044,56",
                    "z": "287,95",
                    "d": "10,00",
                    "rem": "Hangbereich",
                },
            ),
            (
                "KB-4",
                {
                    "bh": "KB-4",
                    "e": "529 895,58",
                    "n": "5 562 397,45",
                    "z": "315,10",
                    "d": "15,00",
                    "rem": "Profil folgt",
                },
            ),
        ],
        footer=footer,
    )
    p3 = TablePage(
        DE_CO,
        "Schichtenverzeichnis",
        sheet_label="BLATT 1 VON 2",
        header=_de_header(
            "KB-1", "530 039,85", "5 562 120,29", "312,45 m NHN", "11.03.2025", "12.03.2025", "18,00 m"
        ),
        columns=DE_SOIL_COLS,
        rows=layer_rows(KB1_LAYERS[:4]),
        notes=[
            ("Grundwasser angebohrt:", "gw0", "2,40 m u. GOK"),
            ("Ruhewasserspiegel (12.03.2025):", "gw1", "2,10 m u. GOK"),
            origin_note,
        ],
        footer=footer,
    )
    p4 = TablePage(
        DE_CO,
        "Schichtenverzeichnis (Fortsetzung)",
        sheet_label="BLATT 2 VON 2",
        header=[("Projekt", "project", DE_PROJECT), ("Bohrverfahren", "method", "Rotationskernbohrung")],
        columns=DE_ROCK_COLS,
        rows=layer_rows(KB1_LAYERS[4:], start=4),
        notes=[
            ("Endteufe erreicht bei", "end_note", "18,00 m"),
            ("Kernkisten:", None, "5 (siehe Kernfotos)"),
        ],
        footer=footer,
    )
    p5 = TablePage(
        DE_CO,
        "Schichtenverzeichnis",
        sheet_label="BLATT 1 VON 1",
        header=_de_header(
            "KB-2", "530 224,36", "5 562 299,24", "309,80 m NHN", "13.03.2025", "13.03.2025", "12,00 m"
        ),
        columns=DE_SOIL_COLS,
        rows=layer_rows(KB2_LAYERS),
        notes=[("Grundwasser:", "gwnote", "nicht angetroffen"), origin_note],
        margin_note=Hand("SPT neu gezaehlt", seed=9),
        footer=footer,
    )
    p6 = TablePage(
        DE_CO,
        "Schichtenverzeichnis",
        sheet_label="BLATT 1 VON 1",
        header=_de_header(
            "KB-3", "530 411,33", "5 562 044,56", "287,59 m NHN", "14.03.2025", "14.03.2025", "10,00 m"
        ),
        columns=DE_SOIL_COLS,
        rows=layer_rows(KB3_LAYERS),
        notes=[("Grundwasser angebohrt:", "gw0", Hand("1,90 m", seed=3)), origin_note],
        footer=footer,
    )
    p7 = TablePage(
        DE_CO,
        "Laborergebnisse",
        intro="Wassergehalt und Fliessgrenze an gestoerten Proben (GP), einaxiale Druckfestigkeit an "
        "Kernproben (KP).",
        columns=[
            Column("s", "Probe", 120),
            Column("bh", "Bohrung", 120),
            Column("from", "von\n(m)", 110),
            Column("to", "bis\n(m)", 110),
            Column("w", "Wassergehalt\nw (%)", 170),
            Column("wl", "Fliessgrenze\nwL (%)", 170),
            Column("ucs", "UCS\n(MPa)", 130),
        ],
        rows=[
            (
                "r1",
                {
                    "s": "GP1",
                    "bh": "KB-1",
                    "from": "1,00",
                    "to": "1,50",
                    "w": "21,4",
                    "wl": "38,2",
                    "ucs": "-",
                },
            ),
            (
                "r2",
                {
                    "s": "KP3",
                    "bh": "KB-1",
                    "from": "10,20",
                    "to": "10,60",
                    "w": "-",
                    "wl": "-",
                    "ucs": "42,5",
                },
            ),
            (
                "r3",
                {"s": "GP2", "bh": "KB-2", "from": "4,00", "to": "4,50", "w": "8,7", "wl": "-", "ucs": "-"},
            ),
            (
                "r4",
                {
                    "s": "GP1",
                    "bh": "KB-3",
                    "from": "0,80",
                    "to": "1,20",
                    "w": "24,9",
                    "wl": "41,0",
                    "ucs": "-",
                },
            ),
        ],
        footer=footer,
    )
    p8 = PlanPage(
        DE_CO,
        "Lageplan der Aufschluesse",
        [("KB-1", 0.36, 0.48), ("KB-2", 0.55, 0.28), ("KB-3", 0.74, 0.66), ("KB-4", 0.2, 0.22)],
        footer=footer,
    )
    p9 = PhotoPage(
        DE_CO,
        "Kernfotos KB-1",
        "Kernkisten 1 bis 5, KB-1, 7,80 bis 18,00 m (gezeichnete Darstellung).",
        seed=11,
        footer=footer,
    )

    lang = "de"
    pages = [
        PageMeta(
            p1,
            "cover_or_toc",
            lang,
            ocr="skipped",
            used=False,
            confidence=0.97,
            reason="Title page of an appendix with a contents list.",
        ),
        PageMeta(
            p2,
            "summary_table",
            lang,
            labels=["KB-1", "KB-2", "KB-3", "KB-4"],
            has_coordinates=True,
            confidence=0.93,
            reason="Table listing four boreholes with coordinates and levels.",
        ),
        PageMeta(
            p3,
            "log_sheet",
            lang,
            labels=["KB-1"],
            sheet=("BLATT 1 VON 2", 1, 2),
            has_coordinates=True,
            confidence=0.96,
            reason="Borehole log with header, layer table and depth column.",
        ),
        PageMeta(
            p4,
            "log_continuation",
            lang,
            labels=[],
            sheet=("BLATT 2 VON 2", 2, 2),
            confidence=0.71,
            reason="Continuation sheet of a log; no borehole label is printed.",
        ),
        PageMeta(
            p5,
            "log_sheet",
            lang,
            handwriting="annotations",
            labels=["KB-2"],
            sheet=("BLATT 1 VON 1", 1, 1),
            has_coordinates=True,
            confidence=0.95,
            reason="Borehole log with a handwritten correction.",
        ),
        PageMeta(
            p6,
            "log_sheet",
            lang,
            handwriting="partial",
            labels=["KB-3"],
            sheet=("BLATT 1 VON 1", 1, 1),
            has_coordinates=True,
            confidence=0.94,
            reason="Borehole log; SPT and water level handwritten.",
        ),
        PageMeta(
            p7,
            "lab_results",
            lang,
            labels=["KB-1", "KB-2", "KB-3"],
            confidence=0.92,
            reason="Laboratory results table per sample.",
        ),
        PageMeta(
            p8,
            "location_plan",
            lang,
            labels=["KB-1", "KB-2", "KB-3", "KB-4"],
            ocr="skipped",
            used=False,
            confidence=0.9,
            reason="Site plan with borehole markers.",
        ),
        PageMeta(
            p9,
            "photos",
            lang,
            labels=["KB-1"],
            ocr="skipped",
            used=False,
            confidence=0.98,
            reason="Core box photographs.",
        ),
    ]

    # KB-1: header values reviewed already; one depth misread by OCR and corrected by the reviewer.
    layers, lprov = layer_records(KB1_LAYERS, [3, 3, 3, 3, 4, 4, 4], language=lang)
    layers[0]["depth_to_m"] = 0.8  # OCR misread "0,30" as "0,80"; the reviewer edit below fixes it
    lprov["stratigraphy[0].depth_to_m"] = Pv(Ref(3, "L0.to"), confidence=0.77, raw="0,80")
    lprov["stratigraphy[5].core_recovery_pct"] = Pv(Ref(4, "L5.tcr"), confidence=0.88)
    kb1 = BoreholeSpec(
        "KB-1",
        {
            "metadata": _de_meta(
                "KB-1",
                530039.85,
                5562120.29,
                "530 039,85",
                "5 562 120,29",
                312.45,
                "2025-03-11",
                "2025-03-12",
                18.0,
                "Kesselbachtal, Widerlager Nord",
            ),
            "stratigraphy": layers,
            "groundwater": [
                {"type": "strike", "depth_m": 2.4, "date": None, "raw": "2,40 m u. GOK"},
                {"type": "rest", "depth_m": 2.1, "date": "2025-03-12", "raw": "2,10 m u. GOK"},
            ],
            "samples": [
                {"name": "GP1", "type_code": "GP", "depth_from_m": 1.0, "depth_to_m": 1.5},
                {"name": "KP3", "type_code": "KP", "depth_from_m": 10.2, "depth_to_m": 10.6},
            ],
            "test_results": [
                {"name": "Watercontent", "value": 21.4, "unit": "%", "sample_name": "GP1", "depth_m": 1.0},
                {"name": "LiquidLimit", "value": 38.2, "unit": "%", "sample_name": "GP1", "depth_m": 1.0},
                {"name": "UCS", "value": 42.5, "unit": "MPa", "sample_name": "KP3", "depth_m": 10.2},
            ],
        },
        merge(
            {p: Pv(Ref(3, k), status="approved") for p, k in DE_HEADER_PATHS.items()},
            {"metadata.country": Pv(None, method="guessed", confidence=0.8, raw=None)},
            lprov,
            {
                "groundwater[0].depth_m": Pv(Ref(3, "gw0")),
                "groundwater[1].depth_m": Pv(Ref(3, "gw1")),
                "groundwater[1].date": Pv(Ref(3, "gw1")),
                "samples[0].name": Pv(Ref(7, "r1.s")),
                "samples[0].depth_from_m": Pv(Ref(7, "r1.from")),
                "samples[0].depth_to_m": Pv(Ref(7, "r1.to")),
                "samples[1].name": Pv(Ref(7, "r2.s")),
                "samples[1].depth_from_m": Pv(Ref(7, "r2.from")),
                "samples[1].depth_to_m": Pv(Ref(7, "r2.to")),
                "test_results[0].value": Pv(Ref(7, "r1.w")),
                "test_results[1].value": Pv(Ref(7, "r1.wl")),
                "test_results[2].value": Pv(Ref(7, "r2.ucs"), confidence=0.84),
            },
        ),
        pages=[3, 4, 7],
        crs_status="stated",
        crs_code="EPSG:25832",
        edits=[("stratigraphy[0].depth_to_m", 0.3)],
    )

    # KB-2: two readers disagree on the handwritten SPT correction (choose_reading).
    layers, lprov = layer_records(KB2_LAYERS, [5, 5, 5, 5], language=lang)
    lprov["stratigraphy[2].spt_n_value"] = Pv(
        Ref(5, "L2.spt"), confidence=0.58, readings=[("ocr", "27", 0.58), ("second_read", "22", 0.71)]
    )
    kb2 = BoreholeSpec(
        "KB-2",
        {
            "metadata": {
                **_de_meta(
                    "KB-2",
                    530224.36,
                    5562299.24,
                    "530 224,36",
                    "5 562 299,24",
                    309.8,
                    "2025-03-13",
                    "2025-03-13",
                    12.0,
                    "Kesselbachtal, Pfeiler 2",
                ),
                "notes": "Grundwasser: nicht angetroffen",
            },
            "stratigraphy": layers,
            "samples": [{"name": "GP2", "type_code": "GP", "depth_from_m": 4.0, "depth_to_m": 4.5}],
            "test_results": [
                {"name": "Watercontent", "value": 8.7, "unit": "%", "sample_name": "GP2", "depth_m": 4.0},
            ],
        },
        merge(
            {p: Pv(Ref(5, k)) for p, k in DE_HEADER_PATHS.items()},
            {
                "metadata.country": Pv(None, method="guessed", confidence=0.8, raw=None),
                "metadata.notes": Pv(Ref(5, "gwnote")),
            },
            lprov,
            {
                "samples[0].name": Pv(Ref(7, "r3.s")),
                "samples[0].depth_from_m": Pv(Ref(7, "r3.from")),
                "samples[0].depth_to_m": Pv(Ref(7, "r3.to")),
                # Taken from the laboratory's spreadsheet export: a cell, no page or box.
                "test_results[0].value": Pv(
                    None, method="read", confidence=None, raw="8.7", cell="Logdata!C5"
                ),
            },
        ),
        pages=[5, 7],
        crs_status="stated",
        crs_code="EPSG:25832",
    )

    # KB-3: handwritten SPT values and water level; ground level differs from the summary table.
    layers, lprov = layer_records(KB3_LAYERS, [6, 6, 6, 6], language=lang)
    kb3 = BoreholeSpec(
        "KB-3",
        {
            "metadata": _de_meta(
                "KB-3",
                530411.33,
                5562044.56,
                "530 411,33",
                "5 562 044,56",
                287.59,
                "2025-03-14",
                "2025-03-14",
                10.0,
                "Kesselbachtal, Widerlager Sued",
            ),
            "stratigraphy": layers,
            "groundwater": [{"type": "strike", "depth_m": 1.9, "date": None, "raw": "1,90 m"}],
            "samples": [{"name": "GP1", "type_code": "GP", "depth_from_m": 0.8, "depth_to_m": 1.2}],
            "test_results": [
                {"name": "Watercontent", "value": 24.9, "unit": "%", "sample_name": "GP1", "depth_m": 0.8},
                {"name": "LiquidLimit", "value": 41.0, "unit": "%", "sample_name": "GP1", "depth_m": 0.8},
            ],
        },
        merge(
            {p: Pv(Ref(6, k)) for p, k in DE_HEADER_PATHS.items()},
            {"metadata.country": Pv(None, method="guessed", confidence=0.8, raw=None)},
            lprov,
            {
                "groundwater[0].depth_m": Pv(Ref(6, "gw0")),
                "samples[0].name": Pv(Ref(7, "r4.s")),
                "samples[0].depth_from_m": Pv(Ref(7, "r4.from")),
                "samples[0].depth_to_m": Pv(Ref(7, "r4.to")),
                "test_results[0].value": Pv(Ref(7, "r4.w")),
                "test_results[1].value": Pv(Ref(7, "r4.wl")),
            },
        ),
        pages=[6, 7],
        crs_status="stated",
        crs_code="EPSG:25832",
    )
    return DocSpec(
        key="de",
        file_name=DE_FILE,
        project=DE_PROJECT,
        status="needs_review",
        stage="validate",
        method="ocr",
        text_layer_quality=0.0,
        pages=pages,
        boreholes=[kb1, kb2, kb3],
        expected_ids=["KB-1", "KB-2", "KB-3", "KB-4"],
    )


# --------------------------------------------------------------------------------------------------
# Document 2: Australia, vector PDF pipeline logs (read values, SPT refusal, flagged, no coordinates)
# --------------------------------------------------------------------------------------------------

AU_CO = "Kestrel Ridge Geotechnics Pty Ltd (fictional)"
AU_PROJECT = "Marrowbank Creek Pipeline"
AU_CLIENT = "Western Plains Water (fictional)"
AU_FILE = "fictional-marrowbank-creek-pipeline-borehole-logs.pdf"
AU_CONTRACTOR = "Dunmore Drilling (fictional)"
AU_COLS = [
    Column("from", "From\n(m)", 85),
    Column("to", "To\n(m)", 85),
    Column("desc", "Material description", 470),
    Column("uscs", "USCS", 80),
    Column("spt", "SPT\n(blows/150 mm)", 170),
    Column("tcr", "TCR\n%", 60),
    Column("rqd", "RQD\n%", 60),
]
BH01_LAYERS = [
    LayerDef(
        "0.00",
        "0.40",
        "TOPSOIL: silty SAND, fine grained, dark brown, moist, with roots",
        "Mu",
        "Topsoil: silty fine sand with roots, dark brown",
        uscs="SM",
    ),
    LayerDef(
        "0.40",
        "2.80",
        "CLAY: high plasticity, red-brown mottled grey, stiff to very stiff, moist",
        "T",
        "Clay, high plasticity, red-brown mottled grey, stiff to very stiff",
        uscs="CH",
        spt="4, 6, 8 N=14",
        spt_n=14,
        increments=[4, 6, 8],
        increment_mm=150,
        consistency="stiff to very stiff",
    ),
    LayerDef(
        "2.80",
        "6.20",
        "Sandy GRAVEL: fine to coarse, sub-rounded, grey, wet, dense",
        "G",
        "Sandy gravel, fine to coarse, sub-rounded, grey, dense",
        uscs="GW",
        spt="12, 18, 21 N=39",
        spt_n=39,
        increments=[12, 18, 21],
        increment_mm=150,
        consistency="dense",
    ),
    LayerDef(
        "6.20",
        "9.45",
        "BASALT: highly weathered, red-brown, very low to low strength",
        "Vu",
        "Basalt, highly weathered, red-brown, very low to low strength",
        tcr="88",
        rqd="12",
    ),
]
BH02_LAYERS = [
    LayerDef("0.00", "0.30", "FILL: gravelly SAND, brown, dry", "A", "Fill: gravelly sand, brown", uscs="SW"),
    LayerDef(
        "0.30",
        "3.60",
        "Silty CLAY: medium plasticity, grey-brown, firm to stiff",
        "T",
        "Silty clay, medium plasticity, grey-brown, firm to stiff",
        uscs="CI",
        spt="2, 3, 5 N=8",
        spt_n=8,
        increments=[2, 3, 5],
        increment_mm=150,
    ),
    LayerDef(
        "3.60",
        "5.10",
        "Clayey SAND: fine to medium grained, grey, medium dense",
        "S",
        "Clayey sand, fine to medium, grey, medium dense",
        uscs="SC",
        spt="8, 11, 14 N=25",
        spt_n=25,
        increments=[8, 11, 14],
        increment_mm=150,
    ),
    LayerDef(
        "5.10",
        "7.00",
        "BASALT: highly weathered, grey-brown, low strength",
        "Vu",
        "Basalt, highly weathered, grey-brown, low strength",
        spt="50/120",
        refusal=True,
        penetration_cm=12.0,
    ),
]
BH03_LAYERS = [
    LayerDef(
        "0.00", "0.20", "TOPSOIL: silty SAND, dark brown", "Mu", "Topsoil: silty sand, dark brown", uscs="SM"
    ),
    LayerDef(
        "0.20",
        "4.50",
        "Silty CLAY: medium plasticity, brown, stiff",
        "T",
        "Silty clay, medium plasticity, brown, stiff",
        uscs="CI",
        spt="5, 7, 9 N=16",
        spt_n=16,
        increments=[5, 7, 9],
        increment_mm=150,
    ),
    LayerDef("4.50", "6.00", "BASALT: extremely weathered, red-brown", "Vu", "Basalt, extremely weathered"),
]


def _au_header(
    label: str,
    loc: str,
    e: str,
    n: str,
    grid: str,
    rl: str,
    start: str,
    end: str | None,
    depth: str,
    method: str,
) -> list[tuple[str, str, Cell]]:
    return [
        ("Borehole", "bh", label),
        ("Project", "project", AU_PROJECT),
        ("Client", "client", AU_CLIENT),
        ("Location", "loc", loc),
        ("Easting", "c1", e),
        ("Northing", "c2", n),
        ("Grid", "crs", grid),
        ("Surface RL", "z", rl),
        ("Date started", "start", start),
        ("Date completed", "end", end),
        ("Drill method", "method", method),
        ("Total depth", "depth", depth),
        ("Contractor", "contractor", AU_CONTRACTOR),
        ("Logged by", "logged", "R.K."),
    ]


AU_HEADER_PATHS = {
    "metadata.borehole_id": "bh",
    "metadata.project_name": "project",
    "metadata.client": "client",
    "metadata.location_name": "loc",
    "metadata.drilling_contractor": "contractor",
    "metadata.drilling_method": "method",
    "metadata.start_date": "start",
    "metadata.borehole_depth_m": "depth",
    "metadata.depth_origin": "origin",
}
AU_COORD_PATHS = {
    "metadata.coordinates.local_x": "c1",
    "metadata.coordinates.local_y": "c2",
    "metadata.coordinates.x_raw": "c1",
    "metadata.coordinates.y_raw": "c2",
    "metadata.coordinates.coordinate_system": "crs",
    "metadata.surface_elevation_mASL": "z",
    "metadata.elevation_datum": "z",
}


def _au_meta(
    label: str,
    loc: str,
    start: str,
    end: str | None,
    depth: float,
    method: str,
    coords: dict[str, Any],
    rl: float | None,
) -> dict[str, Any]:
    return metadata(
        borehole_id=label,
        location_name=loc,
        country="Australia",
        project_name=AU_PROJECT,
        client=AU_CLIENT,
        drilling_contractor=AU_CONTRACTOR,
        drilling_method=method,
        start_date=start,
        end_date=end,
        surface_elevation_mASL=rl,
        elevation_datum="AHD" if rl is not None else None,
        depth_origin="ground",
        borehole_depth_m=depth,
        borehole_depth_source="printed",
        coordinates=coords,
    )


def _au_doc() -> DocSpec:
    footer = AU_FILE
    origin = ("Depths:", "origin", "metres below ground surface")
    p1 = TablePage(
        AU_CO,
        "BOREHOLE LOCATION SCHEDULE",
        intro="Coordinates: MGA94 Zone 55. Levels: m AHD. BH03 was not surveyed (next to the pump station).",
        columns=[
            Column("bh", "Borehole", 150),
            Column("e", "Easting (m)", 200),
            Column("n", "Northing (m)", 220),
            Column("rl", "Surface RL\n(m AHD)", 170),
            Column("d", "Depth\n(m)", 110),
            Column("rem", "Remarks", 160),
        ],
        rows=[
            (
                "BH01",
                {"bh": "BH01", "e": "290251.5", "n": "5823673.2", "rl": "64.20", "d": "9.45", "rem": "-"},
            ),
            (
                "BH02",
                {
                    "bh": "BH02",
                    "e": "290755.6",
                    "n": "5823275.1",
                    "rl": "61.85",
                    "d": "7.12",
                    "rem": "refusal",
                },
            ),
            (
                "BH03",
                {"bh": "BH03", "e": "not surveyed", "n": "-", "rl": "-", "d": "6.00", "rem": "pump station"},
            ),
        ],
        footer=footer,
    )
    method01 = "Solid flight auger to 6.2 m, NMLC coring below"
    p2 = TablePage(
        AU_CO,
        "BOREHOLE LOG",
        sheet_label="SHEET 1 OF 1",
        header=_au_header(
            "BH01",
            "Creek crossing CH 2+140",
            "290251.5",
            "5823673.2",
            "MGA94 Zone 55",
            "64.20 m AHD",
            "18/02/2025",
            "19/02/2025",
            "9.45 m",
            method01,
        ),
        columns=AU_COLS,
        rows=layer_rows(BH01_LAYERS),
        notes=[
            ("Groundwater inflow:", "gw0", "3.10 m (18/02/2025)"),
            ("Standing water level:", "gw1", "2.65 m (19/02/2025)"),
            ("Cerchar abrasivity CAI, core at 7.6 m:", "cai", "7.1"),
            origin,
        ],
        footer=footer,
    )
    method02 = "Solid flight auger"
    p3 = TablePage(
        AU_CO,
        "BOREHOLE LOG",
        sheet_label="SHEET 1 OF 1",
        header=_au_header(
            "BH02",
            "Valve pit VP4, CH 2+820",
            "290755.6",
            "5823275.1",
            "MGA94 Zone 55",
            "61.85 m AHD",
            "20/02/2025",
            None,
            "7.12 m",
            method02,
        ),
        columns=AU_COLS,
        rows=layer_rows(BH02_LAYERS),
        notes=[
            ("Groundwater:", "gwnote", "not encountered"),
            ("Termination:", "term", "SPT refusal on basalt"),
            origin,
        ],
        footer=footer,
    )
    p4 = TablePage(
        AU_CO,
        "BOREHOLE LOG",
        sheet_label="SHEET 1 OF 1",
        header=_au_header(
            "BH03",
            "Next to the pump station",
            "not surveyed",
            "not surveyed",
            "-",
            "-",
            "21/02/2025",
            "21/02/2025",
            "6.00 m",
            method02,
        ),
        columns=AU_COLS,
        rows=layer_rows(BH03_LAYERS),
        notes=[
            ("Bulk unit weight, sample at 2.0 m:", "uw", "19.6"),
            ("Groundwater:", "gwnote", "not encountered"),
            origin,
        ],
        footer=footer,
    )
    p5 = TextPage(
        AU_CO,
        "EXPLANATORY NOTES FOR BOREHOLE LOGS",
        paragraphs=[
            "Soil descriptions follow the unified soil classification (USCS group symbols in the "
            "log column).",
            "SPT: blows per 150 mm increment after the seating drive; N is the sum of the last two "
            "increments. "
            "A value such as 50/120 means 50 blows for 120 mm penetration (refusal).",
            "TCR: total core recovery. RQD: rock quality designation. Both in percent of the core run.",
            "Strength terms: very low, low, medium, high, very high. Weathering: fresh, slightly, "
            "moderately, highly, extremely weathered.",
            "This explanation sheet is fictional and belongs to an invented report used for software "
            "testing.",
        ],
        footer=footer,
    )
    p6 = BlankPage(footer=footer)
    lang = "en"
    pages = [
        PageMeta(
            p1,
            "coordinate_table",
            lang,
            labels=["BH01", "BH02", "BH03"],
            has_coordinates=True,
            confidence=0.97,
            reason="Schedule of borehole coordinates and levels.",
        ),
        PageMeta(
            p2,
            "log_sheet",
            lang,
            labels=["BH01"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            confidence=0.98,
            reason="Borehole log with header and layer table.",
        ),
        PageMeta(
            p3,
            "log_sheet",
            lang,
            labels=["BH02"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            confidence=0.98,
            reason="Borehole log with header and layer table.",
        ),
        PageMeta(
            p4,
            "log_sheet",
            lang,
            labels=["BH03"],
            sheet=("SHEET 1 OF 1", 1, 1),
            confidence=0.97,
            reason="Borehole log; coordinates are marked as not surveyed.",
        ),
        PageMeta(
            p5,
            "legend_or_key",
            lang,
            used=False,
            confidence=0.91,
            reason="Explanation of the log terms and symbols.",
        ),
        PageMeta(p6, "blank", None, ocr="skipped", used=False, confidence=0.99, reason="Empty page."),
    ]

    gw_note = Pv(Ref(3, "gwnote"))
    layers, lprov = layer_records(BH01_LAYERS, [2] * 4, language=lang)
    bh01 = BoreholeSpec(
        "BH01",
        {
            "metadata": _au_meta(
                "BH01",
                "Creek crossing CH 2+140",
                "2025-02-18",
                "2025-02-19",
                9.45,
                method01,
                {
                    "local_x": 290251.5,
                    "local_y": 5823673.2,
                    "x_raw": "290251.5",
                    "y_raw": "5823673.2",
                    "axis_labels_raw": "Easting, Northing",
                    "coordinate_system": "MGA94 Zone 55",
                    "crs_code": "EPSG:28355",
                },
                64.2,
            ),
            "stratigraphy": layers,
            "groundwater": [
                {"type": "strike", "depth_m": 3.1, "date": "2025-02-18", "raw": "3.10 m (18/02/2025)"},
                {"type": "rest", "depth_m": 2.65, "date": "2025-02-19", "raw": "2.65 m (19/02/2025)"},
            ],
            "test_results": [
                {"name": "CAI", "value": 7.1, "unit": None, "sample_name": None, "depth_m": 7.6}
            ],
        },
        merge(
            header_prov(2, AU_HEADER_PATHS | AU_COORD_PATHS | {"metadata.end_date": "end"}),
            {"metadata.country": Pv(None, method="guessed", confidence=0.75, raw=None)},
            lprov,
            {
                "groundwater[0].depth_m": Pv(Ref(2, "gw0")),
                "groundwater[0].date": Pv(Ref(2, "gw0")),
                "groundwater[1].depth_m": Pv(Ref(2, "gw1")),
                "groundwater[1].date": Pv(Ref(2, "gw1")),
                "test_results[0].value": Pv(Ref(2, "cai")),
            },
        ),
        pages=[1, 2],
        crs_status="stated",
        crs_code="EPSG:28355",
    )
    layers, lprov = layer_records(BH02_LAYERS, [3] * 4, language=lang)
    bh02 = BoreholeSpec(
        "BH02",
        {
            "metadata": {
                **_au_meta(
                    "BH02",
                    "Valve pit VP4, CH 2+820",
                    "2025-02-20",
                    None,
                    7.12,
                    method02,
                    {
                        "local_x": 290755.6,
                        "local_y": 5823275.1,
                        "x_raw": "290755.6",
                        "y_raw": "5823275.1",
                        "axis_labels_raw": "Easting, Northing",
                        "coordinate_system": "MGA94 Zone 55",
                        "crs_code": "EPSG:28355",
                    },
                    61.85,
                ),
                "notes": "Groundwater not encountered. Terminated on SPT refusal on basalt.",
            },
            "stratigraphy": layers,
        },
        merge(
            header_prov(3, AU_HEADER_PATHS | AU_COORD_PATHS),
            {
                "metadata.country": Pv(None, method="guessed", confidence=0.75, raw=None),
                "metadata.surface_elevation_mASL": Pv(
                    Ref(3, "z"),
                    status="flagged",
                    flag="RL differs from the survey plan (61.58 m AHD); check with the surveyor.",
                ),
                "metadata.end_date": Pv(Ref(3, "end"), state="not_in_source", confidence=None, raw=None),
                "metadata.notes": gw_note,
            },
            lprov,
        ),
        pages=[1, 3],
        crs_status="stated",
        crs_code="EPSG:28355",
    )
    layers, lprov = layer_records(BH03_LAYERS, [4] * 3, language=lang)
    bh03 = BoreholeSpec(
        "BH03",
        {
            "metadata": {
                **_au_meta(
                    "BH03", "Next to the pump station", "2025-02-21", "2025-02-21", 6.0, method02, {}, None
                ),
                "notes": "Groundwater not encountered.",
            },
            "stratigraphy": layers,
            "test_results": [
                {"name": "Unitweight", "value": 19.6, "unit": None, "sample_name": None, "depth_m": 2.0}
            ],
        },
        merge(
            header_prov(4, AU_HEADER_PATHS | {"metadata.end_date": "end"}),
            {
                "metadata.country": Pv(None, method="guessed", confidence=0.75, raw=None),
                "metadata.coordinates.x_raw": Pv(
                    Ref(4, "c1"), state="not_in_source", confidence=None, raw=None
                ),
                "metadata.coordinates.y_raw": Pv(
                    Ref(4, "c2"), state="not_in_source", confidence=None, raw=None
                ),
                "metadata.surface_elevation_mASL": Pv(
                    Ref(4, "z"), state="not_in_source", confidence=None, raw=None
                ),
                "metadata.notes": Pv(Ref(4, "gwnote")),
                "test_results[0].value": Pv(Ref(4, "uw"), confidence=0.97),
            },
            lprov,
        ),
        pages=[1, 4],
        crs_status="unknown",
    )
    return DocSpec(
        key="au",
        file_name=AU_FILE,
        project=AU_PROJECT,
        status="needs_review",
        stage="validate",
        method="read",
        text_layer_quality=0.97,
        pages=pages,
        boreholes=[bh01, bh02, bh03],
        expected_ids=["BH01", "BH02", "BH03"],
    )


# --------------------------------------------------------------------------------------------------
# Documents 3 and 4: New Zealand, one project in two uploads, coordinates without a system
# --------------------------------------------------------------------------------------------------

NZ_CO = "Pohutu Ground Investigations Ltd (fictional)"
NZ_PROJECT = "Tarawhiti Wharf Upgrade"
NZ_CLIENT = "Tarawhiti Port Company (fictional)"
NZ1_FILE = "fictional-tarawhiti-wharf-phase1-borelogs.pdf"
NZ2_FILE = "fictional-tarawhiti-wharf-phase2-field-sheets.pdf"
NZ_COLS = [
    Column("from", "From\n(m)", 85),
    Column("to", "To\n(m)", 85),
    Column("desc", "Description", 500),
    Column("spt", "SPT\nN", 100),
    Column("tcr", "TCR\n%", 75),
    Column("rqd", "RQD\n%", 75),
]
WH1_LAYERS = [
    LayerDef(
        "0.00",
        "1.20",
        "FILL: sandy GRAVEL with concrete fragments, grey, loose",
        "A",
        "Fill: sandy gravel with concrete fragments, grey, loose",
    ),
    LayerDef(
        "1.20",
        "4.80",
        "Marine SILT: soft, dark grey, with shell fragments, wet",
        "Kl",
        "Marine silt, soft, dark grey, with shell fragments",
        spt="N=2",
        spt_n=2,
    ),
    LayerDef(
        "4.80",
        "8.50",
        "Silty fine SAND: grey, medium dense, wet",
        "fS",
        "Silty fine sand, grey, medium dense",
        spt="N=18",
        spt_n=18,
    ),
    LayerDef(
        "8.50",
        "12.30",
        "MUDSTONE: moderately weathered, blue-grey, very weak",
        "Tst",
        "Mudstone, moderately weathered, blue-grey, very weak",
        tcr="90",
        rqd="45",
    ),
]
WH2_LAYERS = [
    LayerDef("0.00", "0.90", "FILL: gravelly SAND, brown", "A", "Fill: gravelly sand, brown"),
    LayerDef(
        "0.90",
        "3.80",
        "Marine SILT: very soft, grey",
        "Kl",
        "Marine silt, very soft, grey",
        spt="N=1",
        spt_n=1,
    ),
    LayerDef(
        "4.10",
        "9.20",
        "Silty fine SAND: grey, dense",
        "fS",
        "Silty fine sand, grey, dense",
        spt="N=31",
        spt_n=31,
    ),
    LayerDef(
        "9.20",
        "11.00",
        "MUDSTONE: slightly weathered, blue-grey, weak",
        "Tst",
        "Mudstone, slightly weathered, blue-grey, weak",
        tcr="96",
        rqd="70",
    ),
]
WH3_LAYERS = [
    LayerDef(
        Hand("0.0", 1),
        Hand("2.5", 2),
        Hand("deck slab + rubble fill", 3),
        "A",
        "Fill: concrete deck and rubble",
    ),
    LayerDef(
        Hand("2.5", 4),
        Hand("6.0", 5),
        Hand("soft grey marine silt, shells", 6),
        "Kl",
        "Marine silt, soft, grey, with shells",
        spt=Hand("3", 7),
        spt_n=3,
    ),
    LayerDef(
        Hand("6.0", 8),
        Hand("10.5", 9),
        Hand("grey silty sand, dense", 10),
        "fS",
        "Silty sand, grey, dense",
        spt=Smudge("2?", 11),
    ),
]


def _nz_header(label: str, e: str, n: str, rl: str, date: str, depth: str) -> list[tuple[str, str, Cell]]:
    return [
        ("Borehole", "bh", label),
        ("Project", "project", NZ_PROJECT),
        ("Client", "client", NZ_CLIENT),
        ("Date", "start", date),
        ("mE", "c1", e),
        ("mN", "c2", n),
        ("Ground level", "z", rl),
        ("Total depth", "depth", depth),
    ]


NZ_HEADER_PATHS = {
    "metadata.borehole_id": "bh",
    "metadata.project_name": "project",
    "metadata.client": "client",
    "metadata.start_date": "start",
    "metadata.coordinates.local_x": "c1",
    "metadata.coordinates.local_y": "c2",
    "metadata.coordinates.x_raw": "c1",
    "metadata.coordinates.y_raw": "c2",
    "metadata.surface_elevation_mASL": "z",
    "metadata.elevation_datum": "z",
    "metadata.borehole_depth_m": "depth",
}


def _nz_meta(
    label: str, x: float, y: float, xr: str, yr: str, rl: float, date: str, depth: float, origin: str | None
) -> dict[str, Any]:
    return metadata(
        borehole_id=label,
        location_name="Tarawhiti wharf",
        country="New Zealand",
        project_name=NZ_PROJECT,
        client=NZ_CLIENT,
        start_date=date,
        surface_elevation_mASL=rl,
        elevation_datum="CD",
        depth_origin=origin,
        borehole_depth_m=depth,
        borehole_depth_source="printed",
        coordinates={"local_x": x, "local_y": y, "x_raw": xr, "y_raw": yr, "axis_labels_raw": "mE, mN"},
    )


def _wh2_page(footer: str, stamp: str | None = None) -> TablePage:
    return TablePage(
        NZ_CO,
        "BOREHOLE LOG",
        sheet_label="SHEET 1 OF 1",
        header=_nz_header("WH-2", "2037901.1", "5706617.6", "RL 3.18 m CD", "2025-03-27", "11.00 m"),
        columns=NZ_COLS,
        rows=layer_rows(WH2_LAYERS),
        notes=[
            ("Water level (tidal) during drilling:", "gw0", "1.85 m"),
            ("Core loss:", "loss", "3.80 - 4.10 m"),
        ],
        margin_note=Hand("re-survey RL?", seed=5),
        stamp=stamp,
        footer=footer,
    )


def _nz_docs() -> tuple[DocSpec, DocSpec]:
    p1 = TextPage(
        NZ_CO,
        "FACTUAL REPORT - SUMMARY",
        subtitle_lines=[f"Project: {NZ_PROJECT}", f"Client: {NZ_CLIENT}", "Phase 1: boreholes WH-1 and WH-2"],
        paragraphs=[
            "Two machine boreholes were drilled from the existing wharf deck in March 2025. Coordinates were "
            "measured with a handheld receiver and are listed on each log. Levels refer to chart datum (CD).",
            "Phase 2 (field sheets, borehole WH-3) is issued separately.",
            "This report is fictional and was invented for testing the Bormisu software.",
        ],
        footer=NZ1_FILE,
    )
    p2 = TablePage(
        NZ_CO,
        "BOREHOLE LOG",
        sheet_label="SHEET 1 OF 1",
        header=_nz_header("WH-1", "2037743.0", "5706760.0", "RL 3.42 m CD", "2025-03-25", "12.30 m"),
        columns=NZ_COLS,
        rows=layer_rows(WH1_LAYERS),
        notes=[("Water level (tidal) during drilling:", "gw0", "2.10 m")],
        footer=NZ1_FILE,
    )
    p3 = _wh2_page(NZ1_FILE)
    p4 = PlanPage(
        NZ_CO,
        "SITE PLAN - BOREHOLE LOCATIONS",
        [("WH-1", 0.3, 0.42), ("WH-2", 0.5, 0.62), ("WH-3", 0.7, 0.4)],
        footer=NZ1_FILE,
    )
    lang = "en"
    pages1 = [
        PageMeta(
            p1,
            "narrative",
            lang,
            ocr="skipped",
            used=False,
            confidence=0.93,
            reason="Running text summarising the investigation.",
        ),
        PageMeta(
            p2,
            "log_sheet",
            lang,
            labels=["WH-1"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            confidence=0.96,
            reason="Borehole log with header and layer table.",
        ),
        PageMeta(
            p3,
            "log_sheet",
            lang,
            handwriting="annotations",
            labels=["WH-2"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            confidence=0.95,
            reason="Borehole log with a handwritten margin note.",
        ),
        PageMeta(
            p4,
            "location_plan",
            lang,
            labels=["WH-1", "WH-2", "WH-3"],
            ocr="skipped",
            used=False,
            confidence=0.9,
            reason="Site plan with borehole markers.",
        ),
    ]
    layers, lprov = layer_records(WH1_LAYERS, [2] * 4, language=lang)
    wh1 = BoreholeSpec(
        "WH-1",
        {
            "metadata": _nz_meta(
                "WH-1", 2037743.0, 5706760.0, "2037743.0", "5706760.0", 3.42, "2025-03-25", 12.3, None
            ),
            "stratigraphy": layers,
            "groundwater": [{"type": "other", "depth_m": 2.1, "date": None, "raw": "2.10 m (tidal)"}],
        },
        merge(header_prov(2, NZ_HEADER_PATHS), lprov, {"groundwater[0].depth_m": Pv(Ref(2, "gw0"))}),
        pages=[2],
        crs_status="inferred",
    )
    layers, lprov = layer_records(WH2_LAYERS, [3] * 4, language=lang)
    wh2 = BoreholeSpec(
        "WH-2",
        {
            "metadata": {
                **_nz_meta(
                    "WH-2", 2037901.1, 5706617.6, "2037901.1", "5706617.6", 3.18, "2025-03-27", 11.0, None
                ),
                "notes": "Core loss 3.80 - 4.10 m.",
            },
            "stratigraphy": layers,
            "groundwater": [{"type": "other", "depth_m": 1.85, "date": None, "raw": "1.85 m (tidal)"}],
        },
        merge(
            header_prov(3, NZ_HEADER_PATHS),
            lprov,
            {"groundwater[0].depth_m": Pv(Ref(3, "gw0")), "metadata.notes": Pv(Ref(3, "loss"))},
        ),
        pages=[3],
        crs_status="inferred",
    )
    nz1 = DocSpec(
        key="nz1",
        file_name=NZ1_FILE,
        project=NZ_PROJECT,
        status="needs_review",
        stage="validate",
        method="ocr",
        text_layer_quality=0.0,
        pages=pages1,
        boreholes=[wh1, wh2],
    )

    # Phase 2: a fully handwritten field sheet, a copy of a phase 1 page and photographs.
    q1 = TablePage(
        NZ_CO,
        "FIELD BOREHOLE SHEET",
        sheet_label="SHEET 1 OF 1",
        header=[
            ("Borehole", "bh", Hand("WH-3", 21)),
            ("Date", "start", Hand("2025-04-02", 22)),
            ("mE", "c1", Hand("2038060", 23)),
            ("mN", "c2", Hand("5706809", 24)),
            ("Level", "z", Hand("4.15 CD", 25)),
            ("Depths", "origin", Hand("below wharf deck", 26)),
            ("Total depth", "depth", Hand("10.5", 27)),
            ("Driller", "driller", Hand("T. H.", 28)),
        ],
        columns=NZ_COLS[:4],
        rows=layer_rows(WH3_LAYERS),
        notes=[("Water:", "gw0", Hand("tidal, ~2.4", 29))],
        footer=NZ2_FILE,
    )
    q2 = _wh2_page(NZ2_FILE, stamp="COPY")
    q3 = PhotoPage(
        NZ_CO,
        "CORE PHOTOGRAPHS - WH-3",
        "Core boxes 1 to 5, WH-3, 0.0 to 10.5 m (drawn stand-in).",
        seed=31,
        footer=NZ2_FILE,
    )
    pages2 = [
        PageMeta(
            q1,
            "log_sheet",
            lang,
            handwriting="full",
            labels=["WH-3"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            confidence=0.82,
            reason="Handwritten field log of one borehole.",
        ),
        PageMeta(
            q2,
            "duplicate",
            lang,
            handwriting="annotations",
            labels=["WH-2"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            ocr="skipped",
            used=False,
            confidence=0.95,
            reason="Same image as a page already stored.",
            duplicate_of=("nz1", 3),
        ),
        PageMeta(
            q3,
            "photos",
            lang,
            labels=["WH-3"],
            ocr="skipped",
            used=False,
            confidence=0.97,
            reason="Core box photographs.",
        ),
    ]
    layers, lprov = layer_records(WH3_LAYERS, [1] * 3, language=lang)
    wh3 = BoreholeSpec(
        "WH-3",
        {
            "metadata": {
                **_nz_meta(
                    "WH-3", 2038060.0, 5706809.0, "2038060", "5706809", 4.15, "2025-04-02", 10.5, "relative"
                ),
                "location_name": "Tarawhiti wharf",
            },
            "stratigraphy": layers,
            "groundwater": [{"type": "other", "depth_m": 2.4, "date": None, "raw": "tidal, ~2.4"}],
        },
        merge(
            header_prov(1, NZ_HEADER_PATHS | {"metadata.depth_origin": "origin"}),
            lprov,
            {
                "metadata.project_name": Pv(None, method="guessed", confidence=0.9, raw=None),
                "metadata.client": Pv(None, method="guessed", confidence=0.9, raw=None),
                "metadata.depth_origin": Pv(Ref(1, "origin"), method="guessed", confidence=0.55),
                "metadata.surface_elevation_mASL": Pv(
                    Ref(1, "z"),
                    confidence=0.52,
                    readings=[("ocr", "4.15", 0.52), ("second_read", "4.75", 0.66)],
                ),
                "groundwater[0].depth_m": Pv(Ref(1, "gw0"), confidence=0.64),
            },
        ),
        pages=[1],
        crs_status="inferred",
    )
    nz2 = DocSpec(
        key="nz2",
        file_name=NZ2_FILE,
        project=NZ_PROJECT,
        status="needs_review",
        stage="validate",
        method="ocr",
        text_layer_quality=0.0,
        pages=pages2,
        boreholes=[wh3],
    )
    return nz1, nz2


# --------------------------------------------------------------------------------------------------
# Document 5: USA, vector borings in feet, fully reviewed (done)
# --------------------------------------------------------------------------------------------------

US_CO = "Alder & Voss Engineering, PC (fictional)"
US_PROJECT = "Hollis Ridge Retaining Wall"
US_CLIENT = "Hollis Ridge Highway Dept. (fictional)"
US_FILE = "fictional-hollis-ridge-wall-borings.pdf"
US_DRILLER = "Ridgeback Drilling Co. (fictional)"
US_COLS = [
    Column("from", "From\n(ft)", 105),
    Column("to", "To\n(ft)", 105),
    Column("desc", "Description", 440),
    Column("spt", "SPT blows\n(per 6 in)", 140),
    Column("n", "N", 70),
    Column("tcr", "REC\n%", 70),
    Column("rqd", "RQD\n%", 70),
]
HR101_LAYERS = [
    LayerDef("0.0", "1.5", "TOPSOIL, dark brown, organic", "Mu", "Topsoil, dark brown, organic"),
    LayerDef(
        "1.5",
        "8.0",
        "Brown silty fine SAND, some gravel, moist, medium dense (SM)",
        "S",
        "Silty fine sand with some gravel, brown, medium dense",
        uscs=None,
        spt="6-8-9",
        n="17",
        spt_n=17,
        increments=[6, 8, 9],
        increment_mm=152,
    ),
    LayerDef(
        "8.0",
        "17.0",
        "Gray clayey SILT, stiff, wet (ML)",
        "U",
        "Clayey silt, grey, stiff",
        spt="4-5-7",
        n="12",
        spt_n=12,
        increments=[4, 5, 7],
        increment_mm=152,
    ),
    LayerDef(
        "17.0",
        "24.5",
        "Gray GNEISS, moderately weathered, hard, closely fractured",
        "Mem",
        "Gneiss, moderately weathered, hard, closely fractured",
        tcr="95",
        rqd="72",
    ),
]
HR102_LAYERS = [
    LayerDef("0.0", "2.0", "FILL: brown sandy gravel, dry, loose", "A", "Fill: sandy gravel, brown, loose"),
    LayerDef(
        "2.0",
        "11.0",
        "Brown fine to medium SAND, trace silt, dense (SP)",
        "mS",
        "Fine to medium sand, trace silt, brown, dense",
        spt="10-14-17",
        n="31",
        spt_n=31,
        increments=[10, 14, 17],
        increment_mm=152,
    ),
    LayerDef(
        "11.0",
        "19.0",
        "Gray mica SCHIST, highly weathered, soft",
        "Meb",
        "Mica schist, highly weathered, soft",
        tcr="80",
        rqd="20",
    ),
]


def _us_header(
    label: str, loc: str, north: str, east: str, el: str, date: str, depth: str
) -> list[tuple[str, str, Cell]]:
    return [
        ("Boring No.", "bh", label),
        ("Project", "project", US_PROJECT),
        ("Client", "client", US_CLIENT),
        ("Location", "loc", loc),
        ("Northing", "c1", north),
        ("Easting", "c2", east),
        ("Coordinate system", "crs", "WGS 84 / UTM zone 18N"),
        ("Ground surface el.", "z", el),
        ("Date started", "start", date),
        ("Date completed", "end", date),
        ("Drilling method", "method", "Hollow stem auger / NQ core"),
        ("Total depth", "depth", depth),
        ("Driller", "contractor", US_DRILLER),
        ("Hammer", "hammer", "Automatic, 140 lb"),
    ]


US_HEADER_PATHS = {
    "metadata.borehole_id": "bh",
    "metadata.project_name": "project",
    "metadata.client": "client",
    "metadata.location_name": "loc",
    "metadata.coordinates.local_x": "c2",
    "metadata.coordinates.local_y": "c1",
    "metadata.coordinates.x_raw": "c1",
    "metadata.coordinates.y_raw": "c2",
    "metadata.coordinates.coordinate_system": "crs",
    "metadata.surface_elevation_mASL": "z",
    "metadata.elevation_datum": "z",
    "metadata.start_date": "start",
    "metadata.end_date": "end",
    "metadata.drilling_method": "method",
    "metadata.borehole_depth_m": "depth",
    "metadata.drilling_contractor": "contractor",
    "metadata.depth_origin": "origin",
}


def _us_meta(
    label: str,
    loc: str,
    north: float,
    east: float,
    nr: str,
    er: str,
    el_ft: float,
    date: str,
    depth_ft: float,
) -> dict[str, Any]:
    return metadata(
        borehole_id=label,
        location_name=loc,
        country="United States",
        project_name=US_PROJECT,
        client=US_CLIENT,
        drilling_contractor=US_DRILLER,
        drilling_method="Hollow stem auger / NQ core",
        start_date=date,
        end_date=date,
        surface_elevation_mASL=round(el_ft * FT, 3),
        elevation_datum="NAVD 88",
        depth_origin="ground",
        borehole_depth_m=round(depth_ft * FT, 3),
        borehole_depth_source="printed",
        coordinates={
            "local_x": east,
            "local_y": north,
            "x_raw": nr,
            "y_raw": er,
            "axis_labels_raw": "Northing, Easting",
            "coordinate_system": "WGS 84 / UTM zone 18N",
            "crs_code": "EPSG:32618",
        },
    )


def _us_doc() -> DocSpec:
    footer = US_FILE
    origin = ("Depths:", "origin", "feet below ground surface")
    p1 = TablePage(
        US_CO,
        "LOG OF BORING",
        sheet_label="SHEET 1 OF 1",
        header=_us_header(
            "HR-101",
            "Sta. 12+40, 15 ft Lt.",
            "4,608,398.9",
            "579,039.4",
            "412.6 ft (NAVD 88)",
            "03/14/2025",
            "24.5 ft",
        ),
        columns=US_COLS,
        rows=layer_rows(HR101_LAYERS),
        notes=[("Groundwater:", "gw0", "encountered at 9.5 ft during drilling"), origin],
        footer=footer,
    )
    p2 = TablePage(
        US_CO,
        "LOG OF BORING",
        sheet_label="SHEET 1 OF 1",
        header=_us_header(
            "HR-102",
            "Sta. 14+10, 12 ft Rt.",
            "4,608,588.9",
            "579,154.0",
            "418.2 ft (NAVD 88)",
            "03/17/2025",
            "19.0 ft",
        ),
        columns=US_COLS,
        rows=layer_rows(HR102_LAYERS),
        notes=[("Groundwater:", "gwnote", "not encountered"), origin],
        footer=footer,
    )
    p3 = TablePage(
        US_CO,
        "LABORATORY TEST SUMMARY",
        columns=[
            Column("s", "Sample", 110),
            Column("bh", "Boring", 120),
            Column("from", "Top\n(ft)", 100),
            Column("to", "Bottom\n(ft)", 100),
            Column("w", "Moisture\ncontent (%)", 160),
            Column("ll", "Liquid\nlimit (%)", 130),
            Column("ucs", "UCS\n(MPa)", 120),
        ],
        rows=[
            (
                "r1",
                {"s": "S-2", "bh": "HR-101", "from": "3.5", "to": "5.0", "w": "18.2", "ll": "34", "ucs": "-"},
            ),
            (
                "r2",
                {
                    "s": "S-4",
                    "bh": "HR-101",
                    "from": "8.5",
                    "to": "10.0",
                    "w": "27.5",
                    "ll": "41",
                    "ucs": "-",
                },
            ),
            (
                "r3",
                {
                    "s": "C-1",
                    "bh": "HR-102",
                    "from": "13.0",
                    "to": "14.5",
                    "w": "-",
                    "ll": "-",
                    "ucs": "38.4",
                },
            ),
        ],
        footer=footer,
    )
    lang = "en"
    pages = [
        PageMeta(
            p1,
            "log_sheet",
            lang,
            labels=["HR-101"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            confidence=0.99,
            reason="Boring log with header and layer table.",
        ),
        PageMeta(
            p2,
            "log_sheet",
            lang,
            labels=["HR-102"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            confidence=0.99,
            reason="Boring log with header and layer table.",
        ),
        PageMeta(
            p3,
            "lab_results",
            lang,
            labels=["HR-101", "HR-102"],
            confidence=0.97,
            reason="Laboratory test summary table.",
        ),
    ]
    layers, lprov = layer_records(HR101_LAYERS, [1] * 4, language=lang, factor=FT)
    hr101 = BoreholeSpec(
        "HR-101",
        {
            "metadata": _us_meta(
                "HR-101",
                "Sta. 12+40, 15 ft Lt.",
                4608398.9,
                579039.4,
                "4,608,398.9",
                "579,039.4",
                412.6,
                "2025-03-14",
                24.5,
            ),
            "stratigraphy": layers,
            "groundwater": [
                {
                    "type": "strike",
                    "depth_m": round(9.5 * FT, 3),
                    "date": None,
                    "raw": "encountered at 9.5 ft during drilling",
                }
            ],
            "samples": [
                {
                    "name": "S-2",
                    "type_code": "SS",
                    "depth_from_m": round(3.5 * FT, 3),
                    "depth_to_m": round(5.0 * FT, 3),
                },
                {
                    "name": "S-4",
                    "type_code": "SS",
                    "depth_from_m": round(8.5 * FT, 3),
                    "depth_to_m": round(10 * FT, 3),
                },
            ],
            "test_results": [
                {
                    "name": "Watercontent",
                    "value": 18.2,
                    "unit": "%",
                    "sample_name": "S-2",
                    "depth_m": round(3.5 * FT, 3),
                },
                {
                    "name": "LiquidLimit",
                    "value": 34.0,
                    "unit": "%",
                    "sample_name": "S-2",
                    "depth_m": round(3.5 * FT, 3),
                },
                {
                    "name": "Watercontent",
                    "value": 27.5,
                    "unit": "%",
                    "sample_name": "S-4",
                    "depth_m": round(8.5 * FT, 3),
                },
                {
                    "name": "LiquidLimit",
                    "value": 41.0,
                    "unit": "%",
                    "sample_name": "S-4",
                    "depth_m": round(8.5 * FT, 3),
                },
            ],
        },
        merge(
            header_prov(1, US_HEADER_PATHS),
            {"metadata.country": Pv(None, method="guessed", confidence=0.8, raw=None)},
            lprov,
            {
                "groundwater[0].depth_m": Pv(Ref(1, "gw0")),
                "samples[0].name": Pv(Ref(3, "r1.s")),
                "samples[0].depth_from_m": Pv(Ref(3, "r1.from")),
                "samples[0].depth_to_m": Pv(Ref(3, "r1.to")),
                "samples[1].name": Pv(Ref(3, "r2.s")),
                "samples[1].depth_from_m": Pv(Ref(3, "r2.from")),
                "samples[1].depth_to_m": Pv(Ref(3, "r2.to")),
                "test_results[0].value": Pv(Ref(3, "r1.w")),
                "test_results[1].value": Pv(Ref(3, "r1.ll")),
                "test_results[2].value": Pv(Ref(3, "r2.w")),
                "test_results[3].value": Pv(Ref(3, "r2.ll")),
            },
        ),
        pages=[1, 3],
        crs_status="stated",
        crs_code="EPSG:32618",
        approve_all=True,
    )
    layers, lprov = layer_records(HR102_LAYERS, [2] * 3, language=lang, factor=FT)
    hr102 = BoreholeSpec(
        "HR-102",
        {
            "metadata": {
                **_us_meta(
                    "HR-102",
                    "Sta. 14+10, 12 ft Rt.",
                    4608588.9,
                    579154.0,
                    "4,608,588.9",
                    "579,154.0",
                    418.2,
                    "2025-03-17",
                    19.0,
                ),
                "notes": "Groundwater not encountered.",
            },
            "stratigraphy": layers,
            "samples": [
                {
                    "name": "C-1",
                    "type_code": "NQ",
                    "depth_from_m": round(13 * FT, 3),
                    "depth_to_m": round(14.5 * FT, 3),
                },
            ],
            "test_results": [
                {
                    "name": "UCS",
                    "value": 38.4,
                    "unit": "MPa",
                    "sample_name": "C-1",
                    "depth_m": round(13 * FT, 3),
                },
            ],
        },
        merge(
            header_prov(2, US_HEADER_PATHS),
            {
                "metadata.country": Pv(None, method="guessed", confidence=0.8, raw=None),
                "metadata.notes": Pv(Ref(2, "gwnote")),
            },
            lprov,
            {
                "samples[0].name": Pv(Ref(3, "r3.s")),
                "samples[0].depth_from_m": Pv(Ref(3, "r3.from")),
                "samples[0].depth_to_m": Pv(Ref(3, "r3.to")),
                "test_results[0].value": Pv(Ref(3, "r3.ucs")),
            },
        ),
        pages=[2, 3],
        crs_status="stated",
        crs_code="EPSG:32618",
        approve_all=True,
    )
    return DocSpec(
        key="us",
        file_name=US_FILE,
        project=US_PROJECT,
        status="needs_review",  # becomes done once every value is approved below
        stage="validate",
        method="read",
        text_layer_quality=0.98,
        pages=pages,
        boreholes=[hr101, hr102],
    )


# --------------------------------------------------------------------------------------------------
# Document 6: Chile, WGS84 decimal degrees printed (stated EPSG:4326), a typo latitude, a site grid
# --------------------------------------------------------------------------------------------------

CL_CO = "Sondajes Altiplano SpA (ficticio)"
CL_PROJECT = "Planta Salar Verde"
CL_CLIENT = "Minera Salar Verde (ficticio)"
CL_FILE = "fictional-salar-verde-sondajes.pdf"
CL_COLS = [
    Column("from", "Desde\n(m)", 95),
    Column("to", "Hasta\n(m)", 95),
    Column("desc", "Descripcion", 560),
    Column("spt", "SPT\nN", 90),
]
SV1_LAYERS = [
    LayerDef(
        "0,00",
        "0,60",
        "Costra salina sobre arena fina limosa, blanca, cementada",
        "fS",
        "Salt crust over silty fine sand, white, cemented",
    ),
    LayerDef(
        "0,60",
        "3,40",
        "Arena media limosa, cafe claro, compacidad media, humeda",
        "mS",
        "Silty medium sand, light brown, medium dense, moist",
        spt="22",
        spt_n=22,
    ),
    LayerDef(
        "3,40",
        "6,00",
        "Grava media arenosa, gris, muy densa",
        "mG",
        "Sandy medium gravel, grey, very dense",
        spt="47",
        spt_n=47,
    ),
]
SV2_LAYERS = [
    LayerDef(
        "0,00", "1,10", "Limo arcilloso, cafe, firme", "U", "Clayey silt, brown, firm", spt="11", spt_n=11
    ),
    LayerDef(
        "1,10",
        "5,00",
        "Arena gruesa con grava, gris, densa",
        "gS",
        "Coarse sand with gravel, grey, dense",
        spt="35",
        spt_n=35,
    ),
]
SV3_LAYERS = [
    LayerDef(
        "0,00",
        "2,50",
        "Arena fina limosa, beige, suelta",
        "fS",
        "Silty fine sand, beige, loose",
        spt="9",
        spt_n=9,
    ),
    LayerDef("2,50", "4,00", "Yeso masivo, blanco, roca blanda", "Gyst", "Massive gypsum, white, weak rock"),
]
SV4_LAYERS = [
    LayerDef(
        "0,00",
        "3,00",
        "Arcilla limosa, gris verdosa, blanda",
        "T",
        "Silty clay, greenish grey, soft",
        spt="5",
        spt_n=5,
    ),
]


def _cl_header(label: str, lat: str, lon: str, z: str, date: str, depth: str) -> list[tuple[str, str, Cell]]:
    return [
        ("Sondaje", "bh", label),
        ("Proyecto", "project", CL_PROJECT),
        ("Mandante", "client", CL_CLIENT),
        ("Ubicacion", "loc", "Salar Verde, sector planta"),
        ("Latitud", "lat", lat),
        ("Longitud", "lon", lon),
        ("Datum", "crs", "WGS84"),
        ("Cota", "z", z),
        ("Fecha", "start", date),
        ("Profundidad total", "depth", depth),
    ]


CL_HEADER_PATHS = {
    "metadata.borehole_id": "bh",
    "metadata.project_name": "project",
    "metadata.client": "client",
    "metadata.location_name": "loc",
    "metadata.coordinates.latitude": "lat",
    "metadata.coordinates.longitude": "lon",
    "metadata.coordinates.x_raw": "lat",
    "metadata.coordinates.y_raw": "lon",
    "metadata.coordinates.coordinate_system": "crs",
    "metadata.surface_elevation_mASL": "z",
    "metadata.elevation_datum": "z",
    "metadata.start_date": "start",
    "metadata.borehole_depth_m": "depth",
}


def _cl_meta(
    label: str,
    lat: float | None,
    lon: float | None,
    latr: str | None,
    lonr: str | None,
    z: float | None,
    date: str,
    depth: float,
    coords: dict[str, Any] | None = None,
) -> dict[str, Any]:
    coordinates = coords or {
        "latitude": lat,
        "longitude": lon,
        "x_raw": latr,
        "y_raw": lonr,
        "axis_labels_raw": "Latitud, Longitud",
        "coordinate_system": "WGS84",
        "crs_code": "EPSG:4326",
    }
    return metadata(
        borehole_id=label,
        location_name="Salar Verde, sector planta",
        country="Chile",
        project_name=CL_PROJECT,
        client=CL_CLIENT,
        start_date=date,
        surface_elevation_mASL=z,
        elevation_datum="m s.n.m." if z is not None else None,
        borehole_depth_m=depth,
        borehole_depth_source="printed",
        coordinates=coordinates,
    )


def _cl_doc() -> DocSpec:
    footer = CL_FILE
    p1 = TablePage(
        CL_CO,
        "CUADRO DE SONDAJES",
        intro="Coordenadas geograficas WGS84 en grados decimales. SV-04 solo tiene coordenadas de la "
        "grilla local de obra (ver hoja 4).",
        columns=[
            Column("bh", "Sondaje", 140),
            Column("lat", "Latitud", 190),
            Column("lon", "Longitud", 190),
            Column("z", "Cota\n(m s.n.m.)", 150),
            Column("d", "Prof.\n(m)", 110),
            Column("obs", "Observacion", 220),
        ],
        rows=[
            (
                "SV-01",
                {
                    "bh": "SV-01",
                    "lat": "-23.65120",
                    "lon": "-68.22070",
                    "z": "2.304",
                    "d": "6,00",
                    "obs": "-",
                },
            ),
            (
                "SV-02",
                {
                    "bh": "SV-02",
                    "lat": "-23.65410",
                    "lon": "-68.21830",
                    "z": "2.298",
                    "d": "5,00",
                    "obs": "-",
                },
            ),
            (
                "SV-03",
                {
                    "bh": "SV-03",
                    "lat": "-236.5180",
                    "lon": "-68.21550",
                    "z": "2.296",
                    "d": "4,00",
                    "obs": "-",
                },
            ),
            (
                "SV-04",
                {"bh": "SV-04", "lat": "-", "lon": "-", "z": "-", "d": "3,00", "obs": "grilla de obra"},
            ),
        ],
        footer=footer,
    )
    p2 = TablePage(
        CL_CO,
        "REGISTRO DE SONDAJE",
        sheet_label="HOJA 1 DE 1",
        header=_cl_header("SV-01", "-23.65120", "-68.22070", "2.304 m s.n.m.", "05-05-2025", "6,00 m"),
        columns=CL_COLS,
        rows=layer_rows(SV1_LAYERS),
        notes=[("Nivel freatico (06-05-2025):", "gw0", "4,10 m")],
        footer=footer,
    )
    p3 = TablePage(
        CL_CO,
        "REGISTRO DE SONDAJE",
        sheet_label="HOJA 1 DE 1",
        header=_cl_header("SV-02", "-23.65410", "-68.21830", "2.298 m s.n.m.", "07-05-2025", "5,00 m"),
        columns=CL_COLS,
        rows=layer_rows(SV2_LAYERS),
        notes=[
            ("Muestra M2:", "m2", "4,00 - 4,40 m"),
            ("CAI (muestra M2):", "cai", "4,2"),
            ("Nivel freatico:", "gwnote", "no detectado"),
        ],
        footer=footer,
    )
    sv3_header = _cl_header("SV-03", "-236.5180", "-68.21550", "2.296 m s.n.m.", "08-05-2025", "4,00 m")
    sv4_header: list[tuple[str, str, Cell]] = [
        ("Sondaje", "bh4", "SV-04"),
        ("Fecha", "start4", "09-05-2025"),
        ("Coord. de obra X", "c1", "512,40"),
        ("Coord. de obra Y", "c2", "1.208,75"),
        ("Sistema", "crs4", "grilla local de obra"),
        ("Profundidad total", "depth4", "3,00 m"),
    ]
    sv4_rows = [(f"M{i}", cells) for i, (_, cells) in enumerate(layer_rows(SV4_LAYERS))]
    p4 = MultiLogPage(
        CL_CO,
        "REGISTRO DE SONDAJES CORTOS",
        blocks=[(sv3_header, CL_COLS, layer_rows(SV3_LAYERS)), (sv4_header, CL_COLS, sv4_rows)],
        footer=footer,
    )
    lang = "es"
    pages = [
        PageMeta(
            p1,
            "coordinate_table",
            lang,
            labels=["SV-01", "SV-02", "SV-03", "SV-04"],
            has_coordinates=True,
            confidence=0.95,
            reason="Table of boreholes with geographic coordinates.",
        ),
        PageMeta(
            p2,
            "log_sheet",
            lang,
            labels=["SV-01"],
            sheet=("HOJA 1 DE 1", 1, 1),
            has_coordinates=True,
            confidence=0.96,
            reason="Borehole log with header and layer table.",
        ),
        PageMeta(
            p3,
            "log_sheet",
            lang,
            labels=["SV-02"],
            sheet=("HOJA 1 DE 1", 1, 1),
            has_coordinates=True,
            confidence=0.96,
            reason="Borehole log with header and layer table.",
        ),
        PageMeta(
            p4,
            "log_sheet",
            lang,
            labels=["SV-03", "SV-04"],
            has_coordinates=True,
            confidence=0.88,
            reason="Two short logs on one sheet.",
        ),
    ]
    layers, lprov = layer_records(SV1_LAYERS, [2] * 3, language=lang)
    sv1 = BoreholeSpec(
        "SV-01",
        {
            "metadata": _cl_meta(
                "SV-01", -23.6512, -68.2207, "-23.65120", "-68.22070", 2304.0, "2025-05-05", 6.0
            ),
            "stratigraphy": layers,
            "groundwater": [{"type": "rest", "depth_m": 4.1, "date": "2025-05-06", "raw": "4,10 m"}],
        },
        merge(
            header_prov(2, CL_HEADER_PATHS),
            lprov,
            {"groundwater[0].depth_m": Pv(Ref(2, "gw0")), "groundwater[0].date": Pv(Ref(2, "gw0"))},
        ),
        pages=[1, 2],
        crs_status="stated",
        crs_code="EPSG:4326",
    )
    layers, lprov = layer_records(SV2_LAYERS, [3] * 2, language=lang)
    sv2 = BoreholeSpec(
        "SV-02",
        {
            "metadata": {
                **_cl_meta("SV-02", -23.6541, -68.2183, "-23.65410", "-68.21830", 2298.0, "2025-05-07", 5.0),
                "notes": "Nivel freatico no detectado.",
            },
            "stratigraphy": layers,
            "samples": [{"name": "M2", "type_code": "M", "depth_from_m": 4.0, "depth_to_m": 4.4}],
            "test_results": [
                {"name": "CAI", "value": 4.2, "unit": None, "sample_name": "M2", "depth_m": 4.0}
            ],
        },
        merge(
            header_prov(3, CL_HEADER_PATHS),
            lprov,
            {
                "metadata.notes": Pv(Ref(3, "gwnote")),
                "samples[0].name": Pv(Ref(3, "m2")),
                "samples[0].depth_from_m": Pv(Ref(3, "m2")),
                "samples[0].depth_to_m": Pv(Ref(3, "m2")),
                "test_results[0].value": Pv(Ref(3, "cai")),
            },
        ),
        pages=[1, 3],
        crs_status="stated",
        crs_code="EPSG:4326",
    )
    layers, lprov = layer_records(SV3_LAYERS, [4] * 2, language=lang)
    sv3 = BoreholeSpec(
        "SV-03",
        {
            "metadata": _cl_meta(
                "SV-03", -236.518, -68.2155, "-236.5180", "-68.21550", 2296.0, "2025-05-08", 4.0
            ),
            "stratigraphy": layers,
        },
        merge(header_prov(4, CL_HEADER_PATHS), lprov),
        pages=[1, 4],
        crs_status="stated",
        crs_code="EPSG:4326",
    )
    sv4_layers, _ = layer_records(SV4_LAYERS, [4], language=lang)
    sv4_prov = {
        "stratigraphy[0].depth_from_m": Pv(Ref(4, "M0.from")),
        "stratigraphy[0].depth_to_m": Pv(Ref(4, "M0.to")),
        "stratigraphy[0].original_description": Pv(Ref(4, "M0.desc")),
        "stratigraphy[0].din4023_code": Pv(Ref(4, "M0.desc"), method="derived", confidence=0.86, raw=None),
        "stratigraphy[0].spt_n_value": Pv(Ref(4, "M0.spt")),
    }
    sv4 = BoreholeSpec(
        "SV-04",
        {
            "metadata": _cl_meta(
                "SV-04",
                None,
                None,
                None,
                None,
                None,
                "2025-05-09",
                3.0,
                coords={
                    "local_x": 512.4,
                    "local_y": 1208.75,
                    "x_raw": "512,40",
                    "y_raw": "1.208,75",
                    "axis_labels_raw": "X, Y",
                    "coordinate_system": "grilla local de obra",
                },
            ),
            "stratigraphy": sv4_layers,
        },
        merge(
            header_prov(
                4,
                {
                    "metadata.borehole_id": "bh4",
                    "metadata.start_date": "start4",
                    "metadata.coordinates.local_x": "c1",
                    "metadata.coordinates.local_y": "c2",
                    "metadata.coordinates.x_raw": "c1",
                    "metadata.coordinates.y_raw": "c2",
                    "metadata.coordinates.coordinate_system": "crs4",
                    "metadata.borehole_depth_m": "depth4",
                },
            ),
            {"metadata.project_name": Pv(None, method="guessed", confidence=0.9, raw=None)},
            sv4_prov,
        ),
        pages=[1, 4],
        crs_status="unknown",
    )
    return DocSpec(
        key="cl",
        file_name=CL_FILE,
        project=CL_PROJECT,
        status="needs_review",
        stage="validate",
        method="ocr",
        text_layer_quality=0.41,
        pages=pages,
        boreholes=[sv1, sv2, sv3, sv4],
        expected_ids=["SV-01", "SV-02", "SV-03", "SV-04"],
    )


# --------------------------------------------------------------------------------------------------
# Documents 7 and 8: still classifying (Tanzania) and failed (Norway); no boreholes
# --------------------------------------------------------------------------------------------------

TZ_CO = "Mlima Drilling Services (fictional)"
TZ_FILE = "fictional-kilima-road-borehole-scan.pdf"
NO_CO = "Nordvest Geoteknikk AS (fiktiv)"
NO_FILE = "fictional-fjordvik-kai-grunnundersokelse.pdf"


def _simple_log(
    company: str,
    title: str,
    label: str,
    sheet: str | None,
    header: list[tuple[str, str, Cell]],
    rows: list[tuple[str, str, str, str]],
    footer: str,
    titles: tuple[str, str, str, str],
) -> TablePage:
    columns = [
        Column("from", titles[0], 100),
        Column("to", titles[1], 100),
        Column("desc", titles[2], 600),
        Column("spt", titles[3], 100),
    ]
    return TablePage(
        company,
        title,
        sheet_label=sheet,
        header=[("Borehole" if titles[0].startswith("From") else "Borhull", "bh", label), *header],
        columns=columns,
        rows=[(f"L{i}", {"from": a, "to": b, "desc": c, "spt": d}) for i, (a, b, c, d) in enumerate(rows)],
        footer=footer,
    )


def _tz_doc() -> DocSpec:
    en = ("From\n(m)", "To\n(m)", "Description", "SPT\nN")
    p1 = TextPage(
        TZ_CO,
        "KILIMA ROAD REHABILITATION - BOREHOLE RECORDS",
        subtitle_lines=["Section km 14 - km 22", "Scanned field copies, 2025"],
        paragraphs=["Fictional cover page of an invented report used for software testing."],
        footer=TZ_FILE,
    )
    p2 = _simple_log(
        TZ_CO,
        "BOREHOLE RECORD",
        "BH-K1",
        "SHEET 1 OF 1",
        [("Chainage", "loc", "km 14+300"), ("Coordinates", "xy", "E 391 245  N 9 621 870")],
        [
            ("0.00", "0.80", "Red lateritic gravel, dense", "32"),
            ("0.80", "3.50", "Red-brown sandy clay, stiff", "14"),
            ("3.50", "6.00", "Weathered granite, completely weathered", "50/90"),
        ],
        TZ_FILE,
        en,
    )
    p3 = _simple_log(
        TZ_CO,
        "BOREHOLE RECORD",
        "BH-K2",
        "SHEET 1 OF 1",
        [("Chainage", "loc", "km 17+850"), ("Coordinates", "xy", Hand("E 392 910  N 9 618 405", 41))],
        [
            ("0.00", "1.20", "Black cotton soil, expansive clay, firm", "7"),
            ("1.20", "4.00", "Grey silty sand, medium dense", "21"),
        ],
        TZ_FILE,
        en,
    )
    p4 = _simple_log(
        TZ_CO,
        "BOREHOLE RECORD",
        "BH-K3",
        "SHEET 1 OF 1",
        [("Chainage", "loc", "km 21+100"), ("Coordinates", "xy", "not recorded")],
        [("0.00", "2.00", "Brown clayey sand, loose", "6")],
        TZ_FILE,
        en,
    )
    p5 = PhotoPage(
        TZ_CO,
        "SITE PHOTOGRAPHS",
        "Trial pit and auger spoil, km 21+100 (drawn stand-in).",
        seed=51,
        footer=TZ_FILE,
    )
    pages = [
        PageMeta(
            p1, "cover_or_toc", "en", ocr="skipped", used=False, confidence=0.96, reason="Report cover."
        ),
        PageMeta(
            p2,
            "log_sheet",
            "en",
            labels=["BH-K1"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            ocr="pending",
            confidence=0.94,
            reason="Borehole record with layer table.",
        ),
        PageMeta(
            p3,
            "log_sheet",
            "en",
            handwriting="partial",
            labels=["BH-K2"],
            sheet=("SHEET 1 OF 1", 1, 1),
            has_coordinates=True,
            ocr="pending",
            confidence=0.9,
            reason="Borehole record; coordinates handwritten.",
        ),
        PageMeta(
            p4, None, None, handwriting=None, has_coordinates=None, ocr=None, used=False, confidence=None
        ),
        PageMeta(
            p5, None, None, handwriting=None, has_coordinates=None, ocr=None, used=False, confidence=None
        ),
    ]
    return DocSpec(
        key="tz",
        file_name=TZ_FILE,
        project=None,
        status="classifying",
        stage="triage",
        method="ocr",
        text_layer_quality=0.0,
        pages=pages,
        progress={
            "pages_total": 5,
            "pages_classified": 3,
            "pages_ocr_total": 0,
            "pages_ocr_done": 0,
            "boreholes_extracted": 0,
        },
    )


def _no_doc() -> DocSpec:
    nb = ("Fra\n(m)", "Til\n(m)", "Beskrivelse", "Slag")
    p1 = TextPage(
        NO_CO,
        "GRUNNUNDERSOKELSE FJORDVIK KAI",
        subtitle_lines=["Datarapport", "Mai 2025"],
        paragraphs=["Fiktiv rapport laget for testing av programvare. Ingen reelle data."],
        footer=NO_FILE,
    )
    p2 = _simple_log(
        NO_CO,
        "BORPROFIL",
        "B1",
        "ARK 1 AV 1",
        [("Koordinater", "xy", "Euref89 UTM32: 302 115 / 6 812 440")],
        [
            ("0,00", "1,50", "Fylling, grus og stein", "-"),
            ("1,50", "7,20", "Leire, bloet, kvikkleire ikke paavist", "-"),
        ],
        NO_FILE,
        nb,
    )
    pages = [
        PageMeta(
            p1, "cover_or_toc", "nb", ocr="skipped", used=False, confidence=0.95, reason="Report cover."
        ),
        PageMeta(
            p2,
            "log_sheet",
            "nb",
            labels=["B1"],
            sheet=("ARK 1 AV 1", 1, 1),
            has_coordinates=True,
            ocr="failed",
            confidence=0.93,
            reason="Borehole profile with layer table.",
        ),
    ]
    return DocSpec(
        key="no",
        file_name=NO_FILE,
        project=None,
        status="failed",
        stage="classify",
        method="ocr",
        text_layer_quality=0.0,
        pages=pages,
        error="Text recognition failed on page 2 after 3 attempts. Retry when the OCR service is reachable.",
        progress={
            "pages_total": 2,
            "pages_classified": 2,
            "pages_ocr_total": 1,
            "pages_ocr_done": 0,
            "boreholes_extracted": 0,
        },
    )


def document_specs() -> list[DocSpec]:
    nz1, nz2 = _nz_docs()
    return [_de_doc(), _au_doc(), nz1, nz2, _us_doc(), _cl_doc(), _tz_doc(), _no_doc()]


# --------------------------------------------------------------------------------------------------
# Rendering (pure; no database)
# --------------------------------------------------------------------------------------------------


def render_documents(specs: Sequence[DocSpec] | None = None) -> list[RenderedDoc]:
    rendered = []
    for spec in specs or document_specs():
        sheets = [draw_page(page.spec) for page in spec.pages]
        pdf = pdf_bytes([s.image for s in sheets], title=f"{spec.file_name} - FICTIONAL DEMO DATA")
        rendered.append(RenderedDoc(spec, sheets, pdf, hashlib.sha256(pdf).hexdigest()))
    return rendered


# --------------------------------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------------------------------


def _default_confidence(method: str, path: str, anchor: Anchor | None) -> float | None:
    jitter = (zlib.crc32(path.encode()) % 6) / 100
    if anchor is not None and anchor.hand:
        return round(0.66 + jitter * 2, 2)
    if method == "read":
        return 0.99
    if method == "ocr":
        return round(0.91 + jitter, 2)
    return None


def _provenance(spec: DocSpec, sheets: Sequence[Sheet], prov: dict[str, Pv]) -> dict[str, ProvenanceIn]:
    out: dict[str, ProvenanceIn] = {}
    for path, pv in prov.items():
        anchor = sheets[pv.ref.page - 1].anchors[pv.ref.key] if pv.ref is not None else None
        method = pv.method or spec.method
        raw = pv.raw
        if raw == "<anchor>":
            raw = anchor.text if anchor is not None else None
        confidence = pv.confidence
        if confidence is None and pv.state == "ok" and pv.cell is None:
            confidence = _default_confidence(method, path, anchor)
        out[path] = ProvenanceIn(
            page=pv.ref.page if pv.ref is not None else None,
            box=anchor.box if anchor is not None else None,
            raw=raw,
            cell=pv.cell,
            method=method,
            confidence=confidence,
            status=pv.status,
            state=pv.state,
            flag=pv.flag,
            readings=[Reading(reader=r, text=t, confidence=c) for r, t, c in pv.readings],
        )
    return out


@dataclass
class _Ctx:
    docs: dict[str, Document] = field(default_factory=dict)
    sheets: dict[str, list[Sheet]] = field(default_factory=dict)
    uids: dict[tuple[str, str], str] = field(default_factory=dict)

    def box(self, doc: str, page: int, *keys: str) -> list[float]:
        """Union of the anchors' boxes on one page."""
        boxes = [self.sheets[doc][page - 1].anchors[k].box for k in keys]
        x0 = min(b[0] for b in boxes)
        y0 = min(b[1] for b in boxes)
        x1 = max(b[0] + b[2] for b in boxes)
        y1 = max(b[1] + b[3] for b in boxes)
        return [round(x0, 4), round(y0, 4), round(min(x1, 1.0) - x0, 4), round(min(y1, 1.0) - y0, 4)]

    def ev(self, doc: str, page: int, *keys: str, snippet: str | None = None) -> dict[str, Any]:
        if not keys:
            return {"document_id": self.docs[doc].id, "page": page, "box": None, "snippet": snippet}
        texts = " ".join(self.sheets[doc][page - 1].anchors[k].text for k in keys)
        return {
            "document_id": self.docs[doc].id,
            "page": page,
            "box": self.box(doc, page, *keys),
            "snippet": snippet or texts,
        }


async def _add_document(
    session: AsyncSession,
    storage: FileStorage,
    rendered: RenderedDoc,
    ctx: _Ctx,
    created_at: datetime,
    written: list[str],
) -> Document:
    spec = rendered.spec
    key = original_key(rendered.sha256, ".pdf")
    doc = Document(
        id=new_id("doc"),
        file_name=spec.file_name,
        project=spec.project,
        sha256=rendered.sha256,
        mime_type="application/pdf",
        size_bytes=len(rendered.pdf),
        storage_key=key,
        status=spec.status,
        stage=spec.stage,
        error=spec.error,
        page_count=len(spec.pages),
        progress=spec.progress,
        is_seed=True,
        created_at=created_at,
        updated_at=created_at,
    )
    session.add(doc)
    await session.flush()
    ctx.docs[spec.key] = doc
    ctx.sheets[spec.key] = rendered.sheets
    storage.put_bytes(key, rendered.pdf)
    written.append(key)
    for n, (meta, sheet) in enumerate(zip(spec.pages, rendered.sheets, strict=True), start=1):
        render_key, thumb_key = page_render_key(doc.id, n), page_thumb_key(doc.id, n)
        storage.put_bytes(render_key, png_bytes(sheet.image))
        storage.put_bytes(thumb_key, thumbnail_png(sheet.image))
        written.extend((render_key, thumb_key))
        dup_doc, dup_n = None, None
        if meta.duplicate_of is not None:
            dup_doc, dup_n = ctx.docs[meta.duplicate_of[0]].id, meta.duplicate_of[1]
        unused = None
        if not meta.used and meta.role is not None:
            dup_file = ctx.docs[meta.duplicate_of[0]].file_name if meta.duplicate_of else None
            unused = unused_reason_for(meta.role, duplicate_file=dup_file, duplicate_n=dup_n)
        session.add(
            Page(
                document_id=doc.id,
                n=n,
                width_px=sheet.width,
                height_px=sheet.height,
                render_key=render_key,
                thumb_key=thumb_key,
                text_layer_quality=spec.text_layer_quality,
                role=meta.role,
                type=page_type_for(meta.role),
                handwriting=meta.handwriting,
                language=meta.language,
                borehole_labels=list(meta.labels),
                sheet_label=meta.sheet[0] if meta.sheet else None,
                sheet_index=meta.sheet[1] if meta.sheet else None,
                sheet_total=meta.sheet[2] if meta.sheet else None,
                has_coordinates=meta.has_coordinates,
                classifier_confidence=meta.confidence,
                classifier={"reason": meta.reason, "seed": True} if meta.role is not None else None,
                ocr_status=meta.ocr,
                duplicate_of_doc=dup_doc,
                duplicate_of_n=dup_n,
                used=meta.used,
                unused_reason=unused,
            )
        )
    await session.flush()
    return doc


async def _approve_all(session: AsyncSession, bh: Borehole) -> None:
    fvs = await load_field_values(session, bh.uid)
    for fv in fvs.values():
        fv.status = "approved"
        fv.flag = None
    changes = {"action": "approve", "paths": sorted(fvs)}
    await commit_change(session, bh, fvs, actor=REVIEWER, action="approve", changes=changes)


async def _add_boreholes(session: AsyncSession, rendered: RenderedDoc, ctx: _Ctx) -> None:
    spec = rendered.spec
    doc = ctx.docs[spec.key]
    for bspec in spec.boreholes:
        bh = await create_borehole(
            session,
            document=doc,
            group_key=f"seed:{spec.key}:{bspec.label}",
            body=bspec.body,
            provenance=_provenance(spec, rendered.sheets, bspec.prov),
            crs_status=bspec.crs_status,
            crs_code=bspec.crs_code,
            pages=bspec.pages,
            actor="pipeline",
        )
        ctx.uids[(spec.key, bspec.label)] = bh.uid
        for path, value in bspec.edits:
            await apply_patch(
                session, bh.uid, ValuePatch(path=path, action="edit", value=value), actor=REVIEWER
            )
            await apply_patch(session, bh.uid, ValuePatch(path=path, action="approve"), actor=REVIEWER)
        if bspec.approve_all:
            await _approve_all(session, bh)
    if spec.expected_ids is not None:
        found = [b.label for b in spec.boreholes]
        doc.completeness = {
            "expected_ids": spec.expected_ids,
            "found_ids": found,
            "missing": [i for i in spec.expected_ids if i not in found],
            "unexpected": [i for i in found if i not in spec.expected_ids],
        }
    if spec.status in ("needs_review", "done"):
        pages_ocr = [p for p in spec.pages if p.ocr in ("done", "failed")]
        doc.progress = {
            "pages_total": len(spec.pages),
            "pages_classified": sum(1 for p in spec.pages if p.role is not None),
            "pages_ocr_total": len(pages_ocr),
            "pages_ocr_done": sum(1 for p in pages_ocr if p.ocr == "done"),
            "boreholes_extracted": len(spec.boreholes),
        }
    await session.flush()


def _crs_option(ctx: _Ctx, code: str, label: str) -> dict[str, Any]:
    return {"value": code, "label": label, "evidence": ctx.ev("nz1", 2, "c1", "c2")}


async def _add_clarifications(session: AsyncSession, ctx: _Ctx) -> None:
    u = ctx.uids
    nz_uids = [u[("nz1", "WH-1")], u[("nz1", "WH-2")], u[("nz2", "WH-3")]]
    swap_field = {
        "name": "swap_axes",
        "widget": "boolean",
        "label": "The first printed value is the northing",
        "required": False,
        "default": False,
    }
    specs: list[dict[str, Any]] = [
        {
            "kind": "crs_confirm",
            "doc": "nz1",
            "project": NZ_PROJECT,
            "borehole_uids": nz_uids,
            "question": f"Which coordinate system do the coordinates of the {NZ_PROJECT} boreholes use? "
            "No system is printed on the logs.",
            "fields": [
                {
                    "name": "crs",
                    "widget": "crs_picker",
                    "label": "Coordinate system",
                    "help": "Ranked by how compactly the points fall near the wharf named on the logs.",
                    "required": True,
                    "options": [
                        _crs_option(ctx, "EPSG:2193", "NZGD2000 / New Zealand Transverse Mercator 2000"),
                        _crs_option(ctx, "EPSG:27200", "NZGD49 / New Zealand Map Grid"),
                        _crs_option(ctx, "EPSG:32760", "WGS 84 / UTM zone 60S"),
                    ],
                },
                swap_field,
            ],
            "evidence": [
                ctx.ev("nz1", 2, "c1", "c2"),
                ctx.ev("nz1", 3, "c1", "c2"),
                ctx.ev("nz2", 1, "c1", "c2"),
            ],
        },
        {
            "kind": "choose_reading",
            "doc": "de",
            "borehole_uids": [u[("de", "KB-2")]],
            "path": "stratigraphy[2].spt_n_value",
            "question": "Two readings of the handwritten SPT correction for layer 3 of KB-2 disagree. "
            "Which one is on the page?",
            "fields": [
                {
                    "name": "reading",
                    "widget": "choose_reading",
                    "label": "SPT N (layer 3)",
                    "required": True,
                    "options": [
                        {
                            "value": 27,
                            "label": "27 (OCR, confidence 0.58)",
                            "evidence": ctx.ev("de", 5, "L2.spt"),
                        },
                        {
                            "value": 22,
                            "label": "22 (second read, confidence 0.71)",
                            "evidence": ctx.ev("de", 5, "L2.spt", snippet="22"),
                        },
                    ],
                }
            ],
            "evidence": [ctx.ev("de", 5, "L2.spt")],
        },
        {
            "kind": "conflicting_sources",
            "doc": "de",
            "borehole_uids": [u[("de", "KB-3")]],
            "path": "metadata.surface_elevation_mASL",
            "question": "The log header and the summary table give different ground levels for KB-3. "
            "Which one is right?",
            "fields": [
                {
                    "name": "value",
                    "widget": "select",
                    "label": "Ground level (m NHN)",
                    "required": True,
                    "options": [
                        {
                            "value": 287.59,
                            "label": "287,59 m NHN (log header, page 6)",
                            "evidence": ctx.ev("de", 6, "z"),
                        },
                        {
                            "value": 287.95,
                            "label": "287,95 m NHN (summary table, page 2)",
                            "evidence": ctx.ev("de", 2, "KB-3.z"),
                        },
                    ],
                }
            ],
            "evidence": [ctx.ev("de", 6, "z"), ctx.ev("de", 2, "KB-3.z")],
        },
        {
            "kind": "borehole_boundary",
            "doc": "de",
            "borehole_uids": [u[("de", "KB-1")]],
            "question": "Page 4 continues a log sheet but prints no borehole label. Does it belong to KB-1?",
            "fields": [
                {
                    "name": "pages",
                    "widget": "page_range",
                    "label": "Pages of KB-1",
                    "required": True,
                    "default": [3, 4],
                }
            ],
            "evidence": [ctx.ev("de", 4, "sheet"), ctx.ev("de", 3, "bh", "sheet")],
            "resolve": ("skipped", None),
        },
        {
            "kind": "locate_borehole",
            "doc": "au",
            "borehole_uids": [u[("au", "BH03")]],
            "question": "BH03 has no coordinates in the report. Where was it drilled?",
            "fields": [
                {
                    "name": "location",
                    "widget": "map_point",
                    "label": "Click the borehole position on the map",
                    "help": "The log places BH03 next to the pump station.",
                    "required": True,
                },
                {
                    "name": "source_note",
                    "widget": "text",
                    "label": "Where does this position come from?",
                    "required": False,
                },
            ],
            "evidence": [ctx.ev("au", 4, "c1", "c2"), ctx.ev("au", 4, "loc"), ctx.ev("au", 1, "BH03.e")],
        },
        {
            "kind": "unit_ambiguous",
            "doc": "au",
            "borehole_uids": [u[("au", "BH03")]],
            "path": "test_results[0].value",
            "question": "The bulk unit weight of BH03 at 2.0 m is printed as '19.6' without a unit. "
            "Which unit is it?",
            "fields": [
                {
                    "name": "value",
                    "widget": "number_unit",
                    "label": "Bulk unit weight",
                    "required": True,
                    "unit_options": ["kN/m3", "t/m3", "g/cm3"],
                    "default": 19.6,
                },
            ],
            "evidence": [ctx.ev("au", 4, "uw")],
        },
        {
            "kind": "duplicate",
            "doc": "nz2",
            "project": NZ_PROJECT,
            "borehole_uids": [u[("nz1", "WH-2")]],
            "question": f"Page 2 looks like a copy of page 3 of {NZ1_FILE} (WH-2). Is it the same log?",
            "fields": [
                {
                    "name": "same_log",
                    "widget": "boolean",
                    "label": "Both pages show the same log",
                    "required": True,
                    "default": True,
                },
                {
                    "name": "keep_page",
                    "widget": "select",
                    "label": "Which page should be used?",
                    "required": False,
                    "options": [
                        {"value": "original", "label": f"Page 3 of {NZ1_FILE}"},
                        {"value": "copy", "label": f"Page 2 of {NZ2_FILE}"},
                    ],
                },
            ],
            "evidence": [ctx.ev("nz2", 2, "bh", "sheet"), ctx.ev("nz1", 3, "bh", "sheet")],
        },
        {
            "kind": "datum_convention",
            "doc": "nz2",
            "project": NZ_PROJECT,
            "borehole_uids": [u[("nz2", "WH-3")]],
            "path": "metadata.depth_origin",
            "question": "The field sheet of WH-3 notes depths 'below wharf deck'. Are its depths measured "
            "below ground or below the wharf deck?",
            "fields": [
                {
                    "name": "depth_origin",
                    "widget": "select",
                    "label": "Depths are measured from",
                    "required": True,
                    "options": [
                        {"value": "ground", "label": "Ground level"},
                        {"value": "relative", "label": "The wharf deck (a relative origin)"},
                    ],
                },
            ],
            "evidence": [ctx.ev("nz2", 1, "origin")],
        },
        {
            "kind": "datum_convention",
            "doc": "us",
            "borehole_uids": [u[("us", "HR-101")]],
            "path": "metadata.depth_origin",
            "question": "HR-101 gives depths in feet and elevations in NAVD 88. Are the depths measured "
            "below the ground surface?",
            "fields": [
                {
                    "name": "depth_origin",
                    "widget": "select",
                    "label": "Depths are measured from",
                    "required": True,
                    "options": [
                        {"value": "ground", "label": "Ground surface"},
                        {"value": "relative", "label": "Another reference point"},
                    ],
                },
            ],
            "evidence": [ctx.ev("us", 1, "origin"), ctx.ev("us", 1, "z")],
            "resolve": ("answered", {"depth_origin": "ground"}),
        },
    ]
    for i, item in enumerate(specs):
        doc = ctx.docs[item["doc"]]
        row = await create_clarification(
            session,
            kind=item["kind"],
            document_id=doc.id,
            question=item["question"],
            fields=item["fields"],
            evidence=item["evidence"],
            borehole_uids=item["borehole_uids"],
            path=item.get("path"),
            project=item.get("project"),
            dedupe_key=f"seed:{item['doc']}:{item['kind']}:{i}",
        )
        if "resolve" in item:
            status, answer = item["resolve"]
            await resolve_clarification(
                session,
                row,
                status=status,
                answer=answer,
                answered_by=REVIEWER if answer is not None else None,
            )


async def seed_present(session: AsyncSession, shas: Sequence[str] = ()) -> int:
    condition = or_(Document.is_seed.is_(True), Document.sha256.in_(list(shas)))
    return int(await session.scalar(select(func.count()).select_from(Document).where(condition)) or 0)


async def load_seed(session: AsyncSession, storage: FileStorage | None = None) -> SeedSummary | None:
    """Load the fictional demo data and commit. Returns None when it is already loaded."""
    storage = storage or get_storage()
    rendered = render_documents()
    if await seed_present(session, [r.sha256 for r in rendered]):
        return None
    ctx = _Ctx()
    written: list[str] = []
    base = datetime.now(UTC) - timedelta(hours=3)
    try:
        for i, item in enumerate(rendered):
            await _add_document(session, storage, item, ctx, base + timedelta(minutes=17 * i), written)
            await _add_boreholes(session, item, ctx)
        await _add_clarifications(session, ctx)
        for item in rendered:
            doc = ctx.docs[item.spec.key]
            if doc.status == "failed":
                await emit(
                    session,
                    "job.failed",
                    {"document_id": doc.id, "stage": "ocr", "detail": doc.error, "retryable": True},
                    document_id=doc.id,
                )
            await emit_document_updated(session, doc)
        await session.commit()
    except BaseException:
        await session.rollback()
        for key in written:
            storage.delete(key)
        raise
    boreholes = list(ctx.uids.values())
    plotted = int(
        await session.scalar(
            select(func.count())
            .select_from(Borehole)
            .where(Borehole.uid.in_(boreholes), Borehole.plotted.is_(True))
        )
        or 0
    )
    doc_ids = [d.id for d in ctx.docs.values()]
    clar = (
        await session.execute(select(Clarification.status).where(Clarification.document_id.in_(doc_ids)))
    ).all()
    return SeedSummary(
        documents=len(ctx.docs),
        boreholes=len(boreholes),
        plotted=plotted,
        clarifications=len(clar),
        open_clarifications=sum(1 for (s,) in clar if s == "open"),
    )


async def remove_seed(session: AsyncSession, storage: FileStorage | None = None) -> int:
    """Delete every is_seed document (rows cascade), emit document.deleted, then delete their files."""
    storage = storage or get_storage()
    docs = (await session.scalars(select(Document).where(Document.is_seed.is_(True)))).all()
    files = [(d.id, d.storage_key) for d in docs]
    for doc in docs:
        await session.delete(doc)
        await emit(session, "document.deleted", {"document_id": doc.id}, document_id=doc.id)
    await session.commit()
    for doc_id, key in files:
        storage.delete_prefix(document_prefix(doc_id))
        storage.delete(key)
    return len(files)


async def _run(remove: bool) -> int:
    try:
        async with get_sessionmaker()() as session:
            if remove:
                count = await remove_seed(session)
                print(f"Removed {count} fictional demo documents and their files.")
                return 0
            summary = await load_seed(session)
            if summary is None:
                print("Fictional demo data is already loaded; nothing to do (use --remove first to reload).")
                return 0
            print("Loaded fictional demo data:")
            print(f"  documents:      {summary.documents}")
            print(f"  boreholes:      {summary.boreholes} ({summary.plotted} plotted)")
            print(f"  clarifications: {summary.clarifications} ({summary.open_clarifications} open)")
            return 0
    finally:
        await dispose_engine()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.seed", description="Load or remove the fictional demo data."
    )
    parser.add_argument("--remove", action="store_true", help="delete the seeded documents and their files")
    args = parser.parse_args(argv)
    return asyncio.run(_run(args.remove))


if __name__ == "__main__":
    raise SystemExit(main())
