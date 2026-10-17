"""Document read model (contract `Document`) and the `document.updated` event."""

from __future__ import annotations

from collections.abc import Sequence
from functools import lru_cache
from typing import Any

import yaml
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.models import Borehole, BoreholeGroundwater, BoreholeLayer, Clarification, Document, Page
from app.events.writer import emit
from app.schemas.documents import DocumentOut, PageOut

# Statuses after which extraction results exist and `found` is reported.
_FOUND_STATUSES = frozenset({"needs_review", "done"})


@lru_cache
def page_roles() -> dict[str, Any]:
    with (get_settings().data_dir / "page_roles.yaml").open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle)
    return data


def page_type_for(role: str | None) -> str:
    config = page_roles()
    if role is None:
        return str(config.get("unclassified_type", "unknown"))
    entry = config["roles"].get(role) or {}
    return str(entry.get("type", "unknown"))


def unused_reason_for(
    role: str | None, *, duplicate_file: str | None = None, duplicate_n: int | None = None
) -> str | None:
    if role is None:
        return None
    entry = page_roles()["roles"].get(role) or {}
    template = entry.get("unused_reason")
    if template is None:
        return None
    n = duplicate_n if duplicate_n is not None else "?"
    return str(template).format(file=duplicate_file or "another file", n=n)


def page_out(page: Page, *, duplicate_file: str | None = None) -> PageOut:
    duplicate = None
    if page.duplicate_of_doc is not None and page.duplicate_of_n is not None:
        duplicate = {"document_id": page.duplicate_of_doc, "n": page.duplicate_of_n}
    unused = page.unused_reason
    if not page.used and unused is None:
        unused = unused_reason_for(page.role, duplicate_file=duplicate_file, duplicate_n=page.duplicate_of_n)
    return PageOut.model_validate(
        {
            "n": page.n,
            "type": page.type or page_type_for(page.role),
            "role": page.role,
            "used": page.used,
            "unused_reason": None if page.used else unused,
            "borehole_ids": list(page.borehole_labels or []),
            "sheet_label": page.sheet_label,
            "handwriting": page.handwriting,
            "language": page.language,
            "ocr": page.ocr_status,
            "duplicate_of": duplicate,
        }
    )


async def documents_out(session: AsyncSession, docs: Sequence[Document]) -> list[DocumentOut]:
    """Contract documents with pages, counts and open clarifications, in a fixed number of queries."""
    if not docs:
        return []
    ids = [d.id for d in docs]
    pages = (
        await session.scalars(
            select(Page).where(Page.document_id.in_(ids)).order_by(Page.document_id, Page.n)
        )
    ).all()
    dup_docs = {p.duplicate_of_doc for p in pages if p.duplicate_of_doc}
    dup_names: dict[str, str] = {}
    if dup_docs:
        rows = await session.execute(select(Document.id, Document.file_name).where(Document.id.in_(dup_docs)))
        dup_names = {str(i): str(n) for i, n in rows.all()}
    by_doc: dict[str, list[PageOut]] = {}
    for p in pages:
        dup_file = dup_names.get(p.duplicate_of_doc or "")
        by_doc.setdefault(p.document_id, []).append(page_out(p, duplicate_file=dup_file))

    bh_rows = await session.execute(
        select(Borehole.document_id, func.count())
        .where(Borehole.document_id.in_(ids))
        .group_by(Borehole.document_id)
    )
    bh_counts = {str(d): int(n) for d, n in bh_rows.all()}
    spt_filter = BoreholeLayer.spt_n_value.is_not(None) | BoreholeLayer.spt_refusal.is_(True)
    layer_rows = await session.execute(
        select(
            Borehole.document_id,
            func.count(BoreholeLayer.uid),
            func.count(BoreholeLayer.uid).filter(spt_filter),
        )
        .join(BoreholeLayer, BoreholeLayer.uid == Borehole.uid)
        .where(Borehole.document_id.in_(ids))
        .group_by(Borehole.document_id)
    )
    layers = {str(d): (int(n), int(spt)) for d, n, spt in layer_rows.all()}
    gw_rows = await session.execute(
        select(Borehole.document_id, func.count(BoreholeGroundwater.uid))
        .join(BoreholeGroundwater, BoreholeGroundwater.uid == Borehole.uid)
        .where(Borehole.document_id.in_(ids))
        .group_by(Borehole.document_id)
    )
    groundwater = {str(d): int(n) for d, n in gw_rows.all()}
    clar_rows = await session.execute(
        select(Clarification.document_id, func.count())
        .where(Clarification.document_id.in_(ids), Clarification.status == "open")
        .group_by(Clarification.document_id)
    )
    open_clar = {str(d): int(n) for d, n in clar_rows.all()}

    out = []
    for doc in docs:
        n_bh = bh_counts.get(doc.id, 0)
        found = None
        if doc.status in _FOUND_STATUSES or n_bh:
            n_layers, n_spt = layers.get(doc.id, (0, 0))
            found = {
                "boreholes": n_bh,
                "layers": n_layers,
                "spt": n_spt,
                "groundwater": groundwater.get(doc.id, 0),
            }
        out.append(
            DocumentOut.model_validate(
                {
                    "document_id": doc.id,
                    "file_name": doc.file_name,
                    "project": doc.project,
                    "status": doc.status,
                    "error": doc.error,
                    "mime_type": doc.mime_type,
                    "size_bytes": doc.size_bytes,
                    "sha256": doc.sha256,
                    "page_count": doc.page_count,
                    "found": found,
                    "pages": by_doc.get(doc.id, []),
                    "completeness": doc.completeness,
                    "progress": doc.progress,
                    "duplicate_of": doc.duplicate_of,
                    "open_clarifications": open_clar.get(doc.id, 0),
                    "created_at": doc.created_at,
                    "updated_at": doc.updated_at,
                }
            )
        )
    return out


async def document_out(session: AsyncSession, doc: Document) -> DocumentOut:
    return (await documents_out(session, [doc]))[0]


async def emit_document_updated(session: AsyncSession, doc: Document) -> None:
    """Write `document.updated` with the full Document in the caller's transaction."""
    await session.flush()
    await session.refresh(doc)
    payload = (await document_out(session, doc)).model_dump(mode="json")
    await emit(session, "document.updated", payload, document_id=doc.id)
