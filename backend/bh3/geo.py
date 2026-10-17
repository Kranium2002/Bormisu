"""One coordinate reference system for the map: printed X/Y in whatever system -> WGS84 lat/lon.

Resolution per hole, each result tagged with `crs_status`:
  exact    the printed `CoordinateSystem` text parses to an EPSG code (table below)
  assumed  `crs_overrides.json` names the system for this document (with the evidence written next to it)
  unknown  no coordinates, or a system nobody can name -> no pin; the hole is listed, never guessed silently

Axis order is checked, not trusted: a projected pair is transformed as (x, y) and as (y, x) and the one that
lands inside the CRS's area of use wins (FullReport02 prints northing first; AF01 prints latitude in X).
Danish System 34 is west-orientated: its printed "E" is negated before the east-orientated reconstruction.
pyproj carries its own PROJ data, so this runs offline / on-prem. No model calls.
"""
from __future__ import annotations

import json
import logging
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

OVERRIDES_FILE = Path(__file__).with_name("crs_overrides.json")
# EPSG codes whose printed easting runs westward (System 34 reconstructions are east-orientated)
NEG_X = {10250, 10160}
OUTLIER_KM = 100.0        # a hole this far from its document's median is flagged, not pinned

# printed CoordinateSystem text -> EPSG. Ordered: the first match wins.
_EXACT: list[tuple[re.Pattern, Any]] = [
    (re.compile(r"NZTM|NZGD\s*2000|New Zealand Transverse", re.I), 2193),
    (re.compile(r"M(?:t|ount)\.?\s*Eden", re.I), 2105),
    (re.compile(r"MGA\s*2020|GDA\s*2020", re.I), lambda m, s: _zone(s, 7800)),
    (re.compile(r"MGA|GDA\s*94", re.I), lambda m, s: _zone(s, 28300)),
    (re.compile(r"\bS34S\b|System\s*34\s*S", re.I), 10250),
    (re.compile(r"\bS34J\b|System\s*34\s*J", re.I), 10160),
    (re.compile(r"UTM\s*32\s*E89|ETRS\s*89.*?32|EUREF\s*89.*?32", re.I), 25832),
    (re.compile(r"OSGB|British\s*National|\bBNG\b", re.I), 27700),
    (re.compile(r"SVY\s*21", re.I), 3414),
    (re.compile(r"HK\s*1980|HK\s*80\b|Hong\s*Kong\s*1980", re.I), 2326),
    (re.compile(r"NAD\s*83.*?UTM", re.I), lambda m, s: _zone(s, 26900)),
    (re.compile(r"UTM\s*(?:zone)?\s*(\d{1,2})\s*([NS])\b", re.I), lambda m, s: (32600 if m.group(2).upper() == "N" else 32700) + int(m.group(1))),
    (re.compile(r"WGS\s*84|lat(?:itude)?\s*/?\s*lon|geographic", re.I), 4326),
]


def _zone(s: str, base: int) -> Optional[int]:
    m = re.search(r"\b(\d{1,2})\s*[C-HJ-NP-X]?\b", s)
    if m and 1 <= int(m.group(1)) <= 60:
        return base + int(m.group(1))
    return None


def parse_crs(text: Optional[str]) -> Optional[int]:
    """EPSG for a printed coordinate-system string, or None when it is not unambiguous."""
    if not text:
        return None
    s = str(text)
    for rx, val in _EXACT:
        m = rx.search(s)
        if m:
            return val(m, s) if callable(val) else val
    return None


@lru_cache(maxsize=None)
def _crs(epsg: int):
    from pyproj import CRS
    return CRS.from_epsg(epsg)


@lru_cache(maxsize=None)
def _to_wgs84(epsg: int):
    from pyproj import Transformer
    return Transformer.from_crs(_crs(epsg), _crs(4326), always_xy=True)


def _in_area(epsg: int, lat: float, lon: float, margin: float = 0.5) -> bool:
    aou = _crs(epsg).area_of_use
    if aou is None:
        return True
    w, s, e, n = aou.bounds
    return (s - margin) <= lat <= (n + margin) and (w - margin) <= lon <= (e + margin)


def _num(v) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    m = re.search(r"-?\d+(?:[.,]\d+)?", str(v))
    return float(m.group(0).replace(",", ".")) if m else None


