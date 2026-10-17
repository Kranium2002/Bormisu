"""The routes (docs/design/api-contract.md, as frontend/src/data/apiSource.ts calls them)."""
from __future__ import annotations

import io
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .. import __version__
from .mapping import apply_overlay, get_path, map_borehole, public_document
from .store import TERMINAL, Store

log = logging.getLogger(__name__)
SUPPORTED = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".docx"}

try:
    from dotenv import load_dotenv
    load_dotenv()                      # the backend's .env (LLM_API_KEY, LLM_BASE_URL, SSL_CERT_FILE) decides live vs demo mode
except ImportError:                    # pragma: no cover
    pass


def live_mode() -> bool:
    """live when a model backend is configured: an API key, or a non-default base URL (a local server)."""
    key = os.environ.get("LLM_API_KEY") or os.environ.get("MISTRAL_API_KEY") or os.environ.get("OPENAI_API_KEY")
    base = os.environ.get("LLM_BASE_URL", "")
    return bool(key) or (bool(base) and "mistral.ai" not in base)


class Service:
    """Records of the store as BoreholeRecords, with a small cache per document (results change rarely)."""

    def __init__(self, store: Store):
        self.store = store

    def document_records(self, document_id: str) -> list[dict]:
        doc = self.store.document(document_id)
        if doc is None:
            return []
        holes = self.store.result(document_id)
        overlay = self.store.review(document_id)
        crs = self.store.crs(document_id)
        source = doc.get("source_path")
        seen: dict[str, int] = {}
        out = []
        for b in holes:
            name = (b.get("metadata") or {}).get("BoreholeName") or b.get("borehole_id") or "hole"
            uid = f"{document_id}:{name}"
            seen[uid] = seen.get(uid, 0) + 1
            if seen[uid] > 1:
                uid = f"{uid}#{seen[uid]}"
            rec = map_borehole(b, document_id, uid, source, crs)
            out.append(apply_overlay(rec, overlay.get(uid, {})))
        return out

    def all_records(self) -> list[dict]:
        out = []
        for did in self.store.document_ids():
            out += self.document_records(did)
        return out

    def record(self, uid: str) -> Optional[dict]:
        did = uid.split(":", 1)[0]
        for rec in self.document_records(did):
            if rec["uid"] == uid:
                return rec
        return None


# ---------------------------------------------------------------------------
# background extraction of an upload
# ---------------------------------------------------------------------------

def run_extraction(store: Store, document_id: str, path: Path) -> None:
    from ..assemble import finish
    from ..commands import _parse_pages  # noqa: F401  (keeps the import surface identical to the CLI)
    from ..extract import RouteConfig, process_document
    from ..inputs import discover
    from ..llm import LLM, LLMConfig
    from ..render import clear_cache
    from ..vlm import VLM
    from .mapping import document_from_result
    from dataclasses import asdict
    import json
    t0 = time.time()
    try:
        docs = discover([str(path)])
        if not docs:
            store.update_document(document_id, status="failed", error="unsupported file")
            return
        doc = docs[0]
        store.update_document(document_id, status="classifying", page_count=len(doc.pages))
        llm = LLM(LLMConfig(enabled=True))
        vlm = VLM(llm)
        cfg = RouteConfig()
        results = []
        for i, src in enumerate(doc.pages):
            from ..extract import process_page
            results.append(process_page(src, vlm, cfg, store.workdir))
            if i == 0:
                store.update_document(document_id, status="extracting")
        # document-level smoothing lives in process_document; re-run cheaply from cache for the page list
        results = process_document(doc, vlm, cfg, store.workdir)
        out_dir = store.result_dir(document_id)
        bhs = finish([(doc, results)], llm, out_dir)
        holes = json.loads((out_dir / "boreholes.json").read_text(encoding="utf-8"))
        expected = []
        for pr in results:
            for n in (pr.stats or {}).get("names") or []:
                if n and n not in expected:
                    expected.append(n)
        from ..assemble import _name_key
        from ..reconcile import clean_name
        found_keys = {_name_key((b.get("metadata") or {}).get("BoreholeName")) for b in holes}
        seen_keys: set = set()
        expected_ids = []
        for n in (clean_name(n) for n in expected):
            k = _name_key(n)
            if not n or not k or k in seen_keys:
                continue
            seen_keys.add(k)
            # the names the classifier saw, spelled as the extraction spelled them when they match ("BH2" = "BH 2")
            match = next((b for b in holes if _name_key((b.get("metadata") or {}).get("BoreholeName")) == k), None)
            expected_ids.append((match.get("metadata") or {}).get("BoreholeName") if match else n)
        d = document_from_result(document_id, store.document(document_id)["file_name"], holes, str(path), store, page_results=results,
                                 expected_ids=expected_ids)
        d.update({"status": "needs_review", "error": None, "seconds": round(time.time() - t0, 1),
                  "cost_usd": round(vlm.cost(), 3), "vision_calls": vlm.ledger.calls})
        with store.lock(document_id):
            cur = store.document(document_id) or {}
            cur.update(d)
            store.save_document(cur)
        clear_cache()
        log.info("%s: extracted %d holes in %.0fs (%s)", document_id, len(bhs), time.time() - t0, vlm.ledger.summary())
    except Exception as e:  # noqa: BLE001
        log.exception("%s: extraction failed", document_id)
        store.update_document(document_id, status="failed", error=f"{type(e).__name__}: {str(e)[:300]}")


