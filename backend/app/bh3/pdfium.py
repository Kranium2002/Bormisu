"""PDF access for bh3 through pypdfium2 (the backend never uses PyMuPDF).

Everything bh3 reads from a PDF page comes from here: the rendered image, the text-layer words, the ruling
lines of the drawing commands and the share of the page covered by embedded images. Coordinates follow
bh3's convention (models.py): PDF points on the page as displayed, origin top-left, y downward; /Rotate and
the CropBox are honoured.
"""
from __future__ import annotations

import ctypes
import threading
from dataclasses import dataclass
from typing import Optional

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from .models import Segment, Word

_lock = threading.RLock()          # PDFium is not thread-safe; bh3 renders tiles from a thread pool
_docs: dict[str, pdfium.PdfDocument] = {}

SOFT_HYPHEN = "￾"             # PDFium's mark for a hyphen that ends a line


def open_pdf(path: str) -> pdfium.PdfDocument:
    with _lock:
        doc = _docs.get(path)
        if doc is None:
            doc = pdfium.PdfDocument(path)
            _docs[path] = doc
        return doc


def close(path: str) -> None:
    """Close one cached document (the worker reads many files over its life; never keep handles open)."""
    with _lock:
        doc = _docs.pop(path, None)
        if doc is not None:
            try:
                doc.close()
            except Exception:  # noqa: BLE001
                pass


def close_all() -> None:
    with _lock:
        for doc in _docs.values():
            try:
                doc.close()
            except Exception:  # noqa: BLE001
                pass
        _docs.clear()


def page_count(path: str) -> int:
    with _lock:
        return len(open_pdf(path))


@dataclass(frozen=True)
class _Frame:
    """Maps PDF user space onto the displayed page (points, origin top-left)."""

    left: float
    bottom: float
    width: float           # unrotated crop box
    height: float
    rotation: int

    @property
    def size(self) -> tuple[float, float]:
        return (self.height, self.width) if self.rotation in (90, 270) else (self.width, self.height)

    def point(self, x: float, y: float) -> tuple[float, float]:
        ux, uy = x - self.left, self.height - (y - self.bottom)        # unrotated, top-left origin
        if self.rotation == 90:
            return self.height - uy, ux
        if self.rotation == 180:
            return self.width - ux, self.height - uy
        if self.rotation == 270:
            return uy, self.width - ux
        return ux, uy

    def box(self, left: float, bottom: float, right: float, top: float) -> tuple[float, float, float, float]:
        xa, ya = self.point(left, bottom)
        xb, yb = self.point(right, top)
        return min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb)


def _frame(page: pdfium.PdfPage) -> _Frame:
    left, bottom, right, top = page.get_cropbox()
    return _Frame(left, bottom, right - left, top - bottom, page.get_rotation() % 360)


def page_size(path: str, index: int) -> tuple[float, float]:
    with _lock:
        page = open_pdf(path)[index]
        try:
            return _frame(page).size
        finally:
            page.close()


def render(path: str, index: int, scale: float):
    """PIL RGB image of the displayed page at `scale` (1.0 = 72 dpi)."""
    with _lock:
        page = open_pdf(path)[index]
        try:
            bitmap = page.render(scale=scale, may_draw_forms=True)
            return bitmap.to_pil().convert("RGB")
        finally:
            page.close()


def text(path: str, index: int) -> str:
    """The page's text in PDFium's reading order (labels next to their values)."""
    with _lock:
        page = open_pdf(path)[index]
        try:
            tp = page.get_textpage()
            try:
                return tp.get_text_bounded()
            finally:
                tp.close()
        finally:
            page.close()


def _words(tp: pdfium.PdfTextPage, frame: _Frame) -> list[Word]:
    out: list[Word] = []
    chars: list[str] = []
    box: Optional[list[float]] = None

    def flush() -> None:
        if chars and box is not None:
            x0, y0, x1, y1 = frame.box(*box)
            word = "".join(chars).strip()
            if word:
                out.append(Word(word, x0, y0, x1, y1, 1.0, "text"))

    for i in range(tp.count_chars()):
        ch = tp.get_text_range(i, 1)
        if not ch or ch.isspace():
            flush()
            chars, box = [], None
            continue
        left, bottom, right, top = tp.get_charbox(i)
        if ch == SOFT_HYPHEN:
            if box is not None:
                chars.append("-")
                box = [min(box[0], left), min(box[1], bottom), max(box[2], right), max(box[3], top)]
            flush()
            chars, box = [], None
            continue
        box = [left, bottom, right, top] if box is None else [min(box[0], left), min(box[1], bottom),
                                                              max(box[2], right), max(box[3], top)]
        chars.append(ch)
    flush()
    return out


def _color(fn, raw) -> Optional[tuple[float, float, float, float]]:
    r, g, b, a = ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint()
    if not fn(raw, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a)):
        return None
    return r.value / 255, g.value / 255, b.value / 255, a.value / 255


def _matrix(raw) -> tuple[float, float, float, float, float, float]:
    m = pdfium_c.FS_MATRIX()
    if not pdfium_c.FPDFPageObj_GetMatrix(raw, ctypes.byref(m)):
        return 1.0, 0.0, 0.0, 1.0, 0.0, 0.0
    return m.a, m.b, m.c, m.d, m.e, m.f


