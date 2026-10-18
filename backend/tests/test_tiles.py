"""Offline tests for tile planning and merging (no model, no images beyond tiny synthetic ones)."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

from app.bh3.tiles import merge_spt_tiles, merge_tiles, plan_tiles, render_tile


def test_plan_single_tile_when_small():
    specs = plan_tiles((1000, 1200), (0.0, 0.3, 1.0, 0.9), (0.0, 0.25, 1.0, 0.3), tile_px=1400)
    assert len(specs) == 1
    assert specs[0].body_px[1] >= 300 - 12 and specs[0].header_px is not None


def test_plan_splits_with_overlap_and_rows_cap():
    specs = plan_tiles((1000, 4000), (0.0, 0.1, 1.0, 1.0), None, tile_px=1400, overlap=0.15)
    assert len(specs) == 3
    # consecutive tiles overlap
    for a, b in zip(specs, specs[1:]):
        assert b.body_px[1] < a.body_px[3]
    # rows_estimate forces more tiles than pixel height would
    specs = plan_tiles((1000, 1500), (0.0, 0.0, 1.0, 1.0), None, tile_px=1400, rows_estimate=40, max_rows_per_tile=15)
    assert len(specs) == 3


def test_plan_falls_back_to_full_page_on_bad_boxes():
    specs = plan_tiles((800, 1000), None, (0.0, 0.5, 1.0, 0.95), tile_px=2000)
    assert specs[0].body_px == (0, 0, 800, 1000)
    assert specs[0].header_px is None            # too tall for a title strip → dropped


def test_render_tile_stitches_header(tmp_path: Path):
    img = Image.new("RGB", (400, 1000), (255, 255, 255))
    for y in range(100, 120):
        for x in range(400):
            img.putpixel((x, y), (0, 0, 0))     # a black "column title" band
    p = tmp_path / "page.jpg"
    img.save(p)
    specs = plan_tiles((400, 1000), (0.0, 0.12, 1.0, 1.0), (0.0, 0.1, 1.0, 0.12), tile_px=500)
    assert len(specs) >= 2
    out = render_tile(p, specs[1], tmp_path / "t1.jpg")
    t = Image.open(out)
    assert t.height > specs[1].body_px[3] - specs[1].body_px[1]     # header strip was added
    assert sum(t.getpixel((200, 5))) < 40                               # and it sits on top (jpeg-dark)


def _L(top, bottom, desc, pt=False, pb=False):
    return {"top": top, "bottom": bottom, "description": desc, "partial_top": pt, "partial_bottom": pb}


def test_merge_overlap_duplicate_and_continuation():
    t1 = {"borehole_name": "BH-1", "sheet_no": 1, "sheet_total": 2, "depth_unit": "m", "visible_depth_top": 0, "visible_depth_bottom": 5.2,
          "layers": [_L(0, 1.0, "TOPSOIL dark brown"), _L(1.0, 3.5, "Sandy CLAY, grey"), _L(3.5, None, "Silty SAND, brown", pb=True)],
          "spt": [{"depth": 1.0, "depth_to": 1.45, "n_value": "12", "blows": None}], "core_runs": [], "samples": [],
          "groundwater": [{"depth": 2.0, "note": None}], "terminal_note": None, "total_depth": None}
    t2 = {"borehole_name": None, "sheet_no": None, "sheet_total": None, "depth_unit": "m", "visible_depth_top": 4.5, "visible_depth_bottom": 10.0,
          "layers": [_L(None, 6.0, "Silty SAND, brown, fine", pt=True), _L(6.0, 9.5, "GRAVEL with cobbles"), _L(9.5, 10.0, "LIMESTONE")],
          "spt": [{"depth": 1.0, "depth_to": 1.45, "n_value": "12", "blows": None}, {"depth": 7.0, "depth_to": None, "n_value": "R", "blows": None}],
          "core_runs": [], "samples": [], "groundwater": [{"depth": 2.0, "note": None}], "terminal_note": "End of borehole at 10.00 m", "total_depth": 10.0}
    m, issues, st = merge_tiles([t1, t2])
    assert [(L["top"], L["bottom"]) for L in m["layers"]] == [(0, 1.0), (1.0, 3.5), (3.5, 6.0), (6.0, 9.5), (9.5, 10.0)]
    assert "fine" in m["layers"][2]["description"] and not m["layers"][2]["partial_bottom"]
    assert len(m["spt"]) == 2 and len(m["groundwater"]) == 1
    assert m["borehole_name"] == "BH-1" and m["total_depth"] == 10.0 and m["visible_depth_bottom"] == 10.0
    assert st["overlap_matched"] == 1 and not issues


def test_merge_same_layer_repeated_in_overlap_with_disagreement():
    t1 = {"layers": [_L(0, 2.0, "CLAY"), _L(2.0, 4.0, "SAND, medium dense")], "depth_unit": "m"}
    t2 = {"layers": [_L(2.0, 4.6, "SAND, medium dense"), _L(4.6, 7.0, "ROCK")], "depth_unit": "m"}
    m, issues, st = merge_tiles([t1, t2])
    assert len(m["layers"]) == 3
    assert st["overlap_disagreed"] == 1 and any("disagree" in i for i in issues)


def test_merge_handles_failed_tile():
    t1 = {"layers": [_L(0, 2.0, "CLAY", pb=True)], "depth_unit": "m"}
    m, issues, st = merge_tiles([t1, None])
    assert st["tiles_failed"] == 1 and m["layers"][0]["bottom"] == 2.0 and any("failed" in i for i in issues)


def test_merge_spt_rows_dedupe_and_sort():
    a = {"rows": [{"depth_from": 1.5, "depth_to": 1.95, "blows": [3, 4, 5], "n_value": "9", "remark": None},
                  {"depth_from": 3.0, "depth_to": 3.45, "blows": [5, 6, 7], "n_value": "13", "remark": None}], "depth_unit": "m"}
    b = {"rows": [{"depth_from": 3.0, "depth_to": 3.45, "blows": [5, 6, 7], "n_value": "13", "remark": None},
                  {"depth_from": 4.5, "depth_to": 4.95, "blows": [8, 9, 9], "n_value": "18", "remark": None}], "depth_unit": "m"}
    m, issues = merge_spt_tiles([a, b])
    assert [r["depth_from"] for r in m["rows"]] == [1.5, 3.0, 4.5] and not issues


def test_merge_shifted_reread_is_same_layer_by_text():
    # tile 2 misread its depth scale by +2 m but repeats the same cells: identity by text, first tile wins
    t1 = {"layers": [_L(0, 1.0, "Silty Sand fine to medium grained, calcareous"), _L(1.0, 2.0, "Grades with little construction rubbles"),
                     _L(2.0, 3.0, "Grades without rubbles"), _L(3.0, None, "Silty Sand fine grained, slightly calcareous", pb=True)], "depth_unit": "m"}
    t2 = {"layers": [_L(4.0, 5.0, "Grades without rubbles"), _L(5.0, 6.0, "Silty Sand fine grained, slightly calcareous"),
                     _L(6.0, 8.0, "Grades silty, light brown colour")], "depth_unit": "m"}
    m, issues, st = merge_tiles([t1, t2])
    assert [L["description"][:12] for L in m["layers"]] == ["Silty Sand f", "Grades with ", "Grades witho", "Silty Sand f", "Grades silty"]
    assert st["overlap_disagreed"] >= 1 and any("disagree" in i for i in issues)
