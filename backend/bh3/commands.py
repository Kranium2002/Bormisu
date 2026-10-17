"""run / classify / page / eval sub-commands (registered by cli.py)."""
from __future__ import annotations

import json
import logging
import math
import sys
import time
from pathlib import Path

from .llm import LLM, LLMConfig

from .assemble import finish
from .inputs import discover
from .render import clear_cache
from .extract import RouteConfig, process_document, process_page
from .vlm import VLM, BudgetExceeded, cost_usd

log = logging.getLogger("bh3")


def _parse_pages(spec):
    if not spec:
        return None
    out = set()
    for part in str(spec).split(","):
        if "-" in part:
            a, b = part.split("-")
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(part))
    return out


def _setup(args):
    cfg = LLMConfig(enabled=not args.no_llm, cache_dir=args.llm_cache, model=args.model, vision_model=args.vision_model)
    llm = LLM(cfg)
    vlm = VLM(llm, workers=args.workers, max_calls=args.max_calls, max_total_tokens=args.max_tokens_total)
    rc = RouteConfig(resume=not args.no_resume, no_vector=args.no_vector, no_vlm=args.no_llm,
                     preprocess=args.preprocess, anchor=not args.no_anchor,
                     symbols="always" if getattr(args, "symbols", False) else ("never" if getattr(args, "no_symbols", False) else "auto"))
    if args.dpi:
        rc.dpi = args.dpi
    if args.tile_px:
        rc.tile_px = args.tile_px
    if cfg.enabled:
        log.info("LLM: text=%s vision=%s @ %s  (dpi=%d tile_px=%d workers=%d)", cfg.model, cfg.vision_model, cfg.base_url,
                 rc.dpi, rc.tile_px, vlm.workers)
    return llm, vlm, rc


def cmd_run(args) -> int:
    t0 = time.time()
    llm, vlm, rc = _setup(args)
    workdir, out_dir = Path(args.workdir), Path(args.out)
    docs = discover(args.inputs, prefer=args.prefer)
    if not docs:
        print("no supported input files", file=sys.stderr)
        return 2
    pages = _parse_pages(args.pages)
    docs_results = []
    for doc in docs:
        t1 = time.time()
        for s in doc.skipped:
            log.info("%s: %s", doc.doc_id, s)
        try:
            results = process_document(doc, vlm, rc, workdir, pages=pages, max_pages=args.max_pages)
        except BudgetExceeded as e:
            log.warning("%s: %s", doc.doc_id, e)
            log.warning("stopping here; documents before this one are complete, this one is partial, later ones untouched")
            break
        docs_results.append((doc, results))
        n_log = sum(1 for r in results if r.is_log)
        log.info("%s: %d pages, %d log pages (%.0fs)  %s", doc.doc_id, len(results), n_log, time.time() - t1, vlm.ledger.summary())
    bhs = finish(docs_results, llm, out_dir)
    clear_cache()
    _build_site(out_dir / "boreholes.json", out_dir / "site", workdir, copy_pages=True, enrich_first=False)
    log.info("wrote %s (boreholes.xlsx/json + site/) in %.0fs; %s; text model calls=%d cache_hits=%d", out_dir, time.time() - t0,
             vlm.ledger.summary(), llm.calls, llm.cache_hits)
    for b in bhs:
        m = b.metadata
        print(f"{Path(b.source_file).name:22} {str(m.get('BoreholeName'))[:18]:18} pages={','.join(map(str, b.pages))[:14]:14} "
              f"layers={len(b.layers):3} depth={m.get('BoreholeDepth')!s:>7} conf={m.get('_confidence')} route={m.get('_route')} "
              f"issues={len(b.issues)}")
    return 0


def _build_site(result_json: Path, out_dir: Path, workdir: Path, copy_pages: bool = True, enrich_first: bool = True) -> dict:
    from .site import build_site, print_index
    bhs = json.loads(Path(result_json).read_text(encoding="utf-8"))
    index = build_site(bhs, out_dir, workdir=workdir, copy_pages=copy_pages, source=result_json, enrich_first=enrich_first)
    if enrich_first:        # the enriched dicts are the better JSON: write them back next to the site
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        (Path(out_dir) / "boreholes.json").write_text(json.dumps(bhs, ensure_ascii=False, indent=1), encoding="utf-8")
    print_index(index)
    log.info("site written to %s", out_dir)
    return index


