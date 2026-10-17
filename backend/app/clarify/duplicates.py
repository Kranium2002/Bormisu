"""Documents that repeat an earlier document (BACKEND.md 7.3): `documents.duplicate_of` and the `duplicate`
question.

Two signs, both generic:

* pages: every page of the document that carries borehole data is a copy (perceptual hash, see
  app.pipeline.classify) of a used page of one other document. Such pages are never read again, so the
  document gets `duplicate_of` and one question per original document;
* boreholes: boreholes of the document have the same canonical label and the same printed coordinates as
  boreholes of an earlier document (re-scans, the same report as Word and as PDF ...).

The answer `same_boreholes` adds the later document's labels as aliases of the original boreholes and marks
the later boreholes as duplicates; `keep_both` changes nothing. Both go through app.review.service, so every
change is a revision with the answering person as actor.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.clarify.service import create_clarification
from app.db.models import Borehole, Clarification, Document, FieldValue, Page
from app.review.service import add_aliases, mark_duplicate
from app.validate.document import section

KIND = "duplicate"
SAME = "same_boreholes"
KEEP = "keep_both"
LABEL_PATH = "metadata.borehole_id"


def _settings() -> tuple[int, int, int]:
    cfg = section("borehole_duplicates")
    return int(cfg["coordinate_decimals"]), int(cfg["min_matches"]), int(cfg["evidence_max"])


def _point_key(record: dict[str, Any], decimals: int) -> tuple[float, float] | None:
    coords = (record.get("metadata") or {}).get("coordinates") or {}
    x, y = coords.get("local_x"), coords.get("local_y")
    if (
        isinstance(x, bool)
        or isinstance(y, bool)
        or not isinstance(x, int | float)
        or not isinstance(y, int | float)
    ):
        return None
    return round(float(x), decimals), round(float(y), decimals)


# ----------------------------------------------------------------------------------------------
# Page copies
# ----------------------------------------------------------------------------------------------


async def page_copies(session: AsyncSession, document_id: str) -> dict[str, list[tuple[int, int]]]:
    """Original document id -> [(page, original page)] when every page of `document_id` that carries
    borehole data is a copy of a used page of another document; {} otherwise."""
    own_used = await session.scalar(
        select(func.count()).select_from(Page).where(Page.document_id == document_id, Page.used.is_(True))
    )
    if own_used:
        return {}
    original = aliased(Page)
    rows = await session.execute(
        select(Page.n, original.document_id, original.n)
        .join(
            original,
            and_(original.document_id == Page.duplicate_of_doc, original.n == Page.duplicate_of_n),
        )
        .where(Page.document_id == document_id, Page.role == "duplicate", original.used.is_(True))
        .order_by(Page.n)
    )
    copies: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for n, other, other_n in rows.all():
        copies[str(other)].append((int(n), int(other_n)))
    return dict(copies)


async def refresh_duplicate_of(session: AsyncSession, doc: Document) -> bool:
    """Set `documents.duplicate_of` when the document's data pages all copy one other document. Returns
    True when the value changed."""
    copies = await page_copies(session, doc.id)
    value = next(iter(copies)) if len(copies) == 1 else None
    if doc.duplicate_of == value:
        return False
    doc.duplicate_of = value
    return True


# ----------------------------------------------------------------------------------------------
# Repeated boreholes
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Match:
    uid: str  # borehole of the later document
    label: str
    original_uid: str
    original_label: str


async def borehole_matches(session: AsyncSession, doc: Document) -> dict[str, list[Match]]:
    """Earlier document id -> boreholes of `doc` with the same canonical label and printed coordinates as
    one of its boreholes (each borehole of `doc` matched at most once per earlier document)."""
    decimals, _, _ = _settings()
    own_rows = (
        await session.execute(
            select(Borehole.uid, Borehole.label_raw, Borehole.label_canonical, Borehole.record)
            .where(Borehole.document_id == doc.id, Borehole.duplicate_of.is_(None))
            .order_by(Borehole.uid)
        )
    ).all()
    own: dict[tuple[str, float, float], list[tuple[str, str]]] = defaultdict(list)
    for uid, label, canonical, record in own_rows:
        point = _point_key(record, decimals)
        if point is not None:
            own[(canonical, *point)].append((uid, label))
    if not own:
        return {}
    earlier = or_(
        Document.created_at < doc.created_at,
        and_(Document.created_at == doc.created_at, Document.id < doc.id),
    )
    rows = (
        await session.execute(
            select(
                Borehole.uid,
                Borehole.document_id,
                Borehole.label_raw,
                Borehole.label_canonical,
                Borehole.record,
            )
            .join(Document, Document.id == Borehole.document_id)
            .where(
                Borehole.document_id != doc.id,
                Borehole.label_canonical.in_(sorted({key[0] for key in own})),
                Borehole.duplicate_of.is_(None),
                earlier,
            )
            .order_by(Document.created_at, Borehole.document_id, Borehole.uid)
        )
    ).all()
    matches: dict[str, list[Match]] = defaultdict(list)
    used: set[tuple[str, str]] = set()
    for uid, other_doc, label, canonical, record in rows:
        point = _point_key(record, decimals)
        if point is None:
            continue
        for own_uid, own_label in own.get((canonical, *point), []):
            if (str(other_doc), own_uid) in used:
                continue
            used.add((str(other_doc), own_uid))
            matches[str(other_doc)].append(Match(own_uid, own_label, uid, label))
            break
    return dict(matches)


# ----------------------------------------------------------------------------------------------
# Questions
# ----------------------------------------------------------------------------------------------


def _resolution_field(same_label: str, keep_label: str) -> dict[str, Any]:
    return {
        "name": "resolution",
        "widget": "select",
        "label": "Are they the same boreholes?",
        "required": True,
        "options": [{"value": SAME, "label": same_label}, {"value": KEEP, "label": keep_label}],
    }


def _pages(numbers: Sequence[int]) -> str:
    unique = sorted(set(numbers))
    return f"page {unique[0]}" if len(unique) == 1 else "pages " + ", ".join(str(n) for n in unique)


async def _ask_page_copies(
    session: AsyncSession, doc: Document, original: Document, copies: Sequence[tuple[int, int]]
) -> None:
    _, _, evidence_max = _settings()
    original_pages = [other_n for _, other_n in copies]
    uids = (
        await session.scalars(
            select(Borehole.uid)
            .where(Borehole.document_id == original.id, Borehole.pages.overlap(original_pages))
            .order_by(Borehole.uid)
        )
    ).all()
    evidence: list[dict[str, Any]] = []
    for n, other_n in copies:
        evidence.append({"document_id": doc.id, "page": n, "box": None, "snippet": None})
        evidence.append({"document_id": original.id, "page": other_n, "box": None, "snippet": None})
    await create_clarification(
        session,
        kind=KIND,
        document_id=doc.id,
        question=(
            f"The borehole pages of {doc.file_name} repeat {_pages(original_pages)} of {original.file_name}, "
            "uploaded earlier, so they were not read again. Do they show the same boreholes?"
        ),
        fields=[
            _resolution_field(
                f"Yes: keep the boreholes read from {original.file_name}",
                "No: they are different boreholes (keep both documents)",
            )
        ],
        evidence=evidence[: 2 * evidence_max],
        borehole_uids=list(uids),
        project=doc.project,
        dedupe_key=f"{KIND}:pages:{doc.id}:{original.id}",
    )


async def _label_evidence(session: AsyncSession, uids: Sequence[str]) -> dict[str, dict[str, Any]]:
    rows = (
        await session.scalars(
            select(FieldValue).where(FieldValue.uid.in_(list(uids)), FieldValue.path == LABEL_PATH)
        )
    ).all()
    return {
        fv.uid: {"document_id": fv.document_id, "page": fv.page, "box": fv.box, "snippet": fv.raw}
        for fv in rows
        if fv.page is not None and fv.document_id is not None
    }


async def _ask_repeated_boreholes(
    session: AsyncSession, doc: Document, original: Document, matches: Sequence[Match]
) -> None:
    _, _, evidence_max = _settings()
    uids = list(dict.fromkeys([*(m.uid for m in matches), *(m.original_uid for m in matches)]))
    labels = await _label_evidence(session, uids)
    evidence = [
        entry for m in matches for uid in (m.uid, m.original_uid) if (entry := labels.get(uid)) is not None
    ][:evidence_max]
    count = len(matches)
    names = ", ".join(m.label for m in matches[:8]) + (" …" if count > 8 else "")
    subject = f"{count} borehole{'s' if count != 1 else ''} of {doc.file_name} ({names})"
    await create_clarification(
        session,
        kind=KIND,
        document_id=doc.id,
        question=(
            f"{subject} {'have' if count != 1 else 'has'} the same label and coordinates as boreholes of "
            f"{original.file_name}, uploaded earlier. Are they the same boreholes?"
        ),
        fields=[
            _resolution_field(
                f"Yes: keep the records of {original.file_name} and add these labels as aliases",
                "No: they are different boreholes (keep both)",
            )
        ],
        evidence=evidence,
        borehole_uids=uids,
        project=doc.project,
        dedupe_key=f"{KIND}:boreholes:{doc.id}:{original.id}",
    )


async def ask_duplicates(session: AsyncSession, doc: Document) -> None:
    """One `duplicate` question per earlier document that this document repeats (idempotent)."""
    _, min_matches, _ = _settings()
    copies = await page_copies(session, doc.id)
    by_pages = await borehole_matches(session, doc)
    others = {*copies, *by_pages}
    if not others:
        return
    documents = {
        d.id: d
        for d in (await session.scalars(select(Document).where(Document.id.in_(sorted(others))))).all()
    }
    for other_id in sorted(copies):
        if other_id in documents:
            await _ask_page_copies(session, doc, documents[other_id], copies[other_id])
    for other_id, matches in sorted(by_pages.items()):
        if other_id in documents and len(matches) >= min_matches:
            await _ask_repeated_boreholes(session, doc, documents[other_id], matches)


# ----------------------------------------------------------------------------------------------
# Answer
# ----------------------------------------------------------------------------------------------


async def apply_duplicate_answer(
    session: AsyncSession, row: Clarification, values: dict[str, Any], actor: str
) -> None:
    """`same_boreholes`: each later borehole is paired with the original of the same canonical label (the
    same printed position first); the original gains its labels as aliases, the later one is marked."""
    if values.get("resolution") != SAME:
        return
    decimals, _, _ = _settings()
    boreholes = (
        await session.scalars(
            select(Borehole).where(Borehole.uid.in_(list(row.borehole_uids or []))).order_by(Borehole.uid)
        )
    ).all()
    later = [bh for bh in boreholes if bh.document_id == row.document_id]
    originals = [bh for bh in boreholes if bh.document_id != row.document_id]
    note = f"clarification {row.id}"
    for bh in later:
        same_label = [o for o in originals if o.label_canonical == bh.label_canonical]
        if not same_label:
            continue
        point = _point_key(bh.record, decimals)
        original = next((o for o in same_label if _point_key(o.record, decimals) == point), same_label[0])
        await add_aliases(session, original.uid, [bh.label_raw, *(bh.aliases or [])], actor=actor, note=note)
        await mark_duplicate(session, bh.uid, original.uid, actor=actor, note=note)
