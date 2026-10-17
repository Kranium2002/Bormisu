"""Raster-page classification and the per-page raw-answer store.

Raw model answers per page live under `workdir/results/<sha1>/p<N>.raw.json` so `page` can show them and
`--resume` skips pages already read; the model-level cache in bh3.llm makes re-runs free anyway.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .inputs import PageSource
from .render import file_sha1, render_page, rotate_upright
from .vlm import VLM


def _raw_path(src: PageSource, workdir: Path) -> Path:
    d = workdir / "results" / file_sha1(src.source_file)
    d.mkdir(parents=True, exist_ok=True)
    return d / f"p{src.page_no:03d}.raw.json"


def classify_page(src: PageSource, vlm: VLM, classify_dpi: int, workdir: Path, raw: dict) -> tuple[Optional[dict], Path, int]:
    img = render_page(src, classify_dpi, workdir)
    img, rot = rotate_upright(img)
    if raw.get("classify") is not None and raw.get("rot") == rot:
        return raw["classify"], img, rot
    out, meta = vlm.classify(img)
    if out is not None:                      # a failed call (refused key, outage) is never stored: the next run asks again
        raw["classify"] = out
        raw["classify_meta"] = {k: v for k, v in meta.items() if k != "cache_hit"}
        raw["rot"] = rot
    return out, img, rot


def _save(rp: Path, raw: dict) -> None:
    rp.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")



def load_raw(rp: Path, resume: bool = True) -> dict:
    if resume and rp.exists():
        try:
            return json.loads(rp.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}
