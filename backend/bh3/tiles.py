"""Tiling of a log page for the vision model, and merging of the per-tile answers.

Why tiles: hosted and local VLMs downscale a full A4 scan to ~1–1.5k px, which turns 6-pt depth digits into
8-px blobs. We cut the table body into vertical slices of at most `tile_px` height (15 % overlap), stitch the
column-title strip above each slice so column roles stay visible, and merge by depth.

Merge rules (deterministic, never averaged):
  * a layer in tile k+1 whose top is within `tol_top` of a layer already merged and whose description prefix
    matches is the same layer: keep the version that is not partial (or the longer description);
  * a layer flagged partial_top (or without a top) at the start of tile k+1 continues the last merged layer
    when that one was partial_bottom (or had no bottom);
  * boundary disagreement > `tol_bound` inside an overlap → recorded as an issue, both values kept in notes;
  * point values (SPT, core runs, samples, groundwater) are concatenated and de-duplicated on (depth ± 0.05, value).
"""
from __future__ import annotations

import difflib
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

BBox = tuple[float, float, float, float]


@dataclass
class TileSpec:
    index: int
    body_px: tuple[int, int, int, int]            # x0, y0, x1, y1 slice of the page image (pixels)
    header_px: Optional[tuple[int, int, int, int]]  # column-title strip to stitch on top (pixels), or None
    n_tiles: int
    scale: float = 1.0                            # tile px = scale * (page px - y_offset) (set by render_tile)
    y_offset: float = 0.0                         # page y (px) at tile y = 0 … for the body part of the tile
    body_tile_y0: float = 0.0                     # tile y (px, after scaling) where the body slice starts

    def page_y(self, y_tile: float) -> float:
        """tile pixel row (as labelled on the grid) → page pixel row."""
        return self.y_offset + (y_tile - self.body_tile_y0) / self.scale

    @property
    def is_first(self) -> bool:
        return self.index == 0

    @property
    def is_last(self) -> bool:
        return self.index == self.n_tiles - 1


# ---------------------------------------------------------------------------
# planning
# ---------------------------------------------------------------------------

def _clamp_bbox(b: Optional[BBox], W: int, H: int, pad: float = 0.0) -> Optional[tuple[int, int, int, int]]:
    if not b or len(b) != 4:
        return None
    x0, y0, x1, y1 = b
    if not all(isinstance(v, (int, float)) and not math.isnan(v) for v in (x0, y0, x1, y1)):
        return None
    if x1 <= x0 or y1 <= y0:
        return None
    x0, y0 = max(0.0, x0 - pad), max(0.0, y0 - pad)
    x1, y1 = min(1.0, x1 + pad), min(1.0, y1 + pad)
    r = (int(x0 * W), int(y0 * H), int(math.ceil(x1 * W)), int(math.ceil(y1 * H)))
    if r[2] - r[0] < 20 or r[3] - r[1] < 20:
        return None
    return r


def plan_tiles(size: tuple[int, int], table_body: Optional[BBox], column_header: Optional[BBox],
               tile_px: int = 1540, overlap: float = 0.15, rows_estimate: Optional[int] = None,
               max_rows_per_tile: int = 15, max_header_frac: float = 0.12) -> list[TileSpec]:
    """Split the table body into vertical slices. `size` = (W, H) of the page image in pixels.
    Falls back to the full page when no body box was found. Returns at least one tile."""
    W, H = size
    body = _clamp_bbox(table_body, W, H, pad=0.01) or (0, 0, W, H)
    header = _clamp_bbox(column_header, W, H, pad=0.005)
    # Horizontal cropping buys resolution only on landscape pages (log on the left, photos/plots beside it);
    # on portrait pages the table spans the width and classifier boxes tend to drop a column, so keep the
    # full width there. The depth scale sits at the left edge: always extend to it.
    if W > 1.3 * H:
        body = (0, body[1], max(body[2], header[2] if header else 0), body[3])
    else:
        body = (0, body[1], W, body[3])
    if header:
        # the title strip must be thin; a tall box is probably wrong → drop it rather than waste pixels
        if header[3] - header[1] > max_header_frac * H:
            header = None
        else:
            # use the full table width for the strip so columns line up with the body slice
            header = (body[0], header[1], body[2], header[3])
    x0, y0, x1, y1 = body
    body_h = y1 - y0
    header_h = (header[3] - header[1]) if header else 0
    # the server scales the long side to `tile_px`; as long as a tile is no taller than it is wide, the
    # scale factor is set by the width, so splitting gains nothing. Tile height may therefore grow to the
    # tile width (or tile_px, whichever is larger) before we cut.
    usable = max(200, max(tile_px, x1 - x0) - header_h)
    n = max(1, int(math.ceil(body_h / usable)))
    if rows_estimate and rows_estimate > 0:
        n = max(n, int(math.ceil(rows_estimate / max_rows_per_tile)))
    if n == 1:
        return [TileSpec(0, (x0, y0, x1, y1), header, 1)]
    step = body_h / n
    ov = step * overlap
    specs: list[TileSpec] = []
    for i in range(n):
        ty0 = int(max(y0, y0 + i * step - (ov if i > 0 else 0)))
        ty1 = int(min(y1, y0 + (i + 1) * step + (ov if i < n - 1 else 0)))
        specs.append(TileSpec(i, (x0, ty0, x1, ty1), header, n))
    return specs


