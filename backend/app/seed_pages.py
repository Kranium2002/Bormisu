"""Page drawing helpers for the fictional demo seed (`python -m app.seed`). FICTIONAL DEMO DATA ONLY.

Pages are drawn with Pillow at 1600 px on the long edge (A4 ratio) with the built-in font, so rendering
needs no system fonts and is deterministic (no clock, no unseeded randomness): the same input gives the
same pixels and the same PDF bytes. Every page carries a visible "FICTIONAL DEMO DATA" mark.

Each drawn value a seed record points at is registered as an anchor: its normalised `[x, y, w, h]` box
(0-1, top-left origin) and the exact text drawn, so provenance boxes highlight exactly that text.
The built-in font covers ASCII only, so the fictional documents spell umlauts and accents out (ae, oe).
"""

from __future__ import annotations

import io
import random
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

LONG_EDGE = 1600
SHORT_EDGE = round(LONG_EDGE / 2**0.5)  # 1131: A4 ratio
THUMB_EDGE = 300
PDF_RESOLUTION = 137.0  # 1131 x 1600 px is roughly A4 at this resolution
PDF_DATE = time.strptime("2026-01-15 09:00:00", "%Y-%m-%d %H:%M:%S")

PAPER = (251, 250, 245)
INK = (24, 24, 30)
GREY = (105, 105, 115)
RULE = (70, 70, 80)
SHADE = (232, 232, 226)
HAND = (30, 55, 155)
MARK = (176, 28, 36)
WATERMARK = (240, 226, 222)

DEMO_MARK = "FICTIONAL DEMO DATA"
BAND_TEXT = f"{DEMO_MARK} - invented for Bormisu development - not a real report"

Box = list[float]
Rect = tuple[int, int, int, int]


@lru_cache(maxsize=64)
def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


@dataclass(frozen=True)
class Hand:
    """A handwritten value: drawn slanted and jittered in blue ink."""

    text: str
    seed: int = 0


@dataclass(frozen=True)
class Correction:
    """A printed value struck through with a handwritten correction next to it."""

    struck: str
    hand: Hand


@dataclass(frozen=True)
class Smudge:
    """A handwritten value that cannot be read (scribble with an ink blot)."""

    text: str
    seed: int = 0


Cell = str | Hand | Correction | Smudge | None


@dataclass(frozen=True)
class Column:
    key: str
    title: str
    width: int


@dataclass(frozen=True)
class Anchor:
    box: Box
    text: str
    hand: bool = False


