"""Stage 3: depth-anchored geometry parser for a single log page.

Everything here is deterministic. Given words + ruling lines:
  1. find the depth scale (y → metres)
  2. find the table region and its columns (vertical ruling lines)
  3. assign a role to each column from its header text (alias dictionary) or by inference
  4. layers   = description-column text split at horizontal ruling lines / boundary labels
  5. points   = numbers in SPT/RQD/TCR columns, sample ids, interval texts, "N=xx" tokens
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .depthscale import DepthScale, best_depth_scale, find_depth_scales
from ..models import Layer, Page, PointValue, Provenance, Word, parse_number

# --------------------------------------------------------------------------
# column roles
# --------------------------------------------------------------------------
ROLE_ALIASES: dict[str, list[str]] = {
    "depth": ["depth", "prof.", "profundidad", "profundidade", "tiefe", "dybde", "profondeur", "scale", "(m)"],
    "elevation": ["elevation", "elev", "reduced level", "r.l", "rl", "cota", "level", "höhe", "nivel"],
    "description": ["description", "descr", "descripción", "descripcion", "descrição", "naturaleza", "lithology", "strata",
                    "material", "soil", "rock", "layer", "beschreibung", "bodenart", "jordart", "beskrivelse",
                    "geolog", "litolog"],
    "spt": ["spt", "n-value", "n value", "n30", "n60", "blow", "golpe", "penetraci", "n (", "nspt", "15cm", "n ="],
    "rqd": ["rqd", "r.q.d"],
    "tcr": ["tcr", "core recovery", "recovery", "recuperaci", "total core", "rec."],
    "scr": ["scr", "solid core"],
    "sample": ["sample", "muestra", "amostra", "probe", "type", "no.", "nº"],
    "legend": ["legend", "graphic", "symbol", "columna", "litológica", "litologica", "profile", "legenda", "log"],
    "water": ["water", "freático", "freatico", "g.w", "gwl", "grundwasser", "nivel"],
    "thickness": ["thick", "espesor", "mächtigkeit", "thk"],
    "classification": ["uscs", "classif", "clasificaci", "class", "usc", "soil group"],
    "moisture": ["moist", "humedad", "wet"],
    "consistency": ["consist", "density", "relative", "compac"],
    "weathering": ["weather", "meteoriz"],
}
ROLE_PRIORITY = ["description", "depth", "spt", "rqd", "tcr", "scr", "sample", "elevation", "thickness",
                 "legend", "water", "classification", "moisture", "consistency", "weathering"]

INTERVAL_RE = re.compile(r"^(\d{1,3}[.,]\d{1,2})\s*[-–~]\s*(\d{1,3}[.,]\d{1,2})$")
HEADING_RE = re.compile(r"^\(?(\d{1,3}(?:[.,]\d{1,2})?)\s*[-–~～]\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*m?\)?\s*:?$", re.I)
TERMINAL_HINT_RE = re.compile(r"fin de|end of|terminat|complet|bohrende|pit bottom|bottom of", re.I)
INLINE_INTERVAL_RE = re.compile(r"(?:depth|tiefe|prof\.?)\s*:?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*[-–~～]\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*m\b", re.I)
N_EQ_RE = re.compile(r"^N\s*[=:\-]\s*(\d{1,3}|R|REF|>?\d+)$", re.I)
SAMPLE_ID_RE = re.compile(r"^(SS|SPT|UD|U|D|B|C|DS|BS|TW|P|M|S|ES|W|DD)\s*-?\s*(\d{1,3})$", re.I)


@dataclass
class Column:
    x0: float
    x1: float
    header: str = ""
    role: str = "unknown"
    role_score: float = 0.0

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    def contains(self, w: Word, frac: float = 0.6) -> bool:
        ix = max(0.0, min(self.x1, w.x1) - max(self.x0, w.x0))
        return ix / max(1e-6, (w.x1 - w.x0)) >= frac


@dataclass
class TableRegion:
    x0: float
    y0: float
    x1: float
    y1: float
    columns: list[Column] = field(default_factory=list)

    def inside(self, w: Word) -> bool:
        return self.x0 - 2 <= w.xc <= self.x1 + 2 and self.y0 - 2 <= w.yc <= self.y1 + 2


@dataclass
class PageLog:
    page: Page
    scale: Optional[DepthScale]
    table: Optional[TableRegion]
    layers: list[Layer]
    points: list[PointValue]
    header_words: list[Word]
    notes: list[str]

    def summary(self) -> dict:
        return {
            "page": self.page.page_no,
            "scale": self.scale.as_dict() if self.scale else None,
            "table": None if not self.table else {
                "bbox": [round(self.table.x0), round(self.table.y0), round(self.table.x1), round(self.table.y1)],
                "columns": [{"x": [round(c.x0), round(c.x1)], "role": c.role, "header": c.header[:40]}
                            for c in self.table.columns]},
            "n_layers": len(self.layers), "n_points": len(self.points), "notes": self.notes,
        }


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

EXACT_TOKENS = {"n": "spt", "nspt": "spt", "n30": "spt", "rqd": "rqd", "tcr": "tcr", "scr": "scr", "spt": "spt"}


def _role_from_text(text: str) -> tuple[str, float]:
    t = " " + text.lower() + " "
    best, bs = "unknown", 0.0
    toks = [x for x in re.split(r"[^a-z0-9\u00C0-\u024F]+", t) if x]
    if len(toks) <= 2 and all(len(x) <= 4 for x in toks):
        for x in toks:
            if x in EXACT_TOKENS:
                return EXACT_TOKENS[x], 3.0
    for role in ROLE_PRIORITY:
        score = 0.0
        for a in ROLE_ALIASES[role]:
            # short aliases must match whole tokens (otherwise 'scr' hits 'description', 'rl' hits 'drill')
            hit = (re.search(r"(?<![a-z])" + re.escape(a) + r"(?![a-z])", t) if len(a) <= 4 else a in t)
            if hit:
                score += 1.0 + 0.05 * len(a)
        if score > bs:
            best, bs = role, score
    return best, bs


def _cluster_positions(vals: list[float], tol: float) -> list[float]:
    vals = sorted(vals)
    out: list[list[float]] = []
    for v in vals:
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [float(np.mean(c)) for c in out]


def detect_table(page: Page, scale: Optional[DepthScale]) -> Optional[TableRegion]:
    """Table = the band of long vertical ruling lines. Falls back to the scale's vertical extent."""
    H, W = page.height, page.width
    vl = [s for s in page.vlines(min_len=H * 0.25)]
    if scale:
        # keep lines that overlap the scale's y-range substantially
        vl = [s for s in vl if min(s.y1, scale.y_bottom + 30) - max(s.y0, scale.y_top - 30) > 0.5 * (scale.y_bottom - scale.y_top)]
    if len(vl) < 2:
        if not scale:
            return None
        # no ruling lines: treat the whole width right of the scale as one table with 2 columns
        y0, y1 = scale.y_top - 15, scale.y_bottom + 15
        cols = [Column(0, scale.x1 + 4, role="depth"), Column(scale.x1 + 4, W, role="description")]
        return TableRegion(0, y0, W, y1, cols)
    xs = _cluster_positions([s.x0 for s in vl], tol=4.0)
    y0 = float(np.median([min(s.y0, s.y1) for s in vl]))
    y1 = float(np.median([max(s.y0, s.y1) for s in vl]))
    if scale:
        y0 = min(y0, scale.y_top - 10)
        y1 = max(y1, scale.y_bottom + 10)
    cols = [Column(a, b) for a, b in zip(xs[:-1], xs[1:]) if b - a > 6]
    if not cols:
        return None
    return TableRegion(xs[0], y0, xs[-1], y1, cols)


