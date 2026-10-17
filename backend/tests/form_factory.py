"""FICTIONAL scanned field forms for duplicate tests: one printed form, filled in by different hands.

The printed part (frame, ruled rows, columns, header boxes) is the same for every seed; the "handwriting" is a
few short pen strokes in random rows, so two seeds give the same layout with other entries, as two sheets of
one form pad would.
"""

from __future__ import annotations

import io
import random

from PIL import Image, ImageDraw

FORM_SIZE = (1131, 1600)


def filled_form(seed: int) -> Image.Image:
    img = Image.new("L", FORM_SIZE, 255)
    draw = ImageDraw.Draw(img)
    draw.rectangle((60, 60, 1071, 1540), outline=0, width=3)
    for y in range(260, 1540, 64):
        draw.line((60, y, 1071, y), fill=0, width=2)
    for x in (200, 420, 760, 900):
        draw.line((x, 200, x, 1540), fill=0, width=2)
    for i in range(6):  # printed header words
        draw.rectangle((90 + i * 160, 100, 200 + i * 160, 130), fill=40)
    rng = random.Random(seed)
    for row in range(260, 1480, 64):
        if rng.random() < 0.6:
            continue
        x, y = 440 + rng.randint(0, 200), row + 30
        draw.line([(x + k * 8, y + rng.randint(-10, 10)) for k in range(4)], fill=30, width=3)
    return img.convert("RGB")


def encoded(img: Image.Image, fmt: str, **options: object) -> bytes:
    out = io.BytesIO()
    img.save(out, format=fmt, **options)
    return out.getvalue()
