"""Offline tests for page rendering and text-layer words."""
from __future__ import annotations

from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

from app.bh3.inputs import PageSource
from app.bh3.render import render_page, vector_words
from tests.test_bh3_bridge import _line, _text


def _pdf(path: Path, text: str = "BOREHOLE LOG  depth 1.0 2.0 3.0  sandy CLAY grey stiff moist  silty SAND brown loose"):
    pdf = pdfium.PdfDocument.new()
    page = pdf.new_page(595, 842)
    _text(pdf, page, text, 72, 842 - 72, 11)
    _line(page, 50, 742, 500, 742)
    pdfium_c.FPDFPage_GenerateContent(page.raw)
    pdf.save(str(path))
    pdf.close()


def _pdf_page(path: Path) -> PageSource:
    return PageSource(path.stem, str(path), 1, "pdf", pdf_path=str(path), pdf_index=0)


def test_render_cache_and_vector_words(tmp_path: Path):
    pdf = tmp_path / "v.pdf"
    _pdf(pdf)
    src = _pdf_page(pdf)
    a = render_page(src, 72, tmp_path / "work")
    b = render_page(src, 72, tmp_path / "work")
    assert a == b and a.exists()
    im = Image.open(a)
    assert abs(im.width - 595) <= 2 and abs(im.height - 842) <= 2
    c = render_page(src, 72, tmp_path / "work", preprocess=True)
    assert c != a and c.exists()
    page = vector_words(src)
    assert page is not None and page.has_text_layer and len(page.words) >= 5 and page.segments

    gib = tmp_path / "g.pdf"
    _pdf(gib, "@#$% ^&* ()_+ {}|:<>? ~~~ !!! ;;; ,,, ... ///")
    page = vector_words(_pdf_page(gib))
    assert page is not None and not page.has_text_layer


def test_image_render_scales_like_a4(tmp_path: Path):
    img = tmp_path / "photo.jpg"
    Image.new("RGB", (2400, 3400), (255, 255, 255)).save(img)
    src = PageSource(img.stem, str(img), 1, "image", image_path=str(img))
    out = render_page(src, 150, tmp_path / "work")
    im = Image.open(out)
    assert abs(im.height - 842 * 150 / 72) <= 2
