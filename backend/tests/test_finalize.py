"""FICTIONAL extraction results -> boreholes, questions and a closed document (no provider is called).

Every label, place, number and OCR block below is invented for these tests. The extraction results are
built by hand as the extractor model would return them (raw text plus cited block ids); the block maps
stand in for Mistral OCR output. Four document families are covered: a German metric log with a printed
ETRS89 / UTM system, an Australian-style scanned log with an MGA zone and AHD levels, a US-style log in
feet without a printed system, and a log with degrees and decimal minutes whose depths carry no unit.
A fifth, a vector PDF generated at test time, has a text layer while the OCR returns one coarse block per
page: its evidence boxes shrink to the printed words. A sixth, a Danish-style log in System 34 Sjælland,
prints a westward-growing easting; the German log is also printed with its northing first.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select

from app.clarify.answers import answer_clarification
from app.db.models import Borehole, Clarification, Document, Page
from app.db.session import get_sessionmaker
from app.geo.crs_candidates import rank_candidates
from app.geo.plotting import to_wgs84
from app.pipeline import textlayer
from app.pipeline.finalize import (
    RecordDraft,
    build_record,
    finalize_document,
    finalize_group,
    length_unit_in,
    load_text_layers,
)
from app.pipeline.provenance import Citations, method_of, union_box
from app.pipeline.schemas import (
    ExtractedCoreRun,
    ExtractedGroundwater,
    ExtractedHeader,
    ExtractedLayer,
    ExtractedSample,
    ExtractedSpt,
    ExtractedTest,
    ExtractionResult,
    RawCoordinates,
    RawValue,
)
from app.pipeline.textlayer import PageText
from app.pipeline.triage import triage_pdf
from app.pipeline.types import BlockRef, ExtractionOutcome, PageGroup
from app.review.service import to_record
from app.schemas.boreholes import BoreholeRecord
from app.storage import get_storage, original_key
from tests.contract_utils import validate_schema
from tests.pdf_factory import TextItem, make_pdf

# ----------------------------------------------------------------------------------------------
# Builders
# ----------------------------------------------------------------------------------------------


def rv(raw: str | None, *ids: str, state: str = "ok") -> RawValue:
    return RawValue(raw=raw, block_ids=list(ids), state=state)  # type: ignore[arg-type]


def absent() -> RawValue:
    return RawValue(raw=None, block_ids=[], state="not_in_source")


def blk(
    block_id: str,
    text: str,
    box: tuple[float, float, float, float],
    *,
    conf: float = 0.97,
    quality: float | None,
) -> BlockRef:
    page = int(block_id[1:].split(".")[0])
    return BlockRef(
        id=block_id,
        page=page,
        text=text,
        box=box,
        confidence=conf,
        page_text_quality=quality,
        page_handwriting="none",
    )


def block_map(items: Iterable[BlockRef]) -> dict[str, BlockRef]:
    return {b.id: b for b in items}


def header(**values: RawValue) -> ExtractedHeader:
    coords = {k: values.pop(k, absent()) for k in ("x_raw", "y_raw", "labels_raw", "system_raw")}
    fields = {
        name: values.pop(name, absent()) for name in ExtractedHeader.model_fields if name != "coordinates"
    }
    assert not values, f"unknown header fields {sorted(values)}"
    return ExtractedHeader(coordinates=RawCoordinates(**coords), **fields)


def layer(
    top: RawValue,
    bottom: RawValue,
    description: RawValue,
    *,
    din: str | None = None,
    english: str | None = None,
    language: str | None = None,
    **extra: RawValue,
) -> ExtractedLayer:
    texts = {
        name: extra.pop(name, absent())
        for name in (
            "uscs_raw",
            "colour_raw",
            "consistency_raw",
            "moisture_raw",
            "weathering_raw",
            "stratigraphic_name_raw",
        )
    }
    assert not extra
    return ExtractedLayer(
        from_raw=top,
        to_raw=bottom,
        description_raw=description,
        description_language=language,
        english_lithology=english,
        din4023_code=din,
        din4023_notation=None,
        **texts,
    )


def spt(depth: RawValue, blows: RawValue, n: RawValue | None = None) -> ExtractedSpt:
    return ExtractedSpt(depth_raw=depth, blows_raw=blows, n_raw=n or absent(), increment_note_raw=absent())


def result(head: ExtractedHeader, layers: list[ExtractedLayer], **arrays: Any) -> ExtractionResult:
    return ExtractionResult(
        header=head,
        layers=layers,
        spt=arrays.get("spt", []),
        core_runs=arrays.get("core_runs", []),
        groundwater=arrays.get("groundwater", []),
        samples=arrays.get("samples", []),
        tests=arrays.get("tests", []),
    )


def outcome(res: ExtractionResult, blocks: dict[str, BlockRef]) -> ExtractionOutcome:
    return ExtractionOutcome(result=res, blocks=blocks, run_id=None, model="fake-extractor")


# ----------------------------------------------------------------------------------------------
# Family 1: German metric log, printed ETRS89 / UTM zone 32N, text layer on page 2, scan on page 3
# ----------------------------------------------------------------------------------------------

DE_BLOCKS = block_map(
    [
        blk("p2.b0", "Bohrung KB 3", (0.08, 0.04, 0.2, 0.02), quality=0.95),
        blk("p2.b1", "Projekt: Neubau Lagerhalle Fiktivweiler", (0.08, 0.07, 0.4, 0.02), quality=0.95),
        blk("p2.b2", "Auftraggeber: Beispiel Bau GmbH (fiktiv)", (0.08, 0.09, 0.4, 0.02), quality=0.95),
        blk("p2.b3", "Ort: Fiktivweiler", (0.08, 0.11, 0.3, 0.02), quality=0.95),
        blk("p2.b4", "Datum: 12.03.2024", (0.6, 0.04, 0.2, 0.02), quality=0.95),
        blk("p2.b5", "Endtiefe 6,00 m", (0.6, 0.07, 0.2, 0.02), quality=0.95),
        blk("p2.b6", "Tiefe [m] unter GOK", (0.08, 0.2, 0.1, 0.02), quality=0.95),
        blk("p2.b7", "Ansatzpunkt +312,45 m NN", (0.6, 0.09, 0.25, 0.02), quality=0.95),
        blk("p2.b8", "Rechtswert 413 210,5", (0.6, 0.12, 0.2, 0.02), quality=0.95),
        blk("p2.b9", "Hochwert 5 316 044,2", (0.6, 0.14, 0.2, 0.02), quality=0.95),
        blk("p2.b10", "ETRS89 / UTM Zone 32N", (0.6, 0.16, 0.2, 0.02), quality=0.95),
        blk("p2.b11", "0,00", (0.08, 0.25, 0.05, 0.02), quality=0.95),
        blk("p2.b12", "1,20", (0.08, 0.3, 0.05, 0.02), quality=0.95, conf=0.91),
        blk("p2.b13", "Mutterboden, Sand, schluffig, braun", (0.2, 0.25, 0.4, 0.02), quality=0.95),
        blk("p2.b14", "Kies, sandig,", (0.2, 0.32, 0.3, 0.02), quality=0.95, conf=0.88),
        blk("p2.b15", "schwach schluffig", (0.2, 0.34, 0.25, 0.02), quality=0.95, conf=0.93),
        blk("p2.b16", "3,40", (0.08, 0.6, 0.05, 0.02), quality=0.95),
        blk("p2.b17", "GW 2,80 (12.03.2024)", (0.7, 0.5, 0.15, 0.02), quality=0.95),
        blk("p3.b0", "(Fortsetzung) grau", (0.2, 0.05, 0.2, 0.02), quality=0.4, conf=0.8),
        blk("p3.b1", "6,00", (0.08, 0.4, 0.05, 0.02), quality=0.4, conf=0.85),
        blk("p3.b2", "Ton, steif", (0.2, 0.3, 0.2, 0.02), quality=0.4, conf=0.82),
    ]
)


def de_result() -> ExtractionResult:
    head = header(
        borehole_label=rv("KB 3", "p2.b0"),
        project=rv("Neubau Lagerhalle Fiktivweiler", "p2.b1"),
        client=rv("Beispiel Bau GmbH (fiktiv)", "p2.b2"),
        location=rv("Fiktivweiler", "p2.b3"),
        start_date=rv("12.03.2024", "p2.b4"),
        end_date=rv("12.03.2024", "p2.b4"),
        total_depth=rv("6,00 m", "p2.b5"),
        depth_unit=rv("Tiefe [m]", "p2.b6"),
        depth_origin_note=rv("unter GOK", "p2.b6"),
        ground_level=rv("+312,45", "p2.b7"),
        elevation_datum=rv("m NN", "p2.b7"),
        x_raw=rv("413 210,5", "p2.b8"),
        y_raw=rv("5 316 044,2", "p2.b9"),
        labels_raw=rv("Rechtswert, Hochwert", "p2.b8", "p2.b9"),
        system_raw=rv("ETRS89 / UTM Zone 32N", "p2.b10"),
    )
    layers = [
        # Printed out of order on purpose: finalisation stores layers in depth order.
        layer(
            rv("1,20", "p2.b12"),
            rv("3,40", "p2.b16"),
            rv("Kies, sandig, schwach schluffig, grau", "p2.b14", "p2.b15", "p3.b0"),
            din="G",
            english="Sandy gravel, slightly silty, grey",
            language="de",
        ),
        layer(
            rv("0,00", "p2.b11"),
            rv("1,20", "p2.b12"),
            rv("Mutterboden, Sand, schluffig, braun", "p2.b13"),
            english="Topsoil, silty sand, brown",
            language="de",
        ),
        layer(rv("3,40", "p2.b16"), rv("6,00", "p3.b1"), rv("Ton, steif", "p3.b2"), din="T", language="de"),
        # The model could not read this interval: the layer is skipped, never invented.
        layer(rv("??", "p3.b1", state="illegible"), rv("6,50"), rv("Ton"), language="de"),
    ]
    groundwater = [
        ExtractedGroundwater(
            type="strike", depth_raw=rv("2,80", "p2.b17"), date_raw=rv("12.03.2024", "p2.b17")
        )
    ]
    return result(head, layers, groundwater=groundwater)


DE_GROUP = PageGroup(
    key="g-kb3", label_raw="KB 3", label_canonical="KB3", pages=(2, 3), context_pages=(1,), uncertain=()
)


# ----------------------------------------------------------------------------------------------
# Family 2: Australian-style scanned log, MGA94 zone 55, AHD levels, SPT refusal, core runs, lab tests
# ----------------------------------------------------------------------------------------------

AU_BLOCKS = block_map(
    [
        blk("p1.b0", "BOREHOLE No. BH-07", (0.05, 0.03, 0.25, 0.02), quality=None),
        blk("p1.b1", "Easting 320512.0", (0.55, 0.05, 0.18, 0.02), quality=None, conf=0.9),
        blk("p1.b2", "Northing 5812334.0", (0.55, 0.07, 0.18, 0.02), quality=None, conf=0.92),
        blk("p1.b3", "MGA94 Zone 55", (0.75, 0.05, 0.15, 0.02), quality=None),
        blk("p1.b4", "Surface RL 45.20 m AHD", (0.55, 0.09, 0.25, 0.02), quality=None),
        blk("p1.b5", "Depth (m)", (0.05, 0.15, 0.08, 0.02), quality=None),
        blk("p1.b6", "0.00 0.40 FILL: Silty CLAY, brown", (0.05, 0.2, 0.5, 0.02), quality=None),
        blk("p1.b7", "0.40 3.00 CLAY, stiff, grey", (0.05, 0.3, 0.5, 0.02), quality=None),
        blk("p1.b8", "3.00 8.50 SANDSTONE, grey, slightly weathered", (0.05, 0.5, 0.5, 0.02), quality=None),
        blk("p1.b9", "1.50 SPT 4, 6, 8 N=14", (0.6, 0.35, 0.2, 0.02), quality=None, conf=0.86),
        blk("p1.b10", "4.50 SPT 12, 25/100mm", (0.6, 0.55, 0.2, 0.02), quality=None, conf=0.84),
        blk("p1.b11", "Core 3.00-6.00 TCR 95 RQD 60", (0.8, 0.5, 0.15, 0.02), quality=None, conf=0.8),
        blk("p1.b12", "Core 6.00-8.50 TCR 100 RQD 85", (0.8, 0.6, 0.15, 0.02), quality=None, conf=0.8),
        blk("p1.b13", "Standing water 2.10", (0.6, 0.32, 0.2, 0.02), quality=None),
        blk("p1.b14", "U50 1.00-1.45", (0.6, 0.27, 0.15, 0.02), quality=None),
        blk("p2.b0", "UCS 32.5 MPa at 5.20 m", (0.1, 0.2, 0.3, 0.02), quality=None),
        blk("p2.b1", "Moisture content 18.5 %", (0.1, 0.25, 0.3, 0.02), quality=None),
        blk("p2.b2", "Shear vane 45 kPa", (0.1, 0.3, 0.3, 0.02), quality=None),
    ]
)


def au_result() -> ExtractionResult:
    head = header(
        borehole_label=rv("BH-07", "p1.b0"),
        x_raw=rv("320512.0", "p1.b1"),
        y_raw=rv("5812334.0", "p1.b2"),
        labels_raw=rv("Easting / Northing", "p1.b1", "p1.b2"),
        system_raw=rv("MGA94 Zone 55", "p1.b3"),
        ground_level=rv("45.20", "p1.b4"),
        elevation_datum=rv("AHD", "p1.b4"),
        depth_unit=rv("Depth (m)", "p1.b5"),
        depth_origin_note=rv("Depths in m below ground level", "p1.b5"),
    )
    layers = [
        layer(
            rv("0.00", "p1.b6"), rv("0.40", "p1.b6"), rv("FILL: Silty CLAY, brown", "p1.b6"), language="en"
        ),
        layer(rv("0.40", "p1.b7"), rv("3.00", "p1.b7"), rv("CLAY, stiff, grey", "p1.b7"), language="en"),
        layer(
            rv("3.00", "p1.b8"),
            rv("8.50", "p1.b8"),
            rv("SANDSTONE, grey, slightly weathered", "p1.b8"),
            din="Sst",
            language="en",
            weathering_raw=rv("slightly weathered", "p1.b8"),
        ),
    ]
    return result(
        head,
        layers,
        spt=[
            spt(rv("1.50", "p1.b9"), rv("4, 6, 8", "p1.b9"), rv("N=14", "p1.b9")),
            spt(rv("4.50", "p1.b10"), rv("12, 25/100mm", "p1.b10")),
        ],
        core_runs=[
            ExtractedCoreRun(
                from_raw=rv("3.00", "p1.b11"),
                to_raw=rv("6.00", "p1.b11"),
                tcr_raw=rv("95", "p1.b11"),
                scr_raw=absent(),
                rqd_raw=rv("60", "p1.b11"),
                ff_raw=absent(),
            ),
            ExtractedCoreRun(
                from_raw=rv("6.00", "p1.b12"),
                to_raw=rv("8.50", "p1.b12"),
                tcr_raw=rv("100", "p1.b12"),
                scr_raw=absent(),
                rqd_raw=rv("85", "p1.b12"),
                ff_raw=absent(),
            ),
        ],
        groundwater=[ExtractedGroundwater(type="rest", depth_raw=rv("2.10", "p1.b13"), date_raw=absent())],
        samples=[
            ExtractedSample(
                name_raw=rv("U50", "p1.b14"),
                type_raw=rv("U", "p1.b14"),
                from_raw=rv("1.00", "p1.b14"),
                to_raw=rv("1.45", "p1.b14"),
            )
        ],
        tests=[
            ExtractedTest(
                name="UCS",
                value_raw=rv("32.5", "p2.b0"),
                unit_raw=rv("MPa", "p2.b0"),
                depth_raw=rv("5.20", "p2.b0"),
                sample_raw=absent(),
            ),
            ExtractedTest(
                name="Moisture content",
                value_raw=rv("18.5", "p2.b1"),
                unit_raw=rv("%", "p2.b1"),
                depth_raw=absent(),
                sample_raw=absent(),
            ),
            ExtractedTest(
                name="Shear vane",  # not a Test Results field: not stored
                value_raw=rv("45", "p2.b2"),
                unit_raw=rv("kPa", "p2.b2"),
                depth_raw=absent(),
                sample_raw=absent(),
            ),
        ],
    )


AU_GROUP = PageGroup(key="g-bh07", label_raw="BH-07", label_canonical="BH7", pages=(1, 2))


# ----------------------------------------------------------------------------------------------
# Family 3: US-style log in feet, northing printed first, no printed coordinate system
# ----------------------------------------------------------------------------------------------


def us_blocks(page: int, label: str, northing: str, easting: str) -> dict[str, BlockRef]:
    q = 0.97
    return block_map(
        [
            blk(f"p{page}.b0", f"LOG OF BORING {label}", (0.05, 0.03, 0.3, 0.02), quality=q),
            blk(f"p{page}.b1", f"Northing {northing}", (0.55, 0.05, 0.2, 0.02), quality=q),
            blk(f"p{page}.b2", f"Easting {easting}", (0.55, 0.07, 0.2, 0.02), quality=q),
            blk(f"p{page}.b3", "Depth (ft)", (0.05, 0.15, 0.08, 0.02), quality=q),
            blk(f"p{page}.b4", "0.0", (0.05, 0.2, 0.04, 0.02), quality=q),
            blk(f"p{page}.b5", "5.5", (0.05, 0.3, 0.04, 0.02), quality=q),
            blk(f"p{page}.b6", "20.0", (0.05, 0.7, 0.04, 0.02), quality=q),
            blk(f"p{page}.b7", "Lean CLAY (CL), brown, stiff", (0.15, 0.22, 0.4, 0.02), quality=q),
            blk(f"p{page}.b8", "Poorly graded SAND (SP), medium dense", (0.15, 0.4, 0.4, 0.02), quality=q),
            blk(f"p{page}.b9", "5-7-9", (0.7, 0.32, 0.08, 0.02), quality=q),
            blk(f"p{page}.b10", "16", (0.8, 0.32, 0.04, 0.02), quality=q),
            blk(f"p{page}.b11", "Total depth 20.0 ft", (0.05, 0.8, 0.2, 0.02), quality=q),
            blk(f"p{page}.b12", "Elev. 512.3 ft NAVD88", (0.55, 0.09, 0.2, 0.02), quality=q),
        ]
    )


def us_result(page: int, label: str, northing: str, easting: str) -> ExtractionResult:
    p = f"p{page}"
    head = header(
        borehole_label=rv(label, f"{p}.b0"),
        project=rv("Fictional Harbor Yard", f"{p}.b0"),
        x_raw=rv(northing, f"{p}.b1"),
        y_raw=rv(easting, f"{p}.b2"),
        labels_raw=rv("Northing, Easting", f"{p}.b1", f"{p}.b2"),
        depth_unit=rv("Depth (ft)", f"{p}.b3"),
        total_depth=rv("20.0 ft", f"{p}.b11"),
        ground_level=rv("512.3 ft", f"{p}.b12"),
        elevation_datum=rv("NAVD88", f"{p}.b12"),
    )
    layers = [
        layer(
            rv("0.0", f"{p}.b4"),
            rv("5.5", f"{p}.b5"),
            rv("Lean CLAY (CL), brown, stiff", f"{p}.b7"),
            language="en",
            uscs_raw=rv("CL", f"{p}.b7"),
        ),
        layer(
            rv("5.5", f"{p}.b5"),
            rv("20.0", f"{p}.b6"),
            rv("Poorly graded SAND (SP), medium dense", f"{p}.b8"),
            language="en",
            uscs_raw=rv("SP", f"{p}.b8"),
        ),
    ]
    return result(head, layers, spt=[spt(rv("5.5", f"{p}.b5"), rv("5-7-9", f"{p}.b9"), rv("16", f"{p}.b10"))])


# ----------------------------------------------------------------------------------------------
# Family 4: degrees and decimal minutes with a printed datum; depths printed without any unit
# ----------------------------------------------------------------------------------------------


def dm_blocks(page: int, label: str, lat: str, lon: str) -> dict[str, BlockRef]:
    return block_map(
        [
            blk(f"p{page}.b0", f"Sondage {label}", (0.05, 0.03, 0.2, 0.02), quality=None),
            blk(f"p{page}.b1", lat, (0.5, 0.05, 0.15, 0.02), quality=None, conf=0.94),
            blk(f"p{page}.b2", lon, (0.66, 0.05, 0.15, 0.02), quality=None, conf=0.95),
            blk(f"p{page}.b3", "WGS 84", (0.82, 0.05, 0.1, 0.02), quality=None),
            blk(f"p{page}.b4", "0.50", (0.05, 0.25, 0.05, 0.02), quality=None),
            blk(f"p{page}.b5", "2.00", (0.05, 0.4, 0.05, 0.02), quality=None),
            blk(f"p{page}.b6", "Limon argileux, brun", (0.15, 0.25, 0.3, 0.02), quality=None),
            blk(f"p{page}.b7", "Graves sableuses", (0.15, 0.35, 0.3, 0.02), quality=None),
        ]
    )


def dm_result(page: int, label: str, lat: str, lon: str) -> ExtractionResult:
    p = f"p{page}"
    head = header(
        borehole_label=rv(label, f"{p}.b0"),
        x_raw=rv(lat, f"{p}.b1"),
        y_raw=rv(lon, f"{p}.b2"),
        system_raw=rv("WGS 84", f"{p}.b3"),
        client=rv(None, state="not_in_source"),
    )
    layers = [
        layer(
            rv("0", f"{p}.b4"), rv("0.50", f"{p}.b4"), rv("Limon argileux, brun", f"{p}.b6"), language="fr"
        ),
        layer(rv("0.50", f"{p}.b4"), rv("2.00", f"{p}.b5"), rv("Graves sableuses", f"{p}.b7"), language="fr"),
    ]
    return result(head, layers)


# ----------------------------------------------------------------------------------------------
# Database helpers
# ----------------------------------------------------------------------------------------------


async def make_document(
    doc_id: str,
    *,
    pages: dict[int, tuple[str, list[str], float | None]],
    project: str | None = None,
    file_name: str = "fictional-report.pdf",
) -> None:
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=doc_id,
                file_name=file_name,
                project=project,
                sha256=hashlib.sha256(doc_id.encode()).hexdigest(),
                mime_type="application/pdf",
                size_bytes=1000,
                storage_key=f"originals/{doc_id}.pdf",
                status="extracting",
                stage="ocr",
                page_count=len(pages),
                progress={
                    "pages_total": len(pages),
                    "pages_classified": len(pages),
                    "pages_ocr_total": len(pages),
                    "pages_ocr_done": len(pages),
                    "boreholes_extracted": 0,
                },
            )
        )
        await session.flush()
        for n, (role, labels, quality) in pages.items():
            session.add(
                Page(
                    document_id=doc_id,
                    n=n,
                    role=role,
                    borehole_labels=labels,
                    text_layer_quality=quality,
                    used=True,
                    ocr_status="done",
                )
            )
        await session.commit()


async def record_of(uid: str) -> BoreholeRecord:
    async with get_sessionmaker()() as session:
        bh = await session.get(Borehole, uid)
        assert bh is not None
        record = await to_record(session, bh)
    validate_schema(record.model_dump(mode="json"), "BoreholeRecord")
    return record


async def clarifications(kind: str | None = None) -> list[Clarification]:
    async with get_sessionmaker()() as session:
        query = select(Clarification).order_by(Clarification.created_at, Clarification.id)
        if kind is not None:
            query = query.where(Clarification.kind == kind)
        return list((await session.scalars(query)).all())


async def document(doc_id: str) -> Document:
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        assert doc is not None
        return doc


def assert_nothing_invented(record: BoreholeRecord, paths: Iterable[str]) -> None:
    """Values that were not printed are null and have no provenance entry (never 0 or a default)."""
    data = record.model_dump(mode="json")
    for path in paths:
        container: Any = data
        for part in path.split("."):
            container = container[part]
        assert container is None, path
        assert path not in record.provenance, path


# ----------------------------------------------------------------------------------------------
# Pure helpers (no database)
# ----------------------------------------------------------------------------------------------


def test_union_box_and_method_rules() -> None:
    assert union_box([(0.1, 0.2, 0.1, 0.02), (0.25, 0.21, 0.05, 0.02), None]) == [0.1, 0.2, 0.2, 0.03]
    assert union_box([(0.9, 0.95, 0.2, 0.1)]) == [0.9, 0.95, 0.1, 0.05]  # clamped to the page
    assert union_box([None]) is None
    text_page = blk("p1.b0", "1,20", (0.1, 0.1, 0.1, 0.1), quality=0.95)
    scan_page = blk("p2.b0", "1,20", (0.1, 0.1, 0.1, 0.1), quality=0.5)
    unknown_page = blk("p3.b0", "1,20", (0.1, 0.1, 0.1, 0.1), quality=None)
    # "read" needs a trustworthy text layer on every cited page and the printed text found in it.
    assert method_of([text_page], found_in_text_layer=True) == "read"
    assert method_of([text_page]) == "ocr"  # not checked against the text layer
    assert method_of([text_page, scan_page], found_in_text_layer=True) == "ocr"
    assert method_of([unknown_page], found_in_text_layer=True) == "ocr"
    assert method_of([], found_in_text_layer=True) == "ocr"


def test_provenance_uses_the_first_page_in_reading_order_and_ignores_unknown_blocks() -> None:
    blocks = block_map(
        [
            blk("p7.b1", "Kies,", (0.2, 0.8, 0.2, 0.02), quality=0.95, conf=0.9),
            blk("p7.b2", "sandig", (0.45, 0.8, 0.1, 0.02), quality=0.95, conf=0.7),
            blk("p8.b0", "(Forts.)", (0.2, 0.05, 0.2, 0.02), quality=0.95, conf=0.99),
        ]
    )
    cite = Citations(blocks, document_id="doc_X", page_order=(7, 8))
    entry = cite.entry(rv("Kies, sandig", "p8.b0", "p7.b2", "p7.b1", "p99.b0"))
    assert (entry.page, entry.box) == (7, [0.2, 0.8, 0.35, 0.02])
    # No text layer to agree with: an OCR reading.
    assert (entry.method, entry.confidence, entry.raw, entry.state) == ("ocr", 0.7, "Kies, sandig", "ok")
    illegible = cite.entry(rv("1?,5", state="illegible"))
    assert (illegible.page, illegible.box, illegible.state) == (None, None, "illegible")


def test_depth_unit_from_printed_headers() -> None:
    assert length_unit_in("Tiefe [m]") == "m"
    assert length_unit_in("Depth (ft)") == "ft"
    assert length_unit_in("m u. GOK") == "m"
    assert length_unit_in("Depth in metres") == "m"
    assert length_unit_in("Profundidad") is None
    assert length_unit_in(None) is None


def test_draft_skips_unreadable_layers_and_keeps_raw_text() -> None:
    draft = build_record("doc_X", DE_GROUP, outcome(de_result(), DE_BLOCKS))
    assert draft.body is not None
    assert [layer["depth_from_m"] for layer in draft.body["stratigraphy"]] == [0.0, 1.2, 3.4]
    assert any("unreadable layer interval" in w for w in draft.warnings)
    assert draft.guessed_depths == []  # the unit is printed in the header
    assert (draft.crs_status, draft.crs_code) == ("stated", "EPSG:25832")


def test_degrees_without_a_printed_system_are_inferred_not_plotted() -> None:
    res = dm_result(1, "S9", "N 47°25.512'", "E 8°31.204'")
    head = res.header.model_copy(
        update={"coordinates": res.header.coordinates.model_copy(update={"system_raw": absent()})}
    )
    draft = build_record(
        "doc_X",
        PageGroup(key="g", label_raw="S9", label_canonical="S9", pages=(1,)),
        outcome(res.model_copy(update={"header": head}), dm_blocks(1, "S9", "N 47°25.512'", "E 8°31.204'")),
    )
    assert draft.body is not None
    coords = draft.body["metadata"]["coordinates"]
    assert (draft.crs_status, draft.crs_code) == ("inferred", None)
    # Source-system values (longitude is the easting-like axis); WGS84 is never written without a system.
    assert (coords["local_x"], coords["local_y"]) == (
        pytest.approx(8.5200667, abs=1e-6),
        pytest.approx(47.4252),
    )
    assert "latitude" not in coords and "crs_code" not in coords


def _plain_degrees(labels: str | None, system: str | None) -> RecordDraft:
    """Fictional decimal degrees printed as X then Y (a point inland in southern Africa when the first is the
    latitude, open ocean when it is the longitude)."""
    res = dm_result(1, "S9", "-32.929816", "27.437978")
    coordinates = res.header.coordinates.model_copy(
        update={
            "labels_raw": rv(labels, "p1.b1") if labels else absent(),
            "system_raw": rv(system, "p1.b3") if system else absent(),
        }
    )
    head = res.header.model_copy(update={"coordinates": coordinates})
    return build_record(
        "doc_X",
        PageGroup(key="g", label_raw="S9", label_canonical="S9", pages=(1,)),
        outcome(res.model_copy(update={"header": head}), dm_blocks(1, "S9", "-32.929816", "27.437978")),
    )


def test_degrees_without_axis_order_or_system_are_asked_with_the_reading_on_land_first() -> None:
    for labels, swap in ((None, False), ("X Y", True)):
        draft = _plain_degrees(labels, None)
        assert draft.body is not None
        coords = draft.body["metadata"]["coordinates"]
        assert (draft.crs_status, draft.crs_code) == ("inferred", None)
        best = rank_candidates([("bh_fictional", coords["local_x"], coords["local_y"])])[0]
        assert (best.crs, best.swap_axes) == ("EPSG:4326", swap)
        assert (best.points[0].lat, best.points[0].lon) == (-32.929816, 27.437978)


def test_a_printed_geographic_system_with_an_assumed_order_that_lands_at_sea_is_asked() -> None:
    plain = _plain_degrees(None, "WGS 84")  # read latitude first: on land, so the printed system stands
    assert (plain.crs_status, plain.crs_code) == ("stated", "EPSG:4326")
    labelled = _plain_degrees("X Y", "WGS 84")  # X read as the longitude: open ocean, the swap is on land
    assert (labelled.crs_status, labelled.crs_code) == ("inferred", None)
    assert any("far from land" in w for w in labelled.warnings)


def test_a_printed_system_that_does_not_fit_the_values_is_not_trusted() -> None:
    res = de_result()
    coordinates = res.header.coordinates.model_copy(
        update={"system_raw": rv("British National Grid", "p2.b10")}
    )
    head = res.header.model_copy(update={"coordinates": coordinates})
    draft = build_record("doc_X", DE_GROUP, outcome(res.model_copy(update={"header": head}), DE_BLOCKS))
    assert draft.body is not None
    assert (draft.crs_status, draft.crs_code) == ("inferred", None)
    assert (
        draft.body["metadata"]["coordinates"]["coordinate_system"] == "British National Grid"
    )  # kept as printed
    assert any("does not place the point inside its area of use" in w for w in draft.warnings)


def de_swapped_result() -> ExtractionResult:
    """The German log with its northing printed first under X / Y labels."""
    res = de_result()
    coordinates = res.header.coordinates.model_copy(
        update={
            "x_raw": rv("5 316 044,2", "p2.b9"),
            "y_raw": rv("413 210,5", "p2.b8"),
            "labels_raw": rv("X, Y", "p2.b9", "p2.b8"),
        }
    )
    return res.model_copy(update={"header": res.header.model_copy(update={"coordinates": coordinates})})


def test_a_printed_system_that_fits_only_with_swapped_axes_stays_stated_and_reads_them_swapped() -> None:
    plain = build_record("doc_X", DE_GROUP, outcome(de_result(), DE_BLOCKS))
    assert (plain.crs_status, plain.crs_code, plain.swap_axes) == ("stated", "EPSG:25832", False)

    draft = build_record("doc_X", DE_GROUP, outcome(de_swapped_result(), DE_BLOCKS))
    assert draft.body is not None
    assert (draft.crs_status, draft.crs_code, draft.swap_axes) == ("stated", "EPSG:25832", True)
    coords = draft.body["metadata"]["coordinates"]
    assert (coords["local_x"], coords["local_y"]) == (5316044.2, 413210.5)  # kept in the printed order
    assert coords["crs_code"] == "EPSG:25832"
    assert draft.crs_note is not None and "swapped" in draft.crs_note
    assert any("axes swapped" in w for w in draft.warnings)

    # Neither order inside the area of use: asked as before.
    res = de_swapped_result()
    coordinates = res.header.coordinates.model_copy(
        update={"system_raw": rv("British National Grid", "p2.b10")}
    )
    head = res.header.model_copy(update={"coordinates": coordinates})
    neither = build_record("doc_X", DE_GROUP, outcome(res.model_copy(update={"header": head}), DE_BLOCKS))
    assert (neither.crs_status, neither.crs_code, neither.swap_axes) == ("inferred", None, False)


# ----------------------------------------------------------------------------------------------
# Family 5: Danish-style log in System 34 Sjælland (the printed easting grows westward)
# ----------------------------------------------------------------------------------------------


def dk_outcome(page: int, label: str, east: str, north: str, system: str | None) -> ExtractionOutcome:
    p = f"p{page}"
    blocks = block_map(
        [
            blk(f"{p}.b0", f"Boring {label}", (0.05, 0.03, 0.2, 0.02), quality=None),
            blk(f"{p}.b1", f"E {east}", (0.55, 0.05, 0.2, 0.02), quality=None),
            blk(f"{p}.b2", f"N {north}", (0.55, 0.07, 0.2, 0.02), quality=None),
            blk(f"{p}.b3", system or "", (0.78, 0.05, 0.15, 0.02), quality=None),
            blk(f"{p}.b4", "Dybde (m)", (0.05, 0.15, 0.08, 0.02), quality=None),
            blk(f"{p}.b5", "0,0 2,5 Ler, sandet, brunt", (0.05, 0.2, 0.5, 0.02), quality=None),
        ]
    )
    head = header(
        borehole_label=rv(label, f"{p}.b0"),
        x_raw=rv(east, f"{p}.b1"),
        y_raw=rv(north, f"{p}.b2"),
        labels_raw=rv("E, N", f"{p}.b1", f"{p}.b2"),
        system_raw=rv(system, f"{p}.b3") if system else absent(),
        depth_unit=rv("Dybde (m)", f"{p}.b4"),
    )
    layers = [
        layer(rv("0,0", f"{p}.b5"), rv("2,5", f"{p}.b5"), rv("Ler, sandet, brunt", f"{p}.b5"), language="da")
    ]
    return outcome(result(head, layers), blocks)


# ----------------------------------------------------------------------------------------------
# Database tests
# ----------------------------------------------------------------------------------------------

DE_DOC = "doc_01JFINAL000000000000000DE1"
AU_DOC = "doc_01JFINAL000000000000000AU1"
US_DOC_A = "doc_01JFINAL000000000000000USA"
US_DOC_B = "doc_01JFINAL000000000000000USB"
DM_DOC = "doc_01JFINAL000000000000000DM1"


@pytest.mark.db
async def test_german_log_with_printed_utm_system(db: None) -> None:
    await make_document(
        DE_DOC,
        pages={
            1: ("summary_table", ["KB 3", "KB 4"], 0.95),
            2: ("log_sheet", ["KB 3"], 0.95),
            3: ("log_continuation", [], 0.4),
        },
        project="Fiktivweiler",
    )
    uid = await finalize_group(DE_DOC, DE_GROUP, outcome(de_result(), DE_BLOCKS))
    assert uid is not None
    rec = await record_of(uid)
    meta, coords = rec.metadata, rec.metadata.coordinates
    prov = rec.provenance

    # Stated system: plotted from the printed grid values; WGS84 is derived by the review service.
    assert (rec.crs_status, coords.crs_code, rec.plotted, rec.unplotted_reason) == (
        "stated",
        "EPSG:25832",
        True,
        None,
    )
    assert (coords.local_x, coords.local_y) == (413210.5, 5316044.2)
    assert coords.latitude is not None and 47.9 < coords.latitude < 48.1
    assert coords.longitude is not None and 7.7 < coords.longitude < 7.9
    assert prov["metadata.coordinates.latitude"].method == "derived"
    assert (coords.x_raw, coords.y_raw, coords.coordinate_system) == (
        "413 210,5",
        "5 316 044,2",
        "ETRS89 / UTM Zone 32N",
    )
    assert prov["metadata.coordinates.local_x"].raw == "413 210,5"

    # Header values as printed or normalised, each with its source box. The pages' text layers are not
    # stored in this test, so nothing agrees with them: "ocr" (tight boxes are tested further below).
    assert (meta.borehole_id, meta.project_name, meta.location_name) == (
        "KB 3",
        "Neubau Lagerhalle Fiktivweiler",
        "Fiktivweiler",
    )
    assert (meta.start_date, meta.end_date, meta.drilling_date) == ("2024-03-12", "2024-03-12", None)
    assert (meta.surface_elevation_mASL, meta.elevation_datum, meta.depth_origin) == (
        312.45,
        "m NN",
        "ground",
    )
    assert (meta.borehole_depth_m, meta.borehole_depth_source) == (6.0, "printed")
    assert prov["metadata.borehole_depth_m"].model_dump(include={"page", "box", "raw", "method"}) == {
        "page": 2,
        "box": [0.6, 0.07, 0.2, 0.02],
        "raw": "6,00 m",
        "method": "ocr",
    }
    assert prov["metadata.borehole_depth_source"].method == "derived"
    assert prov["metadata.depth_origin"].method == "derived"

    # Layers in depth order; the unreadable fourth interval is not created.
    layers = rec.stratigraphy
    assert [(la.depth_from_m, la.depth_to_m) for la in layers] == [(0.0, 1.2), (1.2, 3.4), (3.4, 6.0)]
    topsoil, gravel, clay = layers
    # Box = union of the cited blocks on the first cited page (the page-3 block is ignored).
    gravel_desc = prov["stratigraphy[1].original_description"]
    assert (gravel_desc.page, gravel_desc.box, gravel_desc.confidence) == (2, [0.2, 0.32, 0.3, 0.04], 0.8)
    assert gravel_desc.method == "ocr"  # one cited block lies on the scanned page
    assert prov["stratigraphy[1].depth_from_m"].method == "ocr"
    assert prov["stratigraphy[1].depth_from_m"].confidence == 0.91
    assert prov["stratigraphy[2].depth_to_m"].method == "ocr"  # scanned page 3
    # DIN codes: the model's code agreeing with the vocabulary, or derived from the printed description.
    assert (gravel.din4023_code, prov["stratigraphy[1].din4023_code"].method) == ("G", "derived")
    assert (topsoil.din4023_code, prov["stratigraphy[0].din4023_code"].method) == ("Mu", "derived")
    assert prov["stratigraphy[0].din4023_code"].box == prov["stratigraphy[0].original_description"].box
    # English rendering: method guessed with the description's box.
    english = prov["stratigraphy[0].english_lithology"]
    assert (english.method, english.box) == ("guessed", prov["stratigraphy[0].original_description"].box)
    assert clay.english_lithology is None and "stratigraphy[2].english_lithology" not in prov
    assert rec.groundwater[0].model_dump(include={"type", "depth_m", "date", "raw"}) == {
        "type": "strike",
        "depth_m": 2.8,
        "date": "2024-03-12",
        "raw": "2,80",
    }

    assert_nothing_invented(
        rec,
        [
            "metadata.drilling_contractor",
            "metadata.drilling_method",
            "metadata.inclination_deg",
            "metadata.notes",
            "metadata.country",
        ],
    )
    assert rec.stratigraphy[0].spt_n_value is None and rec.rock_head_m is None

    # Completeness: KB 4 is listed on the summary table but has no log.
    await finalize_document(DE_DOC)
    doc = await document(DE_DOC)
    assert doc.completeness == {
        "expected_ids": ["KB 3", "KB 4"],
        "found_ids": ["KB 3"],
        "missing": ["KB 4"],
        "unexpected": [],
    }
    assert doc.status == "needs_review"
    assert doc.progress is not None and doc.progress["boreholes_extracted"] == 1
    assert await clarifications("crs_confirm") == []  # stated: nothing to ask


@pytest.mark.db
async def test_australian_scan_with_mga_zone_refusal_and_core_runs(db: None) -> None:
    await make_document(AU_DOC, pages={1: ("log_sheet", ["BH-07"], None), 2: ("lab_results", [], None)})
    uid = await finalize_group(AU_DOC, AU_GROUP, outcome(au_result(), AU_BLOCKS))
    assert uid is not None
    rec = await record_of(uid)
    prov = rec.provenance
    assert (rec.crs_status, rec.metadata.coordinates.crs_code, rec.plotted) == ("stated", "EPSG:28355", True)
    assert rec.metadata.coordinates.latitude is not None and -38 < rec.metadata.coordinates.latitude < -37.6
    assert (rec.metadata.surface_elevation_mASL, rec.metadata.elevation_datum) == (45.2, "AHD")
    # No text layer: every printed value is an OCR reading.
    assert {p.method for path, p in prov.items() if path.endswith(("depth_from_m", "depth_to_m"))} == {"ocr"}
    # Total depth not printed: bottom of the last layer.
    assert (rec.metadata.borehole_depth_m, rec.metadata.borehole_depth_source) == (8.5, "last_layer")
    assert prov["metadata.borehole_depth_m"].method == "derived"

    clay, rock = rec.stratigraphy[1], rec.stratigraphy[2]
    assert (clay.spt_n_value, clay.spt_refusal, clay.spt_increments, clay.spt_depth_m) == (
        14,
        False,
        [4, 6, 8],
        1.5,
    )
    assert prov["stratigraphy[1].spt_n_value"].raw == "N=14"
    # Refusal: no N value, the penetration is kept, and the flag cites its printed sources.
    assert (rock.spt_refusal, rock.spt_n_value, rock.spt_penetration_cm, rock.spt_raw) == (
        True,
        None,
        10.0,
        "12, 25/100mm",
    )
    assert "stratigraphy[2].spt_n_value" not in prov
    refusal = prov["stratigraphy[2].spt_refusal"]
    assert (refusal.method, refusal.page, refusal.box) == ("derived", 1, [0.6, 0.55, 0.2, 0.02])
    # Core runs by overlap: 3.00-8.50 overlaps the 3.00-6.00 run most.
    assert (rock.is_core, rock.rqd_pct, rock.core_recovery_pct) == (True, 60.0, 95.0)
    assert prov["stratigraphy[2].is_core"].method == "derived"
    assert prov["stratigraphy[2].rqd_pct"].raw == "60"
    assert (rock.din4023_code, prov["stratigraphy[2].din4023_code"].method) == ("Sst", "derived")
    assert rock.weathering == "slightly weathered"
    assert clay.is_core is None and clay.rqd_pct is None

    assert rec.groundwater[0].model_dump(include={"type", "depth_m", "date"}) == {
        "type": "rest",
        "depth_m": 2.1,
        "date": None,
    }
    assert prov["groundwater[0].type"].method == "guessed"
    assert [
        s.model_dump(include={"name", "type_code", "depth_from_m", "depth_to_m"}) for s in rec.samples
    ] == [{"name": "U50", "type_code": "U", "depth_from_m": 1.0, "depth_to_m": 1.45}]
    tests = [(t.name, t.value, t.unit, t.depth_m) for t in rec.test_results]
    assert tests == [("UCS", 32.5, "MPa", 5.2), ("Watercontent", 18.5, "%", None)]  # shear vane: no field
    assert prov["test_results[0].value"].page == 2


async def finalize_us_document(doc_id: str, label: str, northing: str, easting: str) -> str:
    await make_document(doc_id, pages={1: ("log_sheet", [label], 0.97)}, project="Fictional Harbor Yard")
    group = PageGroup(key=f"g-{label}", label_raw=label, label_canonical=label.replace("-", ""), pages=(1,))
    uid = await finalize_group(
        doc_id, group, outcome(us_result(1, label, northing, easting), us_blocks(1, label, northing, easting))
    )
    assert uid is not None
    return uid


@pytest.mark.db
async def test_us_feet_without_system_one_crs_question_per_project(db: None) -> None:
    uids = {"B-1": await finalize_us_document(US_DOC_A, "B-1", "212,345.6", "1,012,345.2")}

    rec = await record_of(uids["B-1"])
    # Feet converted to metres; provenance keeps the printed text.
    assert [(la.depth_from_m, la.depth_to_m) for la in rec.stratigraphy] == [(0.0, 1.6764), (1.6764, 6.096)]
    assert rec.provenance["stratigraphy[1].depth_to_m"].raw == "20.0"
    assert (rec.metadata.borehole_depth_m, rec.provenance["metadata.borehole_depth_m"].raw) == (
        6.096,
        "20.0 ft",
    )
    assert rec.metadata.surface_elevation_mASL == 156.14904
    assert rec.stratigraphy[0].uscs_group == "CL"
    # The SPT at 5.5 ft (the layer boundary) belongs to the layer that starts there.
    assert (rec.stratigraphy[1].spt_n_value, rec.stratigraphy[1].spt_depth_m) == (16, 1.6764)
    assert rec.stratigraphy[0].spt_n_value is None
    # No printed system: inferred, never plotted, nothing guessed silently.
    coords = rec.metadata.coordinates
    assert (rec.crs_status, coords.crs_code, rec.plotted, rec.unplotted_reason) == (
        "inferred",
        None,
        False,
        "crs_unconfirmed",
    )
    assert (coords.local_x, coords.local_y, coords.latitude, coords.longitude) == (
        1012345.2,
        212345.6,
        None,
        None,
    )
    assert rec.provenance["metadata.coordinates.local_x"].raw == "1,012,345.2"  # the easting as printed
    assert (coords.coordinate_system, rec.provenance.get("metadata.coordinates.coordinate_system")) == (
        None,
        None,
    )

    await finalize_document(US_DOC_A)
    first = await clarifications("crs_confirm")
    assert len(first) == 1 and first[0].borehole_uids == [uids["B-1"]]
    # A later upload of the same project: the open question grows instead of a second one.
    uids["B-2"] = await finalize_us_document(US_DOC_B, "B-2", "212,512.0", "1,012,812.5")
    await finalize_document(US_DOC_B)
    await finalize_document(US_DOC_B)  # a rerun asks nothing new
    await finalize_document(US_DOC_A)
    questions = await clarifications("crs_confirm")
    assert len(questions) == 1, "one question per project"
    question = questions[0]
    assert question.id == first[0].id and sorted(question.borehole_uids) == sorted(uids.values())
    assert question.project == "Fictional Harbor Yard"
    crs_field, swap_field = question.fields
    assert (crs_field["widget"], crs_field["required"], swap_field["widget"]) == (
        "crs_picker",
        True,
        "boolean",
    )
    assert crs_field["options"] and all(o["value"].startswith("EPSG:") for o in crs_field["options"])
    assert crs_field["options"][0]["evidence"]["page"] == 1
    assert sorted(e["snippet"] for e in question.evidence) == [
        "212,345.6 1,012,345.2",
        "212,512.0 1,012,812.5",
    ]
    async with get_sessionmaker()() as session:
        from app.clarify.service import clarification_out

        row = await session.get(Clarification, question.id)
        assert row is not None
        validate_schema(clarification_out(row).model_dump(mode="json"), "Clarification")

    # Answering it confirms the system for both documents' boreholes, which then plot.
    async with get_sessionmaker()() as session:
        await answer_clarification(session, question.id, {"crs": "EPSG:2263", "swap_axes": False}, "tester")
        await session.commit()
    for uid in uids.values():
        rec = await record_of(uid)
        assert (rec.crs_status, rec.plotted) == ("confirmed", True)
        assert (
            rec.metadata.coordinates.latitude is not None and 40.6 < rec.metadata.coordinates.latitude < 40.9
        )
    doc = await document(US_DOC_B)
    assert doc.status == "needs_review" and doc.completeness is None  # no summary table printed


DE_SWAP_DOC = "doc_01JFINAL000000000000000DE2"
DK_DOC_A = "doc_01JFINAL000000000000000DKA"
DK_DOC_B = "doc_01JFINAL000000000000000DKB"


@pytest.mark.db
async def test_a_stated_system_read_with_swapped_axes_plots_where_the_log_is(db: None) -> None:
    await make_document(
        DE_SWAP_DOC, pages={2: ("log_sheet", ["KB 3"], 0.95), 3: ("log_continuation", [], 0.4)}
    )
    uid = await finalize_group(DE_SWAP_DOC, DE_GROUP, outcome(de_swapped_result(), DE_BLOCKS))
    assert uid is not None
    rec = await record_of(uid)
    coords = rec.metadata.coordinates
    assert (rec.crs_status, coords.crs_code, rec.plotted, rec.unplotted_reason) == (
        "stated",
        "EPSG:25832",
        True,
        None,
    )
    assert (coords.local_x, coords.local_y) == (5316044.2, 413210.5)  # as printed
    expected = to_wgs84("EPSG:25832", 413210.5, 5316044.2)  # the easting read as the easting
    assert expected is not None
    assert (coords.latitude, coords.longitude) == pytest.approx(expected, abs=1e-6)
    async with get_sessionmaker()() as session:
        bh = await session.get(Borehole, uid)
        assert bh is not None and bh.swap_axes is True
    await finalize_document(DE_SWAP_DOC)
    assert await clarifications("crs_confirm") == []  # stated: nothing to ask


@pytest.mark.db
async def test_system_34_sjaelland_is_stated_or_confirmed_and_plots_on_sjaelland(db: None) -> None:
    # Printed with its name: stated, the west-orientated easting negated, plotted on Sjælland.
    await make_document(DK_DOC_A, pages={1: ("log_sheet", ["B1"], None)})
    group = PageGroup(key="g-B1", label_raw="B1", label_canonical="B1", pages=(1,))
    uid = await finalize_group(
        DK_DOC_A, group, dk_outcome(1, "B1", "72 048,15", "140 505,76", "System 34 Sjælland")
    )
    assert uid is not None
    rec = await record_of(uid)
    coords = rec.metadata.coordinates
    assert (rec.crs_status, coords.crs_code, coords.crs_label, rec.plotted) == (
        "stated",
        "EPSG:10250",
        "System 34 Sjælland (S34S)",
        True,
    )
    assert (coords.latitude, coords.longitude) == pytest.approx((55.676, 12.568), abs=1e-3)

    # Printed without a system: asked, System 34 Sjælland offered first, and confirming it plots.
    await make_document(DK_DOC_B, pages={1: ("log_sheet", ["B2"], None), 2: ("log_sheet", ["B3"], None)})
    uids = []
    for page, label, east, north in (
        (1, "B2", "72 210,40", "140 702,05"),
        (2, "B3", "71 880,90", "140 330,60"),
    ):
        group = PageGroup(key=f"g-{label}", label_raw=label, label_canonical=label, pages=(page,))
        new_uid = await finalize_group(DK_DOC_B, group, dk_outcome(page, label, east, north, None))
        assert new_uid is not None
        uids.append(new_uid)
        assert (await record_of(new_uid)).crs_status == "inferred"
    await finalize_document(DK_DOC_B)
    (question,) = await clarifications("crs_confirm")
    assert question.fields[0]["options"][0]["value"] == "EPSG:10250"
    assert question.fields[1]["default"] is False
    async with get_sessionmaker()() as session:
        await answer_clarification(session, question.id, {"crs": "EPSG:10250", "swap_axes": False}, "tester")
        await session.commit()
    for new_uid in uids:
        rec = await record_of(new_uid)
        assert (rec.crs_status, rec.plotted) == ("confirmed", True)
        assert (rec.metadata.coordinates.latitude, rec.metadata.coordinates.longitude) == pytest.approx(
            (55.676, 12.568), abs=0.01
        )


@pytest.mark.db
async def test_degrees_minutes_and_depths_without_unit(db: None) -> None:
    await make_document(DM_DOC, pages={1: ("log_sheet", ["S1"], None), 2: ("log_sheet", ["S2"], None)})
    uids = []
    for page, label, lat, lon in (
        (1, "S1", "N 47°25.512'", "E 8°31.204'"),
        (2, "S2", "N 47°25.530'", "E 8°31.260'"),
    ):
        group = PageGroup(key=f"g-{label}", label_raw=label, label_canonical=label, pages=(page,))
        uid = await finalize_group(
            DM_DOC, group, outcome(dm_result(page, label, lat, lon), dm_blocks(page, label, lat, lon))
        )
        assert uid is not None
        uids.append(uid)
    rec = await record_of(uids[0])
    coords = rec.metadata.coordinates
    assert (rec.crs_status, coords.crs_code, rec.plotted) == ("stated", "EPSG:4326", True)
    assert coords.latitude == pytest.approx(47.4252) and coords.longitude == pytest.approx(
        8.5200667, abs=1e-6
    )
    assert (coords.x_raw, coords.y_raw) == ("N 47°25.512'", "E 8°31.204'")
    assert rec.provenance["metadata.coordinates.local_y"].raw == "N 47°25.512' / E 8°31.204'"  # both cited

    # No unit printed anywhere: metres, marked as guessed on every depth value, and one question.
    assert [(la.depth_from_m, la.depth_to_m) for la in rec.stratigraphy] == [(0.0, 0.5), (0.5, 2.0)]
    depth_methods = {
        path: p.method for path, p in rec.provenance.items() if path.endswith(("depth_from_m", "depth_to_m"))
    }
    assert set(depth_methods.values()) == {"guessed"} and len(depth_methods) == 4
    assert rec.provenance["metadata.borehole_depth_m"].method == "guessed"
    assert rec.metadata.borehole_depth_source == "last_layer"
    # A rerun of a finished group changes nothing and asks nothing new.
    rerun_group = PageGroup(key="g-S1", label_raw="S1", label_canonical="S1", pages=(1,))
    rerun = dm_result(1, "S1", "N 47°25.512'", "E 8°31.204'")
    blocks = dm_blocks(1, "S1", "N 47°25.512'", "E 8°31.204'")
    assert await finalize_group(DM_DOC, rerun_group, outcome(rerun, blocks)) == uids[0]
    questions = await clarifications("unit_ambiguous")
    assert len(questions) == 1
    assert "'2.00'" in questions[0].question and questions[0].fields[0]["default"] == 2.0
    question = questions[0]
    assert question.borehole_uids == uids and question.path is None
    assert question.fields[0]["widget"] == "number_unit" and question.fields[0]["unit_options"] == ["m", "ft"]
    assert question.evidence and question.evidence[0]["page"] == 1
    # The model said the client is not printed and cited nothing: no value, no provenance.
    assert_nothing_invented(
        rec, ["metadata.client", "metadata.surface_elevation_mASL", "metadata.project_name"]
    )


@pytest.mark.db
async def test_finalize_is_idempotent_and_asks_boundary_questions_once(db: None) -> None:
    await make_document(DE_DOC, pages={2: ("log_sheet", ["KB 3"], 0.95), 3: ("log_continuation", [], 0.4)})
    uncertain = PageGroup(
        key="g-kb3",
        label_raw="KB 3",
        label_canonical="KB3",
        pages=(2, 3),
        uncertain=("page 3 has no printed label",),
    )
    first = await finalize_group(DE_DOC, uncertain, outcome(de_result(), DE_BLOCKS))
    second = await finalize_group(DE_DOC, uncertain, outcome(de_result(), DE_BLOCKS))
    assert first is not None and first == second
    await finalize_document(DE_DOC)
    await finalize_document(DE_DOC)
    async with get_sessionmaker()() as session:
        assert await session.scalar(select(func.count()).select_from(Borehole)) == 1
        bh = await session.get(Borehole, first)
        assert bh is not None and bh.revision == 1
    boundary = await clarifications("borehole_boundary")
    assert len(boundary) == 1 and len(await clarifications()) == 1
    question = boundary[0]
    assert question.borehole_uids == [first]
    assert question.fields[0]["widget"] == "page_range" and question.fields[0]["default"] == [2, 3]
    assert [e["page"] for e in question.evidence] == [2, 3]
    assert question.evidence[0]["box"] == [0.08, 0.04, 0.2, 0.02]  # the printed label
    doc = await document(DE_DOC)
    assert doc.completeness is None  # no summary or coordinate table in this document


@pytest.mark.db
async def test_group_label_from_the_classifier_and_document_done_when_approved(db: None) -> None:
    """Without a label in the extraction, the classifier's label is used and pointed at a printed block."""
    await make_document(AU_DOC, pages={1: ("log_sheet", ["BH-07"], None), 2: ("lab_results", [], None)})
    res = au_result()
    res = res.model_copy(update={"header": res.header.model_copy(update={"borehole_label": absent()})})
    uid = await finalize_group(AU_DOC, AU_GROUP, outcome(res, AU_BLOCKS))
    assert uid is not None
    rec = await record_of(uid)
    label = rec.provenance["metadata.borehole_id"]
    assert (rec.metadata.borehole_id, label.page, label.box, label.method) == (
        "BH-07",
        1,
        [0.05, 0.03, 0.25, 0.02],
        "ocr",
    )

    # Every value approved -> the document is done after finalisation.
    async with get_sessionmaker()() as session:
        from app.db.models import FieldValue

        for fv in (await session.scalars(select(FieldValue).where(FieldValue.uid == uid))).all():
            fv.status = "approved"
        bh = await session.get(Borehole, uid)
        assert bh is not None
        bh.review_status = "approved"
        await session.commit()
    await finalize_document(AU_DOC)
    assert (await document(AU_DOC)).status == "done"


