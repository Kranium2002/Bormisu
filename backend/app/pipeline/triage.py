"""Triage (no model): page count, renders, thumbnails, text layer with word boxes, quality and hash.

Pure functions over local files; the orchestrator runs them in a thread and stores the results. Renders use
the page's own rotation, and word boxes are mapped into the same orientation, so every box the UI draws
lines up with the image it is drawn on.
"""

from __future__ import annotations

import io
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageSequence

RENDER_LONG_EDGE = 1600
SOFT_HYPHEN_MARK = "￾"  # PDFium: hyphen at a line end
THUMB_LONG_EDGE = 300
# Images larger than this are refused by Pillow as a decompression bomb guard.
Image.MAX_IMAGE_PIXELS = 250_000_000

Box = tuple[float, float, float, float]  # normalised x, y, w, h (top-left origin)


@dataclass
class Word:
    text: str
    box: Box


@dataclass
class TriagedPage:
    n: int
    width_px: int
    height_px: int
    png: bytes
    thumb: bytes
    phash: str
    text_layer_quality: float | None = None
    text: str = ""
    words: list[Word] = field(default_factory=list)


def _png(img: Image.Image) -> bytes:
    out = io.BytesIO()
    img.save(out, format="PNG", compress_level=3)  # optimize=True took seconds per scanned page
    return out.getvalue()


def _fit(img: Image.Image, long_edge: int) -> Image.Image:
    scale = long_edge / max(img.width, img.height)
    if abs(scale - 1) < 1e-3:
        return img
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    return img.resize(size, Image.Resampling.LANCZOS)


HASH_SIDE = 16
INK_THRESHOLD = 200  # grey levels below this count as ink when cropping to the content


