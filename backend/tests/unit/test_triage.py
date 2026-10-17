"""Triage on FICTIONAL documents generated at test time."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from app.pipeline.triage import changed_share, dhash, hamming, text_quality, triage_image, triage_pdf
from app.validate.document import section
from tests.form_factory import encoded, filled_form
from tests.pdf_factory import A4, TextItem, make_pdf


def _write(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def test_vector_pdf_renders_every_page_with_word_boxes(tmp_path: Path) -> None:
    pages = [
        [TextItem(72, 770, "FICTIONAL LOG FX-01"), TextItem(300, 400, f"Depth {n},50 m")] for n in range(30)
    ]
    result = list(triage_pdf(_write(tmp_path, "fictional.pdf", make_pdf(pages))))
    assert [p.n for p in result] == list(range(1, 31))  # no page cap
    first = result[0]
    assert max(first.width_px, first.height_px) == 1600
    assert first.height_px > first.width_px
    assert first.text_layer_quality is not None and first.text_layer_quality > 0.95
    words = {w.text: w.box for w in first.words}
    x, y, w, h = words["FX-01"]
    # 72 pt from the left of a 595 pt page; baseline 770 pt from the bottom of 842 pt.
    assert 0.12 < x + 0 < 0.40 and 0.06 < y < 0.10 and 0 < w < 0.15 and 0 < h < 0.03
    x, y, _, _ = words["0,50"]
    assert x > 0.5 and 0.48 < y < 0.54
    assert Image.open(io.BytesIO(first.thumb)).size[1] == 300


def test_rotated_page_boxes_follow_the_render(tmp_path: Path) -> None:
    pdf = make_pdf([[TextItem(72, 770, "TOPLEFT")]], rotate=90)
    page = next(triage_pdf(_write(tmp_path, "rot.pdf", pdf)))
    assert page.width_px > page.height_px  # landscape after rotation
    x, y, w, h = page.words[0].box
    # Rotated 90 degrees clockwise: the top-left text moves to the top-right corner.
    assert x > 0.85 and y < 0.4 and w < h


def test_image_pages_and_tiff_frames(tmp_path: Path) -> None:
    img = Image.new("RGB", (3000, 2000), "white")
    single = list(triage_image(_write(tmp_path, "photo.png", _encode(img, "PNG"))))
    assert len(single) == 1 and (single[0].width_px, single[0].height_px) == (1600, 1067)
    frames = [Image.new("RGB", (800, 1000), c) for c in ("white", "black", "gray")]
    out = io.BytesIO()
    frames[0].save(out, format="TIFF", save_all=True, append_images=frames[1:])
    tiff = list(triage_image(_write(tmp_path, "scan.tiff", out.getvalue())))
    assert [p.n for p in tiff] == [1, 2, 3]
    assert tiff[0].text_layer_quality is None


def test_exif_orientation_applied(tmp_path: Path) -> None:
    img = Image.new("RGB", (400, 200), "white")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW on display
    out = io.BytesIO()
    img.save(out, format="JPEG", exif=exif)
    page = next(triage_image(_write(tmp_path, "phone.jpg", out.getvalue())))
    assert (page.width_px, page.height_px) == (200, 400)


def _encode(img: Image.Image, fmt: str) -> bytes:
    out = io.BytesIO()
    img.save(out, format=fmt)
    return out.getvalue()


def test_hash_is_stable_and_close_for_near_duplicates() -> None:
    base = Image.new("L", (800, 1100), 255)
    for i in range(0, 800, 40):
        base.paste(0, (i, 100, i + 10, 1000))
    shifted = base.copy()
    shifted.paste(0, (5, 5, 8, 8))
    other = base.transpose(Image.Transpose.FLIP_LEFT_RIGHT).rotate(90, expand=True)
    assert dhash(base) == dhash(base.copy())
    assert hamming(dhash(base), dhash(shifted)) <= 6
    assert hamming(dhash(base), dhash(other)) > 6


def _scan_rule() -> tuple[int, int, int, float]:
    cfg = section("page_duplicates")
    return (
        int(cfg["max_hamming"]),
        int(cfg["scan_compare_edge"]),
        int(cfg["scan_min_step"]),
        float(cfg["scan_max_changed_share"]),
    )


def test_one_form_filled_in_by_other_hands_is_not_one_scan() -> None:
    """The layout hash cannot tell two sheets of one form pad apart; the pixel comparison can."""
    max_hamming, edge, step, max_share = _scan_rule()
    first, second = filled_form(1), filled_form(2)
    assert hamming(dhash(first), dhash(second)) <= max_hamming  # the hash alone calls them copies
    assert changed_share(first, second, long_edge=edge, min_step=step) > max_share


def test_copies_of_one_scan_change_almost_no_pixel() -> None:
    max_hamming, edge, step, max_share = _scan_rule()
    scan = filled_form(3)
    jpeg = Image.open(io.BytesIO(encoded(scan, "JPEG", quality=50))).convert("RGB")
    rescaled = scan.resize((scan.width // 2, scan.height // 2)).resize(scan.size)
    for copy in (scan.copy(), jpeg, rescaled):
        assert hamming(dhash(scan), dhash(copy)) <= max_hamming
        assert changed_share(scan, copy, long_edge=edge, min_step=step) <= max_share


@pytest.mark.parametrize(
    ("text", "low"),
    [("Schluff, stark sandig 0,50 m", False), ("SPT N=23 (5/7/16)", False), ("�\x01ab", True), ("", None)],
)
def test_text_quality(text: str, low: bool | None) -> None:
    quality = text_quality(text)
    if low is None:
        assert quality is None
    else:
        assert quality is not None and (quality < 0.5) == low


def test_a4_constant() -> None:
    assert A4 == (595.0, 842.0)


def test_line_end_hyphen_keeps_each_word_on_its_line(tmp_path: Path) -> None:
    """PDFium joins a word hyphenated at a line end with the next line; each part keeps its own box."""
    pdf = make_pdf([[TextItem(60, 700, "Schluff, stark sand-"), TextItem(60, 688, "ig, braun")]])
    page = next(triage_pdf(_write(tmp_path, "hyphen.pdf", pdf)))
    words = {w.text: w.box for w in page.words}
    assert "sand-" in words and "ig," in words
    assert words["ig,"][1] > words["sand-"][1]  # the second part sits on the next line
    assert all("￾" not in w.text for w in page.words)
