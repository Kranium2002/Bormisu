"""Score a boreholes.json (bh3 output) against hand-labelled pages in tests/golden/*.json.

    python -m bh3 eval out2/boreholes.json [--golden tests/golden] [--tol 0.15] [--json scores.json]

Golden file format (one per page):
  {"source": "MEA03-jpg/BH-1.jpg", "page": 1, "borehole_name": "1", "depth_unit": "m", "total_depth": 8.0,
   "groundwater": [2.0], "layers": [{"top": 0.0, "bottom": 1.0, "starts_with": "Silty Sand"}, ...],
   "layers_complete": true, "spt": [{"depth": 0.5, "n": 9}, ...], "header": {"ProjectID": "..."} , "notes": "..."}
Matching: a result borehole contributes to a golden page when any of its layers/points has prov.file whose
basename equals the golden source basename (or, for folders, the page image name) and prov.page == page.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any, Optional


def _norm(s: Any) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def _num(v) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    m = re.search(r"[-+]?\d+(?:[.,]\d+)?", str(v))
    return float(m.group(0).replace(",", ".")) if m else None


def _basename(p: str) -> str:
    return Path(str(p).replace("\\", "/")).name.lower()


def _golden_names(g: dict) -> set[str]:
    src = str(g["source"]).replace("\\", "/")
    names = {Path(src).name.lower()}
    # a folder document reports the folder as source_file; accept the folder name too
    if "/" in src:
        names.add(Path(src).parent.name.lower())
    return names


def _page_items(results: list[dict], g: dict) -> tuple[list[dict], list[dict], list[dict]]:
    names = _golden_names(g)
    page = int(g.get("page", 1))
    layers, points, bhs = [], [], []
    for b in results:
        hit = False
        for L in b.get("layers", []):
            pv = L.get("prov", {})
            if _basename(pv.get("file", "")) in names and int(pv.get("page", -1)) == page:
                layers.append(L)
                hit = True
        for p in b.get("points", []):
            pv = p.get("prov", {})
            if _basename(pv.get("file", "")) in names and int(pv.get("page", -1)) == page:
                points.append(p)
                hit = True
        if not hit and _basename(b.get("source_file", "")) in names and page in (b.get("pages") or []):
            hit = True
        if hit:
            bhs.append(b)
    return layers, points, bhs


def _values_equal(a, b) -> bool:
    na, nb = _num(a), _num(b)
    if na is not None and nb is not None and not (isinstance(a, str) and re.search(r"[A-Za-z]{3,}", a)):
        return abs(na - nb) <= max(0.01, 0.001 * abs(nb))
    return _norm(a) == _norm(b)


def score_page(g: dict, results: list[dict], tol: float = 0.15) -> dict:
    layers, points, bhs = _page_items(results, g)
    row: dict[str, Any] = {"page": f"{g['source']} p{g.get('page', 1)}", "missing": not bhs,
                           "layers_expected": len(g.get("layers", [])), "layers_found": len(layers)}
    # boundaries
    gb = sorted({float(v) for L in g.get("layers", []) for v in (L.get("top"), L.get("bottom")) if v is not None})
    pb = sorted({float(v) for L in layers for v in (L.get("top"), L.get("bottom")) if v is not None and not (isinstance(v, float) and math.isnan(v))})
    if gb and pb:
        errs = [min(abs(b - p) for p in pb) for b in gb]
        row["boundary_mae"] = round(sum(errs) / len(errs), 3)
        row["boundaries_within_tol"] = round(sum(1 for e in errs if e <= tol) / len(errs), 2)
    else:
        row["boundary_mae"] = None
        row["boundaries_within_tol"] = 0.0 if gb else None
    # descriptions
    gl = g.get("layers", [])
    if gl:
        ok = 0
        for L in gl:
            sw = _norm(L.get("starts_with"))[:12]
            if not sw:
                continue
            for P in layers:
                t = P.get("top")
                if t is None or (isinstance(t, float) and math.isnan(t)) or L.get("top") is None:
                    near = True
                else:
                    near = abs(float(t) - float(L["top"])) <= max(tol, 0.5)
                if near and sw in _norm(P.get("description")):
                    ok += 1
                    break
        row["desc_match"] = round(ok / len(gl), 2)
    else:
        row["desc_match"] = None
    # SPT
    gs = g.get("spt", [])
    ps = [p for p in points if p.get("kind") == "SPT"]
    row["spt_expected"], row["spt_found"] = len(gs), len(ps)
    if gs:
        hit = 0
        for s in gs:
            for p in ps:
                d = _num(p.get("depth"))
                if d is None or abs(d - float(s["depth"])) > 0.3:
                    continue
                pv = p.get("value") if p.get("value") is not None else p.get("label")
                if _values_equal(pv, s.get("n")) or (_num(pv) is not None and _num(s.get("n")) is not None and abs(_num(pv) - _num(s.get("n"))) < 0.5):
                    hit += 1
                    break
        row["spt_recall"] = round(hit / len(gs), 2)
    else:
        row["spt_recall"] = None
    # scalars
    meta = (bhs[0].get("metadata", {}) if bhs else {})
    if g.get("total_depth") is not None:
        md = _num(meta.get("BoreholeDepth"))
        row["total_depth_ok"] = md is not None and abs(md - float(g["total_depth"])) <= 0.3
    else:
        row["total_depth_ok"] = None
    if g.get("groundwater"):
        gw = _num(meta.get("Groundwaterlevel"))
        gwp = [_num(p.get("depth")) for p in points if p.get("kind") == "GWL"]
        row["gw_ok"] = any(v is not None and abs(v - float(g["groundwater"][0])) <= 0.3 for v in [gw] + gwp)
    else:
        row["gw_ok"] = None
    if g.get("borehole_name") is not None:
        got = _norm(meta.get("BoreholeName"))
        want = _norm(g["borehole_name"])
        row["name_ok"] = bool(got) and (got == want or re.sub(r"[^a-z0-9]", "", got) == re.sub(r"[^a-z0-9]", "", want))
    else:
        row["name_ok"] = None
    hdr = g.get("header", {})
    row["header_expected"] = len(hdr)
    ex = meta.get("_extra", {}) if isinstance(meta.get("_extra"), dict) else {}
    row["header_exact"] = sum(1 for k, v in hdr.items() if _values_equal(meta.get(k, ex.get(k)), v))
    row["notes"] = g.get("notes", "")
    return row


def evaluate(result_json: Path | list[Path], golden_dir: Path, tol: float = 0.15) -> list[dict]:
    paths = result_json if isinstance(result_json, list) else [result_json]
    results: list[dict] = []
    for rp in paths:
        results += json.loads(Path(rp).read_text(encoding="utf-8"))
    rows = []
    for gf in sorted(Path(golden_dir).glob("*.json")):
        g = json.loads(gf.read_text(encoding="utf-8"))
        rows.append(score_page(g, results, tol))
    return rows


def _fmt(v) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "NO"
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


def print_table(rows: list[dict]) -> None:
    cols = [("page", 32), ("layers_found", 6), ("layers_expected", 6), ("boundary_mae", 7), ("boundaries_within_tol", 7),
            ("desc_match", 6), ("spt_found", 5), ("spt_expected", 5), ("spt_recall", 6), ("total_depth_ok", 5), ("gw_ok", 5),
            ("name_ok", 5), ("header_exact", 4), ("header_expected", 4)]
    head = {"layers_found": "Lf", "layers_expected": "Le", "boundary_mae": "bMAE", "boundaries_within_tol": "b<tol", "desc_match": "desc",
            "spt_found": "Sf", "spt_expected": "Se", "spt_recall": "sptR", "total_depth_ok": "depth", "gw_ok": "gw", "name_ok": "name",
            "header_exact": "Hx", "header_expected": "He", "page": "page"}
    print(" ".join(f"{head[c]:<{w}}" for c, w in cols))
    for r in rows:
        print(" ".join(f"{(_fmt(r.get(c)) + (' (missing)' if c == 'page' and r.get('missing') else ''))[:w]:<{w}}" for c, w in cols))
    n = len(rows) or 1
    def avg(key):
        vals = [r[key] for r in rows if isinstance(r.get(key), (int, float)) and not isinstance(r.get(key), bool)]
        return sum(vals) / len(vals) if vals else None
    def frac(key):
        vals = [r[key] for r in rows if isinstance(r.get(key), bool)]
        return (sum(1 for v in vals if v) / len(vals)) if vals else None
    print(f"\n{len(rows)} pages: boundary MAE {_fmt(avg('boundary_mae'))} m, boundaries within tol {_fmt(avg('boundaries_within_tol'))}, "
          f"desc match {_fmt(avg('desc_match'))}, SPT recall {_fmt(avg('spt_recall'))}, depth ok {_fmt(frac('total_depth_ok'))}, "
          f"gw ok {_fmt(frac('gw_ok'))}, name ok {_fmt(frac('name_ok'))}, header exact "
          f"{sum(r['header_exact'] for r in rows)}/{sum(r['header_expected'] for r in rows)}, missing pages {sum(1 for r in rows if r['missing'])}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="bh3 eval")
    ap.add_argument("result", nargs="+", help="one or more boreholes.json files (concatenated)")
    ap.add_argument("--golden", default=str(Path(__file__).resolve().parent.parent / "tests" / "golden"))
    ap.add_argument("--tol", type=float, default=0.15)
    ap.add_argument("--json", default=None)
    a = ap.parse_args(argv)
    rows = evaluate([Path(r) for r in a.result], Path(a.golden), a.tol)
    print_table(rows)
    if a.json:
        Path(a.json).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