def test_a_test_printed_over_its_drive_interval_is_one_spt() -> None:
    """Top and base of one drive (identical blows within one drive length) are one test, not two."""
    block = next(iter(DE_BLOCKS))
    top = spt(rv("1,50", block), rv("5/7/9", block), rv("N=16", block))
    base = spt(rv("1,95", block), rv("5/7/9", block), rv("N=16", block))
    with_twin = de_result().model_copy(update={"spt": [top, base]})
    draft = build_record("doc_X", DE_GROUP, outcome(with_twin, DE_BLOCKS))
    assert draft.body is not None
    held = [layer for layer in draft.body["stratigraphy"] if layer.get("spt_raw")]
    assert len(held) == 1 and held[0]["spt_depth_m"] == 1.5
    assert any("repeats a test" in w for w in draft.warnings)


# ----------------------------------------------------------------------------------------------
# Family 5: vector PDF with a text layer; the OCR returns one coarse block per page
# ----------------------------------------------------------------------------------------------


def coarse_report() -> bytes:
    """Two FICTIONAL log pages: "5,40" is printed in the header and in the table, "1,20" and "3,40" end one
    row and start the next, one description wraps over two lines."""
    return make_pdf(
        [
            [
                TextItem(60, 780, "Bohrung KB 12 (fiktiv)", 14),
                TextItem(60, 760, "Projekt: Fiktive Halle Musterau"),
                TextItem(60, 745, "Endtiefe 5,40"),
                TextItem(300, 745, "Ansatzpunkt +212,30 m NN"),
                TextItem(60, 715, "Tiefe [m]"),
                TextItem(60, 700, "0,00"),
                TextItem(110, 700, "1,20"),
                TextItem(170, 700, "Mutterboden, schluffig"),
                TextItem(60, 680, "1,20"),
                TextItem(110, 680, "3,40"),
                TextItem(170, 680, "Sand, mittelsandig,"),
                TextItem(170, 668, "schwach kiesig, braun"),
                TextItem(400, 680, "GW 2,10"),
                TextItem(60, 648, "3,40"),
                TextItem(110, 648, "5,40"),
                TextItem(170, 648, "Ton, steif, grau"),
            ],
            [
                TextItem(60, 780, "KB 12 Blatt 2 (fiktiv)", 14),
                TextItem(60, 700, "Bemerkung: Bohrung trocken"),
            ],
        ]
    )


