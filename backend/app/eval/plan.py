"""What an eval run will process: files resolved in the data folder, page excerpts, page counts, estimates.

Nothing here calls a provider or the database. A short id is the name given on the command line (`--files`);
without `--files`, every entry of the expected file found in the data folder is planned under an
anonymous id (file-01, file-02 …), because file names may appear in the report only as ids the user chose.
A short id may name a file or a folder; every accepted file in a folder becomes its own document, as if
uploaded one by one.
"""

from __future__ import annotations

import io
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
import yaml
from PIL import Image

from app.config import get_settings
from app.eval.expected import ExpectedFile, ExpectedFileError, file_key, find_entry, name_keys
from app.providers.base import ocr_cost, token_cost

OFFICE_EXTENSIONS = frozenset({".docx", ".doc", ".odt", ".pptx"})
SPREADSHEET_EXTENSIONS = frozenset({".xlsx", ".csv"})
_PAGES_ARG = re.compile(r"^(?P<name>.+)=(?P<first>\d+)(?:\s*-\s*(?P<last>\d+))?$")


class PlanError(ValueError):
    """The run cannot be planned (bad arguments or files); the message is for the terminal."""


@lru_cache
def eval_config() -> dict[str, Any]:
    """Harness settings: backend/data/eval.yaml when present, else the defaults next to this module."""
    path = get_settings().data_dir / "eval.yaml"
    if not path.exists():
        path = Path(__file__).with_name("defaults.yaml")
    with path.open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle) or {}
    return data


def _setting(section: str, key: str) -> float:
    value = eval_config()[section][key]
    return float(value)


def max_pages_in_range() -> int:
    return int(_setting("compare", "max_pages_in_range"))


def prior_usd_per_page() -> float:
    """Worst-case cost of one page: classified, read by OCR and sent to the extractor."""
    settings = get_settings()
    return (
        _setting("estimate", "classify_usd_per_page")
        + ocr_cost(settings.mistral_ocr_model, 1)
        + token_cost(
            settings.extractor_model,
            int(_setting("estimate", "extract_input_tokens_per_page")),
            int(_setting("estimate", "extract_output_tokens_per_page")),
        )
    )


@dataclass(frozen=True)
class SourceFile:
    path: Path
    pages: int | None  # pages the pipeline will see; None when unknown before conversion


@dataclass(frozen=True)
class PlannedFile:
    short_id: str
    sources: tuple[SourceFile, ...]
    expected: ExpectedFile | None
    excerpt: tuple[int, int] | None = None
    ignored_files: int = 0  # files in a folder whose type the upload refuses

    @property
    def page_estimate(self) -> int:
        unknown = int(_setting("estimate", "pages_if_unknown"))
        return sum(unknown if s.pages is None else s.pages for s in self.sources)

    @property
    def excerpt_pages(self) -> int | None:
        return None if self.excerpt is None else self.excerpt[1] - self.excerpt[0] + 1


@dataclass
class Plan:
    files: list[PlannedFile]
    unresolved: list[str] = field(default_factory=list)  # entries without a file (terminal only)


def pdf_page_count(path: Path) -> int | None:
    try:
        pdf = pdfium.PdfDocument(path)
    except Exception:  # pypdfium2 raises PdfiumError and others for damaged or encrypted files
        return None
    try:
        return len(pdf)
    finally:
        pdf.close()


def image_page_count(path: Path) -> int | None:
    try:
        with Image.open(path) as img:
            return int(getattr(img, "n_frames", 1))
    except Exception:  # Pillow raises many types for unreadable files
        return None


def page_count(path: Path) -> int | None:
    extension = path.suffix.lower()
    if extension == ".pdf":
        return pdf_page_count(path)
    if extension in SPREADSHEET_EXTENSIONS or extension in OFFICE_EXTENSIONS:
        return None  # pages (or model calls) are known only after conversion
    return image_page_count(path)


def excerpt_pdf(source: Path, first: int, last: int) -> bytes:
    """Pages first..last (1-based, inclusive) of a PDF as a new PDF (pypdfium2)."""
    pdf = pdfium.PdfDocument(source)
    try:
        if not 1 <= first <= last <= len(pdf):
            raise PlanError(f"pages {first}-{last} are outside the file's {len(pdf)} pages")
        excerpt = pdfium.PdfDocument.new()
        try:
            excerpt.import_pages(pdf, list(range(first - 1, last)))
            buffer = io.BytesIO()
            excerpt.save(buffer)
            return buffer.getvalue()
        finally:
            excerpt.close()
    finally:
        pdf.close()


