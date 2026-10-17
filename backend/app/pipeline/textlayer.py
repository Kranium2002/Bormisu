"""Tight evidence boxes from a page's embedded text layer (BACKEND.md 7.6).

OCR may return one block for a whole log table, so the union of the blocks a value cites can cover most of
a page. Vector PDFs carry a text layer whose words triage stores with boxes normalised to the page render
(pages.text_layer_key -> {"text", "words": [{"t": word, "b": [x, y, w, h]}]}). When a value's cited blocks
lie on a page whose text layer is trustworthy, the value's printed text is looked up as a run of words
inside the cited blocks, and the union of those words' boxes becomes its evidence box.

Matching (`find_runs`) works for any language and layout. Text is compared by a key that ignores whitespace
(digit grouping, thin spaces, line breaks) and letter case and reads equivalent characters as one (decimal
comma and point, dash, apostrophe and quote variants; data/provenance.yaml). A value may start or end
inside a word only where the cut separates a number from a glued unit or label ("1.50m", "N=14",
"(ETRS89"), never inside a number or a word. A value continues on a later line of its column (long
descriptions), also across a hyphen that breaks a word at the end of a line.

Text printed several times ("1.00" in a depth column, a depth scale and a sample column) is resolved across
the whole record (`resolve_record`):
- layer depths are matched top to bottom in depth order, each top and base at or after the previous one (a
  top may share the printed word of the previous layer's base when the log prints one depth per boundary);
- descriptions follow the same order, and a row's other cells lie near its description or depth values;
- SPT tests, core runs, samples, groundwater readings and lab tests are ordered by depth the same way;
- header values prefer words no other value uses and that lie outside the table rows;
- one word is never used for two different values while an unused match fits as well.
A value whose text is not found keeps the union of its blocks, and so does a value that fits several places
equally well: every box is the box of printed words or of the OCR blocks, never an estimate.

Pure functions; tolerances and costs live in data/provenance.yaml.
"""

from __future__ import annotations

import math
import statistics
import unicodedata
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import cached_property, lru_cache
from typing import Any, TypeGuard

from pydantic import BaseModel

from app.normalize.numbers import load_data, str_list
from app.pipeline.schemas import ExtractionResult, RawValue
from app.pipeline.types import BlockRef

Box = tuple[float, float, float, float]  # normalised x, y, w, h (top-left origin of the page render)
Owner = tuple[str, int]  # the record item a value belongs to: ("layer", 2), ("header", 5) ...

_LETTER, _DIGIT, _OTHER = 0, 1, 2


# ----------------------------------------------------------------------------------------------
# Configuration (data/provenance.yaml)
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class BoxConfig:
    read_min_text_quality: float
    block_margin: float
    line_overlap: float
    same_line_gap: float
    next_line_gap: float
    column_tolerance: float
    equivalents: Mapping[str, str]
    ignored: frozenset[str]
    broken_word_markers: frozenset[str]
    number_joiners: frozenset[str]
    break_hyphens: frozenset[str]
    reuse_boundary_cost: float
    split_boundary_cost: float
    reuse_cost: float
    used_cost: float
    order_violation_cost: float
    row_weight: float
    column_weight: float
    tie_margin: float
    max_candidates: int


def _chars(values: Any) -> frozenset[str]:
    return frozenset(unicodedata.normalize("NFKC", v) for v in str_list(values) if len(v) == 1)


@lru_cache(maxsize=1)
def config() -> BoxConfig:
    """Tolerances and costs from data/provenance.yaml (cached)."""
    data = load_data("provenance.yaml")
    equivalents: dict[str, str] = {}
    for target, sources in (data.get("equivalent_characters") or {}).items():
        for source in str_list(sources):
            normalised = unicodedata.normalize("NFKC", source)
            if len(normalised) == 1 and normalised != str(target):
                equivalents[normalised] = str(target)
    return BoxConfig(
        read_min_text_quality=float(data["read_min_text_quality"]),
        block_margin=float(data["block_margin"]),
        line_overlap=float(data["line_overlap"]),
        same_line_gap=float(data["same_line_gap"]),
        next_line_gap=float(data["next_line_gap"]),
        column_tolerance=float(data["column_tolerance"]),
        equivalents=equivalents,
        ignored=_chars(data.get("ignored_characters")),
        broken_word_markers=_chars(data.get("broken_word_markers")),
        number_joiners=_chars(data.get("number_joiners")),
        break_hyphens=_chars(data.get("break_hyphens")),
        reuse_boundary_cost=float(data["reuse_boundary_cost"]),
        split_boundary_cost=float(data["split_boundary_cost"]),
        reuse_cost=float(data["reuse_cost"]),
        used_cost=float(data["used_cost"]),
        order_violation_cost=float(data["order_violation_cost"]),
        row_weight=float(data["row_weight"]),
        column_weight=float(data["column_weight"]),
        tie_margin=float(data["tie_margin"]),
        max_candidates=int(data["max_candidates"]),
    )


