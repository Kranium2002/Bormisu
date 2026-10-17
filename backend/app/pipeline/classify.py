"""Page classification (BACKEND.md 7.3): duplicates by perceptual hash, then a cheap model labels each page.

Each page is labelled and committed on its own, so a retry resumes with the pages still unlabelled and never
pays twice. Labels below CLASSIFIER_MIN_CONFIDENCE are asked again with the extractor model, and so is a
page put in a no-data role that looks like the log sheets around it (`second_opinion`, capped per document
in data/page_roles.yaml); the page records that it was asked, so a retry never asks twice.

Duplicate thresholds live in data/document_checks.yaml (`page_duplicates`). A scan (no trustworthy text
layer on both pages) is a copy only when its render is near identical too, never on the hash alone: the same
printed form filled in by another hand hashes as close as a copy. Once every page is labelled, a
document whose borehole pages all copy pages of one other document gets `documents.duplicate_of`
(app.clarify.duplicates; finalisation asks the `duplicate` question).
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

from PIL import Image
from sqlalchemy import select

from app.clarify.duplicates import refresh_duplicate_of
from app.config import get_settings
from app.db.models import Document, Page
from app.db.session import get_sessionmaker
from app.pipeline.schemas import PageLabel
from app.pipeline.triage import changed_share, hamming
from app.providers.llm import image_part, text_part
from app.services.documents import emit_document_updated, page_type_for, unused_reason_for
from app.storage import get_storage
from app.validate.document import section

logger = logging.getLogger("geomemory.pipeline.classify")

CLASSIFIER_IMAGE_EDGE = 1024
TEXT_LAYER_MIN_QUALITY = 0.8
TEXT_LAYER_CHARS = 1500
PROGRESS_EVERY = 5

PROMPT_VERSION = "1"
BLANK_LABEL = PageLabel(
    role="blank",
    borehole_labels=[],
    sheet_label=None,
    sheet_index=None,
    sheet_total=None,
    handwriting="none",
    language=None,
    has_coordinates=False,
    has_depth_scale=False,
    is_continuation=False,
    confidence=1.0,
    reason="Almost no ink and no embedded text on the page.",
)


@lru_cache
def system_prompt() -> str:
    """The classifier prompt lives in data/prompts so it can change without touching code."""
    return (get_settings().data_dir / "prompts" / "classifier.txt").read_text(encoding="utf-8")


class Classifier(Protocol):
    async def label(self, page: Page, image_png: bytes, text: str | None, *, escalate: bool) -> PageLabel: ...


class OpenRouterClassifier:
    """The classifier model on the configured provider (OpenRouter or OpenAI, app.providers.llm); escalation
    uses the extractor model with the same schema."""

    def __init__(self, document_id: str) -> None:
        from app.providers.llm import LlmClient

        self.client = LlmClient()
        self.document_id = document_id

    async def label(self, page: Page, image_png: bytes, text: str | None, *, escalate: bool) -> PageLabel:
        content = [image_part("data:image/png;base64," + base64.b64encode(image_png).decode("ascii"))]
        if text:
            content.append(text_part("Embedded text of the page (may be incomplete):\n" + text))
        result = await self.client.structured(
            role="extractor" if escalate else "classifier",
            output=PageLabel,
            system=system_prompt(),
            content=content,
            purpose="classify_escalated" if escalate else "classify",
            document_id=self.document_id,
            max_tokens=600,
            estimate_usd=0.01 if escalate else 0.002,
        )
        return result.data


@lru_cache(maxsize=1)
def _blank_rule() -> tuple[float, int, int]:
    import yaml

    with (get_settings().data_dir / "page_roles.yaml").open(encoding="utf-8") as handle:
        rule = (yaml.safe_load(handle) or {}).get("blank_page") or {}
    return (
        float(rule.get("max_ink_share", 0.0)),
        int(rule.get("dark_below", 0)),
        int(rule.get("max_text_chars", 0)),
    )


@dataclass(frozen=True)
class SecondOpinionRule:
    max_share: float
    max_pages: int
    size_tolerance: float
    log_roles: frozenset[str]
    handwriting: frozenset[str]
    skip_roles: frozenset[str]


@lru_cache(maxsize=1)
def second_opinion_rule() -> SecondOpinionRule:
    import yaml

    with (get_settings().data_dir / "page_roles.yaml").open(encoding="utf-8") as handle:
        rule = (yaml.safe_load(handle) or {}).get("second_opinion") or {}
    return SecondOpinionRule(
        max_share=float(rule.get("max_share", 0.0)),
        max_pages=int(rule.get("max_pages", 0)),
        size_tolerance=float(rule.get("size_tolerance", 0.0)),
        log_roles=frozenset(rule.get("roles") or ()),
        handwriting=frozenset(rule.get("handwriting") or ()),
        skip_roles=frozenset(rule.get("skip_roles") or ()),
    )


def _same_size(a: Page, b: Page, tolerance: float) -> bool:
    if not (a.width_px and a.height_px and b.width_px and b.height_px):
        return False
    return abs(a.width_px - b.width_px) <= tolerance * max(a.width_px, b.width_px) and abs(
        a.height_px - b.height_px
    ) <= tolerance * max(a.height_px, b.height_px)


def outliers(pages: list[Page]) -> list[int]:
    """Pages in a no-data role that look like the log sheets next to them, in page order and capped.

    A candidate has a log-sheet neighbour of the same page size, and either handwriting of its own or log
    sheets on both sides; a page already asked twice (`second_opinion` in its label) is never a candidate."""
    rule = second_opinion_rule()
    if rule.max_pages <= 0 or rule.max_share <= 0 or not pages:
        return []
    important = get_settings().important_roles
    by_n = {p.n: p for p in pages}
    # the cap is per document: pages asked by an earlier run (a retry) count against it
    asked = sum(1 for p in pages if (p.classifier or {}).get("second_opinion"))
    found: list[int] = []
    for page in sorted(pages, key=lambda p: p.n):
        if page.role is None or page.role in important or page.role in rule.skip_roles:
            continue
        if (page.classifier or {}).get("second_opinion"):
            continue
        logs = [
            other
            for other in (by_n.get(page.n - 1), by_n.get(page.n + 1))
            if other is not None and other.role in rule.log_roles
        ]
        alike = [other for other in logs if _same_size(page, other, rule.size_tolerance)]
        if alike and (page.handwriting in rule.handwriting or len(logs) == 2):
            found.append(page.n)
    cap = min(rule.max_pages, max(1, math.ceil(rule.max_share * len(pages))))
    return found[: max(0, cap - asked)]


async def second_opinion(document_id: str, classifier: Classifier) -> list[int]:
    """Label the outliers again with the extractor model (paid through the provider ledger like every
    escalation); returns the pages whose role changed."""
    async with get_sessionmaker()() as session:
        pages = list((await session.scalars(select(Page).where(Page.document_id == document_id))).all())
    changed: list[int] = []
    for n in outliers(pages):
        async with get_sessionmaker()() as session:
            page = await session.get(Page, (document_id, n))
            if page is None or page.role is None:
                continue
            first_role = page.role
            storage = get_storage()
            png = await asyncio.to_thread(
                _shrink, await asyncio.to_thread(storage.get_bytes, page.render_key or "")
            )
            text = await asyncio.to_thread(_text_for, page)
            label = await classifier.label(page, png, text, escalate=True)
            apply_label(page, label)
            page.classifier = {**(page.classifier or {}), "second_opinion": {"first_role": first_role}}
            await session.commit()
            if label.role != first_role:
                logger.info(
                    "document %s p%d: %s -> %s on a second opinion", document_id, n, first_role, label.role
                )
                changed.append(n)
    return changed


def is_blank(png: bytes, text: str | None) -> bool:
    """Almost no ink and no embedded text (data/page_roles.yaml blank_page): a blank page, no model needed."""
    max_ink, dark_below, max_chars = _blank_rule()
    if max_ink <= 0 or len((text or "").strip()) > max_chars:
        return False
    with Image.open(io.BytesIO(png)) as img:
        histogram = img.convert("L").histogram()  # full size: a thin faint stroke survives
    dark = sum(histogram[:dark_below])
    return dark / max(1, sum(histogram)) <= max_ink


def _shrink(png: bytes) -> bytes:
    with Image.open(io.BytesIO(png)) as img:
        scale = CLASSIFIER_IMAGE_EDGE / max(img.width, img.height)
        if scale >= 1:
            return png
        small = img.convert("RGB").resize(
            (round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS
        )
        out = io.BytesIO()
        small.save(out, format="PNG", optimize=True)
        return out.getvalue()


def _text_for(page: Page) -> str | None:
    if page.text_layer_key is None or (page.text_layer_quality or 0) < TEXT_LAYER_MIN_QUALITY:
        return None
    storage = get_storage()
    if not storage.exists(page.text_layer_key):
        return None
    payload = json.loads(storage.get_bytes(page.text_layer_key))
    text = str(payload.get("text") or "").strip()
    return text[:TEXT_LAYER_CHARS] or None


def _normalised_text_of(key: str | None, quality: float | None) -> str | None:
    if key is None or (quality or 0) < TEXT_LAYER_MIN_QUALITY:
        return None
    storage = get_storage()
    if not storage.exists(key):
        return None
    text = str(json.loads(storage.get_bytes(key)).get("text") or "")
    return " ".join(text.split()) or None


def _normalised_text(page: Page) -> str | None:
    return _normalised_text_of(page.text_layer_key, page.text_layer_quality)


def is_important(page: Page) -> bool:
    if page.role == "duplicate":
        return False
    return (
        page.role in get_settings().important_roles
        or bool(page.borehole_labels)
        or bool(page.has_coordinates)
    )


def _duplicate_thresholds() -> tuple[int, float, int]:
    """(max Hamming distance of 256 bits, aspect tolerance, min set bits) from data/document_checks.yaml.

    Near-uniform renders (blank pages) hash to few set bits; they are never called duplicates."""
    cfg = section("page_duplicates")
    return int(cfg["max_hamming"]), float(cfg["aspect_tolerance"]), int(cfg["min_hash_bits"])


async def _find_duplicate(page: Page) -> tuple[str, int] | None:
    max_distance, aspect_tolerance, min_hash_bits = _duplicate_thresholds()
    if (
        not page.phash
        or int(page.phash, 16).bit_count() < min_hash_bits
        or not page.width_px
        or not page.height_px
    ):
        return None
    aspect = page.width_px / page.height_px
    async with get_sessionmaker()() as session:
        rows = (
            await session.execute(
                select(
                    Page.document_id,
                    Page.n,
                    Page.phash,
                    Page.width_px,
                    Page.height_px,
                    Page.text_layer_key,
                    Page.text_layer_quality,
                    Page.render_key,
                ).where(
                    Page.document_id != page.document_id,
                    Page.phash.is_not(None),
                    Page.role.is_not(None),
                    Page.role != "duplicate",
                )
            )
        ).all()
    candidates: list[tuple[int, str, int, str | None]] = []  # distance, document, page, render to compare
    own_text = _normalised_text(page)
    for doc_id, n, phash, width, height, text_key, text_quality, render_key in rows:
        if phash is None or not width or not height:
            continue
        if abs(width / height - aspect) > aspect_tolerance * aspect:
            continue
        distance = hamming(page.phash, phash)
        if distance > max_distance:
            continue
        # Same printed form, other values: with trustworthy text layers on both pages the text must match too.
        other_text = _normalised_text_of(text_key, text_quality)
        if own_text is not None and other_text is not None:
            if own_text == other_text:
                candidates.append((distance, doc_id, n, None))
            continue
        # A scan: the hash alone cannot tell the same form filled in by another hand from a copy.
        candidates.append((distance, doc_id, n, render_key or ""))
    for _distance, doc_id, n, render_key in sorted(candidates):
        if render_key is None or await asyncio.to_thread(_same_scan, page.render_key, render_key):
            return doc_id, n
    return None


def _same_scan(own_key: str | None, other_key: str) -> bool:
    """The two stored renders are copies of one scan (data/document_checks.yaml page_duplicates scan_*)."""
    cfg = section("page_duplicates")
    storage = get_storage()
    if not own_key or not other_key or not storage.exists(own_key) or not storage.exists(other_key):
        return False  # nothing to compare: never drop a page on the hash alone
    with (
        Image.open(io.BytesIO(storage.get_bytes(own_key))) as own,
        Image.open(io.BytesIO(storage.get_bytes(other_key))) as other,
    ):
        share = changed_share(
            own, other, long_edge=int(cfg["scan_compare_edge"]), min_step=int(cfg["scan_min_step"])
        )
    return share <= float(cfg["scan_max_changed_share"])


def apply_label(page: Page, label: PageLabel) -> None:
    page.role = label.role
    page.type = page_type_for(label.role)
    page.borehole_labels = [b.strip() for b in label.borehole_labels if b.strip()]
    page.sheet_label = label.sheet_label
    page.sheet_index = label.sheet_index
    page.sheet_total = label.sheet_total
    page.handwriting = label.handwriting
    page.language = label.language
    page.has_coordinates = label.has_coordinates
    page.classifier_confidence = label.confidence
    page.classifier = label.model_dump(mode="json")
    important = is_important(page)
    page.used = important
    page.unused_reason = None if important else unused_reason_for(label.role)
    page.ocr_status = "pending" if important else "skipped"


async def classify_page(document_id: str, n: int, classifier: Classifier) -> None:
    async with get_sessionmaker()() as session:
        page = await session.get(Page, (document_id, n))
        if page is None or page.role is not None:
            return
        duplicate = await _find_duplicate(page)
        if duplicate is not None:
            other_doc, other_n = duplicate
            other_name = await session.scalar(select(Document.file_name).where(Document.id == other_doc))
            page.role, page.type = "duplicate", page_type_for("duplicate")
            page.duplicate_of_doc, page.duplicate_of_n = other_doc, other_n
            page.used, page.ocr_status = False, "skipped"
            page.unused_reason = unused_reason_for(
                "duplicate", duplicate_file=other_name, duplicate_n=other_n
            )
            await session.commit()
            return
        storage = get_storage()
        png = await asyncio.to_thread(
            _shrink, await asyncio.to_thread(storage.get_bytes, page.render_key or "")
        )
        text = await asyncio.to_thread(_text_for, page)
        if await asyncio.to_thread(is_blank, png, text):
            apply_label(page, BLANK_LABEL)  # nothing on the page: no classifier call, no OCR
            await session.commit()
            return
        label = await classifier.label(page, png, text, escalate=False)
        if label.confidence < get_settings().classifier_min_confidence:
            label = await classifier.label(page, png, text, escalate=True)
        apply_label(page, label)
        await session.commit()


async def stage_classify(document_id: str, classifier: Classifier | None = None) -> None:
    """Label every unlabelled page with bounded concurrency; progress events every few pages."""
    async with get_sessionmaker()() as session:
        todo = (
            await session.scalars(
                select(Page.n).where(Page.document_id == document_id, Page.role.is_(None)).order_by(Page.n)
            )
        ).all()
    model = classifier or OpenRouterClassifier(document_id)
    limit = asyncio.Semaphore(max(1, get_settings().concurrency_classify))
    done = 0

    async def one(n: int) -> None:
        nonlocal done
        async with limit:
            await classify_page(document_id, n, model)
            done += 1
            if done % PROGRESS_EVERY == 0:
                await update_progress(document_id, emit=True)

    results = await asyncio.gather(*(one(n) for n in todo), return_exceptions=True)
    await update_progress(document_id, emit=True)
    errors = [r for r in results if isinstance(r, BaseException)]
    if errors:
        raise errors[0]
    if await second_opinion(document_id, model):
        await update_progress(document_id, emit=True)
    await mark_document_duplicate(document_id)


async def mark_document_duplicate(document_id: str) -> None:
    """Set `documents.duplicate_of` when every borehole page copies a page of one other document."""
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id, with_for_update={"key_share": True})
        if doc is None:
            return
        if await refresh_duplicate_of(session, doc):
            await emit_document_updated(session, doc)
        await session.commit()


async def update_progress(document_id: str, *, emit: bool) -> None:
    """Recount progress from the pages table and (optionally) emit document.updated."""
    from sqlalchemy import func

    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return
        counts = (
            await session.execute(
                select(
                    func.count(),
                    func.count().filter(Page.role.is_not(None)),
                    func.count().filter(
                        Page.ocr_status.in_(("pending", "done", "failed")), Page.used.is_(True)
                    ),
                    func.count().filter(Page.ocr_status == "done"),
                ).where(Page.document_id == document_id)
            )
        ).one()
        progress = dict(doc.progress or {})
        progress.update(
            {
                "pages_total": int(counts[0]),
                "pages_classified": int(counts[1]),
                "pages_ocr_total": int(counts[2]),
                "pages_ocr_done": int(counts[3]),
            }
        )
        progress.setdefault("boreholes_extracted", 0)
        doc.progress = progress
        if emit:
            await emit_document_updated(session, doc)
        await session.commit()