def cmd_site(args) -> int:
    """Rebuild the website data product from an existing boreholes.json (no model calls)."""
    _build_site(Path(args.result), Path(args.out), Path(args.workdir), copy_pages=not args.no_pages)
    return 0


def cmd_classify(args) -> int:
    """Classify only; predict the extraction work (tiles) without doing it."""
    from .render import render_page, rotate_upright, vector_words
    from .tiles import plan_tiles
    from .vector import triage as bh_triage
    llm, vlm, rc = _setup(args)
    workdir = Path(args.workdir)
    pages = _parse_pages(args.pages)
    rows = []
    for doc in discover(args.inputs, prefer=args.prefer):
        srcs = [p for p in doc.pages if not pages or p.page_no in pages][: args.max_pages or None]
        # pass 1 (sequential: PyMuPDF is not thread-safe): text-layer triage + classify renders
        jobs = []
        for src in srcs:
            page = None if rc.no_vector else vector_words(src)
            if page is not None and page.has_text_layer:
                cls, conf, f = bh_triage.classify(page)
                rows.append((src.label, "vector", cls, round(conf, 2), "", "", f.get("n_words"), 0))
                continue
            if not vlm.enabled:
                rows.append((src.label, "vlm", "unread", "", "", "", "", 0))
                continue
            img = render_page(src, rc.classify_dpi, workdir)
            img, rot = rotate_upright(img)
            jobs.append((src, img))
        # pass 2 (parallel): the vision calls
        def one(job):
            src, img = job
            cl, _meta = vlm.classify(img)
            if not cl:
                return (src.label, "vlm", "failed", "", "", "", "", 0)
            n_tiles = 0
            if cl.get("page_type") in ("log", "spt_sheet"):
                from PIL import Image
                W, H = Image.open(img).size
                s = rc.dpi / rc.classify_dpi
                n_tiles = len(plan_tiles((int(W * s), int(H * s)), cl.get("table_body"), cl.get("column_header_band"),
                                         tile_px=rc.tile_px, rows_estimate=cl.get("rows_estimate"), max_rows_per_tile=rc.max_rows_per_tile))
            return (src.label, "vlm", cl.get("page_type"), cl.get("read_quality"), cl.get("language"), cl.get("depth_unit"),
                    cl.get("rows_estimate"), n_tiles)
        rows += vlm.map(one, jobs)
        log.info("%s: %d pages classified  %s", doc.doc_id, len(srcs), vlm.ledger.summary())
    print(f"{'page':34} {'route':7} {'class':10} {'quality':8} {'lang':5} {'unit':7} {'rows':>5} {'tiles':>5}")
    for r in rows:
        print(f"{str(r[0])[:34]:34} {r[1]:7} {str(r[2]):10} {str(r[3]):8} {str(r[4]):5} {str(r[5]):7} {str(r[6]):>5} {r[7]:>5}")
    n_log = sum(1 for r in rows if r[2] in ("log", "spt_sheet"))
    n_tiles = sum(r[7] for r in rows)
    print(f"\n{len(rows)} pages, {n_log} log/spt pages, predicted extraction calls ≈ {n_tiles} tiles + {n_log} headers "
          f"(≈ {n_tiles * 2400 + n_log * 1500:,} prompt tokens)")
    print(vlm.ledger.summary())
    clear_cache()
    return 0


