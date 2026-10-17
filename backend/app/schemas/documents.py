"""System and document payloads."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import (
    ApiModel,
    DocumentStatus,
    Handwriting,
    OcrStatus,
    PageRole,
    PageType,
)


class HealthProviders(ApiModel):
    ocr: bool
    classifier: bool
    extractor: bool
    chat: bool
    geocoder: bool


class HealthUpload(ApiModel):
    max_mb: int
    extensions: list[str]


class HealthAuth(ApiModel):
    """Sign-in (contract 1.4.0): whether routes need a session, and whether anyone may register."""

    enabled: bool
    registration: Literal["open", "closed"]


class Health(ApiModel):
    status: Literal["ok", "degraded"]
    mode: Literal["live", "demo"]
    version: str
    providers: HealthProviders
    upload: HealthUpload
    auth: HealthAuth


class Stats(ApiModel):
    documents: int
    boreholes: int
    plotted_boreholes: int
    layers: int


class UploadAccepted(ApiModel):
    document_id: str
    status: DocumentStatus
    duplicate_of: str | None = None


class PageRef(ApiModel):
    document_id: str
    n: int


class PageOut(ApiModel):
    n: int = Field(ge=1)
    type: PageType
    role: PageRole | None = None
    used: bool
    unused_reason: str | None = None
    borehole_ids: list[str] = Field(default_factory=list)
    sheet_label: str | None = None
    handwriting: Handwriting | None = None
    language: str | None = None
    ocr: OcrStatus | None = None
    duplicate_of: PageRef | None = None

    omit_if_none = frozenset({"role", "handwriting", "ocr"})


class DocumentProgress(ApiModel):
    pages_total: int
    pages_classified: int
    pages_ocr_total: int
    pages_ocr_done: int
    boreholes_extracted: int


class Completeness(ApiModel):
    expected_ids: list[str]
    found_ids: list[str]
    missing: list[str]
    unexpected: list[str]


class FoundCounts(ApiModel):
    boreholes: int
    layers: int
    spt: int
    groundwater: int


class DocumentOut(ApiModel):
    document_id: str
    file_name: str
    project: str | None = None
    status: DocumentStatus
    error: str | None = None
    # Contract 1.2.0: the stage that failed (same name as `job.failed.stage`); null unless status is failed.
    failed_stage: str | None = None
    mime_type: str
    size_bytes: int
    sha256: str
    page_count: int | None = None
    found: FoundCounts | None = None
    pages: list[PageOut]
    completeness: Completeness | None = None
    progress: DocumentProgress | None = None
    duplicate_of: str | None = None
    open_clarifications: int = 0
    # Contract 1.2.1: readable notes on a document in review that is not complete, e.g. pages not read.
    warnings: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class DocumentList(ApiModel):
    documents: list[DocumentOut]


class ApproveCleanResult(ApiModel):
    count: int = Field(ge=0)


class CrsPoint(ApiModel):
    uid: str
    lat: float
    lon: float


class CrsCandidate(ApiModel):
    crs: str
    label: str
    score: float | None = Field(default=None, ge=0, le=1)
    verdict: Literal["match", "shifted", "out_of_range"] | None = None
    note: str | None = None
    swap_axes: bool | None = None
    points: list[CrsPoint]

    omit_if_none = frozenset({"score", "verdict", "swap_axes"})


class CrsConfirmRequest(ApiModel):
    crs: str
    swap_axes: bool = False
    confirmed_by: str | None = None
    note: str | None = None


class CrsConfirmResult(ApiModel):
    updated: int = Field(ge=0)
