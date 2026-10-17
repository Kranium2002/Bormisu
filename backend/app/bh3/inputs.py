"""Document discovery: what counts as a document and in which order its pages come.

  PDF            → one Document, one PageSource per page
  image file     → one Document with one page
  folder         → every PDF/DOCX inside is its own Document; the images directly inside form ONE Document
                   (natural sort: Report01_4 before Report01_10). Images that are renders of a sibling PDF
                   (`X.pdf` next to `X_<n>.png`) are skipped unless prefer="images".
  DOCX           → the embedded images in body order (walk r:embed in document.xml, resolve through the rels)
                   – no LibreOffice needed, and the junk text layer Word adds to scanned pages is ignored.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Literal, Optional

log = logging.getLogger(__name__)

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}
PDF_EXT = {".pdf"}
DOCX_EXT = {".docx"}
SUPPORTED_EXT = IMAGE_EXT | PDF_EXT | DOCX_EXT
MIN_DOCX_IMAGE_BYTES = 50_000
MIN_DOCX_IMAGE_PX = 400


@dataclass
class PageSource:
    doc_id: str
    source_file: str
    page_no: int
    kind: Literal["pdf", "image", "docx-image"]
    pdf_path: Optional[str] = None
    pdf_index: Optional[int] = None
    image_path: Optional[str] = None
    docx_member: Optional[str] = None

    @property
    def label(self) -> str:
        base = Path(self.source_file).name
        if self.kind == "image" and Path(self.image_path or "").name != base:
            return f"{base}/{Path(self.image_path).name}"
        return f"{base} p{self.page_no}"


@dataclass
class Document:
    doc_id: str
    kind: Literal["pdf", "image", "folder", "docx"]
    path: str
    pages: list[PageSource] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def natural_key(name: str) -> list:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def is_supported(path: Path) -> bool:
    return path.suffix.lower() in SUPPORTED_EXT


# ---------------------------------------------------------------------------

def _pdf_document(path: Path) -> Document:
    from .pdfium import page_count
    n = page_count(str(path))
    d = Document(path.stem, "pdf", str(path))
    d.pages = [PageSource(path.stem, str(path), i + 1, "pdf", pdf_path=str(path), pdf_index=i) for i in range(n)]
    return d


def _image_document(path: Path) -> Document:
    d = Document(path.stem, "image", str(path))
    d.pages = [PageSource(path.stem, str(path), 1, "image", image_path=str(path))]
    return d


def _docx_document(path: Path) -> Document:
    from PIL import Image
    d = Document(path.stem, "docx", str(path))
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if "word/document.xml" not in names:
            d.skipped.append("no word/document.xml")
            return d
        rels: dict[str, str] = {}
        if "word/_rels/document.xml.rels" in names:
            rx = z.read("word/_rels/document.xml.rels").decode("utf8", "replace")
            for m in re.finditer(r"<Relationship\b([^>]*)/?>", rx):
                attrs = m.group(1)
                rid = re.search(r'\bId="([^"]+)"', attrs)
                tgt = re.search(r'\bTarget="([^"]+)"', attrs)
                if rid and tgt:
                    t = tgt.group(1).replace("\\", "/")
                    t = t[1:] if t.startswith("/") else t
                    rels[rid.group(1)] = t if t.startswith("word/") else "word/" + t.lstrip("./")
        body = z.read("word/document.xml").decode("utf8", "replace")
        seen: set[str] = set()
        order: list[str] = []
        for m in re.finditer(r'\br:(?:embed|link)="([^"]+)"', body):
            member = rels.get(m.group(1))
            if not member or member in seen:
                continue
            seen.add(member)
            order.append(member)
        page = 0
        for member in order:
            if member not in names:
                d.skipped.append(f"{member}: missing in archive")
                continue
            if Path(member).suffix.lower() not in IMAGE_EXT:
                d.skipped.append(f"{member}: not a raster image")
                continue
            data = z.read(member)
            if len(data) < MIN_DOCX_IMAGE_BYTES:
                d.skipped.append(f"{member}: too small ({len(data)} bytes)")
                continue
            try:
                with Image.open(io.BytesIO(data)) as im:
                    w, h = im.size
            except Exception as e:  # noqa: BLE001
                d.skipped.append(f"{member}: unreadable ({e})")
                continue
            if max(w, h) < MIN_DOCX_IMAGE_PX:
                d.skipped.append(f"{member}: too small ({w}x{h})")
                continue
            page += 1
            d.pages.append(PageSource(path.stem, str(path), page, "docx-image", docx_member=member))
    return d


def _folder_documents(folder: Path, prefer: str) -> list[Document]:
    docs: list[Document] = []
    entries = sorted(folder.iterdir(), key=lambda p: natural_key(p.name))
    pdfs = [p for p in entries if p.is_file() and p.suffix.lower() in PDF_EXT]
    docxs = [p for p in entries if p.is_file() and p.suffix.lower() in DOCX_EXT]
    imgs = [p for p in entries if p.is_file() and p.suffix.lower() in IMAGE_EXT]
    subdirs = [p for p in entries if p.is_dir()]

    # images that are renders of a sibling PDF: stem == '<pdfstem>_<digits>' (or exactly the pdf stem)
    def render_of(img: Path) -> Optional[Path]:
        for pdf in pdfs:
            if re.fullmatch(re.escape(pdf.stem) + r"(?:[_\- ]?(?:p|page)?\d+)?", img.stem, re.I):
                return pdf
        return None

    derived = {img: render_of(img) for img in imgs}
    skipped_pdfs: set[Path] = set()
    folder_doc = Document(folder.name, "folder", str(folder))
    page = 0
    for img in imgs:
        pdf = derived[img]
        if pdf is not None and prefer == "pdf":
            folder_doc.skipped.append(f"{img.name} skipped: render of {pdf.name}")
            continue
        if pdf is not None and prefer == "images":
            skipped_pdfs.add(pdf)
        page += 1
        folder_doc.pages.append(PageSource(folder.name, str(folder), page, "image", image_path=str(img)))
    for pdf in pdfs:
        if pdf in skipped_pdfs:
            folder_doc.skipped.append(f"{pdf.name} skipped: its page images are used instead")
            continue
        docs.append(_pdf_document(pdf))
    for dx in docxs:
        docs.append(_docx_document(dx))
    if folder_doc.pages or folder_doc.skipped:
        docs.append(folder_doc)
    for sd in subdirs:
        docs += _folder_documents(sd, prefer)
    return docs


def discover(inputs: Iterable[str | Path], prefer: str = "pdf") -> list[Document]:
    """Documents for the given files/folders, deterministic order. `prefer` = 'pdf' | 'images'."""
    out: list[Document] = []
    for s in inputs:
        p = Path(s)
        if p.is_dir():
            out += _folder_documents(p, prefer)
        elif p.is_file() and p.suffix.lower() in PDF_EXT:
            out.append(_pdf_document(p))
        elif p.is_file() and p.suffix.lower() in DOCX_EXT:
            out.append(_docx_document(p))
        elif p.is_file() and p.suffix.lower() in IMAGE_EXT:
            out.append(_image_document(p))
        else:
            log.warning("unsupported input ignored: %s", p)
    return out