def _header_band(page: Page, table: TableRegion, scale: Optional[DepthScale]) -> tuple[float, float]:
    """y-range of the column-header row: between the table top and the first data row."""
    top = table.y0
    first_data = scale.y_top - 6 if scale else table.y0 + 90
    # the header band is usually bounded below by a horizontal line spanning most of the table
    hls = [s for s in page.hlines(min_len=(table.x1 - table.x0) * 0.5) if top + 6 <= s.y0 <= first_data + 2]
    bottom = min([s.y0 for s in hls], default=first_data)
    # data cannot start above depth 0: if the scale says depth 0 is at/above the table top, there is no header row
    if scale and scale.kind in ("depth", "neg-depth") and scale.y_at(0.0) > top - 20:
        bottom = min(bottom, max(top, scale.y_at(0.0) + 2))
    if bottom - top < 6:
        bottom = top
    return top - 2, bottom


def assign_roles(page: Page, table: TableRegion, scale: Optional[DepthScale]) -> None:
    hb0, hb1 = _header_band(page, table, scale)
    hdr_in = [w for w in page.words if (hb0 <= w.yc <= hb1) or (w.y0 < hb1 - 4 and w.y1 > hb0 + 4 and w.h > 25)]
    hdr_above = [w for w in page.words if hb0 - 40 <= w.yc < hb0]
    for c in table.columns:
        ws = sorted((w for w in hdr_in if c.contains(w, 0.5)), key=lambda w: (w.yc, w.x0))
        if not ws:   # header printed above the table frame (SAM01) – only then look above
            ws = sorted((w for w in hdr_above if c.contains(w, 0.5)), key=lambda w: (w.yc, w.x0))
        c.header = " ".join(w.text for w in ws)
        c.role, c.role_score = _role_from_text(c.header)
    # the column holding the scale is the depth column regardless of header
    if scale:
        for c in table.columns:
            if c.x0 - 2 <= (scale.x0 + scale.x1) / 2 <= c.x1 + 2 and c.width < 0.25 * (table.x1 - table.x0):
                if c.role not in ("depth", "elevation"):
                    c.role, c.role_score = ("depth" if scale.kind != "elevation" else "elevation"), 9.0
    # description: if no column claims it, choose the widest column with most alphabetic words in the body
    if not any(c.role == "description" for c in table.columns):
        best, bs = None, 0.0
        for c in table.columns:
            if c.role in ("depth", "elevation", "spt", "rqd", "tcr"):
                continue
            body = [w for w in page.words if c.contains(w) and table.y0 < w.yc < table.y1
                    and re.search(r"[A-Za-zÀ-ɏ]{3,}", w.text)]
            s = len(body) * (c.width ** 0.5)
            if s > bs:
                best, bs = c, s
        if best:
            best.role, best.role_score = "description", 0.5
    # duplicate roles: keep the strongest, demote others to unknown (except sample/legend which may repeat)
    for role in ("description", "spt", "rqd", "tcr"):      # several depth columns are fine (top / bottom labels)
        cs = [c for c in table.columns if c.role == role]
        if len(cs) > 1:
            cs.sort(key=lambda c: (c.role_score, c.width), reverse=True)
            for c in cs[1:]:
                c.role = "unknown"