class Sheet:
    """One page being drawn; collects anchors (key -> normalised box and drawn text)."""

    MARGIN = 56

    def __init__(self, *, landscape: bool = False, footer: str = "") -> None:
        self.width, self.height = (LONG_EDGE, SHORT_EDGE) if landscape else (SHORT_EDGE, LONG_EDGE)
        self.image = Image.new("RGB", (self.width, self.height), PAPER)
        self.draw = ImageDraw.Draw(self.image)
        self.anchors: dict[str, Anchor] = {}
        self.top = 78
        self.bottom = self.height - 64
        self._watermark()
        self._bands(footer)

    # -- marks ------------------------------------------------------------------------------------

    def _watermark(self) -> None:
        size = 120 if self.height > self.width else 110
        f = font(size)
        length = int(f.getlength(DEMO_MARK)) + 40
        tile = Image.new("L", (length, size + 60), 0)
        ImageDraw.Draw(tile).text((20, 20), DEMO_MARK, font=f, fill=255)
        rotated = tile.rotate(33, resample=Image.Resampling.BICUBIC, expand=True)
        x = (self.width - rotated.width) // 2
        y = (self.height - rotated.height) // 2
        self.image.paste(Image.new("RGB", rotated.size, WATERMARK), (x, y), rotated)

    def _bands(self, footer: str) -> None:
        self.draw.rectangle((0, 0, self.width, 44), fill=MARK)
        self.draw.text((self.MARGIN, 11), BAND_TEXT, font=font(20), fill=(255, 255, 255))
        y = self.height - 40
        self.draw.line((self.MARGIN, y - 8, self.width - self.MARGIN, y - 8), fill=MARK, width=2)
        self.draw.text(
            (self.MARGIN, y), DEMO_MARK, font=font(18), fill=MARK, stroke_width=1, stroke_fill=MARK
        )
        if footer:
            f = font(16)
            self.draw.text((self.width - self.MARGIN - f.getlength(footer), y + 2), footer, font=f, fill=GREY)

    # -- geometry ---------------------------------------------------------------------------------

    def norm(self, rect: Rect, pad: int = 3) -> Box:
        x0, y0, x1, y1 = rect
        x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
        x1, y1 = min(self.width, x1 + pad), min(self.height, y1 + pad)
        nx0, ny0 = round(x0 / self.width, 4), round(y0 / self.height, 4)
        nx1, ny1 = round(x1 / self.width, 4), round(y1 / self.height, 4)
        return [nx0, ny0, round(nx1 - nx0, 4), round(ny1 - ny0, 4)]

    def anchor(self, key: str | None, rect: Rect, text: str, *, hand: bool = False) -> None:
        if key:
            self.anchors[key] = Anchor(self.norm(rect), text, hand)

    # -- text -------------------------------------------------------------------------------------

    def text(
        self,
        x: float,
        y: float,
        s: str,
        *,
        size: int = 20,
        key: str | None = None,
        fill: tuple[int, int, int] = INK,
        bold: bool = False,
    ) -> Rect:
        f = font(size)
        stroke = 1 if bold else 0
        self.draw.text((x, y), s, font=f, fill=fill, stroke_width=stroke, stroke_fill=fill)
        left, top, right, bottom = self.draw.textbbox((x, y), s, font=f, stroke_width=stroke)
        rect = (int(left), int(top), int(right), int(bottom))
        self.anchor(key, rect, s)
        return rect

    def hand(
        self, x: float, y: float, value: Hand | Smudge, *, size: int = 30, key: str | None = None
    ) -> Rect:
        """Draw handwriting: per-letter jitter, a slant and a slight rotation, in blue ink."""
        f = font(size)
        rng = random.Random(f"{value.text}|{value.seed}")  # noqa: S311 (seeded jitter for drawing, not security)
        widths = [f.getlength(ch) for ch in value.text]
        tile_w, tile_h = int(sum(widths) * 1.15 + size + 12), int(size * 2)
        tile = Image.new("L", (tile_w, tile_h), 0)
        tdraw = ImageDraw.Draw(tile)
        cx = 6.0
        for ch, width in zip(value.text, widths, strict=True):
            dy = rng.uniform(-0.09, 0.09) * size
            tdraw.text((cx, size * 0.4 + dy), ch, font=f, fill=255, stroke_width=1)
            cx += width * rng.uniform(1.0, 1.12)
        if isinstance(value, Smudge):
            for _ in range(3):
                x0 = rng.uniform(0, tile_w * 0.6)
                tdraw.line((x0, tile_h * 0.75, x0 + tile_w * 0.4, tile_h * 0.3), fill=255, width=3)
            cx0 = tile_w * rng.uniform(0.3, 0.6)
            tdraw.ellipse((cx0 - 12, tile_h * 0.35, cx0 + 14, tile_h * 0.75), fill=200)
        shear = 0.3
        sheared = tile.transform(
            (tile_w + int(tile_h * shear), tile_h),
            Image.Transform.AFFINE,
            (1, shear, -tile_h * shear, 0, 1, 0),
            resample=Image.Resampling.BICUBIC,
        )
        mask = sheared.rotate(rng.uniform(-3.0, 3.0), resample=Image.Resampling.BICUBIC, expand=True)
        ix, iy = int(x), int(y - size * 0.4)
        self.image.paste(Image.new("RGB", mask.size, HAND), (ix, iy), mask)
        inner = mask.getbbox() or (0, 0, mask.width, mask.height)
        rect = (ix + inner[0], iy + inner[1], ix + inner[2], iy + inner[3])
        self.anchor(key, rect, value.text, hand=True)
        return rect

    def cell(
        self, x: float, y: float, value: Cell, *, size: int = 18, width: int = 400, key: str | None = None
    ) -> int:
        """Draw one value (wrapped when printed); returns the height used."""
        if value is None:
            return 0
        if isinstance(value, Hand | Smudge):
            rect = self.hand(x, y - 2, value, size=size + 8, key=key)
            return rect[3] - int(y) + 4
        if isinstance(value, Correction):
            struck = self.text(x, y, value.struck, size=size, key=f"{key}.struck" if key else None)
            mid = (struck[1] + struck[3]) // 2
            self.draw.line((struck[0] - 3, mid, struck[2] + 3, mid), fill=HAND, width=3)
            rect = self.hand(x + 4, struck[3] + 8, value.hand, size=size + 8, key=key)
            return rect[3] - int(y) + 4
        lines = self.wrap(value, width, size)
        rects = [self.text(x, y + i * (size + 7), line, size=size) for i, line in enumerate(lines)]
        union = (min(r[0] for r in rects), rects[0][1], max(r[2] for r in rects), rects[-1][3])
        self.anchor(key, union, value)
        return union[3] - int(y)

    @staticmethod
    def wrap(text: str, width: int, size: int) -> list[str]:
        f = font(size)
        lines: list[str] = []
        current = ""
        for word in text.split():
            trial = f"{current} {word}".strip()
            if not current or f.getlength(trial) <= width:
                current = trial
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)
        return lines or [""]

    def paragraph(
        self, x: float, y: float, text: str, *, width: int, size: int = 19, key: str | None = None
    ) -> int:
        """Wrapped text; returns the y below it."""
        height = self.cell(x, y, text, size=size, width=width, key=key)
        return int(y) + height + size

    # -- blocks -----------------------------------------------------------------------------------

    def title(self, company: str, title: str, *, right: str | None = None) -> int:
        """Company line, document title and an optional right-aligned label (e.g. the sheet label)."""
        y = self.top
        self.text(self.MARGIN, y, company, size=18, fill=GREY)
        self.text(self.MARGIN, y + 28, title, size=32, bold=True)
        if right:
            f = font(22)
            self.text(
                self.width - self.MARGIN - f.getlength(right) - 4,
                y + 36,
                right,
                size=22,
                key="sheet",
                bold=True,
            )
        y += 84
        self.draw.line((self.MARGIN, y, self.width - self.MARGIN, y), fill=RULE, width=3)
        return y + 16

    def fields(self, y: int, items: Sequence[tuple[str, str, Cell]], *, cols: int = 2, size: int = 20) -> int:
        """Header grid: small grey labels above values; anchors keyed by the item key."""
        usable = self.width - 2 * self.MARGIN
        col_w = usable // cols
        row_y = y
        for start in range(0, len(items), cols):
            heights = []
            for i, (label, key, value) in enumerate(items[start : start + cols]):
                x = self.MARGIN + i * col_w
                self.text(x + 8, row_y + 6, label, size=15, fill=GREY)
                used = self.cell(
                    x + 8,
                    row_y + 30,
                    value if value is not None else "-",
                    size=size,
                    width=col_w - 24,
                    key=key,
                )
                heights.append(used)
            row_h = max(64, max(heights) + 42)
            self.draw.rectangle(
                (self.MARGIN, row_y, self.width - self.MARGIN, row_y + row_h), outline=RULE, width=1
            )
            for i in range(1, cols):
                x = self.MARGIN + i * col_w
                self.draw.line((x, row_y, x, row_y + row_h), fill=RULE, width=1)
            row_y += row_h
        return row_y + 18

    def table(
        self,
        y: int,
        columns: Sequence[Column],
        rows: Sequence[tuple[str, dict[str, Cell]]],
        *,
        size: int = 18,
        x: int | None = None,
    ) -> int:
        """A ruled table; each non-empty cell is anchored as `<row key>.<column key>`."""
        x0 = self.MARGIN if x is None else x
        total = sum(c.width for c in columns)
        header_lines = max(len(c.title.split("\n")) for c in columns)
        header_h = header_lines * 20 + 16
        self.draw.rectangle((x0, y, x0 + total, y + header_h), fill=SHADE, outline=RULE, width=2)
        cx = x0
        for col in columns:
            for j, line in enumerate(col.title.split("\n")):
                self.text(cx + 8, y + 8 + j * 20, line, size=15, bold=True)
            cx += col.width
        top = y
        y += header_h
        for row_key, cells in rows:
            heights = []
            cx = x0
            for col in columns:
                value = cells.get(col.key)
                key = f"{row_key}.{col.key}" if value is not None else None
                heights.append(self.cell(cx + 8, y + 10, value, size=size, width=col.width - 16, key=key))
                cx += col.width
            row_h = max(44, max(heights) + 22)
            y += row_h
            self.draw.line((x0, y, x0 + total, y), fill=RULE, width=1)
        cx = x0
        for col in columns:
            self.draw.line((cx, top, cx, y), fill=RULE, width=1)
            cx += col.width
        self.draw.rectangle((x0, top, x0 + total, y), outline=RULE, width=2)
        return y + 20

    def notes(self, y: int, items: Sequence[tuple[str, str | None, Cell]], *, size: int = 19) -> int:
        """Lines of 'label value'; the value is anchored by its key."""
        for label, key, value in items:
            rect = self.text(self.MARGIN, y, label, size=size, fill=GREY if value is not None else INK)
            used = 0
            if value is not None:
                width = self.width - self.MARGIN - rect[2] - 30
                used = self.cell(rect[2] + 12, y, value, size=size, width=width, key=key)
            y += max(size + 14, used + 10)
        return y + 8

    def stamp(self, text: str, x: int, y: int, *, size: int = 40) -> None:
        f = font(size)
        width = int(f.getlength(text)) + 30
        tile = Image.new("L", (width, size + 30), 0)
        tdraw = ImageDraw.Draw(tile)
        tdraw.rectangle((2, 2, width - 3, size + 27), outline=255, width=4)
        tdraw.text((15, 12), text, font=f, fill=255)
        rotated = tile.rotate(-8, resample=Image.Resampling.BICUBIC, expand=True)
        self.image.paste(Image.new("RGB", rotated.size, MARK), (x, y), rotated)


