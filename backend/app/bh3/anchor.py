"""Geometry anchoring: take depth *positions* away from the model.

The dominant error on photos and small scans is systematic: the text is right, the depth is one cell off,
because the model estimates where a boundary sits on the scale. Three deterministic pieces fix that:

  1. a labelled coordinate grid is drawn on every tile (horizontal lines every `step` px, labelled in a
     margin on both sides) — models read a label next to a line reliably, unlike raw pixel coordinates;
  2. the model reports, for each depth-scale tick, boundary and test row, the nearest grid label
     (`y_grid` fields in the tile schema); the y→depth mapping is then fitted in code from the ticks;
  3. horizontal ruling lines are detected on the tile with OpenCV and each boundary is snapped to the
     nearest detected line before its depth is computed.

Everything here is pure numpy/OpenCV/PIL and runs on-prem.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

GRID_STEP = 100          # px between labelled grid lines on the tile
MARGIN = 54              # px of white margin added on each side for the labels


@dataclass
class ScaleFit:
    slope: float          # px per depth unit
    intercept: float      # y (px, tile frame incl. margin offset = 0) at depth 0
    r2: float
    n: int

    def depth_at(self, y: float) -> float:
        return (y - self.intercept) / self.slope

    def y_at(self, depth: float) -> float:
        return self.intercept + depth * self.slope


# ---------------------------------------------------------------------------
# grid overlay
# ---------------------------------------------------------------------------

def draw_grid(img_path: Path, out_path: Path, step: int = GRID_STEP, margin: int = MARGIN) -> tuple[Path, int]:
    """Return the gridded image path and the step used. Labels are the y coordinate in the ORIGINAL tile
    frame (0 at the tile's top edge), so the model's answers map straight back to tile pixels."""
    from PIL import Image, ImageDraw, ImageFont
    im = Image.open(img_path).convert("RGB")
    W, H = im.size
    canvas = Image.new("RGB", (W + 2 * margin, H), (255, 255, 255))
    canvas.paste(im, (margin, 0))
    d = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("arial.ttf", 16)
    except Exception:  # noqa: BLE001
        font = ImageFont.load_default()
    for y in range(0, H, step):
        d.line([(0, y), (W + 2 * margin, y)], fill=(220, 40, 40), width=1)
        label = str(y)
        d.rectangle([2, y + 1, margin - 2, y + 18], fill=(255, 255, 255))
        d.text((4, y + 1), label, fill=(200, 0, 0), font=font)
        d.rectangle([W + margin + 2, y + 1, W + 2 * margin - 2, y + 18], fill=(255, 255, 255))
        d.text((W + margin + 4, y + 1), label, fill=(200, 0, 0), font=font)
    from .render import save_atomic
    save_atomic(canvas, out_path, quality=88)
    return out_path, step


# ---------------------------------------------------------------------------
# ruling lines
# ---------------------------------------------------------------------------

def detect_hlines(img_path: Path, min_frac: float = 0.25, x_range: Optional[tuple[int, int]] = None) -> list[int]:
    """y positions (px) of dark horizontal lines spanning at least `min_frac` of the (sub)width.
    OpenCV morphology (adaptive threshold + horizontal opening); returns merged positions."""
    import cv2
    g = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
    if g is None:
        return []
    if x_range:
        g = g[:, max(0, x_range[0]):min(g.shape[1], x_range[1])]
    h, w = g.shape
    bw = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, 10)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, int(w * min_frac * 0.5)), 1))
    m = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    ys: list[float] = []
    for i in range(1, n):
        x, y, cw, ch, area = stats[i]
        if cw >= w * min_frac and ch <= 6:
            ys.append(y + ch / 2)
    ys.sort()
    out: list[int] = []
    for y in ys:
        if out and y - out[-1] <= 4:
            continue
        out.append(int(round(y)))
    return out


def snap(y: float, lines: list[int], tol: float) -> Optional[int]:
    best = None
    for L in lines:
        if abs(L - y) <= tol and (best is None or abs(L - y) < abs(best - y)):
            best = L
    return best


# ---------------------------------------------------------------------------
# scale fit
# ---------------------------------------------------------------------------

def fit_scale(ticks: list[tuple[float, float]], min_r2: float = 0.985) -> Optional[ScaleFit]:
    """ticks = [(y_px, depth)] from the model's grid reading. Robust least squares: drop the worst residual
    while r² is poor (up to 2 points). Needs ≥ 3 ticks, increasing depth with y, plausible slope."""
    pts = sorted({(float(y), float(d)) for y, d in ticks if y is not None and d is not None})
    if len(pts) < 3:
        return None
    for _ in range(3):
        ys = np.array([p[0] for p in pts]); ds = np.array([p[1] for p in pts])
        A = np.vstack([ds, np.ones_like(ds)]).T
        coef, *_ = np.linalg.lstsq(A, ys, rcond=None)
        pred = A @ coef
        ss_res = float(np.sum((ys - pred) ** 2)); ss_tot = float(np.sum((ys - ys.mean()) ** 2)) or 1e-9
        r2 = 1 - ss_res / ss_tot
        if r2 >= min_r2 or len(pts) <= 3:
            break
        worst = int(np.argmax(np.abs(ys - pred)))
        pts = [p for i, p in enumerate(pts) if i != worst]
    slope, intercept = float(coef[0]), float(coef[1])
    if not (5 <= slope <= 5000) or r2 < min_r2:
        return None
    return ScaleFit(slope, intercept, r2, len(pts))


# ---------------------------------------------------------------------------
# applying the anchor to a tile answer
# ---------------------------------------------------------------------------

def unanchor(result: dict) -> dict:
    """Restore the model's own depths (undo a previous anchor_tile), so anchoring can be re-applied with
    other settings on a stored answer."""
    for L in result.get("layers") or []:
        if not isinstance(L, dict):
            continue
        for key in ("top", "bottom"):
            mk = f"_{key}_model"
            if mk in L:
                L[key] = L.pop(mk)
    for lst in ("spt", "samples", "groundwater"):
        for it in result.get(lst) or []:
            if isinstance(it, dict) and "_depth_model" in it:
                model = it.pop("_depth_model")
                if isinstance(model, (int, float)) and isinstance(it.get("depth"), (int, float)) and isinstance(it.get("depth_to"), (int, float)):
                    it["depth_to"] = round(it["depth_to"] - (it["depth"] - float(model)), 2)
                it["depth"] = model
    result.pop("_anchor", None)
    return result


def anchor_tile(result: dict, hlines: list[int], tol_px: float = 18.0, max_shift: float = 0.75,
                require_snap: bool = True, min_r2: float = 0.995, min_ticks: int = 4,
                point_max_shift: Optional[float] = None) -> tuple[dict, dict]:
    """Rewrite the depths in a TILE_LOG answer from the grid positions the model reported.

    result must carry `scale_ticks: [{depth, y_grid}]` and `y_grid_top/y_grid_bottom` on layers, `y_grid` on
    spt / samples / groundwater. Returns (result, stats).

    Gate (the model places boundary lines on the grid coarsely, so an anchored value replaces the model's
    own depth only when the evidence is strong): a y→depth fit with r² ≥ min_r2 from ≥ min_ticks ticks; for
    boundaries the grid position must snap to a ruling line detected on the tile (require_snap) and the
    anchored depth must lie within max_shift of the model's depth; for point values (SPT etc.) only the
    shift bound applies (point_max_shift, defaults to max_shift). Larger disagreements are counted as
    rejected and the model's depth is kept.
    """
    stats = {"fit": None, "anchored": 0, "snapped": 0, "kept_model": 0, "rejected": 0, "unsnapped": 0}
    ticks = [(t.get("y_grid"), t.get("depth")) for t in (result.get("scale_ticks") or []) if isinstance(t, dict)]
    fit = fit_scale(ticks, min_r2=min_r2)
    if fit is None or fit.n < min_ticks:
        return result, stats
    stats["fit"] = {"slope": round(fit.slope, 2), "r2": round(fit.r2, 4), "n": fit.n}
    pms = point_max_shift if point_max_shift is not None else max_shift

    def depth_from(y):
        if y is None or not isinstance(y, (int, float)):
            return None, False
        ys = snap(float(y), hlines, tol_px)
        snapped = ys is not None
        return round(fit.depth_at(ys if snapped else float(y)), 2), snapped

    for L in result.get("layers") or []:
        if not isinstance(L, dict):
            continue
        for key, ykey in (("top", "y_grid_top"), ("bottom", "y_grid_bottom")):
            d, snapped = depth_from(L.get(ykey))
            if d is None:
                continue
            model = L.get(key)
            if require_snap and not snapped and isinstance(model, (int, float)):
                stats["unsnapped"] += 1
                continue
            if isinstance(model, (int, float)) and abs(model - d) > max_shift:
                stats["rejected"] += 1
                continue
            if model is None or abs(float(model) - d) > 0.02:
                L[f"_{key}_model"] = model
                L[key] = d
                stats["anchored"] += 1
                stats["snapped"] += 1 if snapped else 0
            else:
                stats["kept_model"] += 1
    for lst in ("spt", "samples", "groundwater"):
        for it in result.get(lst) or []:
            if not isinstance(it, dict):
                continue
            d, _ = depth_from(it.get("y_grid"))
            if d is None:
                continue
            model = it.get("depth")
            if isinstance(model, (int, float)) and abs(model - d) > pms:
                stats["rejected"] += 1
                continue
            if model is None or abs(float(model) - d) > 0.02:
                it["_depth_model"] = model
                if isinstance(model, (int, float)) and it.get("depth_to") is not None and isinstance(it["depth_to"], (int, float)):
                    it["depth_to"] = round(it["depth_to"] + (d - float(model)), 2)
                it["depth"] = d
                stats["anchored"] += 1
    return result, stats