# One OCR block per page, covering everything printed on it (as Mistral OCR may return a whole table).
COARSE_BOXES = {1: (0.05, 0.03, 0.9, 0.3), 2: (0.05, 0.03, 0.9, 0.2)}
COARSE_BLOCKS = block_map(
    [
        BlockRef(
            id=f"p{n}.b0",
            page=n,
            text=text,
            box=COARSE_BOXES[n],
            confidence=0.93,
            page_text_quality=0.99,
            page_handwriting="none",
        )
        for n, text in (
            (1, "Bohrung KB 12 (fiktiv) Projekt: Fiktive Halle Musterau Endtiefe 5,40 ... Ton, steif, grau"),
            (2, "KB 12 Blatt 2 (fiktiv) Bemerkung: Bohrung trocken"),
        )
    ]
)
COARSE_GROUP = PageGroup(key="g-kb12", label_raw="KB 12", label_canonical="KB12", pages=(1, 2))


def coarse_result(*, label: bool = True) -> ExtractionResult:
    b = "p1.b0"
    head = header(
        borehole_label=rv("KB 12", b) if label else absent(),
        project=rv("Fiktive Halle Musterau", b),
        location=rv("Musterau-Süd", b),  # the model's reading is not what is printed: no agreement
        total_depth=rv("5,40", b),
        depth_unit=rv("Tiefe [m]", b),
        ground_level=rv("+212,30", b),
        elevation_datum=rv("m NN", b),
        notes=rv("Bohrung trocken", "p2.b0"),
    )
    layers = [
        layer(rv("0,00", b), rv("1,20", b), rv("Mutterboden, schluffig", b), language="de"),
        layer(
            rv("1,20", b),
            rv("3,40", b),
            rv("Sand, mittelsandig, schwach kiesig, braun", b),
            language="de",
            colour_raw=rv("braun", b),
        ),
        layer(
            rv("3,40", b),
            rv("5,40", b),
            rv("Ton, steif, grau", b),
            language="de",
            colour_raw=rv("grau", b),
            consistency_raw=rv("steif", b),
        ),
    ]
    water = ExtractedGroundwater(type="strike", depth_raw=rv("2,10", b), date_raw=absent())
    return result(head, layers, groundwater=[water])


