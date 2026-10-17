"""The backend's entry points into bh3 (MAIN_VS_BH3.md section 5, option 1).

bh3 is synchronous: call these from a worker thread (``asyncio.to_thread``). With the default ``workers=1``
every model call runs in that thread, one after another, so the ``on_call`` and ``guard`` callbacks never run
concurrently.

    vlm = make_vlm(base_url, api_key, model, on_call=ledger.append, guard=budget.check, cache_dir=run_dir / "llm")
    pages = read_pages("report.pdf", pdf_path=path, pages=[3, 4, 5], vlm=vlm, workdir=run_dir)
    boreholes = build(pages, "report.pdf", doc_id=document_id)

Output shapes are bh3.models: ``Borehole.metadata`` is keyed by the BoreholeDataFormat names (BoreholeID,
X-Coordinate, CoordinateSystem, BoreholeDepth …) with raw printed values; layers carry ``top``/``bottom`` in
metres, ``description`` as printed, ``din_code`` (the composed DIN 4023 short form, e.g. ``"G, s, u'"``) plus
``din_main`` (a key of din_codes.json) and ``din_secondary``; provenance boxes are PDF points on the displayed
page, origin top-left (image pages: the page scaled like an A4 page, see render.page_size_pt).
"""
from __future__ import annotations

import logging
from dataclasses import asdict
from pathlib import Path
from typing import Callable, Iterable, Optional

from . import din
from .assemble import build_boreholes
from .extract import RouteConfig, process_page
from .inputs import Document, PageSource, _pdf_document
from .llm import LLM, LLMConfig
from .models import Borehole
from .reconcile import PageResult
from .render import page_size_pt, render_page
from .validate import validate
from .vlm import VLM, BudgetExceeded

log = logging.getLogger(__name__)

__all__ = ["BudgetExceeded", "PageResult", "Borehole", "make_llm", "make_vlm", "openrouter_body", "read_pages", "build", "page_size_pt"]


def openrouter_body(reasoning: bool = False) -> dict:
    """OpenRouter request fields: reasoning off (otherwise the model spends the answer budget thinking), only
    providers that honour response_format, and usage with the cost of each call."""
    return {"reasoning": {"enabled": reasoning}, "provider": {"require_parameters": True}, "usage": {"include": True}}


def make_llm(base_url: str, api_key: str, model: str, *, cache_dir: Path, vision_model: Optional[str] = None,
             on_call: Optional[Callable[[dict], None]] = None, supports_schema: bool = True,
             extra_headers: Optional[dict] = None, timeout_s: float = 120.0,
             extra_body: Optional[dict] = None) -> LLM:
    """Text + vision client on any OpenAI-compatible server (OpenRouter, OpenAI, a local server)."""
    return LLM(LLMConfig(base_url=base_url, api_key=api_key, model=model, vision_model=vision_model or model,
                         cache_dir=cache_dir, on_call=on_call, supports_schema=supports_schema,
                         extra_headers=extra_headers, timeout_s=timeout_s,
                         extra_body=openrouter_body() if extra_body is None and "openrouter.ai" in base_url
                         else extra_body))


def make_vlm(base_url: str, api_key: str, model: str, on_call: Optional[Callable[[dict], None]] = None, *,
             cache_dir: Path, guard: Optional[Callable[[], None]] = None, workers: int = 1,
             max_tokens: Optional[int] = None, supports_schema: bool = True,
             extra_headers: Optional[dict] = None, extra_body: Optional[dict] = None) -> VLM:
    """The vision reader. ``on_call`` gets {purpose, model, input_tokens, output_tokens, ok} after every request
    that reached the server; ``guard`` runs before every paid call and raises BudgetExceeded to stop the run.
    Answers are cached under ``cache_dir`` by (model, prompt, image), so a retry repeats no paid call."""
    llm = make_llm(base_url, api_key, model, cache_dir=cache_dir, on_call=on_call, supports_schema=supports_schema,
                   extra_headers=extra_headers, extra_body=extra_body)
    return VLM(llm, workers=workers, max_tokens=max_tokens, guard=guard)


