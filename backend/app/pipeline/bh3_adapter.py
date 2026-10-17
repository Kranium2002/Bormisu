"""bh3 as the extraction stage for log pages (MAIN_VS_BH3.md section 5, option 1).

bh3 (package `app.bh3`, reached only through `app.bh3.bridge`) reads a log page as a picture: the depth
scale first, boundaries anchored to the scale's ticks and snapped to ruling lines; vector pages are parsed
from their text layer without a model call. Its reconcile repairs (name cleaning, merged remark rows, SPT N
from increments, elevation scale, header sanity) run inside `bridge.build`. This module turns bh3's
boreholes into this pipeline's `ExtractionResult` + cited blocks, so finalisation, the CRS service and its
questions, lint, second reads and word-level evidence boxes work exactly as for the classic extractor.

- Pages: the used pages the classifier calls log sheets (or continuations). Each page is read on its own,
  so a page bh3 cannot read falls back to the classic extractor alone; bh3 caches every page in
  `pages/{document}/bh3/`, so a retry repeats no paid call.
- Values stay as text: depths are bh3's metres written as numbers (the depth unit is metres), header
  values are the printed strings when the bridge keeps them (else bh3's coerced value as text).
- Evidence: every value cites a block made from its bh3 provenance (page, box in PDF points scaled to the
  page render, confidence); a row band without x extent spans the page width, no box at all is the page.
- Cost: every model call bh3 makes is written to the provider ledger through `on_call`, which stops bh3
  with its BudgetExceeded once PROVIDER_BUDGET_USD is used up.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import logging
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

import pypdfium2 as pdfium
from sqlalchemy import select

from app.config import Settings, get_settings
from app.db.models import Document, Page
from app.db.session import get_sessionmaker
from app.pipeline.schemas import (
    ExtractedCoreRun,
    ExtractedGroundwater,
    ExtractedHeader,
    ExtractedLayer,
    ExtractedSample,
    ExtractedSpt,
    ExtractionResult,
    RawCoordinates,
    RawValue,
)
from app.pipeline.types import BlockRef, ExtractionOutcome, PageGroup
from app.providers.base import BudgetExceededError, Usage, record_usage, spent_usd
from app.storage import get_storage

logger = logging.getLogger("geomemory.pipeline.bh3")

BRIDGE_MODULE = "app.bh3.bridge"
LOG_ROLES = frozenset({"log_sheet", "log_continuation"})
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"})
OFFICE_EXTENSIONS = frozenset({".docx", ".doc", ".odt", ".pptx"})
A4_LONG_PT = 842.0  # bh3 scales an image page so its long side is an A4 page's long side in points
# Budget estimate of one page before bh3 reads it (a few tile calls of a vision model).
PAGE_ESTIMATE_USD = 0.02
UNLABELLED = "unlabelled p{page}"  # a hole bh3 could not name: says so, never a made-up printed label
_SPT_LABEL = re.compile(r"^\s*(?P<n>[^\[\]]*?)\s*\[(?P<blows>[^\]]*)\]\s*$")
_USCS = re.compile(r"^(?:[GSMCO][WPMCLH]?(?:-[GSMCO][WPMCLH])?|[MCO][LH](?:-[MCO][LH])?|Pt|PT)$")
_GW_STRIKE = re.compile(r"strike|struck|encountered|inflow|angetroffen|zufluss|encontrad", re.I)
_GW_REST = re.compile(r"rest|standing|static|stand|ruhe|after\s+\d|estabiliz", re.I)


def load_bridge() -> ModuleType | None:
    """The bh3 bridge, or None when the bh3 package is not installed (the classic extractor is used)."""
    try:
        return importlib.import_module(BRIDGE_MODULE)
    except ImportError:
        return None


def active(settings: Settings | None = None) -> bool:
    settings = settings or get_settings()
    return settings.extractor == "bh3" and bool(settings.llm_routes) and load_bridge() is not None


def vision_route(settings: Settings) -> tuple[str, str, str, str] | None:
    """(provider, base URL, API key, model) of the vision model bh3 reads pages with."""
    for route in settings.llm_routes:
        if route == "openrouter" and settings.openrouter_api_key is not None:
            key = settings.openrouter_api_key.get_secret_value()
            return route, settings.openrouter_base_url, key, settings.bh3_model
        if route == "openai" and settings.openai_api_key is not None:
            model = settings.openai_bh3_model or settings.chat_model
            return route, settings.openai_base_url, settings.openai_api_key.get_secret_value(), model
    return None


# ----------------------------------------------------------------------------------------------
# Reading the document
# ----------------------------------------------------------------------------------------------


@dataclass
class Bh3Read:
    """bh3's boreholes of one document as (group, outcome) pairs, and the log pages it covers."""

    boreholes: list[tuple[PageGroup, ExtractionOutcome]] = field(default_factory=list)
    pages: set[int] = field(default_factory=set)  # log pages that belong to a bh3 borehole
    failed: list[int] = field(default_factory=list)  # log pages bh3 could not read


