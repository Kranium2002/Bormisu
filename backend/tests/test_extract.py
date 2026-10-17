"""Grouping and structured extraction on a FICTIONAL document (hand-written OCR rows and model answers).

No real provider is called: OpenRouter is mocked with respx, or a fake extractor is injected.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
from typing import Any

import httpx
import pytest
import respx
from PIL import Image
from sqlalchemy import func, select, update

from app.config import get_settings
from app.db.models import Document, ExtractionRun, OcrPage, OcrRun, Page
from app.db.session import get_sessionmaker
from app.pipeline import classify as classify_module
from app.pipeline import extract as extract_module
from app.pipeline.extract import (
    IMAGE_TOKENS,
    NothingToExtractError,
    build_input,
    extract_group,
)
from app.pipeline.group import plan_groups
from app.pipeline.orchestrator import run_pipeline
from app.pipeline.schemas import ExtractedHeader, ExtractionResult, PageLabel
from app.pipeline.types import ExtractionInput, PageGroup
from app.providers import ocr_mistral
from app.providers.base import ProviderError
from app.providers.fakes import FakeClassifier, FakeOcrEngine, label
from app.storage import get_storage, original_key, page_render_key
from tests.pdf_factory import TextItem, make_pdf

pytestmark = pytest.mark.db


@pytest.fixture(autouse=True)
def stages_until_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests stop after OCR; extraction has its own tests."""
    from app.pipeline import orchestrator

    monkeypatch.setattr(orchestrator, "STAGES", ("triage", "classify", "ocr"))


DOC = "doc_01JFAKE0000000000000EXTR1"
OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"
TABLE = "<table><tr><th>Hole</th><th>East</th></tr><tr><td>FX-11</td><td>512 300,5</td></tr></table>"


@pytest.fixture
def keys(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test-not-real")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(out, format="PNG")
    return out.getvalue()


def _block(n: int, i: int, text: str, conf: float | None = 0.97, kind: str = "text") -> dict[str, Any]:
    return {
        "id": f"p{n}.b{i}",
        "type": kind,
        "text": text,
        "box": [0.1, 0.05 + 0.05 * i, 0.5, 0.03],
        "confidence": conf,
        "min_confidence": conf,
    }


# Page n -> (role, labels, handwriting, render size, OCR blocks, tables, markdown)
PAGES: dict[int, dict[str, Any]] = {
    1: {
        "role": "summary_table",
        "labels": ["FX-11", "FX-12"],
        "blocks": [
            _block(1, 0, "SUMMARY OF FICTIONAL HOLES"),
            _block(1, 1, "[tbl-0.html](tbl-0.html)", None, "table"),
        ],
        "tables": [TABLE],
        "markdown": "SUMMARY OF FICTIONAL HOLES\n\n[tbl-0.html](tbl-0.html)",
    },
    2: {
        "role": "log_sheet",
        "labels": ["FX-11"],
        "sheet": (1, 3),
        "blocks": [
            _block(2, 0, "FICTIONAL BOREHOLE FX-11"),
            _block(2, 1, "Depth (m)"),
            _block(2, 2, "<table>...</table>", None, "table"),  # names a table without its cells
            _block(2, 3, "0,00 - 1,20 Sand, schluffig"),
            _block(2, 4, "1,20 - 3,40 Kies, sandig"),
        ],
        "tables": ["<table><tr><td>SPT 1,50</td><td>4/6/7</td></tr></table>"],
        "markdown": "FICTIONAL BOREHOLE FX-11",
    },
    3: {
        "role": "log_continuation",
        "labels": [],
        "sheet": (2, 3),
        "handwriting": "partial",
        "render": (2000, 1000),
        "blocks": [_block(3, 0, "1,20 - 3,40 Kies, sandig"), _block(3, 1, "3,40 - 6,00 Ton, steif")],
    },
    4: {
        "role": "log_continuation",
        "labels": ["FX-11"],
        "sheet": (3, 3),
        "render": (800, 1100),
        "blocks": [_block(4, 0, "Endteufe 6,00 m"), _block(4, 1, "GW 2,10 [[p9.b9]]", 0.5)],
    },
    5: {"role": "log_sheet", "labels": ["FX-12"], "blocks": None},  # OCR failed: no row
    6: {"role": "narrative", "labels": [], "used": False, "blocks": None},
}


async def _make_document() -> None:
    storage = get_storage()
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=DOC,
                file_name="fictional-extract.pdf",
                sha256=hashlib.sha256(b"fictional extract document").hexdigest(),
                mime_type="application/pdf",
                size_bytes=1,
                storage_key="originals/fictional.pdf",
                status="extracting",
            )
        )
        session.add(
            OcrRun(
                id="ocr_01JFAKE00000000000000EXTR",
                document_id=DOC,
                provider="mistral",
                model="fake-ocr",
                params_hash="f" * 64,
                pages=[1, 2, 3, 4],
                status="done",
            )
        )
        await session.flush()
        for n, spec in PAGES.items():
            index, total = spec.get("sheet", (None, None))
            render = spec.get("render", (850, 1200))
            key = page_render_key(DOC, n)
            storage.put_bytes(key, _png(*render))
            session.add(
                Page(
                    document_id=DOC,
                    n=n,
                    width_px=render[0],
                    height_px=render[1],
                    render_key=key,
                    text_layer_quality=0.97 if n != 3 else 0.2,
                    role=spec["role"],
                    handwriting=spec.get("handwriting", "none"),
                    borehole_labels=spec["labels"],
                    sheet_index=index,
                    sheet_total=total,
                    used=spec.get("used", True),
                    ocr_status="done" if spec["blocks"] is not None else "failed",
                    classifier={"is_continuation": spec["role"] == "log_continuation"},
                )
            )
            if spec["blocks"] is not None:
                session.add(
                    OcrPage(
                        document_id=DOC,
                        n=n,
                        ocr_run_id="ocr_01JFAKE00000000000000EXTR",
                        markdown=spec.get("markdown", "\n\n".join(b["text"] for b in spec["blocks"])),
                        tables=spec.get("tables", []),
                        blocks=spec["blocks"],
                    )
                )
        await session.commit()


