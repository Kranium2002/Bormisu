"""Turn merged vision answers into Layer / PointValue objects, with hard checks and a check-derived confidence.

Nothing is silently fixed: every violated rule becomes an issue string that travels with the borehole into
`validate.py` and the Issues sheet. Confidence is computed from those checks (plus read quality and tile
agreement), never from anything the model says about itself.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from .vector.header import _coerce
from .vector.header import EXTRA_FIELDS, NUMERIC_FIELDS
from .models import Layer, PointValue, Provenance

FT = 0.3048
METHOD = "vlm"


@dataclass
class PageResult:
    source_file: str
    page_no: int
    route: str                                 # "vlm" | "vlm-spt" | "vector" | "vector→vlm"
    page_type: str = "log"
    read_quality: str = "clean"
    language: str = ""
    depth_unit: str = "unknown"
    borehole_name: Optional[str] = None
    sheet_no: Optional[int] = None
    sheet_total: Optional[int] = None
    total_depth: Optional[float] = None
    visible_top: Optional[float] = None
    visible_bottom: Optional[float] = None
    layers: list[Layer] = field(default_factory=list)
    points: list[PointValue] = field(default_factory=list)
    header_fields: dict[str, Any] = field(default_factory=dict)
    header_extras: dict[str, str] = field(default_factory=dict)
    header_text: str = ""
    issues: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    confidence: float = 0.0
    stats: dict[str, Any] = field(default_factory=dict)

    @property
    def is_log(self) -> bool:
        return self.page_type in ("log", "spt_sheet")


def _num(v) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return None if math.isnan(v) else float(v)
    m = re.search(r"[-+]?\d+(?:[.,]\d+)?", str(v))
    return float(m.group(0).replace(",", ".")) if m else None


def _spt_value(n: Optional[str]) -> Any:
    """'12' → 12.0 ; 'R', '50/3', '>50' → kept as string label."""
    if n is None:
        return None
    s = str(n).strip()
    if re.fullmatch(r"\d{1,3}", s):
        return float(s)
    return s or None


# --- generic sanity rules (no templates) -------------------------------------
NAME_ID_RE = re.compile(r"\b((?:[A-Za-z]{1,6}[-_ .]?)?\d{1,4}[A-Za-z]?(?:[-_/.]\d{1,3})?)\b")
NAME_BAD_RE = re.compile(r"drilling|contractor|consult|associates|ltd|inc\b|gmbh|\.gpj|\.gdt|\.gpj|project no|job no|sheet|page|log \d|\d{1,2}/\d{1,2}/\d{2,4}|"
                         r"\bDVR\s*90\b|\bNN\b|\bNAP\b|\bAHD\b|\bdatum\b|\blevel\b|\bkote\b|\bniveau\b|m\s*ü\.?\s*NN|\bm\s*a\.?s\.?l\b|\bGeoido\b", re.I)
NAME_DISCARD_RE = re.compile(r"\bDVR\s*90\b|\bNAP\b|\bAHD\b|\bdatum\b|\bkote\b|\bniveau\b|m\s*ü\.?\s*NN|\bm\s*a\.?s\.?l\b|\bGeoido\b|\bNN\s*[+-]?\d", re.I)
# label words printed in front of the identifier: "BORING NO. T01", "Borehole: S2", "Sondeo Nº 3"
NAME_LABEL_RE = re.compile(r"(?:^|\b)(?:boring\s*n[or]?\.?|bore\s?hole\s*(?:no|id|ref)?\.?|boring|hole\s*(?:no|id)\.?|bh\s*no\.?|test\s*pit|sondeo|sondaje|sondagem|furo|bohrung|bohrloch|well|location|punto)"
                           r"\s*(?:nº|n°|#|n[or]\.?|id|ref)?\s*[:.\-]?\s*", re.I)
# remarks: ellipsis / dash prefixed lines and "Xm: to Ym:" sub-interval notes. NOT "Grades ..." / "with ...":
# those are how many logs (Sematco, Golder) write a genuine sub-stratum cell.
REMARK_RE = re.compile(r"^\s*(?:\.{2,}|…|-\s|–\s)|^\s*\d{1,3}(?:[.,]\d{1,2})?\s*m?\s*:\s*to\b", re.I)
LABEL_RE = re.compile(r"^\s*(?:CR|CB|RUN|RC)\s*\d{1,3}\b|^\s*\d{1,3}\s*mins?\s*$|^\s*[A-Z]{1,3}\d{1,3}\s*(?:N\s*=\s*\d+)?\s*$", re.I)
DEPTH_LIMITS = {"BoreholeDepth": (0.05, 500.0), "Groundwaterlevel": (-1.0, 300.0), "Surface Elevation": (-500.0, 9000.0)}


def clean_name(*cands: Optional[str]) -> Optional[str]:
    """Pick a plausible hole identifier out of the candidates (header name, tile name): short, carries a
    number, no contractor / file / footer words. Long strings are reduced to the identifier they contain,
    preferring letter-prefixed ids (BH07-1) over bare numbers."""
    best: Optional[str] = None
    for c in cands:
        if not c:
            continue
        s = re.sub(r"\s+", " ", str(c)).strip(" :-–")
        if not s:
            continue
        if NAME_DISCARD_RE.search(s):
            continue                        # a datum / level string ("DVR90 +5.3", "292,00 m ü. NN") is never a name
        if NAME_LABEL_RE.search(s):
            # keep what follows the last label word ("1241009C Borehole: S2" -> "S2", "BORING NO. T01 Damhus" -> "T01 Damhus")
            s = NAME_LABEL_RE.split(s)[-1].strip(" :-–") or s
            first = s.split(" ")[0]
            if re.search(r"\d", first):
                s = first                   # "T01 Damhus" -> "T01"
        if len(s) <= 20 and re.search(r"\d", s) and not NAME_BAD_RE.search(s):
            return s
        ids = [m.group(1).strip() for m in NAME_ID_RE.finditer(s)]
        ids = [i for i in ids if not NAME_BAD_RE.search(i) and not re.fullmatch(r"\d{1,2}", i)]
        if ids:
            ids.sort(key=lambda i: (0 if re.match(r"^[A-Za-z]{1,6}[-_ .]?\d", i) else 1 if re.search(r"[A-Za-z]", i) else 2))
            best = best or ids[0]
        elif len(s) <= 20 and not NAME_BAD_RE.search(s):
            best = best or s
    return best


CONSISTENCY_ONLY_RE = re.compile(r"^\s*(?:v\.?\s*|very\s+|m\.?\s*|medium\s+|extremely\s+|slightly\s+)?"
                                 r"(?:loose|dense|soft|firm|stiff|hard|compact|weak|strong|moist|wet|dry|saturated)\s*\.?\s*$", re.I)


def _is_remark(desc: str) -> bool:
    return bool(REMARK_RE.search(desc))


def _is_consistency_only(desc: str) -> bool:
    """'M. Dense', 'Dense', 'Very stiff' alone: a cell from the consistency/density column, not a stratum."""
    return bool(CONSISTENCY_ONLY_RE.match(desc))


def _is_label(desc: str) -> bool:
    return bool(LABEL_RE.search(desc)) and len(desc) < 40


# ---------------------------------------------------------------------------
# log pages
# ---------------------------------------------------------------------------

def reconcile_log(merged: dict, source_file: str, page_no: int, classify: Optional[dict] = None,
                  header: Optional[dict] = None, tile_issues: Optional[list[str]] = None,
                  tile_stats: Optional[dict] = None, route: str = "vlm") -> PageResult:
    cl = classify or {}
    pr = PageResult(source_file, page_no, route, page_type=cl.get("page_type", "log"),
                    read_quality=cl.get("read_quality", "clean"), language=cl.get("language", ""))
    unit = merged.get("depth_unit") if merged.get("depth_unit") in ("m", "ft") else cl.get("depth_unit", "unknown")
    pr.depth_unit = unit or "unknown"
    if merged.get("legend"):
        pr.stats["legend"] = {str(e["symbol"]).strip().lower(): str(e["meaning"]).strip() for e in merged["legend"]
                              if isinstance(e, dict) and e.get("symbol") and e.get("meaning")}
    k = FT if pr.depth_unit == "ft" else 1.0
    if k != 1.0:
        pr.notes.append("depths converted from feet to metres")

    def conv(v) -> float:
        n = _num(v)
        return float("nan") if n is None else round(n * k, 3)

    pr.borehole_name = clean_name((header or {}).get("BoreholeName"), merged.get("borehole_name"))
    pr.sheet_no = merged.get("sheet_no") if isinstance(merged.get("sheet_no"), int) else None
    pr.sheet_total = merged.get("sheet_total") if isinstance(merged.get("sheet_total"), int) else None
    td = _num(merged.get("total_depth"))
    pr.total_depth = round(td * k, 3) if td is not None and 0.05 <= td * k <= 500 else None
    vt, vb = _num(merged.get("visible_depth_top")), _num(merged.get("visible_depth_bottom"))
    pr.visible_top = vt * k if vt is not None else None
    pr.visible_bottom = vb * k if vb is not None else None
    if merged.get("terminal_note"):
        pr.notes.append(str(merged["terminal_note"]))

    failed: set[str] = set()
    prov = lambda conf: Provenance(source_file, page_no, method=METHOD, confidence=conf)

    # layers
    raw = [L for L in merged.get("layers") or [] if isinstance(L, dict)]
    if raw:
        pr.stats["first_partial"] = bool(raw[0].get("partial_top")) or _num(raw[0].get("top")) is None
        pr.stats["last_partial"] = bool(raw[-1].get("partial_bottom")) or _num(raw[-1].get("bottom")) is None
    # an elevation / reduced-level scale read as depth: tops strictly decreasing down the page
    tops_raw = [_num(L.get("top")) for L in raw]
    tops_known = [t for t in tops_raw if t is not None]
    if len(tops_known) >= 3 and all(b < a for a, b in zip(tops_known, tops_known[1:])):
        gl = _num((header or {}).get("Surface Elevation"))
        if gl is not None:
            for L in raw:
                for key in ("top", "bottom"):
                    v = _num(L.get(key))
                    if v is not None:
                        L[key] = round(gl - v, 3)
            pr.issues.append(f"depths were read from the elevation scale – converted with ground level {gl}")
            failed.add("elevation-scale")
        else:
            pr.issues.append("depths decrease down the page (elevation scale read as depth?) – check")
            failed.add("elevation-scale")
    layers: list[Layer] = []
    n_remarks = n_labels = 0
    for L in raw:
        desc = re.sub(r"\s+", " ", str(L.get("description") or "")).strip()
        top, bot = conv(L.get("top")), conv(L.get("bottom"))
        if not desc and math.isnan(top) and math.isnan(bot) and not L.get("symbol"):
            continue
        if _is_label(desc):
            n_labels += 1
            pr.notes.append(f"dropped label read as stratum: {desc[:40]!r}")
            continue
        if layers and (_is_remark(desc) or _is_consistency_only(desc)):
            # a remark inside the enclosing stratum, or a lone consistency cell: keep the words, not the boundary
            prev = layers[-1]
            prev.description = (prev.description + (" " if _is_remark(desc) else " [" ) + desc + ("" if _is_remark(desc) else "]")).strip()
            if not math.isnan(bot) and (math.isnan(prev.bottom) or bot > prev.bottom):
                prev.bottom = bot
            n_remarks += 1
            continue
        lay = Layer(top, bot, desc, prov(0.0))
        if L.get("symbol") and str(L["symbol"]).strip().lower() not in ("", "blank", "none", "null"):
            lay.symbol = str(L["symbol"]).strip()
        if isinstance(L.get("_y_top_page"), (int, float)):
            lay.prov.y0 = float(L["_y_top_page"])
        if isinstance(L.get("_y_bottom_page"), (int, float)):
            lay.prov.y1 = float(L["_y_bottom_page"])
        layers.append(lay)
    if n_remarks:
        pr.notes.append(f"{n_remarks} remark line(s) merged into their stratum")
    # fill missing tops/bottoms from neighbours in the model's order (first layer: visible top or 0)
    for i, L in enumerate(layers):
        if math.isnan(L.top):
            if i == 0:
                L.top = pr.visible_top if pr.visible_top is not None else 0.0
                pr.notes.append(f"layer 1: top assumed {L.top}")
            elif not math.isnan(layers[i - 1].bottom):
                L.top = layers[i - 1].bottom
        if math.isnan(L.bottom) and i + 1 < len(layers) and not math.isnan(layers[i + 1].top):
            L.bottom = layers[i + 1].top
    # sort by top (nan last, keep original order among nan)
    order = sorted(range(len(layers)), key=lambda i: (math.isnan(layers[i].top), layers[i].top if not math.isnan(layers[i].top) else 0.0, i))
    if order != list(range(len(layers))):
        pr.issues.append("layers were not in depth order – re-sorted")
        failed.add("order")
    layers = [layers[i] for i in order]
    for i in range(1, len(layers)):
        a, b = layers[i - 1], layers[i]
        if not math.isnan(a.bottom) and not math.isnan(b.top) and b.top < a.bottom - 0.1:
            pr.issues.append(f"layers {i} and {i + 1} overlap by {a.bottom - b.top:.2f} m")
            failed.add("overlap")
    for i, L in enumerate(layers):
        if not math.isnan(L.top) and not math.isnan(L.bottom) and L.bottom < L.top:
            pr.issues.append(f"layer {i + 1}: bottom {L.bottom} above top {L.top}")
            failed.add("inverted")
        if pr.total_depth is not None and not math.isnan(L.bottom) and L.bottom > pr.total_depth + 0.5:
            pr.issues.append(f"layer {i + 1}: bottom {L.bottom} below total depth {pr.total_depth}")
            failed.add("below-total")
        if pr.visible_bottom is not None and not math.isnan(L.top) and L.top > pr.visible_bottom + 0.5:
            pr.issues.append(f"layer {i + 1}: top {L.top} outside the visible depth range (≤{pr.visible_bottom})")
            failed.add("outside-visible")
        if not math.isnan(L.top) and not math.isnan(L.bottom) and L.bottom - L.top > 40:
            pr.issues.append(f"layer {i + 1}: thickness {L.bottom - L.top:.1f} m implausible — check")
            failed.add("thick")
    pr.layers = layers

    # points
    pts: list[PointValue] = []
    for s in merged.get("spt") or []:
        if not isinstance(s, dict):
            continue
        d = conv(s.get("depth"))
        if math.isnan(d):
            continue
        dt = _num(s.get("depth_to"))
        val = _spt_value(s.get("n_value"))
        blows = [int(x) for x in re.findall(r"\d+", str(s.get("blows") or ""))]
        if val is None and not blows:
            continue                                    # a marker without any value carries no information
        if len(blows) >= 3 and isinstance(val, float) and abs(val - sum(blows[-2:])) > 0.5 and val <= max(blows[-2:]) + 0.5:
            # N must be the sum of the last two increments; the model copied one increment instead
            fixed = float(sum(blows[-2:]))
            pr.notes.append(f"SPT at {d}: N {val:g} replaced by {fixed:g} = sum of increments {blows[-2:]}")
            val = fixed
            failed.add("spt-n-fixed")
        elif val is None and len(blows) >= 2:
            val = float(sum(blows[-2:]))
        label = " ".join(x for x in (str(s.get("n_value") or ""), f"[{s['blows']}]" if s.get("blows") else "") if x).strip() or None
        if isinstance(val, float) and not (0 <= val <= 150):
            pr.issues.append(f"SPT {val:g} at {d} out of range")
            failed.add("spt-range")
        pts.append(PointValue("SPT", d, val, prov(0.0), depth_to=round(dt * k, 3) if dt is not None else None, label=label))
    for c in merged.get("core_runs") or []:
        if not isinstance(c, dict):
            continue
        t, b = _num(c.get("top")), _num(c.get("bottom"))
        if t is None and b is None:
            continue
        d = round((t if t is not None else b) * k, 3)
        dt = round(b * k, 3) if (b is not None and t is not None) else None
        for kind in ("tcr", "rqd"):
            v = _num(c.get(kind))
            if v is None:
                continue
            if not (0 <= v <= 100):
                pr.issues.append(f"{kind.upper()} {v:g} at {d} out of range")
                failed.add("core-range")
            pts.append(PointValue(kind.upper(), d, v, prov(0.0), depth_to=dt))
    for s in merged.get("samples") or []:
        if not isinstance(s, dict):
            continue
        d = _num(s.get("depth"))
        if d is None:
            continue
        dt = _num(s.get("depth_to"))
        sid = s.get("id") or s.get("type")
        pts.append(PointValue("SAMPLE", round(d * k, 3), sid, prov(0.0), depth_to=round(dt * k, 3) if dt is not None else None,
                              label=" ".join(x for x in (str(s.get("type") or ""), str(s.get("id") or "")) if x).strip() or None))
    for g in merged.get("groundwater") or []:
        if not isinstance(g, dict):
            continue
        d = _num(g.get("depth"))
        if d is None:
            continue
        pts.append(PointValue("GWL", round(d * k, 3), None, prov(0.0), label=g.get("note")))
    # points far below the hole are tile/model artefacts (a mis-projected depth scale): drop, but say so
    limit = pr.total_depth if pr.total_depth is not None else (max((L.bottom for L in layers if not math.isnan(L.bottom)), default=None))
    if limit is not None:
        deep = [p for p in pts if isinstance(p.depth, float) and not math.isnan(p.depth) and p.depth > limit + 1.0]
        if deep:
            pr.issues.append(f"{len(deep)} point values below {limit} m dropped (depths {min(p.depth for p in deep)}–{max(p.depth for p in deep)})")
            failed.add("points-below-hole")
            pts = [p for p in pts if p not in deep]
    pr.points = pts

    # header
    if header:
        _apply_header(pr, header, k)

    # tile merge outcome
    if tile_issues:
        pr.issues += tile_issues
    st = dict(tile_stats or {})
    pr.stats = st
    anch = merged.get("_anchor_summary")
    if anch:
        pr.stats["anchor"] = anch
        if anch.get("fits", 0) == 0:
            pr.notes.append("no depth-scale fit from the grid – depths as read by the model")
    if st.get("overlap_disagreed"):
        failed.add("tile-disagree")
    if st.get("tiles_failed"):
        failed.add("tile-failed")
    if not layers:
        failed.add("no-layers")
        pr.issues.append("vision model returned no layers")

    pr.confidence = _confidence(failed, pr.read_quality)
    for L in pr.layers:
        L.prov.confidence = pr.confidence
    for p in pr.points:
        p.prov.confidence = pr.confidence
    pr.stats["failed_checks"] = sorted(failed)
    return pr


def _apply_header(pr: PageResult, header: dict, k: float) -> None:
    lines = []
    for fld, v in header.items():
        if v in (None, "", "null"):
            continue
        s = str(v).strip()
        lines.append(f"{fld}: {s}")
        if fld == "DepthUnit":
            if s.lower().startswith("f") and pr.depth_unit == "unknown":
                pr.depth_unit = "ft"
            continue
        if fld in EXTRA_FIELDS or fld in ("LoggedBy", "Inclination", "Sheet"):
            pr.header_extras[fld] = s
            if fld == "Sheet" and pr.sheet_no is None:
                m = re.match(r"\s*(\d+)\s*(?:of|/|de|von)\s*(\d+)", s, re.I)
                if m:
                    pr.sheet_no, pr.sheet_total = int(m.group(1)), int(m.group(2))
            continue
        val = _coerce(fld, s)
        if fld in NUMERIC_FIELDS and isinstance(val, float) and fld in ("BoreholeDepth", "Groundwaterlevel") and k != 1.0:
            val = round(val * k, 3)
        if fld in DEPTH_LIMITS and isinstance(val, float):
            lo, hi = DEPTH_LIMITS[fld]
            if not (lo <= val <= hi):
                pr.notes.append(f"header {fld} {val:g} out of range – ignored")
                continue
        if fld == "BoreholeName":
            val = clean_name(s, pr.borehole_name)
            if val is None:
                continue
            if pr.borehole_name is None:
                pr.borehole_name = val
        pr.header_fields[fld] = val
    pr.header_text = "\n".join(lines)
    if pr.total_depth is None and isinstance(pr.header_fields.get("BoreholeDepth"), float):
        pr.total_depth = pr.header_fields["BoreholeDepth"]


def _confidence(failed: set[str], read_quality: str) -> float:
    c = 0.8
    c -= 0.1 * len(failed - {"tile-disagree", "tile-failed"})
    if "tile-disagree" in failed:
        c -= 0.1
    if "tile-failed" in failed:
        c -= 0.1
    if read_quality in ("handwritten", "photo"):
        c -= 0.15
    elif read_quality == "faded":
        c -= 0.05
    return round(max(0.15, min(0.95, c)), 2)


# ---------------------------------------------------------------------------
# SPT sheets (blow-count tables, no strata)
# ---------------------------------------------------------------------------

def reconcile_spt(merged: dict, source_file: str, page_no: int, classify: Optional[dict] = None,
                  header: Optional[dict] = None, tile_issues: Optional[list[str]] = None) -> PageResult:
    cl = classify or {}
    pr = PageResult(source_file, page_no, "vlm-spt", page_type="spt_sheet",
                    read_quality=cl.get("read_quality", "handwritten"), language=cl.get("language", ""))
    unit = merged.get("depth_unit") if merged.get("depth_unit") in ("m", "ft") else cl.get("depth_unit", "unknown")
    pr.depth_unit = unit or "unknown"
    k = FT if pr.depth_unit == "ft" else 1.0
    pr.borehole_name = (str(merged.get("borehole_name")).strip() or None) if merged.get("borehole_name") else None
    td = _num(merged.get("total_depth"))
    pr.total_depth = round(td * k, 3) if td is not None else None
    failed: set[str] = set()
    prov = lambda: Provenance(source_file, page_no, method=METHOD, confidence=0.0)
    rows = [r for r in merged.get("rows") or [] if isinstance(r, dict)]
    # rows with nothing written carry no information (the model sometimes fills an empty column)
    rows = [r for r in rows if r.get("n_value") not in (None, "") or any(b is not None for b in (r.get("blows") or []))]
    # a sheet with one count per row read as two single digits ('84' → [8, 4]): every row has exactly two
    # blows below 10 and no N → re-join the digits
    two_digit = [r for r in rows if r.get("n_value") in (None, "") and len([b for b in (r.get("blows") or []) if b is not None]) == 2
                 and all(isinstance(b, (int, float)) and 0 <= b <= 9 for b in r["blows"] if b is not None)]
    if rows and len(two_digit) >= max(3, int(0.8 * len(rows))):
        for r in two_digit:
            a, b = [int(x) for x in r["blows"] if x is not None]
            r["n_value"], r["blows"] = str(a * 10 + b), []
        pr.issues.append(f"{len(two_digit)} rows read as digit pairs – re-joined into single counts (check)")
        failed.add("digit-split")
    depths: list[float] = []
    for r in rows:
        d = _num(r.get("depth_from"))
        if d is None:
            continue
        dt = _num(r.get("depth_to"))
        val = _spt_value(r.get("n_value"))
        blows = [b for b in (r.get("blows") or []) if b is not None]
        if val is None and blows:
            # N = sum of the last two increments when three are given
            val = float(sum(blows[-2:])) if len(blows) >= 2 else None
        label = ",".join(str(int(b)) if float(b).is_integer() else str(b) for b in blows) or None
        if isinstance(val, float) and not (0 <= val <= 150):
            pr.issues.append(f"SPT {val:g} at {d} out of range")
            failed.add("spt-range")
        pts = PointValue("SPT", round(d * k, 3), val, prov(), depth_to=round(dt * k, 3) if dt is not None else None, label=label)
        pr.points.append(pts)
        depths.append(d * k)
    # row-spacing plausibility: consecutive test depths usually 0.45–1.5 m apart (regular)
    if len(depths) >= 3:
        ds = sorted(depths)
        gaps = [b - a for a, b in zip(ds, ds[1:])]
        med = sorted(gaps)[len(gaps) // 2]
        if not (0.2 <= med <= 3.0):
            pr.issues.append(f"SPT rows spaced {med:.2f} m apart – implausible, check unit/reading")
            failed.add("spt-spacing")
        irregular = sum(1 for g in gaps if abs(g - med) > 0.6 * med + 0.05)
        if irregular > max(1, len(gaps) // 3):
            pr.issues.append(f"{irregular} of {len(gaps)} SPT row gaps irregular – rows may be missing or misread")
            failed.add("spt-irregular")
    if not rows:
        failed.add("no-rows")
        pr.issues.append("vision model returned no SPT rows")
    if header:
        _apply_header(pr, header, k)
    if tile_issues:
        pr.issues += tile_issues
    pr.confidence = _confidence(failed, pr.read_quality)
    for p in pr.points:
        p.prov.confidence = pr.confidence
    pr.stats = {"failed_checks": sorted(failed), "rows": len(rows)}
    return pr
