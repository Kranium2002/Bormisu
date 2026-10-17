"""Page images for the vision model, and text-layer words for vector pages.

Renders are cached under `workdir/render/<sha1 of source file>/`. PDF pages are rendered with
`page.get_pixmap()` on the page as it is displayed (honours /Rotate and CropBox; MediaBox is never used).
Images are scaled so that their long side matches what an A4 page would have at the requested dpi, which
keeps the vision model's pixel budget in the same range for all inputs.
"""
from __future__ import annotations

import hashlib
import threading
import io
import logging
import re
import zipfile
from pathlib import Path
from typing import Optional

from .vector import textlayer as bh_ingest
from .vector import triage as bh_triage
from .models import Page, Word

from .inputs import PageSource

log = logging.getLogger(__name__)

A4_LONG_PT = 842.0
_sha_cache: dict[tuple[str, float, int], str] = {}
_doc_cache: dict[str, object] = {}


def file_sha1(path: str | Path) -> str:
    p = Path(path)
    st = p.stat()
    key = (str(p.resolve()), st.st_mtime, st.st_size)
    if key in _sha_cache:
        return _sha_cache[key]
    h = hashlib.sha1()
    if p.is_dir():
        # a folder document: identity = its files' names, sizes and mtimes
        for f in sorted(p.iterdir()):
            if f.is_file():
                s = f.stat()
                h.update(f"{f.name}|{s.st_size}|{int(s.st_mtime)}".encode())
    else:
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    _sha_cache[key] = h.hexdigest()[:12]
    return _sha_cache[key]


def _open_pdf(path: str):
    import pymupdf
    d = _doc_cache.get(path)
    if d is None:
        d = pymupdf.open(path)
        _doc_cache[path] = d
    return d


def clear_cache() -> None:
    for d in _doc_cache.values():
        try:
            d.close()
        except Exception:  # noqa: BLE001
            pass
    _doc_cache.clear()


def _load_source_image(src: PageSource):
    from PIL import Image, ImageOps
    if src.kind == "image":
        im = Image.open(src.image_path)
    elif src.kind == "docx-image":
        with zipfile.ZipFile(src.source_file) as z:
            im = Image.open(io.BytesIO(z.read(src.docx_member)))
            im.load()
    else:
        raise ValueError(f"not an image source: {src.kind}")
    im = ImageOps.exif_transpose(im)
    return im.convert("RGB")


def render_dir(src: PageSource, workdir: Path) -> Path:
    d = Path(workdir) / "render" / file_sha1(src.source_file)
    d.mkdir(parents=True, exist_ok=True)
    return d


def preprocess_image(im):
    """Deterministic clean-up for faded scans: grey, autocontrast, mild unsharp. PIL only."""
    from PIL import ImageFilter, ImageOps
    g = ImageOps.grayscale(im)
    g = ImageOps.autocontrast(g, cutoff=1)
    g = g.filter(ImageFilter.UnsharpMask(radius=2, percent=80, threshold=3))
    return g.convert("RGB")


def render_page(src: PageSource, dpi: int, workdir: Path, max_px: int = 4000, preprocess: bool = False) -> Path:
    """JPEG of the page at `dpi` (cached). Images are scaled like an A4 page at that dpi, never upscaled."""
    out = render_dir(src, workdir) / f"p{src.page_no:03d}_{dpi}{'_pp' if preprocess else ''}.jpg"
    if out.exists() and image_ok(out):
        return out
    from PIL import Image
    if src.kind == "pdf":
        import pymupdf
        pg = _open_pdf(src.pdf_path)[src.pdf_index]
        scale = dpi / 72.0
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    else:
        im = _load_source_image(src)
        target_long = A4_LONG_PT * dpi / 72.0
        # scale like an A4 page at this dpi; small photos/screenshots are upscaled at most 2× (no new
        # information, but the model's patch grid then sees the glyphs at a usable size)
        f = min(2.0, target_long / max(im.size))
        if abs(f - 1.0) > 0.02:
            im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))), Image.LANCZOS)
    if max(im.size) > max_px:
        f = max_px / max(im.size)
        im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))), Image.LANCZOS)
    if preprocess:
        im = preprocess_image(im)
    save_atomic(im, out)
    return out