# -- whole pages --------------------------------------------------------------------------------------


@dataclass
class TablePage:
    """A log sheet, continuation sheet or summary/coordinate/lab table: title, header grid, table, notes."""

    company: str
    title: str
    sheet_label: str | None = None
    header: list[tuple[str, str, Cell]] = field(default_factory=list)
    intro: str | None = None
    columns: list[Column] = field(default_factory=list)
    rows: list[tuple[str, dict[str, Cell]]] = field(default_factory=list)
    notes: list[tuple[str, str | None, Cell]] = field(default_factory=list)
    margin_note: Hand | None = None
    stamp: str | None = None
    footer: str = ""


@dataclass
class MultiLogPage:
    """Several short logs on one sheet (one group per label sharing the page)."""

    company: str
    title: str
    blocks: list[tuple[list[tuple[str, str, Cell]], list[Column], list[tuple[str, dict[str, Cell]]]]]
    footer: str = ""


@dataclass
class TextPage:
    company: str
    title: str
    paragraphs: list[str]
    subtitle_lines: list[str] = field(default_factory=list)
    footer: str = ""


@dataclass
class PlanPage:
    """Landscape location plan: grid, a creek line, borehole markers, north arrow and scale bar."""

    company: str
    title: str
    points: list[tuple[str, float, float]]  # label, x, y in 0-1 of the drawing frame
    footer: str = ""


