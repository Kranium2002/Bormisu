"""Vector path: the v1 deterministic parser for pages with a usable text layer.

  triage (keywords, depth scale) -> geometry (ruled columns -> layers / points) -> header aliases

Frozen: it is exact on clean vector logs (AUS01, AF01, FullReport01) and is only ever extended through
the regression eval. Pages it cannot parse (< 2 layers, no scale) go to the vision path with the
page's text as a transcript hint (bh3.extract).
"""
from __future__ import annotations

import math
import re
from typing import TYPE_CHECKING, Optional

from ..inputs import PageSource

if TYPE_CHECKING:
    from ..reconcile import PageResult
from . import triage as bh_triage
from .geometry import parse_log_page
from .header import extract_header


def parse_vector_page(src: PageSource, page) -> Optional["PageResult"]:
    from ..reconcile import PageResult          # late import: reconcile imports vector.header
    """The deterministic parse of a text-layer page. None if the page is not a log or parsing failed."""
    cls, conf, feats = bh_triage.classify(page)
    page.page_class, page.class_score, page.features = cls, conf, feats
    pr = PageResult(src.source_file, src.page_no, "vector", page_type=cls, read_quality="clean", depth_unit="m")
    pr.stats = {"triage_score": conf, "n_words": feats.get("n_words")}
    if cls != "log":
        return pr
    pl = parse_log_page(page)
    hdr = extract_header(page, pl.header_words)
    pr.layers = pl.layers
    pr.points = pl.points
    pr.header_fields = dict(hdr.fields)
    pr.header_extras = dict(hdr.extras)
    pr.header_text = hdr.text
    pr.notes = list(pl.notes)
    pr.borehole_name = hdr.fields.get("BoreholeName")
    sheet = str(hdr.extras.get("Sheet", ""))
    m = re.match(r"\s*(\d+)\s*(?:of|/|de|von)\s*(\d+)", sheet, re.I)
    if m:
        pr.sheet_no, pr.sheet_total = int(m.group(1)), int(m.group(2))
    if isinstance(hdr.fields.get("BoreholeDepth"), (int, float)):
        pr.total_depth = float(hdr.fields["BoreholeDepth"])
    confs = [L.prov.confidence for L in pl.layers] or [1.0]
    pr.confidence = round(sum(confs) / len(confs), 2)
    pr.stats.update({"scale": bool(pl.scale), "n_layers": len(pl.layers)})
    return pr


def vector_ok(pr: "PageResult") -> bool:
    real = [L for L in pr.layers if not (math.isnan(L.top) and math.isnan(L.bottom))]
    bad = any("no depth scale" in n or "no table" in n or "no description column" in n for n in pr.notes)
    return len(real) >= 2 and not bad
