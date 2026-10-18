"""Structured extraction per page group (BACKEND.md 7.6).

`build_input` turns a group's OCR blocks into text with inline block ids ("[[p7.b12]] 9,50"), the
document's context pages into a second text, and adds page images only where the OCR may be wrong
(handwriting partial/full, or a block below OCR_LOW_CONFIDENCE). The extractor model returns raw printed
text plus the block ids it came from (app.pipeline.schemas.ExtractionResult); Python normalises later.

`extract_group` is idempotent: a run is keyed by sha256(document sha256, group key, model, prompt and
schema versions, sha256 of the input), and a finished run with that key is reused without a call. An input
above EXTRACT_MAX_INPUT_TOKENS is split by page; each part is its own cached run and the parts are merged
(header from the first part with empty fields filled from later parts and the deepest printed final depth,
layers in depth order without exact duplicates, other lists concatenated).
Block ids the model cites that are not in the input are dropped and reported as warnings, never trusted.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol, TypeGuard

from PIL import Image
from sqlalchemy import select

from app.config import get_settings
from app.db.models import Document, ExtractionRun, OcrPage, Page
from app.db.session import get_sessionmaker
from app.din import din_codes
from app.ids import new_id
from app.normalize.lithology import valid_din_code
from app.normalize.numbers import after_field_label, parse_number
from app.normalize.units import canonical_unit, lab_tests, match_lab_test
from app.pipeline import textlayer
from app.pipeline.schemas import EXTRACTION_SCHEMA_VERSION, ExtractionResult
from app.pipeline.types import BlockRef, ExtractionInput, ExtractionOutcome, PageGroup
from app.providers.base import ProviderError, token_cost
from app.providers.llm import OutputTruncatedError, active_model, image_part, text_part
from app.storage import get_storage

logger = logging.getLogger("geomemory.pipeline.extract")

PROMPT_VERSION = "5"
PROMPT_FILE = "extractor.txt"
DIN_PLACEHOLDER = "{{DIN_CODES}}"
TESTS_PLACEHOLDER = "{{TEST_NAMES}}"

CHARS_PER_TOKEN = 3.5
IMAGE_TOKENS = 1_500  # rough input tokens of one page image, for the size estimate only
IMAGE_MAX_EDGE = 1600
IMAGE_HANDWRITING = frozenset({"partial", "full"})
# Output budget: strict JSON with raw text and block ids per value is several times the input text.
OUTPUT_TOKENS_FLOOR = 6_000
OUTPUT_TOKENS_CAP = 16_000
OUTPUT_TOKENS_PER_INPUT = 3

PAGE_SEPARATOR = "=== page {n}{role} ==="
NO_OCR_LINE = "(no OCR text for this page)"
LOG_PAGES_HEADING = "LOG PAGES"
CONTEXT_HEADING = "CONTEXT PAGES (other pages of the same document)"
RUN_DONE = "done"

# Mistral OCR writes a table into the page markdown as a link to its HTML: [tbl-0.html](tbl-0.html).
_TABLE_REF = re.compile(r"\[(tbl-[^\]\s]+)\]\(\1\)")
_TABLE_CELL = re.compile(r"<t[dh][\s>]", re.IGNORECASE)
_PARAGRAPHS = re.compile(r"\n\s*\n")


class NothingToExtractError(RuntimeError):
    """The group's pages have no OCR text and no image to read. The message is safe to show."""

    retryable = True


class Extractor(Protocol):
    async def extract(
        self, inp: ExtractionInput, *, document_id: str
    ) -> tuple[ExtractionResult, str | None, float]: ...


# ----------------------------------------------------------------------------------------------
# Prompt
# ----------------------------------------------------------------------------------------------


@lru_cache
def system_prompt() -> str:
    """data/prompts/extractor.txt with the DIN 4023 codes and Test Results names filled in from their data
    files (assets/din4023_patterns/din_codes.json, data/test_names.yaml)."""
    template = (get_settings().data_dir / "prompts" / PROMPT_FILE).read_text(encoding="utf-8")
    if DIN_PLACEHOLDER not in template or TESTS_PLACEHOLDER not in template:
        raise RuntimeError(f"{PROMPT_FILE} must contain {DIN_PLACEHOLDER} and {TESTS_PLACEHOLDER}")
    din = "\n".join(
        f"{code}: {entry.get('name_en') or entry.get('name_de') or code} ({entry.get('kind')})"
        for code, entry in din_codes().items()
    )
    tests = "\n".join(
        f"{spec.name} [{spec.unit}]: {', '.join(spec.aliases)}"
        if spec.aliases
        else f"{spec.name} [{spec.unit}]"
        for spec in lab_tests()
    )
    return template.replace(DIN_PLACEHOLDER, din).replace(TESTS_PLACEHOLDER, tests)


