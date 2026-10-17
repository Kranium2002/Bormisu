"""Second reads of handwritten and low-confidence values (BACKEND.md 7.7). FICTIONAL data only.

Documents are built directly in the database: a page render drawn with Pillow, OCR blocks with boxes (one per
value) and boreholes created through the review service. The second reader is
app.providers.fakes.FakeRereader, which answers with the OCR text inside each crop, changed where a test
says so. No provider is called.
"""

from __future__ import annotations

import hashlib
import io
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from PIL import Image, ImageDraw
from sqlalchemy import func, select

from app.clarify.answers import answer_clarification
from app.clarify.service import clarification_out
from app.config import get_settings
from app.db.models import (
    Borehole,
    Clarification,
    Document,
    Event,
    ExtractionRun,
    FieldValue,
    OcrPage,
    OcrRun,
    Page,
    ProviderCall,
    Revision,
)
from app.db.session import get_sessionmaker
from app.ids import new_id
from app.pipeline import reread as reread_module
from app.pipeline.reread import (
    PreparedCrop,
    Verdict,
    batches,
    blocks_in_crop,
    compare,
    crop_rect,
    field_label,
    reading_value,
    reread_config,
    stage_reread,
    tokens,
)
from app.providers.base import ProviderError
from app.providers.fakes import FakeRereader
from app.review.service import create_borehole
from app.schemas.boreholes import ProvenanceIn
from app.storage import get_storage, page_render_key
from tests.contract_utils import validate_schema

WIDTH, HEIGHT = 1131, 1600
ROW_STEP = 0.035
BOX_H = 0.015


# ----------------------------------------------------------------------------------------------
# Comparison and helpers (no database)
# ----------------------------------------------------------------------------------------------


LINE = "0,80 - 4,50 Sand, kiesig"


@pytest.mark.parametrize(
    ("raw", "ocr", "second", "expected"),
    [
        ("4,50", LINE, LINE, Verdict("agree")),
        ("4,50", LINE, "0,80 - 4,80 Sand, kiesig", Verdict("disagree", "4,80")),
        ("0,80", LINE, "0,80 - 4,80 Sand, kiesig", Verdict("agree")),  # the other value changed
        ("Sand, kiesig", LINE, "0,80-4,50 SAND,  KIESIG", Verdict("agree")),  # case and spaces
        ("6,00", "Final depth 6,00 m", "Final depth 6.00m", Verdict("agree")),  # same number
        ("413 210,5", "Easting 413 210,5 Northing", "Easting 413210,5 Northing", Verdict("agree")),
        ("1,20", "1,20", "1,70", Verdict("disagree", "1,70")),
        ("12/15/18", "| SPT | 12/15/18 |", "SPT 12/16/18", Verdict("disagree", "12/16/18")),
        ("1,20", "1,20", "1,20 m", Verdict("agree")),  # text after the value is not part of it
        # The value is not in the OCR text and the second reading holds more: it cannot be matched.
        ("Easting, Northing", "Easting 413 480,0 Northing", "Easting 413 480,0 Northing", Verdict("unknown")),
        ("4,50", LINE, "", Verdict("unknown")),
        # The OCR garbled the value and the extractor read it from the image: a tight box is compared whole.
        ("1,20", "l.2O", "1,70", Verdict("disagree", "1,70")),
        ("1,20", "l.2O", "1,20", Verdict("agree")),
        ("1,20", "l.2O", "1,70 m below the casing shoe", Verdict("unknown")),
    ],
)
def test_compare(raw: str, ocr: str, second: str, expected: Verdict) -> None:
    assert compare(raw, [(ocr, True)], second) == expected


def test_compare_reads_the_value_inside_its_own_box() -> None:
    blocks = [("2,10 - 3,40 Ton", False), ("3,40 - 5,00 Kies", True)]
    second = "2,10 - 3,40 Ton 3,90 - 5,00 Kies"
    assert compare("3,40", blocks, second) == Verdict("disagree", "3,90")
    # Printed only in a neighbouring block: the neighbour is never taken for the value.
    assert compare("2,10", blocks, second) == Verdict("unknown")


