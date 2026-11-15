"""Document discovery: what counts as a document and in which order its pages come.

  PDF            → one Document, one PageSource per page
  image pages    → one Document, one PageSource per rendered page (built by bridge._document)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional


@dataclass
class PageSource:
    doc_id: str
    source_file: str
    page_no: int
    kind: Literal["pdf", "image"]
    pdf_path: Optional[str] = None
    pdf_index: Optional[int] = None
    image_path: Optional[str] = None

    @property
    def label(self) -> str:
        base = Path(self.source_file).name
        if self.kind == "image" and Path(self.image_path or "").name != base:
            return f"{base}/{Path(self.image_path).name}"
        return f"{base} p{self.page_no}"


@dataclass
class Document:
    doc_id: str
    kind: Literal["pdf", "image"]
    path: str
    pages: list[PageSource] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------

def _pdf_document(path: Path) -> Document:
    from .pdfium import page_count
    n = page_count(str(path))
    d = Document(path.stem, "pdf", str(path))
    d.pages = [PageSource(path.stem, str(path), i + 1, "pdf", pdf_path=str(path), pdf_index=i) for i in range(n)]
    return d