@dataclass(frozen=True)
class _PageInfo:
    n: int
    width_px: int
    height_px: int
    text_quality: float | None
    handwriting: str | None


async def extract_document(document_id: str, bridge: ModuleType | None = None) -> Bh3Read | None:
    """Read the document's log pages with bh3 and build its boreholes. None when bh3 cannot run here (no
    bridge, no model route, or a file type bh3 does not read); the caller then uses the classic extractor."""
    settings = get_settings()
    bridge = bridge or load_bridge()
    route = vision_route(settings)
    if bridge is None or route is None:
        return None
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return None
        pages = (
            await session.scalars(
                select(Page).where(Page.document_id == document_id, Page.used.is_(True)).order_by(Page.n)
            )
        ).all()
        file_name, storage_key = doc.file_name, doc.storage_key
        log_pages = [p.n for p in pages if p.role in LOG_ROLES]
        infos = {
            p.n: _PageInfo(p.n, p.width_px or 0, p.height_px or 0, p.text_layer_quality, p.handwriting)
            for p in pages
        }
    sources = _sources(document_id, storage_key)
    if sources is None or not log_pages:
        return None if sources is None else Bh3Read()
    pdf_path, image_path = sources
    provider, base_url, api_key, model = route
    budget = settings.provider_budget_usd
    loop = asyncio.get_running_loop()

    def on_call(call: dict[str, Any]) -> None:
        """bh3 made a model call: write it to the ledger, stop bh3 when the budget is used up."""
        cost = float(call.get("cost_usd") or 0.0)
        usage = Usage(
            provider,
            f"bh3:{call.get('purpose') or 'read'}",
            str(call.get("model") or model),
            _int(call.get("input_tokens")),
            _int(call.get("output_tokens")),
            _int(call.get("pages")),
            cost,
        )
        asyncio.run_coroutine_threadsafe(record_usage(usage, document_id), loop).result(timeout=60)
        if budget is not None:
            spent = asyncio.run_coroutine_threadsafe(spent_usd(), loop).result(timeout=60)
            if spent >= budget:
                raise bridge.BudgetExceeded(f"provider budget of {budget:.2f} USD used up ({spent:.2f} USD)")

    vlm = bridge.make_vlm(base_url, api_key, model, on_call)
    workdir = get_storage().path(f"pages/{document_id}/bh3")
    workdir.mkdir(parents=True, exist_ok=True)

    async def budget_left() -> None:
        if budget is not None:
            spent = await spent_usd()
            if spent + PAGE_ESTIMATE_USD > budget:
                raise BudgetExceededError(spent, budget)

    results: list[Any] = []
    failed: list[int] = []
    for n in log_pages:
        await budget_left()
        try:
            read = await asyncio.to_thread(
                bridge.read_pages, pdf_path, image_path, [n], file_name, vlm, workdir
            )
        except bridge.BudgetExceeded as exc:
            raise BudgetExceededError(await spent_usd(), budget or 0.0) from exc
        except Exception:
            logger.exception(
                "bh3 could not read page %s of %s; the classic extractor takes it", n, document_id
            )
            failed.append(n)
            continue
        results.extend(read)
    try:
        built = await asyncio.to_thread(bridge.build, results, file_name, None) if results else []
    except bridge.BudgetExceeded as exc:
        raise BudgetExceededError(await spent_usd(), budget or 0.0) from exc
    except Exception:
        logger.exception(
            "bh3 could not assemble the boreholes of %s; the classic extractor takes them", document_id
        )
        return Bh3Read(failed=log_pages)
    languages = {int(r.page_no): (getattr(r, "language", "") or None) for r in results}
    long_side = _long_sides(pdf_path, infos)
    out = Bh3Read(failed=failed)
    for bh in built:
        mapped = map_borehole(bh, infos=infos, languages=languages, long_side=long_side, model=model)
        if mapped is None:
            continue
        out.boreholes.append(mapped)
        out.pages.update(mapped[0].pages)
    return out