def test_tokens_normalise_numbers_case_and_minus() -> None:
    assert [t.canon for t in tokens("−1,5 m")] == [t.canon for t in tokens("-1.5M")]
    assert [t.canon for t in tokens("| a |")] == ["a"]  # table marks are layout, not text


def test_reading_value_follows_the_stored_type_and_unit() -> None:
    assert reading_value(1.2, "1,20", "1,70") == (True, 1.7)
    assert reading_value(1.2192, "4,0", "4,5") == (True, 1.3716)  # printed in feet, stored in metres
    assert reading_value(22, "22", "27") == (True, 27)
    assert reading_value(22, "22", "27,5") == (False, None)  # not a whole number
    assert reading_value("Sand", "Sand", "Sond") == (True, "Sond")
    assert reading_value("2025-03-13", "13.03.2025", "18.03.2025") == (False, None)  # not a plain copy
    assert reading_value(True, "50/12", "50/17") == (False, None)
    assert reading_value(4.5, "4,50", "four") == (False, None)


def test_crop_rect_adds_the_margin_and_a_minimum_size() -> None:
    rect = crop_rect((0.1, 0.5, 0.2, 0.001), 1000, 1000, margin=0.08, min_px=32)
    assert rect is not None
    left, top, right, bottom = rect
    assert (left, right) == (84, 316)  # 8 % of the width on each side
    assert bottom - top >= 32 and top <= 500 <= bottom  # widened around the box
    corner = crop_rect((0.0, 0.0, 0.01, 0.01), 1000, 1000, margin=0.08, min_px=32)
    assert corner is not None and corner[0] == 0 and corner[1] == 0  # clamped to the page


def test_blocks_of_a_crop_are_those_mostly_inside_it() -> None:
    line = ("0,00 - 0,80 Mutterboden", (0.05, 0.40, 0.50, 0.02))
    cell = ("0,80", (0.20, 0.40, 0.05, 0.02))
    neighbour = ("1,20", (0.20, 0.43, 0.05, 0.02))
    crop = (0.19, 0.39, 0.07, 0.04)  # around the cell, overlapping the next row a little
    found = blocks_in_crop([line, cell, neighbour], crop, cell[1], share=0.5)
    assert found == [("0,80", True)]  # a whole line around a tight box is not what the crop shows
    wide = blocks_in_crop([line], (0.04, 0.39, 0.52, 0.04), line[1], share=0.5)
    assert wide == [("0,00 - 0,80 Mutterboden", True)]


def test_field_labels_are_readable() -> None:
    config = reread_config()
    assert field_label("stratigraphy[2].depth_to_m", config) == "Layer 3, depth to (m)"
    assert field_label("metadata.borehole_id", config) == "Borehole label"
    assert field_label("metadata.surface_elevation_mASL", config) == "Surface elevation (m ASL)"


def test_batches_hold_at_most_the_batch_size() -> None:
    crop = PreparedCrop(key="k", png=b"", page=1, box=(0.0, 0.0, 1.0, 1.0), ocr_blocks=[])
    assert [len(b) for b in batches([crop] * 25, 20)] == [20, 5]


# ----------------------------------------------------------------------------------------------
# Fictional documents in the database
# ----------------------------------------------------------------------------------------------

pytestmark_db = pytest.mark.db


@dataclass(frozen=True)
class Layer:
    top: str
    base: str
    description: str


@dataclass(frozen=True)
class Hole:
    label: str
    layers: tuple[Layer, ...]
    page: int = 1
    # Path -> OCR confidence (default 0.97).
    confidence: tuple[tuple[str, float], ...] = ()


def _number(text: str) -> float:
    return float(text.replace(",", "."))


def _block(n: int, i: int, text: str, x: float, y: float, w: float, conf: float) -> dict[str, Any]:
    return {
        "id": f"p{n}.b{i}",
        "type": "text",
        "text": text,
        "box": [x, y, w, BOX_H],
        "confidence": conf,
        "min_confidence": conf,
        "table_id": None,
    }


