"""BoreholeRecord and review payloads.

`BoreholeBody` is what `boreholes.record` stores; `BoreholeRecord` adds the server-managed fields.
No field has a default that looks like data: unknown is None.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from app.schemas.common import (
    ApiModel,
    Box,
    CrsStatus,
    Method,
    ReviewStatus,
    UnplottedReason,
    ValueState,
    ValueStatus,
)


class Reading(ApiModel):
    reader: str
    text: str
    confidence: float | None = None


class Provenance(ApiModel):
    document_id: str | None = None
    page: int | None
    box: Box | None
    raw: str | None
    cell: str | None = None
    method: Method
    confidence: float | None = Field(ge=0, le=1)
    status: ValueStatus
    state: ValueState
    ai_value: Any = None
    flag: str | None = None
    readings: list[Reading] = Field(default_factory=list)


class Lint(ApiModel):
    path: str
    rule: str
    severity: Literal["warning", "error"]
    message: str


class Coordinates(ApiModel):
    latitude: float | None = None
    longitude: float | None = None
    local_x: float | None = None
    local_y: float | None = None
    coordinate_system: str | None = None
    crs_code: str | None = None
    # Server-computed name of crs_code (registry label, else the EPSG name); no provenance entry.
    crs_label: str | None = None
    x_raw: str | None = None
    y_raw: str | None = None
    axis_labels_raw: str | None = None


def _iso_date_or_none(value: object) -> object:
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        date.fromisoformat(value)  # raises ValueError for anything that is not an ISO date
        return value
    raise ValueError("expected an ISO date string")


class BoreholeMetadata(ApiModel):
    borehole_id: str
    aliases: list[str] = Field(default_factory=list)
    borehole_name: str | None = None
    location_name: str | None = None
    country: str | None = None
    project_id: str | None = None
    project_name: str | None = None
    client: str | None = None
    drilling_contractor: str | None = None
    drilling_method: str | None = None
    drilling_date: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    surface_elevation_mASL: float | None = None
    elevation_datum: str | None = None
    depth_origin: Literal["ground", "mudline", "seabed", "relative"] | None = None
    coordinates: Coordinates = Field(default_factory=Coordinates)
    borehole_depth_m: float | None = Field(default=None, ge=0)
    borehole_depth_source: Literal["printed", "end_note", "last_layer"] | None = None
    borehole_length_m: float | None = Field(default=None, ge=0)
    inclination_deg: float | None = None
    casing_info: str | None = None
    notes: str | None = None

    _check_dates = field_validator("start_date", "end_date", mode="before")(_iso_date_or_none)


class Layer(ApiModel):
    depth_from_m: float
    depth_to_m: float
    thickness_m: float | None = None
    original_description: str | None = None
    english_lithology: str | None = None
    description_language: str | None = None
    din4023_code: str | None = None
    din4023_notation: str | None = None
    uscs_group: str | None = None
    stratigraphic_name: str | None = None
    engineering_soil_unit: str | None = None
    geologic_age: str | None = None
    colour: str | None = None
    consistency_density: str | None = None
    moisture: str | None = None
    weathering: str | None = None
    is_core: bool | None = None
    rqd_pct: float | None = Field(default=None, ge=0)
    core_recovery_pct: float | None = Field(default=None, ge=0)
    spt_n_value: int | None = Field(default=None, ge=0)
    spt_raw: str | None = None
    spt_refusal: bool | None = None
    spt_increments: list[int] | None = None
    spt_increment_mm: int | None = None
    spt_penetration_cm: float | None = None
    spt_depth_m: float | None = None
    ucs_mpa: float | None = None


class GroundwaterReading(ApiModel):
    type: Literal["strike", "rest", "standpipe", "other"]
    depth_m: float | None
    elevation_m: float | None = None
    date: str | None = None
    raw: str | None = None


class Sample(ApiModel):
    name: str
    type_code: str | None = None
    depth_from_m: float | None = None
    depth_to_m: float | None = None


class TestResult(ApiModel):
    __test__ = False  # not a pytest class

    name: str
    value: float | None
    qualifier: str | None = None
    unit: str | None = None
    sample_name: str | None = None
    depth_m: float | None = None


class BoreholeBody(ApiModel):
    """The editable part of a record, stored in `boreholes.record`."""

    metadata: BoreholeMetadata
    stratigraphy: list[Layer] = Field(default_factory=list)
    groundwater: list[GroundwaterReading] = Field(default_factory=list)
    samples: list[Sample] = Field(default_factory=list)
    test_results: list[TestResult] = Field(default_factory=list)
    rock_head_m: float | None = None


class BoreholeRecord(BoreholeBody):
    uid: str
    document_id: str
    source_file: str
    pages: list[int] = Field(default_factory=list)
    revision: int = Field(ge=1)
    updated_at: datetime
    review_status: ReviewStatus
    crs_status: CrsStatus
    plotted: bool
    unplotted_reason: UnplottedReason | None = None
    provenance: dict[str, Provenance] = Field(default_factory=dict)
    lint: list[Lint] = Field(default_factory=list)
    open_clarifications: int = 0


class BoreholeList(ApiModel):
    count: int
    boreholes: list[BoreholeRecord]
    next_cursor: str | None = None


class ValuePatch(ApiModel):
    path: str
    action: Literal["approve", "edit", "flag", "set_state", "reset"]
    value: Any = None
    reason: str | None = None
    state: ValueState | None = None
    if_revision: int | None = None
    # Who performed the action; stored (trimmed, at most 100 characters) as the revision actor.
    confirmed_by: str | None = None


class ProvenanceIn(ApiModel):
    """Provenance as written by the pipeline or the seed when a borehole is created."""

    document_id: str | None = None
    page: int | None = None
    box: Box | None = None
    raw: str | None = None
    cell: str | None = None
    method: Method
    confidence: float | None = None
    status: ValueStatus = "unreviewed"
    state: ValueState = "ok"
    flag: str | None = None
    readings: list[Reading] = Field(default_factory=list)
    # Defaults to the value at the path when the borehole is created (when not given explicitly).
    ai_value: Any = None