# --------------------------------------------------------------------------
# layers
# --------------------------------------------------------------------------

def _boundaries_from_lines(page: Page, table: TableRegion, desc: Column) -> list[float]:
    ys = []
    for s in page.hlines(min_len=desc.width * 0.5):
        if not (table.y0 - 2 <= s.y0 <= table.y1 + 2):
            continue
        lo, hi = min(s.x0, s.x1), max(s.x0, s.x1)
        overlap = min(hi, desc.x1) - max(lo, desc.x0)
        if overlap >= 0.6 * desc.width:
            ys.append(s.y0)
    return _cluster_positions(ys, tol=3.0)


def _boundary_labels(page: Page, table: TableRegion, scale: Optional[DepthScale],
                     line_ys: list[float], exclude: set[int]) -> list[tuple[float, float, Word]]:
    """Depth labels printed at layer boundaries, e.g. '0.40m' or numbers in a depth-role column
    that are not part of the scale and sit on a ruling line. Returns (y, depth, word)."""
    out = []
    depth_cols = [c for c in table.columns if c.role == "depth"]
    desc = next((c for c in table.columns if c.role == "description"), None)
    for w in page.words:
        if id(w) in exclude or not table.inside(w):
            continue
        v = parse_number(w.text)
        if v is None or v < 0 or v > 300:
            continue
        in_scale = scale and scale.x0 - 3 <= w.xc <= scale.x1 + 3 and any(abs(w.yc - y) < 2 for y, _ in scale.ticks)
        if in_scale:
            continue
        has_m = w.text.lower().endswith("m") and 3 <= len(w.text) <= 7 and "mm" not in w.text.lower()
        near_line = any(abs(w.yc - y) <= 7 for y in line_ys)
        in_desc = desc is not None and desc.contains(w, 0.5)
        in_depth = any(c.contains(w) for c in depth_cols)
        if (has_m and (in_desc or in_depth)) or (near_line and in_depth):
            out.append((w.yc, v, w))
    return out


