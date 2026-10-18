"""Text layer of vector PDF pages: clean-up of the words and ruling lines that bh3.pdfium reads.

No OCR anywhere in bh3: a page without a usable text layer goes to the vision path.
"""
from __future__ import annotations

from ..models import Segment, Word

MIN_TEXT_CHARS = 40       # below this a page is treated as having no usable text layer


def dedupe_words(words: list[Word], iou: float = 0.75) -> list[Word]:
    """Remove stroked/overprinted duplicates (same text drawn 2-4x at nearly the same spot).

    Some PDFs draw every glyph four times over. Sort so the result is deterministic.
    """
    words = sorted(words, key=lambda w: (round(w.y0, 1), round(w.x0, 1), w.text))
    out: list[Word] = []
    for w in words:
        dup = False
        # only need to look back a little; candidates are spatially adjacent after sorting
        for prev in out[-12:]:
            if prev.text == w.text and prev.overlaps(w) >= iou:
                dup = True
                break
        if not dup:
            out.append(w)
    return out


def _text_layer_usable(words: list[Word]) -> bool:
    txt = "".join(w.text for w in words)
    if len(txt) < MIN_TEXT_CHARS:
        return False
    # garbage OCR layers (embedded by some scanners) have a low ratio of alnum chars; keep them but
    # mark unusable so we re-OCR ourselves when the ratio is bad.
    alnum = sum(c.isalnum() for c in txt)
    return alnum / max(1, len(txt)) > 0.6



def _merge_collinear(segs: list[Segment], tol: float = 2.0, gap: float = 6.0) -> list[Segment]:
    out: list[Segment] = []
    for horizontal in (True, False):
        group = [s for s in segs if (s.horizontal if horizontal else s.vertical)]
        if horizontal:
            group.sort(key=lambda s: (round(s.y0 / tol), min(s.x0, s.x1)))
        else:
            group.sort(key=lambda s: (round(s.x0 / tol), min(s.y0, s.y1)))
        for s in group:
            a0, a1 = (min(s.x0, s.x1), max(s.x0, s.x1)) if horizontal else (min(s.y0, s.y1), max(s.y0, s.y1))
            pos = s.y0 if horizontal else s.x0
            if out:
                p = out[-1]
                same = (p.horizontal if horizontal else p.vertical)
                ppos = p.y0 if horizontal else p.x0
                b0, b1 = (min(p.x0, p.x1), max(p.x0, p.x1)) if horizontal else (min(p.y0, p.y1), max(p.y0, p.y1))
                if same and abs(ppos - pos) <= tol and a0 <= b1 + gap:
                    lo, hi = min(a0, b0), max(a1, b1)
                    out[-1] = Segment(lo, ppos, hi, ppos) if horizontal else Segment(ppos, lo, ppos, hi)
                    continue
            out.append(Segment(a0, pos, a1, pos) if horizontal else Segment(pos, a0, pos, a1))
    return out