async def _groups() -> dict[str | None, PageGroup]:
    return {g.label_canonical: g for g in await plan_groups(DOC)}


def rv(raw: str | None = None, *ids: str, state: str | None = None) -> dict[str, Any]:
    return {
        "raw": raw,
        "block_ids": list(ids),
        "state": state or ("ok" if raw is not None else "not_in_source"),
    }


def header(**values: dict[str, Any]) -> dict[str, Any]:
    names = [name for name in ExtractedHeader.model_fields if name != "coordinates"]
    out: dict[str, Any] = {name: values.get(name, rv()) for name in names}
    out["coordinates"] = {"x_raw": rv(), "y_raw": rv(), "labels_raw": rv(), "system_raw": rv()}
    return out


def layer(top: str | None, base: str | None, text: str, *ids: str, code: str | None = None) -> dict[str, Any]:
    first = ids[0] if ids else None
    cite = (first,) if first else ()
    return {
        "from_raw": rv(top, *cite),
        "to_raw": rv(base, *cite),
        "description_raw": rv(text, *cite),
        "description_language": "de",
        "english_lithology": "fictional rendering",
        "din4023_code": code,
        "din4023_notation": None,
        "uscs_raw": rv(),
        "colour_raw": rv(),
        "consistency_raw": rv(),
        "moisture_raw": rv(),
        "weathering_raw": rv(),
        "stratigraphic_name_raw": rv(),
    }


def result(**parts: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "header": header(),
        "layers": [],
        "spt": [],
        "core_runs": [],
        "groundwater": [],
        "samples": [],
        "tests": [],
    }
    base.update(parts)
    return base


