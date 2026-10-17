"""bh3 borehole dict -> BoreholeRecord as the frontend adapter reads it (frontend/src/data/adapters.ts).

Rules: unknown is null, never a default; provenance keys are exactly the adapter's paths; a reviewer's
overlay wins over the extracted value (the AI value is kept in `ai_value`).
"""
from __future__ import annotations

import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

PAGE_TYPE = {"log": "log", "spt_sheet": "log", "lab": "lab_table", "narrative": "text", "cover": "text", "plot": "drawing",
             "photo": "photo", "other": "unknown", "unread": "unknown"}
METHOD = {"geometry": "read", "header-alias": "read", "header-regex": "read", "vlm": "ocr", "llm": "guessed", "derived": "derived"}
CRS_STATUS = {"exact": "stated", "assumed": "inferred", "confirmed": "confirmed", "unknown": "unknown", "outlier": "unknown"}
REFUSAL_RE = re.compile(r"\bR\b|refus|50\s*/\s*\d|^\s*>\s*50", re.I)


def _num(v) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    try:
        return float(str(v).replace(",", "."))
    except ValueError:
        return None


def _r(v, nd=2) -> Optional[float]:
    v = _num(v)
    return None if v is None else round(v, nd)


# ---------------------------------------------------------------------------
# page geometry (for normalised boxes)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=4096)
def page_height_pt(source: Optional[str], page_no: int) -> Optional[float]:
    """Height of a page in PDF points (the unit of bh3 provenance rows); None when the source is unreachable."""
    if not source or not Path(source).exists():
        return None
    try:
        from ..inputs import discover
        from ..render import page_size_pt
        for doc in discover([source]):
            for ps in doc.pages:
                if ps.page_no == page_no:
                    return page_size_pt(ps)[1]
    except Exception:  # noqa: BLE001
        return None
    return None


def row_box(prov: dict, source: Optional[str]) -> Optional[list[float]]:
    """[x, y, w, h] normalised 0-1 for the row a value sits in (contract §4.1 fallback); None without a position."""
    y0, y1 = _num(prov.get("y0")), _num(prov.get("y1"))
    if y0 is None or y1 is None or (y0 == 0 and y1 == 0):
        return None
    H = page_height_pt(source, int(prov.get("page") or 0))
    if not H:
        return None
    top, bot = sorted((y0, y1))
    y = max(0.0, min(1.0, top / H))
    h = max(0.004, min(1.0 - y, (bot - top) / H))
    return [0.0, round(y, 4), 1.0, round(h, 4)]


# ---------------------------------------------------------------------------
# provenance / overlay helpers
# ---------------------------------------------------------------------------

def _prov_entry(prov: Optional[dict], raw: Optional[str], source: Optional[str], ai_value, method_override: Optional[str] = None) -> dict:
    prov = prov or {}
    method = method_override or METHOD.get(str(prov.get("method") or ""), "guessed")
    return {"page": prov.get("page"), "box": row_box(prov, source), "raw": raw, "method": method,
            "confidence": _r(prov.get("confidence"), 2) if prov.get("confidence") is not None else None,
            "status": "unreviewed", "state": "ok", "ai_value": ai_value}


PATH_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?")


def get_path(obj: Any, path: str):
    cur = obj
    for m in PATH_RE.finditer(path):
        key, idx = m.group(1), m.group(2)
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
        if idx is not None:
            if not isinstance(cur, list) or int(idx) >= len(cur):
                return None
            cur = cur[int(idx)]
    return cur


def set_path(obj: Any, path: str, value) -> bool:
    parts = list(PATH_RE.finditer(path))
    cur = obj
    for i, m in enumerate(parts):
        key, idx = m.group(1), m.group(2)
        last = i == len(parts) - 1
        if not isinstance(cur, dict):
            return False
        if idx is None:
            if last:
                cur[key] = value
                return True
            cur = cur.setdefault(key, {})
        else:
            lst = cur.get(key)
            if not isinstance(lst, list) or int(idx) >= len(lst):
                return False
            if last:
                lst[int(idx)] = value
                return True
            cur = lst[int(idx)]
    return False


