"""bh3 as the extraction stage (app.pipeline.bh3_adapter) with a FAKE bridge: no model is called, every
value is FICTIONAL. The fake stands in for app.bh3.bridge (make_vlm, read_pages, build, BudgetExceeded)."""

from __future__ import annotations

import math
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.bh3 import bridge as real_bridge
from app.config import get_settings
from app.db.models import ProviderCall
from app.db.session import get_sessionmaker
from app.pipeline import bh3_adapter
from app.pipeline import classify as classify_module
from app.pipeline import extract as extract_module
from app.providers import ocr_mistral
from app.providers.fakes import FakeClassifier, FakeExtractor, FakeOcrEngine
from tests.test_pipeline_e2e import (
    PROJECT,
    Fakes,
    call,
    classify_rule,
    document,
    fictional_report,
    records,
    upload,
    work,
)

pytestmark = pytest.mark.db


class FakeBudgetExceeded(RuntimeError):
    pass


def prov(page: int, y0: float = 0.0, y1: float = 0.0, *, x0: float = 0.0, x1: float = 0.0) -> Any:
    return SimpleNamespace(
        file="fictional-report.pdf", page=page, x0=x0, y0=y0, x1=x1, y1=y1, method="vlm", confidence=0.9
    )


def layer(top: float, bottom: float, description: str, page: int, y0: float, din: str | None = None) -> Any:
    return SimpleNamespace(
        top=top,
        bottom=bottom,
        description=description,
        prov=prov(page, y0, y0 + 20),
        lithology=None,
        soil_unit=None,
        color=None,
        consistency=None,
        moisture=None,
        stratigraphic_name=None,
        geologic_age=None,
        din_code=din,
    )


def point(
    kind: str, depth: float, value: Any, page: int, *, label: str | None = None, to: float | None = None
) -> Any:
    return SimpleNamespace(
        kind=kind, depth=depth, value=value, prov=prov(page, 400, 412), depth_to=to, label=label
    )


def fx1() -> Any:
    """Printed degrees without labels or system, an open stratum, SPT, groundwater and a sample."""
    return SimpleNamespace(
        borehole_id="doc:FX-1",
        metadata={
            "BoreholeName": "FX-1",
            "ProjectName": PROJECT,
            "X-Coordinate": -32.929816,
            "Y-Coordinate": 27.437978,
            "BoreholeDepth": 6.0,
            "_raw": {"X-Coordinate": "-32.929816", "Y-Coordinate": "27.437978"},
            "_extra": {"Contractor": "Fictional Drilling Ltd"},
        },
        meta_prov={"BoreholeName": prov(2, 60, 76, x0=60, x1=260), "X-Coordinate": prov(2, 120, 132)},
        layers=[
            layer(0.0, 1.2, "Sand, schluffig", 2, 172, din="S, u"),
            layer(1.2, math.nan, "Kies, sandig", 2, 192, din="G, s"),
            layer(3.4, 6.0, "Ton, steif", 3, 172, din="T"),
        ],
        points=[
            point("SPT", 1.5, 24, 2, label="24 [2,3/4,6,6,8]"),
            point("GWL", 2.1, 2.1, 2, label="water strike"),
            point("SAMPLE", 1.0, None, 2, label="D1", to=1.5),
        ],
        pages=[2, 3],
        issues=["p2: fictional issue"],
        source_file="fictional-report.pdf",
    )


def fx2() -> Any:
    return SimpleNamespace(
        borehole_id="doc:FX-2",
        metadata={"BoreholeName": "FX-2", "BoreholeDepth": 4.5},
        meta_prov={},
        layers=[layer(0.0, 0.8, "Mutterboden", 4, 172), layer(0.8, 4.5, "Sand, kiesig", 4, 192)],
        points=[],
        pages=[4],
        issues=[],
        source_file="fictional-report.pdf",
    )


