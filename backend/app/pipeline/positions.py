"""Positions and total depths from the document's own tables when a log sheet's are missing or not trusted.

Reports often print every borehole's position (and depth) in a summary or coordinate table besides the log
sheets. After the boreholes of a document are known (app.pipeline.identity), each one's row of those tables
is read without a model (app.pipeline.table_rows), and:

- a sheet that prints no coordinates, coordinates that cannot be read, or values that do not fit the system it
  names (a handwritten digit too many, a point outside the zone) takes the table's position, cited to the
  table cells; the sheet's own reading is kept as a second reading for review and in a note;
- sheet positions in a map system are checked against the table: boreholes whose distance apart differs
  between the sheets and the table disagree, and a sheet position that disagrees with most of the others is
  not trusted (the same treatment);
- a total depth printed differently on the sheet and in the table keeps the sheet's value, flagged for review
  with the table's value as a second reading; a sheet without one takes the table's.

Nothing is guessed: every position and depth is printed in the document. Thresholds are data
(data/tables.yaml).
"""

from __future__ import annotations

import json
import logging
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from functools import lru_cache
from typing import Any, Literal

from sqlalchemy import select

from app.db.models import OcrPage, Page
from app.db.session import get_sessionmaker
from app.geo.crs_candidates import haversine_km, inside_area_of_use
from app.geo.plotting import to_wgs84
from app.normalize import coordinates as coordinates_parser
from app.normalize import crs as crs_parser
from app.normalize.numbers import load_data, parse_number
from app.pipeline import textlayer
from app.pipeline.provenance import handwriting_levels, printed
from app.pipeline.schemas import RawCoordinates, RawValue
from app.pipeline.table_rows import TableRow, Token, number_of, read_rows
from app.pipeline.types import BlockRef
from app.review.service import canonical_label
from app.storage import get_storage

logger = logging.getLogger("geomemory.pipeline.positions")

TABLE_ROLES = ("coordinate_table", "summary_table")  # in this order of trust
DEPTH_PATH = "metadata.borehole_depth_m"
SheetKind = Literal["missing", "unreadable", "misfit", "world", "local", "unknown"]


@dataclass
class Adjusted:
    """What finalisation adds to a borehole from the tables: notes, review flags and second readings."""

    notes: list[str] = field(default_factory=list)
    flags: dict[str, str] = field(default_factory=dict)
    readings: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


@dataclass(frozen=True)
class TableIndex:
    rows: dict[str, TableRow]
    blocks: dict[str, BlockRef]


@dataclass(frozen=True)
class Sheet:
    kind: SheetKind
    texts: str  # the sheet's printed coordinates and system, for notes
    wgs: tuple[float, float] | None = None  # (lat, lon) of a sheet position in a map system


@lru_cache(maxsize=1)
def _tolerance() -> tuple[float, float]:
    data = load_data("tables.yaml")
    return float(data.get("distance_tolerance_m") or 25.0), float(data.get("distance_tolerance_share") or 0.1)


# ----------------------------------------------------------------------------------------------
# Loading the table pages
# ----------------------------------------------------------------------------------------------


def _text_layer_tokens(page: Page) -> list[Token] | None:
    if (
        page.text_layer_key is None
        or (page.text_layer_quality or 0.0) < textlayer.config().read_min_text_quality
    ):
        return None
    try:
        payload = json.loads(get_storage().get_bytes(page.text_layer_key))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    text = textlayer.page_text_from_payload(page.n, payload)
    return [Token(f"p{page.n}.w{w.index}", w.text, tuple(w.box)) for w in text.words]  # type: ignore[arg-type]


def _ocr_tokens(n: int, ocr: OcrPage | None) -> list[Token]:
    out: list[Token] = []
    for i, block in enumerate((ocr.blocks if ocr else None) or []):
        box = block.get("box") if isinstance(block, dict) else None
        text = str(block.get("text") or "").strip() if isinstance(block, dict) else ""
        if text and isinstance(box, list | tuple) and len(box) == 4:
            out.append(Token(str(block.get("id") or f"p{n}.b{i}"), text, tuple(float(v) for v in box)))  # type: ignore[arg-type]
    return out