def dhash(img: Image.Image) -> str:
    """256-bit difference hash (64 hex) of the inked area of a page.

    Cropping to the content and stretching the contrast make a rescaled, re-scanned or re-framed copy of a
    page hash within a few bits, while different pages that share a printed form stay far apart.
    """
    grey = img.convert("L")
    bbox = grey.point(lambda v: 255 if v < INK_THRESHOLD else 0).getbbox()
    if bbox is not None:
        grey = grey.crop(bbox)
    grey = ImageOps.autocontrast(grey)
    small = grey.resize((HASH_SIDE + 1, HASH_SIDE), Image.Resampling.LANCZOS)
    pixels = list(small.tobytes())  # mode L: one byte per pixel
    bits = 0
    for row in range(HASH_SIDE):
        for col in range(HASH_SIDE):
            left, right = pixels[row * (HASH_SIDE + 1) + col], pixels[row * (HASH_SIDE + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return f"{bits:0{HASH_SIDE * HASH_SIDE // 4}x}"


def hamming(a: str, b: str) -> int:
    return (int(a, 16) ^ int(b, 16)).bit_count()


def changed_share(a: Image.Image, b: Image.Image, *, long_edge: int, min_step: int) -> float:
    """Share of pixels that differ clearly between two renders of a page, compared whole at `long_edge`.

    A pixel counts when no pixel in its 3x3 neighbourhood in the other render comes within `min_step` grey
    levels, both ways. A copy of one scan (re-encoded, rescaled, re-rendered) changes almost no pixel; the
    same printed form filled in by another hand changes every pixel of the strokes that differ, which the
    256-bit hash, made for the layout, cannot see.
    """
    scale = long_edge / max(a.width, a.height)
    size = (max(1, round(a.width * scale)), max(1, round(a.height * scale)))
    left = a.convert("L").resize(size, Image.Resampling.BOX)
    right = b.convert("L").resize(size, Image.Resampling.BOX)

    def one_way(x: Image.Image, y: Image.Image) -> int:
        darker = ImageChops.subtract(y.filter(ImageFilter.MinFilter(3)), x)
        lighter = ImageChops.subtract(x, y.filter(ImageFilter.MaxFilter(3)))
        return sum(darker.histogram()[min_step:]) + sum(lighter.histogram()[min_step:])

    return max(one_way(left, right), one_way(right, left)) / (size[0] * size[1])


def text_quality(text: str) -> float | None:
    """Share of letters, digits and ordinary punctuation among the visible characters.

    Garbled embedded fonts map to private-use, replacement or control characters and score low. None when
    the page has no text layer.
    """
    visible = [ch for ch in text if not ch.isspace()]
    if not visible:
        return None
    good = 0
    for ch in visible:
        category = unicodedata.category(ch)
        if ch == "�" or category in ("Co", "Cn", "Cc", "Cs"):
            continue
        if category[0] in ("L", "N", "P", "S"):
            good += 1
    return round(good / len(visible), 3)


def _map_box(
    left: float, bottom: float, right: float, top: float, width: float, height: float, rotation: int
) -> Box:
    """PDF user space (bottom-left origin, unrotated) -> normalised box on the rendered (rotated) page."""
    x0, x1 = left / width, right / width
    y0, y1 = 1 - top / height, 1 - bottom / height  # top-left origin, unrotated
    if rotation == 90:
        x0, x1, y0, y1 = 1 - y1, 1 - y0, x0, x1
    elif rotation == 180:
        x0, x1, y0, y1 = 1 - x1, 1 - x0, 1 - y1, 1 - y0
    elif rotation == 270:
        x0, x1, y0, y1 = y0, y1, 1 - x1, 1 - x0
    x0, x1, y0, y1 = (min(max(v, 0.0), 1.0) for v in (x0, x1, y0, y1))
    return (round(x0, 5), round(y0, 5), round(max(x1 - x0, 0.0), 5), round(max(y1 - y0, 0.0), 5))


def _words(
    textpage: pdfium.PdfTextPage, width: float, height: float, rotation: int
) -> tuple[str, list[Word]]:
    count = textpage.count_chars()
    if count <= 0:
        return "", []
    text = textpage.get_text_range(0, count)
    words: list[Word] = []
    current: list[str] = []
    box: list[float] | None = None
    # get_text_range may differ in length from count (generated line breaks); walk by char index instead.
    for i in range(count):
        ch = textpage.get_text_range(i, 1)
        if not ch or ch.isspace():
            if current and box is not None:
                words.append(
                    Word("".join(current), _map_box(box[0], box[1], box[2], box[3], width, height, rotation))
                )
            current, box = [], None
            continue
        left, bottom, right, top = textpage.get_charbox(i)
        if ch == SOFT_HYPHEN_MARK:
            # PDFium marks a hyphen at a line end with U+FFFE and joins the next line's first word to it:
            # end the word here with a plain hyphen so each word box stays on its own line.
            if box is not None:
                box = [min(box[0], left), min(box[1], bottom), max(box[2], right), max(box[3], top)]
                current.append("-")
                words.append(
                    Word("".join(current), _map_box(box[0], box[1], box[2], box[3], width, height, rotation))
                )
            current, box = [], None
            continue
        if box is None:
            box = [left, bottom, right, top]
        else:
            box = [min(box[0], left), min(box[1], bottom), max(box[2], right), max(box[3], top)]
        current.append(ch)
    if current and box is not None:
        words.append(
            Word("".join(current), _map_box(box[0], box[1], box[2], box[3], width, height, rotation))
        )
    return text, words


def pdf_page_count(path: Path) -> int:
    pdf = pdfium.PdfDocument(str(path))
    try:
        return len(pdf)
    finally:
        pdf.close()


def triage_pdf(path: Path) -> Iterator[TriagedPage]:
    """Render every page once (no page cap) and read its text layer."""
    pdf = pdfium.PdfDocument(str(path))
    try:
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                width, height = page.get_size()
                rotation = page.get_rotation() % 360
                long_edge = max(width, height)
                bitmap = page.render(scale=RENDER_LONG_EDGE / long_edge, may_draw_forms=True)
                img = bitmap.to_pil().convert("RGB")
                textpage = page.get_textpage()
                try:
                    text, words = _words(textpage, width, height, rotation)
                finally:
                    textpage.close()
                yield TriagedPage(
                    n=index + 1,
                    width_px=img.width,
                    height_px=img.height,
                    png=_png(img),
                    thumb=_png(_fit(img, THUMB_LONG_EDGE)),
                    phash=dhash(img),
                    text_layer_quality=text_quality(text),
                    text=text,
                    words=words,
                )
            finally:
                page.close()
    finally:
        pdf.close()


def triage_image(path: Path) -> Iterator[TriagedPage]:
    """One page per image; every TIFF frame is a page. EXIF orientation is applied."""
    with Image.open(path) as source:
        for index, frame in enumerate(ImageSequence.Iterator(source)):
            img = ImageOps.exif_transpose(frame.copy()).convert("RGB")
            render = _fit(img, RENDER_LONG_EDGE) if max(img.width, img.height) > RENDER_LONG_EDGE else img
            yield TriagedPage(
                n=index + 1,
                width_px=render.width,
                height_px=render.height,
                png=_png(render),
                thumb=_png(_fit(render, THUMB_LONG_EDGE)),
                phash=dhash(render),
            )
