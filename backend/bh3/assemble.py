"""Group PageResults into Boreholes, merge metadata, run the text-model normalisation, validate, export.

Grouping uses what the vision model or the header aliases read directly (borehole name, sheet n of m,
depth continuity) – the v1 geometry parser had to infer all of it from the page.
"""
from __future__ import annotations

import logging
import math
import re
from pathlib import Path
from typing import Optional

from .vector.header import _coerce
from .export import write_json, write_xlsx
from .llm import LLM
from .models import Borehole, Layer, Page, Provenance
from .validate import validate

from .inputs import Document
from .reconcile import PageResult

log = logging.getLogger(__name__)

CONTINUED_RE = re.compile(r"\(?\s*continued\s*\)?|\(cont\.?\)|continuación|fortsetzung", re.I)
NOISE_RE = re.compile(r"^(material description|layer description|description of strata|descripción|descripcion|"
                      r"scale\s*1:\d+|see explanatory notes.*|legend)$", re.I)


def _name_key(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    k = re.sub(r"[^A-Za-z0-9]+", "", name).upper()
    return k or None


def _is_header_fragment(text: str) -> bool:
    """A 'layer' consisting only of column-header words (incl. OCR-mangled 'Dascription')."""
    import difflib
    toks = re.findall(r"[A-Za-z\u00C0-\u024F]{2,}", text)
    if not toks or len(toks) > 5:
        return False
    heads = ["description", "descripcion", "descripción", "lithology", "legend", "depth", "sample", "remarks", "strata",
             "naturaleza", "terreno", "del", "material", "layer", "soil", "type", "of", "and", "rock", "classification",
             "beschreibung", "bodenart", "scale", "elevation", "thickness", "symbol", "graphic", "log", "field", "tests"]
    return all(max(difflib.SequenceMatcher(None, t.lower(), h).ratio() for h in heads) > 0.8 for t in toks) \
        and any(difflib.SequenceMatcher(None, t.lower(), h).ratio() > 0.8 for t in toks
                for h in ("description", "descripcion", "descripción", "lithology", "naturaleza", "strata", "beschreibung"))


def _merge_layers(layers: list[Layer]) -> list[Layer]:
    out: list[Layer] = []
    for L in layers:
        if NOISE_RE.match(L.description.strip()) or _is_header_fragment(L.description):
            continue
        if out:
            prev = out[-1]
            same_text = CONTINUED_RE.sub("", L.description).strip().lower()[:60] == prev.description.strip().lower()[:60]
            if CONTINUED_RE.search(L.description) or (same_text and not math.isnan(L.top) and abs(L.top - prev.bottom) < 0.3):
                prev.bottom = L.bottom if not math.isnan(L.bottom) else prev.bottom
                prev.prov.y1 = L.prov.y1
                continue
            # a continuation sheet re-describes an interval already covered by a layer from the previous
            # sheet (thickness column said the layer runs to 18 m, sheet 2 holds the per-metre notes)
            if (not math.isnan(L.top) and not math.isnan(L.bottom) and not math.isnan(prev.top) and not math.isnan(prev.bottom)
                    and L.prov.page != prev.prov.page and L.top >= prev.top - 0.05 and L.bottom <= prev.bottom + 0.05
                    and prev.bottom - prev.top > L.bottom - L.top + 0.05):
                prev.description += " | " + L.description
                continue
        out.append(L)
    return out


# fields the text model may fill from the header text when the aliases / vision header missed them.
# BoreholeDepth is deliberately absent: the model tends to pick any depth-like number from the header
# (AUS01: 16.0 from the elevation column), and validate.py derives the depth from the terminal note /
# last layer bottom, which is far more reliable.
META_KEYS = ["BoreholeName", "LocationName", "StartDate", "EndDate", "ProjectID", "ProjectName", "Surface Elevation",
             "X-Coordinate", "Y-Coordinate", "CoordinateSystem", "Groundwaterlevel"]
CONTINUATION_TEXT_RE = re.compile(r"^\s*(?:strata\s+as\s+(?:previous|above)|as\s+(?:previous|above)\s+(?:page|sheet)?|same\s+as\s+(?:above|previous)|"
                                  r"-+\s*ditto\s*-+|ditto)\b", re.I)


def _first_top(pr: PageResult) -> Optional[float]:
    for L in pr.layers:
        if not math.isnan(L.top):
            return L.top
    for p in pr.points:
        if isinstance(p.depth, float) and not math.isnan(p.depth):
            return p.depth
    return None


def _last_bottom(pr: PageResult) -> Optional[float]:
    bots = [L.bottom for L in pr.layers if not math.isnan(L.bottom)] + \
           [p.depth for p in pr.points if isinstance(p.depth, float) and not math.isnan(p.depth)]
    return max(bots) if bots else None


def group_pages(results: list[PageResult]) -> list[list[PageResult]]:
    groups: list[list[PageResult]] = []
    cur_key: Optional[str] = None
    cur_bottom = 0.0
    cur_xy: Optional[tuple[float, float]] = None
    for pr in results:
        if not pr.is_log:
            continue
        key = _name_key(pr.borehole_name)
        xy = _page_xy(pr)
        top = _first_top(pr)
        starts_at_zero = top is not None and top < 0.5
        new = False
        if not groups:
            new = True
        elif key and cur_key and key != cur_key:
            new = True
        elif not key and xy and cur_xy and xy != cur_xy:
            new = True                      # no usable name, but the page prints other coordinates
        elif not key and xy and cur_xy and xy == cur_xy:
            new = False                     # same printed coordinates as the open hole: a continuation sheet
        elif key and not cur_key and groups[-1] and any(_name_key(p.borehole_name) for p in groups[-1]):
            new = True
        elif pr.sheet_no == 1 and (starts_at_zero or top is None) and (key is None or key == cur_key) and groups[-1]:
            # 'sheet 1 of n' with the same (or no) name after a complete hole → a new hole with the same label
            new = cur_bottom > 0.5
        elif pr.sheet_no is None and starts_at_zero and cur_bottom > 1.0 and not (key and key == cur_key and pr.visible_top not in (None, 0)):
            new = True
        if new:
            groups.append([pr])
            cur_key = key
            cur_xy = xy
            cur_bottom = _last_bottom(pr) or 0.0
        else:
            groups[-1].append(pr)
            if key and not cur_key:
                cur_key = key
            cur_xy = cur_xy or xy
            cur_bottom = max(cur_bottom, _last_bottom(pr) or 0.0)
    return groups


def _page_xy(pr: PageResult) -> Optional[tuple[float, float]]:
    """Printed coordinates of a page, rounded to the metre, when both are present."""
    x, y = pr.header_fields.get("X-Coordinate"), pr.header_fields.get("Y-Coordinate")
    if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not (math.isnan(x) or math.isnan(y)):
        return (round(float(x)), round(float(y)))
    return None


def _carry_across_sheets(group: list[PageResult], issues: list[str]) -> list[Layer]:
    """Continuation sheets: a first stratum cut by the page top continues the previous sheet's open stratum.
    Same text (or a '(continued)' marker, or no own top) → merged into it; different text → the previous
    stratum is closed at the new top so no gap is reported for the page break."""
    import difflib
    out: list[Layer] = []
    prev_pr: Optional[PageResult] = None
    for pr in group:
        page_layers = list(pr.layers)
        if out and page_layers and prev_pr is not None and prev_pr.is_log:
            last, first = out[-1], page_layers[0]
            sim = difflib.SequenceMatcher(None, last.description[:60].lower(), first.description[:60].lower()).ratio()
            cont = bool(re.search(r"continued|cont\.|fortsetzung|continuaci", first.description, re.I))
            open_prev = prev_pr.stats.get("last_partial") or math.isnan(last.bottom)
            cut_first = pr.stats.get("first_partial") or any("top assumed" in n for n in pr.notes)
            if (cut_first or open_prev) and (sim > 0.6 or cont):
                last.bottom = first.bottom if not math.isnan(first.bottom) else last.bottom
                if sim <= 0.6:
                    last.description = (last.description + " " + first.description).strip()
                last.prov.y1 = first.prov.y1 or last.prov.y1
                issues.append(f"p{pr.page_no}: first stratum continues the previous sheet's '{last.description[:30]}'")
                page_layers = page_layers[1:]
            elif (cut_first or open_prev) and not math.isnan(first.top) and (math.isnan(last.bottom) or abs(last.bottom - first.top) <= 1.0):
                last.bottom = first.top
                issues.append(f"p{pr.page_no}: previous sheet's open stratum closed at {first.top} (page break)")
        out += page_layers
        prev_pr = pr
    return out


def build_boreholes(doc: Document, results: list[PageResult], llm: Optional[LLM] = None) -> list[Borehole]:
    boreholes: list[Borehole] = []
    for gi, group in enumerate(group_pages(results)):
        name = next((p.borehole_name for p in group if p.borehole_name), None)
        generated = name is None
        if generated:
            name = f"{doc.doc_id}-BH{gi + 1}"
        bh = Borehole(borehole_id=f"{doc.doc_id}:{name}", source_file=doc.path, pages=[p.page_no for p in group])
        if generated:
            bh.metadata["_name_generated"] = True
        for pr in group:                                   # first page wins, later pages fill gaps
            for k, v in pr.header_fields.items():
                if k not in bh.metadata and v not in (None, ""):
                    bh.metadata[k] = v
                    bh.meta_prov[k] = Provenance(pr.source_file, pr.page_no, method="header-alias" if pr.route == "vector" else "vlm",
                                                 confidence=1.0 if pr.route == "vector" else pr.confidence)
            for k, v in pr.header_extras.items():
                bh.metadata.setdefault("_extra", {}).setdefault(k, v)
            if isinstance(pr.stats.get("legend"), dict) and pr.stats["legend"]:
                bh.metadata.setdefault("_legend", {}).update(pr.stats["legend"])     # symbol -> meaning, read off the page
            if "BoreholeDepth" not in bh.metadata and pr.total_depth is not None:
                bh.metadata["BoreholeDepth"] = pr.total_depth
                bh.meta_prov["BoreholeDepth"] = Provenance(pr.source_file, pr.page_no, method="vlm", confidence=pr.confidence)
        bh.metadata["BoreholeName"] = name
        layers = _carry_across_sheets(group, bh.issues)
        # continuation markers written as text ('strata as previous page', 'as above', 'ditto') behave like
        # the v1 '(continued)' rule: the stratum carries on from the previous page/row
        for L in layers:
            if CONTINUATION_TEXT_RE.search(L.description) and not re.search(r"continued", L.description, re.I):
                L.description = "(continued) " + L.description
        bh.layers = _merge_layers(layers)
        bh.points = [p for pr in group for p in pr.points]
        bh.issues = [f"p{pr.page_no}: {i}" for pr in group for i in pr.issues]
        notes = [f"p{pr.page_no}: {n}" for pr in group for n in pr.notes]
        if notes:
            bh.metadata["_extra"] = bh.metadata.get("_extra", {})
            bh.metadata["_extra"]["PageNotes"] = " | ".join(notes)[:800]
        bh.metadata["_route"] = ",".join(sorted({pr.route for pr in group}))
        bh.metadata["_read_quality"] = ",".join(sorted({pr.read_quality for pr in group if pr.read_quality}))
        if any(pr.depth_unit == "ft" for pr in group):
            bh.metadata["_extra"] = bh.metadata.get("_extra", {})
            bh.metadata["_extra"]["DepthUnitOriginal"] = "ft"
        # text-model header fallback (header text only, never the whole page)
        if llm and llm.cfg.enabled:
            missing = [k for k in META_KEYS if k not in bh.metadata]
            text = "\n".join(pr.header_text for pr in group[:2] if pr.header_text)
            if missing and text.strip():
                for k, v in llm.fill_header(text, missing).items():
                    bh.metadata[k] = _coerce(k, v)
                    bh.meta_prov[k] = Provenance(bh.source_file, group[0].page_no, method="llm", confidence=0.6)
        boreholes.append(bh)
    seen: dict[str, int] = {}
    for bh in boreholes:
        if sum(1 for b in boreholes if b.borehole_id == bh.borehole_id) > 1 or bh.borehole_id in seen:
            bh.borehole_id = f"{bh.borehole_id}@p{bh.pages[0]}"
        seen[bh.borehole_id] = 1
    if llm and llm.cfg.enabled:
        all_layers = [L for bh in boreholes for L in bh.layers]
        for L, r in zip(all_layers, llm.normalise_layers([L.description for L in all_layers])):
            if not r:
                continue
            L.lithology = r.get("lithology") or None
            L.soil_unit = r.get("soil_unit") or None
            L.color = r.get("color") or None
            L.consistency = r.get("consistency") or None
            L.moisture = r.get("moisture") or None
            L.stratigraphic_name = r.get("stratigraphic_name") or None
            L.geologic_age = r.get("geologic_age") or None
            L.is_rock = r.get("is_rock")
            L.norm_confidence = r.get("confidence")
    return boreholes


def pages_for_export(doc: Document, results: list[PageResult]) -> list[Page]:
    """Lightweight Page objects so export can write the Pages sheet."""
    out = []
    for pr in results:
        pg = Page(doc.doc_id, pr.source_file, pr.page_no, 0, 0)
        pg.page_class = pr.page_type
        pg.class_score = pr.confidence if pr.is_log else pr.stats.get("triage_score", 0.0) or 0.0
        pg.has_text_layer = pr.route == "vector"
        pg.features = {"n_words": pr.stats.get("n_words"), "depth_scale_kind": pr.depth_unit if pr.is_log else None,
                       "depth_scale_n": len(pr.layers), "kw_log": pr.stats.get("tiles"), "kw_lab": None, "ocr_conf": None,
                       "route": pr.route, "read_quality": pr.read_quality}
        out.append(pg)
    return out


def finish(docs_results: list[tuple[Document, list[PageResult]]], llm: Optional[LLM], out_dir: Path) -> list[Borehole]:
    all_bh: list[Borehole] = []
    all_pages: list[Page] = []
    notes: dict[str, dict[int, list[str]]] = {}
    for doc, results in docs_results:
        bhs = [validate(b) for b in build_boreholes(doc, results, llm)]
        all_bh += bhs
        all_pages += pages_for_export(doc, results)
        notes[doc.doc_id] = {pr.page_no: pr.notes + pr.issues for pr in results}
    from .site import enrich_objects
    enrich_objects(all_bh)                     # DIN 4023 codes + lat/lon (deterministic, no model)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_xlsx(all_bh, all_pages, notes, out_dir / "boreholes.xlsx")
    write_json(all_bh, out_dir / "boreholes.json")
    return all_bh
