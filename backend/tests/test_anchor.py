"""Offline tests for geometry anchoring: grid overlay, line detection, scale fit, applying the anchor."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

from app.bh3.anchor import MARGIN, anchor_tile, detect_hlines, draw_grid, fit_scale, snap


def _page(tmp: Path, lines=(150, 400, 650)) -> Path:
    im = Image.new("RGB", (800, 900), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for y in lines:
        d.line([(60, y), (780, y)], fill=(0, 0, 0), width=2)
    d.line([(60, 0), (60, 900)], fill=(0, 0, 0), width=2)          # a vertical rule must not count
    p = tmp / "tile.jpg"
    im.save(p, quality=90)
    return p


def test_grid_adds_margins_and_keeps_height(tmp_path: Path):
    p = _page(tmp_path)
    out, step = draw_grid(p, tmp_path / "grid.jpg", step=100)
    g = Image.open(out)
    assert g.size == (800 + 2 * MARGIN, 900) and step == 100
    r, gg, b = g.getpixel((MARGIN + 400, 300))
    assert r > gg + 60 and r > b + 60                          # grid line is red, not black


def test_detect_hlines_finds_ruling_lines_only(tmp_path: Path):
    p = _page(tmp_path)
    ys = detect_hlines(p)
    assert len(ys) == 3 and all(any(abs(y - t) <= 3 for t in (150, 400, 650)) for y in ys)
    assert snap(404, ys, 10) == ys[1] and snap(500, ys, 10) is None


def test_fit_scale_robust_to_one_bad_tick():
    ticks = [(100, 0.0), (200, 1.0), (300, 2.0), (400, 3.0), (520, 4.0), (600, 5.0)]     # 520 is a misread
    f = fit_scale(ticks)
    assert f is not None and abs(f.slope - 100) < 3 and abs(f.depth_at(350) - 2.5) < 0.05
    assert fit_scale([(100, 0.0), (200, 1.0)]) is None


def test_anchor_tile_rewrites_depths_and_snaps(tmp_path: Path):
    p = _page(tmp_path, lines=(100, 300, 500))
    hl = detect_hlines(p)
    res = {"scale_ticks": [{"depth": 0, "y_grid": 100}, {"depth": 1, "y_grid": 200}, {"depth": 2, "y_grid": 300}, {"depth": 3, "y_grid": 400}],
           "layers": [{"top": 0.0, "bottom": 1.5, "description": "A", "y_grid_top": 100, "y_grid_bottom": 300},     # model said 1.5, line says 2.0
                      {"top": 1.5, "bottom": 9.0, "description": "B", "y_grid_top": 300, "y_grid_bottom": 500}],    # 9.0 is far off → rejected
           "spt": [{"depth": 1.3, "depth_to": 1.75, "n_value": "12", "blows": None, "y_grid": 250}]}
    out, st = anchor_tile(res, hl)
    assert st["fit"]["n"] == 4 and st["rejected"] == 1
    assert abs(out["layers"][0]["bottom"] - 2.0) < 0.03 and abs(out["layers"][1]["top"] - 2.0) < 0.03 and out["layers"][1]["bottom"] == 9.0
    assert abs(out["spt"][0]["depth"] - 1.5) < 0.03 and abs(out["spt"][0]["depth_to"] - 1.95) < 0.03
