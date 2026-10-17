"""Stage 2: page triage. Decide which pages are borehole logs before doing any heavy work.

Pure feature engineering + weighted rules; deterministic. Classes:
  log        – borehole / test-pit log with a depth axis
  lab        – laboratory result sheet (sieve, Atterberg, UCS...)
  narrative  – running text (report body)
  cover      – title / TOC / appendix divider
  photo      – mostly raster image, few words
  other
"""
from __future__ import annotations

import re

from .depthscale import find_depth_scales
from ..models import Page

LOG_KW = [
    # en
    "borehole", "bore hole", "boring log", "borehole log", "drill hole", "drill log", "log of bore",
    "log of investigation", "hole no", "b.h.", "bh no", "test pit", "depth", "description of strata",
    "layer description", "soil description", "lithology", "strata", "spt", "rqd", "tcr", "n-value",
    "blow count", "casing", "groundwater", "water level", "g.w.", "sample", "legend", "elevation",
    # es
    "sondeo", "sondaje", "perforación", "profundidad", "descripción", "muestra", "nivel freático", "penetración",
    # de
    "bohrung", "bohrprofil", "schichtenverzeichnis", "tiefe", "bodenart", "gok", "grundwasser",
    # fr / pt / no
    "sondage", "profondeur", "sondagem", "borrhull", "brønn", "dybde", "boring",
]
LAB_KW = [
    "sieve", "grain size", "gradation", "atterberg", "liquid limit", "plastic limit", "plasticity index",
    "hydrometer", "triaxial", "uniaxial", "unconfined", "ucs", "consolidation", "oedometer", "proctor",
    "direct shear", "specific gravity", "moisture content", "granulometr", "límite líquido", "ensayo",
    "point load", "cbr", "percent passing", "% passing", "passing", "test results", "laboratory",
    "compaction", "penetration ( mm", "penetration (mm", "stress", "dry density", "optimum moisture", "curve",
    "in-situ density", "density indices", "swell", "shear strength", "unit weight", "table no",
]
COVER_KW = ["table of contents", "contents", "appendix", "annex", "report for", "prepared for", "prepared by",
            "introduction", "conducted for", "índice", "inhalt", "anhang", "sammendrag", "summary"]


def _looks_like_row_counter(ds) -> bool:
    vals = [v for _, v in ds.ticks]
    if not vals or vals[0] != 1:
        return False
    return all(float(v).is_integer() for v in vals) and all(b - a == 1 for a, b in zip(vals, vals[1:]))


def _kw_hits(text: str, kws: list[str]) -> int:
    t = text.lower()
    return sum(1 for k in kws if k in t)


def features(page: Page) -> dict:
    words = page.words
    n = len(words)
    text = page.text
    nums = [w for w in words if w.number is not None]
    alpha_words = [w for w in words if re.search(r"[A-Za-zÀ-ɏ]{3,}", w.text)]
    lines = page.lines_of_text()
    long_lines = sum(1 for ln in lines if sum(len(w.text) for w in ln) > 70)
    scales = find_depth_scales(page)
    best = scales[0] if scales else None
    hl = page.hlines(min_len=page.width * 0.08)
    vl = page.vlines(min_len=page.height * 0.15)
    f = {
        "n_words": n,
        "n_numbers": len(nums),
        "num_ratio": len(nums) / max(1, n),
        "n_alpha": len(alpha_words),
        "n_lines": len(lines),
        "long_lines": long_lines,
        "long_line_ratio": long_lines / max(1, len(lines)),
        "n_hlines": len(hl),
        "n_vlines": len(vl),
        "depth_scale": bool(best),
        "depth_scale_n": best.n if best else 0,
        "depth_scale_span": (best.y_bottom - best.y_top) / page.height if best else 0.0,
        "depth_scale_kind": best.kind if best else None,
        "depth_scale_rowcounter": bool(best and _looks_like_row_counter(best)),
        "kw_log": _kw_hits(text, LOG_KW),
        "kw_lab": _kw_hits(text, LAB_KW),
        "kw_cover": _kw_hits(text, COVER_KW),
        "image_area_ratio": page.image_area_ratio,
        "has_text_layer": page.has_text_layer,
        "ocr_conf": (sum(w.conf for w in words) / n) if (n and words[0].source == "ocr") else None,
    }
    return f


def classify(page: Page) -> tuple[str, float, dict]:
    f = features(page)
    s = {"log": 0.0, "lab": 0.0, "narrative": 0.0, "cover": 0.0, "photo": 0.0, "other": 0.1}

    # photo / empty
    if f["n_words"] < 15:
        s["photo"] += 0.8 if f["image_area_ratio"] > 0.3 else 0.3
        s["cover"] += 0.3
    # log evidence: a depth scale is the primary signal; keywords only count on a ruled table
    tabular = f["n_vlines"] >= 4 and f["n_hlines"] >= 4
    if f["depth_scale"]:
        s["log"] += 0.45 + 0.3 * min(1.0, f["depth_scale_span"] / 0.5) + 0.02 * min(10, f["depth_scale_n"])
        if f["depth_scale_rowcounter"]:
            s["log"] -= 0.35          # 1,2,3… integer column is more likely a row counter than a scale
    if tabular or f["depth_scale"]:
        s["log"] += 0.05 * min(6, f["kw_log"])
    if f["n_vlines"] >= 4:
        s["log"] += 0.12
    if f["n_hlines"] >= 6:
        s["log"] += 0.05
    if f["long_line_ratio"] > 0.25:
        s["log"] *= 0.5               # running text pages are not logs
    # lab evidence
    s["lab"] += 0.18 * min(5, f["kw_lab"])
    if f["kw_lab"] >= 2 and f["num_ratio"] > 0.35:
        s["lab"] += 0.2
    # narrative evidence
    if f["long_line_ratio"] > 0.35 and f["n_words"] > 120:
        s["narrative"] += 0.7
    if f["num_ratio"] < 0.1 and f["n_words"] > 150:
        s["narrative"] += 0.2
    # cover
    if f["n_words"] < 80 and f["kw_cover"] >= 1 and not f["depth_scale"]:
        s["cover"] += 0.5
    if f["n_words"] < 40 and not f["depth_scale"]:
        s["cover"] += 0.2

    # sieve plots / curves have axes that look like a scale: suppress when lab kw dominate
    if f["kw_lab"] >= 2 and f["kw_log"] <= 2:
        s["log"] *= 0.5
    if f["kw_lab"] >= 3 and f["kw_lab"] > f["kw_log"]:
        s["log"] *= 0.6

    cls = max(s, key=s.get)
    total = sum(s.values()) or 1.0
    conf = s[cls] / total
    return cls, round(conf, 3), f


def triage(pages: list[Page]) -> list[Page]:
    for p in pages:
        cls, conf, f = classify(p)
        p.page_class, p.class_score, p.features = cls, conf, f
    return pages
