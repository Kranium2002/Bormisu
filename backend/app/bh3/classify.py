"""Raster-page classification and the per-page raw-answer store.

Raw model answers per page live under `workdir/results/<sha1>/p<N>.raw.json` so `page` can show them and
`--resume` skips pages already read; the model-level cache in bh3.llm makes re-runs free anyway.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .inputs import PageSource
from .render import file_sha1, render_page, rotate_by, rotate_upright
from .vlm import VLM


def _raw_path(src: PageSource, workdir: Path) -> Path:
    d = workdir / "results" / file_sha1(src.source_file)
    d.mkdir(parents=True, exist_ok=True)
    return d / f"p{src.page_no:03d}.raw.json"


def _line_ratio(img_path: Path) -> float:
    """> 1 when the ink forms horizontal text lines, < 1 when the lines run vertically (a sideways page).

    Free and local: the row and column ink profiles of a small greyscale render, long ruling lines removed;
    text lines make a profile spiky. Only used to decide whether to ask the classifier about orientation."""
    import numpy as np
    from PIL import Image
    with Image.open(img_path) as im:
        scale = 800 / max(im.size)
        g = np.asarray(im.convert("L").resize((max(1, int(im.width * scale)), max(1, int(im.height * scale)))),
                       dtype=np.float32)
    ink = (g < 160).astype(np.float32)
    ink[ink.mean(axis=1) > 0.5, :] = 0
    ink[:, ink.mean(axis=0) > 0.5] = 0

    def spiky(profile) -> float:
        return float(np.abs(np.diff(profile)).mean() / (profile.mean() + 1e-6))

    return spiky(ink.sum(axis=1)) / (spiky(ink.sum(axis=0)) + 1e-6)


def _looks_sideways(img_path: Path) -> bool:
    try:
        return _line_ratio(img_path) < 0.85
    except Exception:  # noqa: BLE001  # the check is advisory
        return False


def _rank(answer: Optional[dict]) -> int:
    """How much a classification looks like a readable log page (used to vote between orientations)."""
    if not answer:
        return -1
    log = 100 if answer.get("page_type") in ("log", "spt_sheet") else 0
    rows = min(int(answer.get("rows_estimate") or 0), 50)
    return log + rows + 5 * len(answer.get("borehole_names_visible") or [])


def _turn(answer: Optional[dict]) -> int:
    value = (answer or {}).get("text_rotation")
    return value if value in (90, 180, 270) else 0


def classify_page(src: PageSource, vlm: VLM, classify_dpi: int, workdir: Path, raw: dict) -> tuple[Optional[dict], Path, int]:
    """Classify the page as displayed; when the classifier says the text is sideways or upside down, turn the page
    and classify it again so the header / column / body boxes refer to the upright image. `rot` is the total
    clockwise turn applied before reading (landscape strips and text_rotation together)."""
    base = render_page(src, classify_dpi, workdir)
    if raw.get("classify") is not None and isinstance(raw.get("rot"), int):
        return raw["classify"], rotate_by(base, raw["rot"]), raw["rot"]
    img, rot = rotate_upright(base)
    out, meta = vlm.classify(img)
    turn = _turn(out)
    if not turn and _looks_sideways(img):
        # the text lines run vertically: let the classifier vote between the page as shown and both quarter turns
        best = (_rank(out), 0, out, meta)
        for quarter in (90, 270):
            cand, cand_meta = vlm.classify(rotate_by(img, quarter))
            if _rank(cand) > best[0]:
                best = (_rank(cand), quarter, cand, cand_meta)
        if best[1]:
            rot = (rot + best[1]) % 360
            img = rotate_by(base, rot)
            out, meta = best[2], best[3]
            out["text_rotation"] = 0
    elif turn:
        rot = (rot + turn) % 360
        img = rotate_by(base, rot)
        again, meta_again = vlm.classify(img)
        if again is not None:
            again["text_rotation"] = 0            # the boxes now refer to the turned image
            out, meta = again, meta_again
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
