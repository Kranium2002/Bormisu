"""Second reads of handwritten and low-confidence values (BACKEND.md 7.7).

After extraction, every value a machine read from a page (provenance method `ocr` or `read`, unreviewed, with
a box) whose confidence is below OCR_LOW_CONFIDENCE, or that lies on a page the classifier marked as partly or
fully handwritten, is read a second time: its box is cropped from the page render (plus a margin, at least a
minimum size), and the crops go in batches to the extractor model, which transcribes each crop exactly
(data/prompts/reread.txt, strict schema: per crop id the text or null plus a legibility).

A box usually holds more than the value (an OCR block is a line, a cell or a paragraph), so the comparison is
made on tokens: the OCR text of the blocks inside the crop is aligned with the second transcription, and the
value's printed text is located in the OCR text. Numbers are compared after number normalisation
(app.normalize.numbers), other text case- and space-insensitively.
- Agreement: the confidence is raised to the higher of the two readings; the value stays unreviewed.
- Disagreement: provenance.readings holds both readings (`ocr` and `reread`); the value is unchanged and
  unreviewed, and the borehole gets ONE `choose_reading` question listing all its disagreements (one field per
  value; the clarification `path` is set when exactly one value disagrees, else null and each field is named
  by its value path).
- When the value cannot be located in either reading, nothing changes.
Every change goes through the review service (a revision by actor `pipeline` with its events).

Idempotent and resumable: each crop's reading is cached in `extraction_runs` (group_id `reread:<document>`)
under a key of its pixels, the model and the prompt and schema versions, so a rerun never pays again, and the
question has a dedupe key per borehole. A failed second read never fails the document: it is logged, the
values stay as they are and nothing is added. Thresholds, crop sizes and labels live in data/reread.yaml.
"""

from __future__ import annotations

import asyncio
import base64
import difflib
import hashlib
import html
import io
import logging
import math
import re
import unicodedata
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Literal, Protocol

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.clarify.service import clarification_out, create_clarification
from app.config import get_settings
from app.db.models import Borehole, Clarification, Document, ExtractionRun, FieldValue, OcrPage, Page
from app.db.session import get_sessionmaker
from app.events.writer import emit
from app.ids import new_id
from app.normalize.numbers import MINUS_SIGNS, learn_style, load_data, parse_number
from app.pipeline.extract import page_segment
from app.providers.base import ProviderError, token_cost
from app.providers.llm_openrouter import image_part, text_part
from app.review.service import commit_change, load_field_values
from app.schemas.clarifications import Evidence, FormField
from app.storage import get_storage

logger = logging.getLogger("geomemory.pipeline.reread")

PROMPT_FILE = "reread.txt"
CONFIG_FILE = "reread.yaml"
PROMPT_VERSION = "1"
SCHEMA_VERSION = "reread-1"
RUN_DONE = "done"
ACTOR = "pipeline"
ACTION = "reread"
READER_OCR = "ocr"
READER_REREAD = "reread"
KIND = "choose_reading"
SINGLE_FIELD_NAME = "reading"
UNRESOLVED = ("open", "skipped")

Box = tuple[float, float, float, float]
Rect = tuple[int, int, int, int]
LegibilityLiteral = Literal["clear", "unsure", "illegible"]


def _now() -> datetime:
    return datetime.now(UTC)


# ----------------------------------------------------------------------------------------------
# Configuration and prompt (data/reread.yaml, data/prompts/reread.txt)
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RereadConfig:
    methods: frozenset[str]
    handwriting: frozenset[str]
    margin: float
    min_px: int
    max_edge_px: int
    block_share: float
    batch_size: int
    legibility_confidence: Mapping[str, float]
    output_base: int
    output_per_crop: int
    input_base: int
    input_per_crop: int
    tight_slack_chars: int
    section_labels: Mapping[str, str]
    field_labels: Mapping[str, str]
    unit_labels: Mapping[str, str]


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


@lru_cache(maxsize=1)
def reread_config() -> RereadConfig:
    data = load_data(CONFIG_FILE)
    crop = _mapping(data.get("crop"))
    tokens = _mapping(data.get("tokens"))
    labels = _mapping(data.get("labels"))
    return RereadConfig(
        methods=frozenset(str(m) for m in data.get("methods") or ()),
        handwriting=frozenset(str(h) for h in data.get("handwriting") or ()),
        margin=float(crop.get("margin", 0.0)),
        min_px=int(crop.get("min_px", 1)),
        max_edge_px=int(crop.get("max_edge_px", 1024)),
        block_share=float(crop.get("block_share", 0.5)),
        batch_size=max(1, int(data.get("batch_size", 1))),
        legibility_confidence={
            str(k): float(v) for k, v in _mapping(data.get("legibility_confidence")).items()
        },
        output_base=int(tokens.get("output_base", 200)),
        output_per_crop=int(tokens.get("output_per_crop", 120)),
        input_base=int(tokens.get("input_base", 700)),
        input_per_crop=int(tokens.get("input_per_crop", 250)),
        tight_slack_chars=int(data.get("tight_slack_chars", 0)),
        section_labels={str(k): str(v) for k, v in _mapping(labels.get("sections")).items()},
        field_labels={str(k): str(v) for k, v in _mapping(labels.get("fields")).items()},
        unit_labels={str(k): str(v) for k, v in _mapping(labels.get("units")).items()},
    )


