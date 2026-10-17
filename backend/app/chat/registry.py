"""Tool registry: the only tools the chat model can call, with strict function schemas from their inputs."""

from __future__ import annotations

import copy
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import tools as t
from app.providers.schema import strict_json_schema

# Keywords strict function calling does not accept; Pydantic still enforces them on our side.
_UNSUPPORTED_KEYWORDS = frozenset({"minLength", "maxLength", "discriminator"})


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_model: type[BaseModel]
    run: Callable[[Any, t.TurnState, AsyncSession], Awaitable[t.ToolResult]]
    # The input shown in tool-input-available (default: the validated input).
    shown_input: Callable[[Any, t.TurnState], dict[str, Any]] | None = None
    # True when the answer built on this tool states facts from the database (gets a data-scope part).
    factual: bool = True

    def show(self, inp: BaseModel, state: t.TurnState) -> dict[str, Any]:
        if self.shown_input is not None:
            return self.shown_input(inp, state)
        return inp.model_dump(mode="json")

    def schema(self) -> dict[str, Any]:
        return function_schema(self.input_model)

    def function(self) -> dict[str, Any]:
        """The Responses API function tool definition (strict)."""
        return {
            "type": "function",
            "name": self.name,
            "description": self.description,
            "parameters": self.schema(),
            "strict": True,
        }


def _openai_strict(node: Any) -> Any:
    if isinstance(node, list):
        return [_openai_strict(item) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key in _UNSUPPORTED_KEYWORDS:
            continue
        if key == "properties" and isinstance(value, dict):
            # Property names are data here, not keywords: keep every one of them.
            out[key] = {name: _openai_strict(sub) for name, sub in value.items()}
        else:
            out[key] = _openai_strict(value)
    if "const" in out:
        out["enum"] = [out.pop("const")]
    return out


def function_schema(model: type[BaseModel]) -> dict[str, Any]:
    """app.providers.schema.strict_json_schema, adapted to the keywords strict function calling accepts."""
    schema = _openai_strict(strict_json_schema(model))
    assert isinstance(schema, dict)
    schema.pop("description", None)
    return schema


TOOLS: tuple[Tool, ...] = (
    Tool(
        "resolve_place",
        "Find a place by name: places from uploaded documents first, then a geocoder. Returns candidates "
        "with a bbox and the number of uploaded boreholes inside. Use a candidate's bbox as a search area.",
        t.ResolvePlaceInput,
        t.resolve_place,
    ),
    Tool(
        "search_boreholes",
        "Find boreholes with a filter and save the matches as a result set, which the map shows. Returns "
        "the SQL count, how many are located on the map, how many matches were left out because they are "
        "not reviewed yet, the bbox and a preview of at most 10 boreholes.",
        t.SearchBoreholesInput,
        t.search_boreholes,
        shown_input=t.search_input_shown,
    ),
    Tool(
        "summarize_boreholes",
        "Statistics over a result set, computed in SQL: count, min, max, mean or a histogram of one "
        "numeric field. Depths and thicknesses are in metres.",
        t.SummarizeBoreholesInput,
        t.summarize_boreholes,
    ),
    Tool(
        "get_borehole",
        "One borehole record: metadata, layers with their index, groundwater, review status and the "
        "number of lint findings. Depths are in metres.",
        t.UidInput,
        t.get_borehole,
    ),
    Tool(
        "search_sources",
        "Find passages in the documents' text for narrative questions (methods, observations). Each "
        "passage with a page becomes a citation. Not for counts or values.",
        t.SearchSourcesInput,
        t.search_sources,
    ),
    Tool(
        "get_evidence",
        "Where one value of a borehole was read: document, page, box and the raw text. A value with a "
        "page becomes a numbered citation.",
        t.GetEvidenceInput,
        t.get_evidence,
    ),
    Tool(
        "propose_correction",
        "The user says a value is wrong: opens the Review screen at that value so a person can confirm a "
        "change. Never changes the record.",
        t.ProposeCorrectionInput,
        t.propose_correction,
        factual=False,
    ),
    Tool(
        "prepare_export",
        "Open the export menu for one document, preselected; the user downloads the file.",
        t.PrepareExportInput,
        t.prepare_export,
        factual=False,
    ),
)

REGISTRY: Mapping[str, Tool] = {tool.name: tool for tool in TOOLS}


def get_tool(name: str) -> Tool | None:
    """Only registered tools run; any other name is refused."""
    return REGISTRY.get(name)


def function_tools() -> list[dict[str, Any]]:
    return [copy.deepcopy(tool.function()) for tool in TOOLS]