def parse_pages_arg(value: str) -> tuple[str, int, int]:
    """NAME=FROM-TO (or NAME=N) from the command line."""
    match = _PAGES_ARG.match(value.strip())
    if match is None:
        raise PlanError(f"--pages {value}: expected NAME=FROM-TO")
    first = int(match.group("first"))
    last = int(match.group("last") or first)
    if first < 1 or last < first:
        raise PlanError(f"--pages {value}: the range must start at 1 or later and not run backwards")
    return match.group("name").strip(), first, last


def _accepted(path: Path, extensions: Sequence[str]) -> bool:
    return path.is_file() and path.suffix.lower() in extensions


def resolve(data_dir: Path, name: str) -> Path:
    """The file or folder in `data_dir` that a short id names: the path itself, else a unique match of the
    name (with or without extension) anywhere below the folder."""
    direct = data_dir / name
    if direct.exists() and direct.resolve().is_relative_to(data_dir.resolve()):
        return direct
    whole, stem = name_keys(name)
    candidates = sorted(p for p in data_dir.rglob("*") if p.is_file() or p.is_dir())
    for key in dict.fromkeys((whole, stem)):
        found = [p for p in candidates if key and key in (file_key(p.name), file_key(p.stem))]
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            raise PlanError(f"'{name}' matches more than one file or folder in the data folder")
    raise PlanError(f"'{name}' matches no file or folder in the data folder")


def _sources(path: Path, extensions: Sequence[str]) -> tuple[tuple[SourceFile, ...], int]:
    if path.is_dir():
        files = sorted(p for p in path.iterdir() if p.is_file())
        accepted = [p for p in files if _accepted(p, extensions)]
        return tuple(SourceFile(p, page_count(p)) for p in accepted), len(files) - len(accepted)
    if not _accepted(path, extensions):
        return (), 1
    return (SourceFile(path, page_count(path)),), 0


def build_plan(
    data_dir: Path,
    entries: Sequence[ExpectedFile],
    *,
    names: Sequence[str] | None,
    pages: Sequence[str] = (),
) -> Plan:
    """Resolve the files of the run in command-line order (or the expected file's order)."""
    if not data_dir.is_dir():
        raise PlanError("The data folder does not exist.")
    extensions = get_settings().extensions
    plan = Plan(files=[])
    chosen: list[tuple[str, Path, ExpectedFile | None]] = []
    if names:
        if len({file_key(n) for n in names}) != len(names):
            raise PlanError("A file is named twice in --files.")
        for name in names:
            try:
                chosen.append((name, resolve(data_dir, name), find_entry(entries, name)))
            except ExpectedFileError as exc:
                raise PlanError(str(exc)) from exc
    else:
        for entry in entries:
            try:
                path = resolve(data_dir, entry.name)
            except PlanError:
                plan.unresolved.append(entry.name)
                continue
            chosen.append((f"file-{len(chosen) + 1:02d}", path, entry))
    excerpts: dict[str, tuple[int, int]] = {}
    for value in pages:
        name, first, last = parse_pages_arg(value)
        match = [
            short for short, path, _ in chosen if file_key(name) in (file_key(short), *name_keys(path.name))
        ]
        if len(match) != 1:
            raise PlanError(f"--pages {value}: '{name}' is not one of the files of this run")
        if match[0] in excerpts:
            raise PlanError(f"--pages names '{name}' twice")
        excerpts[match[0]] = (first, last)
    for short, path, expected in chosen:
        sources, ignored = _sources(path, extensions)
        excerpt = excerpts.get(short)
        if excerpt is not None:
            if len(sources) != 1 or sources[0].path.suffix.lower() != ".pdf":
                raise PlanError(f"--pages works on single PDF files only ('{short}')")
            total = sources[0].pages
            if total is None:
                raise PlanError(f"'{short}' cannot be opened as a PDF")
            if excerpt[1] > total:
                raise PlanError(f"--pages for '{short}' ends after the file's last page ({total})")
            sources = (SourceFile(sources[0].path, excerpt[1] - excerpt[0] + 1),)
        if not sources:
            raise PlanError(f"'{short}' holds no file of an accepted type")
        plan.files.append(PlannedFile(short, sources, expected, excerpt, ignored))
    return plan