# ---------------------------------------------------------------------------
# CRS candidates
# ---------------------------------------------------------------------------

COMMON_EPSG = [4326, 25832, 25833, 27700, 2193, 2105, 28355, 28356, 7855, 3414, 2326, 10250, 26910, 31983, 32629, 32636, 20439, 5187]


def crs_candidates(records: list[dict]) -> list[dict]:
    from ..geo import _crs, overrides, parse_crs, transform
    pts = [(r["uid"], r["metadata"]["coordinates"]["local_x"], r["metadata"]["coordinates"]["local_y"], r["metadata"]["coordinates"]["coordinate_system"],
            r.get("source_file")) for r in records
           if r["metadata"]["coordinates"]["local_x"] is not None and r["metadata"]["coordinates"]["local_y"] is not None]
    if not pts:
        return []
    cands: list[int] = []
    for _, _, _, cs, src in pts:
        e = parse_crs(cs)
        if e and e not in cands:
            cands.append(e)
        ov = overrides().get(src or "")
        if ov and ov.get("epsg"):
            for e in (ov["epsg"] if isinstance(ov["epsg"], list) else [ov["epsg"]]):
                if e and e not in cands:
                    cands.append(int(e))
    known = list(cands)                      # printed or recorded for this document: always listed, first
    cands += [e for e in COMMON_EPSG if e not in cands]
    xs = [p[1] for p in pts]
    if not known and all(100000 <= abs(x) <= 900000 for x in xs):
        # UTM-sized numbers with no system named: every zone places the points inside its own strip, so the
        # list can only offer the zones; the reviewer picks the one on the right continent on the mini map
        cands += [z for z in list(range(32601, 32661)) + list(range(32701, 32761)) if z not in cands]
    out = []
    for e in cands:
        try:
            name = _crs(e).name
        except Exception:  # noqa: BLE001
            continue
        placed = []
        for uid, x, y, _, _ in pts:
            r = transform(e, float(x), float(y))
            if r:
                placed.append({"uid": uid, "lat": round(r[0], 6), "lon": round(r[1], 6)})
        if placed or e in known:
            out.append({"crs": f"EPSG:{e}", "label": name, "points": placed})
    out.sort(key=lambda c: (0 if c["crs"] in {f"EPSG:{k}" for k in known} else 1, -len(c["points"])))
    return out[:12]


# ---------------------------------------------------------------------------
# app
# ---------------------------------------------------------------------------

