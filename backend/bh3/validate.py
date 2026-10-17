"""Stage 6: hard rules. Every borehole gets a list of issues and a confidence score; nothing is silently fixed
except trivially derivable values (missing top = previous bottom), and those are flagged."""
from __future__ import annotations

import math
import re

from .models import Borehole

TERMINAL_RE = re.compile(r"(terminated|end of (bore ?hole|hole|boring|borehole|excavation|log|test pit)|"
                         r"(bore ?hole|hole|boring) (completed|terminated|ended)|fin de(l)? sondeo|fin de(l)? sondaje|"
                         r"bohrende|endteufe|end of pit|bottom of (bore)?hole|hull avsluttet|total depth)", re.I)


def validate(bh: Borehole) -> Borehole:
    issues = bh.issues
    layers = sorted(bh.layers, key=lambda L: (math.isnan(L.top), L.top if not math.isnan(L.top) else 0))

    # terminal markers ('terminated at 12.00 m', 'End of Borehole at 10.36m' inside a notes block)
    # define the depth; the marker itself and anything below it are not layers
    kept = []
    end_depth = None
    for L in layers:
        m = TERMINAL_RE.search(L.description)
        if m:
            tail = L.description[m.start():m.start() + 60]
            md = re.search(r"(\d{1,3}[.,]\d{1,2})\s*m", tail)
            d = float(md.group(1).replace(",", ".")) if md else (L.top if (not math.isnan(L.top) and L.top > 0.5) else None)
            if d is not None and "BoreholeDepth" not in bh.metadata:
                bh.metadata["BoreholeDepth"] = d
                bh.meta_prov["BoreholeDepth"] = L.prov
            if d is not None:
                end_depth = d if end_depth is None else min(end_depth, d)
            if len(L.description) < 120 or (not math.isnan(L.top) and d is not None and L.top >= d - 0.05):
                continue      # pure marker / notes block below the hole
            if d is not None and kept and not math.isnan(L.top) and L.top < d:
                # a notes block that starts inside the last layer: extend the last layer to the end depth
                kept[-1].bottom = d
                kept[-1].prov.y1 = L.prov.y1
                issues.append(f"notes block dropped, last layer extended to {d} m")
                continue
        kept.append(L)
    if end_depth is not None:
        for L in kept:
            if not math.isnan(L.top) and L.top >= end_depth - 0.05:
                issues.append(f"dropped text below end of hole ({end_depth} m): {L.description[:40]!r}")
        kept = [L for L in kept if math.isnan(L.top) or L.top < end_depth - 0.05]
    layers = kept

    # fill missing tops/bottoms from neighbours
    for i, L in enumerate(layers):
        if math.isnan(L.top):
            if i > 0 and not math.isnan(layers[i - 1].bottom):
                L.top = layers[i - 1].bottom
                issues.append(f"layer {i + 1}: top inferred from previous bottom")
            elif i == 0:
                L.top = 0.0
                issues.append("layer 1: top assumed 0.0")
        if math.isnan(L.bottom):
            if i + 1 < len(layers) and not math.isnan(layers[i + 1].top):
                L.bottom = layers[i + 1].top
                issues.append(f"layer {i + 1}: bottom inferred from next top")
    # contiguity
    for i in range(1, len(layers)):
        a, b = layers[i - 1], layers[i]
        if math.isnan(a.bottom) or math.isnan(b.top):
            continue
        gap = b.top - a.bottom
        if abs(gap) <= 0.1:
            b.top = a.bottom          # snap rounding differences (tick label vs ruling line)
        elif gap > 0:
            issues.append(f"gap of {gap:.2f} m between layer {i} and {i + 1}")
        else:
            issues.append(f"overlap of {-gap:.2f} m between layer {i} and {i + 1}")
    for i, L in enumerate(layers):
        if not math.isnan(L.top) and not math.isnan(L.bottom) and L.bottom < L.top:
            issues.append(f"layer {i + 1}: bottom above top")
    bh.layers = layers

    # borehole depth
    bottoms = [L.bottom for L in layers if not math.isnan(L.bottom)]
    max_bottom = max(bottoms) if bottoms else None
    md = bh.metadata.get("BoreholeDepth")
    if isinstance(md, (int, float)) and max_bottom is not None:
        last = max((L for L in layers if not math.isnan(L.bottom)), key=lambda L: L.bottom)
        if 0 < abs(last.bottom - md) <= 0.3:
            last.bottom = md          # scale rounding vs. printed total depth → trust the printed value
            max_bottom = md
        if md > 300:
            issues.append(f"BoreholeDepth {md} implausible — check")
        if md > max_bottom + 0.5:
            issues.append(f"BoreholeDepth {md} deeper than last layer {max_bottom:.2f} (log may be incomplete)")
        elif max_bottom > md + 0.5:
            issues.append(f"layers extend to {max_bottom:.2f} but BoreholeDepth is {md}")
    elif max_bottom is not None:
        bh.metadata["BoreholeDepth"] = round(max_bottom, 2)
        issues.append("BoreholeDepth taken from last layer bottom")
    if "BoreholeLength" not in bh.metadata and isinstance(bh.metadata.get("BoreholeDepth"), (int, float)):
        bh.metadata["BoreholeLength"] = bh.metadata["BoreholeDepth"]   # vertical hole assumed

    # point values
    bh.points = [p for p in bh.points if not (isinstance(p.depth, float) and p.depth < -0.05)]
    for p in bh.points:
        if p.kind == "SPT" and isinstance(p.value, (int, float)) and not (0 <= p.value <= 150):
            issues.append(f"SPT {p.value} at {p.depth} out of range")
        if p.kind in ("RQD", "TCR", "SCR") and isinstance(p.value, (int, float)) and not (0 <= p.value <= 100):
            issues.append(f"{p.kind} {p.value} at {p.depth} out of range")
        if isinstance(p.depth, float) and not math.isnan(p.depth) and max_bottom is not None and p.depth > max_bottom + 1:
            issues.append(f"{p.kind} at {p.depth} below last layer")

    # groundwater point → metadata
    if "Groundwaterlevel" not in bh.metadata:
        gw = [p for p in bh.points if p.kind == "GWL"]
        if gw:
            bh.metadata["Groundwaterlevel"] = gw[0].depth
            bh.meta_prov["Groundwaterlevel"] = gw[0].prov

    # name / layer sanity
    name = str(bh.metadata.get("BoreholeName", ""))
    if not re.search(r"\d", name):
        issues.append("BoreholeName has no number — check")
    if bh.metadata.get("_name_generated"):
        issues.append("BoreholeName not found in header — generated")
    for i, L in enumerate(layers):
        if not math.isnan(L.top) and not math.isnan(L.bottom) and L.bottom - L.top > 40:
            issues.append(f"layer {i + 1}: thickness {L.bottom - L.top:.1f} m implausible — check")

    # confidence
    confs = [L.prov.confidence for L in layers] + [pv.confidence for pv in bh.meta_prov.values()]
    base = sum(confs) / len(confs) if confs else 0.3
    penalty = 0.05 * len([i for i in issues if "gap" in i or "overlap" in i or "inferred" in i])
    penalty += 0.15 * len([i for i in issues if "check" in i or "generated" in i])
    ocr_pages = [L for L in layers if L.prov.confidence < 1.0]
    if ocr_pages:
        penalty += 0.05           # OCR'd source: never fully certain
    if any(L.prov.method == "llm-vision" for L in layers):
        penalty += 0.2
    if not layers:
        penalty += 0.4
    bh.metadata["_confidence"] = round(max(0.0, min(1.0, base - penalty)), 2)
    return bh