def _layout(hole: Hole, first_row: int) -> list[tuple[str, str, float, float, float]]:
    """(path, printed text, x, y, w) of every value of a hole, one OCR block per value."""
    rows = [("metadata.borehole_id", hole.label, 0.05, 0.03 + first_row * ROW_STEP, 0.15)]
    for i, layer in enumerate(hole.layers):
        y = 0.03 + (first_row + 1 + i) * ROW_STEP
        rows.append((f"stratigraphy[{i}].depth_from_m", layer.top, 0.05, y, 0.07))
        rows.append((f"stratigraphy[{i}].depth_to_m", layer.base, 0.16, y, 0.07))
        rows.append((f"stratigraphy[{i}].original_description", layer.description, 0.3, y, 0.3))
    return rows


def _render(items: list[tuple[str, float, float]]) -> bytes:
    """A white page with every printed text at its place, plus a mark that makes each crop unique."""
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    draw = ImageDraw.Draw(image)
    for index, (text, x, y) in enumerate(items):
        draw.text((x * WIDTH + 2, y * HEIGHT + 4), text, fill="black")
        draw.rectangle(
            (x * WIDTH + 2, y * HEIGHT + 18, x * WIDTH + 4 + index % 40, y * HEIGHT + 19), fill="black"
        )
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


async def make_document(
    holes: list[Hole], *, handwriting: dict[int, str] | None = None, name: str = "fictional-log.pdf"
) -> tuple[str, dict[str, str]]:
    """A finished document (stage extract, needs_review) with its pages, OCR blocks and boreholes."""
    doc_id = new_id("doc")
    handwriting = handwriting or {}
    storage = get_storage()
    pages = sorted({h.page for h in holes})
    uids: dict[str, str] = {}
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=doc_id,
                file_name=name,
                project="Fictional Reread Site",
                sha256=hashlib.sha256(doc_id.encode()).hexdigest(),
                mime_type="application/pdf",
                size_bytes=1000,
                storage_key=f"originals/{doc_id}.pdf",
                status="needs_review",
                stage="extract",
                page_count=len(pages),
                progress={"boreholes_extracted": len(holes)},
            )
        )
        await session.flush()
        run_id = new_id("ocr")
        session.add(
            OcrRun(
                id=run_id,
                document_id=doc_id,
                provider="fake",
                model="fake-ocr",
                params_hash=hashlib.sha256(run_id.encode()).hexdigest(),
                pages=pages,
                status="done",
            )
        )
        layouts: dict[str, list[tuple[str, str, float, float, float]]] = {}
        for n in pages:
            on_page = [h for h in holes if h.page == n]
            blocks: list[dict[str, Any]] = []
            drawn: list[tuple[str, float, float]] = []
            row = 0
            for hole in on_page:
                layout = _layout(hole, row)
                layouts[hole.label] = layout
                row += len(hole.layers) + 2
                conf = dict(hole.confidence)
                for path, text, x, y, w in layout:
                    blocks.append(_block(n, len(blocks), text, x, y, w, conf.get(path, 0.97)))
                    drawn.append((text, x, y))
            storage.put_bytes(page_render_key(doc_id, n), _render(drawn))
            session.add(
                Page(
                    document_id=doc_id,
                    n=n,
                    width_px=WIDTH,
                    height_px=HEIGHT,
                    render_key=page_render_key(doc_id, n),
                    text_layer_quality=None,
                    role="log_sheet",
                    type="log",
                    handwriting=handwriting.get(n, "none"),
                    used=True,
                    ocr_status="done",
                    ocr_run_id=run_id,
                )
            )
            await session.flush()
            session.add(
                OcrPage(
                    document_id=doc_id,
                    n=n,
                    ocr_run_id=run_id,
                    markdown="\n\n".join(b["text"] for b in blocks),
                    tables=[],
                    blocks=blocks,
                    dimensions={"width": WIDTH, "height": HEIGHT},
                )
            )
        await session.flush()
        doc = await session.get(Document, doc_id)
        assert doc is not None
        for hole in holes:
            conf = dict(hole.confidence)
            body = {
                "metadata": {"borehole_id": hole.label},
                "stratigraphy": [
                    {
                        "depth_from_m": _number(layer.top),
                        "depth_to_m": _number(layer.base),
                        "original_description": layer.description,
                    }
                    for layer in hole.layers
                ],
            }
            provenance = {
                path: ProvenanceIn(
                    document_id=doc_id,
                    page=hole.page,
                    box=[x, y, w, BOX_H],
                    raw=text,
                    method="ocr",
                    confidence=conf.get(path, 0.97),
                )
                for path, text, x, y, w in layouts[hole.label]
            }
            bh = await create_borehole(
                session,
                document=doc,
                group_key=f"{hole.label}:p{hole.page}",
                body=body,
                provenance=provenance,
                crs_status="unknown",
                pages=[hole.page],
            )
            uids[hole.label] = bh.uid
        await session.commit()
    return doc_id, uids