@dataclass
class PhotoPage:
    """A drawn stand-in for a core-box photograph."""

    company: str
    title: str
    caption: str
    seed: int
    footer: str = ""


@dataclass
class BlankPage:
    footer: str = ""


PageSpec = TablePage | MultiLogPage | TextPage | PlanPage | PhotoPage | BlankPage


def draw_page(spec: PageSpec) -> Sheet:
    if isinstance(spec, TablePage):
        return _draw_table_page(spec)
    if isinstance(spec, MultiLogPage):
        return _draw_multi(spec)
    if isinstance(spec, TextPage):
        return _draw_text(spec)
    if isinstance(spec, PlanPage):
        return _draw_plan(spec)
    if isinstance(spec, PhotoPage):
        return _draw_photo(spec)
    return Sheet(footer=spec.footer)


def _draw_table_page(spec: TablePage) -> Sheet:
    sheet = Sheet(footer=spec.footer)
    y = sheet.title(spec.company, spec.title, right=spec.sheet_label)
    if spec.header:
        y = sheet.fields(y, spec.header)
    if spec.intro:
        y = sheet.paragraph(sheet.MARGIN, y, spec.intro, width=sheet.width - 2 * sheet.MARGIN, size=18)
    if spec.columns:
        y = sheet.table(y, spec.columns, spec.rows)
    if spec.notes:
        sheet.notes(y + 6, spec.notes)
    if spec.margin_note is not None:
        sheet.hand(sheet.width - 330, sheet.bottom - 120, spec.margin_note, size=30)
    if spec.stamp:
        sheet.stamp(spec.stamp, sheet.width - 330, sheet.top + 120)
    return sheet


def _draw_multi(spec: MultiLogPage) -> Sheet:
    sheet = Sheet(footer=spec.footer)
    y = sheet.title(spec.company, spec.title)
    for header, columns, rows in spec.blocks:
        y = sheet.fields(y, header)
        y = sheet.table(y, columns, rows) + 24
    return sheet


def _draw_text(spec: TextPage) -> Sheet:
    sheet = Sheet(footer=spec.footer)
    y = sheet.title(spec.company, spec.title)
    for line in spec.subtitle_lines:
        sheet.text(sheet.MARGIN, y, line, size=22)
        y += 38
    y += 12
    for para in spec.paragraphs:
        y = sheet.paragraph(sheet.MARGIN, y, para, width=sheet.width - 2 * sheet.MARGIN)
    return sheet