class FakeBridge(ModuleType):
    """app.bh3.bridge's interface: make_vlm / make_llm / read_pages / build / BudgetExceeded."""

    def __init__(
        self, *, fail: set[int] | None = None, unread: set[int] | None = None, cost: float = 0.0015
    ) -> None:
        super().__init__("app.bh3.bridge")
        self.BudgetExceeded = FakeBudgetExceeded
        self.openrouter_body = real_bridge.openrouter_body  # the request fields the adapter hands to bh3
        self.fail = fail or set()
        self.unread = unread or set()
        self.cost = cost
        self.read: list[int] = []
        self.vlm_args: tuple[str, str] | None = None
        self.vlm_options: dict[str, Any] = {}
        self.llm_model: str | None = None
        self.on_call: Any = None
        self.guard: Any = None
        self.built_with: dict[str, Any] = {}

    def make_vlm(
        self,
        base_url: str,
        api_key: str,
        model: str,
        on_call: Any = None,
        *,
        cache_dir: Path,
        guard: Any = None,
        **options: Any,
    ) -> Any:
        self.vlm_args, self.on_call, self.guard = (base_url, model), on_call, guard
        self.vlm_options = options
        return SimpleNamespace(model=model)

    def make_llm(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        cache_dir: Path,
        on_call: Any = None,
        **options: Any,
    ) -> Any:
        self.llm_model = model
        return SimpleNamespace(model=model)

    def read_pages(
        self,
        source_file: str,
        *,
        vlm: Any,
        workdir: Path,
        pdf_path: Path | None = None,
        image_paths: dict[int, Path] | None = None,
        pages: list[int] | None = None,
        doc_id: str | None = None,
    ) -> list[Any]:
        assert pdf_path is not None and pdf_path.exists() and image_paths is None and workdir.is_dir()
        assert source_file == str(pdf_path) and pages is not None and len(pages) == 1 and doc_id
        n = pages[0]
        self.read.append(n)
        if n in self.fail:
            raise RuntimeError("fictional tile failure")
        if n in self.unread:
            return [
                SimpleNamespace(
                    page_no=n, language="", page_type="unread", route="error", issues=["fictional"]
                )
            ]
        self.guard()  # before every paid call
        call = {"purpose": "tile", "model": vlm.model, "ok": True, "input_tokens": 2400, "output_tokens": 300}
        self.on_call({**call, "cost_usd": self.cost})
        return [SimpleNamespace(page_no=n, language="de", page_type="log", route="vlm")]

    def build(
        self, page_results: list[Any], source_file: str, *, doc_id: str | None = None, llm: Any = None
    ) -> list[Any]:
        self.built_with = {"doc_id": doc_id, "llm": llm}
        pages = {r.page_no for r in page_results}
        return [hole for hole, needs in ((fx1(), {2, 3}), (fx2(), {4})) if needs <= pages]


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch) -> Fakes:
    found = Fakes(FakeClassifier(classify_rule), FakeOcrEngine(), FakeExtractor())
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: found.classifier)
    monkeypatch.setattr(ocr_mistral, "MistralOcrClient", lambda: found.ocr)
    monkeypatch.setattr(extract_module, "OpenRouterExtractor", lambda: found.extractor)
    return found


@pytest.fixture
def settings_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    def set_env(**values: str) -> None:
        for key, value in values.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()

    yield set_env
    get_settings.cache_clear()


@pytest.fixture
def bh3(monkeypatch: pytest.MonkeyPatch, settings_env: Any) -> Any:
    def use(bridge: FakeBridge) -> FakeBridge:
        settings_env(EXTRACTOR="bh3")
        monkeypatch.setattr(bh3_adapter, "load_bridge", lambda: bridge)
        return bridge

    return use