def output_tokens_for(estimated_input_tokens: int) -> int:
    """max_tokens for one call, sized to the input and capped."""
    wanted = OUTPUT_TOKENS_FLOOR + OUTPUT_TOKENS_PER_INPUT * max(0, estimated_input_tokens)
    return min(OUTPUT_TOKENS_CAP, wanted)


def message_content(inp: ExtractionInput) -> list[dict[str, Any]]:
    """User message parts: the group text, the context text, then each page image after its caption."""
    content = [text_part(inp.text)]
    if inp.context_text:
        content.append(text_part(f"{CONTEXT_HEADING}\n{inp.context_text}"))
    for n, png in inp.images:
        content.append(text_part(f"Image of page {n}:"))
        content.append(image_part("data:image/png;base64," + base64.b64encode(png).decode("ascii")))
    return content


class OpenRouterExtractor:
    """The extractor model on the configured provider (OpenRouter or OpenAI, app.providers.llm) with the
    strict ExtractionResult schema (budget checked by the client before every call)."""

    def __init__(self) -> None:
        from app.providers.llm import LlmClient

        self.client = LlmClient()

    async def extract(
        self, inp: ExtractionInput, *, document_id: str
    ) -> tuple[ExtractionResult, str | None, float]:
        model = self.client.model_for("extractor")
        max_tokens = output_tokens_for(inp.estimated_tokens)
        result = await self.client.structured(
            role="extractor",
            output=ExtractionResult,
            system=system_prompt(),
            content=message_content(inp),
            purpose="extract",
            document_id=document_id,
            max_tokens=max_tokens,
            estimate_usd=token_cost(model, inp.estimated_tokens, max_tokens),
        )
        return result.data, result.model, result.cost_usd


# ----------------------------------------------------------------------------------------------
# Input
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class PageSegment:
    """One page as the model sees it: separator line plus block lines, its blocks and (maybe) its image."""

    n: int
    text: str
    blocks: tuple[BlockRef, ...]
    image: bytes | None = None

    @property
    def tokens(self) -> int:
        return estimate_tokens(len(self.text) + 1, 1 if self.image is not None else 0)


def estimate_tokens(chars: int, images: int = 0) -> int:
    return math.ceil(chars / CHARS_PER_TOKEN) + IMAGE_TOKENS * images


def _defuse(text: str) -> str:
    """Block text in the prompt: text that imitates a block marker cannot pose as one."""
    return text.replace("[[", "[ [").replace("]]", "] ]")


def _box(value: Any) -> tuple[float, float, float, float] | None:
    if isinstance(value, list | tuple) and len(value) == 4:
        try:
            x, y, w, h = (float(v) for v in value)
        except (TypeError, ValueError):
            return None
        return (x, y, w, h)
    return None