def apply_overlay(record: dict, overlay: dict) -> dict:
    """Review overlay of one uid onto a mapped record: status / state / flag, edited values with method edited."""
    prov = record.setdefault("provenance", {})
    for path, ov in (overlay or {}).items():
        p = prov.setdefault(path, {"page": None, "box": None, "raw": None, "method": "guessed", "confidence": None,
                                   "status": "unreviewed", "state": "ok", "ai_value": get_path(record, path)})
        if "status" in ov:
            p["status"] = ov["status"]
        if "state" in ov:
            p["state"] = ov["state"]
        if "flag" in ov:
            p["flag"] = ov["flag"]
        elif "flag" in p:
            del p["flag"]
        if "value" in ov:
            p["method"] = "edited"
            if "ai_value" in ov:
                p["ai_value"] = ov["ai_value"]
            set_path(record, path, ov["value"])
    if any(v.get("status") in ("approved", "flagged") for v in prov.values()):
        record["review_status"] = "reviewed" if all(v.get("status") == "approved" or v.get("state") != "ok" for v in prov.values()) else "unreviewed"
    return record


# ---------------------------------------------------------------------------
# borehole -> BoreholeRecord
# ---------------------------------------------------------------------------

def _spt_fields(points: list[dict], top: Optional[float], bot: Optional[float]) -> dict:
    """SPT of a layer from the point values inside its interval (first test wins; the rest stay in points)."""
    for p in points:
        if p.get("kind") != "SPT":
            continue
        d = _num(p.get("depth"))
        if d is None or top is None or bot is None or not (top - 1e-6 <= d < bot + 1e-6):
            continue
        label = str(p.get("label") or "")
        raw = label or (str(p.get("value")) if p.get("value") is not None else None)
        refusal = bool(REFUSAL_RE.search(label)) or (isinstance(p.get("value"), str) and bool(REFUSAL_RE.search(p["value"])))
        n = _num(p.get("value")) if not refusal else None
        inc = [int(x) for x in re.findall(r"\d+", re.search(r"\[([^\]]*)\]", label).group(1))] if re.search(r"\[([^\]]*)\]", label) else None
        return {"spt_n_value": int(n) if n is not None and float(n).is_integer() else n, "spt_raw": raw, "spt_refusal": refusal,
                "spt_increments": inc, "spt_penetration_cm": None, "spt_depth_m": _r(d), "_prov": p.get("prov")}
    return {"spt_n_value": None, "spt_raw": None, "spt_refusal": None, "spt_increments": None, "spt_penetration_cm": None,
            "spt_depth_m": None, "_prov": None}


def _lint(b: dict, n_layers: int) -> list[dict]:
    out = []
    for issue in b.get("issues") or []:
        text = re.sub(r"^p\d+:\s*", "", str(issue))
        m = re.search(r"(gap|overlap) of ([\d.]+) m between layer (\d+) and (\d+)", text)
        if m:
            i = int(m.group(3)) - 1
            out.append({"path": f"stratigraphy[{i}].depth_to_m", "rule": f"layer_{m.group(1)}", "severity": "warning", "message": text})
            continue
        m = re.search(r"layer (\d+): (bottom above top|thickness)", text)
        if m:
            out.append({"path": f"stratigraphy[{int(m.group(1)) - 1}].depth_to_m", "rule": "layer_geometry", "severity": "error", "message": text})
            continue
        if re.search(r"BoreholeDepth|deeper than last layer|extend to", text):
            out.append({"path": "metadata.borehole_depth_m", "rule": "log_bottom_vs_final_depth",
                        "severity": "error" if "implausible" in text or "≠" in text else "warning", "message": text})
            continue
        m = re.search(r"^(SPT|RQD|TCR) [^ ]+ at ([\d.]+) (out of range|below last layer)", text)
        if m:
            out.append({"path": "metadata.borehole_depth_m", "rule": "value_range", "severity": "warning", "message": text})
            continue
        if re.search(r"overlap|disagree|check|generated|not found", text, re.I):
            out.append({"path": "metadata.borehole_id", "rule": "extraction", "severity": "warning", "message": text})
    return out