def text_key(text: str, cfg: BoxConfig | None = None) -> str:
    """Comparison key: NFKC, no whitespace or ignored characters, equivalents unified, casefolded."""
    cfg = cfg or config()
    out: list[str] = []
    for ch in unicodedata.normalize("NFKC", text):
        if ch.isspace() or ch in cfg.ignored:
            continue
        out.append(cfg.equivalents.get(ch, ch).casefold())
    return "".join(out)


# ----------------------------------------------------------------------------------------------
# Words and lines of one page
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Word:
    text: str
    key: str
    box: Box
    line: int  # index into PageText.lines
    index: int  # reading order on the page (lines top to bottom, words left to right)

    @property
    def x0(self) -> float:
        return self.box[0]

    @property
    def x1(self) -> float:
        return self.box[0] + self.box[2]

    @property
    def y0(self) -> float:
        return self.box[1]

    @property
    def y1(self) -> float:
        return self.box[1] + self.box[3]


@dataclass(frozen=True)
class Line:
    words: tuple[int, ...]  # word indexes, left to right
    y0: float
    y1: float

    @property
    def height(self) -> float:
        return self.y1 - self.y0


@dataclass(frozen=True)
class PageText:
    page: int
    words: tuple[Word, ...]
    lines: tuple[Line, ...]
    quality: float | None
    unit: float  # typical word height on the page: the floor for gaps measured in line heights

    @cached_property
    def starts(self) -> dict[str, list[tuple[int, int]]]:
        """Where each character occurs: (word index, offset in its key), in reading order."""
        index: dict[str, list[tuple[int, int]]] = {}
        for word in self.words:
            for offset, ch in enumerate(word.key):
                index.setdefault(ch, []).append((word.index, offset))
        return index


def _valid_box(value: Any) -> Box | None:
    if not isinstance(value, list | tuple) or len(value) != 4:
        return None
    try:
        x, y, w, h = (float(v) for v in value)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w < 0 or h < 0:
        return None
    return (x, y, w, h)


def page_text(
    page: int,
    words: Iterable[tuple[str, Sequence[float]]],
    *,
    quality: float | None = None,
    cfg: BoxConfig | None = None,
) -> PageText:
    """Group words (text, [x, y, w, h]) into lines and number them in reading order."""
    cfg = cfg or config()
    items: list[tuple[str, str, Box]] = []
    for text, raw_box in words:
        box = _valid_box(raw_box)
        if not isinstance(text, str) or box is None or any(ch in cfg.broken_word_markers for ch in text):
            continue
        key = text_key(text, cfg)
        if key:
            items.append((text, key, box))
    heights = [box[3] for _, _, box in items if box[3] > 0]
    unit = statistics.median(heights) if heights else 0.01

    # Words ordered by their vertical centre join the current line while they overlap it enough.
    order = sorted(range(len(items)), key=lambda i: (items[i][2][1] + items[i][2][3] / 2, items[i][2][0]))
    groups: list[list[int]] = []
    ranges: list[list[float]] = []
    for i in order:
        _, _, (_, y, _, h) = items[i]
        centre = y + h / 2
        if groups:
            top, bottom = ranges[-1]
            overlap = min(bottom, y + h) - max(top, y)
            smaller = min(h, bottom - top)
            if top <= centre <= bottom or (smaller > 0 and overlap >= cfg.line_overlap * smaller):
                groups[-1].append(i)
                ranges[-1] = [min(top, y), max(bottom, y + h)]
                continue
        groups.append([i])
        ranges.append([y, y + h])

    placed = sorted(zip(groups, ranges, strict=True), key=lambda g: ((g[1][0] + g[1][1]) / 2, g[1][0]))
    out_words: list[Word] = []
    out_lines: list[Line] = []
    for line_no, (members, (top, bottom)) in enumerate(placed):
        indexes: list[int] = []
        for i in sorted(members, key=lambda m: (items[m][2][0], items[m][2][1])):
            text, key, box = items[i]
            indexes.append(len(out_words))
            out_words.append(Word(text=text, key=key, box=box, line=line_no, index=len(out_words)))
        out_lines.append(Line(words=tuple(indexes), y0=top, y1=bottom))
    return PageText(page=page, words=tuple(out_words), lines=tuple(out_lines), quality=quality, unit=unit)


