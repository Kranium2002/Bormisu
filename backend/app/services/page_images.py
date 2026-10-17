"""Page images at the widths the review screens ask for (GET /documents/{id}/pages/{n}.png?w=...).

Resizing a full-resolution render takes seconds, so the widths the web app uses are made once when the page
is triaged; any other width is made on first request and cached the same way.
"""

from __future__ import annotations

import io

from PIL import Image

from app.storage import FileStorage, page_resized_key

DEFAULT_PAGE_WIDTH = 1400
MIN_PAGE_WIDTH, MAX_PAGE_WIDTH = 200, 2400
# The widths the web app requests: the page viewers and the thumbnail strips.
PREWARM_WIDTHS = (DEFAULT_PAGE_WIDTH, MIN_PAGE_WIDTH)


def resize_png(source: bytes, width: int) -> bytes:
    """The PNG scaled to `width` pixels wide (unchanged when it is not wider)."""
    with Image.open(io.BytesIO(source)) as img:
        if img.width <= width:
            return source
        height = max(1, round(img.height * width / img.width))
        resized = img.resize((width, height), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        resized.save(out, format="PNG", optimize=True)
        return out.getvalue()


def prewarm_page(storage: FileStorage, document_id: str, n: int, render: bytes) -> None:
    """Store the PREWARM_WIDTHS versions of one page render."""
    for width in PREWARM_WIDTHS:
        key = page_resized_key(document_id, n, width)
        if not storage.exists(key):
            storage.put_bytes(key, resize_png(render, width))
