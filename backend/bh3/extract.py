"""Per-page extraction: route, tile, read, anchor, reconcile.

  vector page (usable text layer)  -> bh3.vector (triage -> geometry -> header aliases)        (route "vector")
                                      < 2 layers or parser failure -> vision path             (route "vector->vlm")
  raster page                      -> classify -> (log) tiles -> VLM extract -> merge -> anchor -> reconcile   (route "vlm")
                                               -> (spt_sheet) tiles -> VLM rows -> merge                     (route "vlm-spt")
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import prompts, schemas
from .anchor import anchor_tile, detect_hlines, unanchor
from .classify import _raw_path, _save, classify_page, load_raw
from .inputs import Document, PageSource
from .reconcile import DEPTH_LIMITS, PageResult, reconcile_log, reconcile_spt
from .render import crop_norm, file_sha1, render_page, rotate_upright, vector_words
from .schemas import PROMPT_VERSION
from .tiles import TileSpec, merge_spt_tiles, merge_tiles, plan_tiles, render_tile
from .vector import parse_vector_page, vector_ok
from .vlm import VLM

log = logging.getLogger(__name__)


@dataclass
class RouteConfig:
    dpi: int = int(os.environ.get("BH_VLM_DPI", "200"))           # render resolution for extraction tiles
    classify_dpi: int = 72                                         # A4 → 842 px long side; enough for layout
    tile_px: int = int(os.environ.get("BH_VLM_TILE_PX", "1540"))   # long-side cap measured on the backend
    overlap: float = 0.15
    max_rows_per_tile: int = 15
    preprocess: str = "auto"                                       # auto | always | never
    resume: bool = True
    no_vector: bool = False                                        # force everything through the vision path
    no_vlm: bool = False                                           # deterministic only (vector pages; raster pages unread)
    anchor: bool = os.environ.get("BH_VLM_ANCHOR", "1") != "0"      # grid overlay + line snapping for depths
    symbols: str = os.environ.get("BH_VLM_SYMBOLS", "auto")        # auto | always | never: hatch symbols + legend read (separate schema / cache key)
    anchor_max_shift: float = float(os.environ.get("BH_ANCHOR_MAX_SHIFT", "0.75"))      # m, boundaries
    anchor_point_shift: float = float(os.environ.get("BH_ANCHOR_POINT_SHIFT", "0.3"))   # m, SPT/samples (measured best)
    anchor_require_snap: bool = os.environ.get("BH_ANCHOR_REQUIRE_SNAP", "1") != "0"



def text_transcript(page, y0_pt: float, y1_pt: float, max_lines: int = 140, max_chars: int = 7000) -> str:
    """The page's embedded text (vector pages only) for a y-range, one line per text row with its page row.
    Lets the vision model spell descriptions and read numbers from exact text while positions still come
    from the picture."""
    if page is None or not page.words:
        return ""
    lines = []
    for ln in page.lines_of_text(ytol=3.0):
        yc = sum(w.yc for w in ln) / len(ln)
        if y0_pt - 6 <= yc <= y1_pt + 6:
            lines.append((yc, " ".join(w.text for w in sorted(ln, key=lambda w: w.x0))))
    if not lines:
        return ""
    if len(lines) > max_lines:
        step = len(lines) / max_lines
        lines = [lines[int(i * step)] for i in range(max_lines)]
    out, n = [], 0
    for yc, t in lines:
        row = f"y={yc:.0f}: {t[:220]}"
        if n + len(row) > max_chars:
            break
        out.append(row); n += len(row) + 1
    return "\n".join(out)


def _extract_tiles(src: PageSource, vlm: VLM, cfg: RouteConfig, workdir: Path, cl: dict, rot: int, raw: dict,
                   kind: str, page=None, symbols: bool = False) -> tuple[list[Optional[dict]], list[str], list[TileSpec]]:
    from PIL import Image
    pre = cfg.preprocess == "always" or (cfg.preprocess == "auto" and cl.get("read_quality") in ("faded", "photo"))
    img = render_page(src, cfg.dpi, workdir, preprocess=pre)
    if rot:
        img, _ = rotate_upright(img)
    W, H = Image.open(img).size
    specs = plan_tiles((W, H), cl.get("table_body"), cl.get("column_header_band"), tile_px=cfg.tile_px,
                       overlap=cfg.overlap, rows_estimate=cl.get("rows_estimate"), max_rows_per_tile=cfg.max_rows_per_tile)
    hint = (f"page of a {('blow-count sheet' if kind == 'spt' else 'borehole log')} in language '{cl.get('language')}', "
            f"depth unit {cl.get('depth_unit')}, about {cl.get('rows_estimate')} rows on the whole page; "
            f"this image is part {{i}} of {len(specs)} from top to bottom")
    tdir = workdir / "tiles" / file_sha1(src.source_file)
    use_grid = cfg.anchor and kind == "log"
    geom = hashlib.sha1(json.dumps([[s.body_px, s.header_px] for s in specs]).encode()).hexdigest()[:8]
    use_text = page is not None and bool(page.words) and rot == 0 and os.environ.get("BH_VLM_TRANSCRIPT", "1") != "0"
    key = f"tiles_{kind}_{cfg.dpi}_{cfg.tile_px}_{PROMPT_VERSION}_{geom}{'_pp' if pre else ''}{'_g' if (cfg.anchor and kind == 'log') else ''}{'_t' if use_text else ''}{'_s' if (symbols and kind == 'log') else ''}"
    def _apply_anchor(results: list) -> list:
        """Anchoring is post-processing on the stored model answer: undo any earlier application, then apply
        the current gate. Tiles must have been rendered (for the ruling lines) – render_tile is cached."""
        if kind != "log":
            return results
        to_pt = 72.0 / cfg.dpi
        for spec, out in zip(specs, results):
            if not isinstance(out, dict):
                continue
            unanchor(out)
            tp = render_tile(img, spec, tdir / f"p{src.page_no:03d}_{cfg.dpi}_t{spec.index}of{spec.n_tiles}{'_pp' if pre else ''}{'_g' if use_grid else ''}.jpg",
                             max_side=cfg.tile_px, grid=use_grid)
            if cfg.anchor and use_grid:
                hl = detect_hlines(tp.with_name(tp.stem + "_raw.jpg"))
                out, st = anchor_tile(out, hl, max_shift=cfg.anchor_max_shift, require_snap=cfg.anchor_require_snap,
                                      point_max_shift=cfg.anchor_point_shift)
                out["_anchor"] = st
            for L in out.get("layers") or []:
                if isinstance(L, dict):
                    for pkey, ykey in (("_y_top_page", "y_grid_top"), ("_y_bottom_page", "y_grid_bottom")):
                        y = L.get(ykey)
                        L[pkey] = round(spec.page_y(float(y)) * to_pt, 1) if isinstance(y, (int, float)) else None
        return results

    if key in raw and len(raw[key]) == len(specs):
        return _apply_anchor(raw[key]), raw.get(key + "_issues", []), specs

    def one(spec: TileSpec) -> Optional[dict]:
        tp = render_tile(img, spec, tdir / f"p{src.page_no:03d}_{cfg.dpi}_t{spec.index}of{spec.n_tiles}{'_pp' if pre else ''}{'_g' if use_grid else ''}.jpg",
                         max_side=cfg.tile_px, grid=use_grid)
        h = hint.replace("{i}", str(spec.index + 1))
        if use_text:
            to_pt = 72.0 / cfg.dpi
            y0 = (spec.header_px[1] if (spec.header_px and spec.is_first) else spec.body_px[1]) * to_pt
            tr = text_transcript(page, y0, spec.body_px[3] * to_pt)
            if tr:
                h += ("\nThis page has an exact embedded text layer. Below is every text row inside this image, "
                      "as 'y=<page row>: <text>' (y is a page coordinate, NOT a depth). Spell descriptions and read "
                      "every number from these lines; take positions and the depth scale from the picture.\n" + tr)
        out, meta = vlm.tile_spt(tp, h) if kind == "spt" else vlm.tile_log(tp, h, symbols=symbols)
        if out is None and meta.get("truncated"):
            # too many rows for one answer: split this tile in two and merge the halves
            x0, y0, x1, y1 = spec.body_px
            mid = (y0 + y1) // 2
            ov = int((y1 - y0) * 0.1)
            halves = [TileSpec(spec.index, (x0, y0, x1, mid + ov), spec.header_px, spec.n_tiles),
                      TileSpec(spec.index, (x0, mid - ov, x1, y1), spec.header_px, spec.n_tiles)]
            outs = []
            for j, hs in enumerate(halves):
                hp = render_tile(img, hs, tdir / f"p{src.page_no:03d}_{cfg.dpi}_t{spec.index}of{spec.n_tiles}_h{j}.jpg", max_side=cfg.tile_px)
                o, _ = vlm.tile_spt(hp, h) if kind == "spt" else vlm.tile_log(hp, h, symbols=symbols)
                outs.append(o)
            if kind == "spt":
                merged, _ = merge_spt_tiles(outs)
            else:
                merged, _, _ = merge_tiles(outs)
            return merged if any(o is not None for o in outs) else None
        return out

    results = vlm.map(one, specs)
    raw[key] = results
    return _apply_anchor(results), [], specs


def _header(src: PageSource, vlm: VLM, cfg: RouteConfig, workdir: Path, cl: dict, rot: int, raw: dict, page=None) -> Optional[dict]:
    if "header" in raw:
        return raw["header"]
    img = render_page(src, cfg.dpi, workdir)
    if rot:
        img, _ = rotate_upright(img)
    hb = cl.get("header_band")
    if not hb or len(hb) != 4 or hb[3] - hb[1] < 0.02:
        hb = (0.0, 0.0, 1.0, 0.3)
    # a header crop cut flat gets downscaled wastefully; give it the full table width and a bit of margin
    crop = crop_norm(img, (0.0, hb[1], 1.0, hb[3]), workdir / "tiles" / file_sha1(src.source_file) / f"p{src.page_no:03d}_header.jpg", pad=0.02)
    hint = ""
    if page is not None and page.words and rot == 0:
        from PIL import Image
        H = Image.open(img).size[1]
        tr = text_transcript(page, hb[1] * H * 72.0 / cfg.dpi, hb[3] * H * 72.0 / cfg.dpi, max_lines=60, max_chars=4000)
        if tr:
            hint = ("\nExact embedded text of this header region ('y=<page row>: <text>'); copy values from it:\n" + tr)
    out, _meta = vlm.call(crop, prompts.SYSTEM_HEADER, prompts.USER_HEADER + hint, schemas.HEADER_SCHEMA, "header", max_tokens=1200)
    raw["header"] = out
    return out


def _needs_symbols(merged: dict, cl: dict) -> bool:
    layers = merged.get("layers") or []
    if not layers:
        return (cl.get("rows_estimate") or 0) > 0
    return any(not str(L.get("description") or "").strip() for L in layers)


def _copy_symbols(plain: dict, sym: dict) -> dict:
    """Copy `symbol` from the symbol read onto the matching layers of the plain read (same depths within 0.15 m
    or the same words), plus the page legend. Returns counts."""
    import difflib
    st = {"matched": 0, "unmatched_plain": 0, "symbol_only_in_second_read": 0}
    sl = [L for L in (sym.get("layers") or []) if isinstance(L, dict)]
    used: set[int] = set()
    for P in plain.get("layers") or []:
        best = None
        for i, S in enumerate(sl):
            if i in used or not S.get("symbol"):
                continue
            same_depth = (P.get("top") is not None and S.get("top") is not None and abs(P["top"] - S["top"]) <= 0.15
                          and (P.get("bottom") is None or S.get("bottom") is None or abs(P["bottom"] - S["bottom"]) <= 0.15))
            pd, sd = str(P.get("description") or "").lower()[:60], str(S.get("description") or "").lower()[:60]
            same_text = bool(pd) and difflib.SequenceMatcher(None, pd, sd).ratio() > 0.85
            if same_depth or same_text:
                best = i
                break
        if best is None:
            st["unmatched_plain"] += 1
            continue
        used.add(best)
        P["symbol"] = sl[best]["symbol"]
        st["matched"] += 1
    st["symbol_only_in_second_read"] = sum(1 for i, S in enumerate(sl) if i not in used and not str(S.get("description") or "").strip() and S.get("symbol"))
    if sym.get("legend"):
        plain["legend"] = sym["legend"]
    return st


def _vision_result(src: PageSource, vlm: VLM, cfg: RouteConfig, workdir: Path, route: str, page=None) -> PageResult:
    rp = _raw_path(src, workdir)
    raw = load_raw(rp, cfg.resume)
    if not vlm.enabled:
        pr = PageResult(src.source_file, src.page_no, route, page_type="unread", read_quality="")
        pr.issues.append("raster page not read (vision model disabled)")
        return pr
    cl, cimg, rot = classify_page(src, vlm, cfg.classify_dpi, workdir, raw)
    if cl is None:
        pr = PageResult(src.source_file, src.page_no, route, page_type="unread")
        pr.issues.append("classification call failed")
        _save(rp, raw)
        return pr
    ptype = cl.get("page_type", "other")
    if ptype == "log":
        results, tissues, specs = _extract_tiles(src, vlm, cfg, workdir, cl, rot, raw, "log", page=page)
        merged, issues, stats = merge_tiles(results)
        if not merged["layers"] and (cl.get("rows_estimate") or 0) > 0 and any(r is not None for r in results):
            # the page shows strata but the read came back empty: one more try with a different tiling
            import dataclasses
            cfg2 = dataclasses.replace(cfg, tile_px=int(cfg.tile_px * 1.3), overlap=0.25)
            log.info("%s: no layers read – re-reading with shifted tiles", src.label)
            results2, tissues2, specs2 = _extract_tiles(src, vlm, cfg2, workdir, cl, rot, raw, "log", page=page)
            merged2, issues2, stats2 = merge_tiles(results2)
            if merged2["layers"]:
                merged, issues, stats, specs = merged2, issues2 + ["layers from a second, shifted read"], stats2, specs2
        if cfg.symbols == "always" or (cfg.symbols == "auto" and _needs_symbols(merged, cl)):
            # strata drawn rather than written: a second read that names the hatch of every stratum and the
            # legend; the plain read stays authoritative, only `symbol` / `legend` are copied onto its layers
            log.info("%s: strata without words – reading the symbol column", src.label)
            results_s, _, _ = _extract_tiles(src, vlm, cfg, workdir, cl, rot, raw, "log", page=page, symbols=True)
            merged_s, _, _ = merge_tiles(results_s)
            stats["symbols"] = _copy_symbols(merged, merged_s)
        hdr = _header(src, vlm, cfg, workdir, cl, rot, raw, page=page)
        pr = reconcile_log(merged, src.source_file, src.page_no, cl, hdr, issues + tissues, stats, route=route)
        pr.stats["tiles"] = len(specs)
    elif ptype == "spt_sheet":
        results, tissues, specs = _extract_tiles(src, vlm, cfg, workdir, cl, rot, raw, "spt")
        merged, issues = merge_spt_tiles(results)
        hdr = _header(src, vlm, cfg, workdir, cl, rot, raw)
        pr = reconcile_spt(merged, src.source_file, src.page_no, cl, hdr, issues + tissues)
        pr.route = route if route != "vlm" else "vlm-spt"
        pr.stats["tiles"] = len(specs)
    else:
        pr = PageResult(src.source_file, src.page_no, route, page_type=ptype, read_quality=cl.get("read_quality", ""),
                        language=cl.get("language", ""), depth_unit=cl.get("depth_unit", "unknown"))
        pr.stats = {"names": cl.get("borehole_names_visible") or []}
    if rot:
        pr.notes.append(f"page rotated {rot}° before reading")
    if cl.get("notes"):
        pr.notes.append(f"classifier: {cl['notes']}")
    _save(rp, raw)
    return pr



DOC_RULES_FILE = Path(__file__).with_name("doc_rules.json")


def _doc_rules(source_file: str) -> dict:
    try:
        rules = json.loads(DOC_RULES_FILE.read_text(encoding="utf-8")) if DOC_RULES_FILE.exists() else {}
    except json.JSONDecodeError:
        return {}
    return rules.get(Path(source_file).name) or {}


def _apply_doc_rules(pr: PageResult, src: PageSource, page) -> PageResult:
    """Document-specific name rule (doc_rules.json) on the page's embedded text when no usable name was read."""
    from .reconcile import clean_name
    rule = _doc_rules(src.source_file).get("name_regex")
    if not rule or page is None or not page.words or not pr.is_log:
        return pr
    if pr.borehole_name and clean_name(pr.borehole_name):
        return pr
    text = page.text
    if src.kind == "pdf":                      # reading-order text (labels next to their values), not x/y-sorted words
        try:
            from .render import _open_pdf
            text = _open_pdf(src.pdf_path)[src.pdf_index].get_text()
        except Exception:  # noqa: BLE001
            pass
    m = re.search(rule, text)
    if m:
        name = next((g for g in m.groups() if g), None)
        if name:
            pr.borehole_name = name
            pr.header_fields.setdefault("BoreholeName", name)
            pr.notes.append(f"name '{name}' from the document rule")
    return pr