def line_blocks(text: PageText) -> list[dict[str, Any]]:
    """The text layer as OCR-like blocks: one per line (top to bottom), its words joined by spaces, the union
    of their boxes, confidence 1.0 (the printed text itself, not a reading of it)."""
    blocks: list[dict[str, Any]] = []
    for line in text.lines:
        words = [text.words[i] for i in line.words]
        x0, x1 = min(w.x0 for w in words), max(w.x1 for w in words)
        blocks.append(
            {
                "id": f"p{text.page}.b{len(blocks)}",
                "type": "text",
                "text": " ".join(w.text for w in words),
                "box": [round(x0, 5), round(line.y0, 5), round(x1 - x0, 5), round(line.height, 5)],
                "confidence": 1.0,
            }
        )
    return blocks


def page_text_from_payload(
    page: int, payload: Mapping[str, Any], *, quality: float | None = None, cfg: BoxConfig | None = None
) -> PageText:
    """The text layer as triage stores it: {"text": ..., "words": [{"t": word, "b": [x, y, w, h]}]}."""
    words: list[tuple[str, Sequence[float]]] = []
    for entry in payload.get("words") or []:
        if isinstance(entry, Mapping):
            text, box = entry.get("t"), entry.get("b")
            if isinstance(text, str) and isinstance(box, list | tuple):
                words.append((text, box))
    return page_text(page, words, quality=quality, cfg=cfg)


def usable(text: PageText | None, cfg: BoxConfig | None = None) -> bool:
    """A text layer that can be trusted as the source of a value."""
    cfg = cfg or config()
    return (
        text is not None
        and bool(text.words)
        and text.quality is not None
        and text.quality >= cfg.read_min_text_quality
    )


# ----------------------------------------------------------------------------------------------
# Finding printed text as runs of words
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Match:
    """Words on one page whose text is the value's printed text."""

    page: int
    words: tuple[int, ...]
    box: Box  # union of the words' boxes
    line: int  # line of the first word
    line_y: float  # top of that line
    partial: bool = False  # starts or ends inside a word (glued unit or label)

    @property
    def first(self) -> int:
        return self.words[0]

    @property
    def y0(self) -> float:
        return self.box[1]

    @property
    def y1(self) -> float:
        return self.box[1] + self.box[3]

    @property
    def x0(self) -> float:
        return self.box[0]

    @property
    def x1(self) -> float:
        return self.box[0] + self.box[2]


def _kind(ch: str) -> int:
    if ch.isdigit():
        return _DIGIT
    if ch.isalpha():
        return _LETTER
    return _OTHER


def _boundary(key: str, cut: int, cfg: BoxConfig) -> bool:
    """Whether a value may start or end at position `cut` of a word's key."""
    if cut <= 0 or cut >= len(key):
        return True
    a, b = key[cut - 1], key[cut]
    kind_a, kind_b = _kind(a), _kind(b)
    if kind_a == kind_b and kind_a != _OTHER:
        return False  # inside a number or a word
    joiners = cfg.number_joiners
    if kind_b == _DIGIT and a in joiners and cut >= 2 and _kind(key[cut - 2]) == _DIGIT:
        return False  # "1,|50": a decimal or grouping separator belongs to its number
    return not (kind_a == _DIGIT and b in joiners and cut + 1 < len(key) and _kind(key[cut + 1]) == _DIGIT)


@dataclass(frozen=True)
class _Step:
    pos: int  # characters of the target matched after this word
    complete: bool
    partial: bool
    needs_break: bool  # the word was matched without its line-end hyphen: the value goes on on a later line


def _consume(key: str, start: int, target: str, pos: int, cfg: BoxConfig) -> list[_Step]:
    """Ways the word key (from `start`) continues `target` at `pos`."""
    seg, rest = key[start:], target[pos:]
    steps: list[_Step] = []
    if len(seg) >= len(rest):
        if seg.startswith(rest) and _boundary(key, start + len(rest), cfg):
            steps.append(_Step(len(target), True, start > 0 or len(seg) > len(rest), False))
    elif rest.startswith(seg):
        steps.append(_Step(pos + len(seg), False, start > 0, False))
    if len(seg) > 1 and seg[-1] in cfg.break_hyphens:
        core = seg[:-1]
        if len(core) < len(rest) and rest.startswith(core) and rest[len(core)] != seg[-1]:
            steps.append(_Step(pos + len(core), False, start > 0, True))
    return steps


