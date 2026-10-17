"""SQLAlchemy models (BACKEND.md section 6).

`boreholes.record` holds the current BoreholeRecord body (metadata, stratigraphy, groundwater, samples,
test_results, rock_head_m). `field_values` holds one provenance row per value path. The query columns
(`layers`, `groundwater`, depth, geometry …) are recomputed from the body by app.review.service on every
change, so SQL tools never parse JSON.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from geoalchemy2 import Geometry
from sqlalchemy import (
    DDL,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.event import listen
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

__all__ = [
    "Base",
    "Borehole",
    "BoreholeGroundwater",
    "BoreholeLayer",
    "Clarification",
    "Document",
    "Event",
    "ExtractionRun",
    "FieldValue",
    "GeocodeCache",
    "OcrPage",
    "OcrRun",
    "Page",
    "ProviderCall",
    "ResultSet",
    "Revision",
]


def _now_column() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    file_name: Mapped[str] = mapped_column(Text, nullable=False)
    project: Mapped[str | None] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    mime_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="queued")
    # Last pipeline stage that finished; retry resumes after it.
    stage: Mapped[str | None] = mapped_column(String(30))
    error: Mapped[str | None] = mapped_column(Text)
    page_count: Mapped[int | None] = mapped_column(Integer)
    progress: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    completeness: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    duplicate_of: Mapped[str | None] = mapped_column(String(40))
    # True for fictional records loaded by `python -m app.seed`; `--remove` deletes exactly these.
    is_seed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = _now_column()
    updated_at: Mapped[datetime] = _now_column()

    __table_args__ = (
        Index(
            "ix_documents_project_trgm",
            "project",
            postgresql_using="gin",
            postgresql_ops={"project": "gin_trgm_ops"},
        ),
    )


class Page(Base):
    __tablename__ = "pages"

    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True)
    n: Mapped[int] = mapped_column(Integer, primary_key=True)
    width_px: Mapped[int | None] = mapped_column(Integer)
    height_px: Mapped[int | None] = mapped_column(Integer)
    render_key: Mapped[str | None] = mapped_column(Text)
    thumb_key: Mapped[str | None] = mapped_column(Text)
    text_layer_quality: Mapped[float | None] = mapped_column(Float)
    text_layer_key: Mapped[str | None] = mapped_column(Text)
    phash: Mapped[str | None] = mapped_column(String(64))
    role: Mapped[str | None] = mapped_column(String(30))
    type: Mapped[str | None] = mapped_column(String(20))
    handwriting: Mapped[str | None] = mapped_column(String(20))
    language: Mapped[str | None] = mapped_column(String(20))
    borehole_labels: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'::text[]")
    )
    sheet_label: Mapped[str | None] = mapped_column(Text)
    sheet_index: Mapped[int | None] = mapped_column(Integer)
    sheet_total: Mapped[int | None] = mapped_column(Integer)
    has_coordinates: Mapped[bool | None] = mapped_column(Boolean)
    classifier_confidence: Mapped[float | None] = mapped_column(Float)
    classifier_run_id: Mapped[str | None] = mapped_column(String(40))
    classifier: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    ocr_status: Mapped[str | None] = mapped_column(String(20))
    ocr_run_id: Mapped[str | None] = mapped_column(String(40))
    duplicate_of_doc: Mapped[str | None] = mapped_column(String(40))
    duplicate_of_n: Mapped[int | None] = mapped_column(Integer)
    used: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    unused_reason: Mapped[str | None] = mapped_column(Text)


class OcrRun(Base):
    __tablename__ = "ocr_runs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    model: Mapped[str | None] = mapped_column(Text)
    params_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    pages: Mapped[list[int]] = mapped_column(ARRAY(Integer), nullable=False)
    pages_processed: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    raw_key: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _now_column()

    __table_args__ = (UniqueConstraint("document_id", "params_hash", name="uq_ocr_runs_document_params"),)


class OcrPage(Base):
    __tablename__ = "ocr_pages"

    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True)
    n: Mapped[int] = mapped_column(Integer, primary_key=True)
    ocr_run_id: Mapped[str] = mapped_column(ForeignKey("ocr_runs.id", ondelete="CASCADE"), nullable=False)
    markdown: Mapped[str | None] = mapped_column(Text)
    tables: Mapped[list[Any] | None] = mapped_column(JSONB)
    blocks: Mapped[list[Any] | None] = mapped_column(JSONB)
    dimensions: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    raw_key: Mapped[str | None] = mapped_column(Text)


class ExtractionRun(Base):
    __tablename__ = "extraction_runs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    group_id: Mapped[str] = mapped_column(Text, nullable=False)
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    model: Mapped[str | None] = mapped_column(Text)
    prompt_version: Mapped[str] = mapped_column(String(20), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(20), nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    cost_usd: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _now_column()


class Borehole(Base):
    __tablename__ = "boreholes"

    uid: Mapped[str] = mapped_column(String(40), primary_key=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Stable key of the page group the borehole came from; makes re-extraction idempotent.
    group_key: Mapped[str] = mapped_column(Text, nullable=False)
    label_raw: Mapped[str] = mapped_column(Text, nullable=False)
    label_canonical: Mapped[str] = mapped_column(Text, nullable=False)
    aliases: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'::text[]")
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    review_status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="unreviewed")
    crs_status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="unknown")
    crs_code: Mapped[str | None] = mapped_column(String(40))
    swap_axes: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    plotted: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    unplotted_reason: Mapped[str | None] = mapped_column(String(30))
    geom: Mapped[Any | None] = mapped_column(Geometry("POINT", srid=4326, spatial_index=True))
    borehole_depth_m: Mapped[float | None] = mapped_column(Float)
    rock_head_m: Mapped[float | None] = mapped_column(Float)
    project_name: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(Text)
    location_name: Mapped[str | None] = mapped_column(Text)
    pages: Mapped[list[int]] = mapped_column(
        ARRAY(Integer), nullable=False, server_default=text("'{}'::int[]")
    )
    record: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    lint: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    # Lint that depends on the other boreholes of the document (cluster, shared coordinates, duplicates);
    # recomputed for the whole document by app.review.service and merged into `lint` on every recompute.
    document_lint: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    # uid of the borehole this one repeats (a person answered a `duplicate` question); null otherwise.
    duplicate_of: Mapped[str | None] = mapped_column(String(40))
    # A value is flagged or a lint error exists (open clarifications are counted separately).
    needs_attention: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = _now_column()
    updated_at: Mapped[datetime] = _now_column()

    __table_args__ = (
        UniqueConstraint("document_id", "group_key", name="uq_boreholes_document_group"),
        Index(
            "ix_boreholes_label_trgm",
            "label_canonical",
            postgresql_using="gin",
            postgresql_ops={"label_canonical": "gin_trgm_ops"},
        ),
        Index(
            "ix_boreholes_location_trgm",
            "location_name",
            postgresql_using="gin",
            postgresql_ops={"location_name": "gin_trgm_ops"},
        ),
        Index(
            "ix_boreholes_project_trgm",
            "project_name",
            postgresql_using="gin",
            postgresql_ops={"project_name": "gin_trgm_ops"},
        ),
    )


class BoreholeLayer(Base):
    """Query columns for SQL tools; rebuilt from the record on every change."""

    __tablename__ = "layers"

    uid: Mapped[str] = mapped_column(ForeignKey("boreholes.uid", ondelete="CASCADE"), primary_key=True)
    idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    depth_from_m: Mapped[float | None] = mapped_column(Float)
    depth_to_m: Mapped[float | None] = mapped_column(Float)
    din4023_code: Mapped[str | None] = mapped_column(String(10))
    english_lithology: Mapped[str | None] = mapped_column(Text)
    spt_n_value: Mapped[int | None] = mapped_column(Integer)
    spt_refusal: Mapped[bool | None] = mapped_column(Boolean)
    rqd_pct: Mapped[float | None] = mapped_column(Float)
    core_recovery_pct: Mapped[float | None] = mapped_column(Float)

    __table_args__ = (Index("ix_layers_din_depth", "din4023_code", "depth_to_m"),)


class BoreholeGroundwater(Base):
    __tablename__ = "groundwater"

    uid: Mapped[str] = mapped_column(ForeignKey("boreholes.uid", ondelete="CASCADE"), primary_key=True)
    idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    depth_m: Mapped[float | None] = mapped_column(Float)
    date: Mapped[str | None] = mapped_column(Text)


class FieldValue(Base):
    """Provenance of one value path of one borehole."""

    __tablename__ = "field_values"

    uid: Mapped[str] = mapped_column(ForeignKey("boreholes.uid", ondelete="CASCADE"), primary_key=True)
    path: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[Any | None] = mapped_column(JSONB)
    raw: Mapped[str | None] = mapped_column(Text)
    document_id: Mapped[str | None] = mapped_column(String(40))
    page: Mapped[int | None] = mapped_column(Integer)
    box: Mapped[list[float] | None] = mapped_column(JSONB)
    cell: Mapped[str | None] = mapped_column(Text)
    method: Mapped[str] = mapped_column(String(20), nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="unreviewed")
    state: Mapped[str] = mapped_column(String(20), nullable=False, server_default="ok")
    ai_value: Mapped[Any | None] = mapped_column(JSONB)
    flag: Mapped[str | None] = mapped_column(Text)
    readings: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    updated_at: Mapped[datetime] = _now_column()


class Revision(Base):
    __tablename__ = "revisions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    uid: Mapped[str] = mapped_column(ForeignKey("boreholes.uid", ondelete="CASCADE"), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    changes: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = _now_column()

    __table_args__ = (UniqueConstraint("uid", "revision", name="uq_revisions_uid_revision"),)


class Clarification(Base):
    __tablename__ = "clarifications"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="open")
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project: Mapped[str | None] = mapped_column(Text)
    borehole_uids: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'::text[]")
    )
    path: Mapped[str | None] = mapped_column(Text)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    fields: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    evidence: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    answer: Mapped[Any | None] = mapped_column(JSONB)
    answered_by: Mapped[str | None] = mapped_column(Text)
    # Makes generation idempotent: the same question is never asked twice.
    dedupe_key: Mapped[str | None] = mapped_column(Text, unique=True)
    created_at: Mapped[datetime] = _now_column()
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_clarifications_uids", "borehole_uids", postgresql_using="gin"),)


class ResultSet(Base):
    __tablename__ = "result_sets"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    uids: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False)
    located_count: Mapped[int] = mapped_column(Integer, nullable=False)
    unlocated_count: Mapped[int] = mapped_column(Integer, nullable=False)
    excluded_unreviewed: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    bbox: Mapped[list[float] | None] = mapped_column(JSONB)
    area: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _now_column()
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now() + interval '7 days'")
    )


class Event(Base):
    """Live-update log. `seq` is the public SSE id, assigned at commit in commit order (EVENT_SEQ_DDL).

    `id` is allocated at insert, so two transactions can commit out of `id` order and a stream that
    followed `id` could skip the later commit. `seq` is set by a deferred trigger that holds an advisory
    lock until its transaction ends, so a lower `seq` is always visible before a higher one.
    """

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    seq: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    document_id: Mapped[str | None] = mapped_column(String(40), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = _now_column()


EVENT_SEQ_LOCK = 7_342_001
EVENT_SEQ_DDL = (
    "CREATE SEQUENCE IF NOT EXISTS events_seq_counter",
    f"""
    CREATE OR REPLACE FUNCTION events_assign_seq() RETURNS trigger AS $$
    BEGIN
        PERFORM pg_advisory_xact_lock({EVENT_SEQ_LOCK});
        UPDATE events SET seq = nextval('events_seq_counter') WHERE id = NEW.id;
        RETURN NULL;
    END
    $$ LANGUAGE plpgsql
    """,  # noqa: S608 (only an integer constant is interpolated)
    "DROP TRIGGER IF EXISTS events_assign_seq ON events",
    """
    CREATE CONSTRAINT TRIGGER events_assign_seq AFTER INSERT ON events
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION events_assign_seq()
    """,
)

for _statement in EVENT_SEQ_DDL:
    listen(Event.__table__, "after_create", DDL(_statement))  # type: ignore[no-untyped-call]


class ProviderCall(Base):
    """Ledger of paid provider calls (cost from the provider's usage report or the price table)."""

    __tablename__ = "provider_calls"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    document_id: Mapped[str | None] = mapped_column(String(40), index=True)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    purpose: Mapped[str] = mapped_column(String(30), nullable=False)
    model: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    pages: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False, server_default=text("0"))
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = _now_column()


class GeocodeCache(Base):
    __tablename__ = "geocode_cache"

    query_norm: Mapped[str] = mapped_column(Text, primary_key=True)
    response: Mapped[list[Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = _now_column()
