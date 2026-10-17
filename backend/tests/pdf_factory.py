"""FICTIONAL test documents made at test time (never committed): small vector PDFs with a text layer.

`make_pdf([[TextItem(...), ...], ...])` writes one page per list with Helvetica text at known positions, so
tests know exactly where each value sits. Coordinates are PDF points from the bottom-left of an A4 page.
"""

from __future__ import annotations

from dataclasses import dataclass

A4 = (595.0, 842.0)


@dataclass(frozen=True)
class TextItem:
    x: float
    y: float
    text: str
    size: float = 10.0


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(pages: list[list[TextItem]], *, size: tuple[float, float] = A4, rotate: int = 0) -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    pages_obj_index = add(b"")  # placeholder, filled below
    kids = []
    for items in pages:
        stream = (
            "BT\n"
            + "".join(
                f"/F1 {item.size:g} Tf 1 0 0 1 {item.x:g} {item.y:g} Tm ({_escape(item.text)}) Tj\n"
                for item in items
            )
            + "ET\n"
        )
        data = stream.encode("cp1252")
        content = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"endstream")
        page = add(
            (
                f"<< /Type /Page /Parent {pages_obj_index} 0 R /MediaBox [0 0 {size[0]:g} {size[1]:g}] "
                f"/Rotate {rotate} /Resources << /Font << /F1 {font} 0 R >> >> /Contents {content} 0 R >>"
            ).encode()
        )
        kids.append(page)
    objects[pages_obj_index - 1] = (
        f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()
    )
    catalog = add(f"<< /Type /Catalog /Pages {pages_obj_index} 0 R >>".encode())

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)