@lru_cache(maxsize=1)
def system_prompt() -> str:
    return (get_settings().data_dir / "prompts" / PROMPT_FILE).read_text(encoding="utf-8")


def prompt_digest() -> str:
    return hashlib.sha256(system_prompt().encode("utf-8")).hexdigest()


# ----------------------------------------------------------------------------------------------
# The model's answer (strict schema) and the reader interface
# ----------------------------------------------------------------------------------------------


class CropReading(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(description='The crop id exactly as given, e.g. "c3".')
    text: str | None = Field(
        description="Exact transcription of the text in the crop, lines in reading order separated by one "
        "space; null when nothing can be read."
    )
    legibility: LegibilityLiteral


class RereadAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    readings: list[CropReading]


@dataclass(frozen=True)
class CropImage:
    """One crop as a reader receives it. `ocr_text` (what the OCR read inside the crop) and `printed` (the
    printed text of the values in it) are for logs and test doubles only; the model never sees them, so the
    second read stays independent."""

    id: str
    png: bytes
    ocr_text: str = ""
    printed: str = ""


class Rereader(Protocol):
    async def reread(
        self, crops: Sequence[CropImage], *, document_id: str
    ) -> tuple[RereadAnswer, str | None, float]: ...


def output_tokens_for(crops: int) -> int:
    config = reread_config()
    return config.output_base + config.output_per_crop * max(0, crops)


def input_tokens_for(crops: int) -> int:
    config = reread_config()
    return config.input_base + config.input_per_crop * max(0, crops)


class OpenRouterRereader:
    """The extractor model on OpenRouter, strict RereadAnswer schema; the client checks the budget."""

    def __init__(self) -> None:
        from app.providers.llm_openrouter import OpenRouterClient

        self.client = OpenRouterClient()

    async def reread(
        self, crops: Sequence[CropImage], *, document_id: str
    ) -> tuple[RereadAnswer, str | None, float]:
        model = get_settings().extractor_model
        content: list[dict[str, Any]] = [
            text_part(f"{len(crops)} crop(s). Transcribe each one exactly as written.")
        ]
        for crop in crops:
            content.append(text_part(f"Crop {crop.id}:"))
            content.append(image_part("data:image/png;base64," + base64.b64encode(crop.png).decode("ascii")))
        max_tokens = output_tokens_for(len(crops))
        result = await self.client.structured(
            model=model,
            output=RereadAnswer,
            system=system_prompt(),
            content=content,
            purpose="reread",
            document_id=document_id,
            max_tokens=max_tokens,
            estimate_usd=token_cost(model, input_tokens_for(len(crops)), max_tokens),
        )
        return result.data, result.model, result.cost_usd


# ----------------------------------------------------------------------------------------------
# Comparison (pure)
# ----------------------------------------------------------------------------------------------

_GROUP_SPACES = "    "
# A number with separators (a grouping space only before exactly three digits), a run of letters, or one
# other visible character. A trailing separator is not part of the number.
_TOKEN = re.compile(rf"\d(?:[\d.,'’]|[{_GROUP_SPACES}](?=\d{{3}}(?!\d)))*(?<![.,'’])|[^\W\d_]+|[^\s\w]|_")
# Layout marks of OCR markdown and tables that a transcription does not repeat.
_MARKUP = frozenset("|*#_`~")
_HTML_TAG = re.compile(r"<[^>]+>")
_MINUS = {sign: "-" for sign in MINUS_SIGNS}


@dataclass(frozen=True)
class Token:
    text: str
    canon: str
    start: int
    end: int
    core: bool = True


def _canonical(token: str) -> str:
    if token[:1].isdigit():
        parsed = parse_number(token)
        if parsed.value is not None and not parsed.ambiguous:
            return f"#{parsed.value!r}"
        return "#" + re.sub(r"\s", "", token)
    text = unicodedata.normalize("NFKC", token).casefold()
    return _MINUS.get(text, text)


def tokens(text: str, *, core: bool = True) -> list[Token]:
    """Comparable tokens of a text: numbers (normalised), words (case-folded) and single symbols."""
    out: list[Token] = []
    for match in _TOKEN.finditer(text):
        piece = match.group(0)
        if piece in _MARKUP:
            continue
        out.append(Token(piece, _canonical(piece), match.start(), match.end(), core))
    return out


def plain_text(text: str) -> str:
    """Block text without HTML tags or entities (tables are HTML)."""
    return " ".join(html.unescape(_HTML_TAG.sub(" ", text)).split())


@dataclass(frozen=True)
class Verdict:
    kind: Literal["agree", "disagree", "unknown"]
    text: str | None = None  # the second reader's text for the value (disagree only)


AGREE = Verdict("agree")
UNKNOWN = Verdict("unknown")


def _occurrences(seq: Sequence[str], sub: Sequence[str]) -> list[int]:
    n = len(sub)
    return [i for i in range(len(seq) - n + 1) if list(seq[i : i + n]) == list(sub)]


def _span_text(text: str, toks: Sequence[Token], first: int, last: int) -> str:
    return " ".join(text[toks[first].start : toks[last].end].split())


def _map_span(
    opcodes: Sequence[tuple[str, int, int, int, int]],
    start: int,
    end: int,
    second: Sequence[Token],
    second_text: str,
) -> Verdict:
    """What the second reading says for the first reading's tokens [start, end)."""
    collected: list[int] = []
    changed = False
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "insert":
            if start < i1 < end:  # text the second reader saw inside the value
                collected.extend(range(j1, j2))
                changed = True
            continue
        if i2 <= start or i1 >= end:
            continue
        lo, hi = max(start, i1), min(end, i2)
        if tag == "equal":
            collected.extend(range(j1 + lo - i1, j1 + hi - i1))
        elif tag == "replace" and i2 - i1 == j2 - j1:  # token for token
            collected.extend(range(j1 + lo - i1, j1 + hi - i1))
            changed = True
        else:
            if i1 < start or i2 > end:
                # The change runs past the value: its boundary in the second reading is unclear.
                return UNKNOWN
            collected.extend(range(j1, j2))
            changed = True
    if not changed:
        return AGREE
    if not collected:
        return UNKNOWN  # the second reader saw nothing where the value is
    return Verdict("disagree", _span_text(second_text, second, min(collected), max(collected)))


def _squashed_length(text: str) -> int:
    return len("".join(unicodedata.normalize("NFKC", text).split()))


def compare(
    raw: str, ocr_blocks: Sequence[tuple[str, bool]], second: str, *, slack: int | None = None
) -> Verdict:
    """Compare a value's printed text (`raw`) with a second transcription of its crop.

    `ocr_blocks` are the OCR texts inside the crop in reading order, each flagged True when it lies inside the
    value's own box. The value is located in the OCR text and aligned with the second transcription. `slack`
    (characters, default from data/reread.yaml) bounds how much longer than the value both readings of a
    box may be for the whole second reading to count as the value's reading when the value is not in the
    OCR text.
    """
    value = tokens(raw)
    other = tokens(second)
    if not value or not other:
        return UNKNOWN
    value_canon = [t.canon for t in value]
    other_canon = [t.canon for t in other]
    if value_canon == other_canon:
        return AGREE
    ocr = [t for text, core in ocr_blocks for t in tokens(plain_text(text), core=core)]
    ocr_canon = [t.canon for t in ocr]
    everywhere = _occurrences(ocr_canon, value_canon)
    inside = [s for s in everywhere if all(ocr[k].core for k in range(s, s + len(value)))]
    # The value is read where its own box is, never from a neighbouring block.
    found = inside if inside or any(t.core for t in ocr) else everywhere
    if not found:
        # The printed text is not in the OCR text of its box (the extractor read it from the image, or
        # composed it).
        if _occurrences(other_canon, value_canon):
            return UNKNOWN if everywhere else AGREE  # also printed in a neighbouring block: cannot tell
        if ocr_canon == other_canon:
            return UNKNOWN  # both readers agree on the box; the value is not printed there as such
        limit = _squashed_length(raw) + (reread_config().tight_slack_chars if slack is None else slack)
        core = " ".join(text for text, in_box in ocr_blocks if in_box)
        if _squashed_length(second) <= limit and _squashed_length(plain_text(core)) <= limit:
            # Both readers saw no more than the value in its box: the whole second reading is its reading.
            return Verdict("disagree", " ".join(second.split()))
        return UNKNOWN
    opcodes = difflib.SequenceMatcher(None, ocr_canon, other_canon, autojunk=False).get_opcodes()
    verdicts = {_map_span(opcodes, s, s + len(value), other, second) for s in found}
    if len(verdicts) == 1:
        return verdicts.pop()
    return AGREE if all(v.kind == "agree" for v in verdicts) else UNKNOWN


def reading_value(current: Any, raw: str, text: str) -> tuple[bool, Any]:
    """The value a reading stands for, in the stored value's type and unit; (False, None) when it cannot be
    known (the stored value is not a plain copy or a linear conversion of the printed text)."""
    if current is None or isinstance(current, bool):
        return False, None
    if isinstance(current, str):
        if " ".join(current.split()) != " ".join(raw.split()):
            return False, None
        cleaned = " ".join(text.split())
        return (True, cleaned) if cleaned else (False, None)
    if not isinstance(current, int | float):
        return False, None
    style = learn_style([raw, text])
    printed, other = parse_number(raw, style=style).value, parse_number(text, style=style).value
    if printed is None or other is None:
        return False, None
    if printed == current:
        number = other
    elif printed != 0:
        number = round(other * (float(current) / printed), 6)  # the unit conversion of the printed value
    else:
        return False, None
    if not math.isfinite(number):
        return False, None
    if isinstance(current, int):
        if not float(number).is_integer():
            return False, None
        return True, int(number)
    return True, float(number)


# ----------------------------------------------------------------------------------------------
# Candidates and crops
# ----------------------------------------------------------------------------------------------


def as_box(value: Any) -> Box | None:
    if not isinstance(value, list | tuple) or len(value) != 4:
        return None
    try:
        x, y, w, h = (float(v) for v in value)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
        return None
    return (x, y, w, h)


def is_candidate(
    fv: FieldValue, handwriting: str | None, *, low_confidence: float, config: RereadConfig
) -> bool:
    """A machine-read, unreviewed value with a box and printed text that is low-confidence or handwritten."""
    if fv.method not in config.methods or fv.status != "unreviewed" or fv.state != "ok":
        return False
    if fv.readings or fv.value is None or fv.cell is not None:
        return False
    if not (fv.raw or "").strip() or fv.page is None or as_box(fv.box) is None:
        return False
    low = fv.confidence is not None and fv.confidence < low_confidence
    return low or handwriting in config.handwriting


@dataclass(frozen=True)
class Candidate:
    uid: str
    path: str
    raw: str
    page: int
    box: Box


def crop_rect(box: Box, width: int, height: int, *, margin: float, min_px: int) -> Rect | None:
    """Pixel rectangle (left, top, right, bottom) of a normalised box plus margin, at least min_px a side."""
    x, y, w, h = box
    left, right = (x - margin * w) * width, (x + w + margin * w) * width
    top, bottom = (y - margin * h) * height, (y + h + margin * h) * height
    if right - left < min_px:
        centre = (left + right) / 2
        left, right = centre - min_px / 2, centre + min_px / 2
    if bottom - top < min_px:
        centre = (top + bottom) / 2
        top, bottom = centre - min_px / 2, centre + min_px / 2
    eps = 1e-6  # float noise must not add a pixel
    rect = (
        max(0, math.floor(left + eps)),
        max(0, math.floor(top + eps)),
        min(width, math.ceil(right - eps)),
        min(height, math.ceil(bottom - eps)),
    )
    if rect[2] - rect[0] < 1 or rect[3] - rect[1] < 1:
        return None
    return rect


def _share_inside(box: Box, area: Box) -> float:
    """The share of `box` that lies inside `area` (0-1)."""
    x, y, w, h = box
    ax, ay, aw, ah = area
    width = max(0.0, min(x + w, ax + aw) - max(x, ax))
    height = max(0.0, min(y + h, ay + ah) - max(y, ay))
    return width * height / (w * h) if w > 0 and h > 0 else 0.0


def blocks_in_crop(
    blocks: Iterable[tuple[str, Box | None]], crop: Box, value_box: Box, *, share: float
) -> list[tuple[str, bool]]:
    """OCR texts of the blocks lying (at least `share` of their area) inside the crop, in reading order, each
    flagged when it lies inside the value's box the same way. A block much larger than a tight value box (a
    whole line around one word) is left out: its text is not what the crop shows."""
    found: list[tuple[str, bool]] = []
    for text, box in blocks:
        if box is None or box[2] <= 0 or box[3] <= 0:
            continue
        if _share_inside(box, crop) >= share:
            found.append((text, _share_inside(box, value_box) >= share))
    return found


def pixel_hash(image: Image.Image) -> str:
    digest = hashlib.sha256(f"{image.mode}:{image.width}x{image.height}:".encode())
    digest.update(image.tobytes())
    return digest.hexdigest()


def crop_key(pixels: str, model: str) -> str:
    parts = ["reread", pixels, model, PROMPT_VERSION, SCHEMA_VERSION, prompt_digest()]
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


@dataclass
class PreparedCrop:
    key: str
    png: bytes
    page: int
    box: Box
    ocr_blocks: list[tuple[str, bool]]
    values: list[Candidate] = field(default_factory=list)

    @property
    def ocr_text(self) -> str:
        return " ".join(plain_text(text) for text, _ in self.ocr_blocks)

    @property
    def printed(self) -> str:
        return " ".join(dict.fromkeys(" ".join(v.raw.split()) for v in self.values))


def _cut(image: Image.Image, rect: Rect, max_edge: int) -> Image.Image:
    piece = image.crop(rect)
    longest = max(piece.width, piece.height)
    if longest > max_edge:
        scale = max_edge / longest
        size = (max(1, round(piece.width * scale)), max(1, round(piece.height * scale)))
        piece = piece.resize(size, Image.Resampling.LANCZOS)
    return piece


def make_crops(
    renders: Mapping[int, bytes],
    regions: Mapping[tuple[int, Box], list[Candidate]],
    blocks: Mapping[int, list[tuple[str, Box | None]]],
    *,
    model: str,
    config: RereadConfig,
) -> list[PreparedCrop]:
    """One crop per distinct (page, box); identical pixels share one crop. Pure apart from Pillow."""
    crops: dict[str, PreparedCrop] = {}
    by_page: dict[int, list[tuple[Box, list[Candidate]]]] = {}
    for (page, box), values in regions.items():
        by_page.setdefault(page, []).append((box, values))
    for page, items in sorted(by_page.items()):
        png = renders.get(page)
        if png is None:
            logger.info("no render of page %s; %d value(s) not re-read", page, sum(len(v) for _, v in items))
            continue
        with Image.open(io.BytesIO(png)) as opened:
            image = opened.convert("RGB")
        for box, values in sorted(items, key=lambda item: (item[0][1], item[0][0])):
            rect = crop_rect(box, image.width, image.height, margin=config.margin, min_px=config.min_px)
            if rect is None:
                continue
            piece = _cut(image, rect, config.max_edge_px)
            key = crop_key(pixel_hash(piece), model)
            if key in crops:
                crops[key].values.extend(values)
                continue
            out = io.BytesIO()
            piece.save(out, format="PNG")
            crop_box = (
                rect[0] / image.width,
                rect[1] / image.height,
                (rect[2] - rect[0]) / image.width,
                (rect[3] - rect[1]) / image.height,
            )
            crops[key] = PreparedCrop(
                key=key,
                png=out.getvalue(),
                page=page,
                box=box,
                ocr_blocks=blocks_in_crop(blocks.get(page, []), crop_box, box, share=config.block_share),
                values=list(values),
            )
    return list(crops.values())


# ----------------------------------------------------------------------------------------------
# Loading
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Loaded:
    regions: dict[tuple[int, Box], list[Candidate]]
    render_keys: dict[int, str]
    blocks: dict[int, list[tuple[str, Box | None]]]
    count: int


async def _load(document_id: str) -> _Loaded:
    settings = get_settings()
    config = reread_config()
    async with get_sessionmaker()() as session:
        pages = {
            p.n: p for p in (await session.scalars(select(Page).where(Page.document_id == document_id))).all()
        }
        uids = (
            await session.scalars(
                select(Borehole.uid).where(Borehole.document_id == document_id).order_by(Borehole.uid)
            )
        ).all()
        values: list[FieldValue] = []
        if uids:
            values = list(
                (
                    await session.scalars(
                        select(FieldValue)
                        .where(FieldValue.uid.in_(uids))
                        .order_by(FieldValue.uid, FieldValue.path)
                    )
                ).all()
            )
        regions: dict[tuple[int, Box], list[Candidate]] = {}
        count = 0
        for fv in values:
            if fv.document_id not in (None, document_id) or fv.page not in pages:
                continue
            page = pages[fv.page]
            if not is_candidate(
                fv, page.handwriting, low_confidence=settings.ocr_low_confidence, config=config
            ):
                continue
            box = as_box(fv.box)
            assert box is not None and fv.page is not None and fv.raw is not None
            regions.setdefault((fv.page, box), []).append(
                Candidate(uid=fv.uid, path=fv.path, raw=fv.raw, page=fv.page, box=box)
            )
            count += 1
        numbers = sorted({page for page, _ in regions})
        ocr_pages: dict[int, OcrPage] = {}
        if numbers:
            ocr_pages = {
                o.n: o
                for o in (
                    await session.scalars(
                        select(OcrPage).where(OcrPage.document_id == document_id, OcrPage.n.in_(numbers))
                    )
                ).all()
            }
    blocks: dict[int, list[tuple[str, Box | None]]] = {}
    for n in numbers:
        page_ocr = ocr_pages.get(n)
        if page_ocr is None:
            continue
        segment = page_segment(
            n,
            role=None,
            blocks=page_ocr.blocks,
            tables=page_ocr.tables,
            markdown=page_ocr.markdown,
            text_quality=None,
            handwriting=None,
        )
        blocks[n] = [(b.text, as_box(b.box)) for b in segment.blocks]
    render_keys = {n: key for n in numbers if (key := pages[n].render_key)}
    return _Loaded(regions=regions, render_keys=render_keys, blocks=blocks, count=count)


def _read_renders(keys: Mapping[int, str]) -> dict[int, bytes]:
    storage = get_storage()
    return {n: storage.get_bytes(key) for n, key in keys.items() if storage.exists(key)}


# ----------------------------------------------------------------------------------------------
# Cached readings (extraction_runs, group_id reread:<document>)
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SecondRead:
    text: str | None
    legibility: str

    def confidence(self, config: RereadConfig) -> float | None:
        return config.legibility_confidence.get(self.legibility)


def group_id_for(document_id: str) -> str:
    return f"reread:{document_id}"


async def cached_reads(document_id: str) -> dict[str, SecondRead]:
    async with get_sessionmaker()() as session:
        outputs = (
            await session.scalars(
                select(ExtractionRun.output).where(
                    ExtractionRun.document_id == document_id,
                    ExtractionRun.group_id == group_id_for(document_id),
                    ExtractionRun.status == RUN_DONE,
                )
            )
        ).all()
    reads: dict[str, SecondRead] = {}
    for output in outputs:
        items = output.get("reads") if isinstance(output, dict) else None
        if not isinstance(items, dict):
            continue
        for key, item in items.items():
            if isinstance(item, dict):
                text = item.get("text")
                reads[str(key)] = SecondRead(
                    text if isinstance(text, str) else None, str(item.get("legibility") or "missing")
                )
    return reads


def batch_key(keys: Iterable[str]) -> str:
    return hashlib.sha256("\x1f".join(["reread-batch", *sorted(keys)]).encode("utf-8")).hexdigest()


async def _start_run(document_id: str, key: str, crops: int) -> str:
    async with get_sessionmaker()() as session:
        run = await session.scalar(select(ExtractionRun).where(ExtractionRun.cache_key == key))
        if run is None:
            run = ExtractionRun(
                id=new_id("ext"),
                document_id=document_id,
                group_id=group_id_for(document_id),
                cache_key=key,
                model=get_settings().extractor_model,
                prompt_version=PROMPT_VERSION,
                schema_version=SCHEMA_VERSION,
                input_tokens=input_tokens_for(crops),
                status="running",
            )
            session.add(run)
        else:
            run.status, run.error = "running", None
        await session.commit()
        return run.id


async def _finish_run(
    run_id: str, *, output: dict[str, Any] | None, model: str | None, cost: float, error: str | None
) -> None:
    async with get_sessionmaker()() as session:
        run = await session.get(ExtractionRun, run_id)
        if run is None:
            return
        if error is not None:
            run.status, run.error = "failed", error
        else:
            run.status, run.error, run.output = RUN_DONE, None, output
            run.model = model or run.model
            run.cost_usd = cost
        await session.commit()


async def read_batch(
    document_id: str, batch: Sequence[PreparedCrop], get_reader: Callable[[], Rereader]
) -> dict[str, SecondRead]:
    """One model call for up to batch_size crops; the readings are stored before they are used."""
    run_id = await _start_run(document_id, batch_key(c.key for c in batch), len(batch))
    images = [
        CropImage(id=f"c{i}", png=c.png, ocr_text=c.ocr_text, printed=c.printed)
        for i, c in enumerate(batch, start=1)
    ]
    try:
        answer, model, cost = await get_reader().reread(images, document_id=document_id)
    except ProviderError as exc:
        await _finish_run(run_id, output=None, model=None, cost=0.0, error=str(exc))
        raise
    by_id: dict[str, CropReading] = {}
    for reading in answer.readings:
        by_id.setdefault(reading.id.strip(), reading)
    reads: dict[str, SecondRead] = {}
    for image, crop in zip(images, batch, strict=True):
        found = by_id.get(image.id)
        if found is None:
            reads[crop.key] = SecondRead(None, "missing")
            continue
        text = " ".join((found.text or "").split()) or None
        reads[crop.key] = SecondRead(text if found.legibility != "illegible" else None, found.legibility)
    output = {
        "reads": {key: {"text": r.text, "legibility": r.legibility} for key, r in reads.items()},
        "crops": [
            {
                "id": image.id,
                "key": crop.key,
                "page": crop.page,
                "box": list(crop.box),
                "values": [f"{v.uid}:{v.path}" for v in crop.values],
            }
            for image, crop in zip(images, batch, strict=True)
        ],
    }
    await _finish_run(run_id, output=output, model=model, cost=cost, error=None)
    return reads


# ----------------------------------------------------------------------------------------------
# Applying the readings to one borehole (review service) and its question
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Outcome:
    raw: str
    verdict: Verdict
    confidence: float | None


def field_label(path: str, config: RereadConfig) -> str:
    """A readable label for a value path, e.g. "Layer 3, depth to (m)"."""
    match = re.fullmatch(r"(?:(stratigraphy|groundwater|samples|test_results)\[(\d+)\]|(.*))\.(\w+)", path)
    if match is None:
        name = path
        section = ""
    else:
        name = match.group(4)
        if match.group(1):
            template = config.section_labels.get(match.group(1), match.group(1) + " {n}")
            section = template.replace("{n}", str(int(match.group(2)) + 1))
        else:
            prefix = match.group(3) or ""
            section = config.section_labels.get(prefix.rsplit(".", 1)[-1], "")
    words = config.field_labels.get(name)
    if words is None:
        parts = name.split("_")
        unit = config.unit_labels.get(parts[-1]) if len(parts) > 1 else None
        words = " ".join(parts[:-1] if unit else parts) + (f" ({unit})" if unit else "")
    text = f"{section}, {words}" if section else words
    return text[:1].upper() + text[1:]


def path_order(path: str) -> tuple[tuple[int, str], ...]:
    """Record order of value paths: array positions compare as numbers ("[2]" before "[10]")."""
    return tuple((int(p), "") if p.isdigit() else (-1, p) for p in re.split(r"\[(\d+)\]", path))


def _confidence_text(confidence: Any) -> str:
    return f", confidence {float(confidence):.2f}" if isinstance(confidence, int | float) else ""


def _evidence(fv: FieldValue, document_id: str, snippet: str | None) -> dict[str, Any] | None:
    if fv.page is None:
        return None
    return {"document_id": fv.document_id or document_id, "page": fv.page, "box": fv.box, "snippet": snippet}


def _two_readings(fv: FieldValue) -> tuple[dict[str, Any], dict[str, Any]] | None:
    readers = {str(r.get("reader")): r for r in fv.readings or [] if isinstance(r, dict)}
    first, second = readers.get(READER_OCR), readers.get(READER_REREAD)
    if first is None or second is None:
        return None
    return first, second


def question_fields(
    fvs: Mapping[str, FieldValue], document_id: str, config: RereadConfig
) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    """(path, field, evidence) for every unreviewed value whose two readings stand for different values."""
    out: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for path, fv in sorted(fvs.items(), key=lambda item: path_order(item[0])):
        pair = _two_readings(fv)
        if pair is None or fv.status != "unreviewed" or fv.method not in config.methods or fv.raw is None:
            continue
        first, second = pair
        ocr_text, second_text = str(first.get("text") or ""), str(second.get("text") or "")
        ok, value = reading_value(fv.value, fv.raw, second_text)
        if not ok or value == fv.value:
            continue  # the readings differ in a way no form field can express; both stay in the provenance
        evidence_ocr = _evidence(fv, document_id, ocr_text)
        evidence_second = _evidence(fv, document_id, second_text)
        if evidence_ocr is None or evidence_second is None:
            continue
        options = [
            {
                "value": fv.value,
                "label": f"{ocr_text} (OCR{_confidence_text(first.get('confidence'))})",
                "evidence": evidence_ocr,
            },
            {
                "value": value,
                "label": f"{second_text} (second read{_confidence_text(second.get('confidence'))})",
                "evidence": evidence_second,
            },
        ]
        spec = {
            "name": path,
            "widget": KIND,
            "label": field_label(path, config),
            "help": f"Page {fv.page}: the OCR read '{ocr_text}', a second read '{second_text}'.",
            "required": True,
            "options": options,
        }
        out.append((path, spec, {**evidence_ocr, "snippet": f"{ocr_text} / {second_text}"}))
    return out


def _question_text(label: str, items: Sequence[tuple[str, dict[str, Any], dict[str, Any]]]) -> str:
    if len(items) == 1:
        name = str(items[0][1]["label"])
        return (
            f"Two readings disagree for borehole {label}, {name[:1].lower() + name[1:]}. "
            "Which one is on the page?"
        )
    return (
        f"Two readings disagree for {len(items)} values of borehole {label}. "
        "For each value, choose the reading that is on the page."
    )


async def ask_choose_reading(
    session: AsyncSession, doc: Document, bh: Borehole, fvs: Mapping[str, FieldValue]
) -> bool:
    """Create (or bring up to date while unanswered) the borehole's one choose_reading question."""
    items = question_fields(fvs, doc.id, reread_config())
    if not items:
        return False
    single = len(items) == 1
    fields = [
        FormField.model_validate({**spec, "name": SINGLE_FIELD_NAME} if single else spec).model_dump(
            mode="json"
        )
        for _, spec, _ in items
    ]
    path = items[0][0] if single else None
    evidence: list[dict[str, Any]] = []
    for _, _, item in items:
        if all((e["page"], e["box"]) != (item["page"], item["box"]) for e in evidence):
            evidence.append(Evidence.model_validate(item).model_dump(mode="json"))
    question = _question_text(bh.label_raw, items)
    key = f"{KIND}:{bh.uid}"
    existing = await session.scalar(select(Clarification).where(Clarification.dedupe_key == key))
    if existing is None:
        await create_clarification(
            session,
            kind=KIND,
            document_id=doc.id,
            question=question,
            fields=fields,
            evidence=evidence,
            borehole_uids=[bh.uid],
            path=path,
            project=doc.project,
            dedupe_key=key,
        )
        return True
    if existing.status not in UNRESOLVED:
        return False
    current = {"fields": existing.fields, "path": existing.path, "question": existing.question}
    if current == {"fields": fields, "path": path, "question": question}:
        return False
    existing.fields, existing.path, existing.question, existing.evidence = fields, path, question, evidence
    await session.flush()
    await emit(
        session,
        "clarification.created",
        clarification_out(existing).model_dump(mode="json"),
        document_id=existing.document_id,
    )
    return True


@dataclass
class Applied:
    agreed: int = 0
    disagreed: int = 0
    asked: bool = False


async def apply_outcomes(document_id: str, uid: str, outcomes: Mapping[str, Outcome]) -> Applied:
    """Write one borehole's second reads in one transaction (a `pipeline` revision) and ask its question."""
    applied = Applied()
    async with get_sessionmaker()() as session:
        bh = await session.scalar(select(Borehole).where(Borehole.uid == uid).with_for_update())
        doc = await session.get(Document, document_id)
        if bh is None or doc is None:
            return applied
        fvs = await load_field_values(session, uid)
        config = reread_config()
        agreed: dict[str, dict[str, Any]] = {}
        disagreed: dict[str, dict[str, Any]] = {}
        for path, outcome in outcomes.items():
            fv = fvs.get(path)
            # Re-checked under the row lock: a person may have reviewed or edited the value meanwhile.
            if (
                fv is None
                or fv.status != "unreviewed"
                or fv.method not in config.methods
                or fv.readings
                or fv.raw != outcome.raw
            ):
                continue
            if outcome.verdict.kind == "agree" and outcome.confidence is not None:
                if fv.confidence is None or outcome.confidence > fv.confidence:
                    agreed[path] = {"before": fv.confidence, "after": outcome.confidence}
                    fv.confidence = outcome.confidence
                    fv.updated_at = _now()
            elif outcome.verdict.kind == "disagree" and outcome.verdict.text:
                fv.readings = [
                    {"reader": READER_OCR, "text": fv.raw, "confidence": fv.confidence},
                    {"reader": READER_REREAD, "text": outcome.verdict.text, "confidence": outcome.confidence},
                ]
                fv.updated_at = _now()
                disagreed[path] = {"ocr": fv.raw, "reread": outcome.verdict.text}
        if agreed or disagreed:
            changes = {"action": ACTION, "agreed": agreed, "disagreed": disagreed}
            await commit_change(session, bh, fvs, actor=ACTOR, action=ACTION, changes=changes)
        applied.agreed, applied.disagreed = len(agreed), len(disagreed)
        applied.asked = await ask_choose_reading(session, doc, bh, fvs)
        await session.commit()
    return applied


# ----------------------------------------------------------------------------------------------
# Stage
# ----------------------------------------------------------------------------------------------


@dataclass
class RereadSummary:
    candidates: int = 0
    crops: int = 0
    cached: int = 0
    calls: int = 0
    agreed: int = 0
    disagreed: int = 0
    questions: int = 0
    failed: str | None = None


def batches(items: Sequence[PreparedCrop], size: int) -> list[list[PreparedCrop]]:
    return [list(items[i : i + size]) for i in range(0, len(items), max(1, size))]


async def stage_reread(document_id: str, rereader: Rereader | None = None) -> RereadSummary:
    """Second reads for one document. Never raises: a failure is logged and leaves the values as they are."""
    try:
        return await _stage_reread(document_id, rereader)
    except Exception as exc:
        logger.exception("second reads of %s stopped", document_id)
        return RereadSummary(failed=type(exc).__name__)


async def _stage_reread(document_id: str, rereader: Rereader | None) -> RereadSummary:
    summary = RereadSummary()
    loaded = await _load(document_id)
    summary.candidates = loaded.count
    if not loaded.count:
        return summary  # nothing handwritten or uncertain: no crops, no calls
    config = reread_config()
    model = get_settings().extractor_model
    renders = await asyncio.to_thread(_read_renders, loaded.render_keys)
    crops = await asyncio.to_thread(
        make_crops, renders, loaded.regions, loaded.blocks, model=model, config=config
    )
    summary.crops = len(crops)
    reads = await cached_reads(document_id)
    todo = [c for c in crops if c.key not in reads]
    summary.cached = len(crops) - len(todo)
    instance: list[Rereader] = [rereader] if rereader is not None else []

    def get_reader() -> Rereader:
        if not instance:
            instance.append(OpenRouterRereader())  # built only when a call is needed
        return instance[0]

    for batch in batches(todo, config.batch_size):
        try:
            reads.update(await read_batch(document_id, batch, get_reader))
        except ProviderError as exc:
            # Budget, provider or configuration failure: the values read so far are used, the rest stay as
            # they are (unreviewed, no readings, no question).
            summary.failed = str(exc)
            logger.warning("second read of %s stopped after %d call(s): %s", document_id, summary.calls, exc)
            break
        summary.calls += 1

    per_borehole: dict[str, dict[str, Outcome]] = {}
    for crop in crops:
        read = reads.get(crop.key)
        if read is None or read.text is None:
            continue
        confidence = read.confidence(config)
        for value in crop.values:
            verdict = compare(value.raw, crop.ocr_blocks, read.text)
            if verdict.kind == "unknown":
                logger.info("second read of %s %s could not be matched to the value", value.uid, value.path)
                continue
            per_borehole.setdefault(value.uid, {})[value.path] = Outcome(value.raw, verdict, confidence)
    for uid in sorted(per_borehole):
        applied = await apply_outcomes(document_id, uid, per_borehole[uid])
        summary.agreed += applied.agreed
        summary.disagreed += applied.disagreed
        summary.questions += int(applied.asked)
    logger.info(
        "second reads of %s: %d value(s), %d crop(s), %d cached, %d call(s), %d agreed, %d disagreed, "
        "%d question(s)",
        document_id,
        summary.candidates,
        summary.crops,
        summary.cached,
        summary.calls,
        summary.agreed,
        summary.disagreed,
        summary.questions,
    )
    return summary