def _inside(text: PageText, areas: Sequence[Box], margin: float) -> frozenset[int]:
    found: set[int] = set()
    for word in text.words:
        cx, cy = word.x0 + word.box[2] / 2, word.y0 + word.box[3] / 2
        for x, y, w, h in areas:
            if x - margin <= cx <= x + w + margin and y - margin <= cy <= y + h + margin:
                found.add(word.index)
                break
    return frozenset(found)


class _Finder:
    def __init__(self, text: PageText, target: str, allowed: frozenset[int] | None, cfg: BoxConfig) -> None:
        self.text = text
        self.target = target
        self.allowed = allowed
        self.cfg = cfg
        self.found: dict[tuple[int, ...], bool] = {}
        self.limit = cfg.max_candidates + 1

    def ok(self, index: int) -> bool:
        return self.allowed is None or index in self.allowed

    def run(self) -> None:
        for index, start in self.text.starts.get(self.target[0], ()):
            if len(self.found) >= self.limit:
                return
            word = self.text.words[index]
            if not self.ok(index) or not _boundary(word.key, start, self.cfg):
                continue
            for step in _consume(word.key, start, self.target, 0, self.cfg):
                self._step((index,), step, (word.x0, word.x1))

    def _step(self, run: tuple[int, ...], step: _Step, column: tuple[float, float]) -> None:
        if step.complete:
            self.found[run] = self.found.get(run, True) and step.partial
            return
        if len(self.found) >= self.limit:
            return
        for nxt, new_line in self._next(run, column, step.needs_break):
            col = (min(column[0], nxt.x0) if new_line else column[0], max(column[1], nxt.x1))
            for following in _consume(nxt.key, 0, self.target, step.pos, self.cfg):
                partial = step.partial or following.partial
                self._step(
                    (*run, nxt.index),
                    _Step(following.pos, following.complete, partial, following.needs_break),
                    col,
                )

    def _next(
        self, run: tuple[int, ...], column: tuple[float, float], needs_break: bool
    ) -> list[tuple[Word, bool]]:
        text, cfg = self.text, self.cfg
        last = text.words[run[-1]]
        line = text.lines[last.line]
        options: list[tuple[Word, bool]] = []
        position = line.words.index(last.index)
        if not needs_break and position + 1 < len(line.words):
            nxt = text.words[line.words[position + 1]]
            base = max(last.box[3], nxt.box[3], text.unit)
            if self.ok(nxt.index) and nxt.x0 - last.x1 <= cfg.same_line_gap * base:
                options.append((nxt, False))
        base = max(line.height, text.unit)
        for later in text.lines[last.line + 1 :]:
            if later.y0 - line.y1 > cfg.next_line_gap * base:
                break
            in_column = [
                text.words[i] for i in later.words if text.words[i].x0 >= column[0] - cfg.column_tolerance
            ]
            if not in_column:
                continue
            nxt = in_column[0]
            if nxt.x0 <= column[1] and self.ok(nxt.index) and nxt.index not in run:
                options.append((nxt, True))
            break
        return options


def find_runs(
    text: PageText, raw: str, areas: Sequence[Box] | None = None, *, cfg: BoxConfig | None = None
) -> list[Match]:
    """Every place where `raw` is printed as a run of words (inside `areas` when given), in reading order.

    At most max_candidates + 1 places are returned (one more than are considered for a value).
    """
    cfg = cfg or config()
    allowed = _inside(text, areas, cfg.block_margin) if areas is not None else None
    return _find(text, raw, allowed, cfg)


def _find(text: PageText, raw: str, allowed: frozenset[int] | None, cfg: BoxConfig) -> list[Match]:
    """find_runs with the words inside the cited areas already known (None: the whole page)."""
    target = text_key(raw, cfg)
    if not target or not text.words or (allowed is not None and not allowed):
        return []
    finder = _Finder(text, target, allowed, cfg)
    finder.run()
    matches: list[Match] = []
    for run, partial in finder.found.items():
        boxes = [text.words[i].box for i in run]
        x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
        x1, y1 = max(b[0] + b[2] for b in boxes), max(b[1] + b[3] for b in boxes)
        first = text.words[run[0]]
        matches.append(
            Match(
                page=text.page,
                words=run,
                box=(x0, y0, x1 - x0, y1 - y0),
                line=first.line,
                line_y=text.lines[first.line].y0,
                partial=partial,
            )
        )
    matches.sort(key=lambda m: (m.first, len(m.words)))
    return matches


