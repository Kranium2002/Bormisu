"""Clarification requests (small forms for a person) and chat request payloads."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from app.schemas.common import ApiModel, Box, ClarificationKind, ClarificationStatus
from app.schemas.map import BoreholeFilter

Widget = Literal[
    "text", "number_unit", "select", "boolean", "map_point", "choose_reading", "page_range", "crs_picker"
]


class Evidence(ApiModel):
    document_id: str
    page: int
    box: Box | None = None
    snippet: str | None = None


class FieldOption(ApiModel):
    value: Any
    label: str
    evidence: Evidence | None = None

    omit_if_none = frozenset({"evidence"})


class FormField(ApiModel):
    name: str
    widget: Widget
    label: str
    help: str | None = None
    required: bool = False
    unit_options: list[str] = Field(default_factory=list)
    options: list[FieldOption] = Field(default_factory=list)
    default: Any = None


class ClarificationOut(ApiModel):
    clarification_id: str
    kind: ClarificationKind
    status: ClarificationStatus
    document_id: str
    borehole_uids: list[str] = Field(default_factory=list)
    path: str | None = None
    question: str
    fields: list[FormField]
    evidence: list[Evidence]
    answer: Any = None
    answered_by: str | None = None
    created_at: datetime
    resolved_at: datetime | None = None


class ClarificationAnswer(ApiModel):
    values: dict[str, Any]
    answered_by: str | None = None


class MapView(ApiModel):
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    zoom: float | None = None


class ChatContext(ApiModel):
    selected_uids: list[str] = Field(default_factory=list)
    active_result_set_id: str | None = None
    filters: BoreholeFilter | None = None
    map_view: MapView | None = None
    units: Literal["m", "ft"] = "m"
    ui_language: str | None = None
    include_unreviewed: bool = False


class ChatRequest(ApiModel):
    id: str | None = None
    messages: list[dict[str, Any]]
    context: ChatContext = Field(default_factory=ChatContext)