def english_lithology(L: dict) -> Optional[str]:
    parts = [L.get("consistency"), L.get("color"), L.get("lithology")]
    s = " ".join(str(p) for p in parts if p and str(p).lower() not in ("unknown", "none"))
    return s or None


def map_borehole(b: dict, document_id: str, uid: str, source: Optional[str], confirmed_crs: Optional[dict] = None) -> dict:
    m = b.get("metadata") or {}
    mp = b.get("meta_prov") or {}
    extra = m.get("_extra") or {}
    points = b.get("points") or []
    prov: dict[str, dict] = {}

    def meta_prov(key: str, path: str, raw_override: Optional[str] = None, method: Optional[str] = None):
        if m.get(key) is None:
            return
        prov[path] = _prov_entry(mp.get(key), raw_override if raw_override is not None else (str(m.get(key)) if m.get(key) is not None else None), source, m.get(key), method)

    lat, lon, status, epsg, note = m.get("lat"), m.get("lon"), m.get("crs_status", "unknown"), m.get("epsg"), m.get("crs_note")
    if confirmed_crs and _num(m.get("X-Coordinate")) is not None and _num(m.get("Y-Coordinate")) is not None:
        from ..geo import transform
        r = transform(int(confirmed_crs["epsg"]), _num(m["X-Coordinate"]), _num(m["Y-Coordinate"]), confirmed_crs.get("axis", "auto"))
        if r:
            lat, lon, status, epsg = round(r[0], 6), round(r[1], 6), "confirmed", int(confirmed_crs["epsg"])
            note = f"confirmed EPSG:{epsg} by {confirmed_crs.get('confirmed_by') or 'reviewer'}"
    plotted = lat is not None and lon is not None and status != "outlier"
    unplotted = None if plotted else ("outlier" if status == "outlier" else ("no coordinates" if _num(m.get("X-Coordinate")) is None else "CRS unknown"))
    coord_system = m.get("CoordinateSystem") or (f"EPSG:{epsg}" if epsg and status in ("assumed", "confirmed") else None)

    layers_out = []
    layers = b.get("layers") or []
    for i, L in enumerate(layers):
        top, bot = _r(L.get("top")), _r(L.get("bottom"))
        lp = L.get("prov") or {}
        spt = _spt_fields(points, _num(L.get("top")), _num(L.get("bottom")))
        core_pts = [p for p in points if p.get("kind") in ("RQD", "TCR") and _num(p.get("depth")) is not None and top is not None and bot is not None
                    and top - 1e-6 <= _num(p["depth"]) < bot + 1e-6]
        rqd = next((_r(p.get("value")) for p in core_pts if p.get("kind") == "RQD" and _num(p.get("value")) is not None), None)
        tcr = next((_r(p.get("value")) for p in core_pts if p.get("kind") == "TCR" and _num(p.get("value")) is not None), None)
        lay = {
            "depth_from_m": top, "depth_to_m": bot,
            "thickness_m": None if top is None or bot is None else round(bot - top, 2),
            "original_description": L.get("description") or None,
            "english_lithology": english_lithology(L),
            "din4023_code": L.get("din_code") or None,
            "din_source": L.get("din_source"), "din_pattern": L.get("din_pattern"), "din_color": L.get("din_color"),
            "uscs_group": None if str(L.get("soil_unit") or "").upper() in ("", "UNKNOWN") else L.get("soil_unit"),
            "consistency_density": L.get("consistency") or None,
            "core": True if core_pts else (None if L.get("is_rock") is None else None),
            "rqd_pct": rqd, "core_recovery_pct": tcr,
            "spt_n_value": spt["spt_n_value"], "spt_raw": spt["spt_raw"], "spt_refusal": spt["spt_refusal"],
            "spt_increments": spt["spt_increments"], "spt_penetration_cm": spt["spt_penetration_cm"], "spt_depth_m": spt["spt_depth_m"],
            "symbol": L.get("symbol"),
        }
        layers_out.append(lay)
        base = f"stratigraphy[{i}]"
        if bot is not None:
            prov[f"{base}.depth_to_m"] = _prov_entry(lp, str(L.get("bottom")), source, bot)
        if top is not None and i == 0:
            prov[f"{base}.depth_from_m"] = _prov_entry(lp, str(L.get("top")), source, top)
        prov[f"{base}.english_lithology"] = _prov_entry(lp, L.get("description"), source, lay["english_lithology"])
        prov[f"{base}.din4023_code"] = _prov_entry(lp, L.get("description"), source, lay["din4023_code"],
                                                   "derived" if L.get("din_source") in ("lithology", "words", "uscs", "legend", "ditto") else None)
        if spt["spt_n_value"] is not None or spt["spt_refusal"]:
            prov[f"{base}.spt_n_value"] = _prov_entry(spt["_prov"], spt["spt_raw"], source, spt["spt_n_value"])
        for kind, key in (("RQD", "rqd_pct"), ("TCR", "core_recovery_pct")):
            p = next((p for p in core_pts if p.get("kind") == kind), None)
            if p is not None and lay[key] is not None:
                prov[f"{base}.{key}"] = _prov_entry(p.get("prov"), str(p.get("label") or p.get("value")), source, lay[key])

    gw = []
    if _num(m.get("Groundwaterlevel")) is not None:
        gw.append({"type": "rest", "depth_m": _r(m["Groundwaterlevel"]), "date": None, "_prov": mp.get("Groundwaterlevel")})
    for p in points:
        if p.get("kind") == "GWL" and _num(p.get("depth")) is not None:
            if any(abs(g["depth_m"] - _r(p["depth"])) < 0.005 for g in gw):
                continue
            gw.append({"type": "strike", "depth_m": _r(p["depth"]), "date": None, "_prov": p.get("prov"), "_raw": p.get("label")})
    for i, g in enumerate(gw):
        prov[f"groundwater[{i}].depth_m"] = _prov_entry(g.pop("_prov", None), g.pop("_raw", None) or str(g["depth_m"]), source, g["depth_m"])

    rock = next((L for L in layers if L.get("is_rock")), None)
    rock_head = _r(rock.get("top")) if rock else None
    if rock_head is not None:
        prov["rock_head_m"] = _prov_entry(rock.get("prov"), None, source, rock_head, "derived")

    rec = {
        "uid": uid, "document_id": document_id, "source_file": Path(b.get("source_file") or "").name or None,
        "review_status": "unreviewed", "crs_status": CRS_STATUS.get(status, "unknown"), "plotted": plotted, "unplotted_reason": unplotted,
        "crs_note": note, "rock_head_m": rock_head,
        "metadata": {
            "borehole_id": m.get("BoreholeName") or b.get("borehole_id"), "borehole_name": m.get("BoreholeName"),
            "location_name": m.get("LocationName"), "project_id": m.get("ProjectID"), "project_name": m.get("ProjectName"),
            "client": extra.get("Client") or m.get("Client"), "drilling_contractor": extra.get("Contractor") or m.get("Contractor"),
            "drilling_date": m.get("StartDate"), "end_date": m.get("EndDate"), "drilling_method": extra.get("Method"),
            "surface_elevation_mASL": _r(m.get("Surface Elevation")), "borehole_depth_m": _r(m.get("BoreholeDepth")),
            "borehole_length_m": _r(m.get("BoreholeLength")), "notes": m.get("Notes") or None,
            "coordinates": {"latitude": lat, "longitude": lon, "local_x": _num(m.get("X-Coordinate")), "local_y": _num(m.get("Y-Coordinate")),
                            "coordinate_system": coord_system, "epsg": epsg},
        },
        "stratigraphy": layers_out,
        "groundwater": gw,
        "geotechnical_tests": {"water_table_m": gw[0]["depth_m"] if gw else None},
        "pages": b.get("pages") or [],
        "confidence": m.get("_confidence"), "route": m.get("_route"), "read_quality": m.get("_read_quality"),
        "name_generated": bool(m.get("_name_generated")),
        "provenance": prov,
        "lint": _lint(b, len(layers)),
    }
    meta_prov("BoreholeName", "metadata.borehole_id")
    meta_prov("ProjectName", "metadata.project_name")
    meta_prov("LocationName", "metadata.location_name")
    meta_prov("StartDate", "metadata.drilling_date")
    meta_prov("BoreholeDepth", "metadata.borehole_depth_m")
    meta_prov("Surface Elevation", "metadata.surface_elevation_mASL")
    meta_prov("X-Coordinate", "metadata.coordinates.local_x")
    meta_prov("Y-Coordinate", "metadata.coordinates.local_y")
    meta_prov("CoordinateSystem", "metadata.coordinates.coordinate_system")
    if lat is not None and "metadata.coordinates.local_x" in prov:
        for k in ("latitude", "longitude"):
            prov[f"metadata.coordinates.{k}"] = {**prov["metadata.coordinates.local_x"], "method": "derived",
                                                  "raw": None, "ai_value": lat if k == "latitude" else lon}
    return rec


