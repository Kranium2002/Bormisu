"""On-disk store of the API: documents, results, review overlays, uploads, confirmed CRS.

    <store>/documents/<document_id>.json   status, file name, pages, counts, completeness, source path
    <store>/results/<document_id>/boreholes.json   bh3 output of that document (enriched)
    <store>/review/<document_id>.json      review overlay: {uid: {path: {status, state, flag, value, method, ai_value}}}
    <store>/crs/<document_id>.json         a CRS confirmed by a reviewer for the whole document
    <store>/uploads/<document_id><ext>     uploaded files, saved under the generated id (never the client name)

One lock per document for read-modify-write of the overlay (the UI sends many PATCHes at once).
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import threading
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

TERMINAL = {"needs_review", "done", "failed"}


def _read(p: Path) -> Optional[Any]:
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _write(p: Path, data: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    tmp.replace(p)


def slug(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "_", str(s)).strip("_")
    return s[:60] or "doc"


class Store:
    def __init__(self, root: str | Path, workdir: str | Path = ".bh3_work", data_root: Optional[str | Path] = None):
        self.root = Path(root)
        self.workdir = Path(workdir)
        self.data_root = Path(data_root) if data_root else None
        for d in ("documents", "results", "review", "crs", "uploads"):
            (self.root / d).mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
        self._locks_guard = threading.Lock()

    def lock(self, document_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks[document_id]

    # -- documents --------------------------------------------------------------
    def document_ids(self) -> list[str]:
        return sorted(p.stem for p in (self.root / "documents").glob("*.json"))

    def document(self, document_id: str) -> Optional[dict]:
        return _read(self.root / "documents" / f"{document_id}.json")

    def save_document(self, doc: dict) -> None:
        _write(self.root / "documents" / f"{doc['document_id']}.json", doc)

    def update_document(self, document_id: str, **fields) -> Optional[dict]:
        with self.lock(document_id):
            doc = self.document(document_id)
            if doc is None:
                return None
            doc.update(fields)
            self.save_document(doc)
            return doc

    def new_document_id(self, file_name: str) -> str:
        base = slug(Path(file_name).stem)
        for _ in range(100):
            did = f"{base}_{secrets.token_hex(3)}"
            if not (self.root / "documents" / f"{did}.json").exists():
                return did
        return f"{base}_{secrets.token_hex(6)}"

    # -- results ----------------------------------------------------------------
    def result(self, document_id: str) -> list[dict]:
        return _read(self.root / "results" / document_id / "boreholes.json") or []

    def save_result(self, document_id: str, boreholes: list[dict]) -> None:
        _write(self.root / "results" / document_id / "boreholes.json", boreholes)

    def result_dir(self, document_id: str) -> Path:
        d = self.root / "results" / document_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    # -- review overlay ---------------------------------------------------------
    def review(self, document_id: str) -> dict:
        return _read(self.root / "review" / f"{document_id}.json") or {}

    def patch_review(self, document_id: str, uid: str, path: str, change: dict) -> dict:
        """Merge `change` into overlay[uid][path] under the document lock; returns the overlay entry."""
        with self.lock(document_id):
            ov = self.review(document_id)
            entry = ov.setdefault(uid, {}).setdefault(path, {})
            for k, v in change.items():
                if v is None and k in entry:
                    del entry[k]
                elif v is not None:
                    entry[k] = v
            if not entry:
                del ov[uid][path]
                if not ov[uid]:
                    del ov[uid]
            _write(self.root / "review" / f"{document_id}.json", ov)
            return entry

    # -- confirmed CRS ----------------------------------------------------------
    def crs(self, document_id: str) -> Optional[dict]:
        return _read(self.root / "crs" / f"{document_id}.json")

    def save_crs(self, document_id: str, data: dict) -> None:
        _write(self.root / "crs" / f"{document_id}.json", data)

    # -- sources ----------------------------------------------------------------
    def resolve_source(self, source_file: str) -> Optional[Path]:
        """The document on disk: as recorded, else under the data root by its tail path (results made from
        another working directory record a relative path such as ..\\BoreholeData\\AF01.PDF)."""
        if not source_file:
            return None
        p = Path(source_file)
        if p.exists():
            return p
        parts = [x for x in re.split(r"[\\/]+", source_file) if x and x != ".."]
        if self.data_root is not None:
            for i in range(len(parts)):
                cand = self.data_root.joinpath(*parts[i:])
                if cand.exists():
                    return cand
        return None

    # -- import of an existing result ------------------------------------------
    def import_result(self, result_json: str | Path) -> list[str]:
        """One document per source file of a bh3 boreholes.json. Returns the document ids created."""
        from .mapping import document_from_result
        bhs = json.loads(Path(result_json).read_text(encoding="utf-8"))
        by_src: dict[str, list[dict]] = {}
        for b in bhs:
            by_src.setdefault(b.get("source_file") or "unknown", []).append(b)
        ids = []
        for src, holes in by_src.items():
            did = slug(Path(src).stem)
            existing = self.document(did)
            if existing and existing.get("status") not in TERMINAL:
                did = self.new_document_id(src)
            resolved = self.resolve_source(src)
            self.save_result(did, holes)
            doc = document_from_result(did, Path(src).name, holes, str(resolved) if resolved else None, self)
            doc["imported_from"] = str(result_json)
            self.save_document(doc)
            ids.append(did)
        log.info("imported %d documents from %s", len(ids), result_json)
        return ids
