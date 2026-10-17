"""One borehole per printed ID within a document (BACKEND.md 7.6).

Handwritten log forms often print the borehole ID only in a remark ("Kommentar: Hull nr 506"), while the page
classifier and the extractor take a name from a header field (the driller, a well-register number, a place).
When the document's summary or coordinate table lists the IDs, a borehole whose name is none of them takes the
one listed ID that its own pages print. Boreholes of one document that then share an ID are one borehole (the
handwritten log and the drilling-parameter plot of the same hole): their extraction results are merged before
anything is stored, so the review never shows the same hole twice.

Generic: the listed IDs are the classifier's labels of the document's table pages, the prefix words come from
data/page_roles.yaml, and nothing depends on a file, project, language or layout.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy import select

from app.db.models import Page
from app.db.session import get_sessionmaker
from app.normalize.numbers import parse_number
from app.pipeline.extract import merge_results
from app.pipeline.group import clean_label, group_key, label_prefix_words
from app.pipeline.provenance import printed
from app.pipeline.schemas import ExtractionResult, RawValue
from app.pipeline.types import BlockRef, ExtractionOutcome, PageGroup
from app.review.service import canonical_label

logger = logging.getLogger("geomemory.pipeline.identity")

TABLE_ROLES = frozenset({"summary_table", "coordinate_table"})
# A table must list at least this many IDs before its IDs overrule a name read on a log page.
MIN_LISTED = 2
# Bare IDs shorter than this (no borehole word in front) are too easily a depth or a count.
MIN_BARE_LENGTH = 3
# Parts of one label whose depth columns share more than this share of the shorter column are two holes.
OVERLAP_SHARE = 0.5


@dataclass
class Reconciled:
    """A page group and its extraction outcome, with the names it was known by before (aliases)."""

    group: PageGroup
    outcome: ExtractionOutcome
    aliases: list[str]


@dataclass(frozen=True)
class Tables:
    """The IDs a document's summary and coordinate tables list (canonical -> as listed) and their pages."""

    ids: dict[str, str]
    pages: frozenset[int] = frozenset()


async def document_tables(document_id: str) -> Tables:
    """The IDs the classifier read on the document's table pages, and those pages."""
    async with get_sessionmaker()() as session:
        rows = (
            await session.execute(
                select(Page.n, Page.borehole_labels).where(
                    Page.document_id == document_id, Page.role.in_(TABLE_ROLES)
                )
            )
        ).all()
    labels = (label for _, labels in rows for label in (labels or []))
    return Tables(ids_from_labels(labels), frozenset(int(n) for n, _ in rows))


def ids_from_labels(labels: Iterable[str]) -> dict[str, str]:
    listed: dict[str, str] = {}
    for label in labels:
        text = clean_label(str(label).strip())
        canonical = canonical_label(text) if text else ""
        if canonical and any(ch.isdigit() for ch in canonical):
            listed.setdefault(canonical, text)
    return listed


def _id_pattern(canonical: str) -> re.Pattern[str]:
    """The ID as printed: its letter and digit runs, optionally split by a space, dash, dot or slash. Never
    a part of a longer number: a decimal ("703,5 m") or a date ("12.05.2004") does not print the ID."""
    runs = re.findall(r"[0-9]+|[A-Z]+", canonical)
    body = r"[\s\-_./]?".join(re.escape(run) for run in runs)
    return re.compile(rf"(?<![0-9A-Za-z])(?<![0-9][.,/]){body}(?![0-9A-Za-z])(?![.,/][0-9])", re.IGNORECASE)


def _prefixed(text: str, start: int) -> bool:
    """A borehole word or a word and a number sign stands right before position `start`."""
    words, signs = label_prefix_words()
    before = text[max(0, start - 40) : start]
    word = "|".join(re.escape(w).replace(r"\ ", r"\s*") for w in words) or r"(?!)"
    sign = "|".join(re.escape(s) for s in signs) or r"(?!)"
    pattern = rf"(?:(?:{word})\s*(?:{sign})?|[^\W\d_]+\.?\s*(?:{sign}))\s*[:.\-]?\s*$"
    return re.search(pattern, before, re.IGNORECASE) is not None


@dataclass(frozen=True)
class Hit:
    canonical: str
    text: str  # as printed
    block: BlockRef
    prefixed: bool