async def load_tables(document_id: str, ids: Mapping[str, str]) -> TableIndex:
    """The table rows of the document's coordinate and summary tables by canonical ID (`ids`: the document's
    boreholes, canonical -> as named), with citable blocks for the cells used."""
    if not ids:
        return TableIndex({}, {})
    async with get_sessionmaker()() as session:
        pages = (
            await session.scalars(
                select(Page).where(
                    Page.document_id == document_id, Page.used.is_(True), Page.role.in_(TABLE_ROLES)
                )
            )
        ).all()
        ocr = {
            o.n: o
            for o in (
                await session.scalars(
                    select(OcrPage).where(
                        OcrPage.document_id == document_id, OcrPage.n.in_([p.n for p in pages])
                    )
                )
            ).all()
        }
    from app.pipeline.identity import _id_pattern

    rows: dict[str, TableRow] = {}
    blocks: dict[str, BlockRef] = {}
    for page in sorted(pages, key=lambda p: (TABLE_ROLES.index(p.role or "summary_table"), p.n)):
        tokens = _text_layer_tokens(page) or _ocr_tokens(page.n, ocr.get(page.n))
        handwritten = page.handwriting in handwriting_levels()
        for label, row in read_rows(page.n, tokens, ids, _id_pattern).items():
            kept = rows.get(label)
            if kept is None:
                rows[label] = row
            elif kept.total_depth is None and row.total_depth is not None:
                rows[label] = replace(kept, total_depth=row.total_depth)
            else:
                continue
            for token in (row.x, row.y, row.total_depth, *row.axis_labels, *row.system):
                if token is not None:
                    blocks[token.id] = BlockRef(
                        id=token.id,
                        page=page.n,
                        text=token.text,
                        box=token.box,
                        confidence=None if handwritten else 1.0,
                        page_text_quality=page.text_layer_quality,
                        page_handwriting=page.handwriting,
                    )
    # a table page that does not name its system shares the one another table page of the document names
    named = next((row.system for row in rows.values() if row.system), ())
    if named:
        rows = {label: row if row.system else replace(row, system=named) for label, row in rows.items()}
        for token in named:
            if token.id not in blocks:
                page_n = int(token.id[1:].split(".")[0])
                page = next(p for p in pages if p.n == page_n)
                blocks[token.id] = BlockRef(
                    id=token.id,
                    page=page.n,
                    text=token.text,
                    box=token.box,
                    confidence=1.0,
                    page_text_quality=page.text_layer_quality,
                    page_handwriting=page.handwriting,
                )
    return TableIndex(rows, blocks)


# ----------------------------------------------------------------------------------------------
# Deciding
# ----------------------------------------------------------------------------------------------


def sheet_position(coords: RawCoordinates) -> Sheet:
    """How far the sheet's own printed coordinates can be trusted."""
    x, y = printed(coords.x_raw), printed(coords.y_raw)
    system = printed(coords.system_raw)
    texts = " / ".join(t for t in (x, y) if t) + (f" ({system})" if system else "")
    if x is None or y is None:
        return Sheet("missing", texts)
    parsed = coordinates_parser.parse_coordinates(x, y, printed(coords.labels_raw), None)
    if parsed.kind == "projected" and parsed.local_x is not None and parsed.local_y is not None:
        point = (parsed.local_x, parsed.local_y)
    elif parsed.kind == "geographic" and parsed.longitude is not None and parsed.latitude is not None:
        point = (parsed.longitude, parsed.latitude)
    else:
        return Sheet("unreadable", texts)
    if crs_parser.map_sheet(system):
        system = None
    if crs_parser.local_grid(system, parsed) is not None:
        return Sheet("local", texts)
    code = crs_parser.resolve_printed_system(system, parsed).code
    if code is not None and inside_area_of_use(code, *point):
        wgs = to_wgs84(code, *point)
        return Sheet("world", texts, wgs)
    if system and crs_parser.names_a_system(system):
        return Sheet("misfit", texts)  # a named system the printed values do not fit
    return Sheet("unknown", texts)


def _disagree(a: Sheet, b: Sheet, ra: TableRow, rb: TableRow) -> bool:
    xa, ya, xb, yb = number_of(ra.x), number_of(ra.y), number_of(rb.x), number_of(rb.y)
    if None in (xa, ya, xb, yb) or a.wgs is None or b.wgs is None:
        return False
    table = math.hypot(xa - xb, ya - yb)  # type: ignore[operator]
    world = haversine_km(a.wgs[0], a.wgs[1], b.wgs[0], b.wgs[1]) * 1000.0
    metres, share = _tolerance()
    return abs(world - table) > max(metres, share * table)


def _cite(token: Token) -> RawValue:
    return RawValue(raw=token.text, block_ids=[token.id], state="ok")


def _cite_all(tokens: Sequence[Token]) -> RawValue:
    """Several words as one value (a system name), without the punctuation that ends a phrase."""
    text = " ".join(t.text for t in tokens).strip(" ,.;:")
    if not text:
        return RawValue.absent()
    return RawValue(raw=text, block_ids=[t.id for t in tokens], state="ok")


def _reading(text: str) -> dict[str, Any]:
    return {"reader": "sheet", "text": text, "confidence": None}


def position_from_table(result: Any, row: TableRow) -> RawCoordinates | None:
    if row.x is None or row.y is None:
        return None
    labels = RawValue(
        raw=", ".join(t.text for t in row.axis_labels), block_ids=[t.id for t in row.axis_labels], state="ok"
    )
    return RawCoordinates(
        x_raw=_cite(row.x), y_raw=_cite(row.y), labels_raw=labels, system_raw=_cite_all(row.system)
    )


WHY = {
    "missing": "prints no coordinates",
    "unreadable": "prints coordinates that cannot be read",
    "misfit": "prints values that do not fit the system it names",
    "world": "prints a position that disagrees with the other boreholes' positions in the table",
}


