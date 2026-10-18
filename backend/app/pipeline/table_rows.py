"""Per-borehole rows of a document's summary and coordinate tables, read without a model.

A table page's words (its text layer, else its OCR blocks with boxes) are grouped into printed rows. A heading
row names the coordinate columns by their axis labels (data/crs_patterns.yaml: X / Y, Easting / Northing,
Rechtswert / Hochwert ...) and, when printed, a total-depth column (data/tables.yaml). Every later row that
prints one listed borehole ID gives that borehole's coordinates and total depth: the words under those
headings. The table's coordinate system is the phrase on the page that names a local grid ("Oslo lokal") or a
printed system. Pure; the caller loads the pages (app.pipeline.positions).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache

from app.normalize import crs as crs_parser
from app.normalize.numbers import load_data, parse_number, str_list

Box = tuple[float, float, float, float]  # x, y, w, h normalised 0-1


@dataclass(frozen=True)
class Token:
    """One printed word or cell with its box, and the id it is cited by."""

    id: str
    text: str
    box: Box

    @property
    def cx(self) -> float:
        return self.box[0] + self.box[2] / 2

    @property
    def cy(self) -> float:
        return self.box[1] + self.box[3] / 2


@dataclass(frozen=True)
class TableRow:
    """What one table row prints for one borehole."""

    label: str  # canonical ID
    page: int
    x: Token | None
    y: Token | None
    axis_labels: tuple[Token, ...]  # the two coordinate headings, left to right
    system: tuple[Token, ...]  # the words naming the table's coordinate system, if printed
    total_depth: Token | None


@dataclass(frozen=True)
class _Config:
    x_labels: frozenset[str]
    y_labels: frozenset[str]
    depth_terms: tuple[str, ...]
    tolerance: float
    local_words: re.Pattern[str] | None


def _key(text: str) -> str:
    return re.sub(r"[\s.:,;()\[\]]+", " ", text.casefold()).strip()


@lru_cache(maxsize=1)
def config() -> _Config:
    patterns = load_data("crs_patterns.yaml")
    labels = patterns.get("axis_labels") or {}
    x_labels = {_key(w) for k in ("east", "x", "lon") for w in str_list(labels.get(k))}
    y_labels = {_key(w) for k in ("north", "y", "lat") for w in str_list(labels.get(k))}
    tables = load_data("tables.yaml")
    words = sorted(str_list((patterns.get("local_grid") or {}).get("words")), key=len, reverse=True)
    local = (
        re.compile(r"(?:" + "|".join(re.escape(w) for w in words) + r")", re.IGNORECASE) if words else None
    )
    return _Config(
        x_labels=frozenset(x_labels),
        y_labels=frozenset(y_labels),
        depth_terms=tuple(_key(t) for t in str_list(tables.get("total_depth_terms"))),
        tolerance=float(tables.get("column_tolerance") or 0.06),
        local_words=local,
    )


def _axis(token: Token) -> str:
    """A heading word as an axis label: the word itself, or its part before a hyphen ("X-koordinat")."""
    key = _key(token.text)
    return re.split(r"[-_/]", key, maxsplit=1)[0] if key not in config().x_labels | config().y_labels else key


def rows_of(tokens: Sequence[Token]) -> list[list[Token]]:
    """Tokens in printed rows: vertical centres within half a line height, left to right."""
    rows: list[tuple[float, float, list[Token]]] = []
    for token in sorted(tokens, key=lambda t: t.cy):
        height = token.box[3]
        if rows and abs(token.cy - rows[-1][0]) <= max(rows[-1][1], height) / 2:
            rows[-1][2].append(token)
        else:
            rows.append((token.cy, height, [token]))
    return [sorted(row, key=lambda t: t.cx) for _, _, row in rows]


def number_of(token: Token | None) -> float | None:
    return None if token is None else parse_number(token.text).value


def _nearest(row: Sequence[Token], centre: float, tolerance: float) -> Token | None:
    numbers = [t for t in row if number_of(t) is not None and abs(t.cx - centre) <= tolerance]
    return min(numbers, key=lambda t: abs(t.cx - centre)) if numbers else None


def _depth_column(rows: Sequence[Sequence[Token]]) -> float | None:
    """The centre of a total-depth heading printed in `rows` (a heading may wrap over lines)."""
    for row in rows:
        words = [_key(t.text) for t in row]
        text = " ".join(words)
        for term in config().depth_terms:
            at = text.find(term)
            if at < 0:
                continue
            pos, covered = 0, []
            for token, word in zip(row, words, strict=True):
                if pos + len(word) > at and pos < at + len(term):
                    covered.append(token)
                pos += len(word) + 1
            if covered:
                return sum(t.cx for t in covered) / len(covered)
    return None


def _system_tokens(tokens: Sequence[Token]) -> tuple[Token, ...]:
    """The words that name the page's coordinate system: a local-grid word with the word before it ("Oslo
    lokal"), else a short line that states a system."""
    cfg = config()
    rows = rows_of(tokens)
    if cfg.local_words is not None:
        for row in rows:
            for i, token in enumerate(row):
                if cfg.local_words.fullmatch(token.text.strip(" ,.;:")):
                    return tuple(row[max(0, i - 1) : i + 1])
    for row in rows:
        line = " ".join(t.text for t in row)
        if len(line) <= 80 and crs_parser.resolve_printed_system(line).code is not None:
            return tuple(row)
    return ()