def words_box(layer_text: PageText, *words: tuple[str, int]) -> list[float]:
    """Union box of printed words given as (text, occurrence on the page), rounded like provenance."""
    boxes = []
    for word, nth in words:
        boxes.append([w.box for w in layer_text.words if w.text == word][nth])
    box = union_box(boxes)
    assert box is not None
    return box


def text_layers_of(pdf: bytes, folder: Path) -> dict[int, PageText]:
    """Triage's text layer of every page (the same words the pipeline stores)."""
    path = folder / "fictional-coarse.pdf"
    path.write_bytes(pdf)
    return {
        page.n: textlayer.page_text(
            page.n, [(w.text, w.box) for w in page.words], quality=page.text_layer_quality
        )
        for page in triage_pdf(path)
    }


def assert_tight_boxes(prov: dict[str, Any], layers: dict[int, PageText]) -> None:
    """Every value found in the text layer points at its printed words, far smaller than the OCR block."""
    p1, p2 = layers[1], layers[2]
    expected = {
        "metadata.borehole_id": (1, words_box(p1, ("KB", 0), ("12", 0))),
        "metadata.project_name": (1, words_box(p1, ("Fiktive", 0), ("Musterau", 0))),
        # "5,40" twice: the header's total depth and the table's base of the last layer.
        "metadata.borehole_depth_m": (1, words_box(p1, ("5,40", 0))),
        "stratigraphy[2].depth_to_m": (1, words_box(p1, ("5,40", 1))),
        # A row's top is the next row's printed "1,20" / "3,40", not the base printed in the row above.
        "stratigraphy[0].depth_to_m": (1, words_box(p1, ("1,20", 0))),
        "stratigraphy[1].depth_from_m": (1, words_box(p1, ("1,20", 1))),
        "stratigraphy[1].depth_to_m": (1, words_box(p1, ("3,40", 0))),
        "stratigraphy[2].depth_from_m": (1, words_box(p1, ("3,40", 1))),
        # A description wrapped over two lines: the union of its words on both.
        "stratigraphy[1].original_description": (
            1,
            words_box(p1, ("Sand,", 0), ("mittelsandig,", 0), ("schwach", 0), ("kiesig,", 0), ("braun", 0)),
        ),
        "stratigraphy[1].colour": (1, words_box(p1, ("braun", 0))),
        "stratigraphy[2].colour": (1, words_box(p1, ("grau", 0))),
        "stratigraphy[2].consistency_density": (1, words_box(p1, ("steif,", 0))),
        "metadata.surface_elevation_mASL": (1, words_box(p1, ("+212,30", 0))),
        "groundwater[0].depth_m": (1, words_box(p1, ("2,10", 0))),
        "metadata.notes": (2, words_box(p2, ("Bohrung", 0), ("trocken", 0))),
    }
    coarse_area = {n: box[2] * box[3] for n, box in COARSE_BOXES.items()}
    for path, (page, box) in expected.items():
        entry = prov[path]
        assert (entry["page"], entry["box"], entry["method"]) == (page, box, "read"), path
        assert box[2] * box[3] < 0.02 * coarse_area[page], path
    # Printed differently from the model's reading: the coarse block and an OCR reading, never a guess.
    location = prov["metadata.location_name"]
    assert (location["box"], location["method"]) == (list(COARSE_BOXES[1]), "ocr")
    # Derived values keep their method and take the tight box of the text they come from.
    din = prov["stratigraphy[2].din4023_code"]
    assert din["method"] == "derived"
    assert din["box"] == words_box(p1, ("Ton,", 0), ("steif,", 0), ("grau", 0))