def apply_tables(items: Sequence[Any], index: TableIndex) -> list[tuple[Any, Adjusted]]:
    """Each reconciled borehole with its table-based position and depth applied (see the module docstring).
    `items` are app.pipeline.identity.Reconciled; returned with what finalisation adds to each."""
    out: list[tuple[Any, Adjusted]] = []
    rows: list[TableRow | None] = []
    sheets: list[Sheet] = []
    for item in items:
        labels = [item.group.label_canonical, *(canonical_label(a) for a in item.aliases)]
        rows.append(next((index.rows[c] for c in labels if c and c in index.rows), None))
        sheets.append(sheet_position(item.outcome.result.header.coordinates))
    untrusted = _untrusted(sheets, rows)
    for i, item in enumerate(items):
        adjusted = Adjusted()
        row, sheet = rows[i], sheets[i]
        if row is not None:
            if sheet.kind in ("missing", "unreadable", "misfit") or i in untrusted:
                item = _take_position(item, row, sheet, adjusted, index)
            item = _check_depth(item, row, adjusted, index)
        out.append((item, adjusted))
    return out


def _untrusted(sheets: Sequence[Sheet], rows: Sequence[TableRow | None]) -> set[int]:
    """Sheet positions in a map system outside the largest group that agrees with itself by the table's
    distances (a misread digit puts a borehole hundreds of metres or kilometres away). Nothing is untrusted
    when no group of two or more agrees, or two different groups are equally large."""
    placed = [
        i for i, (s, r) in enumerate(zip(sheets, rows, strict=True)) if s.kind == "world" and r is not None
    ]
    if len(placed) < 2:
        return set()
    table = {i: row for i in placed if (row := rows[i]) is not None}

    def agree(i: int, j: int) -> bool:
        return not _disagree(sheets[i], sheets[j], table[i], table[j])

    groups: list[frozenset[int]] = []
    for i in placed:
        group = [i, *(j for j in placed if j != i and agree(i, j))]
        while True:  # drop the member that disagrees with most of the others until all agree
            worst = max(group, key=lambda k: sum(1 for m in group if m != k and not agree(k, m)))
            if all(agree(k, m) for k in group for m in group if k != m):
                break
            group.remove(worst)
        groups.append(frozenset(group))
    largest = max(len(g) for g in groups)
    best = {g for g in groups if len(g) == largest}
    if largest < 2 or len(best) > 1:
        return set()
    (trusted,) = best
    return set(placed) - trusted


def _with_blocks(item: Any, header_update: dict[str, Any], index: TableIndex, tokens: Sequence[Token]) -> Any:
    result = item.outcome.result
    header = result.header.model_copy(update=header_update)
    blocks = {**item.outcome.blocks, **{t.id: index.blocks[t.id] for t in tokens if t.id in index.blocks}}
    outcome = replace(item.outcome, result=result.model_copy(update={"header": header}), blocks=blocks)
    return replace(item, outcome=outcome)


def _take_position(item: Any, row: TableRow, sheet: Sheet, adjusted: Adjusted, index: TableIndex) -> Any:
    coords = position_from_table(item.outcome.result, row)
    if coords is None or row.x is None or row.y is None:
        return item
    tokens = [row.x, row.y, *row.axis_labels, *row.system]
    system = " ".join(t.text for t in row.system).strip(" ,.;:")
    where = f"{row.x.text} / {row.y.text}" + (f" ({system})" if system else "")
    kind = "world" if sheet.kind == "world" else sheet.kind
    note = f"position from the table on page {row.page} ({where}): the log sheet {WHY.get(kind, '')}"
    if sheet.texts:
        note += f" ({sheet.texts})"
        reading = _reading(sheet.texts)
        adjusted.readings["metadata.coordinates.x_raw"] = [reading]
        adjusted.readings["metadata.coordinates.y_raw"] = [reading]
    adjusted.notes.append(note)
    logger.info("borehole %s: %s", item.group.label_raw, note)
    return _with_blocks(item, {"coordinates": coords}, index, tokens)


def _page_of(token: Token) -> int:
    """The page a table cell is on (its id is "p<n>.<...>")."""
    return int(token.id[1:].split(".", 1)[0])


def _check_depth(item: Any, row: TableRow, adjusted: Adjusted, index: TableIndex) -> Any:
    token = row.total_depth
    table_value = number_of(token)
    if token is None or table_value is None:
        return item
    page = _page_of(token)
    sheet_text = printed(item.outcome.result.header.total_depth)
    if sheet_text is None:
        adjusted.notes.append(f"total depth {token.text} from the table on page {page}")
        return _with_blocks(item, {"total_depth": _cite(token)}, index, [token])
    sheet_value = parse_number(sheet_text).value
    if sheet_value is not None and abs(sheet_value - table_value) > 1e-6:
        flag = (
            f"the table on page {page} prints {token.text} as this borehole's total depth; "
            f"the log sheet prints {sheet_text}"
        )
        adjusted.flags[DEPTH_PATH] = flag
        adjusted.readings[DEPTH_PATH] = [
            {"reader": "sheet", "text": sheet_text, "confidence": None},
            {"reader": "table", "text": token.text, "confidence": None},
        ]
        adjusted.notes.append(flag)
    return item