def render_tile(page_img: Path, spec: TileSpec, out_path: Path, max_side: Optional[int] = None, grid: bool = False) -> Path:
    """Cut the body slice, stitch the column-title strip above it, save JPEG. `max_side` downsizes the
    result so its long side does not exceed the server's cap (anything larger is downscaled there anyway)."""
    from PIL import Image
    im = Image.open(page_img).convert("RGB")
    body = im.crop(spec.body_px)
    if spec.header_px and not spec.is_first:
        hdr = im.crop(spec.header_px)
        if hdr.width != body.width:
            hdr = hdr.resize((body.width, max(1, int(hdr.height * body.width / max(1, hdr.width)))))
        canvas = Image.new("RGB", (body.width, hdr.height + 6 + body.height), (255, 255, 255))
        canvas.paste(hdr, (0, 0))
        body_tile_y0 = hdr.height + 6
        # a thin grey separator so the model does not read the strip as a data row
        for y in range(hdr.height, hdr.height + 6):
            for x in range(0, body.width, 2):
                canvas.putpixel((x, y), (160, 160, 160))
        canvas.paste(body, (0, hdr.height + 6))
    elif spec.header_px and spec.is_first and spec.header_px[3] > spec.body_px[1]:
        # first tile: include the header strip region naturally by extending the crop upwards
        canvas = im.crop((spec.body_px[0], spec.header_px[1], spec.body_px[2], spec.body_px[3]))
        body_tile_y0 = spec.body_px[1] - spec.header_px[1]
    else:
        canvas = body
        body_tile_y0 = 0
    f = 1.0
    if max_side and max(canvas.size) > max_side:
        f = max_side / max(canvas.size)
        canvas = canvas.resize((max(1, int(canvas.width * f)), max(1, int(canvas.height * f))), Image.LANCZOS)
    spec.scale = f
    spec.y_offset = float(spec.body_px[1])
    spec.body_tile_y0 = body_tile_y0 * f
    from .render import save_atomic
    save_atomic(canvas, out_path)
    if grid:
        from .anchor import draw_grid
        raw = out_path.with_name(out_path.stem + "_raw.jpg")
        save_atomic(canvas, raw)
        draw_grid(raw, out_path)
    return out_path


# ---------------------------------------------------------------------------
# merging
# ---------------------------------------------------------------------------

def _norm(s: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _similar(a: Optional[str], b: Optional[str], n: int = 40) -> float:
    a, b = _norm(a)[:n], _norm(b)[:n]
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)) and not math.isnan(v):
        return float(v)
    try:
        return float(str(v).replace(",", "."))
    except ValueError:
        return None


def _pick_desc(a: str, b: str) -> str:
    """Longer description wins; if one is a prefix of the other take the longer one; else join when different."""
    na, nb = _norm(a), _norm(b)
    if na in nb:
        return b
    if nb in na:
        return a
    if _similar(a, b, 60) > 0.8:
        return a if len(a) >= len(b) else b
    return a + " " + b