def process_page(src: PageSource, vlm: VLM, cfg: RouteConfig, workdir: Path) -> PageResult:
    page = None if cfg.no_vector else vector_words(src)
    if page is not None and page.has_text_layer:
        pr = parse_vector_page(src, page)
        if pr is not None and (pr.page_type != "log" or vector_ok(pr)):
            pr.stats["route_reason"] = "text layer"
            return _apply_doc_rules(pr, src, page)
        log.info("%s: geometry parse weak (%s) → vision path", src.label, "; ".join(pr.notes[:3]) if pr else "no result")
        vr = _vision_result(src, vlm, cfg, workdir, "vector→vlm", page=page)
        if pr is not None and pr.header_fields and vr.is_log:
            # alias-extracted header text is exact: it wins over the model's reading
            for k, v in pr.header_fields.items():
                lim = DEPTH_LIMITS.get(k)
                if lim and isinstance(v, (int, float)) and not (lim[0] <= v <= lim[1]):
                    continue                    # pipeline 1 read an axis label as a depth
                vr.header_fields.setdefault(k, v)
            for k, v in pr.header_extras.items():
                vr.header_extras.setdefault(k, v)
            vr.header_text = pr.header_text or vr.header_text
            if vr.borehole_name is None:
                vr.borehole_name = pr.borehole_name
        return _apply_doc_rules(vr, src, page)
    if cfg.no_vlm:
        pr = PageResult(src.source_file, src.page_no, "vlm", page_type="unread")
        pr.issues.append("raster page not read (vision model disabled)")
        return pr
    return _vision_result(src, vlm, cfg, workdir, "vlm")