def test_coarse_ocr_blocks_shrink_to_the_printed_words(tmp_path: Path) -> None:
    layers = text_layers_of(coarse_report(), tmp_path)
    assert all(t.quality is not None and t.quality > 0.9 for t in layers.values())
    draft = build_record("doc_X", COARSE_GROUP, outcome(coarse_result(), COARSE_BLOCKS), text_layers=layers)
    assert draft.body is not None
    assert not any("text layer" in w for w in draft.warnings)
    prov = {path: entry.model_dump(mode="json") for path, entry in draft.provenance.items()}
    assert_tight_boxes(prov, layers)
    # Without the text layer the same extraction keeps the coarse blocks and reads as OCR.
    plain = build_record("doc_X", COARSE_GROUP, outcome(coarse_result(), COARSE_BLOCKS))
    depth = plain.provenance["stratigraphy[2].depth_to_m"]
    assert (depth.box, depth.method) == (list(COARSE_BOXES[1]), "ocr")


def test_a_label_from_the_classifier_points_at_its_printed_words(tmp_path: Path) -> None:
    layers = text_layers_of(coarse_report(), tmp_path)
    draft = build_record(
        "doc_X", COARSE_GROUP, outcome(coarse_result(label=False), COARSE_BLOCKS), text_layers=layers
    )
    label = draft.provenance["metadata.borehole_id"]
    assert (label.raw, label.page, label.method) == ("KB 12", 1, "read")
    assert label.box == words_box(layers[1], ("KB", 0), ("12", 0))
    assert draft.label_box == label.box


