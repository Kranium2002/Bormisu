"""UI commands (contracts/realtime-and-chat.md section 2.3).

Only the commands below ever reach the browser, each with arguments validated by its own model
(unknown arguments are rejected). Tools build commands from server results; the model never writes one.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.schemas.map import BoreholeFilter


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ShowResultSetArgs(_Args):
    result_set_id: str = Field(min_length=1)


class FitResultSetArgs(_Args):
    result_set_id: str = Field(min_length=1)


class FitBoundsArgs(_Args):
    bbox: list[float] = Field(min_length=4, max_length=4)
    outline: bool | None = None


class FocusBoreholeArgs(_Args):
    uid: str = Field(min_length=1)


class OpenDetailArgs(_Args):
    uid: str = Field(min_length=1)
    layer: int | None = Field(default=None, ge=0)


class OpenEvidenceArgs(_Args):
    document_id: str = Field(min_length=1)
    page: int = Field(ge=1)
    box: list[float] | None = Field(default=None, min_length=4, max_length=4)
    uid: str | None = None
    path: str | None = None


class OpenReviewArgs(_Args):
    uid: str = Field(min_length=1)
    path: str | None = None


class SetFiltersArgs(_Args):
    filters: BoreholeFilter


class OpenClarificationArgs(_Args):
    clarification_id: str = Field(min_length=1)


class RequestAreaArgs(_Args):
    prompt: str = Field(min_length=1, max_length=300)


class ExportDocumentArgs(_Args):
    document_id: str = Field(min_length=1)
    format: Literal["xlsx", "csv", "questions"]
    include_unreviewed: bool


UI_COMMANDS: Mapping[str, type[_Args]] = {
    "show_result_set": ShowResultSetArgs,
    "fit_result_set": FitResultSetArgs,
    "fit_bounds": FitBoundsArgs,
    "focus_borehole": FocusBoreholeArgs,
    "open_detail": OpenDetailArgs,
    "open_evidence": OpenEvidenceArgs,
    "open_review": OpenReviewArgs,
    "set_filters": SetFiltersArgs,
    "open_clarification": OpenClarificationArgs,
    "request_area": RequestAreaArgs,
    "export_document": ExportDocumentArgs,
}


class UiCommandError(ValueError):
    """A command outside the allowlist, or arguments its model rejects."""


@dataclass(frozen=True)
class UiCommand:
    """A validated command. Build it with `ui_command`, never directly."""

    command: str
    args: dict[str, Any]

    def data(self) -> dict[str, Any]:
        return {"command": self.command, "args": dict(self.args)}


def ui_command(command: str, args: Mapping[str, Any]) -> UiCommand:
    """Validate a command against the allowlist; raises UiCommandError otherwise."""
    model = UI_COMMANDS.get(command)
    if model is None:
        raise UiCommandError(f"UI command {command!r} is not allowlisted")
    try:
        parsed = model.model_validate(dict(args))
    except ValidationError as exc:
        raise UiCommandError(f"arguments for {command!r} are not valid") from exc
    return UiCommand(command, parsed.model_dump(mode="json", exclude_none=True))


def checked(cmd: UiCommand) -> UiCommand:
    """Re-validate a command at the point it leaves the server (defence in depth)."""
    return ui_command(cmd.command, cmd.args)