async def values(uid: str) -> dict[str, FieldValue]:
    async with get_sessionmaker()() as session:
        rows = (await session.scalars(select(FieldValue).where(FieldValue.uid == uid))).all()
    return {fv.path: fv for fv in rows}


async def borehole(uid: str) -> Borehole:
    async with get_sessionmaker()() as session:
        bh = await session.get(Borehole, uid)
        assert bh is not None
        return bh


async def questions(document_id: str) -> list[Clarification]:
    async with get_sessionmaker()() as session:
        rows = (
            await session.scalars(
                select(Clarification)
                .where(Clarification.document_id == document_id)
                .order_by(Clarification.created_at, Clarification.id)
            )
        ).all()
    return list(rows)


async def revisions(uid: str) -> list[Revision]:
    async with get_sessionmaker()() as session:
        rows = (
            await session.scalars(select(Revision).where(Revision.uid == uid).order_by(Revision.revision))
        ).all()
    return list(rows)


async def event_count(document_id: str) -> int:
    async with get_sessionmaker()() as session:
        value = await session.scalar(
            select(func.count()).select_from(Event).where(Event.document_id == document_id)
        )
    return int(value or 0)


@pytest.fixture
def settings_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    def set_env(**items: str) -> None:
        for key, value in items.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()

    yield set_env
    monkeypatch.undo()
    get_settings.cache_clear()


