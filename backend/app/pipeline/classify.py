"""Page classification (BACKEND.md 7.3): duplicates by perceptual hash, then a cheap model labels each page.

Each page is labelled and committed on its own, so a retry resumes with the pages still unlabelled and never
pays twice. Labels below CLASSIFIER_MIN_CONFIDENCE are asked again with the extractor model.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
from functools import lru_cache
from typing import Protocol

from PIL import Image
from sqlalchemy import select

from app.config import get_settings
from app.db.models import Document, Page
from app.db.session import get_sessionmaker
from app.pipeline.schemas import PageLabel
from app.pipeline.triage import hamming
from app.providers.llm_openrouter import image_part, text_part
from app.services.documents import emit_document_updated, page_type_for, unused_reason_for
from app.storage import get_storage

logger = logging.getLogger("geomemory.pipeline.classify")

CLASSIFIER_IMAGE_EDGE = 1024
TEXT_LAYER_MIN_QUALITY = 0.8
TEXT_LAYER_CHARS = 1500
DUPLICATE_MAX_DISTANCE = 8  # of 256 bits
DUPLICATE_ASPECT_TOLERANCE = 0.02
# Near-uniform renders (blank pages) hash to few set bits; they are never called duplicates.
MIN_HASH_BITS = 16
PROGRESS_EVERY = 5

PROMPT_VERSION = "1"


@lru_cache
def system_prompt() -> str:
    """The classifier prompt lives in data/prompts so it can change without touching code."""
    return (get_settings().data_dir / "prompts" / "classifier.txt").read_text(encoding="utf-8")


class Classifier(Protocol):
    async def label(self, page: Page, image_png: bytes, text: str | None, *, escalate: bool) -> PageLabel: ...


class OpenRouterClassifier:
    """Classifier model on OpenRouter; escalation uses the extractor model with the same schema."""

    def __init__(self, document_id: str) -> None:
        from app.providers.llm_openrouter import OpenRouterClient

        self.client = OpenRouterClient()
        self.document_id = document_id

    async def label(self, page: Page, image_png: bytes, text: str | None, *, escalate: bool) -> PageLabel:
        settings = get_settings()
        model = settings.extractor_model if escalate else settings.classifier_model
        content = [image_part("data:image/png;base64," + base64.b64encode(image_png).decode("ascii"))]
        if text:
            content.append(text_part("Embedded text of the page (may be incomplete):\n" + text))
        result = await self.client.structured(
            model=model,
            output=PageLabel,
            system=system_prompt(),
            content=content,
            purpose="classify_escalated" if escalate else "classify",
            document_id=self.document_id,
            max_tokens=600,
            estimate_usd=0.01 if escalate else 0.002,
        )
        return result.data


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


async def _find_duplicate(page: Page) -> tuple[str, int] | None:
    if (
        not page.phash
        or int(page.phash, 16).bit_count() < MIN_HASH_BITS
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
                ).where(
                    Page.document_id != page.document_id,
                    Page.phash.is_not(None),
                    Page.role.is_not(None),
                    Page.role != "duplicate",
                )
            )
        ).all()
    best: tuple[int, str, int] | None = None
    own_text = _normalised_text(page)
    for doc_id, n, phash, width, height, text_key, text_quality in rows:
        if phash is None or not width or not height:
            continue
        if abs(width / height - aspect) > DUPLICATE_ASPECT_TOLERANCE * aspect:
            continue
        distance = hamming(page.phash, phash)
        if distance > DUPLICATE_MAX_DISTANCE:
            continue
        # Same printed form, other values: with trustworthy text layers on both pages the text must match too.
        other_text = _normalised_text_of(text_key, text_quality)
        if own_text is not None and other_text is not None and own_text != other_text:
            continue
        if best is None or distance < best[0]:
            best = (distance, doc_id, n)
    return None if best is None else (best[1], best[2])


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
