"""The website-ready data product (what a borehole map such as bohrungen.lgrb-bw.de shows).

    site/
      boreholes.geojson      one Point per located hole: the map layer
      profiles/<slug>.json   master data + layer table (Schichtenverzeichnis) + points + provenance per hole
      pages/<doc>/pNNN.jpg   the source page images (200 dpi) so a UI can show the scan behind every value
      index.json             documents, counts, CRS status, the DIN 4023 legend, coverage

Input is the list of borehole dicts from boreholes.json (any bh3 run, or an older run). Two deterministic
enrichments run first when their modules are present: `din.classify_boreholes` (petrography codes) and
`geo.locate_boreholes` (lat/lon). No model calls anywhere in this module.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import re
import shutil
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

PAGE_IMAGE_DPI = 200
MASTER_KEYS = ["BoreholeName", "LocationName", "StartDate", "EndDate", "ProjectID", "ProjectName", "Surface Elevation",
               "X-Coordinate", "Y-Coordinate", "CoordinateSystem", "BoreholeDepth", "BoreholeLength", "Groundwaterlevel"]


# ---------------------------------------------------------------------------
# enrichment (optional modules)
# ---------------------------------------------------------------------------

def enrich(boreholes: list[dict]) -> dict:
    """Run din + geo in place on borehole dicts. Returns a report dict (what ran, coverage)."""
    report: dict[str, Any] = {}
    try:
        from .din import classify_boreholes
        report["din"] = classify_boreholes(boreholes)
    except ImportError as e:
        report["din"] = {"error": f"din module not available: {e}"}
    try:
        from .geo import locate_boreholes
        report["geo"] = locate_boreholes(boreholes)
    except ImportError as e:
        report["geo"] = {"error": f"geo module not available: {e}"}
    return report


def enrich_objects(boreholes: list) -> dict:
    """Same for Borehole dataclasses (used at the end of `run`): enrich dict views, copy the fields back."""
    from dataclasses import asdict
    views = [asdict(b) for b in boreholes]
    report = enrich(views)
    for b, v in zip(boreholes, views):
        for k in ("lat", "lon", "epsg", "crs_status", "crs_note"):
            if k in v.get("metadata", {}):
                b.metadata[k] = v["metadata"][k]
        for L, Lv in zip(b.layers, v.get("layers", [])):
            for k in ("din_code", "din_color", "din_pattern", "din_source"):
                if k in Lv:
                    setattr(L, k, Lv[k])
            if "needs_review" in Lv:
                L.__dict__["_needs_review"] = Lv["needs_review"]
    return report


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def slugify(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", str(s)).strip("_")
    return s[:80] or "hole"


def _doc_name(b: dict) -> str:
    return Path(b.get("source_file") or "").name or "document"


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return None if v != v else float(v)
    try:
        return float(str(v).replace(",", "."))
    except ValueError:
        return None


def _prov(p: Optional[dict]) -> dict:
    p = p or {}
    return {"file": Path(p.get("file") or "").name, "page": p.get("page"), "y0": p.get("y0"), "y1": p.get("y1"),
            "method": p.get("method"), "confidence": p.get("confidence")}


def _page_image(src_file: str, page_no: int, workdir: Optional[Path]) -> Optional[Path]:
    """Cached 200-dpi render of a page, rendering it when the source is reachable and nothing is cached."""
    if not src_file:
        return None
    from .render import file_sha1, render_page, image_ok
    src = Path(src_file)
    if workdir is None or not src.exists():
        return None
    d = Path(workdir) / "render" / file_sha1(src)
    for name in (f"p{page_no:03d}_{PAGE_IMAGE_DPI}_rot90.jpg", f"p{page_no:03d}_{PAGE_IMAGE_DPI}.jpg"):
        p = d / name
        if p.exists() and image_ok(p):
            return p
    try:
        from .inputs import discover
        for doc in discover([str(src)]):
            for ps in doc.pages:
                if ps.page_no == page_no:
                    return render_page(ps, PAGE_IMAGE_DPI, Path(workdir))
    except Exception as e:  # noqa: BLE001
        log.warning("could not render %s p%d: %s", src, page_no, e)
    return None


# ---------------------------------------------------------------------------
# per-hole profile
# ---------------------------------------------------------------------------

def profile(b: dict, slug: str, page_images: dict[int, str]) -> dict:
    m = b.get("metadata") or {}
    extra = m.get("_extra") or {}
    layers = []
    pts = b.get("points") or []
    for i, L in enumerate(b.get("layers") or [], start=1):
        top, bot = _num(L.get("top")), _num(L.get("bottom"))
        in_layer = [p for p in pts if _num(p.get("depth")) is not None and top is not None and bot is not None
                    and top - 1e-6 <= (_num(p.get("depth")) if p.get("depth_to") is None else (_num(p.get("depth")) + (_num(p.get("depth_to")) or _num(p.get("depth")))) / 2) < bot + 1e-6]
        layers.append({
            "no": i, "from": top, "to": bot, "thickness": None if top is None or bot is None else round(bot - top, 2),
            "petrography": L.get("din_code"), "din_color": L.get("din_color"), "din_pattern": L.get("din_pattern"),
            "din_source": L.get("din_source"), "needs_review": bool(L.get("needs_review", L.get("_needs_review", False))),
            "lithology": L.get("lithology"), "uscs": L.get("soil_unit"),
            "stratigraphy": L.get("stratigraphic_name") or None, "age": L.get("geologic_age") or None,
            "color": L.get("color") or None, "consistency": L.get("consistency") or None, "moisture": L.get("moisture") or None,
            "is_rock": L.get("is_rock"), "description": L.get("description"),
            "spt": [p.get("value") if p.get("value") is not None else p.get("label") for p in in_layer if p.get("kind") == "SPT"],
            "samples": [p.get("value") or p.get("label") for p in in_layer if p.get("kind") == "SAMPLE"],
            "confidence": (L.get("prov") or {}).get("confidence"),
            "provenance": _prov(L.get("prov")),
        })
    points = [{"kind": p.get("kind"), "depth": _num(p.get("depth")), "depth_to": _num(p.get("depth_to")), "value": p.get("value"),
               "label": p.get("label"), "provenance": _prov(p.get("prov"))} for p in pts]
    gw = [_num(p.get("depth")) for p in pts if p.get("kind") == "GWL" and _num(p.get("depth")) is not None]
    if _num(m.get("Groundwaterlevel")) is not None and _num(m.get("Groundwaterlevel")) not in gw:
        gw.insert(0, _num(m.get("Groundwaterlevel")))
    master = {k: m.get(k) for k in MASTER_KEYS}
    master.update({
        "lat": m.get("lat"), "lon": m.get("lon"), "epsg": m.get("epsg"), "crs_status": m.get("crs_status", "unknown"),
        "crs_note": m.get("crs_note"), "Client": extra.get("Client") or m.get("Client"), "Contractor": extra.get("Contractor") or m.get("Contractor"),
        "Method": extra.get("Method"), "Inclination": extra.get("Inclination"), "document": _doc_name(b), "pages": b.get("pages") or [],
        "confidence": m.get("_confidence"), "route": m.get("_route"), "read_quality": m.get("_read_quality"),
        "name_generated": bool(m.get("_name_generated")),
    })
    return {"id": b.get("borehole_id"), "slug": slug, "master": master, "layers": layers, "points": points,
            "groundwater": gw, "issues": b.get("issues") or [],
            "pages": [{"page": pn, "image": page_images.get(pn), "dpi": PAGE_IMAGE_DPI} for pn in (b.get("pages") or [])]}


def feature(b: dict, slug: str) -> Optional[dict]:
    m = b.get("metadata") or {}
    lat, lon = _num(m.get("lat")), _num(m.get("lon"))
    if lat is None or lon is None or m.get("crs_status") == "outlier":
        return None
    extra = m.get("_extra") or {}
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": {"id": b.get("borehole_id"), "slug": slug, "name": m.get("BoreholeName"), "document": _doc_name(b),
                           "pages": b.get("pages") or [], "depth": _num(m.get("BoreholeDepth")), "elevation": _num(m.get("Surface Elevation")),
                           "date": m.get("StartDate"), "method": extra.get("Method"), "project": m.get("ProjectName") or m.get("ProjectID"),
                           "location": m.get("LocationName"), "n_layers": len(b.get("layers") or []),
                           "confidence": m.get("_confidence"), "crs_status": m.get("crs_status", "unknown"), "epsg": m.get("epsg"),
                           "profile": f"profiles/{slug}.json"}}


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def build_site(boreholes: list[dict], out_dir: Path, workdir: Optional[Path] = None, copy_pages: bool = True,
               source: Optional[Path] = None, enrich_first: bool = True) -> dict:
    out_dir = Path(out_dir)
    (out_dir / "profiles").mkdir(parents=True, exist_ok=True)
    report = enrich(boreholes) if enrich_first else {}

    # unique slugs
    slugs: dict[str, str] = {}
    used: Counter = Counter()
    for b in boreholes:
        s = slugify(b.get("borehole_id") or "hole")
        used[s] += 1
        slugs[id(b)] = s if used[s] == 1 else f"{s}_{used[s]}"

    features, unlocated = [], []
    by_doc: dict[str, dict] = defaultdict(lambda: {"holes": 0, "located": 0, "crs": Counter(), "layers": 0, "coded": 0, "pages": set()})
    page_files: dict[tuple[str, int], Optional[str]] = {}
    n_layers = n_coded = 0
    src_counter: Counter = Counter()
    for b in boreholes:
        slug = slugs[id(b)]
        doc = _doc_name(b)
        d = by_doc[doc]
        d["holes"] += 1
        d["crs"][(b.get("metadata") or {}).get("crs_status", "unknown")] += 1
        for L in b.get("layers") or []:
            n_layers += 1; d["layers"] += 1
            if L.get("din_code"):
                n_coded += 1; d["coded"] += 1
            src_counter[L.get("din_source") or "none"] += 1
        imgs: dict[int, str] = {}
        for pn in b.get("pages") or []:
            key = (b.get("source_file") or "", pn)
            if key not in page_files:
                rel = None
                if copy_pages:
                    p = _page_image(b.get("source_file") or "", pn, workdir)
                    if p is not None:
                        rel = f"pages/{slugify(Path(doc).stem)}/p{pn:03d}.jpg"
                        dst = out_dir / rel
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        if not dst.exists():
                            shutil.copyfile(p, dst)
                page_files[key] = rel
            if page_files[key]:
                imgs[pn] = page_files[key]
                d["pages"].add(pn)
        prof = profile(b, slug, imgs)
        (out_dir / "profiles" / f"{slug}.json").write_text(json.dumps(prof, ensure_ascii=False, indent=1), encoding="utf-8")
        f = feature(b, slug)
        if f:
            features.append(f); d["located"] += 1
        else:
            unlocated.append({"id": b.get("borehole_id"), "slug": slug, "document": doc, "name": (b.get("metadata") or {}).get("BoreholeName"),
                              "reason": (b.get("metadata") or {}).get("crs_note") or "no coordinates printed", "crs_status": (b.get("metadata") or {}).get("crs_status", "unknown")})

    (out_dir / "boreholes.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False), encoding="utf-8")
    legend = []
    try:
        from .din_codes import legend as din_legend
        legend = din_legend()
    except ImportError:
        pass
    src_hash = hashlib.sha1(Path(source).read_bytes()).hexdigest()[:12] if source and Path(source).exists() else None
    index = {
        "built": _dt.datetime.now().isoformat(timespec="seconds"), "source": str(source) if source else None, "source_sha1": src_hash,
        "page_image_dpi": PAGE_IMAGE_DPI,
        "counts": {"documents": len(by_doc), "boreholes": len(boreholes), "located": len(features), "unlocated": len(unlocated),
                   "layers": n_layers, "layers_with_code": n_coded, "layers_by_source": dict(src_counter)},
        "documents": [{"document": k, "holes": v["holes"], "located": v["located"], "crs_status": dict(v["crs"]), "layers": v["layers"],
                       "layers_with_code": v["coded"], "pages_with_image": len(v["pages"])} for k, v in sorted(by_doc.items())],
        "unlocated": unlocated, "din_legend": legend, "enrichment": report,
    }
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    return index


def print_index(index: dict) -> None:
    c = index["counts"]
    print(f"{'document':24} {'holes':>5} {'located':>7} {'exact':>5} {'assumed':>7} {'layers':>6} {'coded':>5} {'pages':>5}")
    for d in index["documents"]:
        cs = d["crs_status"]
        print(f"{d['document'][:24]:24} {d['holes']:>5} {d['located']:>7} {cs.get('exact', 0):>5} {cs.get('assumed', 0):>7} "
              f"{d['layers']:>6} {d['layers_with_code']:>5} {d['pages_with_image']:>5}")
    print(f"\n{c['boreholes']} holes in {c['documents']} documents: {c['located']} located, {c['unlocated']} without coordinates; "
          f"{c['layers_with_code']}/{c['layers']} layers with a DIN 4023 code  {c['layers_by_source']}")
    for k in ("din", "geo"):
        e = (index.get("enrichment") or {}).get(k) or {}
        if "error" in e:
            print(f"!! {e['error']}")