def _draw_plan(spec: PlanPage) -> Sheet:
    sheet = Sheet(landscape=True, footer=spec.footer)
    y = sheet.title(spec.company, spec.title)
    d = sheet.draw
    frame = (sheet.MARGIN, y, sheet.width - sheet.MARGIN, sheet.bottom - 30)
    d.rectangle(frame, outline=RULE, width=2)
    fx0, fy0, fx1, fy1 = frame
    for gx in range(fx0 + 100, fx1, 100):
        d.line((gx, fy0, gx, fy1), fill=SHADE, width=1)
    for gy in range(fy0 + 100, fy1, 100):
        d.line((fx0, gy, fx1, gy), fill=SHADE, width=1)
    rng = random.Random(spec.title)  # noqa: S311 (seeded jitter for drawing, not security)
    creek = []
    for i in range(13):
        px = fx0 + (fx1 - fx0) * i / 12
        py = fy0 + (fy1 - fy0) * (0.55 + 0.12 * ((-1) ** i) * rng.uniform(0.2, 1.0))
        creek.append((px, py))
    d.line(creek, fill=(70, 120, 190), width=6)
    d.rectangle((fx0 + 140, fy0 + 60, fx0 + 520, fy0 + 220), outline=GREY, width=3)
    for label, px, py in spec.points:
        cx, cy = fx0 + (fx1 - fx0) * px, fy0 + (fy1 - fy0) * py
        d.ellipse((cx - 11, cy - 11, cx + 11, cy + 11), outline=INK, width=3)
        d.line((cx - 16, cy, cx + 16, cy), fill=INK, width=2)
        d.line((cx, cy - 16, cx, cy + 16), fill=INK, width=2)
        sheet.text(cx + 18, cy - 30, label, size=22, key=f"pt.{label}", bold=True)
    ax, ay = fx1 - 90, fy0 + 40
    d.polygon([(ax, ay), (ax - 20, ay + 60), (ax + 20, ay + 60)], fill=INK)
    sheet.text(ax - 8, ay + 66, "N", size=26, bold=True)
    sx, sy = fx0 + 40, fy1 - 50
    d.rectangle((sx, sy, sx + 200, sy + 10), outline=INK, width=2)
    d.rectangle((sx, sy, sx + 100, sy + 10), fill=INK)
    sheet.text(sx, sy + 16, "0          50         100 m", size=16)
    return sheet


def _draw_photo(spec: PhotoPage) -> Sheet:
    sheet = Sheet(footer=spec.footer)
    y = sheet.title(spec.company, spec.title)
    rng = random.Random(spec.seed)  # noqa: S311 (seeded jitter for drawing, not security)
    x0, x1 = sheet.MARGIN + 20, sheet.width - sheet.MARGIN - 20
    y1 = y + 980
    d = sheet.draw
    d.rectangle((x0 - 14, y - 14 + 20, x1 + 14, y1 + 14), fill=(92, 64, 40))
    rows = 5
    row_h = (y1 - y - 20) // rows
    for r in range(rows):
        ry = y + 20 + r * row_h
        d.rectangle((x0, ry + 8, x1, ry + row_h - 8), fill=(60, 42, 26))
        cx = x0 + 6
        base = rng.choice([(150, 85, 60), (170, 120, 90), (120, 110, 100), (180, 160, 130)])
        while cx < x1 - 20:
            length = rng.randint(25, 160)
            shade = tuple(max(0, min(255, c + rng.randint(-25, 25))) for c in base)
            d.rounded_rectangle(
                (cx, ry + 22, min(cx + length, x1 - 6), ry + row_h - 22), radius=18, fill=shade
            )
            cx += length + rng.randint(2, 9)
        sheet.text(x0 + 10, ry + 10, f"{r + 1}", size=16, fill=(240, 240, 240))
    sheet.paragraph(sheet.MARGIN, y1 + 40, spec.caption, width=sheet.width - 2 * sheet.MARGIN)
    return sheet


# -- files ----------------------------------------------------------------------------------------------


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=False, compress_level=6)
    return buffer.getvalue()


def thumbnail_png(image: Image.Image) -> bytes:
    thumb = image.copy()
    thumb.thumbnail((THUMB_EDGE, THUMB_EDGE), Image.Resampling.LANCZOS)
    return png_bytes(thumb)


def pdf_bytes(images: Sequence[Image.Image], title: str) -> bytes:
    """A multi-page PDF of the page images with fixed metadata, so the bytes (and sha256) are stable."""
    buffer = io.BytesIO()
    first, *rest = images
    first.save(
        buffer,
        "PDF",
        save_all=True,
        append_images=rest,
        resolution=PDF_RESOLUTION,
        title=title,
        author=DEMO_MARK,
        subject=DEMO_MARK,
        creator="Bormisu demo seed",
        producer="Bormisu demo seed",
        creationDate=PDF_DATE,
        modDate=PDF_DATE,
    )
    return buffer.getvalue()