def merge_tiles(results: list[Optional[dict]], tol_top: float = 0.1, tol_bound: float = 0.2) -> tuple[dict, list[str], dict]:
    """Merge TILE_LOG answers (in tile order; None = failed tile) into one page result.
    Returns (merged, issues, stats). stats: overlap_candidates, overlap_matched, overlap_disagreed, tiles_failed."""
    issues: list[str] = []
    stats = {"overlap_candidates": 0, "overlap_matched": 0, "overlap_disagreed": 0, "tiles_failed": 0, "tiles": len(results)}
    merged: dict = {"borehole_name": None, "sheet_no": None, "sheet_total": None, "depth_unit": "unknown",
                    "visible_depth_top": None, "visible_depth_bottom": None, "layers": [], "spt": [], "core_runs": [],
                    "samples": [], "groundwater": [], "terminal_note": None, "total_depth": None}
    units: list[str] = []
    layers: list[dict] = []
    for ti, r in enumerate(results):
        if not r:
            stats["tiles_failed"] += 1
            issues.append(f"tile {ti + 1}/{len(results)} failed")
            continue
        for k in ("borehole_name", "sheet_no", "sheet_total", "terminal_note", "total_depth"):
            if merged[k] in (None, "") and r.get(k) not in (None, ""):
                merged[k] = r[k]
        if r.get("depth_unit") in ("m", "ft"):
            units.append(r["depth_unit"])
        vt, vb = _num(r.get("visible_depth_top")), _num(r.get("visible_depth_bottom"))
        if vt is not None:
            merged["visible_depth_top"] = vt if merged["visible_depth_top"] is None else min(merged["visible_depth_top"], vt)
        if vb is not None:
            merged["visible_depth_bottom"] = vb if merged["visible_depth_bottom"] is None else max(merged["visible_depth_bottom"], vb)
        for lst in ("spt", "core_runs", "samples", "groundwater"):
            merged[lst] += [x for x in (r.get(lst) or []) if isinstance(x, dict)]
        for e in r.get("legend") or []:
            if isinstance(e, dict) and e.get("symbol") and e.get("meaning"):
                merged.setdefault("legend", []).append({"symbol": str(e["symbol"]), "meaning": str(e["meaning"])})
        a = r.get("_anchor")
        if isinstance(a, dict):
            s = merged.setdefault("_anchor_summary", {"fits": 0, "anchored": 0, "rejected": 0, "tiles": 0})
            s["tiles"] += 1
            s["fits"] += 1 if a.get("fit") else 0
            s["anchored"] += a.get("anchored", 0)
            s["rejected"] += a.get("rejected", 0)

        tile_layers = [L for L in (r.get("layers") or []) if isinstance(L, dict)]
        for li, L in enumerate(tile_layers):
            top, bot = _num(L.get("top")), _num(L.get("bottom"))
            desc = str(L.get("description") or "").strip()
            cand = {"top": top, "bottom": bot, "description": desc,
                    "partial_top": bool(L.get("partial_top")), "partial_bottom": bool(L.get("partial_bottom")), "_tile": ti,
                    "_y_top_page": L.get("_y_top_page"), "_y_bottom_page": L.get("_y_bottom_page"), "symbol": L.get("symbol")}
            if ti == 0 or not layers:
                layers.append(cand)
                continue
            # (a) same layer seen again in the overlap? Identity by text first (a tile that misreads its
            # depth scale shifts every boundary, but the words stay the same), then by depth.
            match = None
            for M in layers[-6:]:
                sim = _similar(M["description"], desc)
                if sim > 0.85 and len(_norm(desc)) >= 12:
                    match = M
                    break
                if M["top"] is not None and top is not None and abs(M["top"] - top) <= tol_top and sim > 0.6:
                    match = M
                    break
                if M["top"] is None and top is None and sim > 0.8:
                    match = M
                    break
            if match is not None:
                stats["overlap_candidates"] += 1
                stats["overlap_matched"] += 1
                if match["top"] is not None and top is not None and abs(match["top"] - top) > tol_bound:
                    stats["overlap_disagreed"] += 1
                    issues.append(f"tiles {match['_tile'] + 1}/{ti + 1} disagree on top of '{desc[:30]}': {match['top']} vs {top}")
                    # a shifted re-read: do not let its bottom overwrite a bottom the first tile already had
                    if match["bottom"] is not None and not match["partial_bottom"]:
                        continue
                if match["bottom"] is not None and bot is not None and abs(match["bottom"] - bot) > tol_bound \
                        and not match["partial_bottom"] and not cand["partial_bottom"]:
                    stats["overlap_disagreed"] += 1
                    issues.append(f"tiles {match['_tile'] + 1}/{ti + 1} disagree on bottom of '{desc[:30]}': {match['bottom']} vs {bot}")
                if match["partial_bottom"] or match["bottom"] is None:
                    match["bottom"] = bot if bot is not None else match["bottom"]
                    match["partial_bottom"] = cand["partial_bottom"]
                    if cand.get("_y_bottom_page") is not None:
                        match["_y_bottom_page"] = cand["_y_bottom_page"]
                match["description"] = _pick_desc(match["description"], desc)
                continue
            # (b) continuation of the last layer cut by the tile edge?
            last = layers[-1]
            if li == 0 and (cand["partial_top"] or top is None) and (last["partial_bottom"] or last["bottom"] is None):
                stats["overlap_candidates"] += 1
                stats["overlap_matched"] += 1
                if bot is not None:
                    last["bottom"] = bot
                    if cand.get("_y_bottom_page") is not None:
                        last["_y_bottom_page"] = cand["_y_bottom_page"]
                last["partial_bottom"] = cand["partial_bottom"]
                last["description"] = _pick_desc(last["description"], desc)
                continue
            # (c) an overlap duplicate whose text matches but top differs (model misread a digit)?
            if _similar(last["description"], desc, 60) > 0.85 and top is not None and last["top"] is not None \
                    and abs(last["top"] - top) <= 1.0:
                stats["overlap_candidates"] += 1
                stats["overlap_disagreed"] += 1
                issues.append(f"tiles {last['_tile'] + 1}/{ti + 1} disagree on top of '{desc[:30]}': {last['top']} vs {top}")
                if last["bottom"] is None and bot is not None:
                    last["bottom"] = bot
                continue
            layers.append(cand)
    # fill bottoms from the next top where the model left them open, keep order by top
    for a, b in zip(layers, layers[1:]):
        if a["bottom"] is None and b["top"] is not None:
            a["bottom"] = b["top"]
    merged["layers"] = [{k: v for k, v in L.items() if not k.startswith("_") or k.startswith("_y_")} for L in layers]
    merged["depth_unit"] = max(set(units), key=units.count) if units else "unknown"
    for lst in ("spt", "core_runs", "samples", "groundwater"):
        merged[lst] = _dedupe_points(merged[lst])
    return merged, issues, stats