async def test_bh3_boreholes_are_finalised_with_evidence_and_questions(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, bh3: Any
) -> None:
    bridge = bh3(FakeBridge())
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    assert bridge.read == [2, 3, 4]  # the log pages, one at a time
    # OpenRouter first (live_mode sets its key): Gemini reads the pages and normalises layers, with the
    # reasoning it requires
    assert bridge.vlm_args == ("https://openrouter.ai/api/v1", "google/gemini-3.5-flash")
    assert bridge.llm_model == "google/gemini-3.5-flash"
    assert bridge.vlm_options["extra_body"]["reasoning"] == {"effort": "low"}
    assert bridge.built_with["doc_id"] == doc_id and bridge.built_with["llm"] is not None
    assert fakes.extractor.calls == 0  # bh3 covered every log page
    doc = await document(client, doc_id)
    assert doc["status"] == "needs_review" and doc["warnings"] == []
    by_label = await records(client, doc_id)
    assert sorted(by_label) == ["FX-1", "FX-2"]
    hole = by_label["FX-1"]
    layers = hole["stratigraphy"]
    # The open stratum takes the next stratum's top as its bottom; nothing is dropped.
    assert [(x["depth_from_m"], x["depth_to_m"]) for x in layers] == [(0.0, 1.2), (1.2, 3.4), (3.4, 6.0)]
    assert [x["original_description"] for x in layers] == ["Sand, schluffig", "Kies, sandig", "Ton, steif"]
    assert layers[1]["spt_n_value"] == 24 and layers[0]["din4023_code"] == "S"
    assert hole["groundwater"][0]["depth_m"] == 2.1
    assert hole["metadata"]["borehole_depth_m"] == 6.0
    evidence = hole["provenance"]["stratigraphy[0].original_description"]
    assert evidence["page"] == 2 and evidence["box"] is not None
    # bh3's row band, tightened to the printed words: the page has a text layer, so it counts as read.
    x, y, w, h = evidence["box"]
    assert x > 0.0 and w < 1.0 and 0.0 < y < 1.0 and 0.0 < h < 0.1 and evidence["method"] == "read"
    # Printed degrees without a system: asked, never plotted on a guess.
    assert hole["crs_status"] == "inferred" and hole["plotted"] is False
    questions = await call(client, "GET", "/api/v1/clarifications", expect=200)
    assert any(q["kind"] == "crs_confirm" and hole["uid"] in q["borehole_uids"] for q in questions)
    async with get_sessionmaker()() as session:
        rows = (await session.scalars(select(ProviderCall).where(ProviderCall.document_id == doc_id))).all()
    bh3_rows = [r for r in rows if r.purpose == "bh3:tile"]
    assert len(bh3_rows) == 3 and all(r.provider == "openrouter" and r.input_tokens == 2400 for r in bh3_rows)

    # A retry of the extraction finds every bh3 borehole finished and creates nothing twice.
    from app.pipeline.orchestrator import stage_extract

    await stage_extract(doc_id)
    assert sorted(await records(client, doc_id)) == ["FX-1", "FX-2"]


@pytest.mark.parametrize("how", ["raises", "unread"])
async def test_a_page_bh3_cannot_read_goes_to_the_classic_extractor(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, bh3: Any, how: str
) -> None:
    bh3(FakeBridge(fail={4}) if how == "raises" else FakeBridge(unread={4}))
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    assert fakes.extractor.calls == 1  # only FX-2's group
    by_label = await records(client, doc_id)
    assert sorted(by_label) == ["FX-1", "FX-2"]
    fx2_layers = by_label["FX-2"]["stratigraphy"]
    assert (
        by_label["FX-2"]["provenance"]["stratigraphy[0].depth_from_m"]["raw"] == "0,00"
    )  # classic: as printed
    assert len(fx2_layers) == 2


async def test_the_budget_stops_bh3_with_a_readable_failure(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, bh3: Any, settings_env: Any
) -> None:
    bh3(FakeBridge(cost=0.3))
    settings_env(PROVIDER_BUDGET_USD="0.5")
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    assert doc["status"] == "failed" and doc["failed_stage"] == "extract"
    assert "budget" in (doc["error"] or "").lower()
    assert fakes.extractor.calls == 0  # the budget is not worked around by the classic extractor


def test_boxes_scale_from_pdf_points_to_the_render() -> None:
    info = bh3_adapter._PageInfo(2, width_px=1240, height_px=1754, text_quality=1.0, handwriting="none")
    blocks = bh3_adapter._Blocks({2: info}, {2: 842.0})
    width_pt = 1240 * 842.0 / 1754
    box = blocks.box(prov(2, 421.0, 463.1, x0=width_pt / 4, x1=width_pt / 2))
    assert box == pytest.approx((0.25, 0.5, 0.25, 0.05), abs=1e-4)
    assert blocks.box(prov(2)) is None  # no row band: the whole page
    assert blocks.box(prov(2, 100.0, 120.0))[0::2] == (0.0, 1.0)  # type: ignore[index]


def test_spt_label_and_depth_text() -> None:
    assert bh3_adapter._spt_parts(24, "24 [2,3/4,6,6,8]") == ("24", "2,3/4,6,6,8")
    assert bh3_adapter._spt_parts(None, "R [50/120]") == ("R", "50/120")
    assert bh3_adapter._spt_parts(31, None) == ("31", None)
    assert [bh3_adapter._depth_text(v) for v in (6.0, 10.46, 1.255, -0.12, math.nan, None)] == [
        "6.00",
        "10.46",
        "1.255",
        "0.00",  # anchoring a hair above the top is the top
        None,
        None,
    ]
    assert bh3_adapter._printed_uscs("Sandy CLAY (CL), stiff", "CL") == "CL"
    assert bh3_adapter._printed_uscs("Sandy clay, stiff", "CL") is None  # the model's class, not printed