# ----------------------------------------------------------------------------------------------
# Resolution across a record
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Hit:
    """A value's printed text was found in the text layer of `page` (text-layer agreement).

    `box` is the union of its words, or None when it fits several places equally well (the value then
    keeps the box of its OCR blocks).
    """

    page: int
    box: Box | None


class Resolution:
    """Hits per extracted value (by identity: the same RawValue objects the record is built from)."""

    def __init__(self, hits: Iterable[tuple[RawValue, Hit]] = ()) -> None:
        self._hits: dict[int, tuple[RawValue, Hit]] = {}
        for value, hit in hits:
            self._hits.setdefault(id(value), (value, hit))

    def get(self, value: RawValue | None) -> Hit | None:
        if value is None:
            return None
        item = self._hits.get(id(value))
        return item[1] if item is not None and item[0] is value else None

    def __len__(self) -> int:
        return len(self._hits)


@dataclass
class _Slot:
    value: RawValue
    owner: Owner
    page: int
    candidates: tuple[Match, ...]
    crowded: bool
    chosen: Match | None = None


@dataclass(frozen=True)
class _RowSpec:
    """How the items of one record array are laid out as table rows."""

    owner: str
    depths: tuple[str, ...]  # fields ordered top to bottom within a row
    anchor: str | None  # the row's main text (descriptions, sample names), matched before the depths
    cells: tuple[str, ...]
    shared_boundary: bool  # an item's top may be printed once with the previous item's base


ROWS: tuple[tuple[str, _RowSpec], ...] = (
    (
        "layers",
        _RowSpec(
            "layer",
            ("from_raw", "to_raw"),
            "description_raw",
            (
                "uscs_raw",
                "colour_raw",
                "consistency_raw",
                "moisture_raw",
                "weathering_raw",
                "stratigraphic_name_raw",
            ),
            True,
        ),
    ),
    ("spt", _RowSpec("spt", ("depth_raw",), None, ("blows_raw", "n_raw", "increment_note_raw"), False)),
    (
        "core_runs",
        _RowSpec("core", ("from_raw", "to_raw"), None, ("tcr_raw", "scr_raw", "rqd_raw", "ff_raw"), True),
    ),
    ("samples", _RowSpec("sample", ("from_raw", "to_raw"), "name_raw", ("type_raw",), True)),
    ("groundwater", _RowSpec("water", ("depth_raw",), None, ("date_raw",), False)),
    ("tests", _RowSpec("test", ("depth_raw",), None, ("value_raw", "unit_raw", "sample_raw"), False)),
)


def _raw_values(item: BaseModel, names: Iterable[str]) -> dict[str, RawValue]:
    out: dict[str, RawValue] = {}
    for name in names:
        value = getattr(item, name, None)
        if isinstance(value, RawValue):
            out[name] = value
    return out


def _gap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, b0 - a1, a0 - b1)


def _free(slot: _Slot | None) -> TypeGuard[_Slot]:
    """A value that takes part in a row order (found, and not printed more often than considered)."""
    return slot is not None and not slot.crowded


def _no_cost(_match: Match) -> float:
    return 0.0