def _box_inside(inner: Sequence[float], outer: Sequence[float]) -> bool:
    return (
        inner[0] >= outer[0] - 1e-6
        and inner[1] >= outer[1] - 1e-6
        and inner[0] + inner[2] <= outer[0] + outer[2] + 1e-6
        and inner[1] + inner[3] <= outer[1] + outer[3] + 1e-6
    )


def test_tight_boxes_stay_inside_the_cited_blocks(tmp_path: Path) -> None:
    layers = text_layers_of(coarse_report(), tmp_path)
    draft = build_record("doc_X", COARSE_GROUP, outcome(coarse_result(), COARSE_BLOCKS), text_layers=layers)
    for path, entry in draft.provenance.items():
        assert entry.page is not None and entry.box is not None, path
        assert _box_inside(entry.box, COARSE_BOXES[entry.page]), path


COARSE_DOC = "doc_01JFINAL00000000000000CRS"


@pytest.mark.db
async def test_finalize_reads_the_stored_text_layer(db: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Triage stores the text layer; finalisation loads it and narrows every box to the printed words."""
    from app.pipeline import orchestrator
    from app.pipeline.orchestrator import run_pipeline

    monkeypatch.setattr(orchestrator, "STAGES", ("triage",))
    pdf = coarse_report()
    digest = hashlib.sha256(pdf).hexdigest()
    get_storage().put_bytes(original_key(digest, ".pdf"), pdf)
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=COARSE_DOC,
                file_name="fictional-coarse.pdf",
                sha256=digest,
                mime_type="application/pdf",
                size_bytes=len(pdf),
                storage_key=original_key(digest, ".pdf"),
                status="queued",
            )
        )
        await session.commit()
    await run_pipeline(COARSE_DOC)
    async with get_sessionmaker()() as session:
        pages = (await session.scalars(select(Page).where(Page.document_id == COARSE_DOC))).all()
        assert sorted(p.n for p in pages) == [1, 2] and all(p.text_layer_key for p in pages)
        for page_row in pages:  # what classification and OCR would have recorded
            page_row.role = "log_sheet" if page_row.n == 1 else "log_continuation"
            page_row.used = True
            page_row.ocr_status = "done"
        await session.commit()
        stored = await load_text_layers(session, COARSE_DOC, [1, 2, 3])
    assert sorted(stored) == [1, 2]

    uid = await finalize_group(COARSE_DOC, COARSE_GROUP, outcome(coarse_result(), COARSE_BLOCKS))
    assert uid is not None
    rec = await record_of(uid)
    prov = {path: entry.model_dump(mode="json") for path, entry in rec.provenance.items()}
    assert_tight_boxes(prov, stored)
    assert rec.metadata.borehole_depth_m == 5.4 and len(rec.stratigraphy) == 3


@pytest.mark.db
async def test_missing_or_untrusted_text_layers_are_skipped(db: None) -> None:
    await make_document(
        DE_DOC,
        pages={1: ("log_sheet", ["KB 3"], 0.95), 2: ("log_sheet", [], 0.95), 3: ("log_sheet", [], 0.4)},
    )
    async with get_sessionmaker()() as session:
        rows = {p.n: p for p in (await session.scalars(select(Page).where(Page.document_id == DE_DOC))).all()}
        rows[1].text_layer_key = f"pages/{DE_DOC}/text/0001.json"  # file never written
        rows[2].text_layer_key = f"pages/{DE_DOC}/text/0002.json"
        rows[3].text_layer_key = f"pages/{DE_DOC}/text/0003.json"
        await session.commit()
    get_storage().put_bytes(f"pages/{DE_DOC}/text/0002.json", b"{not json")
    get_storage().put_bytes(f"pages/{DE_DOC}/text/0003.json", b'{"text": "x", "words": []}')
    async with get_sessionmaker()() as session:
        assert await load_text_layers(session, DE_DOC, [1, 2, 3]) == {}  # 3 is below the quality bar
    # Finalisation still works and keeps the OCR blocks.
    uid = await finalize_group(DE_DOC, DE_GROUP, outcome(de_result(), DE_BLOCKS))
    assert uid is not None
    rec = await record_of(uid)
    assert rec.provenance["metadata.borehole_depth_m"].box == [0.6, 0.07, 0.2, 0.02]


# ----------------------------------------------------------------------------------------------
# Family 7: a log whose depth column prints only the base of each stratum, over three sheets
# ----------------------------------------------------------------------------------------------

BASES_BLOCKS = block_map(
    [
        blk("p1.b0", "Bohrung FB 7", (0.08, 0.04, 0.2, 0.02), quality=None),
        blk("p1.b1", "0,40 m", (0.08, 0.2, 0.06, 0.02), quality=None),
        blk("p1.b2", "Mutterboden", (0.2, 0.2, 0.3, 0.02), quality=None),
        blk("p1.b3", "2,10 m", (0.08, 0.3, 0.06, 0.02), quality=None),
        blk("p1.b4", "Lehm, sandig", (0.2, 0.3, 0.3, 0.02), quality=None),
        blk("p1.b5", "5,00 m", (0.08, 0.5, 0.06, 0.02), quality=None),
        blk("p1.b6", "Kies, sandig", (0.2, 0.5, 0.3, 0.02), quality=None),
        blk("p2.b0", "7,30 m", (0.08, 0.2, 0.06, 0.02), quality=None),
        blk("p2.b1", "Sand, kiesig", (0.2, 0.2, 0.3, 0.02), quality=None),
        blk("p3.b0", "9,00 m", (0.08, 0.3, 0.06, 0.02), quality=None),
        blk("p3.b1", "Ton, steif", (0.2, 0.3, 0.3, 0.02), quality=None),
    ]
)
# (base, its block, description, its block) of every printed stratum, top to bottom
BASES_ROWS = [
    ("0,40 m", "p1.b1", "Mutterboden", "p1.b2"),
    ("2,10 m", "p1.b3", "Lehm, sandig", "p1.b4"),
    ("5,00 m", "p1.b5", "Kies, sandig", "p1.b6"),
    ("7,30 m", "p2.b0", "Sand, kiesig", "p2.b1"),
    ("9,00 m", "p3.b0", "Ton, steif", "p3.b1"),
]
BASES_ROLES: dict[int, str | None] = {1: "log_sheet", 2: "log_continuation", 3: "log_continuation"}


def bases_result(
    rows: Sequence[tuple[str, str, str, str]] = tuple(BASES_ROWS), *, first_top: RawValue | None = None
) -> ExtractionResult:
    """As the model returns a log that prints one depth per stratum: the base in to_raw, the top empty."""
    layers = [
        layer(absent(), rv(base, base_block), rv(text, text_block), language="de")
        for base, base_block, text, text_block in rows
    ]
    if first_top is not None:
        layers[0] = layers[0].model_copy(update={"from_raw": first_top})
    head = header(borehole_label=rv("FB 7", "p1.b0"), depth_unit=rv("m", "p1.b1"))
    return result(head, layers)


def bases_group(*pages: int) -> PageGroup:
    return PageGroup(key=f"g-fb7-{pages}", label_raw="FB 7", label_canonical="FB7", pages=pages)


def intervals(draft: RecordDraft) -> list[tuple[float, float]]:
    assert draft.body is not None
    return [(layer["depth_from_m"], layer["depth_to_m"]) for layer in draft.body["stratigraphy"]]


def test_a_log_printing_only_bases_starts_at_the_ground_and_each_layer_at_the_base_above() -> None:
    draft = build_record(
        "doc_X", bases_group(1, 2, 3), outcome(bases_result(), BASES_BLOCKS), page_roles=BASES_ROLES
    )
    # one layer per printed stratum, none invented, each top derived
    assert intervals(draft) == [(0.0, 0.4), (0.4, 2.1), (2.1, 5.0), (5.0, 7.3), (7.3, 9.0)]
    prov = draft.provenance
    ground = prov["stratigraphy[0].depth_from_m"]
    assert (ground.method, ground.raw, ground.page) == ("derived", None, 1)  # no printed value: the row
    above = prov["stratigraphy[1].depth_from_m"]
    assert (above.method, above.raw, above.page) == ("derived", "0,40 m", 1)
    assert above.box == [0.08, 0.2, 0.06, 0.02]  # the printed base above
    across = prov["stratigraphy[3].depth_from_m"]  # the first row of the next sheet: the last base above
    assert (across.method, across.raw, across.page) == ("derived", "5,00 m", 1)
    assert all(prov[f"stratigraphy[{i}].depth_to_m"].method == "ocr" for i in range(5))  # bases as printed
    assert not any("unreadable layer interval" in w for w in draft.warnings)
    # pages of unknown role count as a log's first sheet
    unknown = build_record("doc_X", bases_group(1, 2, 3), outcome(bases_result(), BASES_BLOCKS))
    assert intervals(unknown) == intervals(draft)


def test_the_ground_the_model_implies_on_the_first_row_is_read_as_0_m() -> None:
    for implied in ("0,00", "0"):
        res = bases_result(BASES_ROWS[:2], first_top=rv(implied, state="not_in_source"))
        draft = build_record("doc_X", bases_group(1), outcome(res, BASES_BLOCKS), page_roles=BASES_ROLES)
        assert intervals(draft) == [(0.0, 0.4), (0.4, 2.1)]
        entry = draft.provenance["stratigraphy[0].depth_from_m"]
        assert (entry.method, entry.raw) == ("derived", None)


def test_printed_tops_stay_and_only_the_missing_top_is_derived() -> None:
    res = bases_result(BASES_ROWS[:3])
    tops = [rv("0,40 m", "p1.b1"), rv("2,10 m", "p1.b3")]
    printed_tops = [
        row.model_copy(update={"from_raw": top}) for row, top in zip(res.layers[1:], tops, strict=True)
    ]
    res = res.model_copy(update={"layers": [res.layers[0], *printed_tops]})
    draft = build_record("doc_X", bases_group(1), outcome(res, BASES_BLOCKS), page_roles=BASES_ROLES)
    assert intervals(draft) == [(0.0, 0.4), (0.4, 2.1), (2.1, 5.0)]
    methods = [draft.provenance[f"stratigraphy[{i}].depth_from_m"].method for i in range(3)]
    assert methods == ["derived", "ocr", "ocr"]


def test_a_further_sheet_read_on_its_own_does_not_start_at_the_ground() -> None:
    """The first stratum of a further sheet starts where the sheet before ends, which this group lacks:
    it is left out, never given a top of 0 m."""
    res = bases_result(BASES_ROWS[3:])
    draft = build_record("doc_X", bases_group(2, 3), outcome(res, BASES_BLOCKS), page_roles=BASES_ROLES)
    assert intervals(draft) == [(7.3, 9.0)]
    assert any("layer 1: unreadable layer interval" in w for w in draft.warnings)


def test_no_top_is_taken_across_a_sheet_read_in_another_group() -> None:
    rows = [*BASES_ROWS[:3], BASES_ROWS[4]]  # page 2 belongs to another group
    res = bases_result(rows)
    gap = build_record("doc_X", bases_group(1, 3), outcome(res, BASES_BLOCKS), page_roles=BASES_ROLES)
    assert intervals(gap) == [(0.0, 0.4), (0.4, 2.1), (2.1, 5.0)]
    # page 2 is part of the group (it prints no stratum): the log follows on
    whole = build_record("doc_X", bases_group(1, 2, 3), outcome(res, BASES_BLOCKS), page_roles=BASES_ROLES)
    assert intervals(whole)[-1] == (5.0, 9.0)


def test_values_that_do_not_go_down_the_log_get_no_derived_top() -> None:
    elevations = [
        ("312,40", "p1.b1", "Mutterboden", "p1.b2"),
        ("310,10", "p1.b3", "Lehm, sandig", "p1.b4"),
        ("307,50", "p1.b5", "Kies, sandig", "p1.b6"),
    ]
    res = bases_result(elevations)
    draft = build_record("doc_X", bases_group(1), outcome(res, BASES_BLOCKS), page_roles=BASES_ROLES)
    assert intervals(draft) == []  # nothing invented
    repeated = [BASES_ROWS[0], ("0,40 m", "p1.b3", "Lehm, sandig", "p1.b4"), BASES_ROWS[2]]
    res = bases_result(repeated)
    draft = build_record("doc_X", bases_group(1), outcome(res, BASES_BLOCKS), page_roles=BASES_ROLES)
    assert intervals(draft) == [(0.0, 0.4), (0.4, 5.0)]  # a base not below the one above gets no top


def _de_header(**update: RawValue) -> ExtractionResult:
    res = de_result()
    return res.model_copy(update={"header": res.header.model_copy(update=update)})


def _de_coordinates(**update: RawValue) -> ExtractionResult:
    res = de_result()
    coords = res.header.coordinates.model_copy(update=update)
    return res.model_copy(update={"header": res.header.model_copy(update={"coordinates": coords})})


def test_a_ground_level_printed_below_its_datum_is_read_and_flagged() -> None:
    res = _de_header(ground_level=rv("- 2,35", "p2.b7"))
    draft = build_record("doc_X", DE_GROUP, outcome(res, DE_BLOCKS))
    assert draft.body is not None
    assert draft.body["metadata"]["surface_elevation_mASL"] == -2.35  # the sign printed apart is its sign
    entry = draft.provenance["metadata.surface_elevation_mASL"]
    assert (entry.raw, entry.status) == ("- 2,35", "unreviewed")
    assert entry.flag is not None and "local reference" in entry.flag
    plain = build_record("doc_X", DE_GROUP, outcome(de_result(), DE_BLOCKS))
    assert plain.provenance["metadata.surface_elevation_mASL"].flag is None


def test_a_negative_depth_printed_below_ground_is_a_depth() -> None:
    water = ExtractedGroundwater(type="strike", depth_raw=rv("-2,80 m u. G.", "p2.b17"), date_raw=absent())
    res = de_result().model_copy(update={"groundwater": [water]})
    draft = build_record("doc_X", DE_GROUP, outcome(res, DE_BLOCKS))
    assert draft.body is not None
    reading = draft.body["groundwater"][0]
    assert (reading["depth_m"], reading["raw"]) == (2.8, "-2,80 m u. G.")


def test_a_start_and_end_printed_as_one_range_are_both_read() -> None:
    res = _de_header(start_date=rv("11.03. - 14.03.24", "p2.b4"), end_date=absent())
    draft = build_record("doc_X", DE_GROUP, outcome(res, DE_BLOCKS))
    assert draft.body is not None
    meta = draft.body["metadata"]
    assert (meta["start_date"], meta["end_date"], meta.get("drilling_date")) == (
        "2024-03-11",
        "2024-03-14",
        None,
    )
    for key in ("start_date", "end_date"):
        entry = draft.provenance[f"metadata.{key}"]
        assert (entry.method, entry.raw) == ("derived", "11.03. - 14.03.24")
    # the end field printing the range's end agrees; one printing another date does not
    agreeing = _de_header(start_date=rv("11.03.-14.03.2024", "p2.b4"), end_date=rv("14.03.2024", "p2.b4"))
    meta = (build_record("doc_X", DE_GROUP, outcome(agreeing, DE_BLOCKS)).body or {})["metadata"]
    assert (meta["start_date"], meta["end_date"]) == ("2024-03-11", "2024-03-14")
    other = _de_header(start_date=rv("11.03.-14.03.2024", "p2.b4"), end_date=rv("20.03.2024", "p2.b4"))
    meta = (build_record("doc_X", DE_GROUP, outcome(other, DE_BLOCKS)).body or {})["metadata"]
    assert (meta["start_date"], meta["end_date"]) == (None, "2024-03-20")
    assert meta["drilling_date"] == "11.03.-14.03.2024 – 20.03.2024"  # as printed, not guessed


def test_a_date_in_brackets_after_the_place_is_the_drilling_date_when_no_date_is_printed() -> None:
    place = rv("Fiktivweiler (IV/1962)", "p2.b3")
    res = _de_header(location=place, start_date=absent(), end_date=absent())
    draft = build_record("doc_X", DE_GROUP, outcome(res, DE_BLOCKS))
    assert draft.body is not None
    meta = draft.body["metadata"]
    assert (meta["location_name"], meta["drilling_date"], meta["start_date"]) == (
        "Fiktivweiler",
        "IV/1962",
        None,
    )
    entry = draft.provenance["metadata.drilling_date"]
    assert (entry.method, entry.raw, entry.page) == ("derived", "IV/1962", 2)
    # a printed date wins: the place stays as printed
    dated = build_record("doc_X", DE_GROUP, outcome(_de_header(location=place), DE_BLOCKS))
    assert dated.body is not None
    assert dated.body["metadata"]["location_name"] == "Fiktivweiler (IV/1962)"


def test_a_diameter_sign_the_text_layer_left_unmapped_is_put_back() -> None:
    res = de_result()
    stones = res.layers[2].model_copy(
        update={"description_raw": rv("Ton, Steine (bis 8 cm \u0098)", "p3.b2")}
    )
    res = res.model_copy(update={"layers": [*res.layers[:2], stones]})
    draft = build_record("doc_X", DE_GROUP, outcome(res, DE_BLOCKS))
    assert draft.body is not None
    assert draft.body["stratigraphy"][2]["original_description"] == "Ton, Steine (bis 8 cm Ø)"
    assert draft.provenance["stratigraphy[2].original_description"].raw == "Ton, Steine (bis 8 cm Ø)"


BASES_DOC_A = "doc_01JFINAL00000000000000FB7"
BASES_DOC_B = "doc_01JFINAL00000000000000FB8"


@pytest.mark.db
async def test_finalize_reads_the_page_roles_for_a_log_printing_only_bases(db: None) -> None:
    """A log's first sheet starts at the ground; a page classified as a further sheet does not."""
    res = bases_result(BASES_ROWS[:3])
    await make_document(BASES_DOC_A, pages={1: ("log_sheet", ["FB 7"], None)})
    uid = await finalize_group(BASES_DOC_A, bases_group(1), outcome(res, BASES_BLOCKS))
    assert uid is not None
    rec = await record_of(uid)
    assert [(s.depth_from_m, s.depth_to_m) for s in rec.stratigraphy] == [(0.0, 0.4), (0.4, 2.1), (2.1, 5.0)]
    assert rec.provenance["stratigraphy[0].depth_from_m"].method == "derived"

    await make_document(BASES_DOC_B, pages={1: ("log_continuation", ["FB 7"], None)})
    uid = await finalize_group(BASES_DOC_B, bases_group(1), outcome(res, BASES_BLOCKS))
    assert uid is not None
    rec = await record_of(uid)
    assert [(s.depth_from_m, s.depth_to_m) for s in rec.stratigraphy] == [(0.4, 2.1), (2.1, 5.0)]