def build_layers(page: Page, table: TableRegion, scale: Optional[DepthScale], notes: list[str],
                 header_bottom: float, exclude: set[int],
                 extra_labels: Optional[list[tuple[float, float, Word]]] = None) -> list[Layer]:
    desc = next((c for c in table.columns if c.role == "description"), None)
    if desc is None:
        notes.append("no description column")
        return []
    y_min = max(table.y0, header_bottom)
    body_words = [w for w in page.words if desc.contains(w, 0.5) and y_min < w.yc < table.y1 and id(w) not in exclude]
    if not body_words:
        notes.append("description column empty")
        return []

    # candidate boundaries
    line_ys = _boundaries_from_lines(page, table, desc)
    labels = _boundary_labels(page, table, scale, line_ys, exclude)
    for lab in (extra_labels or []):
        if not any(abs(lab[0] - y) < 3 and id(w) == id(lab[2]) for y, _, w in labels):
            labels.append(lab)
    # priority: labels in the description column, then depth-role columns, then the rest
    def _prio(lab):
        w = lab[2]
        if desc.contains(w, 0.5):
            return 0
        if any(c.role == "depth" and c.contains(w, 0.5) for c in table.columns):
            return 1
        return 2
    labels.sort(key=lambda lab: (_prio(lab), lab[0]))
    # depth labels must increase down the page: keep the longest increasing chain, drop the rest (OCR junk)
    if len(labels) >= 2:
        by_y = sorted(labels, key=lambda lab: (round(lab[0]), _prio(lab)))
        n = len(by_y); best = [1] * n; prev = [-1] * n
        for i in range(n):
            for j in range(i):
                if by_y[j][1] <= by_y[i][1] and best[j] + 1 > best[i]:
                    best[i], prev[i] = best[j] + 1, j
        i = max(range(n), key=lambda k: best[k]); keep = set()
        while i != -1:
            keep.add(id(by_y[i][2])); i = prev[i]
        labels = [lab for lab in labels if id(lab[2]) in keep]
    label_ids = {id(w) for _, _, w in labels}
    body_words = [w for w in body_words if id(w) not in label_ids]
    ys = list(line_ys)
    for y, v, _ in labels:
        if v == 0.0:
            continue                      # '0.00' marks the top, never a boundary
        if not any(abs(y - b) < 6 for b in ys):
            ys.append(y)
    ys = sorted(set(round(y, 1) for y in ys))

    # data extent
    if scale:
        y_top = scale.y_at(0.0) if scale.kind in ("depth", "neg-depth") else scale.y_top - 4
    else:
        y_top = min(w.y0 for w in body_words) - 2
    y_top = max(y_top, y_min)
    y_bot = max(w.y1 for w in body_words) + 2
    if scale:
        y_bot = max(y_bot, scale.y_bottom)
    ys = [y for y in ys if y_top + 12 < y < y_bot - 4]

    def depth_at(y: float) -> Optional[float]:
        if abs(y - y_top) > 1e-6 or not scale:
            for ly, v, _ in labels:
                if abs(ly - y) <= 10:
                    return v
        if scale:
            d = round(scale.depth_at(y), 2)
            return 0.0 if -0.15 < d < 0.12 else d
        return None

    text_rows = _join_rows(body_words)
    # thickness mode: a 'Thick.' column gives one value per layer cell → exact cumulative boundaries
    thk = next((c for c in table.columns if c.role == "thickness"), None)
    page_starts_at_zero = scale is None or scale.depth_at(y_min) < 0.6
    if thk is not None and page_starts_at_zero:
        got = _layers_from_thickness(page, table, desc, thk, body_words, y_min, notes, scale)
        if got:
            return got
    # heading mode: layers introduced by '41.6~44.6m :' / '0.0 - 0.5' lines inside the description (SEA01 style)
    headings = []
    for r in text_rows:
        rt = " ".join(w.text for w in r)
        m = HEADING_RE.match(rt.replace(" ", "")) if len(r) <= 4 else None
        m = m or INLINE_INTERVAL_RE.search(rt)
        if m:
            headings.append((r, m))
    hvals = [float(m.group(1).replace(",", ".")) for _, m in headings]
    monotonic = all(b >= a for a, b in zip(hvals, hvals[1:]))
    if scale and len(headings) >= 2 and monotonic:
        notes.append("heading-mode layers")
        return _layers_from_headings(page, desc, text_rows, headings, scale)
    # row mode: a table with one text row per depth step and no layer lines (SAM01 style)
    if len(ys) < max(2, len(text_rows) // 4) and len(text_rows) >= 6 and scale:
        aligned = sum(1 for r in text_rows if any(abs(np.mean([w.yc for w in r]) - ty) <= 4 for ty, _ in scale.ticks))
        if aligned >= 0.6 * len(text_rows):
            notes.append("row-mode layers")
            return _layers_from_rows(page, desc, text_rows, scale)

    bounds = [y_top] + ys + [y_bot]
    layers: list[Layer] = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        ws = sorted((w for w in body_words if a <= w.yc < b), key=lambda w: (round(w.yc / 3), w.x0))
        text = _join_words(ws) if ws else ""
        bot = depth_at(b)
        if len(text) < 2 or not re.search(r"[A-Za-z\u00C0-\u024F]{3,}", text):
            # empty / numeric-only interval → continuation of the previous layer
            if layers:
                if text:
                    layers[-1].description += " " + text
                layers[-1].bottom = bot if bot is not None else layers[-1].bottom
                layers[-1].prov.y1 = b
            continue
        top = depth_at(a)
        if layers and re.match(r"^[a-z,;:)\-–]", text) and text[:3].lower() != "end":
            layers[-1].description += " " + text
            layers[-1].bottom = bot if bot is not None else layers[-1].bottom
            layers[-1].prov.y1 = b
            continue
        layers.append(Layer(top=top if top is not None else float("nan"),
                            bottom=bot if bot is not None else float("nan"),
                            description=text,
                            prov=Provenance(page.source_file, page.page_no, a, b, desc.x0, desc.x1, "geometry",
                                            confidence=min(w.conf for w in ws))))
    # zero-thickness layers (two labels for one boundary) are merged into the following layer
    out: list[Layer] = []
    for L in layers:
        if out and out[-1].top == out[-1].bottom:
            prev = out.pop()
            L.description = prev.description + " " + L.description
            L.top = prev.top
            L.prov.y0 = prev.prov.y0
        out.append(L)
    return out


def _join_rows(ws: list[Word]) -> list[list[Word]]:
    rows: list[list[Word]] = []
    for w in sorted(ws, key=lambda w: (w.yc, w.x0)):
        if rows and abs(rows[-1][-1].yc - w.yc) <= max(2.5, 0.5 * w.h):
            rows[-1].append(w)
        else:
            rows.append([w])
    return rows


def _layers_from_thickness(page: Page, table: TableRegion, desc: Column, thk: Column, body_words: list[Word],
                           y_min: float, notes: list[str], scale: Optional[DepthScale] = None) -> list[Layer]:
    def _thk(w: Word) -> Optional[float]:
        v = parse_number(w.text.lstrip("><≥≤~"))
        return v if v is not None and 0.02 <= v <= 60 else None
    vals = sorted(((w.yc, w) for w in page.words if thk.contains(w, 0.5) and y_min < w.yc < table.y1
                   and _thk(w) is not None), key=lambda t: t[0])
    if len(vals) < 1:
        return []
    # cell boundaries = ruling lines crossing the thickness column
    lines = sorted(set(round(s.y0, 1) for s in page.hlines(min_len=thk.width * 0.5)
                       if y_min - 2 <= s.y0 <= table.y1 + 2 and min(s.x1, thk.x1) - max(s.x0, thk.x0) >= 0.5 * thk.width))
    # Thickness cells are drawn to scale: cell centres sit at depth top+thk/2. Fit y = a + b*depth from them
    # (or use the detected scale) and place each cell bottom at the ruling line nearest to the predicted y.
    thks = [_thk(w) for _, w in vals]
    bottoms = list(np.cumsum(thks))
    centres = [b - t / 2 for b, t in zip(bottoms, thks)]
    sc_slope = sc_icpt = None
    if scale is not None:
        sc_slope, sc_icpt = scale.slope, scale.intercept
    elif len(vals) >= 2:
        A = np.vstack([centres, np.ones(len(centres))]).T
        ysc = np.array([y for y, _ in vals])
        coef, *_ = np.linalg.lstsq(A, ysc, rcond=None)
        pred = A @ coef
        ss_res = float(np.sum((ysc - pred) ** 2)); ss_tot = float(np.sum((ysc - ysc.mean()) ** 2)) or 1e-9
        if 1 - ss_res / ss_tot >= 0.98 and 8 <= coef[0] <= 600:
            sc_slope, sc_icpt = float(coef[0]), float(coef[1])
        else:
            notes.append("thickness cells not to scale – ignored")
            return []
    layers: list[Layer] = []
    top = 0.0
    prev_yb = y_min
    for i, (y, w) in enumerate(vals):
        bottom = round(float(bottoms[i]), 2)
        if sc_slope is not None:
            y_pred = sc_icpt + bottom * sc_slope
            tol = 0.2 * abs(sc_slope) + 3
            near = [l for l in lines if abs(l - y_pred) <= tol and l > w.y1 - 2]
            yb = min(near, key=lambda l: abs(l - y_pred)) if near else y_pred
            if scale is not None and abs(scale.depth_at(yb) - bottom) > 0.35 + 0.05 * bottom:
                notes.append("thickness column disagrees with scale – ignored")
                return []
        else:   # single value, no scale: first ruling line below the word, else the table bottom
            below = [l for l in lines if l > w.y1 + 1]
            yb = below[0] if below else table.y1
        if i + 1 < len(vals) and yb > vals[i + 1][1].y0:
            yb = (w.y1 + vals[i + 1][1].y0) / 2
        ya = prev_yb
        ws = sorted((x for x in body_words if ya <= x.yc < yb), key=lambda x: (round(x.yc / 3), x.x0))
        text = _join_words(ws)
        layers.append(Layer(top, bottom, text, Provenance(page.source_file, page.page_no, ya, yb, desc.x0, desc.x1,
                                                          "geometry-thickness", confidence=min([w.conf] + [x.conf for x in ws]))))
        top, prev_yb = bottom, yb
    if sum(1 for L in layers if re.search(r"[A-Za-z\u00C0-\u024F]{3,}", L.description)) < max(1, len(layers) // 2):
        return []           # thickness values without descriptions – not the layout we think it is
    # bottom-depth labels in a depth column deeper than the cumulative total → a thickness value was not read
    depth_labels = [w.number for c in table.columns if c.role == "depth" and c is not thk
                    for w in page.words if c.contains(w, 0.5) and y_min < w.yc < table.y1 and w.number is not None
                    and (scale is None or not any(abs(w.yc - ty) < 2 for ty, _ in scale.ticks))]
    if depth_labels and max(depth_labels) > layers[-1].bottom + 0.3 and max(depth_labels) < 300:
        notes.append("thickness column incomplete (deeper depth label present) – ignored")
        return []
    last_yb = layers[-1].prov.y1
    below_all = [x for x in body_words if x.yc > last_yb + 6]
    closing = re.compile(r"^(end|of|excavation|description|pit|bottom|fin|del?|sondeo|metros|borehole|bore|hole|"
                         r"completed|terminated|at|a|boring|log)$", re.I)
    below = [x for x in below_all if re.search(r"[A-Za-z\u00C0-\u024F]{4,}", x.text) and not closing.match(x.text.strip(":.,"))]
    # a short pit-bottom note after the last cell is fine; a whole description below it means a missing thickness value
    if len(below) >= 4 and (len(below) > 12 or not TERMINAL_HINT_RE.search(" ".join(x.text for x in below_all))):
        notes.append("thickness column incomplete (text below last cell) – ignored")
        return []           # OCR missed some thickness values
    notes.append("thickness-mode layers")
    return layers


def _layers_from_headings(page: Page, desc: Column, rows: list[list[Word]], headings, scale: DepthScale) -> list[Layer]:
    layers: list[Layer] = []
    hs = [(float(np.mean([w.yc for w in r])), float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", ".")), r)
          for r, m in headings]
    hs.sort(key=lambda t: t[0])
    for i, (y, a, b, r) in enumerate(hs):
        y_next = hs[i + 1][0] if i + 1 < len(hs) else float("inf")
        body = [rr for rr in rows if y < float(np.mean([w.yc for w in rr])) < y_next and rr is not r]
        own = INLINE_INTERVAL_RE.sub("", _join_words(r)).strip(" :*-")
        text = " ".join(([own] if len(own) > 3 else []) + [_join_words(rr) for rr in body])
        words = [w for rr in body for w in rr] or r
        layers.append(Layer(a, b, text or " ".join(w.text for w in r),
                            Provenance(page.source_file, page.page_no, min(w.y0 for w in r), max(w.y1 for w in words),
                                       desc.x0, desc.x1, "geometry-headings", confidence=min(w.conf for w in words))))
    return layers


def _layers_from_rows(page: Page, desc: Column, rows: list[list[Word]], scale: DepthScale) -> list[Layer]:
    """Each text row is a depth sample; its interval is the scale tick it is aligned with."""
    ticks = sorted(scale.ticks)
    layers: list[Layer] = []
    for r in rows:
        yc = float(np.mean([w.yc for w in r]))
        text = _join_words(r)
        if not re.search(r"[A-Za-z\u00C0-\u024F]{3,}", text):
            continue
        # nearest tick at or above
        i = max(range(len(ticks)), key=lambda k: (ticks[k][0] <= yc + 3, -abs(ticks[k][0] - yc)))
        if layers and abs(ticks[i][0] - yc) > 4:
            layers[-1].description += " " + text          # continuation line of the previous row
            layers[-1].prov.y1 = max(w.y1 for w in r)
            continue
        top = ticks[i][1] if ticks[i][0] <= yc + 3 else round(scale.depth_at(yc), 2)
        bottom = ticks[i + 1][1] if i + 1 < len(ticks) else round(scale.depth_at(yc) + (ticks[1][1] - ticks[0][1]), 2)
        if layers and layers[-1].description.lower() == text.lower() and abs(layers[-1].bottom - top) < 1e-6:
            layers[-1].bottom = bottom
            layers[-1].prov.y1 = max(w.y1 for w in r)
            continue
        layers.append(Layer(top, bottom, text, Provenance(page.source_file, page.page_no, min(w.y0 for w in r),
                                                         max(w.y1 for w in r), desc.x0, desc.x1, "geometry-rows",
                                                         confidence=min(w.conf for w in r))))
    return layers


def _join_words(ws: list[Word]) -> str:
    lines: list[list[Word]] = []
    for w in sorted(ws, key=lambda w: (w.yc, w.x0)):
        if lines and abs(lines[-1][-1].yc - w.yc) <= max(2.5, 0.5 * w.h):
            lines[-1].append(w)
        else:
            lines.append([w])
    parts = []
    for ln in lines:
        ln.sort(key=lambda w: w.x0)
        parts.append(" ".join(w.text for w in ln))
    text = " ".join(parts)
    text = re.sub(r"\s+([,.;:)])", r"\1", text)
    text = re.sub(r"(\w)- (\w)", r"\1\2", text)   # hyphenation at line end
    return text.strip()


# --------------------------------------------------------------------------
# point values (SPT / RQD / TCR / samples / intervals)
# --------------------------------------------------------------------------

def _interval_tokens(page: Page, table: TableRegion) -> list[tuple[Word, float, float, list[Word]]]:
    """'0.00 - 0.55' either as one token or as three adjacent words on a line."""
    out = []
    for ln in page.lines_of_text():
        ln = [w for w in ln if table.inside(w)]
        i = 0
        while i < len(ln):
            w = ln[i]
            m = INTERVAL_RE.match(w.text.replace(" ", ""))
            if m:
                out.append((w, float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", ".")), [w]))
                i += 1
                continue
            if i + 2 < len(ln) and ln[i + 1].text in ("-", "–", "—") and w.number is not None and ln[i + 2].number is not None \
                    and ln[i + 2].x0 - w.x1 < 60 and ln[i + 2].number > w.number >= 0 \
                    and (re.search(r"[.,]", w.text) or re.search(r"[.,]", ln[i + 2].text)):
                merged = Word(f"{w.text} - {ln[i+2].text}", w.x0, w.y0, ln[i + 2].x1, ln[i + 2].y1, min(w.conf, ln[i + 2].conf), w.source)
                out.append((merged, w.number, ln[i + 2].number, [w, ln[i + 1], ln[i + 2]]))
                i += 3
                continue
            # 'a-b' glued without decimals e.g. '1.5-3.0' handled by regex; 'a -b' (two tokens)
            if i + 1 < len(ln) and w.number is not None and re.match(r"^[-–]\d", ln[i + 1].text) \
                    and parse_number(ln[i + 1].text[1:]) is not None and parse_number(ln[i + 1].text[1:]) > w.number:
                v2 = parse_number(ln[i + 1].text[1:])
                merged = Word(f"{w.text} - {ln[i+1].text[1:]}", w.x0, w.y0, ln[i + 1].x1, ln[i + 1].y1, min(w.conf, ln[i + 1].conf), w.source)
                out.append((merged, w.number, v2, [w, ln[i + 1]]))
                i += 2
                continue
            i += 1
    return out


def build_points(page: Page, table: TableRegion, scale: Optional[DepthScale], notes: list[str]) -> list[PointValue]:
    pts: list[PointValue] = []
    prov = lambda w, method="geometry": Provenance(page.source_file, page.page_no, w.y0, w.y1, w.x0, w.x1, method, w.conf)

    def depth_of(w: Word) -> Optional[float]:
        return round(scale.depth_at(w.yc), 2) if scale else None

    intervals = _interval_tokens(page, table)
    # which column do intervals live in? (sample depth column usually)
    for w, a, b, _src in intervals:
        col = next((c for c in table.columns if c.contains(w, 0.5)), None)
        kind = "SAMPLE" if (col and col.role in ("sample", "depth", "unknown")) else "INTERVAL"
        pts.append(PointValue(kind, a, None, prov(w), depth_to=b, label=w.text))

    for c in table.columns:
        if c.role not in ("spt", "rqd", "tcr", "scr", "sample"):
            continue
        body = [w for w in page.words if c.contains(w, 0.6) and table.y0 + 2 < w.yc < table.y1]
        if c.role == "sample":
            for w in body:
                if SAMPLE_ID_RE.match(w.text) or re.fullmatch(r"[A-Z]{1,3}", w.text):
                    d = depth_of(w)
                    # snap to an interval on the same line if present
                    iv = next((iv for iv in intervals if abs(iv[0].yc - w.yc) < 4), None)
                    if iv:
                        pts.append(PointValue("SAMPLE", iv[1], w.text, prov(w), depth_to=iv[2], label=w.text))
                    elif d is not None:
                        pts.append(PointValue("SAMPLE", d, w.text, prov(w), label=w.text))
            continue
        kind = c.role.upper()
        for w in body:
            m = N_EQ_RE.match(w.text.replace(" ", ""))
            if m:
                pts.append(PointValue("SPT", depth_of(w) or float("nan"), m.group(1), prov(w), label=w.text))
                continue
            v = parse_number(w.text.rstrip("%"))
            if v is None:
                if re.fullmatch(r"R|REF|>\d+|\d+/\d+", w.text, re.I):
                    pts.append(PointValue(kind, depth_of(w) or float("nan"), w.text, prov(w), label=w.text))
                continue
            if kind in ("RQD", "TCR", "SCR") and not (0 <= v <= 100):
                continue
            if kind == "SPT" and not (0 <= v <= 200):
                continue
            d = depth_of(w)
            iv = next((iv for iv in intervals if abs(iv[0].yc - w.yc) < 4), None)
            if iv:
                pts.append(PointValue(kind, iv[1], v, prov(w), depth_to=iv[2]))
            elif d is not None:
                pts.append(PointValue(kind, d, v, prov(w)))

    # N=xx tokens anywhere in the table (AUS01 style) if no SPT column caught them
    if not any(p.kind == "SPT" for p in pts):
        for w in page.words:
            if table.inside(w):
                m = N_EQ_RE.match(w.text.replace(" ", ""))
                if m:
                    pts.append(PointValue("SPT", depth_of(w) or float("nan"), m.group(1), prov(w), label=w.text))
    # dedupe (same kind, same depth, same value)
    seen = set()
    out = []
    for p in pts:
        key = (p.kind, round(p.depth, 2) if p.depth == p.depth else None, str(p.value), p.depth_to)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    out.sort(key=lambda p: (p.kind, p.depth if p.depth == p.depth else 1e9))
    return out


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def _calibrate_scale(page: Page, scale: DepthScale, notes: list[str]) -> DepthScale:
    """Tick labels sit a little below/above the actual tick line; snap each tick to the nearest
    short horizontal ruling line crossing the scale column and refit."""
    hls = [s for s in page.segments if s.horizontal and min(s.x1, scale.x1 + 12) - max(s.x0, scale.x0 - 12) > 0]
    snapped = []
    for y, v in scale.ticks:
        near = [s.y0 for s in hls if abs(s.y0 - y) <= 0.12 * abs(scale.slope) + 2]
        if near:
            snapped.append((min(near, key=lambda yy: abs(yy - y)), v))
    if len(snapped) >= max(3, 0.6 * len(scale.ticks)):
        ys = np.array([t[0] for t in snapped]); vs = np.array([t[1] for t in snapped])
        A = np.vstack([vs, np.ones_like(vs)]).T
        coef, *_ = np.linalg.lstsq(A, ys, rcond=None)
        slope, intercept = float(coef[0]), float(coef[1])
        if scale.kind == "neg-depth":
            slope = -slope
        elif scale.kind == "elevation":
            slope = -slope
            intercept = float(ys[0])
        if abs(slope - scale.slope) / abs(scale.slope) < 0.1:
            notes.append(f"scale calibrated on {len(snapped)} tick lines")
            scale.slope, scale.intercept = slope, intercept
            scale.y_top, scale.y_bottom = float(ys.min()), float(ys.max())
    return scale


def parse_log_page(page: Page) -> PageLog:
    notes: list[str] = []
    scale = best_depth_scale(page)
    if not scale:
        notes.append("no depth scale found")
    else:
        scale = _calibrate_scale(page, scale, notes)
    table = detect_table(page, scale)
    if table is None:
        notes.append("no table region")
        return PageLog(page, scale, None, [], [], list(page.words), notes)
    if scale is not None and scale.kind == "elevation":
        # an elevation column only yields depths if we know the ground level (header) – otherwise it is
        # not an anchor: on continuation sheets 'depth 0 at the first tick' would be badly wrong
        from .header import extract_header
        outside = [w for w in page.words if not (table.y0 < w.yc < table.y1 and table.x0 < w.xc < table.x1)]
        gl = extract_header(page, outside).fields.get("Surface Elevation")
        if isinstance(gl, (int, float)):
            ys = np.array([y for y, _ in scale.ticks]); ds = np.array([gl - v for _, v in scale.ticks])
            A = np.vstack([ds, np.ones_like(ds)]).T
            coef, *_ = np.linalg.lstsq(A, ys, rcond=None)
            scale.slope, scale.intercept, scale.kind = float(coef[0]), float(coef[1]), "depth"
            scale.ticks = [(y, gl - v) for y, v in scale.ticks]
            notes.append(f"elevation scale converted with GL={gl}")
        else:
            notes.append("only an elevation scale and no ground level – depths from labels only")
            scale = None
            table = detect_table(page, None) or table
    assign_roles(page, table, scale)
    # words that belong to any linear numeric column (depth or elevation scales) never form descriptions
    exclude: set[int] = set()
    extra_labels: list[tuple[float, float, Word]] = []
    for cand in find_depth_scales(page):
        is_scale = scale is not None and abs(cand.x0 - scale.x0) < 1 and cand.n == scale.n
        if cand.r2 >= 0.995 or (cand.kind == "depth" and cand.r2 >= 0.98 and cand.n >= 4):
            for w in page.words:
                if cand.x0 - 2 <= w.xc <= cand.x1 + 2 and any(abs(w.yc - y) < 2 for y, _ in cand.ticks):
                    exclude.add(id(w))
                    # monotonic depth-like numbers that are not the scale are layer-boundary labels
                    if not is_scale and cand.kind == "depth" and w.number is not None and table.inside(w):
                        extra_labels.append((w.yc, w.number, w))
    interval_ids = {id(w) for *_rest, src in _interval_tokens(page, table) for w in src}
    desc_col = next((c for c in table.columns if c.role == "description"), None)
    line_ys = _boundaries_from_lines(page, table, desc_col) if desc_col else []
    extra_labels = [(y, v, w) for y, v, w in extra_labels
                    if id(w) not in interval_ids and any(abs(y - ly) <= 10 for ly in line_ys)
                    and (scale is None or abs(v - scale.depth_at(y)) < 0.3 + 0.1 * abs(v))]
    hb0, hb1 = _header_band(page, table, scale)
    layers = build_layers(page, table, scale, notes, hb1, exclude, extra_labels)
    points = build_points(page, table, scale, notes)
    header_words = [w for w in page.words if not (table.y0 < w.yc < table.y1 and table.x0 < w.xc < table.x1)]
    return PageLog(page, scale, table, layers, points, header_words, notes)