class _Resolver:
    def __init__(
        self,
        blocks: Mapping[str, BlockRef],
        pages: Mapping[int, PageText],
        page_key: Callable[[int], tuple[int, int]],
        depth_of: Callable[[RawValue], float | None],
        cfg: BoxConfig,
    ) -> None:
        self.blocks = blocks
        self.pages = {n: t for n, t in pages.items() if usable(t, cfg)}
        self.page_key = page_key
        self.depth_of = depth_of
        self.cfg = cfg
        self.rank = {n: i for i, n in enumerate(sorted(self.pages, key=page_key))}
        self.slots: list[_Slot] = []
        self.seen: set[int] = set()
        self.used: dict[tuple[int, int], set[Owner]] = {}
        self.areas: dict[tuple[int, tuple[Box, ...]], frozenset[int]] = {}  # words inside cited blocks

    # -- slots -----------------------------------------------------------------------------------

    def slot(self, value: RawValue | None, owner: Owner) -> _Slot | None:
        if value is None or value.state != "ok" or value.raw is None or not value.raw.strip():
            return None
        if id(value) in self.seen:
            return None
        cited = [self.blocks[b] for b in dict.fromkeys(value.block_ids) if b in self.blocks]
        if not cited:
            return None
        page = min((b.page for b in cited), key=self.page_key)
        text = self.pages.get(page)
        if text is None:
            return None
        allowed: frozenset[int] | None = None
        # A cited block without a box (page-level OCR fallback) stands for its whole page.
        if not any(b.page == page and b.box is None for b in cited):
            boxes = tuple(sorted({b.box for b in cited if b.page == page and b.box is not None}))
            allowed = self.areas.get((page, boxes))
            if allowed is None:
                allowed = self.areas[(page, boxes)] = _inside(text, boxes, self.cfg.block_margin)
        candidates = _find(text, value.raw, allowed, self.cfg)
        if not candidates:
            return None
        crowded = len(candidates) > self.cfg.max_candidates
        slot = _Slot(value, owner, page, tuple(candidates), crowded)
        self.seen.add(id(value))
        self.slots.append(slot)
        return slot

    def decide(self, slot: _Slot, match: Match) -> None:
        slot.chosen = match
        for word in match.words:
            self.used.setdefault((match.page, word), set()).add(slot.owner)

    def taken(self, slot: _Slot, match: Match) -> bool:
        """Some word of `match` is used by a value of another row or header field."""
        return any(
            owners - {slot.owner}
            for w in match.words
            if (owners := self.used.get((match.page, w))) is not None
        )

    # -- geometry --------------------------------------------------------------------------------

    def order(self, match: Match) -> tuple[int, int]:
        return (self.rank.get(match.page, len(self.rank)), match.first)

    def vertical(self, match: Match) -> float:
        return self.rank.get(match.page, len(self.rank)) + match.line_y

    def distance(self, match: Match, anchor: Sequence[Match]) -> float:
        """Weighted distance of a cell to its row's anchor matches on the same page (0 without anchors)."""
        same = [a for a in anchor if a.page == match.page]
        if not same:
            return 0.0
        top, bottom = min(a.y0 for a in same), max(a.y1 for a in same)
        left, right = min(a.x0 for a in same), max(a.x1 for a in same)
        return self.cfg.row_weight * _gap(top, bottom, match.y0, match.y1) + self.cfg.column_weight * _gap(
            left, right, match.x0, match.x1
        )

    def near(self, anchor: Sequence[Match]) -> Callable[[Match], float]:
        return lambda match: self.distance(match, anchor)

    def transition(self, before: Match, after: Match, boundary: bool, jump_weight: float) -> float:
        """Cost of `after` following `before` in printed order. `boundary`: the pair is the base of one row
        and the top of the next, which a log may print once for both."""
        cost = 0.0
        if self.order(after) < self.order(before):
            cost += self.cfg.order_violation_cost + abs(self.vertical(before) - self.vertical(after))
        else:
            cost += jump_weight * max(0.0, self.vertical(after) - self.vertical(before))
        if set(before.words) & set(after.words):
            cost += self.cfg.reuse_boundary_cost if boundary else self.cfg.reuse_cost
        elif boundary and before.page == after.page and before.line == after.line:
            cost += self.cfg.split_boundary_cost  # one boundary printed twice on its line (e.g. a scale)
        return cost

    # -- assignment ------------------------------------------------------------------------------

    def chain(
        self,
        slots: Sequence[_Slot],
        local: Sequence[Callable[[Match], float]],
        boundary: Sequence[bool],
        jump_weight: float,
        undecided_only: bool = False,
    ) -> None:
        """Best monotone assignment of a sequence of values in printed order (Viterbi), keeping only the
        choices that beat every alternative of the same value by at least tie_margin (`undecided_only`:
        values placed by an earlier pass keep their place)."""
        n = len(slots)
        if n == 0:
            return
        cands = [s.candidates for s in slots]
        loc = [
            [local[i](m) + (self.cfg.used_cost if self.taken(slots[i], m) else 0.0) for m in cands[i]]
            for i in range(n)
        ]
        forward: list[list[float]] = [loc[0][:]]
        back: list[list[int]] = [[-1] * len(cands[0])]
        for i in range(1, n):
            row: list[float] = []
            arg: list[int] = []
            for c, mc in enumerate(cands[i]):
                best, best_p = math.inf, 0
                for p, mp in enumerate(cands[i - 1]):
                    value = forward[i - 1][p] + self.transition(mp, mc, boundary[i], jump_weight)
                    if value < best:
                        best, best_p = value, p
                row.append(best + loc[i][c])
                arg.append(best_p)
            forward.append(row)
            back.append(arg)
        backward: list[list[float]] = [[0.0] * len(c) for c in cands]
        for i in range(n - 2, -1, -1):
            for c, mc in enumerate(cands[i]):
                backward[i][c] = min(
                    self.transition(mc, mq, boundary[i + 1], jump_weight) + loc[i + 1][q] + backward[i + 1][q]
                    for q, mq in enumerate(cands[i + 1])
                )
        path = [0] * n
        path[-1] = min(range(len(cands[-1])), key=lambda c: forward[-1][c])
        for i in range(n - 1, 0, -1):
            path[i - 1] = back[i][path[i]]
        for i, slot in enumerate(slots):
            if undecided_only and slot.chosen is not None:
                continue
            chosen = cands[i][path[i]]
            if len(cands[i]) > 1:
                totals = sorted(forward[i][c] + backward[i][c] for c in range(len(cands[i])))
                if totals[1] - totals[0] < self.cfg.tie_margin:
                    continue
                before = cands[i - 1][path[i - 1]] if i > 0 else None
                after = cands[i + 1][path[i + 1]] if i + 1 < n else None
                if (before is not None and self.order(chosen) < self.order(before)) or (
                    after is not None and self.order(after) < self.order(chosen)
                ):
                    continue
            self.decide(slot, chosen)

    def alone(self, slot: _Slot, avoid: Mapping[int, tuple[float, float]] | None = None) -> None:
        """A value outside any row order: its only place, its only place no other value uses, or its only
        such place outside the table rows (`avoid`: vertical span of the rows per page)."""
        if slot.crowded or slot.chosen is not None:
            return
        cands = list(slot.candidates)
        if len(cands) == 1:
            self.decide(slot, cands[0])
            return
        pool = [m for m in cands if not self.taken(slot, m)] or cands
        if len(pool) == 1:
            self.decide(slot, pool[0])
            return
        if avoid:
            outside = [
                m
                for m in pool
                if m.page not in avoid or _gap(avoid[m.page][0], avoid[m.page][1], m.y0, m.y1) > 0
            ]
            if len(outside) == 1:
                self.decide(slot, outside[0])

    # -- record ----------------------------------------------------------------------------------

    @staticmethod
    def chosen(row: Mapping[str, _Slot], names: Iterable[str]) -> list[Match]:
        """The matches chosen so far for the named values of one row."""
        out: list[Match] = []
        for name in names:
            slot = row.get(name)
            if slot is not None and slot.chosen is not None:
                out.append(slot.chosen)
        return out

    def rows(self, items: Sequence[BaseModel], spec: _RowSpec) -> None:
        fields = (*spec.depths, *((spec.anchor,) if spec.anchor else ()), *spec.cells)
        table: list[dict[str, _Slot]] = []
        keys: list[tuple[float, float, int] | None] = []
        for i, item in enumerate(items):
            values = _raw_values(item, fields)
            slots = {
                name: slot
                for name, value in values.items()
                if (slot := self.slot(value, (spec.owner, i))) is not None
            }
            table.append(slots)
            depths = [self.depth_of(values[d]) if d in values else None for d in spec.depths]
            known = [d for d in depths if d is not None]
            keys.append((known[0], known[-1], i) if known else None)
        ordered = [i for i in sorted(range(len(items)), key=lambda i: keys[i] or (0.0, 0.0, i)) if keys[i]]

        # 1. The rows' main texts in depth order.
        if spec.anchor is not None:
            anchors = [s for i in ordered if _free(s := table[i].get(spec.anchor))]
            self.chain(anchors, [_no_cost] * len(anchors), [False] * len(anchors), 1.0)

        # 2. Depths top to bottom, near their row's main text.
        self.depth_pass(table, ordered, spec, (spec.anchor,) if spec.anchor else ())

        # 3. Every other cell near its row: the main text when found, else the depth values.
        for name in spec.cells:
            cells: list[_Slot] = []
            near: list[Callable[[Match], float]] = []
            for i in ordered:
                slot = table[i].get(name)
                if not _free(slot):
                    continue
                row = self.chosen(table[i], (spec.anchor,) if spec.anchor else ())
                cells.append(slot)
                near.append(self.near(row or self.chosen(table[i], spec.depths)))
            self.chain(cells, near, [False] * len(cells), 0.0)

        # 4. Rows without a main text: depths left open are placed near their row's cells.
        if spec.anchor is None and any(
            _free(s) and s.chosen is None for i in ordered for d in spec.depths if (s := table[i].get(d))
        ):
            self.depth_pass(table, ordered, spec, spec.cells, undecided_only=True)

        # Items without a readable depth: each value on its own.
        for i, slots in enumerate(table):
            if keys[i] is None:
                for slot in slots.values():
                    self.alone(slot)

    def depth_pass(
        self,
        table: Sequence[Mapping[str, _Slot]],
        ordered: Sequence[int],
        spec: _RowSpec,
        near_fields: Sequence[str],
        *,
        undecided_only: bool = False,
    ) -> None:
        """The rows' depth values as one chain top to bottom, each near the row's `near_fields` matches."""
        chain: list[_Slot] = []
        local: list[Callable[[Match], float]] = []
        boundaries: list[bool] = []
        previous: tuple[int, int] | None = None
        for position, i in enumerate(ordered):
            anchor = self.chosen(table[i], near_fields)
            for d, name in enumerate(spec.depths):
                slot = table[i].get(name)
                if not _free(slot):
                    continue
                boundary = (
                    spec.shared_boundary and previous == (position - 1, len(spec.depths) - 1) and d == 0
                )
                chain.append(slot)
                local.append(self.near(anchor))
                boundaries.append(boundary)
                previous = (position, d)
        self.chain(chain, local, boundaries, 1.0, undecided_only)

    def header(self, result: ExtractionResult, table_rows: Mapping[int, tuple[float, float]]) -> None:
        h = result.header
        values: list[RawValue] = [
            getattr(h, name) for name in type(h).model_fields if isinstance(getattr(h, name), RawValue)
        ]
        values += list(_raw_values(h.coordinates, type(h.coordinates).model_fields).values())
        for index, value in enumerate(values):
            slot = self.slot(value, ("header", index))
            if slot is not None:
                self.alone(slot, table_rows)

    def table_rows(self) -> dict[int, tuple[float, float]]:
        """Vertical span of the matched layer rows per page."""
        spans: dict[int, tuple[float, float]] = {}
        for slot in self.slots:
            if slot.owner[0] != "layer" or slot.chosen is None:
                continue
            m = slot.chosen
            top, bottom = spans.get(m.page, (m.y0, m.y1))
            spans[m.page] = (min(top, m.y0), max(bottom, m.y1))
        return spans

    def resolve(self, result: ExtractionResult) -> Resolution:
        for name, spec in ROWS:
            items = getattr(result, name)
            self.rows(items, spec)
        self.header(result, self.table_rows())
        return Resolution(
            (s.value, Hit(s.page, s.chosen.box if s.chosen is not None else None)) for s in self.slots
        )