def process_document(doc: Document, vlm: VLM, cfg: RouteConfig, workdir: Path, pages: Optional[set[int]] = None,
                     max_pages: Optional[int] = None) -> list[PageResult]:
    out: list[PageResult] = []
    srcs = [p for p in doc.pages if not pages or p.page_no in pages]
    if max_pages:
        srcs = srcs[:max_pages]
    for i, src in enumerate(srcs):
        pr = process_page(src, vlm, cfg, workdir)
        out.append(pr)
        log.info("%s [%d/%d]: route=%s type=%s layers=%d points=%d conf=%.2f %s", src.label, i + 1, len(srcs), pr.route,
                 pr.page_type, len(pr.layers), len(pr.points), pr.confidence, ("issues=" + str(len(pr.issues))) if pr.issues else "")
    # document-level smoothing: a 'photo/other' page between two log pages that names a borehole is a log
    for i in range(1, len(out) - 1):
        a, b, c = out[i - 1], out[i], out[i + 1]
        if b.route == "vlm" and b.page_type in ("photo", "other", "plot") and a.is_log and c.is_log and b.stats.get("names"):
            log.info("%s: re-reading as log (between two log pages, names visible)", srcs[i].label)
            rp = _raw_path(srcs[i], workdir)
            raw = json.loads(rp.read_text(encoding="utf-8")) if rp.exists() else {}
            if raw.get("classify"):
                raw["classify"]["page_type"] = "log"
                _save(rp, raw)
                out[i] = _vision_result(srcs[i], vlm, cfg, workdir, "vlm")
                out[i].notes.append("re-classified as log by document context")
    return out