def _dedupe_points(items: list[dict], tol: float = 0.05) -> list[dict]:
    out: list[dict] = []
    for it in items:
        d = _num(it.get("depth") if "depth" in it else it.get("top") if "top" in it else it.get("depth_from"))
        val = str(it.get("n_value") or it.get("id") or it.get("rqd") or it.get("tcr") or it.get("note") or "")
        dup = False
        for o in out:
            od = _num(o.get("depth") if "depth" in o else o.get("top") if "top" in o else o.get("depth_from"))
            oval = str(o.get("n_value") or o.get("id") or o.get("rqd") or o.get("tcr") or o.get("note") or "")
            if d is not None and od is not None and abs(d - od) <= tol and val == oval:
                dup = True
                break
            if d is None and od is None and val == oval and o == it:
                dup = True
                break
        if not dup:
            out.append(it)
    return out


def merge_spt_tiles(results: list[Optional[dict]]) -> tuple[dict, list[str]]:
    issues: list[str] = []
    merged: dict = {"borehole_name": None, "depth_unit": "unknown", "rows": [], "total_depth": None}
    units: list[str] = []
    for ti, r in enumerate(results):
        if not r:
            issues.append(f"tile {ti + 1}/{len(results)} failed")
            continue
        for k in ("borehole_name", "total_depth"):
            if merged[k] in (None, "") and r.get(k) not in (None, ""):
                merged[k] = r[k]
        if r.get("depth_unit") in ("m", "ft"):
            units.append(r["depth_unit"])
        for row in r.get("rows") or []:
            if not isinstance(row, dict):
                continue
            d = _num(row.get("depth_from"))
            if d is not None and any(_num(x.get("depth_from")) is not None and abs(_num(x["depth_from"]) - d) <= 0.05 for x in merged["rows"]):
                continue
            merged["rows"].append(row)
    merged["rows"].sort(key=lambda x: (_num(x.get("depth_from")) is None, _num(x.get("depth_from")) or 0.0))
    merged["depth_unit"] = max(set(units), key=units.count) if units else "unknown"
    return merged, issues