def cmd_page(args) -> int:
    llm, vlm, rc = _setup(args)
    workdir = Path(args.workdir)
    src = None
    for d in discover([args.file], prefer=args.prefer):
        for p in d.pages:
            if p.page_no == args.page:
                src = p
    if src is None:
        print("page not found", file=sys.stderr)
        return 2
    pr = process_page(src, vlm, rc, workdir)
    print(f"route={pr.route} type={pr.page_type} quality={pr.read_quality} lang={pr.language} unit={pr.depth_unit} "
          f"name={pr.borehole_name!r} sheet={pr.sheet_no}/{pr.sheet_total} total={pr.total_depth} conf={pr.confidence}")
    print("stats:", json.dumps(pr.stats, ensure_ascii=False))
    for L in pr.layers:
        print(f"  L {L.top:>7.2f} {L.bottom:>7.2f} | {L.description[:110]}" + (f"  [symbol: {L.symbol}]" if L.symbol else ""))
    if pr.stats.get("legend"):
        print("  legend:", json.dumps(pr.stats["legend"], ensure_ascii=False))
    for q in pr.points:
        print(f"  P {q.kind:7} {q.depth!s:>7} {q.depth_to!s:>6} {q.value!s:>6} {q.label or ''}")
    print("  header:", json.dumps(pr.header_fields, ensure_ascii=False, default=str), pr.header_extras)
    for n in pr.notes:
        print("  note:", n)
    for i in pr.issues:
        print("  issue:", i)
    if args.raw:
        from .classify import _raw_path
        rp = _raw_path(src, workdir)
        if rp.exists():
            print(rp.read_text(encoding="utf-8")[:6000])
    print(vlm.ledger.summary())
    clear_cache()
    return 0


def cmd_eval(args) -> int:
    try:
        from .eval import main as eval_main
    except ImportError:
        print("eval module not available yet", file=sys.stderr)
        return 2
    argv = list(args.result)
    if args.golden:
        argv += ["--golden", args.golden]
    if args.json:
        argv += ["--json", args.json]
    return eval_main(argv)


def add_commands(sub, common) -> None:
    ext = __import__("argparse").ArgumentParser(add_help=False)
    ext.add_argument("--no-llm", action="store_true", help="no model calls at all (vector pages only)")
    ext.add_argument("--no-vector", action="store_true", help="send every page through the vision path")
    ext.add_argument("--no-resume", action="store_true", help="ignore stored per-page raw results")
    ext.add_argument("--prefer", choices=["pdf", "images"], default="pdf", help="when a folder holds a PDF and its page images")
    ext.add_argument("--preprocess", choices=["auto", "always", "never"], default="auto", help="contrast/sharpen scans before reading")
    ext.add_argument("--dpi", type=int, help="render dpi for extraction tiles (default BH_VLM_DPI or 200)")
    ext.add_argument("--tile-px", type=int, help="tile long-side cap (default BH_VLM_TILE_PX or 1540)")
    ext.add_argument("--workers", type=int, default=None, help="parallel vision calls (default BH_VLM_WORKERS or 4)")
    ext.add_argument("--no-anchor", action="store_true", help="no coordinate grid / line snapping: depths as read by the model")
    ext.add_argument("--symbols", action="store_true", help="read the hatch symbol of every stratum and the page legend on every log page (default: only on pages with strata that have no words)")
    ext.add_argument("--no-symbols", action="store_true", help="never do the symbol read")
    ext.add_argument("--max-calls", type=int, default=None, help="stop the run after this many model calls (off by default; cached answers do not count)")
    ext.add_argument("--max-tokens-total", type=int, default=None, help="stop the run after this many tokens (off by default)")
    ext.add_argument("--pages", help="page filter, e.g. 1,3,5-8")
    ext.add_argument("--max-pages", type=int, help="process at most N pages per document")

    r = sub.add_parser("run", help="full pipeline → xlsx + json", parents=[common, ext])
    r.add_argument("inputs", nargs="+")
    r.add_argument("-o", "--out", default="out3")
    r.set_defaults(func=cmd_run)

    c = sub.add_parser("classify", help="classify pages only, predict extraction calls", parents=[common, ext])
    c.add_argument("inputs", nargs="+")
    c.set_defaults(func=cmd_classify)

    g = sub.add_parser("page", help="one page end-to-end (debug)", parents=[common, ext])
    g.add_argument("file")
    g.add_argument("page", type=int)
    g.add_argument("--raw", action="store_true", help="also print the stored raw model answers")
    g.set_defaults(func=cmd_page)

    st = sub.add_parser("site", help="website data product (geojson, profiles, page images) from a boreholes.json", parents=[common])
    st.add_argument("result")
    st.add_argument("-o", "--out", default="out3/site")
    st.add_argument("--no-pages", action="store_true", help="do not copy page images")
    st.set_defaults(func=cmd_site)

    e = sub.add_parser("eval", help="score a boreholes.json against tests/golden", parents=[common])
    e.add_argument("result", nargs="+")
    e.add_argument("--golden", default=None)
    e.add_argument("--json", default=None)
    e.set_defaults(func=cmd_eval)
