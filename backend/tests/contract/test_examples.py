"""Contract tests for the shared fictional examples in contracts/examples.

The frontend adapter tests load the same files, so a rename or a shape change in the contract
fails both suites. See contracts/examples/README.md for the naming rule.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Iterator
from functools import cache
from pathlib import Path
from typing import Any

import pytest
import referencing
import referencing.exceptions
import referencing.jsonschema
from jsonschema import Draft202012Validator

from tests.contract_utils import (
    EXAMPLES_DIR,
    REPO_ROOT,
    SPEC_URI,
    iter_refs,
    load_spec,
    parse_value_path,
    resolve_pointer,
    resolve_value_path,
    schema_errors,
)

SPEC = load_spec()
SCHEMAS: dict[str, Any] = SPEC["components"]["schemas"]
REALTIME_MD = (REPO_ROOT / "contracts" / "realtime-and-chat.md").read_text(encoding="utf-8")
DIN_CODES: dict[str, Any] = json.loads(
    (REPO_ROOT / "assets" / "din4023_patterns" / "din_codes.json").read_text(encoding="utf-8")
)
TARGET_FORMAT_MD = REPO_ROOT / "docs" / "design" / "target-format.md"

ID_RE = re.compile(r"^(doc|bh|rs|cl)_[0-7][0-9A-HJKMNP-TV-Z]{25}$")
ID_PREFIX_RE = re.compile(r"^(doc|bh|rs|cl)_")
ID_KEYS = {"document_id", "uid", "result_set_id", "clarification_id", "active_result_set_id"}
ID_LIST_KEYS = {"uids", "borehole_uids", "selected_uids"}

TOP_JSON = sorted(EXAMPLES_DIR.glob("*.json"))
EVENT_JSON = sorted((EXAMPLES_DIR / "events").glob("*.json"))
CHAT_SSE = sorted((EXAMPLES_DIR / "chat").glob("*.sse"))

# Files other sessions rely on by name (BACKEND.md M0, FRONTEND.md section 4).
REQUIRED_FILES = {
    "Health.live.json",
    "Health.demo.json",
    "UploadAccepted.queued.json",
    "UploadAccepted.duplicate.json",
    "Document.classifying.json",
    "Document.needs_review.json",
    "Document.failed.json",
    "Document.done.json",
    "DocumentList.json",
    "BoreholeRecord.full.json",
    "BoreholeRecord.unplotted_no_coordinates.json",
    "BoreholeRecord.crs_unconfirmed.json",
    "BoreholeRecord.approved.json",
    "BoreholeList.json",
    "ValuePatch.approve.json",
    "ValuePatch.edit.json",
    "ValuePatch.flag.json",
    "ValuePatch.set_state.json",
    "ValuePatch.reset.json",
    "CrsCandidate.list.json",
    "CrsConfirmRequest.json",
    "BoreholeFilter.bbox.json",
    "BoreholeFilter.polygon.json",
    "BoreholeFilter.circle.json",
    "BoreholeFilter.lithology.json",
    "ResultSet.located.json",
    "ResultSet.empty_area.json",
    "BoreholeFeatureCollection.json",
    "PlaceCandidate.list.json",
    "Clarification.answered.json",
    "ClarificationAnswer.crs_confirm.json",
    "ClarificationAnswer.choose_reading.json",
    "Stats.json",
    "ChatRequest.json",
    "chat/turn.sse",
    "chat/error.sse",
}
REQUIRED_ERROR_CODES = {
    "validation_error",
    "route_not_found",
    "document_not_found",
    "borehole_not_found",
    "path_not_found",
    "demo_mode",
    "too_large",
    "unsupported_type",
    "revision_conflict",
    "unparseable_value",
    "chat_unavailable",
    "internal_error",
}
KIND_WIDGETS = {
    "crs_confirm": {"crs_picker"},
    "locate_borehole": {"map_point"},
    "choose_reading": {"choose_reading"},
    "datum_convention": {"select"},
    "unit_ambiguous": {"number_unit"},
    "borehole_boundary": {"page_range"},
    "duplicate": {"select", "boolean"},
    "conflicting_sources": {"select"},
    "chat_parameter": {"select"},
}
OPTION_WIDGETS = {"select", "choose_reading", "crs_picker"}


def _obj(required: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "required": list(required),
        "additionalProperties": False,
        "properties": required,
    }


_ID = {"type": "string", "pattern": ID_RE.pattern}
# realtime-and-chat.md section 1: data JSON per event type ("Document"/"Clarification" = full schema).
EVENT_SCHEMAS: dict[str, str | dict[str, Any]] = {
    "document.updated": "Document",
    "document.deleted": _obj({"document_id": _ID}),
    "borehole.created": _obj(
        {
            "uid": _ID,
            "document_id": _ID,
            "revision": {"type": "integer", "minimum": 1},
            "plotted": {"type": "boolean"},
        }
    ),
    "borehole.updated": _obj({"uid": _ID, "revision": {"type": "integer", "minimum": 1}}),
    "clarification.created": "Clarification",
    "clarification.resolved": _obj({"clarification_id": _ID, "status": {"enum": ["answered", "skipped"]}}),
    "job.failed": _obj(
        {
            "document_id": _ID,
            "stage": {"type": "string", "minLength": 1},
            "detail": {"type": "string", "minLength": 1},
            "retryable": {"type": "boolean"},
        }
    ),
}
# realtime-and-chat.md section 2.2: data part payloads.
DATA_PART_SCHEMAS: dict[str, str | dict[str, Any]] = {
    "data-result-set": {
        "type": "object",
        "required": ["result_set_id", "count", "bbox"],
        "additionalProperties": False,
        "properties": {
            "result_set_id": _ID,
            "count": {"type": "integer", "minimum": 0},
            "located_count": {"type": "integer", "minimum": 0},
            "unlocated_count": {"type": "integer", "minimum": 0},
            "bbox": {"type": ["array", "null"], "items": {"type": "number"}, "minItems": 4, "maxItems": 4},
            "area": {},
        },
    },
    "data-citation": {
        "type": "object",
        "required": ["citation_id", "document_id", "page", "box", "snippet"],
        "additionalProperties": False,
        "properties": {
            "citation_id": {"type": "string", "minLength": 1},
            "document_id": _ID,
            "page": {"type": "integer", "minimum": 1},
            "box": {"type": ["array", "null"], "items": {"type": "number"}, "minItems": 4, "maxItems": 4},
            "uid": _ID,
            "path": {"type": "string"},
            "snippet": {"type": ["string", "null"]},
        },
    },
    "data-scope": _obj(
        {
            "included": {"type": "string", "minLength": 1},
            "excluded_unreviewed": {"type": "integer", "minimum": 0},
            "unlocated_in_scope": {"type": "integer", "minimum": 0},
            "documents_processing": {"type": "integer", "minimum": 0},
        }
    ),
    "data-clarification": "Clarification",
}


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------


def _rel(path: Path) -> str:
    return path.relative_to(EXAMPLES_DIR).as_posix()


@cache
def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _schema_of(path: Path) -> str:
    return path.name.split(".", 1)[0]


def _section(markdown: str, start: str, end: str | None) -> str:
    begin = markdown.index(start)
    stop = markdown.index(end, begin) if end else len(markdown)
    return markdown[begin:stop]


def _table_codes(section: str, pattern: str) -> list[str]:
    return re.findall(pattern, section, flags=re.MULTILINE)


def _inline_errors(instance: Any, schema: str | dict[str, Any]) -> list[str]:
    if isinstance(schema, str):
        return schema_errors(instance, schema)
    validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    return [f"{list(e.absolute_path)}: {e.message}" for e in validator.iter_errors(instance)]


def _walk(node: Any, path: tuple[Any, ...] = ()) -> Iterator[tuple[tuple[Any, ...], Any]]:
    yield path, node
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _walk(value, (*path, key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _walk(value, (*path, index))


DONE = "[DONE]"


@cache
def _sse_chunks(path: Path) -> tuple[Any, ...]:
    raw = path.read_bytes()
    assert b"\r" not in raw, f"{_rel(path)}: CR characters found; .sse files use LF line endings"
    text = raw.decode("utf-8")
    assert text.endswith("\n\n"), f"{_rel(path)}: every frame must end with a blank line"
    frames = text[:-2].split("\n\n")
    chunks: list[Any] = []
    for index, frame in enumerate(frames):
        assert "\n" not in frame, f"{_rel(path)} frame {index}: one data line per frame: {frame!r}"
        assert frame.startswith("data: "), f"{_rel(path)} frame {index}: not a 'data: ' line: {frame!r}"
        payload = frame[len("data: ") :]
        if payload == DONE:
            assert index == len(frames) - 1, f"{_rel(path)}: data: [DONE] must be the last frame"
            chunks.append(DONE)
        else:
            chunk = json.loads(payload)
            assert isinstance(chunk, dict) and isinstance(chunk.get("type"), str), f"frame {index}: {payload}"
            chunks.append(chunk)
    assert chunks and chunks[-1] == DONE, f"{_rel(path)}: the stream must end with data: [DONE]"
    return tuple(chunks)


def _all_payloads() -> list[tuple[str, Any]]:
    out = [(_rel(p), _load(p)) for p in TOP_JSON + EVENT_JSON]
    for path in CHAT_SSE:
        out += [(f"{_rel(path)}#{i}", c) for i, c in enumerate(_sse_chunks(path)) if c != DONE]
    return out


def _instances(schema: str) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for path in TOP_JSON:
        if _schema_of(path) == schema:
            data = _load(path)
            items = data if isinstance(data, list) else [data]
            out += [(_rel(path), item) for item in items]
    return out


def _documents() -> list[tuple[str, dict[str, Any]]]:
    out = list(_instances("Document"))
    out += [("DocumentList.json", d) for _, lst in _instances("DocumentList") for d in lst["documents"]]
    out.append(("events/document.updated.json", _load(EXAMPLES_DIR / "events" / "document.updated.json")))
    return out


def _records() -> list[tuple[str, dict[str, Any]]]:
    out = list(_instances("BoreholeRecord"))
    out += [(src, r) for src, lst in _instances("BoreholeList") for r in lst["boreholes"]]
    return out


def _clarifications() -> list[tuple[str, dict[str, Any]]]:
    out = list(_instances("Clarification"))
    out.append(
        ("events/clarification.created.json", _load(EXAMPLES_DIR / "events" / "clarification.created.json"))
    )
    for path in CHAT_SSE:
        try:
            chunks = _sse_chunks(path)
        except (AssertionError, ValueError):
            continue  # reported by test_chat_stream_follows_protocol; keep collection working
        out += [
            (_rel(path), c["data"])
            for c in chunks
            if isinstance(c, dict) and c["type"] == "data-clarification"
        ]
    return out


def _by_id(items: list[tuple[str, dict[str, Any]]], key: str) -> dict[str, dict[str, Any]]:
    return {item[key]: item for _, item in items}


DOCS = _by_id(_documents(), "document_id")
RECORDS = _by_id(_records(), "uid")
CLARIFICATIONS = _by_id(_clarifications(), "clarification_id")


def _doc_pages(document_id: str) -> set[int]:
    return {page["n"] for page in DOCS[document_id]["pages"]}


# --------------------------------------------------------------------------------------------
# Layout and schema validation
# --------------------------------------------------------------------------------------------


def test_examples_folder_layout() -> None:
    allowed_meta = {"README.md", ".gitattributes"}
    unexpected = []
    for path in EXAMPLES_DIR.rglob("*"):
        if path.is_dir():
            if _rel(path) not in {"events", "chat"}:
                unexpected.append(_rel(path) + "/")
            continue
        rel = _rel(path)
        ok = (
            rel in allowed_meta
            or (path.parent == EXAMPLES_DIR and path.suffix == ".json")
            or (rel.startswith("events/") and path.suffix == ".json" and "/" not in rel[len("events/") :])
            or (rel.startswith("chat/") and path.suffix == ".sse" and "/" not in rel[len("chat/") :])
        )
        if not ok:
            unexpected.append(rel)
    assert not unexpected, f"files outside the naming rule: {unexpected}"
    readme = (EXAMPLES_DIR / "README.md").read_text(encoding="utf-8").lower()
    assert "fictional" in readme and "changelog" in readme


def test_required_example_files_exist() -> None:
    existing = {_rel(p) for p in EXAMPLES_DIR.rglob("*") if p.is_file()}
    assert sorted(REQUIRED_FILES - existing) == []


@pytest.mark.parametrize("path", TOP_JSON, ids=_rel)
def test_example_validates_against_its_schema(path: Path) -> None:
    name = _schema_of(path)
    assert name in SCHEMAS, f"{path.name}: no schema #/components/schemas/{name}"
    data = _load(path)
    items = data if isinstance(data, list) else [data]
    assert items, f"{path.name}: an array example needs at least one item"
    problems = [f"[{i}] {err}" for i, item in enumerate(items) for err in schema_errors(item, name)]
    assert not problems, f"{path.name} against {name}:\n  " + "\n  ".join(problems)


def test_event_table_matches_test_schemas() -> None:
    section = _section(REALTIME_MD, "## 1.", "## 2.")
    documented = set(_table_codes(section, r"^\| `([a-z]+\.[a-z]+)` \|"))
    assert documented == set(EVENT_SCHEMAS)


@pytest.mark.parametrize("path", EVENT_JSON, ids=_rel)
def test_event_example_validates(path: Path) -> None:
    event_type = path.name.removesuffix(".json")
    assert event_type in EVENT_SCHEMAS, f"{path.name}: unknown event type"
    errors = _inline_errors(_load(path), EVENT_SCHEMAS[event_type])
    assert not errors, f"{path.name}:\n  " + "\n  ".join(errors)


def test_every_event_type_has_an_example() -> None:
    assert {p.name.removesuffix(".json") for p in EVENT_JSON} == set(EVENT_SCHEMAS)


# --------------------------------------------------------------------------------------------
# Chat stream
# --------------------------------------------------------------------------------------------


def _chunk_types() -> set[str]:
    section = _section(REALTIME_MD, "### 2.1", "### 2.2")
    types = set(re.findall(r'"type":"([a-z-]+)"', section))
    types |= set(_table_codes(_section(REALTIME_MD, "### 2.2", "### 2.3"), r"^\| `(data-[a-z-]+)` \|"))
    return types


def _ui_commands() -> dict[str, tuple[set[str], set[str]]]:
    """command -> (required arg names, all arg names) from the section 2.3 table."""
    section = _section(REALTIME_MD, "### 2.3", "### 2.4")
    out: dict[str, tuple[set[str], set[str]]] = {}
    for command, args in re.findall(r"^\| `([a-z_]+)` \| `\{(.*?)\}` \|", section, flags=re.MULTILINE):
        names = [part.split(":")[0].strip() for part in args.split(",")]
        out[command] = ({n for n in names if not n.endswith("?")}, {n.rstrip("?") for n in names})
    return out


def _tool_names() -> set[str]:
    section = _section(REALTIME_MD, "### 2.4", "### 2.5")
    return set(_table_codes(section, r"^\| `([a-z_]+)` \|"))


def test_stream_vocabulary_parsed_from_contract() -> None:
    assert {
        "start",
        "text-delta",
        "tool-input-available",
        "error",
        "data-ui-command",
        "finish",
    } <= _chunk_types()
    assert len(_ui_commands()) == 11
    assert _tool_names() == {
        "resolve_place",
        "search_boreholes",
        "summarize_boreholes",
        "get_borehole",
        "search_sources",
        "get_evidence",
        "propose_correction",
        "prepare_export",
    }


@pytest.mark.parametrize("path", CHAT_SSE, ids=_rel)
def test_chat_stream_follows_protocol(path: Path) -> None:
    chunks = [c for c in _sse_chunks(path) if c != DONE]
    allowed, commands, tools = _chunk_types(), _ui_commands(), _tool_names()
    assert chunks[0]["type"] == "start" and isinstance(chunks[0].get("messageId"), str)
    assert chunks[-1]["type"] == "finish"
    in_step = False
    open_text: set[str] = set()
    tool_calls: dict[str, str] = {}
    answered_calls: set[str] = set()
    result_set_ids: set[str] = set()
    for index, chunk in enumerate(chunks):
        kind = chunk["type"]
        where = f"{_rel(path)} chunk {index} ({kind})"
        assert kind in allowed, f"{where}: type not in the contract"
        if kind == "start-step":
            assert not in_step, f"{where}: nested step"
            in_step = True
        elif kind == "finish-step":
            assert in_step, f"{where}: finish-step without start-step"
            in_step = False
        elif kind == "text-start":
            open_text.add(chunk["id"])
        elif kind == "text-delta":
            assert chunk["id"] in open_text and isinstance(chunk["delta"], str), where
        elif kind == "text-end":
            assert chunk["id"] in open_text, where
            open_text.discard(chunk["id"])
        elif kind == "tool-input-available":
            assert chunk["toolName"] in tools, f"{where}: unknown tool {chunk['toolName']!r}"
            assert chunk["toolCallId"] not in tool_calls and isinstance(chunk["input"], dict), where
            tool_calls[chunk["toolCallId"]] = chunk["toolName"]
            _check_tool_input(chunk["toolName"], chunk["input"], where)
        elif kind == "tool-output-available":
            call = chunk["toolCallId"]
            assert call in tool_calls and call not in answered_calls, f"{where}: output without input"
            answered_calls.add(call)
            output = _check_tool_output(tool_calls[call], chunk["output"], where)
            if tool_calls[call] == "search_boreholes":
                result_set_ids.add(output["result_set_id"])
        elif kind == "data-ui-command":
            assert chunk.get("transient") is True, f"{where}: ui commands are transient"
            command, args = chunk["data"]["command"], chunk["data"]["args"]
            assert command in commands, f"{where}: {command!r} is not allowlisted"
            required, known = commands[command]
            assert required <= set(args) <= known, f"{where}: args {sorted(args)} for {command}"
        elif kind.startswith("data-"):
            assert chunk.get("transient") is not True, f"{where}: only data-ui-command is transient"
            errors = _inline_errors(chunk["data"], DATA_PART_SCHEMAS[kind])
            assert not errors, f"{where}: {errors}"
            if kind == "data-result-set":
                assert chunk["data"]["result_set_id"] in result_set_ids, f"{where}: no tool created this set"
        elif kind == "error":
            assert isinstance(chunk["errorText"], str) and chunk["errorText"], where
            assert chunks[index + 1]["type"] == "finish", f"{where}: error is followed by finish"
    assert not in_step and not open_text, f"{_rel(path)}: unclosed step or text part"
    assert set(tool_calls) == answered_calls, f"{_rel(path)}: tool calls without output"


def _check_tool_input(tool: str, data: dict[str, Any], where: str) -> None:
    if tool == "resolve_place":
        assert set(data) == {"query"} and isinstance(data["query"], str), where
    elif tool == "search_boreholes":
        assert not schema_errors(data, "BoreholeFilter"), f"{where}: {schema_errors(data, 'BoreholeFilter')}"
    elif tool == "get_evidence":
        assert set(data) == {"uid", "path"}, where
        parse_value_path(data["path"])


def _check_tool_output(tool: str, data: dict[str, Any], where: str) -> dict[str, Any]:
    if tool == "resolve_place":
        assert set(data) == {"candidates"}, where
        for candidate in data["candidates"]:
            assert not schema_errors(candidate, "PlaceCandidate"), where
    elif tool == "search_boreholes":
        keys = {"result_set_id", "count", "located_count", "unlocated_count", "excluded_unreviewed", "bbox"}
        assert keys <= set(data) <= keys | {"preview"}, where
        assert len(data.get("preview", [])) <= 10, where
    elif tool == "get_evidence":
        assert set(data) == {"document_id", "page", "box", "raw", "method"}, where
    return data


def test_chat_examples_cover_the_turn_and_the_error_case() -> None:
    turn = [c for c in _sse_chunks(EXAMPLES_DIR / "chat" / "turn.sse") if c != DONE]
    kinds = Counter(c["type"] for c in turn)
    tools = {c["toolName"] for c in turn if c["type"] == "tool-input-available"}
    assert {"resolve_place", "search_boreholes"} <= tools
    for kind in ("data-result-set", "data-citation", "data-ui-command", "data-scope", "text-delta"):
        assert kinds[kind] >= 1, f"turn.sse lacks {kind}"
    error = [c["type"] for c in _sse_chunks(EXAMPLES_DIR / "chat" / "error.sse") if c != DONE]
    assert "error" in error and error[-1] == "finish"


# --------------------------------------------------------------------------------------------
# Coverage of enums
# --------------------------------------------------------------------------------------------


def _enum(name: str) -> set[str]:
    return set(SCHEMAS[name]["enum"])


def test_every_clarification_kind_has_an_example() -> None:
    kinds = set(SCHEMAS["Clarification"]["properties"]["kind"]["enum"])
    for kind in kinds:
        path = EXAMPLES_DIR / f"Clarification.{kind}.json"
        assert path.is_file(), f"missing {path.name}"
        assert _load(path)["kind"] == kind
    assert {c["kind"] for c in CLARIFICATIONS.values()} == kinds
    answered = _load(EXAMPLES_DIR / "Clarification.answered.json")
    assert answered["status"] == "answered"
    assert answered["answer"] is not None and answered["answered_by"] and answered["resolved_at"]


def test_clarification_widgets_follow_the_kind() -> None:
    for cid, clar in CLARIFICATIONS.items():
        widgets = {f["widget"] for f in clar["fields"]}
        assert widgets & KIND_WIDGETS[clar["kind"]], f"{cid} ({clar['kind']}): widgets {widgets}"
        for field in clar["fields"]:
            if field["widget"] in OPTION_WIDGETS:
                assert field.get("options"), f"{cid}: {field['name']} needs options"
            if field["widget"] == "crs_picker" or clar["kind"] == "conflicting_sources":
                assert all("evidence" in o for o in field.get("options", [])), f"{cid}: options need evidence"
            if field["widget"] == "choose_reading":
                assert len(field["options"]) >= 2, cid
            if field["widget"] == "number_unit":
                assert field.get("unit_options"), cid
    all_widgets = {f["widget"] for c in CLARIFICATIONS.values() for f in c["fields"]}
    assert all_widgets == set(SCHEMAS["FormField"]["properties"]["widget"]["enum"])


def test_provenance_covers_every_status_state_and_method() -> None:
    entries = [p for r in RECORDS.values() for p in r["provenance"].values()]
    provenance = SCHEMAS["Provenance"]["properties"]
    assert {p["status"] for p in entries} == set(provenance["status"]["enum"])
    assert {p["state"] for p in entries} == set(provenance["state"]["enum"])
    assert {p["method"] for p in entries} == _enum("Method")
    assert any(p.get("cell") and p["page"] is None and p["box"] is None for p in entries)
    assert any(p["box"] is None and p["page"] is not None for p in entries)
    assert any(len(p.get("readings") or []) >= 2 for p in entries)


def test_documents_cover_page_types_roles_and_statuses() -> None:
    pages = [page for d in DOCS.values() for page in d["pages"]]
    assert {p["type"] for p in pages} == _enum("PageType")
    assert {p["role"] for p in pages if "role" in p} == _enum("PageRole")
    statuses = {d["status"] for d in DOCS.values()}
    assert _enum("DocumentStatus") - {"queued"} <= statuses
    assert "queued" in {u["status"] for _, u in _instances("UploadAccepted")}


def _contract_error_codes() -> set[str]:
    description = SCHEMAS["Error"]["properties"]["code"]["description"]
    listed = description.split("Codes in v1:", 1)[1]
    return {code.strip(" .\n") for code in listed.split(",") if code.strip(" .\n")}


def test_every_error_code_has_an_example() -> None:
    codes = _contract_error_codes()
    assert codes >= REQUIRED_ERROR_CODES
    examples = {}
    for path in TOP_JSON:
        if _schema_of(path) == "Error":
            body = _load(path)
            assert path.name == f"Error.{body['code']}.json", f"{path.name}: file name and code differ"
            examples[body["code"]] = body
    assert set(examples) == codes
    internals = re.compile(
        r"Traceback|File \"|\.py\b|SELECT |INSERT |sqlalchemy|asyncpg|Exception|[A-Za-z]:\\"
    )
    for code, body in examples.items():
        assert not internals.search(body["detail"]), f"{code}: detail leaks internals"
        if code == "validation_error":
            assert body["errors"] and all({"loc", "msg"} <= set(e) for e in body["errors"])
        else:
            assert body.get("errors") is None, f"{code}: errors[] only with validation_error"
    assert examples["demo_mode"]["detail"] == "demo_mode"


def test_health_examples() -> None:
    for name in ("live", "demo"):
        health = _load(EXAMPLES_DIR / f"Health.{name}.json")
        assert health["mode"] == name
        assert health["upload"]["max_mb"] == 200
        extensions = health["upload"]["extensions"]
        assert all(e.startswith(".") and e == e.lower() for e in extensions)
        assert {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".docx", ".xlsx", ".csv"} == set(
            extensions
        )
    demo = _load(EXAMPLES_DIR / "Health.demo.json")["providers"]
    assert not (demo["ocr"] and demo["extractor"])


# --------------------------------------------------------------------------------------------
# Data rules
# --------------------------------------------------------------------------------------------


def test_ids_are_opaque_ulids() -> None:
    problems = []
    for source, payload in _all_payloads():
        for path, value in _walk(payload):
            key = path[-1] if path else None
            parent = path[-2] if len(path) > 1 else None
            is_id_slot = key in ID_KEYS or parent in ID_LIST_KEYS or key == "duplicate_of"
            if (
                isinstance(value, str)
                and (is_id_slot or ID_PREFIX_RE.match(value))
                and not ID_RE.match(value)
            ):
                problems.append(f"{source} {list(path)}: {value!r}")
    assert not problems, "\n".join(problems)


def test_din_codes_are_keys_of_the_asset() -> None:
    problems = []
    seen: set[str] = set()
    for source, payload in _all_payloads():
        for path, value in _walk(payload):
            key = path[-1] if path else None
            codes = []
            if key == "din4023_code" and value is not None:
                codes = [value]
            elif key == "din4023_codes":
                codes = list(value)
            for code in codes:
                seen.add(code)
                if code not in DIN_CODES:
                    problems.append(f"{source} {list(path)}: {code!r}")
    assert not problems, "not keys of din_codes.json (case-sensitive): " + ", ".join(problems)
    assert "mG" in seen, "keep a case-sensitive code (mG, not Mg) in the examples"
    assert any(DIN_CODES[c]["kind"] == "rock" for c in seen), "keep a rock code in the examples"


def test_no_zero_coordinate_placeholders() -> None:
    problems = []
    for source, payload in _all_payloads():
        for path, value in _walk(payload):
            if isinstance(value, dict):
                for lat_key, lon_key in (("latitude", "longitude"), ("lat", "lon"), ("local_x", "local_y")):
                    if value.get(lat_key) == 0 and value.get(lon_key) == 0:
                        problems.append(f"{source} {list(path)}: ({lat_key}, {lon_key}) = (0, 0)")
                if value.get("type") == "Point" and value.get("coordinates") == [0, 0]:
                    problems.append(f"{source} {list(path)}: Point [0, 0]")
    assert not problems, "\n".join(problems)


def _test_result_names() -> set[str]:
    text = TARGET_FORMAT_MD.read_text(encoding="utf-8")
    section = _section(text, "## 3.", "## What this means")
    names = set(re.findall(r"^\| ([A-Za-z][A-Za-z -]*?) \|", section, flags=re.MULTILINE))
    return names - {"Field"}


@pytest.mark.skipif(not TARGET_FORMAT_MD.is_file(), reason="docs/design/target-format.md not present")
def test_test_result_names_come_from_the_target_format() -> None:
    allowed = _test_result_names()
    assert {"UCS", "Watercontent", "LiquidLimit"} <= allowed
    used = {t["name"] for r in RECORDS.values() for t in r.get("test_results", [])}
    assert used and used <= allowed, f"not Test Results fields: {sorted(used - allowed)}"


@pytest.mark.parametrize(
    ("source", "record"),
    _records(),
    ids=[f"{source}:{record['metadata']['borehole_id']}" for source, record in _records()],
)
def test_record_internal_rules(source: str, record: dict[str, Any]) -> None:
    label = f"{source} {record['metadata']['borehole_id']}"
    for path, entry in record["provenance"].items():
        value = resolve_value_path(record, path)  # raises when the path or field is missing
        where = f"{label} provenance[{path!r}]"
        if entry.get("cell"):
            assert entry["page"] is None and entry["box"] is None, f"{where}: cell values have no page/box"
        if entry["box"] is not None:
            x, y, w, h = entry["box"]
            assert entry["page"] is not None and x + w <= 1 + 1e-9 and y + h <= 1 + 1e-9, where
        if entry["status"] == "flagged":
            assert isinstance(entry.get("flag"), str) and entry["flag"], f"{where}: flagged needs flag text"
        else:
            assert entry.get("flag") is None, f"{where}: flag text without status flagged"
        if entry["state"] != "ok":
            assert value is None, f"{where}: {entry['state']} values are null"
        if "ai_value" in entry:
            if entry["method"] == "edited":
                assert entry["ai_value"] != value, f"{where}: edited values keep a different ai_value"
            else:
                assert entry["ai_value"] == value, f"{where}: ai_value differs without an edit"
        if entry.get("readings"):
            assert len({r["text"] for r in entry["readings"]}) >= 2, f"{where}: readings must disagree"
    for lint in record["lint"]:
        resolve_value_path(record, lint["path"])

    statuses = {p["status"] for p in record["provenance"].values()}
    expected = (
        "approved"
        if statuses == {"approved"}
        else "unreviewed"
        if statuses == {"unreviewed"}
        else "in_review"
    )
    assert record["review_status"] == expected, f"{label}: review_status should be {expected}"

    coords = record["metadata"].get("coordinates") or {}
    if record["plotted"]:
        assert coords.get("latitude") is not None and coords.get("longitude") is not None, label
        assert record.get("unplotted_reason") is None, label
    else:
        assert record.get("unplotted_reason"), f"{label}: unplotted boreholes need a reason"

    linted = {lint["path"] for lint in record["lint"]}
    for index, layer in enumerate(record["stratigraphy"]):
        assert layer["depth_from_m"] <= layer["depth_to_m"], f"{label} layer {index}"
        if layer.get("spt_refusal"):
            assert layer.get("spt_n_value") is None, f"{label} layer {index}: no N on refusal"
        if (layer.get("rqd_pct") or 0) > 100:
            assert f"stratigraphy[{index}].rqd_pct" in linted, f"{label} layer {index}: RQD > 100 is linted"


def test_full_record_shows_the_demanding_cases() -> None:
    record = _load(EXAMPLES_DIR / "BoreholeRecord.full.json")
    layers = record["stratigraphy"]
    assert any(la.get("spt_n_value") is not None for la in layers)
    assert any(
        la.get("spt_refusal") is True and la.get("spt_n_value") is None and la.get("spt_raw") == "50/120"
        for la in layers
    )
    assert any((la.get("rqd_pct") or 0) > 100 for la in layers)
    assert {g["type"] for g in record["groundwater"]} >= {"strike", "rest"}
    assert record["samples"] and record["test_results"] and record["rock_head_m"] is not None
    assert {lint["severity"] for lint in record["lint"]} == {"warning", "error"}
    meta = record["metadata"]
    assert meta["aliases"] and meta["elevation_datum"] and meta["depth_origin"] == "ground"
    assert meta["borehole_depth_source"] == "printed"
    assert record["crs_status"] == "stated" and meta["coordinates"]["crs_code"].startswith("EPSG:")
    cells = [p for p in record["provenance"].values() if p.get("cell") == "Logdata!C5"]
    assert len(cells) == 1


# --------------------------------------------------------------------------------------------
# Cross-file consistency
# --------------------------------------------------------------------------------------------


def test_objects_with_the_same_id_are_identical_across_files() -> None:
    for items, key in (
        (_documents(), "document_id"),
        (_records(), "uid"),
        (_clarifications(), "clarification_id"),
    ):
        first: dict[str, tuple[str, Any]] = {}
        for source, item in items:
            if item[key] in first:
                other_source, other = first[item[key]]
                assert item == other, f"{item[key]} differs between {other_source} and {source}"
            else:
                first[item[key]] = (source, item)


def test_records_point_at_existing_documents_and_pages() -> None:
    for uid, record in RECORDS.items():
        doc = DOCS.get(record["document_id"])
        assert doc is not None, f"{uid}: document {record['document_id']} has no example"
        assert record["source_file"] == doc["file_name"], uid
        assert set(record.get("pages", [])) <= _doc_pages(doc["document_id"]), uid
        for path, entry in record["provenance"].items():
            source_doc = entry.get("document_id") or record["document_id"]
            assert source_doc in DOCS, f"{uid} {path}: unknown document {source_doc}"
            if entry["page"] is not None:
                assert entry["page"] in _doc_pages(source_doc), f"{uid} {path}: page {entry['page']}"
                if source_doc == record["document_id"]:
                    assert entry["page"] in record.get("pages", []), f"{uid} {path}: page not in record.pages"


def test_document_counts_match_their_records_and_clarifications() -> None:
    open_clarifications = [c for c in CLARIFICATIONS.values() if c["status"] == "open"]
    for doc_id, doc in DOCS.items():
        records = [r for r in RECORDS.values() if r["document_id"] == doc_id]
        if doc.get("found") is not None:
            found = doc["found"]
            assert found["boreholes"] == len(records), doc_id
            assert found["layers"] == sum(len(r["stratigraphy"]) for r in records), doc_id
            assert found["spt"] == sum(1 for r in records for la in r["stratigraphy"] if la.get("spt_raw")), (
                doc_id
            )
            assert found["groundwater"] == sum(len(r["groundwater"]) for r in records), doc_id
        if "open_clarifications" in doc:
            expected = sum(1 for c in open_clarifications if c["document_id"] == doc_id)
            assert doc["open_clarifications"] == expected, f"{doc['file_name']}: open clarifications"
        for page in doc["pages"]:
            if page.get("duplicate_of"):
                target = page["duplicate_of"]
                assert page["n"] in _doc_pages(doc_id) and target["n"] in _doc_pages(target["document_id"])
        if doc.get("completeness"):
            comp = doc["completeness"]
            assert set(comp["missing"]) == set(comp["expected_ids"]) - set(comp["found_ids"]), doc_id
    for uid, record in RECORDS.items():
        expected = sum(1 for c in open_clarifications if uid in c.get("borehole_uids", []))
        assert record.get("open_clarifications", 0) == expected, f"{uid}: open clarifications"


def test_clarifications_reference_existing_things() -> None:
    for cid, clar in CLARIFICATIONS.items():
        assert clar["document_id"] in DOCS, cid
        assert set(clar.get("borehole_uids", [])) <= set(RECORDS), cid
        evidence = list(clar["evidence"])
        evidence += [o["evidence"] for f in clar["fields"] for o in f.get("options", []) if "evidence" in o]
        for item in evidence:
            assert item["page"] in _doc_pages(item["document_id"]), f"{cid}: evidence page {item['page']}"
        if clar.get("path"):
            record = RECORDS[clar["borehole_uids"][0]]
            assert clar["path"] in record["provenance"], f"{cid}: path is not a value of the borehole"


def test_clarification_answers_fit_their_forms() -> None:
    for path in sorted(EXAMPLES_DIR.glob("ClarificationAnswer.*.json")):
        kind = path.name.split(".")[1]
        clar = _load(EXAMPLES_DIR / f"Clarification.{kind}.json")
        values = _load(path)["values"]
        fields = {f["name"]: f for f in clar["fields"]}
        assert set(values) <= set(fields), path.name
        assert {n for n, f in fields.items() if f.get("required")} <= set(values), path.name
        for name, value in values.items():
            if fields[name]["widget"] in OPTION_WIDGETS:
                assert value in [o["value"] for o in fields[name]["options"]], f"{path.name}: {name}"
    answered = _load(EXAMPLES_DIR / "Clarification.answered.json")
    assert set(answered["answer"]) <= {f["name"] for f in answered["fields"]}


def test_map_features_match_plotted_records() -> None:
    collection = _load(EXAMPLES_DIR / "BoreholeFeatureCollection.json")
    features = {f["id"]: f for f in collection["features"]}
    assert set(features) <= set(RECORDS)
    assert set(features) == {uid for uid, r in RECORDS.items() if r["plotted"]}
    for uid, feature in features.items():
        record, props = RECORDS[uid], feature["properties"]
        coords = record["metadata"]["coordinates"]
        assert feature["geometry"]["coordinates"] == [coords["longitude"], coords["latitude"]], uid
        assert props["uid"] == uid and props["document_id"] == record["document_id"]
        assert props["borehole_id"] == record["metadata"]["borehole_id"]
        assert (
            props["review_status"] == record["review_status"] and props["crs_status"] == record["crs_status"]
        )
        assert props["revision"] == record["revision"]
        assert props["open_clarifications"] == record["open_clarifications"]
        attention = (
            any(p["status"] == "flagged" for p in record["provenance"].values())
            or any(lint["severity"] == "error" for lint in record["lint"])
            or record["open_clarifications"] > 0
        )
        assert props["attention"] == attention, uid
    assert any(f["properties"]["attention"] for f in features.values())


def test_result_sets_and_lists_are_consistent() -> None:
    for source, rs in _instances("ResultSet"):
        assert set(rs["uids"]) <= set(RECORDS), source
        assert rs["count"] == len(rs["uids"]) == rs["located_count"] + rs["unlocated_count"], source
        assert rs["located_count"] == sum(RECORDS[u]["plotted"] for u in rs["uids"]), source
        if rs["located_count"] == 0 and rs.get("area"):
            assert rs["bbox"] == rs["area"]["bbox"], f"{source}: empty set echoes the searched area"
    for source, listing in _instances("BoreholeList"):
        assert listing["count"] >= len(listing["boreholes"]), source
        if listing.get("next_cursor") is None:
            assert listing["count"] == len(listing["boreholes"]), source
    stats = _load(EXAMPLES_DIR / "Stats.json")
    assert stats["documents"] == len(DOCS)
    assert stats["boreholes"] == len(RECORDS)
    assert stats["plotted_boreholes"] == sum(r["plotted"] for r in RECORDS.values())
    assert stats["layers"] == sum(len(r["stratigraphy"]) for r in RECORDS.values())


def test_requests_reference_existing_things() -> None:
    provenance_keys = {p for r in RECORDS.values() for p in r["provenance"]}
    for source, patch in _instances("ValuePatch"):
        parse_value_path(patch["path"])
        assert patch["path"] in provenance_keys, f"{source}: path is not a provenance key of any example"
    for source, upload in _instances("UploadAccepted"):
        assert upload["document_id"] in DOCS, source
        if upload.get("duplicate_of"):
            assert (
                upload["duplicate_of"] in DOCS and upload["status"] == DOCS[upload["document_id"]]["status"]
            )
    for source, candidate in _instances("CrsCandidate"):
        assert {p["uid"] for p in candidate["points"]} <= set(RECORDS), source
    verdicts = {c["verdict"]: c for _, c in _instances("CrsCandidate")}
    assert set(verdicts) == {"match", "shifted", "out_of_range"} and verdicts["shifted"]["swap_axes"] is True
    picker = next(
        f for f in _load(EXAMPLES_DIR / "Clarification.crs_confirm.json")["fields"] if f["name"] == "crs"
    )
    assert {o["value"] for o in picker["options"]} <= {c["crs"] for _, c in _instances("CrsCandidate")}
    context = _load(EXAMPLES_DIR / "ChatRequest.json")["context"]
    assert set(context["selected_uids"]) <= set(RECORDS)
    result_sets = {rs["result_set_id"] for _, rs in _instances("ResultSet")}
    assert context["active_result_set_id"] in result_sets


def test_events_reference_existing_things() -> None:
    events = {p.name.removesuffix(".json"): _load(p) for p in EVENT_JSON}
    assert events["document.deleted"]["document_id"] not in DOCS, "a deleted document is gone"
    for name in ("borehole.created", "borehole.updated"):
        record = RECORDS[events[name]["uid"]]
        assert events[name]["revision"] <= record["revision"], name
    created = events["borehole.created"]
    assert created["document_id"] == RECORDS[created["uid"]]["document_id"]
    resolved = events["clarification.resolved"]
    assert CLARIFICATIONS[resolved["clarification_id"]]["status"] == resolved["status"]
    failed = events["job.failed"]
    assert DOCS[failed["document_id"]]["status"] == "failed"
    assert DOCS[failed["document_id"]]["error"] == failed["detail"]


def test_chat_citations_point_at_provenance() -> None:
    for path in CHAT_SSE:
        for chunk in _sse_chunks(path):
            if chunk == DONE or chunk["type"] != "data-citation":
                continue
            data = chunk["data"]
            assert data["document_id"] in DOCS and data["page"] in _doc_pages(data["document_id"])
            if data.get("uid"):
                entry = RECORDS[data["uid"]]["provenance"][data["path"]]
                assert (entry["page"], entry["box"], entry["raw"]) == (
                    data["page"],
                    data["box"],
                    data["snippet"],
                )


# --------------------------------------------------------------------------------------------
# The contract itself
# --------------------------------------------------------------------------------------------


def test_every_ref_in_openapi_resolves() -> None:
    resource = referencing.Resource.from_contents(
        SPEC, default_specification=referencing.jsonschema.DRAFT202012
    )
    resolver = referencing.Registry().with_resource(SPEC_URI, resource).resolver(base_uri=SPEC_URI)
    refs = list(iter_refs(SPEC))
    assert refs
    problems = []
    for location, ref in refs:
        if not ref.startswith("#/"):
            problems.append(f"{location}: external or relative $ref {ref!r}")
            continue
        try:
            resolve_pointer(ref)
            resolver.lookup(ref)
        except (KeyError, IndexError, ValueError, referencing.exceptions.Unresolvable) as exc:
            problems.append(f"{location}: {ref} ({exc})")
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_component_schema_is_valid_json_schema(name: str) -> None:
    Draft202012Validator.check_schema(SCHEMAS[name])


def test_ulid_timestamps_are_plausible() -> None:
    """ULIDs decode to a millisecond timestamp; examples use 2026 times (first char 0-7 by spec)."""
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    for doc_id in DOCS:
        body = doc_id.split("_", 1)[1]
        ms = 0
        for char in body[:10]:
            ms = ms * 32 + alphabet.index(char)
        assert 2025 <= 1970 + math.floor(ms / 1000 / 31_556_952) <= 2027, doc_id
