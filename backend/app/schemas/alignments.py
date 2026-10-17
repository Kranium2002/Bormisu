"""Planned lines (contract 1.3.0): Alignment, AlignmentQuery, AlignmentHit, AlignmentResult."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from app.schemas.common import ApiModel, ReviewStatus
from app.schemas.map import ResultSetOut

DEFAULT_BUFFER_M = 100.0
MAX_BUFFER_M = 1000.0


class AlignmentOut(ApiModel):
    alignment_id: str
    name: str
    file_name: str
    format: Literal["geojson", "kml", "gpx", "csv"]
    source_crs: str
    geometry: dict[str, Any]
    length_m: float
    vertex_count: int
    part_count: int
    bbox: list[float]
    buffer_m: float
    created_at: datetime


class AlignmentList(ApiModel):
    alignments: list[AlignmentOut]


class AlignmentQuery(ApiModel):
    buffer_m: float | None = Field(default=None, gt=0, le=MAX_BUFFER_M)
    include_unreviewed: bool = False


class AlignmentHit(ApiModel):
    uid: str
    borehole_id: str
    document_id: str
    project_name: str | None = None
    borehole_depth_m: float | None = None
    review_status: ReviewStatus
    crs_status: str
    position: list[float]
    offset_m: float
    chainage_m: float
    side: Literal["left", "right", "on"]


class AlignmentResult(ApiModel):
    alignment_id: str
    buffer_m: float
    include_unreviewed: bool
    length_m: float
    metric_crs: str
    buffer_polygon: dict[str, Any]
    hits: list[AlignmentHit]
    excluded_unreviewed: int
    not_on_map: int
    result_set: ResultSetOut
