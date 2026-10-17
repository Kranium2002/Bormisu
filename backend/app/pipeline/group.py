"""Pages to borehole groups (BACKEND.md 7.5). Deterministic: the same pages always give the same groups.

`plan_page_groups` is a pure function over simple page records; `plan_groups` loads the records of one
document. Log pages (log_sheet, log_continuation) are walked in page order:

- a page that names labels joins the open group of each label it names, unless its sheet index is 1;
  every other label starts a new group (so a multi-hole sheet makes one group per label sharing the page);
- a page that names no label joins the open group(s), unless its sheet index is 1;
- a page that continues a log (sheet index > 1, role log_continuation or the classifier's is_continuation)
  but has no open group to join starts one marked "missing first sheet".

Doubtful boundaries never stop grouping: they are written to `PageGroup.uncertain` and become a
`borehole_boundary` clarification later. Summary, coordinate, lab-result and legend pages are context for
every group, never groups. Duplicate pages are never grouped.

Nothing here depends on a file, project, label text, page number, language or layout: the only inputs are
the classifier's roles, labels and sheet numbers.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import yaml
from sqlalchemy import select

from app.config import get_settings
from app.db.models import Page
from app.db.session import get_sessionmaker
from app.pipeline.types import PageGroup
from app.review.service import canonical_label

LOG_ROLES = frozenset({"log_sheet", "log_continuation"})
CONTEXT_ROLES = frozenset({"summary_table", "coordinate_table", "lab_results", "legend_or_key"})
DUPLICATE_ROLE = "duplicate"

# Reasons for a borehole_boundary clarification (stable texts; the page-specific ones are built below).
MISSING_FIRST_SHEET = "missing first sheet"
NO_LABEL = "no borehole label"

# Sheet totals above this are classifier noise, not a sheet count worth checking.
MAX_SHEET_TOTAL = 500
# Keys longer than this use a hash of the page list instead of the page ranges.
MAX_KEY_LENGTH = 96
NO_LABEL_KEY = "nolabel"  # lower case: canonical labels are upper case, so this never collides

_NUMBER = re.compile(r"\d+")


@dataclass(frozen=True)
class PageInfo:
    """What grouping needs from one page (from `pages` and the classifier's label)."""

    n: int
    role: str | None
    used: bool = True
    labels: tuple[str, ...] = ()
    sheet_label: str | None = None
    sheet_index: int | None = None
    sheet_total: int | None = None
    is_continuation: bool = False
    has_coordinates: bool = False


def page_info(page: Page) -> PageInfo:
    classifier: dict[str, Any] = page.classifier or {}
    return PageInfo(
        n=page.n,
        role=page.role,
        used=bool(page.used),
        labels=tuple(page.borehole_labels or ()),
        sheet_label=page.sheet_label,
        sheet_index=page.sheet_index,
        sheet_total=page.sheet_total,
        is_continuation=bool(classifier.get("is_continuation")),
        has_coordinates=bool(page.has_coordinates),
    )


def sheet_numbers(page: PageInfo) -> tuple[int | None, int | None]:
    """Sheet index and total. The classifier's numbers win; otherwise the numbers printed in the sheet label
    ("SHEET 2 OF 3", "Blatt 2/3", "Hoja 2 de 3", "2 (3)") are read language-independently: one number is
    the index, two ascending numbers are index and total."""
    index = page.sheet_index if page.sheet_index is not None and page.sheet_index > 0 else None
    total = page.sheet_total if page.sheet_total is not None and page.sheet_total > 0 else None
    if (index is None or total is None) and page.sheet_label:
        numbers = [int(m) for m in _NUMBER.findall(page.sheet_label)]
        if len(numbers) == 2 and 1 <= numbers[0] <= numbers[1]:
            index = index if index is not None else numbers[0]
            total = total if total is not None else numbers[1]
        elif len(numbers) == 1 and numbers[0] >= 1 and index is None:
            index = numbers[0]
    if total is not None and (total > MAX_SHEET_TOTAL or (index is not None and index > total)):
        total = None
    return index, total


@lru_cache(maxsize=1)
def _label_prefix() -> re.Pattern[str]:
    """A borehole word with a number sign in front of the label (data/page_roles.yaml label_prefixes)."""
    with (get_settings().data_dir / "page_roles.yaml").open(encoding="utf-8") as handle:
        data = (yaml.safe_load(handle) or {}).get("label_prefixes") or {}
    words = sorted((str(w) for w in data.get("words") or []), key=len, reverse=True)
    signs = sorted((str(s) for s in data.get("number_signs") or []), key=len, reverse=True)
    if not words or not signs:
        return re.compile(r"(?!)")
    word = "|".join(re.escape(w).replace(r"\ ", r"\s*") for w in words)
    sign = "|".join(re.escape(s) for s in signs)
    return re.compile(rf"^\s*(?:{word})\s*(?:{sign})\s*[:.\-]?\s*(?=\S)", re.IGNORECASE)


def clean_label(text: str) -> str:
    """The label without a printed "borehole number" prefix ("BORING NO. T01" -> "T01")."""
    cleaned = _label_prefix().sub("", text, count=1).strip()
    return cleaned or text


def _labels(raw_labels: Iterable[str]) -> list[tuple[str, str]]:
    """(canonical, raw) per distinct canonical label, in printed order; a printed "borehole number" prefix
    is not part of the label."""
    seen: dict[str, str] = {}
    for raw in raw_labels:
        text = clean_label(raw.strip())
        canonical = canonical_label(text) if text else ""
        if canonical and canonical not in seen:
            seen[canonical] = text
    return list(seen.items())


def _ranges(pages: Sequence[int]) -> str:
    parts: list[str] = []
    start = prev = pages[0]
    for n in pages[1:]:
        if n == prev + 1:
            prev = n
            continue
        parts.append(f"p{start}" if start == prev else f"p{start}-p{prev}")
        start = prev = n
    parts.append(f"p{start}" if start == prev else f"p{start}-p{prev}")
    return ",".join(parts)


def group_key(label_canonical: str | None, pages: Sequence[int]) -> str:
    """Stable key from the canonical label and the page numbers: "BH1:p3-p5", "nolabel:p7,p9"."""
    label = label_canonical or NO_LABEL_KEY
    key = f"{label}:{_ranges(sorted(pages))}"
    if len(key) <= MAX_KEY_LENGTH:
        return key
    digest = hashlib.sha256(json.dumps([label, sorted(pages)]).encode("utf-8")).hexdigest()[:16]
    return f"{label[:40]}:h{digest}"


@dataclass
class _Builder:
    label_canonical: str | None
    label_raw: str | None
    pages: list[int] = field(default_factory=list)
    sheets: dict[int, int | None] = field(default_factory=dict)  # page -> sheet index
    total: int | None = None
    uncertain: list[str] = field(default_factory=list)

    def add(self, n: int, index: int | None, total: int | None) -> None:
        if n not in self.pages:
            self.pages.append(n)
            self.sheets[n] = index
        if total is not None:
            self.total = max(self.total or 0, total)

    def note(self, reason: str) -> None:
        if reason not in self.uncertain:
            self.uncertain.append(reason)

    def last_index(self) -> int | None:
        return self.sheets.get(self.pages[-1]) if self.pages else None

    def finish(self, context: tuple[int, ...]) -> PageGroup:
        self._check_sheets()
        pages = tuple(sorted(self.pages))
        return PageGroup(
            key=group_key(self.label_canonical, pages),
            label_raw=self.label_raw,
            label_canonical=self.label_canonical,
            pages=pages,
            context_pages=tuple(n for n in context if n not in pages),
            uncertain=tuple(self.uncertain),
        )

    def _check_sheets(self) -> None:
        if self.total is None:
            return
        found = {i for i in self.sheets.values() if i is not None}
        missing = [i for i in range(1, self.total + 1) if i not in found]
        unnumbered = sum(1 for i in self.sheets.values() if i is None)
        if MISSING_FIRST_SHEET in self.uncertain:
            missing = [i for i in missing if i != 1]
        if len(missing) > unnumbered:
            self.note(f"sheets {_numbers(missing)} of {self.total} not found")


def _numbers(values: Sequence[int]) -> str:
    return _ranges(values).replace("p", "")


def _continues(page: PageInfo, index: int | None) -> bool:
    return page.role == "log_continuation" or page.is_continuation or (index is not None and index > 1)


def plan_page_groups(pages: Iterable[PageInfo]) -> list[PageGroup]:
    """Groups of one document's pages, in order of their first page (see the module docstring)."""
    ordered = sorted((p for p in pages if p.used and p.role != DUPLICATE_ROLE), key=lambda p: p.n)
    context = tuple(
        p.n for p in ordered if p.role in CONTEXT_ROLES or (p.role not in LOG_ROLES and p.has_coordinates)
    )
    builders: list[_Builder] = []
    open_groups: list[_Builder] = []

    for page in ordered:
        if page.role not in LOG_ROLES:
            continue
        index, total = sheet_numbers(page)
        continues = _continues(page, index)
        restart = index == 1
        labels = _labels(page.labels)

        if not labels:
            if open_groups and not restart:
                for builder in open_groups:
                    builder.add(page.n, index, total)
                    if not continues:
                        builder.note(f"page {page.n} has no borehole label; read as a further sheet")
                continue
            builder = _Builder(None, None)
            builder.add(page.n, index, total)
            builder.note(NO_LABEL)
            if continues:
                builder.note(MISSING_FIRST_SHEET)
            builders.append(builder)
            open_groups = [builder]
            continue

        # An unlabelled first sheet followed by its labelled further sheet: the group takes the label.
        if (
            len(labels) == 1
            and len(open_groups) == 1
            and open_groups[0].label_canonical is None
            and continues
            and not restart
            and all(b.label_canonical != labels[0][0] for b in builders)
        ):
            builder = open_groups[0]
            builder.label_canonical, builder.label_raw = labels[0]
            builder.uncertain = [r for r in builder.uncertain if r != NO_LABEL]
            builder.note(f"label {labels[0][1]} printed only from page {page.n} on")
            builder.add(page.n, index, total)
            continue

        open_labels = {b.label_canonical: b for b in open_groups}
        page_canonicals = {canonical for canonical, _ in labels}
        next_open: list[_Builder] = []
        for canonical, raw in labels:
            target = open_labels.get(canonical)
            if target is not None and not restart:
                target.add(page.n, index, total)
                next_open.append(target)
                continue
            builder = _Builder(canonical, raw)
            builder.add(page.n, index, total)
            if continues:
                builder.note(MISSING_FIRST_SHEET)
                for previous in open_groups:
                    last = previous.last_index()
                    if (
                        previous.label_canonical not in page_canonicals
                        and index is not None
                        and last is not None
                        and index == last + 1
                    ):
                        shown = previous.label_raw or "an unlabelled log"
                        builder.note(f"label conflict: page {page.n} numbers on from {shown} but names {raw}")
            earlier = [b for b in builders if b.label_canonical == canonical]
            if earlier:
                reason = f"label {raw} appears in more than one log of this document"
                builder.note(reason)
                for other in earlier:
                    other.note(reason)
            builders.append(builder)
            next_open.append(builder)
        open_groups = next_open

    return [builder.finish(context) for builder in builders]


async def plan_groups(document_id: str) -> list[PageGroup]:
    """The page groups of one document from its classified pages."""
    async with get_sessionmaker()() as session:
        rows = (
            await session.scalars(select(Page).where(Page.document_id == document_id).order_by(Page.n))
        ).all()
        infos = [page_info(page) for page in rows]
    return plan_page_groups(infos)
