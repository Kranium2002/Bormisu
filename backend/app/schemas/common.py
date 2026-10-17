"""Base model and shared enums for the API (contracts/openapi.yaml)."""

from __future__ import annotations

from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer


class ApiModel(BaseModel):
    """Base for API payloads.

    The contract distinguishes nullable fields (send `null`) from optional non-nullable ones (omit when
    unknown). Fields listed in `omit_if_none` are dropped from the output when they are None.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    omit_if_none: ClassVar[frozenset[str]] = frozenset()

    @model_serializer(mode="wrap")
    def _drop_unknown_optional(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        for name in self.omit_if_none:
            if name in data and data[name] is None:
                del data[name]
        return data


Box = list[float]

DocumentStatus = Literal["queued", "classifying", "extracting", "needs_review", "done", "failed"]
PageType = Literal["log", "lab_table", "text", "drawing", "photo", "unknown"]
PageRole = Literal[
    "log_sheet",
    "log_continuation",
    "summary_table",
    "coordinate_table",
    "lab_results",
    "legend_or_key",
    "location_plan",
    "cross_section",
    "narrative",
    "cover_or_toc",
    "photos",
    "blank",
    "duplicate",
    "other",
]
Handwriting = Literal["none", "annotations", "partial", "full"]
OcrStatus = Literal["pending", "done", "skipped", "failed"]
Method = Literal["read", "ocr", "derived", "guessed", "edited"]
ValueStatus = Literal["unreviewed", "approved", "flagged"]
ValueState = Literal["ok", "not_in_source", "illegible"]
ReviewStatus = Literal["unreviewed", "in_review", "approved"]
CrsStatus = Literal["stated", "inferred", "confirmed", "unknown"]
UnplottedReason = Literal["no_coordinates", "crs_unknown", "crs_unconfirmed", "implausible"]
ClarificationKind = Literal[
    "crs_confirm",
    "locate_borehole",
    "choose_reading",
    "datum_convention",
    "unit_ambiguous",
    "borehole_boundary",
    "duplicate",
    "conflicting_sources",
    "chat_parameter",
]
ClarificationStatus = Literal["open", "answered", "skipped"]

ERROR_CODES = frozenset(
    {
        "validation_error",
        "route_not_found",
        "document_not_found",
        "page_not_found",
        "borehole_not_found",
        "path_not_found",
        "result_set_not_found",
        "clarification_not_found",
        "demo_mode",
        "too_large",
        "unsupported_type",
        "not_failed",
        "revision_conflict",
        "unparseable_value",
        "crs_invalid",
        "already_resolved",
        "answer_invalid",
        "chat_unavailable",
        "geocoder_unavailable",
        "rate_limited",
        "internal_error",
    }
)


class FieldError(ApiModel):
    loc: list[str | int]
    msg: str


class ErrorBody(ApiModel):
    detail: str
    code: str
    errors: list[FieldError] | None = None

    omit_if_none = frozenset({"errors"})