def _confidence(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _table_text(table: Any) -> str:
    """ocr_pages.tables holds HTML strings; a provider-shaped {id, content} entry is read too."""
    if isinstance(table, Mapping):
        return str(table.get("content") or "")
    return str(table)


def _resolve_tables(text: str, tables: Sequence[str], order: Mapping[str, int]) -> tuple[str, bool]:
    """Replace table links ([tbl-0.html](tbl-0.html)) with the page's HTML tables. True when one was found."""
    found = False

    def swap(match: re.Match[str]) -> str:
        nonlocal found
        index = order.get(match.group(1))
        if index is None or index >= len(tables):
            return match.group(0)
        found = True
        return tables[index]

    return _TABLE_REF.sub(swap, text), found


def page_segment(
    n: int,
    *,
    role: str | None,
    blocks: Sequence[Mapping[str, Any]] | None,
    tables: Sequence[Any] | None,
    markdown: str | None,
    text_quality: float | None,
    handwriting: str | None,
) -> PageSegment:
    """Render one page's OCR. Pure: no I/O. Images are attached by the caller."""
    html = [_table_text(t) for t in tables or []]
    order = {ref: i for i, ref in enumerate(m.group(1) for m in _TABLE_REF.finditer(markdown or ""))}
    lines = [PAGE_SEPARATOR.format(n=n, role=f" ({role})" if role else "")]
    refs: list[BlockRef] = []
    table_ordinal = 0
    raw_blocks: list[Mapping[str, Any]] = list(blocks or [])
    if not raw_blocks and markdown and markdown.strip():
        # No block list (e.g. a page-level OCR fallback): one citable block per paragraph, without a box.
        raw_blocks = [
            {"id": f"p{n}.b{i}", "type": "text", "text": part, "box": None, "confidence": None}
            for i, part in enumerate(p for p in _PARAGRAPHS.split(markdown) if p.strip())
        ]
    for i, block in enumerate(raw_blocks):
        block_id = str(block.get("id") or f"p{n}.b{i}")
        text = str(block.get("text") or "")
        text, linked = _resolve_tables(text, html, order)
        if str(block.get("type") or "") == "table":
            if not linked and not _TABLE_CELL.search(text) and table_ordinal < len(html):
                text = html[table_ordinal]  # the block names a table without carrying its cells
            table_ordinal += 1
        text = text.strip()
        if not text:
            continue
        lines.append(f"[[{block_id}]] {_defuse(text)}")
        refs.append(
            BlockRef(
                id=block_id,
                page=n,
                text=text,
                box=_box(block.get("box")),
                confidence=_confidence(block.get("confidence")),
                page_text_quality=text_quality,
                page_handwriting=handwriting,
            )
        )
    if not refs:
        lines.append(NO_OCR_LINE)
    return PageSegment(n=n, text="\n".join(lines), blocks=tuple(refs))


def needs_image(segment: PageSegment, handwriting: str | None, low_confidence: float) -> bool:
    if not segment.blocks:
        return True  # nothing was read: the model reads the page image itself
    if handwriting in IMAGE_HANDWRITING:
        return True
    if all(b.box is None for b in segment.blocks):
        # Text-only OCR (no block positions): the layout, e.g. which depth in a column bounds which layer,
        # is only in the image.
        return True
    return any(b.confidence is not None and b.confidence < low_confidence for b in segment.blocks)


def _shrink_png(png: bytes) -> bytes:
    with Image.open(io.BytesIO(png)) as img:
        if max(img.width, img.height) <= IMAGE_MAX_EDGE and img.format == "PNG":
            return png
        scale = min(1.0, IMAGE_MAX_EDGE / max(img.width, img.height))
        size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
        out = io.BytesIO()
        img.convert("RGB").resize(size, Image.Resampling.LANCZOS).save(out, format="PNG", optimize=True)
        return out.getvalue()


def _render(render_key: str | None) -> bytes | None:
    storage = get_storage()
    if not render_key or not storage.exists(render_key):
        return None
    return _shrink_png(storage.get_bytes(render_key))


def task_line(group: PageGroup, part: tuple[int, int] | None = None) -> str:
    label = group.label_raw or "the borehole these pages describe (no label was identified)"
    line = f"Borehole to extract: {label}"
    if part is not None:
        line += (
            f" (part {part[0]} of {part[1]} of this borehole's pages; report what these pages print, "
            "including the header values they show)"
        )
    return line


def assemble(
    group: PageGroup,
    segments: Sequence[PageSegment],
    context: Sequence[PageSegment],
    *,
    part: tuple[int, int] | None = None,
) -> ExtractionInput:
    text = "\n".join([task_line(group, part), "", LOG_PAGES_HEADING, *(s.text for s in segments)])
    context_text = "\n".join(s.text for s in context)
    images = tuple((s.n, s.image) for s in segments if s.image is not None)
    blocks = {b.id: b for s in (*segments, *context) for b in s.blocks}
    chars = len(text) + len(context_text)
    return ExtractionInput(
        text=text,
        context_text=context_text,
        images=images,
        blocks=blocks,
        estimated_tokens=estimate_tokens(chars, len(images)),
    )


@dataclass(frozen=True)
class _Loaded:
    sha256: str
    segments: tuple[PageSegment, ...]
    context: tuple[PageSegment, ...]


def _text_layer_blocks(page: Page) -> list[dict[str, Any]] | None:
    """Blocks of a page's trustworthy text layer, line by line (None when it has none)."""
    threshold = textlayer.config().read_min_text_quality
    if page.text_layer_key is None or (page.text_layer_quality or 0.0) < threshold:
        return None
    storage = get_storage()
    try:
        payload = json.loads(storage.get_bytes(page.text_layer_key))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    return textlayer.line_blocks(textlayer.page_text_from_payload(page.n, payload)) or None


async def _load(document_id: str, group: PageGroup) -> _Loaded:
    numbers = set(group.pages) | set(group.context_pages)
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            raise LookupError(f"document {document_id} not found")
        pages = {
            p.n: p
            for p in (
                await session.scalars(
                    select(Page).where(Page.document_id == document_id, Page.n.in_(numbers))
                )
            ).all()
        }
        ocr = {
            o.n: o
            for o in (
                await session.scalars(
                    select(OcrPage).where(OcrPage.document_id == document_id, OcrPage.n.in_(numbers))
                )
            ).all()
        }
        sha256 = doc.sha256
    low = get_settings().ocr_low_confidence

    def segment(n: int) -> PageSegment:
        page, page_ocr = pages.get(n), ocr.get(n)
        blocks = page_ocr.blocks if page_ocr else None
        if page_ocr is None and page is not None and page.ocr_status == "skipped":
            blocks = _text_layer_blocks(page)  # not sent to OCR: its trustworthy text layer stands in
        return page_segment(
            n,
            role=page.role if page else None,
            blocks=blocks,
            tables=page_ocr.tables if page_ocr else None,
            markdown=page_ocr.markdown if page_ocr else None,
            text_quality=page.text_layer_quality if page else None,
            handwriting=page.handwriting if page else None,
        )

    segments: list[PageSegment] = []
    for n in group.pages:
        seg = segment(n)
        page = pages.get(n)
        handwriting = page.handwriting if page else None
        if page is not None and needs_image(seg, handwriting, low):
            image = await asyncio.to_thread(_render, page.render_key)
            if image is not None:
                blocks = seg.blocks
                text = seg.text
                if not blocks:
                    whole = BlockRef(
                        id=f"p{n}.b0",
                        page=n,
                        text="(no OCR text on this page; read the attached page image)",
                        box=(0.0, 0.0, 1.0, 1.0),
                        confidence=None,
                        page_text_quality=page.text_layer_quality,
                        page_handwriting=handwriting,
                    )
                    blocks = (whole,)
                    text = f"{seg.text}\n[[{whole.id}]] {whole.text}"
                seg = PageSegment(n=seg.n, text=text, blocks=blocks, image=image)
        segments.append(seg)
    context = tuple(segment(n) for n in group.context_pages if n not in group.pages)
    return _Loaded(sha256=sha256, segments=tuple(segments), context=context)


async def build_input(document_id: str, group: PageGroup) -> ExtractionInput:
    loaded = await _load(document_id, group)
    return assemble(group, loaded.segments, loaded.context)


# ----------------------------------------------------------------------------------------------
# Splitting and merging
# ----------------------------------------------------------------------------------------------


def split_segments(
    segments: Sequence[PageSegment], *, max_tokens: int, fixed_tokens: int
) -> list[list[PageSegment]]:
    """Consecutive pages per part so that each part stays under `max_tokens` (a single page that is larger
    on its own still gets a part)."""
    room = max(1, max_tokens - fixed_tokens)
    parts: list[list[PageSegment]] = []
    current: list[PageSegment] = []
    used = 0
    for seg in segments:
        if current and used + seg.tokens > room:
            parts.append(current)
            current, used = [], 0
        current.append(seg)
        used += seg.tokens
    if current:
        parts.append(current)
    return parts


def _is_raw_value(node: Any) -> TypeGuard[dict[str, Any]]:
    return isinstance(node, dict) and set(node) == {"raw", "block_ids", "state"}


def _fill_header(first: dict[str, Any], later: dict[str, Any]) -> None:
    """Fill header values the first part does not print from later parts (coordinates only as a whole)."""
    for name, value in first.items():
        other = later.get(name)
        if _is_raw_value(value):
            if value["raw"] is None and isinstance(other, dict) and other.get("raw") is not None:
                first[name] = other
        elif isinstance(value, dict) and isinstance(other, dict):
            empty = all(v.get("raw") is None for v in value.values() if _is_raw_value(v))
            if empty and any(v.get("raw") is not None for v in other.values() if _is_raw_value(v)):
                first[name] = other


def _deepest_total_depth(headers: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """The deepest final depth the parts print: a first sheet may give its own last base where the final
    depth goes, while the last sheet prints the final depth. None when no part prints a readable one or the
    parts print it in different units."""
    best: dict[str, Any] | None = None
    best_value = -math.inf
    unit_keys: set[str] = set()
    for head in headers:
        value = head.get("total_depth")
        if not _is_raw_value(value) or value["raw"] is None or value["state"] != "ok":
            continue
        number = parse_number(str(value["raw"]))
        if number.value is None and (bare := after_field_label(str(value["raw"]))) is not None:
            number = parse_number(bare)  # printed with its label ("Endtiefe 26,60 m")
        if number.value is None:
            continue
        if number.unit is not None:
            unit_keys.add(canonical_unit(number.unit) or number.unit)
        if abs(number.value) > best_value:
            best, best_value = value, abs(number.value)
    return best if len(unit_keys) <= 1 else None


def _norm_text(value: Any) -> str | None:
    if not _is_raw_value(value) or value["raw"] is None:
        return None
    return " ".join(str(value["raw"]).split())


def _layer_signature(layer: dict[str, Any]) -> tuple[str | None, ...] | None:
    signature = (
        _norm_text(layer["from_raw"]),
        _norm_text(layer["to_raw"]),
        _norm_text(layer["description_raw"]),
    )
    return None if all(s is None for s in signature) else signature


def _union_blocks(kept: dict[str, Any], duplicate: dict[str, Any]) -> None:
    for name, value in kept.items():
        other = duplicate.get(name)
        if _is_raw_value(value) and _is_raw_value(other):
            if value["raw"] is None and other["raw"] is not None:
                kept[name] = other
            elif value["raw"] == other["raw"]:
                value["block_ids"] = list(dict.fromkeys([*value["block_ids"], *other["block_ids"]]))
        elif value is None and other is not None:
            kept[name] = other


def _depth(value: Any) -> float | None:
    text = _norm_text(value)
    return None if text is None else parse_number(text).value


def _depth_order(layers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Stable sort by printed depth (top, else base); a layer without a readable depth keeps its place
    after the layer before it. Logs that count downwards (elevations) keep a descending order."""
    tops = [_depth(layer["from_raw"]) for layer in layers]
    bases = [_depth(layer["to_raw"]) for layer in layers]
    pairs = [(t, b) for t, b in zip(tops, bases, strict=True) if t is not None and b is not None]
    descending = sum(1 for t, b in pairs if b < t) > sum(1 for t, b in pairs if b > t)
    keys: list[float] = []
    last = -math.inf
    for top, base in zip(tops, bases, strict=True):
        value = top if top is not None else base
        if value is not None:
            last = -value if descending else value
        keys.append(last)
    order = sorted(range(len(layers)), key=lambda i: keys[i])
    return [layers[i] for i in order]


def _unique(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in items:
        key = json.dumps(item, sort_keys=True, ensure_ascii=False)
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def merge_results(parts: Sequence[ExtractionResult]) -> ExtractionResult:
    """One result from the parts of a split group, in page order."""
    if len(parts) == 1:
        return parts[0]
    dumps = [p.model_dump(mode="json") for p in parts]
    header: dict[str, Any] = dumps[0]["header"]
    for later in dumps[1:]:
        _fill_header(header, later["header"])
    deepest = _deepest_total_depth([dump["header"] for dump in dumps])
    if deepest is not None:
        header["total_depth"] = deepest
    layers: list[dict[str, Any]] = []
    by_signature: dict[tuple[str | None, ...], dict[str, Any]] = {}
    for dump in dumps:
        for layer in dump["layers"]:
            signature = _layer_signature(layer)
            if signature is not None and signature in by_signature:
                _union_blocks(by_signature[signature], layer)
                continue
            if signature is not None:
                by_signature[signature] = layer
            layers.append(layer)
    merged: dict[str, Any] = {"header": header, "layers": _depth_order(layers)}
    for name in ("spt", "core_runs", "groundwater", "samples", "tests"):
        # Context pages are sent with every part, so their rows can come back more than once.
        merged[name] = _unique([item for dump in dumps for item in dump[name]])
    return ExtractionResult.model_validate(merged)


# ----------------------------------------------------------------------------------------------
# Checking the model's answer
# ----------------------------------------------------------------------------------------------


def sanitize(result: ExtractionResult, blocks: Mapping[str, BlockRef]) -> tuple[ExtractionResult, list[str]]:
    """Drop cited block ids that are not in the input; blank raw text is null; null raw is never `ok`;
    DIN codes must be keys of din_codes.json; test names are mapped to Test Results names."""
    data = result.model_dump(mode="json")
    warnings: list[str] = []

    def walk(node: Any, path: str) -> None:
        if _is_raw_value(node):
            cited = [str(b) for b in node["block_ids"]]
            for bad in dict.fromkeys(b for b in cited if b not in blocks):
                warnings.append(f"{path}: block id {bad!r} is not in the input; dropped")
            node["block_ids"] = list(dict.fromkeys(b for b in cited if b in blocks))
            if isinstance(node["raw"], str) and not node["raw"].strip():
                node["raw"] = None
            if node["raw"] is None and node["state"] == "ok":
                node["state"] = "not_in_source"
        elif isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{path}.{key}" if path else key)
        elif isinstance(node, list):
            for i, item in enumerate(node):
                walk(item, f"{path}[{i}]")

    walk(data, "")
    for i, layer in enumerate(data["layers"]):
        code = layer.get("din4023_code")
        if code is not None:
            valid = valid_din_code(code)
            if valid is None:
                warnings.append(f"layers[{i}].din4023_code {code!r} is not a DIN 4023 code; set to null")
            layer["din4023_code"] = valid
    for i, test in enumerate(data["tests"]):
        name = match_lab_test(test.get("name"))
        if name is None:
            warnings.append(f"tests[{i}].name {test.get('name')!r} is not a Test Results name")
        else:
            test["name"] = name
    return ExtractionResult.model_validate(data), warnings


# ----------------------------------------------------------------------------------------------
# Runs
# ----------------------------------------------------------------------------------------------


def cache_key(sha256: str, key: str, model: str, inp: ExtractionInput) -> str:
    """sha256 over the document, group key, model, versions and a hash of everything the model reads."""
    content = hashlib.sha256()
    for piece in (system_prompt(), inp.text, inp.context_text):
        content.update(piece.encode("utf-8"))
        content.update(b"\x00")
    for n, png in inp.images:
        content.update(f"{n}:".encode())
        content.update(hashlib.sha256(png).digest())
    parts = [sha256, key, model, PROMPT_VERSION, EXTRACTION_SCHEMA_VERSION, content.hexdigest()]
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class _Run:
    id: str
    result: ExtractionResult
    model: str | None
    cost_usd: float
    input_tokens: int | None


async def _stored(key: str) -> _Run | None:
    async with get_sessionmaker()() as session:
        run = await session.scalar(select(ExtractionRun).where(ExtractionRun.cache_key == key))
        if run is None or run.status != RUN_DONE or run.output is None:
            return None
        try:
            result = ExtractionResult.model_validate(run.output)
        except ValueError:
            logger.warning("stored extraction run %s does not validate; extracting again", run.id)
            return None
        return _Run(run.id, result, run.model, float(run.cost_usd or 0.0), run.input_tokens)


async def _call(
    document_id: str,
    group_id: str,
    key: str,
    inp: ExtractionInput,
    extractor: Callable[[], Extractor],
) -> _Run:
    """Reuse the finished run with this key, or call the extractor and store the run."""
    stored = await _stored(key)
    if stored is not None:
        return stored
    model = active_model("extractor")
    async with get_sessionmaker()() as session:
        run = await session.scalar(select(ExtractionRun).where(ExtractionRun.cache_key == key))
        if run is None:
            run = ExtractionRun(
                id=new_id("ext"),
                document_id=document_id,
                group_id=group_id,
                cache_key=key,
                model=model,
                prompt_version=PROMPT_VERSION,
                schema_version=EXTRACTION_SCHEMA_VERSION,
                input_tokens=inp.estimated_tokens,
                status="running",
            )
            session.add(run)
        else:
            run.status, run.error = "running", None
        await session.commit()
        run_id = run.id
    try:
        result, returned_model, cost = await extractor().extract(inp, document_id=document_id)
    except ProviderError as exc:
        async with get_sessionmaker()() as session:
            failed = await session.get(ExtractionRun, run_id)
            if failed is not None:
                failed.status, failed.error = "failed", str(exc)
                await session.commit()
        raise
    async with get_sessionmaker()() as session:
        done = await session.get(ExtractionRun, run_id)
        if done is not None:
            done.status, done.error = RUN_DONE, None
            done.output = result.model_dump(mode="json")
            done.model = returned_model or model
            done.cost_usd = cost
            done.input_tokens = inp.estimated_tokens
            await session.commit()
    return _Run(run_id, result, returned_model or model, cost, inp.estimated_tokens)


async def _store_merged(
    document_id: str, group_id: str, key: str, result: ExtractionResult, parts: Sequence[_Run]
) -> str:
    """The merged answer of a split group as one finished run under the whole input's key."""
    model = next((p.model for p in parts if p.model), active_model("extractor"))
    async with get_sessionmaker()() as session:
        run = await session.scalar(select(ExtractionRun).where(ExtractionRun.cache_key == key))
        if run is None:
            run = ExtractionRun(
                id=new_id("ext"),
                document_id=document_id,
                group_id=group_id,
                cache_key=key,
                prompt_version=PROMPT_VERSION,
                schema_version=EXTRACTION_SCHEMA_VERSION,
                status=RUN_DONE,
            )
            session.add(run)
        run.status, run.error = RUN_DONE, None
        run.model = model
        run.output = result.model_dump(mode="json")
        run.cost_usd = sum(p.cost_usd for p in parts)
        run.input_tokens = sum(p.input_tokens or 0 for p in parts)
        await session.commit()
        return run.id


async def extract_group(
    document_id: str, group: PageGroup, *, extractor: Extractor | None = None
) -> ExtractionOutcome:
    """Extract one group (cached); see the module docstring. `cost_usd` is the cost of the run(s) the
    result came from, also when they are reused."""
    loaded = await _load(document_id, group)
    if not any(s.blocks or s.image is not None for s in loaded.segments):
        raise NothingToExtractError(
            f"No text could be read on pages {', '.join(map(str, group.pages))}. Retry the document's OCR."
        )
    inp = assemble(group, loaded.segments, loaded.context)
    model = active_model("extractor")
    key = cache_key(loaded.sha256, group.key, model, inp)
    instance: list[Extractor] = [extractor] if extractor is not None else []

    def get_extractor() -> Extractor:
        if not instance:
            instance.append(OpenRouterExtractor())  # only built when a call is needed
        return instance[0]

    max_tokens = get_settings().extract_max_input_tokens
    parts = [list(loaded.segments)]
    if inp.estimated_tokens > max_tokens:
        fixed = assemble(group, [], loaded.context, part=(1, 1)).estimated_tokens
        parts = split_segments(loaded.segments, max_tokens=max_tokens, fixed_tokens=fixed)
    warnings = [f"input split into {len(parts)} parts by page"] if len(parts) > 1 else []
    stored = await _stored(key)
    if stored is not None:
        run_id, result, returned_model, cost = stored.id, stored.result, stored.model, stored.cost_usd
    else:
        if len(parts) == 1:
            try:
                run = await _call(document_id, group.key, key, inp, get_extractor)
            except OutputTruncatedError:
                if len(loaded.segments) < 2:
                    raise
                # The whole log did not fit in one answer: extract it page by page (each part cached).
                parts = [[segment] for segment in loaded.segments]
                warnings.append(f"answer cut off; extracted page by page in {len(parts)} parts")
                run = None
            if run is not None:
                run_id, result, returned_model, cost = run.id, run.result, run.model, run.cost_usd
        if len(parts) > 1:
            runs: list[_Run] = []
            for i, segments in enumerate(parts, start=1):
                part_inp = assemble(group, segments, loaded.context, part=(i, len(parts)))
                part_id = f"{group.key}#{i}/{len(parts)}"
                part_key = cache_key(loaded.sha256, part_id, model, part_inp)
                runs.append(await _call(document_id, part_id, part_key, part_inp, get_extractor))
            result = merge_results([r.result for r in runs])
            run_id = await _store_merged(document_id, group.key, key, result, runs)
            returned_model = next((r.model for r in runs if r.model), model)
            cost = sum(r.cost_usd for r in runs)
    checked, problems = sanitize(result, inp.blocks)
    warnings.extend(problems)
    if problems:
        logger.info("extraction of %s/%s: %d warning(s)", document_id, group.key, len(problems))
    return ExtractionOutcome(
        result=checked,
        blocks=inp.blocks,
        run_id=run_id,
        model=returned_model,
        cost_usd=cost,
        warnings=tuple(warnings),
    )