def completion(content: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "gen-fictional",
        "model": "mistralai/mistral-large-fictional",
        "choices": [
            {"finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(content)}}
        ],
        "usage": {"prompt_tokens": 2100, "completion_tokens": 800, "cost": 0.0061},
    }


async def _runs() -> list[ExtractionRun]:
    async with get_sessionmaker()() as session:
        return list((await session.scalars(select(ExtractionRun).order_by(ExtractionRun.created_at))).all())


# ----------------------------------------------------------------------------------------------


async def test_plan_groups_reads_the_pages_table(db: None) -> None:
    await _make_document()
    groups = await plan_groups(DOC)
    assert [(g.label_canonical, g.pages, g.context_pages) for g in groups] == [
        ("FX11", (2, 3, 4), (1,)),
        ("FX12", (5,), (1,)),
    ]
    assert groups[0].key == "FX11:p2-p4" and groups[0].uncertain == ()


async def test_build_input_text_blocks_and_images(db: None) -> None:
    await _make_document()
    group = (await _groups())["FX11"]
    inp = await build_input(DOC, group)
    lines = inp.text.splitlines()
    assert lines[0] == "Borehole to extract: FX-11"
    assert "LOG PAGES" in lines
    assert lines.index("=== page 2 (log_sheet) ===") < lines.index("=== page 3 (log_continuation) ===")
    assert "[[p2.b0]] FICTIONAL BOREHOLE FX-11" in lines
    assert "[[p2.b3]] 0,00 - 1,20 Sand, schluffig" in lines
    # A table block without cells is replaced by the page's HTML table.
    assert "[[p2.b2]] <table><tr><td>SPT 1,50</td><td>4/6/7</td></tr></table>" in lines
    # Text that imitates a block marker is defused.
    assert "[[p4.b1]] GW 2,10 [ [p9.b9] ]" in lines
    assert inp.blocks["p4.b1"].text == "GW 2,10 [[p9.b9]]"  # the block keeps its text as read
    assert "page 1" not in inp.text and "page 5" not in inp.text
    # Context pages: the same format; the table link is resolved from ocr_pages.tables.
    context = inp.context_text.splitlines()
    assert context[0] == "=== page 1 (summary_table) ==="
    assert f"[[p1.b1]] {TABLE}" in context
    # Block map: group and context blocks, with boxes as tuples and page facts.
    assert set(inp.blocks) == {"p1.b0", "p1.b1", "p2.b0", "p2.b1", "p2.b2", "p2.b3", "p2.b4"} | {
        "p3.b0",
        "p3.b1",
        "p4.b0",
        "p4.b1",
    }
    ref = inp.blocks["p3.b1"]
    assert ref.page == 3 and ref.box == (0.1, 0.1, 0.5, 0.03) and ref.confidence == 0.97
    assert ref.page_handwriting == "partial" and ref.page_text_quality == 0.2
    assert inp.blocks["p2.b2"].text.startswith("<table>")
    # Images only for the handwritten page (3) and the page with a low-confidence block (4).
    assert [n for n, _ in inp.images] == [3, 4]
    with Image.open(io.BytesIO(inp.images[0][1])) as img:
        assert max(img.size) == 1600  # the 2000 px render is shrunk
    with Image.open(io.BytesIO(inp.images[1][1])) as img:
        assert img.size == (800, 1100)
    chars = len(inp.text) + len(inp.context_text)
    assert inp.estimated_tokens == math.ceil(chars / 3.5) + 2 * IMAGE_TOKENS


async def test_openrouter_extraction_is_stored_and_reused(db: None, keys: Any) -> None:
    await _make_document()
    group = (await _groups())["FX11"]
    answer = result(
        header=header(
            borehole_label=rv("FX-11", "p2.b0"),
            total_depth=rv("Endteufe 6,00 m", "p4.b0"),
            depth_unit=rv("(m)", "p2.b1", "p7.b1"),  # p7.b1 is not in the input
            project=rv("", state="ok"),  # blank text is not a value
        ),
        layers=[
            layer("0,00", "1,20", "Sand, schluffig", "p2.b3", code="S"),
            layer("1,20", "3,40", "Kies, sandig", "p2.b4", code="Sandy gravel"),  # not a DIN key
        ],
        groundwater=[{"type": "strike", "depth_raw": rv("2,10", "p4.b1"), "date_raw": rv()}],
        tests=[
            {
                "name": "w",
                "value_raw": rv("21,5", "p1.b1"),
                "unit_raw": rv("%", "p1.b1"),
                "depth_raw": rv(),
                "sample_raw": rv(),
            }
        ],
    )
    with respx.mock(assert_all_called=True) as mock:
        route = mock.post(OPENROUTER).mock(return_value=httpx.Response(200, json=completion(answer)))
        outcome = await extract_group(DOC, group)
        assert route.call_count == 1
        body = json.loads(route.calls[0].request.content)
        again = await extract_group(DOC, group)
        assert route.call_count == 1  # reused, no HTTP

    assert body["model"] == get_settings().extractor_model
    assert body["response_format"]["json_schema"]["name"] == "ExtractionResult"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert 6000 <= body["max_tokens"] <= 16000
    system = body["messages"][0]["content"]
    assert "mG: Medium gravel (soil)" in system and "Mg: " in system  # case-sensitive DIN keys
    assert "Watercontent [%]:" in system and "{{" not in system
    content = body["messages"][1]["content"]
    assert content[0]["type"] == "text" and content[0]["text"].startswith("Borehole to extract: FX-11")
    assert content[1]["text"].startswith("CONTEXT PAGES") and "[[p1.b1]]" in content[1]["text"]
    images = [part for part in content if part["type"] == "image_url"]
    assert len(images) == 2 and images[0]["image_url"]["url"].startswith("data:image/png;base64,")

    res = outcome.result
    assert res.header.borehole_label.raw == "FX-11" and res.header.borehole_label.block_ids == ["p2.b0"]
    assert res.header.depth_unit.block_ids == ["p2.b1"]
    assert res.header.project.raw is None and res.header.project.state == "not_in_source"
    assert [layer.din4023_code for layer in res.layers] == ["S", None]
    assert res.tests[0].name == "Watercontent"
    assert any("p7.b1" in w and "header.depth_unit" in w for w in outcome.warnings)
    assert any("Sandy gravel" in w for w in outcome.warnings)
    assert outcome.model == "mistralai/mistral-large-fictional"
    assert outcome.cost_usd == pytest.approx(0.0061)
    assert set(outcome.blocks) >= {"p1.b1", "p2.b0", "p4.b1"}

    runs = await _runs()
    assert len(runs) == 1
    run = runs[0]
    assert (run.id, run.status, run.group_id) == (outcome.run_id, "done", "FX11:p2-p4")
    assert run.model == "mistralai/mistral-large-fictional" and run.cost_usd == pytest.approx(0.0061)
    assert run.prompt_version == extract_module.PROMPT_VERSION and run.schema_version == "1"
    assert run.output is not None and run.output["layers"][1]["din4023_code"] == "Sandy gravel"  # as answered
    assert run.input_tokens is not None and run.input_tokens > 0
    assert again.run_id == run.id and again.result == outcome.result and again.warnings == outcome.warnings


async def test_changed_ocr_text_is_a_new_extraction(db: None) -> None:
    await _make_document()
    group = (await _groups())["FX11"]
    fake = FakeExtractor()
    await extract_group(DOC, group, extractor=fake)
    await extract_group(DOC, group, extractor=fake)
    assert fake.calls == 1
    async with get_sessionmaker()() as session:
        blocks = [*PAGES[3]["blocks"]]
        blocks[1] = {**blocks[1], "text": "3,40 - 6,50 Ton, steif"}
        await session.execute(
            update(OcrPage).where(OcrPage.document_id == DOC, OcrPage.n == 3).values(blocks=blocks)
        )
        await session.commit()
    await extract_group(DOC, group, extractor=fake)
    assert fake.calls == 2 and len(await _runs()) == 2


async def test_provider_failure_is_stored_and_raised(db: None, keys: Any) -> None:
    await _make_document()
    group = (await _groups())["FX11"]
    with respx.mock() as mock:
        mock.post(OPENROUTER).mock(return_value=httpx.Response(400, json={"error": "fictional"}))
        with pytest.raises(ProviderError):
            await extract_group(DOC, group)
    runs = await _runs()
    assert [(r.status, r.error) for r in runs] == [("failed", "OpenRouter refused the request (400).")]
    # A retry calls again and reuses the same run row.
    fake = FakeExtractor()
    outcome = await extract_group(DOC, group, extractor=fake)
    runs = await _runs()
    assert fake.calls == 1 and [(r.id, r.status, r.error) for r in runs] == [(outcome.run_id, "done", None)]


async def test_group_without_ocr_text_sends_the_page_image(db: None) -> None:
    """A page OCR could not read goes to the model as an image with one whole-page block to cite."""
    await _make_document()
    group = (await _groups())["FX12"]
    fake = FakeExtractor()
    await extract_group(DOC, group, extractor=fake)
    sent = fake.inputs[0]
    assert set(group.pages) <= {n for n, _ in sent.images}
    whole_page = [b for b in sent.blocks.values() if b.box == (0.0, 0.0, 1.0, 1.0)]
    assert whole_page and all(f"[[{b.id}]]" in sent.text for b in whole_page)


async def test_group_without_text_or_image_is_not_sent(db: None, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.pipeline.extract as extract_module

    await _make_document()
    group = (await _groups())["FX12"]
    monkeypatch.setattr(extract_module, "_render", lambda _key: None)  # no render either
    fake = FakeExtractor()
    with pytest.raises(NothingToExtractError):
        await extract_group(DOC, group, extractor=fake)
    assert fake.calls == 0 and await _runs() == []


class FakeExtractor:
    """Answers per page set: what each fictional page 'prints', citing that page's block ids."""

    def __init__(self) -> None:
        self.calls = 0
        self.inputs: list[ExtractionInput] = []

    async def extract(
        self, inp: ExtractionInput, *, document_id: str
    ) -> tuple[ExtractionResult, str | None, float]:
        self.calls += 1
        self.inputs.append(inp)
        answer = result()
        if "=== page 2 " in inp.text:
            answer["header"]["borehole_label"] = rv("FX-11", "p2.b0")
            answer["layers"] += [
                layer("0,00", "1,20", "Sand, schluffig", "p2.b3"),
                layer("1,20", "3,40", "Kies, sandig", "p2.b4"),
            ]
        if "=== page 3 " in inp.text:
            # Printed again at the top of sheet 2 (exact duplicate), and listed after the next stratum.
            answer["layers"] += [
                layer("3,40", "6,00", "Ton, steif", "p3.b1"),
                layer("1,20", "3,40", "Kies, sandig", "p3.b0"),
            ]
        if "=== page 4 " in inp.text:
            answer["header"]["total_depth"] = rv("Endteufe 6,00 m", "p4.b0")
            answer["header"]["borehole_label"] = rv("FX-11", "p4.b9")  # first part's label wins
            answer["groundwater"] = [{"type": "strike", "depth_raw": rv("2,10", "p4.b1"), "date_raw": rv()}]
        # The context page is in every part: its row comes back each time.
        answer["samples"] = [
            {"name_raw": rv("FX-11", "p1.b1"), "type_raw": rv(), "from_raw": rv(), "to_raw": rv()}
        ]
        return ExtractionResult.model_validate(answer), "fake-extractor", 0.01


async def test_large_input_is_split_by_page_and_merged(db: None, monkeypatch: pytest.MonkeyPatch) -> None:
    await _make_document()
    group = (await _groups())["FX11"]
    whole = await build_input(DOC, group)
    loaded = await extract_module._load(DOC, group)
    # Room for the context and the largest single page only: every page becomes its own part.
    fixed = extract_module.assemble(group, [], loaded.context, part=(1, 1)).estimated_tokens
    largest = max(seg.tokens for seg in loaded.segments)
    assert sorted(seg.tokens for seg in loaded.segments)[:2] != [0, 0]
    assert whole.estimated_tokens > fixed + largest
    monkeypatch.setenv("EXTRACT_MAX_INPUT_TOKENS", str(fixed + largest))
    get_settings.cache_clear()
    try:
        fake = FakeExtractor()
        outcome = await extract_group(DOC, group, extractor=fake)
        assert fake.calls == 3
        assert [inp.text.splitlines()[0] for inp in fake.inputs] == [
            f"Borehole to extract: FX-11 (part {i} of 3 of this borehole's pages; report what these pages "
            "print, including the header values they show)"
            for i in (1, 2, 3)
        ]
        assert all(inp.context_text == whole.context_text for inp in fake.inputs)
        assert [[n for n, _ in inp.images] for inp in fake.inputs] == [[], [3], [4]]

        res = outcome.result
        assert [(lay.from_raw.raw, lay.to_raw.raw) for lay in res.layers] == [
            ("0,00", "1,20"),
            ("1,20", "3,40"),
            ("3,40", "6,00"),
        ]
        assert res.layers[1].description_raw.block_ids == ["p2.b4", "p3.b0"]  # duplicate dropped, ids kept
        assert res.header.borehole_label.raw == "FX-11" and res.header.borehole_label.block_ids == ["p2.b0"]
        assert res.header.total_depth.raw == "Endteufe 6,00 m"  # filled from the last part
        assert len(res.groundwater) == 1 and len(res.samples) == 1
        assert "input split into 3 parts by page" in outcome.warnings
        assert outcome.cost_usd == pytest.approx(0.03) and outcome.model == "fake-extractor"

        runs = await _runs()
        assert sorted(r.group_id for r in runs) == [
            "FX11:p2-p4",
            "FX11:p2-p4#1/3",
            "FX11:p2-p4#2/3",
            "FX11:p2-p4#3/3",
        ]
        assert all(r.status == "done" for r in runs)
        merged = next(r for r in runs if r.group_id == "FX11:p2-p4")
        assert merged.id == outcome.run_id and merged.cost_usd == pytest.approx(0.03)

        again = await extract_group(DOC, group, extractor=fake)
        assert fake.calls == 3 and again.result == outcome.result and again.warnings == outcome.warnings
    finally:
        get_settings.cache_clear()


# ----------------------------------------------------------------------------------------------
# Triage -> classify -> OCR with the fakes, then grouping and the extraction input
# ----------------------------------------------------------------------------------------------


def _fictional_pdf() -> bytes:
    return make_pdf(
        [
            [TextItem(60, 780, "FICTIONAL HOLE LIST", 14), TextItem(60, 740, "QX-1  QX-2")],
            [TextItem(60, 780, "LOG QX-1 SHEET 1 OF 2", 14), TextItem(60, 700, "0,00 - 2,00 Lehm")],
            [TextItem(60, 780, "SHEET 2 OF 2", 14), TextItem(60, 700, "2,00 - 4,50 Mergel")],
            [TextItem(60, 780, "LOG QX-2", 14), TextItem(60, 700, "0,00 - 1,00 Torf")],
        ]
    )


def _rule(text: str) -> PageLabel:
    if "HOLE LIST" in text:
        return label("summary_table", borehole_labels=["QX-1", "QX-2"])
    if "LOG QX-1" in text:
        return label("log_sheet", borehole_labels=["QX-1"], sheet_label="SHEET 1 OF 2", sheet_index=1)
    if "SHEET 2 OF 2" in text:
        return label("log_continuation", sheet_label="SHEET 2 OF 2", is_continuation=True)
    return label("log_sheet", borehole_labels=["QX-2"])


async def test_pipeline_pages_to_groups_and_input(db: None, monkeypatch: pytest.MonkeyPatch) -> None:
    classifier = FakeClassifier(_rule)
    engine = FakeOcrEngine(confidence={"Mergel": 0.5})
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: classifier)
    monkeypatch.setattr(ocr_mistral, "MistralOcrClient", lambda: engine)
    data = _fictional_pdf()
    digest = hashlib.sha256(data).hexdigest()
    get_storage().put_bytes(original_key(digest, ".pdf"), data)
    doc_id = "doc_01JFAKE0000000000000EXTR2"
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=doc_id,
                file_name="fictional.pdf",
                sha256=digest,
                mime_type="application/pdf",
                size_bytes=len(data),
                storage_key=original_key(digest, ".pdf"),
                status="queued",
            )
        )
        await session.commit()
    await run_pipeline(doc_id)

    groups = await plan_groups(doc_id)
    assert [(g.key, g.pages, g.context_pages, g.uncertain) for g in groups] == [
        ("QX1:p2-p3", (2, 3), (1,), ()),
        ("QX2:p4", (4,), (1,), ()),
    ]
    inp = await build_input(doc_id, groups[0])
    lines = inp.text.splitlines()
    assert "[[p2.b0]] LOG QX-1 SHEET 1 OF 2" in lines and "[[p3.b1]] 2,00 - 4,50 Mergel" in lines
    assert inp.context_text.splitlines()[:2] == [
        "=== page 1 (summary_table) ===",
        "[[p1.b0]] FICTIONAL HOLE LIST",
    ]
    assert [n for n, _ in inp.images] == [3]  # the low-confidence block is on page 3
    box = inp.blocks["p2.b0"].box
    assert box is not None and 0.05 < box[0] < 0.15
    async with get_sessionmaker()() as session:
        assert (await session.scalar(select(func.count()).select_from(ExtractionRun))) == 0


def test_page_without_blocks_cites_paragraphs_of_its_markdown() -> None:
    seg = extract_module.page_segment(
        7,
        role="log_sheet",
        blocks=[],
        tables=[TABLE],
        markdown="FICTIONAL LOG ZZ-3\n\n[tbl-0.html](tbl-0.html)\n\n \n\n0,00 - 0,40 Mutterboden",
        text_quality=None,
        handwriting=None,
    )
    assert seg.text.splitlines() == [
        "=== page 7 (log_sheet) ===",
        "[[p7.b0]] FICTIONAL LOG ZZ-3",
        f"[[p7.b1]] {TABLE}",
        "[[p7.b2]] 0,00 - 0,40 Mutterboden",
    ]
    assert all(b.box is None and b.confidence is None for b in seg.blocks)
    empty = extract_module.page_segment(
        8, role=None, blocks=None, tables=None, markdown=None, text_quality=None, handwriting=None
    )
    assert empty.text.splitlines() == ["=== page 8 ===", "(no OCR text for this page)"] and empty.blocks == ()