def _document(source_file: str, doc_id: Optional[str], pdf_path: Optional[Path],
              image_paths: Optional[dict[int, Path]]) -> Document:
    # bh3 keys its render and answer caches by the bytes of `source_file`, so it must be a real path
    if pdf_path is not None:
        doc = _pdf_document(Path(pdf_path))
        doc.doc_id = doc_id or doc.doc_id
        for p in doc.pages:
            p.doc_id = doc.doc_id
        return doc
    if not image_paths:
        raise ValueError("read_pages needs pdf_path or image_paths")
    did = doc_id or Path(source_file).stem
    first = str(sorted(image_paths.items())[0][1])
    doc = Document(did, "image", first)
    doc.pages = [PageSource(did, str(path), n, "image", image_path=str(path))
                 for n, path in sorted(image_paths.items())]
    return doc


def read_pages(source_file: str, *, vlm: VLM, workdir: Path, pdf_path: Optional[Path] = None,
               image_paths: Optional[dict[int, Path]] = None, pages: Optional[Iterable[int]] = None,
               doc_id: Optional[str] = None, cfg: Optional[RouteConfig] = None) -> list[PageResult]:
    """Read the given pages (1-based) of one document.

    PDF pages with a usable text layer are parsed from their embedded words and ruling lines with no model call;
    the vision path reads the others (classify, tile, read, anchor to the depth scale, reconcile). Non-PDF
    documents pass one image per page (``image_paths``: page number → rendered image). Renders and answers are
    cached under ``workdir``. Raises BudgetExceeded when ``vlm.guard`` stops the run.
    """
    doc = _document(source_file, doc_id, pdf_path, image_paths)
    wanted = set(pages) if pages is not None else None
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    cfg = cfg or RouteConfig()
    results: list[PageResult] = []
    for src in doc.pages:
        if wanted is not None and src.page_no not in wanted:
            continue
        try:
            results.append(_in_points(process_page(src, vlm, cfg, workdir), src, cfg, workdir))
        except BudgetExceeded:
            raise
        except Exception as exc:  # noqa: BLE001  # one unreadable page never stops the document
            log.exception("bh3 could not read %s page %d", source_file, src.page_no)
            pr = PageResult(src.source_file, src.page_no, "error", page_type="unread")
            pr.issues.append(f"page could not be read: {type(exc).__name__}: {str(exc)[:200]}")
            results.append(pr)
    return results


def _in_points(pr: PageResult, src: PageSource, cfg: RouteConfig, workdir: Path) -> PageResult:
    """Vision results carry row bands in pixels of the page render; express them in page points like the
    vector route. A page read after rotating it (landscape strip) gets page-level evidence instead."""
    if pr.route in ("vector", "error") or not (pr.layers or pr.points):
        return pr
    rotated = any("rotated" in n for n in pr.notes)
    factor = 0.0
    if not rotated:
        from PIL import Image
        with Image.open(render_page(src, cfg.dpi, workdir)) as im:
            factor = page_size_pt(src)[1] / max(1, im.height)
    for item in [*pr.layers, *pr.points]:
        prov = item.prov
        if rotated or not (prov.y1 > prov.y0):
            prov.x0 = prov.x1 = prov.y0 = prov.y1 = 0.0
        else:
            prov.y0, prov.y1 = prov.y0 * factor, prov.y1 * factor
    return pr


def build(page_results: list[PageResult], source_file: str, *, doc_id: Optional[str] = None,
          llm: Optional[LLM] = None) -> list[Borehole]:
    """Group pages into boreholes, carry open strata across sheets, check and repair, then DIN 4023 codes.

    ``llm`` (optional, a text model) normalises layer descriptions (lithology, USCS, colour) and fills header
    fields from the header text; without it the DIN codes come from printed codes, nouns and adjectives.
    """
    doc = Document(doc_id or Path(source_file).stem, "pdf", source_file)
    boreholes = [validate(b) for b in build_boreholes(doc, page_results, llm)]
    for b in boreholes:
        b.source_file = source_file
    views = [asdict(b) for b in boreholes]
    din.classify_boreholes(views)
    for b, view in zip(boreholes, views):
        for layer, lv in zip(b.layers, view.get("layers") or []):
            for key in ("din_code", "din_color", "din_pattern", "din_source"):
                setattr(layer, key, lv.get(key))
            layer.__dict__["din_main"] = lv.get("din_main")
            layer.__dict__["din_secondary"] = list(lv.get("din_secondary") or [])
            layer.__dict__["needs_review"] = bool(lv.get("needs_review"))
    return boreholes