def create_app(store: Store) -> FastAPI:
    svc = Service(store)
    app = FastAPI(title="bh3 API (Bormisu)", version=__version__, docs_url="/docs")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
    from fastapi.middleware.gzip import GZipMiddleware
    app.add_middleware(GZipMiddleware, minimum_size=1024)   # the full list with provenance is ~6 MB raw; dev proxies choke on that
    app.state.store = store

    @app.exception_handler(Exception)
    async def _generic(request: Request, exc: Exception):
        log.exception("unhandled error on %s", request.url.path)
        return JSONResponse(status_code=500, content={"error": "Internal Server Error", "detail": str(exc)})

    @app.get("/api/health")
    def health():
        return {"status": "healthy", "service": "bh3", "version": __version__, "mode": "live" if live_mode() else "demo",
                "standards": ["DIN 4023", "BoreholeDataFormat.xlsx"], "documents": len(store.document_ids())}

    for prefix in ("/api/v1", "/api"):
        _routes(app, prefix, store, svc)
    return app


def _routes(app: FastAPI, prefix: str, store: Store, svc: Service) -> None:
    def doc_or_404(document_id: str) -> dict:
        d = store.document(document_id)
        if d is None:
            raise HTTPException(404, detail=f"document '{document_id}' not found")
        return d

    @app.get(prefix + "/boreholes")
    def list_boreholes(search: Optional[str] = Query(None), document_id: Optional[str] = Query(None)):
        recs = svc.document_records(document_id) if document_id else svc.all_records()
        if search:
            s = search.lower()
            recs = [r for r in recs if s in " ".join(str(v) for v in (r["metadata"].get("borehole_id"), r["metadata"].get("project_name"),
                                                                         r["metadata"].get("location_name"), r.get("source_file")) if v).lower()]
        return {"count": len(recs), "boreholes": recs}

    @app.get(prefix + "/boreholes/{uid:path}/values")
    def _values_get(uid: str):
        raise HTTPException(405, detail="Method Not Allowed")

    @app.patch(prefix + "/boreholes/{uid:path}/values")
    def patch_value(uid: str, body: dict):
        rec = svc.record(uid)
        if rec is None:
            raise HTTPException(404, detail=f"borehole '{uid}' not found")
        path, action = body.get("path"), body.get("action")
        if not path or action not in ("approve", "edit", "flag", "set_state", "reset"):
            raise HTTPException(422, detail="body needs 'path' and an 'action' of approve | edit | flag | set_state | reset")
        did = uid.split(":", 1)[0]
        if action == "approve":
            change = {"status": "approved"}
        elif action == "flag":
            change = {"status": "flagged", "flag": str(body.get("reason") or "")}
        elif action == "set_state":
            st = body.get("state")
            if st not in ("ok", "not_in_source", "illegible"):
                raise HTTPException(422, detail="state must be ok | not_in_source | illegible")
            change = {"state": st} if st != "ok" else {"state": None}
        elif action == "edit":
            if "value" not in body:
                raise HTTPException(422, detail="edit needs 'value'")
            prev = store.review(did).get(uid, {}).get(path, {})
            ai = prev["ai_value"] if "ai_value" in prev else get_path(rec, path)
            change = {"value": body["value"], "ai_value": ai}
        else:  # reset
            change = {"status": None, "state": None, "flag": None, "value": None, "ai_value": None}
        store.patch_review(did, uid, path, change)
        return svc.record(uid)

    @app.get(prefix + "/boreholes/{uid:path}")
    def get_borehole(uid: str):
        rec = svc.record(uid)
        if rec is None:
            raise HTTPException(404, detail=f"borehole '{uid}' not found")
        return rec

    @app.get(prefix + "/documents")
    def list_documents():
        return {"documents": [public_document(d) for did in store.document_ids() if (d := store.document(did))]}

    @app.post(prefix + "/documents", status_code=status.HTTP_202_ACCEPTED)
    async def upload_document(file: UploadFile = File(...)):
        if not live_mode():
            raise HTTPException(409, detail="demo_mode")
        ext = Path(file.filename or "").suffix.lower()
        if ext not in SUPPORTED:
            raise HTTPException(415, detail=f"unsupported file type '{ext}'")
        did = store.new_document_id(file.filename or "upload")
        dest = store.root / "uploads" / f"{did}{ext}"
        dest.write_bytes(await file.read())
        store.save_document({"document_id": did, "file_name": Path(file.filename or dest.name).name, "source_path": str(dest),
                             "status": "queued", "error": None, "page_count": None, "found": None, "pages": [], "completeness": None})
        threading.Thread(target=run_extraction, args=(store, did, dest), daemon=True, name=f"extract-{did}").start()
        return {"document_id": did, "status": "queued"}

    @app.get(prefix + "/documents/{document_id}")
    def get_document(document_id: str):
        return public_document(doc_or_404(document_id))

    @app.get(prefix + "/documents/{document_id}/boreholes")
    def document_boreholes(document_id: str):
        doc_or_404(document_id)
        return svc.document_records(document_id)

    @app.get(prefix + "/documents/{document_id}/pages/{n}.png")
    def page_image(document_id: str, n: int, w: Optional[int] = Query(None, ge=50, le=4000)):
        d = doc_or_404(document_id)
        src = d.get("source_path")
        if not src or not Path(src).exists():
            raise HTTPException(404, detail="source document not available on this server")
        from ..site import _page_image
        p = _page_image(src, n, store.workdir)
        if p is None:
            raise HTTPException(404, detail=f"page {n} not found")
        from PIL import Image
        im = Image.open(p).convert("RGB")
        if w and im.width != w:
            im = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=False, compress_level=3)
        return Response(content=buf.getvalue(), media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})

    @app.get(prefix + "/documents/{document_id}/crs-candidates")
    def get_crs_candidates(document_id: str):
        doc_or_404(document_id)
        return crs_candidates(svc.document_records(document_id))

    @app.post(prefix + "/documents/{document_id}/crs")
    def confirm_crs(document_id: str, body: dict):
        doc_or_404(document_id)
        crs = str(body.get("crs") or "")
        m = __import__("re").match(r"(?i)epsg:(\d+)", crs.strip())
        if not m:
            raise HTTPException(422, detail="crs must be 'EPSG:<code>'")
        store.save_crs(document_id, {"epsg": int(m.group(1)), "axis": "auto", "confirmed_by": body.get("confirmed_by") or "reviewer",
                                     "note": body.get("note") or ""})
        return {"document_id": document_id, "crs": f"EPSG:{m.group(1)}", "boreholes": svc.document_records(document_id)}

    @app.post(prefix + "/documents/{document_id}/approve-clean")
    def approve_clean(document_id: str, dry_run: bool = Query(True)):
        doc_or_404(document_id)
        n = 0
        for rec in svc.document_records(document_id):
            for path, p in rec["provenance"].items():
                if p.get("method") == "read" and p.get("status") == "unreviewed" and p.get("state", "ok") == "ok" \
                        and not any(l["path"] == path for l in rec.get("lint") or []):
                    n += 1
                    if not dry_run:
                        store.patch_review(document_id, rec["uid"], path, {"status": "approved"})
        return {"count": n}

    @app.get(prefix + "/stats")
    def stats():
        recs = svc.all_records()
        din: dict[str, int] = {}
        for r in recs:
            for L in r["stratigraphy"]:
                c = (L.get("din4023_code") or "").split(",")[0].strip()
                if c:
                    din[c] = din.get(c, 0) + 1
        return {"total_boreholes": len(recs), "plotted": sum(1 for r in recs if r["plotted"]),
                "total_stratigraphic_layers": sum(len(r["stratigraphy"]) for r in recs), "din4023_distribution": din}


def serve(store: Store, host: str = "127.0.0.1", port: int = 8000) -> None:
    import uvicorn
    uvicorn.run(create_app(store), host=host, port=port, log_level="info")