def find_listed(blocks: Iterable[BlockRef], pages: Iterable[int], listed: dict[str, str]) -> Hit | None:
    """The one listed ID that the blocks on `pages` print; None when they print none or several.

    IDs with a borehole word in front ("Hull nr 506", "Id: 502") win over bare ones; of overlapping matches
    the longest stands ("502 b" is 502B, not 502)."""
    wanted = set(pages)
    patterns = {canonical: _id_pattern(canonical) for canonical in listed}
    hits: list[Hit] = []
    for block in sorted((b for b in blocks if b.page in wanted), key=lambda b: (b.page, b.id)):
        spans: list[tuple[int, int, str]] = []
        for canonical, pattern in patterns.items():
            spans.extend((m.start(), m.end(), canonical) for m in pattern.finditer(block.text))
        for start, end, canonical in spans:
            if any(s <= start and end <= e and (e - s) > (end - start) for s, e, _ in spans):
                continue  # inside a longer listed ID
            prefixed = _prefixed(block.text, start)
            if not prefixed and len(canonical) < MIN_BARE_LENGTH:
                continue
            hits.append(Hit(canonical, block.text[start:end], block, prefixed))
    for subset in ([h for h in hits if h.prefixed], hits):
        found = {h.canonical for h in subset}
        if len(found) == 1:
            return subset[0]
        if len(found) > 1:
            return None
    return None


# Header values whose printed text may carry the borehole's ID (a remark "Hull nr 506" on a handwritten form
# is often only in the extractor's reading, not in the scan's text layer).
HEADER_TEXTS = ("borehole_label", "notes", "location", "project", "client", "contractor", "method")


def _own_texts(item: Reconciled) -> list[BlockRef]:
    """The blocks of the group's own pages, plus the header values read there (each placed at the first block
    it cites, so a match cites that block)."""
    pages = set(item.group.pages)
    blocks = item.outcome.blocks
    out = [b for b in blocks.values() if b.page in pages]
    header = item.outcome.result.header
    for name in HEADER_TEXTS:
        value: RawValue = getattr(header, name)
        text = printed(value)
        cited = [blocks[b] for b in value.block_ids if b in blocks and blocks[b].page in pages]
        if text is not None and cited:
            out.append(replace(cited[0], text=text))
    return out


Row = tuple[BlockRef, ...]


def _rows(blocks: Iterable[BlockRef]) -> list[Row]:
    """Blocks of one page in printed rows: vertical centres within half a line height, left to right."""
    rows: list[tuple[float, float, list[BlockRef]]] = []
    for b in sorted(blocks, key=lambda b: b.box[1] + b.box[3] / 2 if b.box else 0.0):
        if b.box is None:
            continue
        centre, height = b.box[1] + b.box[3] / 2, b.box[3]
        if rows and abs(centre - rows[-1][0]) <= max(rows[-1][1], height) / 2:
            rows[-1][2].append(b)
        else:
            rows.append((centre, height, [b]))
    return [tuple(sorted(row, key=lambda b: b.box[0] if b.box else 0.0)) for _, _, row in rows]


def table_rows(items: Sequence[Reconciled], pages: frozenset[int]) -> list[Row]:
    """The rows of the document's table pages, from every block the outcomes carry of those pages."""
    unique: dict[tuple[int, str], BlockRef] = {}
    for item in items:
        for block in item.outcome.blocks.values():
            if block.page in pages:
                unique.setdefault((block.page, block.id), block)
    return [row for n in sorted(pages) for row in _rows(b for (page, _), b in unique.items() if page == n)]


def _row_id(row: Row, listed: dict[str, str]) -> Hit | None:
    """The one listed ID a table row prints (anchored at the row's first block)."""
    joined = replace(row[0], text="  ".join(b.text for b in row))
    return find_listed([joined], [row[0].page], listed)