@pytest.fixture
def no_real_reader(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real OpenRouter reader must never be built in these tests."""

    def refuse() -> None:
        raise AssertionError("the real second reader was built")

    monkeypatch.setattr(reread_module, "OpenRouterRereader", refuse)


HOLE_A = Hole(
    "RX-1",
    (
        Layer("0,00", "1,20", "Mutterboden"),
        Layer("1,20", "3,40", "Kies, sandig"),
        Layer("3,40", "6,00", "Ton, steif"),
    ),
)
HOLE_B = Hole("RX-2", (Layer("0,00", "0,60", "Auffüllung"), Layer("0,60", "2,80", "Schluff, tonig")), page=2)


# ----------------------------------------------------------------------------------------------
# Agreement
# ----------------------------------------------------------------------------------------------


@pytestmark_db
async def test_agreement_raises_confidence_and_keeps_the_value_unreviewed(
    db: None, no_real_reader: None
) -> None:
    low = Hole(HOLE_A.label, HOLE_A.layers, confidence=(("stratigraphy[1].depth_to_m", 0.5),))
    doc_id, uids = await make_document([low])
    reader = FakeRereader()

    summary = await stage_reread(doc_id, reader)

    assert (summary.candidates, summary.crops, summary.calls, summary.failed) == (1, 1, 1, None)
    assert reader.batches == [1] and reader.crops[0].ocr_text == "3,40"
    fvs = await values(uids["RX-1"])
    target = fvs["stratigraphy[1].depth_to_m"]
    assert target.confidence == pytest.approx(0.9)  # the second read's "clear"
    assert (target.status, target.readings, target.value) == ("unreviewed", [], 3.4)
    assert fvs["stratigraphy[1].depth_from_m"].confidence == pytest.approx(0.97)  # not a candidate
    bh = await borehole(uids["RX-1"])
    assert bh.revision == 2 and bh.review_status == "unreviewed"
    last = (await revisions(uids["RX-1"]))[-1]
    assert (last.actor, last.action) == ("pipeline", "reread")
    assert last.changes["agreed"] == {"stratigraphy[1].depth_to_m": {"before": 0.5, "after": 0.9}}
    assert await questions(doc_id) == []
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        assert doc is not None and doc.status == "needs_review"
        assert doc.progress == {"boreholes_extracted": 1}  # progress unchanged


# ----------------------------------------------------------------------------------------------
# Disagreement: readings and one question per borehole
# ----------------------------------------------------------------------------------------------


@pytestmark_db
async def test_disagreement_stores_readings_and_asks_once_per_borehole(
    db: None, no_real_reader: None
) -> None:
    doc_id, uids = await make_document([HOLE_A, HOLE_B], handwriting={1: "partial", 2: "full"})
    changed = {"3,40": "3,90", "Ton, steif": "Ton, steil", "2,80": "2,30"}
    reader = FakeRereader(replace=changed)

    summary = await stage_reread(doc_id, reader)

    # Every value on a handwritten page is read again: 1 label + 3 values per layer, per borehole.
    assert summary.candidates == (1 + 3 * 3) + (1 + 3 * 2)
    # "3,40" is printed twice (base of layer 2, top of layer 3): both disagree.
    assert summary.disagreed == 4 and summary.questions == 2 and summary.failed is None
    a = await values(uids["RX-1"])
    assert a["stratigraphy[1].depth_to_m"].readings == [
        {"reader": "ocr", "text": "3,40", "confidence": 0.97},
        {"reader": "reread", "text": "3,90", "confidence": 0.9},
    ]
    for path in (
        "stratigraphy[1].depth_to_m",
        "stratigraphy[2].depth_from_m",
        "stratigraphy[2].original_description",
    ):
        assert a[path].status == "unreviewed" and a[path].method == "ocr"
    assert a["stratigraphy[1].depth_to_m"].value == 3.4  # unchanged
    assert a["stratigraphy[2].original_description"].value == "Ton, steif"
    assert a["stratigraphy[0].depth_to_m"].readings == []  # agreed
    assert a["stratigraphy[0].depth_to_m"].confidence == pytest.approx(0.97)  # already higher

    by_uid = {q.borehole_uids[0]: q for q in await questions(doc_id)}
    assert sorted(by_uid) == sorted(uids.values())
    for row in by_uid.values():
        assert row.kind == "choose_reading" and row.status == "open"
        validate_schema(clarification_out(row).model_dump(mode="json"), "Clarification")
    many = by_uid[uids["RX-1"]]
    assert many.path is None  # several values: each field is named by its path
    assert [f["name"] for f in many.fields] == [
        "stratigraphy[1].depth_to_m",
        "stratigraphy[2].depth_from_m",
        "stratigraphy[2].original_description",
    ]
    first = many.fields[0]
    assert first["widget"] == "choose_reading" and first["required"] is True
    assert first["label"] == "Layer 2, depth to (m)"
    assert [(o["value"], o["label"]) for o in first["options"]] == [
        (3.4, "3,40 (OCR, confidence 0.97)"),
        (3.9, "3,90 (second read, confidence 0.90)"),
    ]
    box = a["stratigraphy[1].depth_to_m"].box
    assert [
        (o["evidence"]["page"], o["evidence"]["box"], o["evidence"]["snippet"]) for o in first["options"]
    ] == [
        (1, box, "3,40"),
        (1, box, "3,90"),
    ]
    assert many.fields[2]["options"][1]["value"] == "Ton, steil"
    assert {(e["page"], tuple(e["box"])) for e in many.evidence} == {
        (1, tuple(a[p].box))
        for p in (
            "stratigraphy[1].depth_to_m",
            "stratigraphy[2].depth_from_m",
            "stratigraphy[2].original_description",
        )
    }
    assert "RX-1" in many.question

    one = by_uid[uids["RX-2"]]
    assert one.path == "stratigraphy[1].depth_to_m" and [f["name"] for f in one.fields] == ["reading"]
    assert [o["value"] for o in one.fields[0]["options"]] == [2.8, 2.3]
    assert (await borehole(uids["RX-2"])).revision == 2

    # Answering the single-value question edits and approves the chosen reading (app.clarify.answers).
    async with get_sessionmaker()() as session:
        await answer_clarification(session, one.id, {"reading": 2.3}, "fictional-reviewer")
        await session.commit()
    b = await values(uids["RX-2"])
    chosen = b["stratigraphy[1].depth_to_m"]
    assert (chosen.value, chosen.status, chosen.method, chosen.ai_value) == (2.3, "approved", "edited", 2.8)


@pytestmark_db
async def test_illegible_reads_add_nothing_and_unusable_readings_ask_nothing(
    db: None, no_real_reader: None
) -> None:
    doc_id, uids = await make_document([HOLE_A], handwriting={1: "full"})

    def rule(crop: Any) -> tuple[str | None, str]:
        if crop.ocr_text == "1,20":
            return None, "illegible"
        if crop.ocr_text == "0,00":
            return "O,OO", "unsure"  # letters where the OCR read digits: not a number
        return crop.ocr_text, "clear"

    summary = await stage_reread(doc_id, FakeRereader(rule=rule))

    assert summary.calls == 1 and summary.disagreed == 1 and summary.questions == 0
    fvs = await values(uids["RX-1"])
    assert fvs["stratigraphy[0].depth_from_m"].readings == [
        {"reader": "ocr", "text": "0,00", "confidence": 0.97},
        {"reader": "reread", "text": "O,OO", "confidence": 0.6},
    ]
    assert fvs["stratigraphy[0].depth_from_m"].value == 0.0
    assert (
        fvs["stratigraphy[0].depth_to_m"].readings == []
        and fvs["stratigraphy[1].depth_from_m"].readings == []
    )
    # Both readings stay in the provenance for the reviewer; no form field can offer "O,OO" as a depth.
    assert await questions(doc_id) == [] and (await borehole(uids["RX-1"])).revision == 2


@pytestmark_db
async def test_reviewed_values_are_not_read_again(db: None, no_real_reader: None) -> None:
    doc_id, uids = await make_document([HOLE_B], handwriting={2: "full"})
    async with get_sessionmaker()() as session:
        rows = (await session.scalars(select(FieldValue).where(FieldValue.uid == uids["RX-2"]))).all()
        for fv in rows:
            fv.status = "approved"
        await session.commit()
    reader = FakeRereader(replace={"2,80": "2,30"})

    summary = await stage_reread(doc_id, reader)

    assert summary.candidates == 0 and reader.calls == 0 and await questions(doc_id) == []


# ----------------------------------------------------------------------------------------------
# Batching, reruns, failures
# ----------------------------------------------------------------------------------------------


def _many_layers(count: int) -> tuple[Layer, ...]:
    return tuple(
        Layer(f"{i},{i:02d}", f"{i + 1},{i + 50:02d}", f"Fiktiv Schicht {chr(65 + i)}") for i in range(count)
    )


@pytestmark_db
async def test_twenty_five_crops_go_in_two_calls(db: None, no_real_reader: None) -> None:
    doc_id, _ = await make_document([Hole("RX-9", _many_layers(8))], handwriting={1: "partial"})
    reader = FakeRereader()

    summary = await stage_reread(doc_id, reader)

    assert summary.crops == 25 and summary.calls == 2 and reader.batches == [20, 5]
    async with get_sessionmaker()() as session:
        runs = (await session.scalars(select(ExtractionRun).where(ExtractionRun.document_id == doc_id))).all()
    assert sorted(len(r.output["reads"]) for r in runs if r.output) == [5, 20]
    assert {(r.group_id, r.status, r.model) for r in runs} == {(f"reread:{doc_id}", "done", "fake-rereader")}


@pytestmark_db
async def test_rerun_pays_nothing_and_adds_no_question(db: None, no_real_reader: None) -> None:
    doc_id, uids = await make_document([HOLE_A], handwriting={1: "partial"})
    reader = FakeRereader(replace={"6,00": "8,00"}, cost_usd=0.002)
    await stage_reread(doc_id, reader)
    calls, events_before = reader.calls, await event_count(doc_id)
    revision = (await borehole(uids["RX-1"])).revision
    assert calls == 1 and revision == 2 and len(await questions(doc_id)) == 1

    again = await stage_reread(doc_id, reader)

    assert reader.calls == calls and again.calls == 0 and again.cached == again.crops > 0
    assert len(await questions(doc_id)) == 1
    assert (await borehole(uids["RX-1"])).revision == revision
    assert await event_count(doc_id) == events_before
    async with get_sessionmaker()() as session:
        spent = await session.scalar(select(func.sum(ProviderCall.cost_usd)))
    assert spent == pytest.approx(0.002)  # one paid call in the ledger


@pytestmark_db
async def test_provider_failure_leaves_the_values_unchanged(db: None, no_real_reader: None) -> None:
    low = Hole(HOLE_A.label, HOLE_A.layers, confidence=(("stratigraphy[0].depth_to_m", 0.4),))
    doc_id, uids = await make_document([low], handwriting={1: "partial"})
    before = {p: (fv.value, fv.confidence, fv.status) for p, fv in (await values(uids["RX-1"])).items()}
    failing = FakeRereader(
        replace={"1,20": "1,70"}, fail=ProviderError("OpenRouter did not answer in time.", retryable=True)
    )

    summary = await stage_reread(doc_id, failing)

    assert summary.failed == "OpenRouter did not answer in time." and failing.calls == 1
    after = await values(uids["RX-1"])
    assert {p: (fv.value, fv.confidence, fv.status) for p, fv in after.items()} == before
    assert all(fv.readings == [] for fv in after.values())
    assert await questions(doc_id) == [] and (await borehole(uids["RX-1"])).revision == 1
    async with get_sessionmaker()() as session:
        runs = (await session.scalars(select(ExtractionRun).where(ExtractionRun.document_id == doc_id))).all()
    assert [(r.status, r.error) for r in runs] == [("failed", "OpenRouter did not answer in time.")]

    # A later run reads them (the failed call cached nothing).
    working = FakeRereader(replace={"1,20": "1,70"})
    assert (await stage_reread(doc_id, working)).calls == 1
    assert len(await questions(doc_id)) == 1


@pytestmark_db
async def test_budget_stops_second_reads_without_failing(
    db: None, no_real_reader: None, settings_env: Any
) -> None:
    doc_id, uids = await make_document([HOLE_B], handwriting={2: "partial"})
    async with get_sessionmaker()() as session:
        session.add(ProviderCall(provider="fake", purpose="extract", model="fake-extractor", cost_usd=2.0))
        await session.commit()
    settings_env(PROVIDER_BUDGET_USD="1")
    reader = FakeRereader(replace={"2,80": "2,30"}, cost_usd=0.01)

    summary = await stage_reread(doc_id, reader)

    assert summary.failed is not None and "budget" in summary.failed and reader.calls == 0
    assert await questions(doc_id) == [] and (await borehole(uids["RX-2"])).revision == 1


@pytestmark_db
async def test_no_candidates_means_no_crops_and_no_reader(db: None, no_real_reader: None) -> None:
    doc_id, uids = await make_document([HOLE_A])  # printed, confident: nothing to read again

    summary = await stage_reread(doc_id)

    assert (summary.candidates, summary.crops, summary.calls, summary.failed) == (0, 0, 0, None)
    assert (await borehole(uids["RX-1"])).revision == 1
