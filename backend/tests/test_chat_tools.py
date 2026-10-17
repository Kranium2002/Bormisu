"""FICTIONAL data only. Chat tools against PostGIS: SQL counts, scopes, data parts and UI commands.

The site "Fictional Chat Ridge" and its boreholes CR-1 … CR-4 are invented for these tests. Tools run
through `execute_call`, exactly as the chat loop runs them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import pytest
from sqlalchemy import select

from app.chat import registry
from app.chat.commands import UI_COMMANDS
from app.chat.loop import FunctionCall, execute_call
from app.chat.stream import MessageWriter
from app.chat.tools import TurnState, compute_scope
from app.db.models import Borehole, Document, FieldValue, OcrPage, OcrRun, ResultSet
from app.db.session import get_sessionmaker
from app.review.service import commit_change, create_borehole, load_field_values
from app.schemas.boreholes import ProvenanceIn
from app.schemas.clarifications import ChatContext
from tests.contract.test_examples import _tool_names, _ui_commands
from tests.contract_utils import schema_errors
from tests.factories import full_provenance
from tests.test_chat_stream import check_protocol

pytestmark = pytest.mark.db

SITE = "Fictional Chat Ridge"
DOC = "doc_01JFAKECHAT000000000000001"
DOC_BUSY = "doc_01JFAKECHAT000000000000002"
REGION = [7.0, 47.0, 9.0, 49.0]  # contains the located fictional boreholes (UTM 32N near 48° N, 7.8° E)
FAR_AWAY = [150.0, -34.0, 151.0, -33.0]
SOURCE_TEXT = "Groundwater was observed at 3.5 m during drilling of the fictional hole."


@dataclass(frozen=True)
class _Hole:
    label: str
    x: float | None
    y: float | None
    depth: float
    layers: list[dict[str, Any]]
    approved: bool
    water: float | None = None


HOLES = (
    _Hole(
        "CR-1",
        413000.0,
        5316000.0,
        12.0,
        [
            {"depth_from_m": 0.0, "depth_to_m": 4.0, "din4023_code": "S", "spt_n_value": 10},
            {"depth_from_m": 4.0, "depth_to_m": 12.0, "din4023_code": "T", "spt_n_value": 20},
        ],
        approved=True,
        water=3.5,
    ),
    _Hole(
        "CR-2",
        413500.0,
        5316500.0,
        30.0,
        [
            {"depth_from_m": 0.0, "depth_to_m": 10.0, "din4023_code": "G", "spt_n_value": 30},
            {"depth_from_m": 10.0, "depth_to_m": 30.0, "din4023_code": "U"},
        ],
        approved=True,
    ),
    _Hole(
        "CR-3",
        414000.0,
        5317000.0,
        25.0,
        [{"depth_from_m": 0.0, "depth_to_m": 25.0, "din4023_code": "U"}],
        approved=False,
    ),
    _Hole(
        "CR-4",
        None,
        None,
        8.0,
        [{"depth_from_m": 0.0, "depth_to_m": 8.0, "din4023_code": "S"}],
        approved=True,
    ),
)


def _document(doc_id: str, *, status: str, sha: str) -> Document:
    return Document(
        id=doc_id,
        file_name=f"fictional-{doc_id[-4:].lower()}.pdf",
        project=SITE,
        sha256=sha * 64,
        mime_type="application/pdf",
        size_bytes=10,
        storage_key="originals/" + sha * 64 + ".pdf",
        status=status,
        page_count=3,
    )


async def seed_fictional_site() -> dict[str, str]:
    """Four fictional boreholes (three approved, one unreviewed; one without coordinates), one OCR page
    with fictional text and one document still processing. Returns label -> uid."""
    uids: dict[str, str] = {}
    async with get_sessionmaker()() as session:
        doc = _document(DOC, status="needs_review", sha="c")
        session.add_all([doc, _document(DOC_BUSY, status="extracting", sha="d")])
        await session.flush()
        for page, hole in enumerate(HOLES, start=1):
            coords: dict[str, Any] = {}
            if hole.x is not None and hole.y is not None:
                coords = {"local_x": hole.x, "local_y": hole.y, "x_raw": str(hole.x), "y_raw": str(hole.y)}
            body: dict[str, Any] = {
                "metadata": {
                    "borehole_id": hole.label,
                    "borehole_depth_m": hole.depth,
                    "project_name": SITE,
                    "location_name": "Sampleton Heath",
                    "coordinates": coords,
                },
                "stratigraphy": hole.layers,
            }
            if hole.water is not None:
                body["groundwater"] = [{"type": "strike", "depth_m": hole.water}]
            overrides: dict[str, ProvenanceIn] = {}
            if hole.x is None:  # a value read from a spreadsheet cell: no page, so no citation
                overrides["metadata__borehole_depth_m"] = ProvenanceIn(
                    page=None, box=None, cell="Logs!B4", raw="8,00", method="read", confidence=None
                )
            bh = await create_borehole(
                session,
                document=doc,
                group_key=hole.label,
                body=body,
                provenance=full_provenance(body, page=page, **overrides),
                crs_status="stated" if hole.x is not None else "unknown",
                crs_code="EPSG:25832" if hole.x is not None else None,
                pages=[page],
            )
            if hole.approved:
                fvs = await load_field_values(session, bh.uid)
                for fv in fvs.values():
                    fv.status = "approved"
                await commit_change(
                    session, bh, fvs, actor="fictional reviewer", action="approve", changes={}
                )
            uids[hole.label] = bh.uid
        session.add(
            OcrRun(
                id="ocr_01JFAKECHAT000000000000",
                document_id=DOC,
                provider="fake",
                model="fictional-ocr",
                params_hash="e" * 64,
                pages=[1],
                status="done",
            )
        )
        await session.flush()
        session.add(
            OcrPage(
                document_id=DOC,
                n=1,
                ocr_run_id="ocr_01JFAKECHAT000000000000",
                markdown=f"# Fictional log\n\n{SOURCE_TEXT}",
                blocks=[
                    {"id": "p1.b0", "type": "title", "text": "Fictional log", "box": [0.1, 0.05, 0.3, 0.03]},
                    {"id": "p1.b1", "type": "text", "text": SOURCE_TEXT, "box": [0.1, 0.4, 0.6, 0.05]},
                ],
            )
        )
        await session.commit()
    return uids


@dataclass
class Run:
    chunks: list[dict[str, Any]]
    model_output: dict[str, Any]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [c for c in self.chunks if c["type"] == kind]

    @property
    def output(self) -> dict[str, Any]:
        outputs = self.of("tool-output-available")
        assert len(outputs) == 1, self.chunks
        result: dict[str, Any] = outputs[0]["output"]
        return result

    @property
    def commands(self) -> list[dict[str, Any]]:
        return [c["data"] for c in self.of("data-ui-command")]


async def run_tool(
    state: TurnState, name: str, arguments: dict[str, Any] | str, call_id: str = "call_1"
) -> Run:
    chunks: list[dict[str, Any]] = []
    out = MessageWriter(chunks.append, "msg_fictional")
    out.begin_step()
    chunks.clear()  # keep only what the call adds inside the step
    raw = arguments if isinstance(arguments, str) else json.dumps(arguments)
    model_output = await execute_call(FunctionCall(call_id, name, raw), state, out)
    check_protocol(chunks, complete=False)
    return Run(list(chunks), model_output)


def search_args(**values: Any) -> dict[str, Any]:
    """Strict-mode arguments: every field present, as the model must send them."""
    args: dict[str, Any] = {
        "search": None,
        "country": None,
        "project": None,
        "document_id": None,
        "min_depth_m": None,
        "max_depth_m": None,
        "din4023_codes": [],
        "lithology_min_depth_m": None,
        "has_spt": None,
        "has_groundwater": None,
        "review_status": [],
        "include_unreviewed": False,
        "area": None,
    }
    args.update(values)
    return args


def bbox_area(bbox: list[float]) -> dict[str, Any]:
    return {"type": "bbox", "bbox": bbox}


def state_for(include_unreviewed: bool = False) -> TurnState:
    return TurnState(context=ChatContext(include_unreviewed=include_unreviewed))


# ------------------------------------------------------------------------------------------------


async def test_resolve_place_lists_uploaded_places(db: None) -> None:
    await seed_fictional_site()
    run = await run_tool(state_for(), "resolve_place", {"query": "Chat Ridge"})
    candidates = run.output["candidates"]
    assert candidates, run.output
    for candidate in candidates:
        assert not schema_errors(candidate, "PlaceCandidate")
    site = next(c for c in candidates if c["kind"] == "project_site")
    assert site["source"] == "uploaded" and site["borehole_count"] == 3  # only plotted boreholes
    assert run.of("tool-input-available")[0]["input"] == {"query": "Chat Ridge"}
    assert run.model_output == run.output


async def test_search_defaults_to_accepted_data_and_counts_the_rest(db: None) -> None:
    uids = await seed_fictional_site()
    # The model asks for unreviewed data, but the interface has it switched off.
    run = await run_tool(state_for(False), "search_boreholes", search_args(include_unreviewed=True))
    shown = run.of("tool-input-available")[0]["input"]
    assert shown == {"include_unreviewed": False}
    out = run.output
    assert (out["count"], out["located_count"], out["unlocated_count"], out["excluded_unreviewed"]) == (
        3,
        2,
        1,
        1,
    )
    assert {p["uid"] for p in out["preview"]} == {uids["CR-1"], uids["CR-2"], uids["CR-4"]}
    assert [p["borehole_id"] for p in out["preview"]] == ["CR-1", "CR-2", "CR-4"]
    assert run.model_output["include_unreviewed"] is False and "scope_note" in run.model_output
    part = run.of("data-result-set")[0]
    assert part["id"] == out["result_set_id"] and part["data"]["count"] == 3 and "area" not in part["data"]
    assert run.commands == [
        {"command": "show_result_set", "args": {"result_set_id": out["result_set_id"]}},
        {"command": "fit_result_set", "args": {"result_set_id": out["result_set_id"]}},
    ]
    async with get_sessionmaker()() as session:
        stored = await session.get(ResultSet, out["result_set_id"])
        assert stored is not None and sorted(stored.uids) == sorted(p["uid"] for p in out["preview"])


async def test_search_includes_unreviewed_only_when_the_context_allows(db: None) -> None:
    await seed_fictional_site()
    args = search_args(min_depth_m=20, include_unreviewed=True, area=bbox_area(REGION))
    allowed = await run_tool(state_for(True), "search_boreholes", args)
    assert allowed.output["count"] == 2 and allowed.output["excluded_unreviewed"] == 0
    assert allowed.of("tool-input-available")[0]["input"] == {
        "min_depth_m": 20.0,
        "include_unreviewed": True,
        "area": {"type": "bbox", "bbox": REGION},
    }
    blocked = await run_tool(state_for(False), "search_boreholes", args)
    assert blocked.output["count"] == 1 and blocked.output["excluded_unreviewed"] == 1
    assert [p["borehole_id"] for p in blocked.output["preview"]] == ["CR-2"]


async def test_zero_results_in_an_area_outline_the_area(db: None) -> None:
    await seed_fictional_site()
    run = await run_tool(state_for(True), "search_boreholes", search_args(area=bbox_area(FAR_AWAY)))
    out = run.output
    assert out["count"] == 0 and out["bbox"] == FAR_AWAY and out["preview"] == []
    part = run.of("data-result-set")[0]["data"]
    assert part["area"] == {"type": "bbox", "bbox": FAR_AWAY} and part["bbox"] == FAR_AWAY
    assert run.commands == [{"command": "fit_bounds", "args": {"bbox": FAR_AWAY, "outline": True}}]


async def test_search_rejects_invalid_filters_without_touching_the_ui(db: None) -> None:
    await seed_fictional_site()
    for args in (
        search_args(area=bbox_area([200.0, 0.0, 201.0, 1.0])),  # outside WGS84
        search_args(din4023_codes=["sand"]),  # not a DIN 4023 key
        {"area": None},  # strict mode: every field must be present
        "SELECT * FROM boreholes",  # not even JSON
    ):
        run = await run_tool(state_for(), "search_boreholes", args)
        assert run.chunks == [], args
        assert run.model_output["error"]["code"] == "invalid_arguments"


async def test_summarize_in_sql(db: None) -> None:
    await seed_fictional_site()
    state = state_for(True)
    search = await run_tool(state, "search_boreholes", search_args(include_unreviewed=True))
    rs_id = search.output["result_set_id"]
    assert search.output["count"] == 4

    async def summary(metric: str, field: str) -> dict[str, Any]:
        args = {"result_set_id": rs_id, "metric": metric, "field": field}
        return (await run_tool(state, "summarize_boreholes", args)).output

    assert (await summary("count", "borehole_depth_m"))["value"] == 4
    assert (await summary("min", "borehole_depth_m"))["value"] == 8.0
    assert (await summary("max", "borehole_depth_m"))["value"] == 30.0
    mean = await summary("mean", "borehole_depth_m")
    assert mean["value"] == 18.75 and mean["n_with_value"] == 4 and mean["n_total"] == 4
    assert mean["unit"] == "m" and mean["level"] == "borehole"
    histogram = await summary("histogram", "borehole_depth_m")
    bins = histogram["bins"]
    assert len(bins) == 10 and sum(b["count"] for b in bins) == 4
    assert bins[0]["from"] == 8.0 and bins[-1]["to"] == 30.0 and bins[-1]["count"] == 1
    spt = await summary("mean", "spt_n_value")
    assert (spt["value"], spt["n_with_value"], spt["n_boreholes_with_value"]) == (20.0, 3, 2)
    assert (await summary("max", "spt_n_value"))["value"] == 30
    water = await summary("count", "groundwater_depth_m")
    assert water["value"] == 1 and water["level"] == "groundwater_reading"
    thickness = await summary("max", "layer_thickness_m")
    assert thickness["value"] == 25.0
    assert (await summary("mean", "rqd_pct"))["value"] is None

    not_whitelisted = await run_tool(
        state, "summarize_boreholes", {"result_set_id": rs_id, "metric": "max", "field": "label_raw"}
    )
    assert (
        not_whitelisted.chunks == [] and not_whitelisted.model_output["error"]["code"] == "invalid_arguments"
    )
    missing = await run_tool(
        state, "summarize_boreholes", {"result_set_id": "rs_missing", "metric": "count", "field": "rqd_pct"}
    )
    assert missing.output == {"error": {"code": "result_set_not_found", "message": "Result set not found."}}


async def test_get_borehole_is_trimmed(db: None) -> None:
    uids = await seed_fictional_site()
    run = await run_tool(state_for(), "get_borehole", {"uid": uids["CR-1"]})
    out = run.output
    assert "provenance" not in json.dumps(out)
    assert out["borehole_id"] == "CR-1" and out["review_status"] == "approved" and out["plotted"] is True
    assert [layer["index"] for layer in out["layers"]] == [0, 1] and out["layer_count"] == 2
    assert out["layers"][1]["din4023_code"] == "T" and out["groundwater"][0]["depth_m"] == 3.5
    assert isinstance(out["lint_count"], int) and out["metadata"]["borehole_depth_m"] == 12.0
    assert out["source_file"].startswith("fictional-")
    missing = await run_tool(state_for(), "get_borehole", {"uid": "bh_missing"})
    assert missing.output["error"]["code"] == "borehole_not_found"


async def test_get_evidence_becomes_numbered_citations(db: None) -> None:
    uids = await seed_fictional_site()
    state = state_for()
    first = await run_tool(state, "get_evidence", {"uid": uids["CR-1"], "path": "metadata.borehole_depth_m"})
    assert set(first.output) == {"document_id", "page", "box", "raw", "method"}
    assert first.output["document_id"] == DOC and first.output["page"] == 1 and first.output["raw"] == "12.0"
    citation = first.of("data-citation")[0]
    assert citation["id"] == "cit_1" and citation["data"]["citation_id"] == "cit_1"
    assert citation["data"]["uid"] == uids["CR-1"] and citation["data"]["path"] == "metadata.borehole_depth_m"
    assert first.model_output["citation"] == "[1]"
    second = await run_tool(
        state, "get_evidence", {"uid": uids["CR-2"], "path": "stratigraphy[0].din4023_code"}, "call_2"
    )
    assert second.of("data-citation")[0]["id"] == "cit_2" and second.model_output["citation"] == "[2]"
    cell = await run_tool(state, "get_evidence", {"uid": uids["CR-4"], "path": "metadata.borehole_depth_m"})
    assert cell.output["page"] is None and cell.of("data-citation") == []
    assert cell.model_output["citation"] is None and cell.model_output["cell"] == "Logs!B4"
    bad_path = await run_tool(state, "get_evidence", {"uid": uids["CR-1"], "path": "metadata; DROP TABLE"})
    assert bad_path.chunks == [] and bad_path.model_output["error"]["code"] == "invalid_arguments"
    absent = await run_tool(state, "get_evidence", {"uid": uids["CR-1"], "path": "metadata.client"})
    assert absent.output["error"]["code"] == "path_not_found"


async def test_search_sources_returns_cited_passages(db: None) -> None:
    await seed_fictional_site()
    state = state_for()
    run = await run_tool(
        state, "search_sources", {"query": "groundwater observed", "document_id": None, "k": 3}
    )
    passages = run.output["passages"]
    assert passages == [{"document_id": DOC, "page": 1, "box": [0.1, 0.4, 0.6, 0.05], "snippet": SOURCE_TEXT}]
    assert run.of("data-citation")[0]["data"]["citation_id"] == "cit_1"
    assert run.model_output["passages"][0]["citation"] == "[1]"
    nothing = await run_tool(state, "search_sources", {"query": "zzz-nowhere", "document_id": DOC, "k": 8})
    assert nothing.output == {"passages": []} and nothing.of("data-citation") == []


async def test_propose_correction_never_writes(db: None) -> None:
    uids = await seed_fictional_site()
    uid = uids["CR-1"]
    async with get_sessionmaker()() as session:
        before = await session.get(Borehole, uid)
        assert before is not None
        revision, record = before.revision, before.record
    args = {
        "uid": uid,
        "path": "metadata.borehole_depth_m",
        "proposed_value": "13.5",
        "reason": "Fictional typo",
    }
    run = await run_tool(state_for(), "propose_correction", args)
    assert run.output["changed"] is False and run.output["current_value"] == 12.0
    assert run.commands == [
        {"command": "open_review", "args": {"uid": uid, "path": "metadata.borehole_depth_m"}}
    ]
    async with get_sessionmaker()() as session:
        after = await session.get(Borehole, uid)
        fv = await session.scalar(
            select(FieldValue).where(FieldValue.uid == uid, FieldValue.path == "metadata.borehole_depth_m")
        )
        assert after is not None and fv is not None
        assert (after.revision, after.record, fv.value, fv.status) == (revision, record, 12.0, "approved")


async def test_prepare_export_follows_the_review_scope(db: None) -> None:
    await seed_fictional_site()
    args = {"document_id": DOC, "format": "xlsx", "include_unreviewed": True}
    blocked = await run_tool(state_for(False), "prepare_export", args)
    assert blocked.commands == [
        {
            "command": "export_document",
            "args": {"document_id": DOC, "format": "xlsx", "include_unreviewed": False},
        }
    ]
    allowed = await run_tool(state_for(True), "prepare_export", args)
    assert allowed.commands[0]["args"]["include_unreviewed"] is True
    missing = await run_tool(state_for(), "prepare_export", {**args, "document_id": "doc_missing"})
    assert missing.output["error"]["code"] == "document_not_found" and missing.commands == []


async def test_scope_comes_from_sql(db: None) -> None:
    await seed_fictional_site()
    state = state_for(False)
    await run_tool(state, "search_boreholes", search_args())
    async with get_sessionmaker()() as session:
        scoped = await compute_scope(session, state)
        unscoped = await compute_scope(session, state_for(True))
        accepted_only = await compute_scope(session, state_for(False))
    assert scoped == {
        "included": "accepted data only",
        "excluded_unreviewed": 1,
        "unlocated_in_scope": 1,
        "documents_processing": 1,
    }
    assert unscoped == {
        "included": "accepted and unreviewed data",
        "excluded_unreviewed": 0,
        "unlocated_in_scope": 1,
        "documents_processing": 1,
    }
    assert accepted_only["excluded_unreviewed"] == 1 and accepted_only["unlocated_in_scope"] == 1


# ------------------------------------------------------------------------------------------------
# The model can only reach registered tools and allowlisted commands
# ------------------------------------------------------------------------------------------------


def test_registry_matches_the_contract_tools_and_commands() -> None:
    assert set(registry.REGISTRY) == _tool_names()
    contract_commands = _ui_commands()
    assert set(UI_COMMANDS) == set(contract_commands)
    for command, model in UI_COMMANDS.items():
        required, known = contract_commands[command]
        assert set(model.model_fields) == known, command
        assert {n for n, f in model.model_fields.items() if f.is_required()} == required, command


def _strict_problems(node: Any, where: str = "$") -> list[str]:
    problems: list[str] = []
    if isinstance(node, dict):
        if node.get("type") == "object" or "properties" in node:
            if node.get("additionalProperties") is not False:
                problems.append(f"{where}: object not closed")
            if sorted(node.get("required", [])) != sorted(node.get("properties", {})):
                problems.append(f"{where}: not every property is required")
        for key in ("$ref", "$defs", "oneOf", "const", "minLength", "maxLength", "discriminator", "default"):
            if key in node:
                problems.append(f"{where}: unsupported keyword {key}")
        for key, value in node.items():
            if key == "properties":
                for name, sub in value.items():
                    problems += _strict_problems(sub, f"{where}.{name}")
            else:
                problems += _strict_problems(value, f"{where}/{key}")
    elif isinstance(node, list):
        for i, item in enumerate(node):
            problems += _strict_problems(item, f"{where}[{i}]")
    return problems


def test_function_tools_are_strict() -> None:
    tools = registry.function_tools()
    assert [t["name"] for t in tools] == [t.name for t in registry.TOOLS]
    for tool in tools:
        assert tool["type"] == "function" and tool["strict"] is True and tool["description"]
        assert tool["parameters"]["type"] == "object"
        assert not _strict_problems(tool["parameters"]), (tool["name"], _strict_problems(tool["parameters"]))
    assert "format" in registry.REGISTRY["prepare_export"].schema()["properties"]


async def test_unregistered_tools_never_run(db: None) -> None:
    await seed_fictional_site()
    for name in ("run_sql", "delete_document", "set_filters", "SEARCH_BOREHOLES", ""):
        run = await run_tool(state_for(), name, {"query": "DROP TABLE boreholes"})
        assert run.chunks == [] and run.model_output["error"]["code"] == "unknown_tool", name
    assert registry.get_tool("run_sql") is None
