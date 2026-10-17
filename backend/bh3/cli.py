"""Command line for bh3.

  python -m bh3 probe   [file] [page]            # which model / resolution / schema mode work on this backend
  python -m bh3 classify <inputs>...             # page classes + predicted extraction calls, no extraction
  python -m bh3 run      <inputs>... -o out2     # full pipeline → xlsx + json
  python -m bh3 page     <file> <page>           # one page end-to-end, prints raw and merged results
  python -m bh3 eval     <boreholes.json>        # score against tests/golden
  python -m bh3 site     <boreholes.json> -o out3/site   # website data product from an existing result, no model calls
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

from .llm import LLM, LLMConfig

from . import __version__
from .inputs import discover
from .render import clear_cache, render_page
from .schemas import TILE_LOG_SCHEMA
from .vlm import VLM

log = logging.getLogger("bh3")


def _llm(args) -> LLM:
    cfg = LLMConfig(enabled=not getattr(args, "no_llm", False), cache_dir=getattr(args, "llm_cache", None),
                    model=getattr(args, "model", None), vision_model=getattr(args, "vision_model", None))
    return LLM(cfg)


# ---------------------------------------------------------------------------
# probe
# ---------------------------------------------------------------------------

def cmd_probe(args) -> int:
    """Send real crops of a scanned log page at several resolutions; print what came back."""
    from . import prompts
    from .tiles import plan_tiles, render_tile
    llm = _llm(args)
    vlm = VLM(llm, workers=1)
    print(f"backend: {llm.cfg.base_url}  vision model: {llm.cfg.vision_model}  json_schema: {llm.cfg.supports_schema}")
    # 1. which models does the server offer?
    try:
        ids = sorted(m.id for m in llm.client.models.list().data)
        vis = [m for m in ids if any(k in m for k in ("pixtral", "vl", "vision", "medium", "large", "small-latest", "small-3"))]
        print(f"models on server: {len(ids)}; vision-ish: {', '.join(vis[:30])}")
        if llm.cfg.vision_model not in ids and not any(llm.cfg.vision_model.startswith(m.split('-latest')[0]) for m in ids):
            print(f"!! configured vision model '{llm.cfg.vision_model}' is not in the server's model list")
    except Exception as e:  # noqa: BLE001
        print(f"models.list not available ({str(e)[:120]})")
    # 2. the page
    src = None
    for d in discover([args.file]):
        for p in d.pages:
            if p.page_no == args.page:
                src = p
    if src is None:
        print("page not found", file=sys.stderr)
        return 2
    workdir = Path(args.workdir)
    for dpi in [int(x) for x in args.dpis.split(",")]:
        img = render_page(src, dpi, workdir)
        from PIL import Image
        W, H = Image.open(img).size
        specs = plan_tiles((W, H), None, None, tile_px=args.tile_px)
        spec = specs[min(len(specs) - 1, max(0, args.tile))]
        tile = render_tile(img, spec, workdir / "probe" / f"{src.doc_id}_p{src.page_no}_{dpi}_t{spec.index}.jpg")
        tw, th = Image.open(tile).size
        t0 = time.time()
        out, meta = vlm.call(tile, prompts.SYSTEM_TILE_LOG, prompts.USER_TILE_LOG, TILE_LOG_SCHEMA, "tile_log")
        dt = time.time() - t0
        print(f"\n--- dpi={dpi} page={W}x{H}px tile {spec.index + 1}/{len(specs)} {tw}x{th}px  {dt:.1f}s  "
              f"schema_mode={meta.get('schema_mode')} tokens={meta.get('prompt_tokens')}+{meta.get('completion_tokens')} "
              f"error={meta.get('error')} cache={meta.get('cache_hit')}")
        if out:
            print(f"  name={out.get('borehole_name')!r} unit={out.get('depth_unit')} visible={out.get('visible_depth_top')}..{out.get('visible_depth_bottom')} "
                  f"total={out.get('total_depth')} layers={len(out.get('layers') or [])} spt={len(out.get('spt') or [])} "
                  f"core={len(out.get('core_runs') or [])} samples={len(out.get('samples') or [])}")
            for L in (out.get("layers") or [])[:12]:
                print(f"    {L.get('top')!s:>6} - {L.get('bottom')!s:<6} {'^' if L.get('partial_top') else ' '}{'v' if L.get('partial_bottom') else ' '} {str(L.get('description'))[:90]}")
            for s in (out.get("spt") or [])[:6]:
                print(f"    SPT {s}")
    print("\n" + vlm.ledger.summary())
    clear_cache()
    return 0


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="bh3", description=f"borehole log extraction v{__version__}")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("-v", "--verbose", action="store_true")
    common.add_argument("--workdir", default=".bh3_work", help="renders, tiles and per-page results (cache)")
    common.add_argument("--llm-cache", default=None, help="override LLM_CACHE_DIR")
    common.add_argument("--model", help="override LLM_MODEL (text model for normalisation)")
    common.add_argument("--vision-model", help="override LLM_VISION_MODEL")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe", help="check the backend: models, resolution, schema support", parents=[common])
    p.add_argument("file", nargs="?", default="../HKBoreholeChallenge_Data_BFH2026/BoreholeData/AF02.pdf")
    p.add_argument("page", nargs="?", type=int, default=5)
    p.add_argument("--dpis", default="100,150,200,300")
    p.add_argument("--tile-px", type=int, default=1400)
    p.add_argument("--tile", type=int, default=0, help="which tile of the page to send (0-based)")
    p.set_defaults(func=cmd_probe)

    try:
        from .commands import add_commands        # run / classify / page / eval / site
        add_commands(sub, common)
    except ImportError:
        raise

    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):      # Windows consoles default to cp1252; our output is multilingual
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname).1s %(name)s: %(message)s")
    for n in ("httpx", "httpcore", "openai", "PIL"):
        logging.getLogger(n).setLevel(logging.WARNING)
    return args.func(args)