def image_ok(path: Path) -> bool:
    """A cached JPEG may be truncated when two runs shared the cache; treat it as absent then."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            im.load()
        return True
    except Exception:  # noqa: BLE001
        try:
            Path(path).unlink()
        except OSError:
            pass
        return False


def save_atomic(im, out: Path, quality: int = 85) -> None:
    """Write to a temp file next to the target and rename, so readers never see a half-written image."""
    import os
    out.parent.mkdir(parents=True, exist_ok=True)
    import time
    tmp = out.with_name(out.stem + f".tmp{os.getpid()}_{threading.get_ident()}" + out.suffix)
    im.save(tmp, "JPEG", quality=quality)
    # Windows: an antivirus scan or a reader in another thread can hold the target for a moment
    for attempt in range(6):
        try:
            os.replace(tmp, out)
            return
        except PermissionError:
            time.sleep(0.2 * (attempt + 1))
    try:
        im.save(out, "JPEG", quality=quality)       # last resort: direct write
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def page_size_pt(src: PageSource) -> tuple[float, float]:
    if src.kind == "pdf":
        r = _open_pdf(src.pdf_path)[src.pdf_index].rect
        return float(r.width), float(r.height)
    im = _load_source_image(src)
    f = A4_LONG_PT / max(im.size)
    return im.width * f, im.height * f


def crop_norm(img_path: Path, bbox: tuple[float, float, float, float], out_path: Path, pad: float = 0.02) -> Path:
    from PIL import Image
    im = Image.open(img_path)
    W, H = im.size
    x0, y0, x1, y1 = bbox
    box = (int(max(0.0, x0 - pad) * W), int(max(0.0, y0 - pad) * H), int(min(1.0, x1 + pad) * W), int(min(1.0, y1 + pad) * H))
    if box[2] - box[0] < 10 or box[3] - box[1] < 10:
        box = (0, 0, W, H)
    save_atomic(im.crop(box), out_path)
    return out_path


def rotate_upright(img_path: Path) -> tuple[Path, int]:
    """Landscape strips (wider than 1.6× height) are rotated 90° clockwise so the depth axis runs down."""
    from PIL import Image
    im = Image.open(img_path)
    if im.width <= 1.6 * im.height:
        return img_path, 0
    out = img_path.with_name(img_path.stem + "_rot90.jpg")
    if not (out.exists() and image_ok(out)):
        save_atomic(im.rotate(-90, expand=True), out)
    return out, 90


# ---------------------------------------------------------------------------
# vector pages
# ---------------------------------------------------------------------------

_VOWEL = re.compile(r"[aeiouyàáâäãåæèéêëìíîïòóôöõøùúûüœ]", re.I)
_ALPHA = re.compile(r"^[A-Za-zÀ-ɏ]{3,}$")


def dictionary_ratio(words: list[Word]) -> float:
    toks = [w.text for w in words if re.search(r"[A-Za-zÀ-ɏ]{3,}", w.text)]
    if not toks:
        return 0.0
    good = sum(1 for t in toks if _ALPHA.match(t) and _VOWEL.search(t))
    return good / len(toks)


def text_layer_usable(words: list[Word]) -> bool:
    """the text-layer size/alnum test AND evidence the glyphs decode to real words (ToUnicode-less fonts fail here)."""
    if not bh_ingest._text_layer_usable(words):
        return False
    text = " ".join(w.text for w in words)
    kw = bh_triage._kw_hits(text, bh_triage.LOG_KW + bh_triage.LAB_KW + bh_triage.COVER_KW)
    return kw > 0 or dictionary_ratio(words) >= 0.3


def vector_words(src: PageSource) -> Optional[Page]:
    """Page with text-layer words and drawing segments (no OCR). None for non-PDF sources."""
    if src.kind != "pdf":
        return None
    import pymupdf
    pg = _open_pdf(src.pdf_path)[src.pdf_index]
    rect = pg.rect
    page = Page(doc_id=src.doc_id, source_file=src.source_file, page_no=src.page_no, width=rect.width, height=rect.height)
    try:
        area = 0.0
        for info in pg.get_image_info():
            b = pymupdf.Rect(info["bbox"]) & rect
            area += max(0.0, b.width * b.height)
        page.image_area_ratio = min(1.0, area / max(1.0, rect.width * rect.height))
    except Exception:  # noqa: BLE001
        page.image_area_ratio = 0.0
    page.words = bh_ingest._words_from_textpage(pg)
    page.has_text_layer = text_layer_usable(page.words)
    page.segments = bh_ingest._merge_collinear(bh_ingest._segments_from_drawings(pg))
    return page
