"""FICTIONAL extraction results -> boreholes, questions and a closed document (no provider is called).

Every label, place, number and OCR block below is invented for these tests. The extraction results are
built by hand as the extractor model would return them (raw text plus cited block ids); the block maps
stand in for Mistral OCR output. Four document families are covered: a German metric log with a printed
ETRS89 / UTM system, an Australian-style scanned log with an MGA zone and AHD levels, a US-style log in
feet without a printed system, and a log with degrees and decimal minutes whose depths carry no unit.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from typing import Any

import pytest
from sqlalchemy import func, select

from app.clarify.answers import answer_clarification
from app.db.models import Borehole, Clarification, Document, Page
from app.db.session import get_sessionmaker
from app.pipeline.finalize import build_record, finalize_document, finalize_group, length_unit_in
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
from app.pipeline.types import BlockRef, ExtractionOutcome, PageGroup
from app.review.service import to_record
from app.schemas.boreholes import BoreholeRecord
from tests.contract_utils import validate_schema

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
    assert method_of([text_page]) == "read"
    assert method_of([text_page, scan_page]) == "ocr"
    assert method_of([unknown_page]) == "ocr"
    assert method_of([]) == "ocr"


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
    assert (entry.method, entry.confidence, entry.raw, entry.state) == ("read", 0.7, "Kies, sandig", "ok")
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

    # Header values as printed or normalised, each with its source box; text-layer page -> "read".
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
        "method": "read",
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
    assert prov["stratigraphy[1].depth_from_m"].method == "read"
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