async def test_in_bh3_mode_only_log_pages_get_paid_ocr(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, bh3: Any
) -> None:
    bh3(FakeBridge())
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    by_page = {p["n"]: p["ocr"] for p in doc["pages"] if p["used"]}
    # page 5 is a summary table; pages 2-4 are log sheets whose text layer bh3 reads directly
    assert by_page == {2: "skipped", 3: "skipped", 4: "skipped", 5: "skipped"}
    assert doc["warnings"] == [] and fakes.ocr.pages_seen == 0


async def test_a_document_without_borehole_logs_is_done_and_says_so(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes
) -> None:
    from tests.pdf_factory import TextItem, make_pdf

    pdf = make_pdf(
        [
            [TextItem(120, 700, "FICTIONAL SITE REPORT", 16), TextItem(120, 670, "COVER PAGE")],
            [
                TextItem(60, 780, "INTRODUCTION", 14),
                TextItem(60, 750, "This fictional text describes a site."),
            ],
        ]
    )
    doc_id = await upload(client, pdf)
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    assert doc["status"] == "done" and doc["warnings"] == ["No borehole logs were found in this document."]
    assert await records(client, doc_id) == {} and fakes.extractor.calls == 0


def test_text_layer_pages_take_the_classifier_language() -> None:
    info = bh3_adapter._PageInfo(1, 100, 140, 1.0, "none", "en-GB")
    assert bh3_adapter._base_language(info) == "en"
    assert bh3_adapter._base_language(bh3_adapter._PageInfo(1, 100, 140, 1.0, "none", None)) is None


class ThinBridge(FakeBridge):
    """bh3 reads FX-2's sheet as one layer, and names no hole on it."""

    def build(
        self, page_results: list[Any], source_file: str, *, doc_id: str | None = None, llm: Any = None
    ) -> list[Any]:
        holes = super().build(page_results, source_file, doc_id=doc_id, llm=llm)
        for hole in holes:
            if hole.pages == [4]:
                hole.layers = hole.layers[:1]
        return holes


class NamelessBridge(FakeBridge):
    def build(
        self, page_results: list[Any], source_file: str, *, doc_id: str | None = None, llm: Any = None
    ) -> list[Any]:
        holes = super().build(page_results, source_file, doc_id=doc_id, llm=llm)
        for hole in holes:
            if hole.pages == [4]:
                hole.metadata = {**hole.metadata, "BoreholeName": "doc-BH2", "_name_generated": True}
        return holes


async def test_at_most_one_layer_on_a_log_sheet_goes_to_the_classic_extractor(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, bh3: Any
) -> None:
    bh3(ThinBridge())
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    assert fakes.extractor.calls == 1  # FX-2's sheet, read again by the classic extractor
    by_label = await records(client, doc_id)
    assert sorted(by_label) == ["FX-1", "FX-2"] and len(by_label["FX-2"]["stratigraphy"]) == 2


async def test_an_unnamed_hole_takes_the_label_the_classifier_read(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, bh3: Any
) -> None:
    bh3(NamelessBridge())
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    assert sorted(await records(client, doc_id)) == ["FX-1", "FX-2"]  # not "unlabelled p4"


def test_a_page_without_ink_or_text_is_blank() -> None:
    import io

    from PIL import Image, ImageDraw

    from app.pipeline.classify import is_blank

    def png(draw_text: bool) -> bytes:
        img = Image.new("RGB", (1240, 1754), "white")
        if draw_text:  # a faint grey log: one line every 40 px down the page
            draw = ImageDraw.Draw(img)
            for row in range(40):
                draw.text(
                    (100, 100 + 40 * row), f"FICTIONAL {row}.00 - {row}.50 Sand, faint", fill=(150, 150, 150)
                )
        out = io.BytesIO()
        img.save(out, format="PNG")
        return out.getvalue()

    assert is_blank(png(False), None) is True
    assert is_blank(png(False), "BOREHOLE LOG FX-9") is False  # embedded text: not blank
    assert is_blank(png(True), None) is False  # faint grey writing still counts as ink