def _cited_ids(result: ExtractionResult) -> set[str]:
    cited: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if isinstance(node.get("block_ids"), list) and node.get("state") == "ok":
                cited.update(str(b) for b in node["block_ids"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(result.model_dump(mode="json"))
    return cited


def _cited_row(item: Reconciled, listed: dict[str, str], rows: Sequence[Row]) -> Hit | None:
    """The listed ID of the table row(s) the extractor took this borehole's values from, when they agree."""
    cited = _cited_ids(item.outcome.result)
    found: dict[str, Hit] = {}
    for row in rows:
        if any(b.id in cited for b in row) and (hit := _row_id(row, listed)) is not None:
            found.setdefault(hit.canonical, hit)
    return next(iter(found.values())) if len(found) == 1 else None


_NUMBER = re.compile(r"(?<![\d.,])\d+(?:[.,]\d+)?(?![\d.,])")


def _depth_row(item: Reconciled, listed: dict[str, str], rows: Sequence[Row]) -> Hit | None:
    """The listed ID of the one table row that prints this borehole's total depth."""
    depth = parse_number(printed(item.outcome.result.header.total_depth)).value
    if depth is None or depth <= 0:
        return None
    found: dict[str, Hit] = {}
    for row in rows:
        hit = _row_id(row, listed)
        numbers = [float(n.replace(",", ".")) for b in row for n in _NUMBER.findall(b.text)]
        if hit is not None and any(abs(n - depth) < 1e-6 for n in numbers):
            found.setdefault(hit.canonical, hit)
    return next(iter(found.values())) if len(found) == 1 else None


def _label_of(item: Reconciled) -> str | None:
    return printed(item.outcome.result.header.borehole_label) or (item.group.label_raw or "").strip() or None


def _relabel(item: Reconciled, listed: dict[str, str], rows: Sequence[Row]) -> Reconciled:
    """The listed ID the borehole's own pages print, else the one of the table rows its values come from."""
    label = _label_of(item)
    cleaned = clean_label(label) if label else None
    if cleaned is not None and canonical_label(cleaned) in listed:
        if cleaned != label:  # "Holl nr 502" -> "502", cited where it was printed
            item = _with_label(item, cleaned, item.outcome.result.header.borehole_label.block_ids, label)
        return item
    hit = find_listed(_own_texts(item), item.group.pages, listed)
    how = "printed on page"
    if hit is None:
        hit, how = _cited_row(item, listed, rows), "of the table row its values come from, page"
    if hit is None:
        return item
    logger.info("borehole %r takes the listed ID %r %s %s", label, hit.text, how, hit.block.page)
    return _with_label(item, clean_label(hit.text), [hit.block.id], label)


def _with_label(item: Reconciled, label: str, block_ids: Sequence[str], before: str | None) -> Reconciled:
    result = item.outcome.result
    header = result.header.model_copy(
        update={"borehole_label": RawValue(raw=label, block_ids=list(block_ids), state="ok")}
    )
    outcome = replace(item.outcome, result=result.model_copy(update={"header": header}))
    canonical = canonical_label(label)
    group = replace(
        item.group, label_raw=label, label_canonical=canonical, key=group_key(canonical, item.group.pages)
    )
    aliases = [*item.aliases, *([before] if before and canonical_label(before) != canonical else [])]
    return Reconciled(group, outcome, aliases)


def _rekey(result: ExtractionResult, mapping: dict[str, str]) -> ExtractionResult:
    """The result with cited block ids renamed (`mapping`), for blocks whose id another part already uses."""
    if not mapping:
        return result

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if "block_ids" in node and isinstance(node["block_ids"], list):
                node = {**node, "block_ids": [mapping.get(b, b) for b in node["block_ids"]]}
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return ExtractionResult.model_validate(walk(result.model_dump(mode="json")))


def _merge(items: Sequence[Reconciled]) -> Reconciled:
    """Parts of one borehole (in page order) as one group and one outcome."""
    blocks: dict[str, BlockRef] = {}
    results: list[ExtractionResult] = []
    for item in items:
        mapping: dict[str, str] = {}
        for block_id, block in item.outcome.blocks.items():
            if block_id in blocks and blocks[block_id] != block:
                new_id = f"{block_id}.{len(results)}"
                mapping[block_id] = new_id
                blocks[new_id] = replace(block, id=new_id)
            else:
                blocks[block_id] = block
        results.append(_rekey(item.outcome.result, mapping))
    first = items[0]
    pages = tuple(sorted({n for item in items for n in item.group.pages}))
    context = tuple(sorted({n for item in items for n in item.group.context_pages} - set(pages)))
    uncertain = tuple(dict.fromkeys(reason for item in items for reason in item.group.uncertain))
    group = PageGroup(
        key=group_key(first.group.label_canonical, pages),
        label_raw=first.group.label_raw,
        label_canonical=first.group.label_canonical,
        pages=pages,
        context_pages=context,
        uncertain=uncertain,
    )
    outcome = ExtractionOutcome(
        result=merge_results(results),
        blocks=blocks,
        run_id=first.outcome.run_id,
        model=first.outcome.model,
        cost_usd=sum(item.outcome.cost_usd for item in items),
        warnings=tuple(w for item in items for w in item.outcome.warnings),
    )
    aliases = list(dict.fromkeys(a for item in items for a in item.aliases))
    names = [_label_of(item) for item in items]
    logger.info("pages %s are one borehole %r (parts %s)", pages, group.label_raw, names)
    return Reconciled(group, outcome, aliases)


def _printed_position(item: Reconciled) -> tuple[str, str] | None:
    """The digits of the printed coordinates ("X:276,650.254" and "276,650.254" are the same), when both are
    printed."""
    coords = item.outcome.result.header.coordinates
    x, y = printed(coords.x_raw), printed(coords.y_raw)
    if x is None or y is None:
        return None
    return re.sub(r"\D", "", x), re.sub(r"\D", "", y)


def _depth_span(item: Reconciled) -> tuple[float, float] | None:
    """Shallowest and deepest printed depth of a part's depth column (layers, SPT, core runs)."""
    result = item.outcome.result
    raws = [
        *(v for layer in result.layers for v in (layer.from_raw, layer.to_raw)),
        *(test.depth_raw for test in result.spt),
        *(v for run in result.core_runs for v in (run.from_raw, run.to_raw)),
    ]
    depths = [
        d
        for raw in raws
        if (text := printed(raw)) is not None and (d := parse_number(text).value) is not None
    ]
    return (min(depths), max(depths)) if depths else None


def _overlap(a: tuple[float, float] | None, b: tuple[float, float] | None) -> bool:
    """Two depth columns cover the same depths: two logs each from their own top, not one log's sheets (a
    further sheet goes on below the one before, sharing at most a boundary or a layer across the break)."""
    if a is None or b is None:
        return False
    shared = min(a[1], b[1]) - max(a[0], b[0])
    return shared > 0 and shared > OVERLAP_SHARE * min(a[1] - a[0], b[1] - b[0])


def _holes(parts: Sequence[Reconciled], listed: dict[str, str]) -> list[list[Reconciled]]:
    """Parts with one label (in page order) as boreholes. All one borehole when the document's tables list
    the label. Otherwise parts that print different coordinates stay apart, and so do parts whose depth
    columns cover the same depths: a field form numbered per site ("HA-1" under every main hole) or a
    misread ID repeats a label on logs of other holes, and without coordinates nothing else tells them
    apart. Continuation sheets read as separate holes go on below each other and are merged."""
    if parts[0].group.label_canonical in listed:
        return [list(parts)]
    positions = {pos for part in parts if (pos := _printed_position(part)) is not None}
    if len(positions) > 1:
        return [[part] for part in parts]
    holes: list[list[Reconciled]] = []
    for part in parts:
        span = _depth_span(part)
        if holes and not any(_overlap(span, _depth_span(other)) for other in holes[-1]):
            holes[-1].append(part)
        else:
            holes.append([part])
    return holes


def reconcile(
    pairs: Sequence[tuple[PageGroup, ExtractionOutcome]], tables: Tables | dict[str, str]
) -> list[Reconciled]:
    """Relabel to the IDs the document's tables list, then merge the parts that share a label and are one
    borehole (`_holes`). Parts without a label are never merged.

    A borehole takes, in this order: the listed ID its own pages print; the ID of the table row its values
    were taken from; the ID of the one table row printing its total depth, when no other borehole has it."""
    tables = tables if isinstance(tables, Tables) else Tables(tables)
    listed = tables.ids
    items = [Reconciled(group, outcome, []) for group, outcome in pairs]
    if len(listed) >= MIN_LISTED:
        rows = table_rows(items, tables.pages)
        items = [_relabel(item, listed, rows) for item in items]
        held = {item.group.label_canonical for item in items if item.group.label_canonical in listed}
        guesses = {
            i: hit
            for i, item in enumerate(items)
            if item.group.label_canonical not in listed
            and (hit := _depth_row(item, listed, rows)) is not None
        }
        per_id = Counter(hit.canonical for hit in guesses.values())
        for i, hit in guesses.items():
            if per_id[hit.canonical] == 1 and hit.canonical not in held:
                before = _label_of(items[i])
                logger.info("borehole %r takes the listed ID %r of the row with its depth", before, hit.text)
                items[i] = _with_label(items[i], clean_label(hit.text), [hit.block.id], before)
    by_id: dict[str, list[Reconciled]] = {}
    order: list[str | Reconciled] = []
    for item in sorted(items, key=lambda i: (min(i.group.pages, default=0), i.group.key)):
        canonical = item.group.label_canonical
        if not canonical:
            order.append(item)
            continue
        if canonical not in by_id:
            by_id[canonical] = []
            order.append(canonical)
        by_id[canonical].append(item)
    out: list[Reconciled] = []
    for entry in order:
        if isinstance(entry, Reconciled):
            out.append(entry)
        else:
            for hole in _holes(by_id[entry], listed):
                out.append(hole[0] if len(hole) == 1 else _merge(hole))
    return out