def read_rows(
    page: int,
    tokens: Sequence[Token],
    ids: Mapping[str, str],
    id_pattern: Callable[[str], re.Pattern[str]],
) -> dict[str, TableRow]:
    """The rows of one table page by canonical borehole ID (`ids`: canonical -> as listed; `id_pattern`
    matches an ID as printed)."""
    cfg = config()
    rows = rows_of(tokens)
    heading = next(
        (
            i
            for i, row in enumerate(rows)
            if any(_axis(t) in cfg.x_labels for t in row) and any(_axis(t) in cfg.y_labels for t in row)
        ),
        None,
    )
    if heading is None:
        return {}
    head = rows[heading]
    x_head = next(t for t in head if _axis(t) in cfg.x_labels)
    y_head = next((t for t in head if _axis(t) in cfg.y_labels and t is not x_head), None)
    if y_head is None:
        return {}
    depth_centre = _depth_column(rows[max(0, heading - 2) : heading + 3])
    system = _system_tokens(tokens)
    patterns = {canonical: id_pattern(canonical) for canonical in ids}
    left_edge = min(x_head.cx, y_head.cx) - cfg.tolerance
    out: dict[str, TableRow] = {}
    for row in rows[heading + 1 :]:
        first = [t for t in row if t.cx < left_edge] or list(row[:2])
        text = " ".join(t.text for t in first)
        spans = [(m.start(), m.end(), c) for c, p in patterns.items() for m in p.finditer(text)]
        # of overlapping matches the longest stands ("502 b" is 502B, not 502)
        found = sorted(
            {
                c
                for s, e, c in spans
                if not any(s2 <= s and e <= e2 and e2 - s2 > e - s for s2, e2, _ in spans)
            }
        )
        if len(found) != 1 or found[0] in out:
            continue
        x = _nearest(row, x_head.cx, cfg.tolerance)
        y = _nearest(row, y_head.cx, cfg.tolerance)
        depth = _nearest(row, depth_centre, cfg.tolerance) if depth_centre is not None else None
        if (x is None or y is None) and depth is None:
            continue
        out[found[0]] = TableRow(
            label=found[0],
            page=page,
            x=x,
            y=y,
            axis_labels=tuple(sorted((x_head, y_head), key=lambda t: t.cx)),
            system=system,
            total_depth=depth,
        )
    return out
