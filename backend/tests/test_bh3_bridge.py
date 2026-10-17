"""bh3 in the backend: PDF reading through pypdfium2, the vision path on a fake model, budget, page isolation.

No network: the vision model is a fake that answers per call kind. No challenge data: PDFs and images are made
here.
"""

from __future__ import annotations

import ctypes
import math
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
import pytest
from PIL import Image, ImageDraw

from app.bh3 import bridge
from app.bh3 import pdfium as bh3_pdfium
from app.bh3.inputs import PageSource
from app.bh3.llm import LLM, LLMConfig
from app.bh3.vlm import VLM

# ------------------------------------------------------------------------------------------------
# helpers
# ------------------------------------------------------------------------------------------------


def _text(
    pdf: pdfium.PdfDocument, page: pdfium.PdfPage, s: str, x: float, y: float, size: float = 10
) -> None:
    obj = pdfium_c.FPDFPageObj_NewTextObj(pdf.raw, b"Helvetica", ctypes.c_float(size))
    data = (s + "\x00").encode("utf-16-le")
    buf = (ctypes.c_ushort * (len(data) // 2)).from_buffer_copy(data)
    assert pdfium_c.FPDFText_SetText(obj, buf)
    pdfium_c.FPDFPageObj_Transform(obj, 1, 0, 0, 1, x, y)
    pdfium_c.FPDFPage_InsertObject(page.raw, obj)


def _line(page: pdfium.PdfPage, x0: float, y0: float, x1: float, y1: float) -> None:
    path = pdfium_c.FPDFPageObj_CreateNewPath(x0, y0)
    pdfium_c.FPDFPath_LineTo(path, x1, y1)
    pdfium_c.FPDFPageObj_SetStrokeColor(path, 0, 0, 0, 255)
    pdfium_c.FPDFPageObj_SetStrokeWidth(path, ctypes.c_float(0.8))
    pdfium_c.FPDFPath_SetDrawMode(path, 0, True)
    pdfium_c.FPDFPage_InsertObject(page.raw, path)


def _pdf(path: Path, rotation: int = 0) -> Path:
    pdf = pdfium.PdfDocument.new()
    page = pdf.new_page(595, 842)
    _text(pdf, page, "DEPTH 1.50 m", 60, 720)
    for i, line in enumerate(
        [
            "BOREHOLE LOG  BH-7  Project: test pipeline",
            "Silty SAND, fine, brown, medium dense",
            "CLAY, stiff, grey, high plasticity",
            "End of borehole at 4.00 m",
        ]
    ):
        _text(pdf, page, line, 120, 660 - 40 * i)
    _line(page, 50, 700, 500, 700)  # horizontal ruling line, 142 pt below the top edge
    _line(page, 100, 100, 100, 600)  # vertical ruling line
    if rotation:
        page.set_rotation(rotation)
    pdfium_c.FPDFPage_GenerateContent(page.raw)
    pdf.save(str(path))
    pdf.close()
    return path


def _defaults(schema: dict) -> dict:
    out: dict[str, Any] = {}
    for key, spec in schema["properties"].items():
        kind = spec.get("type")
        kinds = kind if isinstance(kind, list) else [kind]
        if "null" in kinds:
            out[key] = None
        elif "array" in kinds:
            out[key] = []
        elif "integer" in kinds or "number" in kinds:
            out[key] = 0
        elif "boolean" in kinds:
            out[key] = False
        elif "enum" in spec:
            out[key] = spec["enum"][0]
        else:
            out[key] = ""
    return out


ANSWERS: dict[str, dict] = {
    "classify": {
        "page_type": "log",
        "language": "en",
        "depth_unit": "m",
        "rows_estimate": 2,
        "read_quality": "clean",
        "borehole_names_visible": ["BH-7"],
        "header_band": [0.05, 0.02, 0.95, 0.15],
        "column_header_band": [0.05, 0.16, 0.95, 0.2],
        "table_body": [0.05, 0.2, 0.95, 0.95],
        "notes": "",
    },
    "tile_log": {
        "borehole_name": "BH-7",
        "sheet_no": 1,
        "sheet_total": 1,
        "depth_unit": "m",
        "visible_depth_top": 0,
        "visible_depth_bottom": 4,
        "n_strata": 2,
        "boundary_depths": [1.5, 4.0],
        "layers": [
            {
                "top": 0,
                "bottom": 1.5,
                "description": "Silty SAND, fine, brown",
                "partial_top": False,
                "partial_bottom": False,
                "y_grid_top": None,
                "y_grid_bottom": None,
            },
            {
                "top": 1.5,
                "bottom": 4.0,
                "description": "CLAY, stiff, grey",
                "partial_top": False,
                "partial_bottom": False,
                "y_grid_top": None,
                "y_grid_bottom": None,
            },
        ],
        "spt": [{"depth": 1.0, "depth_to": 1.45, "n_value": "12", "blows": "3,5,7", "y_grid": None}],
        "terminal_note": "End of borehole at 4.00 m",
        "total_depth": 4.0,
    },
    "header": {
        "BoreholeName": "BH-7",
        "X-Coordinate": "E 512 345.6",
        "Y-Coordinate": "N 5 405 870.2",
        "CoordinateSystem": "ETRS89 / UTM 32N",
        "BoreholeDepth": "4.00 m",
    },
}


class FakeLLM(LLM):
    """Answers vision calls from ANSWERS (padded to the schema) and reports them like the real client."""

    def __init__(self, cfg: LLMConfig, fail: set[str] | None = None) -> None:
        super().__init__(cfg)
        self.fail = fail or set()
        self.names: list[str] = []

    def complete_vision_json(
        self,
        image_bytes,
        mime,
        system,
        user_text,
        schema,
        name,
        model=None,
        max_tokens=4096,
        prompt_version="1",
    ):
        self.names.append(name)
        if name in self.fail:
            raise RuntimeError(f"fake failure in {name}")
        if self.cfg.on_call:
            self.cfg.on_call(
                {
                    "purpose": name,
                    "model": "fake",
                    "ok": True,
                    "input_tokens": 1000,
                    "output_tokens": 100,
                    "cost_usd": 0.001,
                }
            )
        answer = {**_defaults(schema), **ANSWERS.get(name, {})}
        return answer, {
            "cache_hit": False,
            "calls": 1,
            "schema_mode": "json_schema",
            "truncated": False,
            "error": None,
            "prompt_tokens": 1000,
            "completion_tokens": 100,
            "latency_s": 0.0,
        }


def _vlm(tmp_path: Path, calls: list, guard=None, fail: set[str] | None = None) -> VLM:
    cfg = LLMConfig(
        base_url="http://fake.invalid/v1",
        api_key="test",
        model="fake",
        cache_dir=tmp_path / "llm",
        on_call=calls.append,
    )
    return VLM(FakeLLM(cfg, fail), guard=guard)


def _scan(tmp_path: Path) -> Path:
    im = Image.new("RGB", (1240, 1754), "white")
    d = ImageDraw.Draw(im)
    for y in (350, 700, 1600):
        d.line([(60, y), (1180, y)], fill="black", width=3)
    path = tmp_path / "scan.png"
    im.save(path)
    return path


# ------------------------------------------------------------------------------------------------
# PDF reading (pypdfium2 instead of PyMuPDF)
# ------------------------------------------------------------------------------------------------


def test_pdf_words_and_ruling_lines_in_top_left_points(tmp_path: Path) -> None:
    pdf = _pdf(tmp_path / "log.pdf")
    content = bh3_pdfium.page_content(str(pdf), 0)
    assert (round(content.width), round(content.height)) == (595, 842)
    words = {w.text: w for w in content.words}
    assert {"DEPTH", "1.50", "m"} <= set(words)
    assert words["DEPTH"].x0 == pytest.approx(60, abs=2)
    assert (
        842 - 720 - 12 < words["DEPTH"].y0 < words["DEPTH"].y1 < 842 - 720 + 3
    )  # baseline at y=720 from the bottom
    horizontal = [s for s in content.segments if s.horizontal]
    vertical = [s for s in content.segments if s.vertical]
    assert any(abs(s.y0 - 142) < 1 and s.length > 400 for s in horizontal)
    assert any(abs(s.x0 - 100) < 1 and s.length > 400 for s in vertical)
    assert content.image_area_ratio == 0


def test_rotated_page_swaps_axes(tmp_path: Path) -> None:
    pdf = _pdf(tmp_path / "rot.pdf", rotation=90)
    content = bh3_pdfium.page_content(str(pdf), 0)
    assert (round(content.width), round(content.height)) == (842, 595)
    # the horizontal line of the unrotated page is vertical once the page is displayed turned by 90°
    assert any(s.vertical and s.length > 400 for s in content.segments)
    img = bh3_pdfium.render(str(pdf), 0, 0.5)
    assert img.width > img.height


def test_text_layer_page_needs_no_model(tmp_path: Path) -> None:
    calls: list = []
    pdf = _pdf(tmp_path / "log.pdf")
    vlm = _vlm(tmp_path, calls)
    results = bridge.read_pages("log.pdf", vlm=vlm, workdir=tmp_path / "work", pdf_path=pdf, doc_id="doc1")
    assert len(results) == 1 and results[0].page_no == 1
    # a page that is not a log is decided from its text layer; a weak log page would go to the vision path
    assert results[0].route in ("vector", "vector→vlm")


# ------------------------------------------------------------------------------------------------
# vision path, budget, page isolation
# ------------------------------------------------------------------------------------------------


def test_scanned_page_becomes_a_borehole(tmp_path: Path) -> None:
    calls: list = []
    vlm = _vlm(tmp_path, calls)
    results = bridge.read_pages(
        "scan.png", vlm=vlm, workdir=tmp_path / "work", image_paths={1: _scan(tmp_path)}, doc_id="doc2"
    )
    assert [r.page_type for r in results] == ["log"]
    boreholes = bridge.build(results, "scan.png", doc_id="doc2")
    assert len(boreholes) == 1
    bh = boreholes[0]
    assert bh.metadata["BoreholeName"] == "BH-7"
    assert bh.metadata["_raw"]["X-Coordinate"] == "E 512 345.6"  # printed text kept for the CRS service
    tops = [(L.top, L.bottom) for L in bh.layers if not math.isnan(L.top)]
    assert tops[0][0] == 0 and (1.5, 4.0) in tops
    assert any(p.kind == "SPT" for p in bh.points)
    assert all(L.__dict__.get("din_main") in (None, "S", "fS", "T", "U") for L in bh.layers)
    scan = str(tmp_path / "scan.png")
    page_h = bridge.page_size_pt(PageSource("doc2", scan, 1, "image", image_path=scan))[1]
    for L in bh.layers:  # bands are page points, within the page
        assert 0 <= L.prov.y0 <= L.prov.y1 <= page_h + 1
    assert calls and all(c["cost_usd"] == 0.001 for c in calls)


def test_budget_stop_propagates(tmp_path: Path) -> None:
    calls: list = []

    def guard() -> None:
        raise bridge.BudgetExceeded("cap reached")

    vlm = _vlm(tmp_path, calls, guard=guard)
    with pytest.raises(bridge.BudgetExceeded):
        bridge.read_pages("scan.png", vlm=vlm, workdir=tmp_path / "work", image_paths={1: _scan(tmp_path)})
    assert calls == []


def test_a_failing_page_does_not_stop_the_document(tmp_path: Path) -> None:
    calls: list = []
    scan = _scan(tmp_path)
    other = tmp_path / "scan2.png"
    Image.open(scan).save(other)
    vlm = _vlm(tmp_path, calls, fail={"classify"})
    results = bridge.read_pages(
        "two.png", vlm=vlm, workdir=tmp_path / "work", image_paths={1: scan, 2: other}
    )
    assert [r.page_no for r in results] == [1, 2]
    for r in results:
        assert r.page_type == "unread"
        assert r.route == "error" or r.issues