def transform(epsg: int, x: float, y: float, axis: str = "auto") -> Optional[tuple[float, float, str]]:
    """(lat, lon, axis_used) or None when neither axis order lands in the CRS's area of use."""
    if epsg in NEG_X:
        x = -x
    orders = {"xy": [("xy", x, y)], "yx": [("yx", y, x)]}.get(axis, [("xy", x, y), ("yx", y, x)])
    if epsg == 4326:
        for name, a, b in orders:
            lon, lat = a, b
            if abs(lat) <= 90 and abs(lon) <= 180:
                return lat, lon, name
        return None
    tr = _to_wgs84(epsg)
    for name, a, b in orders:
        try:
            lon, lat = tr.transform(a, b)
        except Exception:  # noqa: BLE001
            continue
        if math.isfinite(lat) and math.isfinite(lon) and _in_area(epsg, lat, lon):
            return lat, lon, name
    return None


@lru_cache(maxsize=1)
def overrides() -> dict:
    if OVERRIDES_FILE.exists():
        return json.loads(OVERRIDES_FILE.read_text(encoding="utf-8"))
    return {}


def locate(metadata: dict, source_file: str) -> dict:
    out: dict[str, Any] = {"lat": None, "lon": None, "epsg": None, "crs_status": "unknown", "crs_note": None}
    x, y = _num(metadata.get("X-Coordinate")), _num(metadata.get("Y-Coordinate"))
    if x is None or y is None:
        out["crs_note"] = "no coordinates printed"
        return out
    printed = metadata.get("CoordinateSystem")
    doc = Path(source_file or "").name
    ov = overrides().get(doc) or {}
    epsg = parse_crs(printed)
    if epsg:
        r = transform(epsg, x, y, ov.get("axis", "auto") if ov.get("epsg") == epsg else "auto")
        if r:
            out.update(lat=round(r[0], 6), lon=round(r[1], 6), epsg=epsg, crs_status="exact",
                       crs_note=f"printed '{printed}' -> EPSG:{epsg}" + (" (axes swapped)" if r[2] == "yx" else ""))
            return out
        out["crs_note"] = f"printed '{printed}' -> EPSG:{epsg} but the point falls outside its area"
    if ov.get("epsg"):
        cands = ov["epsg"] if isinstance(ov["epsg"], list) else [ov["epsg"]]
        for cand in cands:
            r = transform(int(cand), x, y, ov.get("axis", "auto"))
            if r:
                out.update(lat=round(r[0], 6), lon=round(r[1], 6), epsg=int(cand), crs_status="assumed",
                           crs_note=f"assumed EPSG:{cand} for {doc}: {ov.get('evidence', '')}".strip() + (" (axes swapped)" if r[2] == "yx" else ""))
                return out
        out["crs_note"] = f"assumed EPSG {cands} for {doc} but the point falls outside the area: {ov.get('evidence', '')}"
        return out
    if not out["crs_note"]:
        out["crs_note"] = (f"coordinate system '{printed}' not recognised" if printed else "coordinate system not printed") + \
                          f"; no assumption recorded for {doc} in crs_overrides.json"
    return out


def locate_boreholes(boreholes: list[dict]) -> dict:
    """Write lat/lon/epsg/crs_status/crs_note into every hole's metadata; return per-document counts + centroids."""
    docs: dict[str, dict] = {}
    for b in boreholes:
        m = b.setdefault("metadata", {})
        r = locate(m, b.get("source_file", ""))
        m.update(r)
        d = docs.setdefault(Path(b.get("source_file", "")).name, {"holes": 0, "located": 0, "exact": 0, "assumed": 0, "unknown": 0, "lats": [], "lons": []})
        d["holes"] += 1
        d[r["crs_status"]] += 1
        if r["lat"] is not None:
            d["located"] += 1
            d["lats"].append(r["lat"]); d["lons"].append(r["lon"])
    # a hole far from the others of its document is a misread coordinate, not a pin: flag it
    for b in boreholes:
        m = b["metadata"]
        if m.get("lat") is None:
            continue
        d = docs[Path(b.get("source_file", "")).name]
        if len(d["lats"]) < 3:
            continue
        lat0, lon0 = sorted(d["lats"])[len(d["lats"]) // 2], sorted(d["lons"])[len(d["lons"]) // 2]
        km = math.hypot((m["lat"] - lat0) * 111.0, (m["lon"] - lon0) * 111.0 * math.cos(math.radians(lat0)))
        if km > OUTLIER_KM:
            m["crs_status"] = "outlier"
            m["crs_note"] = f"{km:.0f} km from the document's other holes (misread coordinate?); " + str(m.get("crs_note") or "")
            d["located"] -= 1
            d["outlier"] = d.get("outlier", 0) + 1
    for d in docs.values():
        d["centroid"] = [round(sum(d["lats"]) / len(d["lats"]), 4), round(sum(d["lons"]) / len(d["lons"]), 4)] if d["lats"] else None
        del d["lats"], d["lons"]
    return {"documents": docs, "located": sum(d["located"] for d in docs.values()), "holes": sum(d["holes"] for d in docs.values())}