def _int(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _sources(document_id: str, storage_key: str) -> tuple[Path | None, Path | None] | None:
    """(pdf, image) bh3 reads: the original PDF, the converted PDF of an Office file, or the image."""
    storage = get_storage()
    original = storage.path(storage_key)
    suffix = original.suffix.lower()
    if suffix == ".pdf":
        return original, None
    if suffix in OFFICE_EXTENSIONS:
        converted = storage.path(f"pages/{document_id}/converted.pdf")
        return (converted, None) if converted.exists() else None
    if suffix in IMAGE_EXTENSIONS:
        return None, original
    return None


def _long_sides(pdf_path: Path | None, infos: dict[int, _PageInfo]) -> dict[int, float]:
    """Each page's long side in PDF points (bh3's unit): from the PDF, or A4 for an image."""
    if pdf_path is None:
        return {n: A4_LONG_PT for n in infos}
    sides: dict[int, float] = {}
    document = pdfium.PdfDocument(str(pdf_path))
    try:
        for n in infos:
            if 1 <= n <= len(document):
                page = document[n - 1]
                sides[n] = float(max(page.get_size()))
                page.close()
    finally:
        document.close()
    return sides


# ----------------------------------------------------------------------------------------------
# bh3 Borehole -> ExtractionResult + blocks
# ----------------------------------------------------------------------------------------------


def _depth_text(value: Any) -> str | None:
    if (
        not isinstance(value, int | float)
        or isinstance(value, bool)
        or math.isnan(value)
        or math.isinf(value)
    ):
        return None
    return (
        f"{round(float(value), 3):.2f}"
        if round(float(value), 2) == round(float(value), 3)
        else f"{value:.3f}"
    )


def _text(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


class _Blocks:
    """Cited blocks made from bh3 provenance; one block per distinct (page, box, text)."""

    def __init__(self, infos: dict[int, _PageInfo], long_side: dict[int, float]) -> None:
        self.infos = infos
        self.long_side = long_side
        self.blocks: dict[str, BlockRef] = {}
        self._ids: dict[tuple[int, tuple[float, ...] | None, str], str] = {}

    def box(self, prov: Any) -> tuple[float, float, float, float] | None:
        info = self.infos.get(int(prov.page))
        side = self.long_side.get(int(prov.page))
        if info is None or not side or not info.width_px or not info.height_px:
            return None
        scale = side / max(info.width_px, info.height_px)  # points per render pixel
        width_pt, height_pt = info.width_px * scale, info.height_px * scale
        x0, y0, x1, y1 = (float(getattr(prov, k, 0.0) or 0.0) for k in ("x0", "y0", "x1", "y1"))
        if y1 <= y0:
            return None  # no row band: the whole page
        if x1 <= x0:
            x0, x1 = 0.0, width_pt  # a row band spans the page width

        def clamp(v: float) -> float:
            return min(max(v, 0.0), 1.0)

        left, top = clamp(x0 / width_pt), clamp(y0 / height_pt)
        right, bottom = clamp(x1 / width_pt), clamp(y1 / height_pt)
        if right <= left or bottom <= top:
            return None
        return (round(left, 5), round(top, 5), round(right - left, 5), round(bottom - top, 5))

    def cite(self, text: str | None, prov: Any) -> RawValue:
        if text is None:
            return RawValue.absent()
        if prov is None or getattr(prov, "page", None) is None or int(prov.page) not in self.infos:
            return RawValue(raw=text, block_ids=[], state="ok")
        page = int(prov.page)
        box = self.box(prov)
        key = (page, box, text)
        block_id = self._ids.get(key)
        if block_id is None:
            info = self.infos[page]
            block_id = f"p{page}.b{1000 + len(self._ids)}"
            confidence = getattr(prov, "confidence", None)
            self.blocks[block_id] = BlockRef(
                id=block_id,
                page=page,
                text=text,
                box=box if box is not None else (0.0, 0.0, 1.0, 1.0),
                confidence=None if confidence is None else min(max(float(confidence), 0.0), 1.0),
                page_text_quality=info.text_quality,
                page_handwriting=info.handwriting,
            )
            self._ids[key] = block_id
        return RawValue(raw=text, block_ids=[block_id], state="ok")


def _header_text(bh: Any, key: str) -> str | None:
    """A header field as printed: the raw string the bridge kept, else bh3's (coerced) value as text."""
    metadata = getattr(bh, "metadata", {}) or {}
    raw = metadata.get("_raw")
    if isinstance(raw, dict) and _text(raw.get(key)) is not None:
        return _text(raw.get(key))
    extra = metadata.get("_extra")
    if key not in metadata and isinstance(extra, dict):
        return _text(extra.get(key))
    return _text(metadata.get(key))


def map_borehole(
    bh: Any,
    *,
    infos: dict[int, _PageInfo],
    languages: dict[int, str | None],
    long_side: dict[int, float],
    model: str,
) -> tuple[PageGroup, ExtractionOutcome] | None:
    """One bh3 Borehole as a page group and an extraction outcome (None when it has no pages here)."""
    pages = tuple(sorted({int(n) for n in (getattr(bh, "pages", None) or []) if int(n) in infos}))
    if not pages:
        return None
    blocks = _Blocks(infos, long_side)
    metadata = getattr(bh, "metadata", {}) or {}
    meta_prov = getattr(bh, "meta_prov", {}) or {}
    first = pages[0]

    def header(key: str, *, depth: bool = False) -> RawValue:
        value = metadata.get(key)
        text = _depth_text(value) if depth and isinstance(value, int | float) else _header_text(bh, key)
        return blocks.cite(text, meta_prov.get(key) or _page_prov(first))

    generated = bool(metadata.get("_name_generated"))
    name = None if generated else _text(metadata.get("BoreholeName"))
    label = name or UNLABELLED.format(page=first)
    label_value = header("BoreholeName") if name else RawValue.absent()
    head = ExtractedHeader(
        borehole_label=label_value,
        project=header("ProjectName"),
        client=header("Client"),
        location=header("LocationName"),
        contractor=header("Contractor"),
        method=header("Method"),
        start_date=header("StartDate"),
        end_date=header("EndDate"),
        total_depth=header("BoreholeDepth", depth=True),
        # bh3 gives every depth in metres (feet are converted when it reads them)
        depth_unit=RawValue(raw="m", block_ids=[], state="ok"),
        ground_level=header("Surface Elevation"),
        elevation_datum=RawValue.absent(),
        coordinates=RawCoordinates(
            x_raw=header("X-Coordinate"),
            y_raw=header("Y-Coordinate"),
            labels_raw=RawValue.absent(),
            system_raw=header("CoordinateSystem"),
        ),
        inclination=header("Inclination"),
        depth_origin_note=RawValue.absent(),
        notes=header("Notes"),
    )
    layers = _layers(bh, blocks, languages)
    spt, cores, samples, water = _points(bh, blocks)
    if not water and metadata.get("Groundwaterlevel") is not None:
        depth = _depth_text(metadata.get("Groundwaterlevel"))
        if depth is not None:
            prov = meta_prov.get("Groundwaterlevel") or _page_prov(first)
            water.append(
                ExtractedGroundwater(type="other", depth_raw=blocks.cite(depth, prov), date_raw=None)
            )
    result = ExtractionResult(
        header=head, layers=layers, spt=spt, core_runs=cores, groundwater=water, samples=samples, tests=[]
    )
    key = "bh3:" + hashlib.sha256(f"{label}|{','.join(map(str, pages))}".encode()).hexdigest()[:24]
    issues = [str(i) for i in getattr(bh, "issues", None) or []]
    group = PageGroup(key=key, label_raw=label, label_canonical=label, pages=pages)
    if issues:
        logger.info("bh3 borehole %s: %s", label, "; ".join(issues[:10]))
    return group, ExtractionOutcome(result=result, blocks=blocks.blocks, run_id=None, model=f"bh3:{model}")


@dataclass(frozen=True)
class _PageProv:
    page: int
    x0: float = 0.0
    y0: float = 0.0
    x1: float = 0.0
    y1: float = 0.0
    confidence: float | None = None


def _page_prov(page: int) -> _PageProv:
    return _PageProv(page)


def _layers(bh: Any, blocks: _Blocks, languages: dict[int, str | None]) -> list[ExtractedLayer]:
    raw_layers = list(getattr(bh, "layers", None) or [])
    out: list[ExtractedLayer] = []
    for i, layer in enumerate(raw_layers):
        prov = getattr(layer, "prov", None)
        top, bottom = _depth_text(getattr(layer, "top", None)), _depth_text(getattr(layer, "bottom", None))
        # an open stratum: its neighbour's boundary is the same line
        if top is None and i > 0:
            top = _depth_text(getattr(raw_layers[i - 1], "bottom", None))
        if bottom is None and i + 1 < len(raw_layers):
            bottom = _depth_text(getattr(raw_layers[i + 1], "top", None))
        description = _text(getattr(layer, "description", None))
        page = int(getattr(prov, "page", 0) or 0)
        language = languages.get(page)
        din = _text(getattr(layer, "din_code", None))
        din_main = din.split(",")[0].strip() if din else None
        soil_unit = _text(getattr(layer, "soil_unit", None))
        out.append(
            ExtractedLayer(
                from_raw=blocks.cite(top, prov),
                to_raw=blocks.cite(bottom, prov),
                description_raw=blocks.cite(description, prov),
                description_language=language,
                english_lithology=description if language == "en" else None,
                din4023_code=din_main or None,
                din4023_notation=din,
                uscs_raw=blocks.cite(soil_unit if soil_unit and _USCS.match(soil_unit) else None, prov),
                colour_raw=blocks.cite(_text(getattr(layer, "color", None)), prov),
                consistency_raw=blocks.cite(_text(getattr(layer, "consistency", None)), prov),
                moisture_raw=blocks.cite(_text(getattr(layer, "moisture", None)), prov),
                weathering_raw=RawValue.absent(),
                stratigraphic_name_raw=blocks.cite(_text(getattr(layer, "stratigraphic_name", None)), prov),
            )
        )
    return out


def _points(
    bh: Any, blocks: _Blocks
) -> tuple[list[ExtractedSpt], list[ExtractedCoreRun], list[ExtractedSample], list[ExtractedGroundwater]]:
    spt: list[ExtractedSpt] = []
    runs: dict[tuple[str | None, str | None], dict[str, Any]] = {}
    samples: list[ExtractedSample] = []
    water: list[ExtractedGroundwater] = []
    for point in getattr(bh, "points", None) or []:
        kind = str(getattr(point, "kind", "")).upper()
        prov = getattr(point, "prov", None)
        depth = _depth_text(getattr(point, "depth", None))
        depth_to = _depth_text(getattr(point, "depth_to", None))
        value, label = getattr(point, "value", None), _text(getattr(point, "label", None))
        if kind == "SPT":
            n_text, blows = _spt_parts(value, label)
            spt.append(
                ExtractedSpt(
                    depth_raw=blocks.cite(depth, prov),
                    blows_raw=blocks.cite(blows, prov),
                    n_raw=blocks.cite(n_text, prov),
                    increment_note_raw=RawValue.absent(),
                )
            )
        elif kind in ("RQD", "TCR", "SCR"):
            run = runs.setdefault((depth, depth_to), {"prov": prov})
            run[kind] = _text(value)
        elif kind == "SAMPLE":
            name = label or _text(value)
            if name is None:
                continue
            samples.append(
                ExtractedSample(
                    name_raw=blocks.cite(name, prov),
                    type_raw=RawValue.absent(),
                    from_raw=blocks.cite(depth, prov),
                    to_raw=blocks.cite(depth_to, prov),
                )
            )
        elif kind == "GWL":
            water_depth = depth or _depth_text(value)
            if water_depth is None:
                continue
            note = " ".join(t for t in (label, _text(value) if depth else None) if t)
            water_type = "strike" if _GW_STRIKE.search(note) else "rest" if _GW_REST.search(note) else "other"
            water.append(
                ExtractedGroundwater(type=water_type, depth_raw=blocks.cite(water_depth, prov), date_raw=None)
            )
    cores = [
        ExtractedCoreRun(
            from_raw=blocks.cite(top, run["prov"]),
            to_raw=blocks.cite(bottom or top, run["prov"]),
            tcr_raw=blocks.cite(run.get("TCR"), run["prov"]),
            scr_raw=blocks.cite(run.get("SCR"), run["prov"]),
            rqd_raw=blocks.cite(run.get("RQD"), run["prov"]),
            ff_raw=RawValue.absent(),
        )
        for (top, bottom), run in runs.items()
        if top is not None
    ]
    return spt, cores, samples, water


def _spt_parts(value: Any, label: str | None) -> tuple[str | None, str | None]:
    """(N as printed, blows per increment) from bh3's value and its composite label "24 [2,3/4,6,6,8]"."""
    if label:
        match = _SPT_LABEL.match(label)
        if match:
            return (_text(match.group("n")) or _text(value)), _text(match.group("blows"))
    return _text(value) or label, None


def covered(groups: Iterable[PageGroup], pages: set[int]) -> list[PageGroup]:
    """Classic groups none of whose pages belong to a bh3 borehole: the classic extractor takes these."""
    return [g for g in groups if not set(g.pages) & pages]