def resolve_record(
    result: ExtractionResult,
    blocks: Mapping[str, BlockRef],
    pages: Mapping[int, PageText],
    *,
    page_key: Callable[[int], tuple[int, int]],
    depth_of: Callable[[RawValue], float | None],
    cfg: BoxConfig | None = None,
) -> Resolution:
    """Find every printed value of one extraction in the text layers of the pages it cites.

    `pages` holds the text layers by page number (pages without a trustworthy layer are ignored),
    `page_key` the group's reading order of pages and `depth_of` a value's depth in metres (orders rows).
    """
    cfg = cfg or config()
    if not pages:
        return Resolution()
    return _Resolver(blocks, pages, page_key, depth_of, cfg).resolve(result)


def locate_text(
    raw: str,
    blocks: Sequence[BlockRef],
    pages: Mapping[int, PageText],
    *,
    page_key: Callable[[int], tuple[int, int]],
    cfg: BoxConfig | None = None,
) -> Hit | None:
    """One text (not part of a record's order) inside `blocks`: found once -> its box; several times ->
    found without a box; not found or no trustworthy text layer -> None."""
    cfg = cfg or config()
    if not blocks or not raw.strip():
        return None
    page = min((b.page for b in blocks), key=page_key)
    text = pages.get(page)
    if text is None or not usable(text, cfg):
        return None
    on_page = [b for b in blocks if b.page == page]
    areas = None if any(b.box is None for b in on_page) else [b.box for b in on_page if b.box is not None]
    matches = find_runs(text, raw, areas, cfg=cfg)
    if not matches:
        return None
    return Hit(page, matches[0].box if len(matches) == 1 else None)