# ---------------------------------------------------------------------------
# document
# ---------------------------------------------------------------------------

def _page_types_from_results(page_results) -> list[dict]:
    out = []
    for pr in page_results:
        t = PAGE_TYPE.get(pr.page_type, "unknown")
        used = pr.is_log and (bool(pr.layers) or bool(pr.points))
        reason = None if used else (pr.page_type if pr.page_type not in ("log", "spt_sheet") else "nothing read")
        out.append({"n": pr.page_no, "type": t, "used": used, "unused_reason": reason, "route": pr.route})
    return out


def document_from_result(document_id: str, file_name: str, holes: list[dict], source_path: Optional[str], store, page_results=None,
                         expected_ids: Optional[list[str]] = None) -> dict:
    layers = sum(len(b.get("layers") or []) for b in holes)
    spt = sum(1 for b in holes for p in (b.get("points") or []) if p.get("kind") == "SPT")
    gw = sum(1 for b in holes for p in (b.get("points") or []) if p.get("kind") == "GWL") + sum(1 for b in holes if _num((b.get("metadata") or {}).get("Groundwaterlevel")) is not None)
    used_pages = sorted({pn for b in holes for pn in (b.get("pages") or [])})
    if page_results is not None:
        pages = _page_types_from_results(page_results)
        page_count = len(pages)
    else:
        page_count = _page_count(source_path) or (max(used_pages) if used_pages else 0)
        pages = [{"n": n, "type": "log" if n in used_pages else "unknown", "used": n in used_pages,
                  "unused_reason": None if n in used_pages else "not a log page"} for n in range(1, page_count + 1)]
    found_ids = [(b.get("metadata") or {}).get("BoreholeName") for b in holes if not (b.get("metadata") or {}).get("_name_generated")]
    found_ids = [x for x in found_ids if x]
    completeness = None
    if expected_ids:
        exp = [e for e in expected_ids if e]
        completeness = {"expected_ids": exp, "found_ids": found_ids, "missing": [e for e in exp if e not in found_ids],
                        "unexpected": [f for f in found_ids if f not in exp]}
    return {"document_id": document_id, "file_name": file_name, "source_path": source_path, "status": "needs_review", "error": None,
            "page_count": page_count, "found": {"boreholes": len(holes), "layers": layers, "spt": spt, "groundwater": gw},
            "pages": pages, "completeness": completeness}


def _page_count(source_path: Optional[str]) -> Optional[int]:
    if not source_path or not Path(source_path).exists():
        return None
    try:
        from ..inputs import discover
        docs = discover([source_path])
        return len(docs[0].pages) if docs else None
    except Exception:  # noqa: BLE001
        return None


def public_document(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k not in ("source_path", "imported_from")}
