"""Offline tests for document discovery and rendering."""
from __future__ import annotations

import zipfile
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

from app.bh3.inputs import discover, natural_key
from app.bh3.render import render_page, vector_words
from tests.test_bh3_bridge import _line, _text


def _png(path: Path, size=(500, 500)):
    Image.new("RGB", size, (255, 255, 255)).save(path)


def _pdf(path: Path, text: str = "BOREHOLE LOG  depth 1.0 2.0 3.0  sandy CLAY grey stiff moist  silty SAND brown loose"):
    pdf = pdfium.PdfDocument.new()
    page = pdf.new_page(595, 842)
    _text(pdf, page, text, 72, 842 - 72, 11)
    _line(page, 50, 742, 500, 742)
    pdfium_c.FPDFPage_GenerateContent(page.raw)
    pdf.save(str(path))
    pdf.close()


def test_natural_key():
    assert sorted(["a_10", "a_4", "a_2"], key=natural_key) == ["a_2", "a_4", "a_10"]


def test_folder_dedupe_prefers_pdf(tmp_path: Path):
    _pdf(tmp_path / "R.pdf")
    for n in ("R_4.png", "R_10.png", "other.png"):
        _png(tmp_path / n)
    docs = discover([tmp_path])
    kinds = {d.kind: d for d in docs}
    assert kinds["pdf"].doc_id == "R" and len(kinds["pdf"].pages) == 1
    folder = kinds["folder"]
    assert [Path(p.image_path).name for p in folder.pages] == ["other.png"]
    assert len(folder.skipped) == 2

    docs = discover([tmp_path], prefer="images")
    folder = next(d for d in docs if d.kind == "folder")
    assert [Path(p.image_path).name for p in folder.pages] == ["other.png", "R_4.png", "R_10.png"]
    assert not any(d.kind == "pdf" for d in docs) and any("R.pdf" in s for s in folder.skipped)


def test_docx_images_in_body_order(tmp_path: Path):
    import io
    def png_bytes(size):
        b = io.BytesIO()
        Image.new("RGB", size, (200, 200, 200)).save(b, "PNG")
        return b.getvalue()
    big = png_bytes((600, 800))
    # pad to exceed the size threshold (PNG of flat colour compresses well)
    big = big + b"\0" * 60_000
    tiny = png_bytes((100, 100))
    p = tmp_path / "t.docx"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("word/document.xml", '<w:document><w:body><w:p><a:blip r:embed="rId3"/></w:p>'
                                        '<w:p><a:blip r:embed="rId2"/></w:p><w:p><a:blip r:embed="rId9"/></w:p></w:body></w:document>')
        z.writestr("word/_rels/document.xml.rels", '<Relationships><Relationship Id="rId2" Target="media/image1.png"/>'
                                                   '<Relationship Id="rId3" Target="media/image2.png"/>'
                                                   '<Relationship Id="rId9" Target="media/image3.png"/></Relationships>')
        z.writestr("word/media/image1.png", big)
        z.writestr("word/media/image2.png", big)
        z.writestr("word/media/image3.png", tiny)
    docs = discover([p])
    assert docs[0].kind == "docx"
    assert [pg.docx_member for pg in docs[0].pages] == ["word/media/image2.png", "word/media/image1.png"]
    assert any("image3" in s for s in docs[0].skipped)


def test_render_cache_and_vector_words(tmp_path: Path):
    pdf = tmp_path / "v.pdf"
    _pdf(pdf)
    doc = discover([pdf])[0]
    src = doc.pages[0]
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
    page = vector_words(discover([gib])[0].pages[0])
    assert page is not None and not page.has_text_layer


def test_image_render_scales_like_a4(tmp_path: Path):
    img = tmp_path / "photo.jpg"
    Image.new("RGB", (2400, 3400), (255, 255, 255)).save(img)
    src = discover([img])[0].pages[0]
    out = render_page(src, 150, tmp_path / "work")
    im = Image.open(out)
    assert abs(im.height - 842 * 150 / 72) <= 2