def _apply(m: tuple[float, ...], x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return a * x + c * y + e, b * x + d * y + f


def _compose(inner: tuple[float, ...], outer: tuple[float, ...]) -> tuple[float, ...]:
    a1, b1, c1, d1, e1, f1 = inner
    a2, b2, c2, d2, e2, f2 = outer
    return (a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
            e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2)


def _path_segments(raw, matrix: tuple[float, ...], frame: _Frame) -> list[Segment]:
    """Straight pieces of one visible path object, in displayed page points."""
    fill_mode, stroke = ctypes.c_int(), ctypes.c_int()
    if not pdfium_c.FPDFPath_GetDrawMode(raw, ctypes.byref(fill_mode), ctypes.byref(stroke)):
        return []
    colour = _color(pdfium_c.FPDFPageObj_GetStrokeColor, raw) if stroke.value else None
    if colour is None and fill_mode.value:
        colour = _color(pdfium_c.FPDFPageObj_GetFillColor, raw)
    if colour is None or colour[3] == 0 or sum(colour[:3]) / 3 > 0.75:
        return []                                       # invisible, or white / very light strokes
    points: list[tuple[float, float]] = []
    start: Optional[tuple[float, float]] = None
    segs: list[Segment] = []
    n = pdfium_c.FPDFPath_CountSegments(raw)
    x, y = ctypes.c_float(), ctypes.c_float()
    for i in range(max(0, n)):
        seg = pdfium_c.FPDFPath_GetPathSegment(raw, i)
        if not seg or not pdfium_c.FPDFPathSegment_GetPoint(seg, ctypes.byref(x), ctypes.byref(y)):
            continue
        p = frame.point(*_apply(matrix, x.value, y.value))
        kind = pdfium_c.FPDFPathSegment_GetType(seg)
        if kind == pdfium_c.FPDF_SEGMENT_MOVETO:
            points, start = [p], p
        elif kind == pdfium_c.FPDF_SEGMENT_LINETO:
            if points:
                segs.append(Segment(points[-1][0], points[-1][1], p[0], p[1]))
            points.append(p)
        else:                                           # bezier control points: curves are never ruling lines
            points = [p]
        if pdfium_c.FPDFPathSegment_GetClose(seg) and start is not None and points:
            segs.append(Segment(points[-1][0], points[-1][1], start[0], start[1]))
    out: list[Segment] = []
    for s in segs:
        w, h = abs(s.x1 - s.x0), abs(s.y1 - s.y0)
        if h < 2.5 and w > 8:
            ym = (s.y0 + s.y1) / 2
            out.append(Segment(min(s.x0, s.x1), ym, max(s.x0, s.x1), ym))
        elif w < 2.5 and h > 8:
            xm = (s.x0 + s.x1) / 2
            out.append(Segment(xm, min(s.y0, s.y1), xm, max(s.y0, s.y1)))
    # a thin filled rectangle is a line: collapse it to its centre line
    if fill_mode.value and not stroke.value and len(out) >= 2:
        xs = [v for s in segs for v in (s.x0, s.x1)]
        ys = [v for s in segs for v in (s.y0, s.y1)]
        bw, bh = max(xs) - min(xs), max(ys) - min(ys)
        if bh < 2.5 and bw > 8:
            return [Segment(min(xs), (min(ys) + max(ys)) / 2, max(xs), (min(ys) + max(ys)) / 2)]
        if bw < 2.5 and bh > 8:
            return [Segment((min(xs) + max(xs)) / 2, min(ys), (min(xs) + max(xs)) / 2, max(ys))]
    return out


def _bounds(obj) -> tuple[float, float, float, float]:
    get = getattr(obj, "get_bounds", None) or obj.get_pos          # pypdfium2 5.x renamed get_pos
    return get()


def _walk(objects, matrix: tuple[float, ...], frame: _Frame, segs: list[Segment], images: list[tuple], depth: int):
    for obj in objects:
        try:
            kind = obj.type
            own = _compose(_matrix(obj.raw), matrix) if depth else _matrix(obj.raw)
            if kind == pdfium_c.FPDF_PAGEOBJ_PATH:
                segs += _path_segments(obj.raw, own, frame)
            elif kind == pdfium_c.FPDF_PAGEOBJ_IMAGE:
                left, bottom, right, top = _bounds(obj)
                images.append(frame.box(left, bottom, right, top))
            elif kind == pdfium_c.FPDF_PAGEOBJ_FORM and depth < 3:
                count = pdfium_c.FPDFFormObj_CountObjects(obj.raw)
                children = [pdfium.PdfObject(pdfium_c.FPDFFormObj_GetObject(obj.raw, j), page=obj.page, pdf=obj.pdf,
                                             level=obj.level + 1) for j in range(max(0, count))]
                _walk(children, own, frame, segs, images, depth + 1)
        except Exception:  # noqa: BLE001  # one malformed object must not cost the page its other lines
            continue


@dataclass
class PageContent:
    width: float
    height: float
    words: list[Word]
    segments: list[Segment]
    image_area_ratio: float


def page_content(path: str, index: int) -> PageContent:
    """Text-layer words, ruling-line segments and image coverage of one PDF page."""
    with _lock:
        page = open_pdf(path)[index]
        try:
            frame = _frame(page)
            width, height = frame.size
            tp = page.get_textpage()
            try:
                words = _words(tp, frame)
            finally:
                tp.close()
            segs: list[Segment] = []
            images: list[tuple] = []
            try:
                top_level = list(page.get_objects(max_depth=0))
            except Exception:  # noqa: BLE001  # a malformed content stream must not stop the text route
                top_level = []
            _walk(top_level, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), frame, segs, images, 0)
            area = 0.0
            for x0, y0, x1, y1 in images:
                ix = max(0.0, min(x1, width) - max(x0, 0.0))
                iy = max(0.0, min(y1, height) - max(y0, 0.0))
                area += ix * iy
            ratio = min(1.0, area / max(1.0, width * height))
            return PageContent(width, height, words, segs, ratio)
        finally:
            page.close()
