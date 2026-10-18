"""Positions and depths a document's own tables print (app.pipeline.table_rows, app.pipeline.positions), the
hemisphere of a zone printed without one (app.normalize.crs) and the confidence of handwritten values without
an OCR confidence (app.pipeline.provenance). Fictional labels, values and pages."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from app.db.models import Revision
from app.db.session import get_sessionmaker
from app.normalize import coordinates as coordinates_parser
from app.normalize import crs as crs_parser
from app.pipeline.finalize import finalize_group
from app.pipeline.identity import Reconciled, _id_pattern
from app.pipeline.positions import TableIndex, apply_tables, sheet_position
from app.pipeline.provenance import lowest_confidence
from app.pipeline.schemas import RawCoordinates, RawValue
from app.pipeline.table_rows import TableRow, Token, read_rows
from app.pipeline.types import BlockRef
from tests.test_finalize import make_document, record_of
from tests.test_identity import pair

# ----------------------------------------------------------------------------------------------
# A zone printed without its hemisphere
# ----------------------------------------------------------------------------------------------


def _resolve(system: str, x: str, y: str) -> Any:
    return crs_parser.resolve_printed_system(system, coordinates_parser.parse_coordinates(x, y, None, None))


def test_the_hemisphere_of_a_zone_comes_from_the_one_reading_on_land() -> None:
    found = _resolve("WGS 84 UTM zone 32", "512000", "5016000")  # northern reading on land, southern at sea
    assert found.code == "EPSG:32632" and "only the northern reading" in (found.reason or "")
    assert _resolve("WGS 84, UTM Sone: 32", "0512000", "5016000").code == "EPSG:32632"
    # both readings lie on land: still not stated
    assert _resolve("WGS 84 UTM zone 33", "500000", "7500000").code is None
    # values that fit no reading (a digit too many): not stated
    assert _resolve("WGS 84 UTM zone 32", "05120001", "50160001").code is None


# ----------------------------------------------------------------------------------------------
# Reading table rows
# ----------------------------------------------------------------------------------------------


def tok(i: int, text: str, x: float, y: float, w: float = 0.06) -> Token:
    return Token(f"p9.w{i}", text, (x, y, w, 0.012))


TABLE = [
    tok(0, "Point", 0.05, 0.10),
    tok(1, "X-coordinate", 0.25, 0.10, 0.1),
    tok(2, "Y-coordinate", 0.40, 0.10, 0.1),
    tok(3, "Total", 0.60, 0.10, 0.04),
    tok(4, "depth", 0.65, 0.10, 0.04),
    tok(10, "BH", 0.05, 0.14, 0.02),
    tok(11, "1", 0.08, 0.14, 0.01),
    tok(12, "a", 0.10, 0.14, 0.01),
    tok(13, "1200,5", 0.27, 0.14),
    tok(14, "3400", 0.42, 0.14),
    tok(15, "12,5", 0.63, 0.14),
    tok(20, "BH", 0.05, 0.18, 0.02),
    tok(21, "1", 0.08, 0.18, 0.01),
    tok(22, "b", 0.10, 0.18, 0.01),
    tok(23, "1204", 0.27, 0.18),
    tok(24, "3401,5", 0.42, 0.18),
    tok(25, "notes", 0.80, 0.18),
    tok(30, "Coordinates:", 0.05, 0.90, 0.1),
    tok(31, "Fictional", 0.20, 0.90, 0.08),
    tok(32, "local,", 0.30, 0.90, 0.05),
    tok(33, "height", 0.38, 0.90, 0.05),
]


def test_a_table_row_gives_each_borehole_its_coordinates_depth_and_system() -> None:
    rows = read_rows(9, TABLE, {"BH1": "BH 1", "BH1B": "BH 1 b"}, _id_pattern)
    first, second = rows["BH1"], rows["BH1B"]  # "BH 1 b" is BH1B (the longest ID), "BH 1 a" is BH1
    assert (first.x.text, first.y.text, first.total_depth.text) == ("1200,5", "3400", "12,5")  # type: ignore[union-attr]
    assert (second.x.text, second.y.text, second.total_depth) == ("1204", "3401,5", None)  # type: ignore[union-attr]
    assert [t.text for t in first.axis_labels] == ["X-coordinate", "Y-coordinate"]
    assert [t.text for t in first.system] == ["Fictional", "local,"]
    assert read_rows(9, TABLE[5:], {"BH1": "BH 1"}, _id_pattern) == {}  # no heading row: nothing is read


# ----------------------------------------------------------------------------------------------
# Choosing between a sheet's position and the table's
# ----------------------------------------------------------------------------------------------


def raw(text: str | None) -> RawValue:
    return RawValue.absent() if text is None else RawValue(raw=text, block_ids=[], state="ok")


def coords(x: str | None, y: str | None, system: str | None = None) -> RawCoordinates:
    return RawCoordinates(
        x_raw=raw(x), y_raw=raw(y), labels_raw=raw("E, N" if x else None), system_raw=raw(system)
    )


def test_how_far_a_sheet_position_is_trusted() -> None:
    utm = "WGS 84 UTM zone 32"
    assert sheet_position(coords(None, None)).kind == "missing"
    assert sheet_position(coords("1200,5", "34a0,5")).kind == "unreadable"
    assert sheet_position(coords("05120001", "50160001", utm)).kind == "misfit"  # a digit too many
    assert sheet_position(coords("512000", "5016000", utm)).kind == "world"
    assert sheet_position(coords("1200,5", "3400", "Fictional local")).kind == "local"


def item(
    label: str, x: str | None, y: str | None, system: str | None, depth: str | None = None
) -> Reconciled:
    group, outcome = pair(label, (1,), [])
    header = outcome.result.header.model_copy(
        update={"coordinates": coords(x, y, system), "total_depth": raw(depth)}
    )
    result = outcome.result.model_copy(update={"header": header})
    return Reconciled(group, outcome.__class__(**{**outcome.__dict__, "result": result}), [])


def table(rows: dict[str, tuple[str, str, str | None]]) -> TableIndex:
    out: dict[str, TableRow] = {}
    blocks: dict[str, BlockRef] = {}
    heads = (Token("p9.h1", "X", (0.2, 0.1, 0.02, 0.01)), Token("p9.h2", "Y", (0.4, 0.1, 0.02, 0.01)))
    system = (
        Token("p9.s1", "Fictional", (0.1, 0.9, 0.1, 0.01)),
        Token("p9.s2", "local", (0.2, 0.9, 0.1, 0.01)),
    )
    for i, (label, (x, y, depth)) in enumerate(rows.items()):
        cells = [Token(f"p9.c{i}x", x, (0.2, 0.2, 0.05, 0.01)), Token(f"p9.c{i}y", y, (0.4, 0.2, 0.05, 0.01))]
        depth_token = Token(f"p9.c{i}d", depth, (0.6, 0.2, 0.05, 0.01)) if depth else None
        out[label] = TableRow(label, 9, cells[0], cells[1], heads, system, depth_token)
        for t in (*cells, *heads, *system, *([depth_token] if depth_token else [])):
            blocks[t.id] = BlockRef(t.id, 9, t.text, t.box, 1.0, 1.0, "none")
    return TableIndex(out, blocks)


def test_a_sheet_without_or_with_unfit_coordinates_takes_the_table_position() -> None:
    index = table(
        {"B1": ("1200,5", "3400", None), "B2": ("1210", "3405", None), "B3": ("1220", "3410", None)}
    )
    missing = item("B1", None, None, None)
    misread = item("B2", "05120001", "50160001", "WGS 84 UTM zone 32")
    local = item("B3", "1220", "3410", "Fictional local")
    (b1, a1), (b2, a2), (b3, a3) = apply_tables([missing, misread, local], index)
    c1 = b1.outcome.result.header.coordinates
    assert (c1.x_raw.raw, c1.y_raw.raw, c1.system_raw.raw) == ("1200,5", "3400", "Fictional local")
    assert c1.x_raw.block_ids == ["p9.c0x"] and "p9.c0x" in b1.outcome.blocks  # cited to the table cell
    assert a1.notes and "prints no coordinates" in a1.notes[0] and not a1.readings
    assert b2.outcome.result.header.coordinates.x_raw.raw == "1210"
    assert a2.readings["metadata.coordinates.x_raw"][0]["text"].startswith("05120001 / 50160001")
    assert "do not fit the system it names" in a2.notes[0]
    assert b3 is local and a3.notes == []  # a readable local position stays as printed


def test_a_sheet_position_that_disagrees_with_most_others_takes_the_table_position() -> None:
    # three boreholes printed in a map system; on the table they lie 30 m apart, on the sheets the third
    # lies tens of kilometres away (a misread digit)
    index = table({"B1": ("1000", "2000", None), "B2": ("1030", "2000", None), "B3": ("1000", "2030", None)})
    utm = "WGS 84 UTM zone 32"
    items = [
        item("B1", "512000", "5016000", utm),
        item("B2", "512030", "5016000", utm),
        item("B3", "512000", "4986030", utm),
    ]
    (b1, a1), (b2, _), (b3, a3) = apply_tables(items, index)
    assert b1 is items[0] and b2 is items[1] and a1.notes == []
    assert b3.outcome.result.header.coordinates.x_raw.raw == "1000"
    assert "disagrees with the other boreholes" in a3.notes[0]
    assert a3.readings["metadata.coordinates.y_raw"][0]["text"].startswith("512000 / 4986030")
    # with two, nothing tells which one is wrong: both stay
    pairs = apply_tables(items[1:], table({"B2": ("1030", "2000", None), "B3": ("1000", "2030", None)}))
    assert [b for b, _ in pairs] == items[1:]


def test_a_total_depth_printed_differently_in_the_table_is_flagged_and_a_missing_one_filled() -> None:
    index = table({"B1": ("1000", "2000", "68"), "B2": ("1030", "2000", "43")})
    conflicting = item("B1", "1000", "2000", "Fictional local", depth="61")
    missing = item("B2", "1030", "2000", "Fictional local")
    (b1, a1), (b2, a2) = apply_tables([conflicting, missing], index)
    assert b1.outcome.result.header.total_depth.raw == "61"  # the sheet's value stays
    assert "prints 68" in a1.flags["metadata.borehole_depth_m"]
    assert [r["text"] for r in a1.readings["metadata.borehole_depth_m"]] == ["61", "68"]
    assert b2.outcome.result.header.total_depth.raw == "43" and a2.flags == {}


# ----------------------------------------------------------------------------------------------
# Handwriting without an OCR confidence
# ----------------------------------------------------------------------------------------------


def test_a_handwritten_value_without_a_confidence_is_below_the_review_threshold() -> None:
    def block(confidence: float | None, handwriting: str | None) -> BlockRef:
        return BlockRef("p1.b1", 1, "12,5", (0.1, 0.1, 0.1, 0.02), confidence, None, handwriting)

    assert lowest_confidence([block(None, "full")]) == pytest.approx(0.6)
    assert lowest_confidence([block(None, "partial")]) == pytest.approx(0.6)
    assert lowest_confidence([block(0.92, "full")]) == pytest.approx(0.92)  # its own confidence stands
    assert lowest_confidence([block(None, "none")]) is None
    assert lowest_confidence([block(None, "annotations")]) is None


# ----------------------------------------------------------------------------------------------
# Finalisation keeps the notes, flags and second readings
# ----------------------------------------------------------------------------------------------

DOC = "doc_01JTABLEPOS0000000000000001"


@pytest.mark.db
async def test_finalisation_flags_values_and_keeps_second_readings_and_notes(db: None) -> None:
    from tests.test_finalize import DE_BLOCKS, DE_GROUP, de_result, outcome

    await make_document(DOC, pages={2: ("log_sheet", ["KB 3"], 0.95), 3: ("log_continuation", [], 0.4)})
    flag = "the table on page 9 prints 6,40 as this borehole's total depth; the log sheet prints 6,00 m"
    uid = await finalize_group(
        DOC,
        DE_GROUP,
        outcome(de_result(), DE_BLOCKS),
        notes=["a fictional note"],
        flags={"metadata.borehole_depth_m": flag},
        readings={"metadata.borehole_depth_m": [{"reader": "table", "text": "6,40", "confidence": None}]},
    )
    assert uid is not None
    rec = await record_of(uid)
    depth = rec.provenance["metadata.borehole_depth_m"]
    assert (depth.status, depth.flag) == ("flagged", flag)
    assert [(r.reader, r.text) for r in depth.readings] == [("table", "6,40")]
    async with get_sessionmaker()() as session:
        first = await session.scalar(select(Revision).where(Revision.uid == uid, Revision.revision == 1))
    assert first is not None and "a fictional note" in first.changes["notes"]


def test_ocr_noise_in_a_table_cell_is_not_a_number() -> None:
    from app.pipeline.table_rows import number_of

    def cell(text: str) -> Token:
        return Token("p9.w1", text, (0.0, 0.0, 0.1, 0.01))

    assert [number_of(cell(t)) for t in ("4892,5", "68", "3 170,5", "54 m")] == [4892.5, 68.0, 3170.5, 54.0]
    assert [number_of(cell(t)) for t in ("4a", "3C", "2875,a", "nr 5")] == [None, None, None, None]
