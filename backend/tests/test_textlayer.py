"""FICTIONAL word layouts -> tight evidence boxes (app.pipeline.textlayer). No provider, no database.

Every word, label, place and number below is invented. Pages are built word by word as triage stores a
text layer (normalised [x, y, w, h] boxes), so each test knows exactly where every printed value sits.
Families: a German log with decimal commas and thin-space digit grouping, an English log with units glued
to the numbers, a log whose descriptions wrap over several lines (with a hyphenated line break and one
depth per boundary), and a drawn-to-scale log where the same numbers are printed many times.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Iterable, Sequence
from typing import Any

import pytest

from app.pipeline.provenance import Citations
from app.pipeline.schemas import (
    ExtractedGroundwater,
    ExtractedHeader,
    ExtractedLayer,
    ExtractedSample,
    ExtractedSpt,
    ExtractionResult,
    RawCoordinates,
    RawValue,
)
from app.pipeline.textlayer import (
    Box,
    Match,
    PageText,
    Resolution,
    config,
    find_runs,
    locate_text,
    page_text,
    page_text_from_payload,
    resolve_record,
    text_key,
    usable,
)
from app.pipeline.types import BlockRef

CHAR = 0.006  # width of one character
HEIGHT = 0.01
THIN = " "

Words = list[tuple[str, Box]]


def printed_at(x: float, y: float, text: str, *, height: float = HEIGHT, char: float = CHAR) -> Words:
    """Words of `text` from (x, y); every whitespace character separates words, as in a PDF text layer."""
    out: Words = []
    for token in re.split(r"\s", text):
        if token:
            width = char * len(token)
            out.append((token, (x, y, width, height)))
            x += width + char
        else:
            x += char
    return out


def page(*rows: Words, n: int = 1, quality: float | None = 0.98) -> PageText:
    return page_text(n, [w for row in rows for w in row], quality=quality)


def texts(layer: PageText, match: Match) -> list[str]:
    return [layer.words[i].text for i in match.words]


def box_of(layer: PageText, *spans: tuple[str, int]) -> Box:
    """Union box of words given as (text, occurrence in reading order)."""
    boxes = []
    for text, nth in spans:
        found = [w for w in layer.words if w.text == text]
        boxes.append(found[nth].box)
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[0] + b[2] for b in boxes), max(b[1] + b[3] for b in boxes)
    return (x0, y0, x1 - x0, y1 - y0)


def approx(box: Sequence[float] | None, expected: Sequence[float]) -> bool:
    return box is not None and all(abs(a - b) < 1e-9 for a, b in zip(box, expected, strict=True))


def rv(raw: str | None, *ids: str, state: str = "ok") -> RawValue:
    return RawValue(raw=raw, block_ids=list(ids), state=state)  # type: ignore[arg-type]


def absent() -> RawValue:
    return RawValue(raw=None, block_ids=[], state="not_in_source")


def header(**values: RawValue) -> ExtractedHeader:
    coords = {k: values.pop(k, absent()) for k in ("x_raw", "y_raw", "labels_raw", "system_raw")}
    fields = {n: values.pop(n, absent()) for n in ExtractedHeader.model_fields if n != "coordinates"}
    assert not values
    return ExtractedHeader(coordinates=RawCoordinates(**coords), **fields)


def layer(top: RawValue, bottom: RawValue, description: RawValue, **cells: RawValue) -> ExtractedLayer:
    names = ("uscs_raw", "colour_raw", "consistency_raw", "moisture_raw", "weathering_raw")
    more = ("stratigraphic_name_raw", "engineering_soil_unit_raw", "geologic_age_raw")
    extra = {n: cells.pop(n, absent()) for n in (*names, *more)}
    assert not cells
    return ExtractedLayer(
        from_raw=top,
        to_raw=bottom,
        description_raw=description,
        description_language=None,
        english_lithology=None,
        din4023_code=None,
        din4023_notation=None,
        **extra,
    )


def result(head: ExtractedHeader, layers: list[ExtractedLayer], **arrays: Any) -> ExtractionResult:
    return ExtractionResult(
        header=head,
        layers=layers,
        spt=arrays.get("spt", []),
        core_runs=[],
        groundwater=arrays.get("groundwater", []),
        samples=arrays.get("samples", []),
        tests=[],
    )


def block(block_id: str, box: Box | None, quality: float | None = 0.98) -> BlockRef:
    return BlockRef(
        id=block_id,
        page=int(block_id[1:].split(".")[0]),
        text="(coarse OCR block)",
        box=box,
        confidence=0.9,
        page_text_quality=quality,
        page_handwriting="none",
    )


WHOLE: Box = (0.0, 0.0, 1.0, 1.0)


def depth_number(value: RawValue) -> float | None:
    """Depth order of the fictional values (the finaliser passes its own normaliser)."""
    raw = (value.raw or "").replace(",", ".").rstrip("m").strip()
    try:
        return float(raw)
    except ValueError:
        return None


def resolve(res: ExtractionResult, blocks: Iterable[BlockRef], *layers: PageText) -> Resolution:
    return resolve_record(
        res,
        {b.id: b for b in blocks},
        {t.page: t for t in layers},
        page_key=lambda n: (0, n),
        depth_of=depth_number,
    )


# ----------------------------------------------------------------------------------------------
# Keys, words and lines
# ----------------------------------------------------------------------------------------------


def test_keys_ignore_spacing_case_and_separator_variants() -> None:
    assert text_key("1,20") == text_key("1.20") == "1.20"
    assert text_key(f"5{THIN}316{THIN}044,2") == text_key("5 316 044,2") == text_key("5316044.2")
    assert text_key("0,00–1,20") == text_key("0,00 - 1,20")  # en dash vs hyphen
    assert text_key("−2,5") == text_key("-2,5")  # Unicode minus
    assert text_key("KIES") == text_key("Kies")
    assert text_key("ﬁll") == text_key("fill")  # ligature
    assert text_key("N’ 12") == text_key("N' 12")
    assert text_key("  ") == ""


def test_lines_group_words_by_height_and_order_them() -> None:
    layer = page(
        printed_at(0.5, 0.101, "right"),
        printed_at(0.1, 0.1, "left"),
        [("-", (0.3, 0.104, 0.004, 0.001))],  # a dash has a tiny box in the middle of the line
        printed_at(0.1, 0.13, "next line"),
    )
    assert [[layer.words[i].text for i in line.words] for line in layer.lines] == [
        ["left", "-", "right"],
        ["next", "line"],
    ]
    assert [w.index for w in layer.words] == list(range(5))
    assert layer.words[0].line == 0 and layer.words[3].line == 1


def test_stored_payload_is_read_and_broken_entries_are_skipped() -> None:
    payload = {
        "text": "Bohrung KB 9",
        "words": [
            {"t": "Bohrung", "b": [0.1, 0.1, 0.05, 0.01]},
            {"t": "KB", "b": [0.16, 0.1, 0.012, 0.01]},
            {"t": "9", "b": [0.18, 0.1, 0.006, 0.01]},
            {"t": "bad box", "b": [0.1, 0.1]},
            {"t": "negative", "b": [0.1, 0.1, -0.1, 0.01]},
            {"t": None, "b": [0.1, 0.1, 0.1, 0.01]},
            {"t": "schluf￾Ton", "b": [0.1, 0.2, 0.1, 0.03]},  # PDFium glued two lines at a hyphen
            "not a word",
        ],
    }
    layer = page_text_from_payload(4, payload, quality=0.97)
    assert [w.text for w in layer.words] == ["Bohrung", "KB", "9"]
    assert layer.page == 4 and usable(layer)
    assert not usable(page_text_from_payload(4, payload, quality=0.5))
    assert not usable(page_text_from_payload(4, payload, quality=None))
    assert not usable(page_text_from_payload(4, {"words": []}, quality=0.99))


# ----------------------------------------------------------------------------------------------
# Family 1: German log, decimal commas, thin-space digit grouping
# ----------------------------------------------------------------------------------------------


def german_page() -> PageText:
    return page(
        printed_at(0.1, 0.05, "Bohrung KB 9 (fiktiv)"),
        printed_at(0.1, 0.07, "Endtiefe 6,00 m"),
        printed_at(0.5, 0.07, f"Rechtswert 3{THIN}512{THIN}345,6"),
        printed_at(0.5, 0.085, "System ETRS89 / UTM 32N"),
        printed_at(0.1, 0.2, "0,00") + printed_at(0.18, 0.2, "1,20") + printed_at(0.3, 0.2, "Mutterboden"),
        printed_at(0.1, 0.23, "1,20")
        + printed_at(0.18, 0.23, "3,40")
        + printed_at(0.3, 0.23, "Sand, mittelsandig,"),
        printed_at(0.3, 0.244, "schwach kiesig"),
        printed_at(0.1, 0.27, "3,40") + printed_at(0.18, 0.27, "6,00") + printed_at(0.3, 0.27, "Ton, steif"),
        printed_at(0.6, 0.27, "GW 2,10 m"),
    )


def test_thin_spaces_and_decimal_variants_are_found() -> None:
    layer = german_page()
    # The text layer split the grouped number at its thin spaces: one value, three words.
    (coordinate,) = find_runs(layer, "3 512 345,6")
    assert texts(layer, coordinate) == ["3", "512", "345,6"] and not coordinate.partial
    assert [texts(layer, m) for m in find_runs(layer, "3512345.6")] == [["3", "512", "345,6"]]
    # The model may write a decimal point for a printed comma.
    assert len(find_runs(layer, "1.20")) == 2
    assert [texts(layer, m) for m in find_runs(layer, "6,00 m")] == [["6,00", "m"]]
    # A value may start inside a word after punctuation ("(fiktiv)" -> "fiktiv").
    (fiktiv,) = find_runs(layer, "fiktiv")
    assert fiktiv.partial and texts(layer, fiktiv) == ["(fiktiv)"]
    assert [texts(layer, m) for m in find_runs(layer, "ETRS89 / UTM 32N")] == [["ETRS89", "/", "UTM", "32N"]]


def test_numbers_and_words_are_never_cut_inside() -> None:
    layer = german_page()
    assert find_runs(layer, "1") == []  # not inside "1,20"
    assert find_runs(layer, "20") == []  # not the decimals of "1,20"
    assert find_runs(layer, "6,0") == []
    assert find_runs(layer, "Sand, mittel") == []  # not inside "mittelsandig"
    assert find_runs(layer, "Mutter") == []
    assert find_runs(layer, "KB 99") == []


def test_cited_block_limits_where_a_value_is_looked_for() -> None:
    layer = german_page()
    first_row: Box = (0.09, 0.195, 0.4, 0.02)
    assert [m.first for m in find_runs(layer, "1,20", [first_row])] == [
        next(w.index for w in layer.words if w.text == "1,20")
    ]
    assert find_runs(layer, "Ton, steif", [first_row]) == []
    assert find_runs(layer, "1,20", []) == []  # nothing cited on the page


def test_german_record_with_one_coarse_block() -> None:
    layer = german_page()
    coarse = block("p1.b0", WHOLE)
    b = "p1.b0"
    head = header(
        borehole_label=rv("KB 9", b),
        total_depth=rv("6,00", b),
        x_raw=rv("3 512 345,6", b),
        system_raw=rv("ETRS89 / UTM 32N", b),
    )
    layers = [
        layer_values("0,00", "1,20", "Mutterboden", b),
        layer_values("1,20", "3,40", "Sand, mittelsandig, schwach kiesig", b),
        layer_values("3,40", "6,00", "Ton, steif", b, consistency_raw=rv("steif", b)),
    ]
    water = ExtractedGroundwater(type="strike", depth_raw=rv("2,10", b), date_raw=absent())
    res = result(head, layers, groundwater=[water])
    resolution = resolve(res, [coarse], layer)
    assert res.layers[0] is layers[0]  # hits are keyed by the very values the record is built from

    def hit_box(value: RawValue) -> Box | None:
        hit = resolution.get(value)
        assert hit is not None and hit.page == 1, value
        return hit.box

    top, sand, clay = res.layers
    # Depths top to bottom: each layer's top is the second "1,20"/"3,40", not its upper neighbour's base.
    assert hit_box(top.from_raw) == box_of(layer, ("0,00", 0))
    assert hit_box(top.to_raw) == box_of(layer, ("1,20", 0))
    assert hit_box(sand.from_raw) == box_of(layer, ("1,20", 1))
    assert hit_box(sand.to_raw) == box_of(layer, ("3,40", 0))
    assert hit_box(clay.from_raw) == box_of(layer, ("3,40", 1))
    assert hit_box(clay.to_raw) == box_of(layer, ("6,00", 1))  # the table cell, not "Endtiefe 6,00 m"
    # The header's total depth takes the "6,00" outside the table that no layer uses.
    assert hit_box(res.header.total_depth) == box_of(layer, ("6,00", 0))
    # A description wrapped over two lines: the union of its words on both lines.
    assert approx(
        hit_box(sand.description_raw),
        box_of(layer, ("Sand,", 0), ("mittelsandig,", 0), ("schwach", 0), ("kiesig", 0)),
    )
    assert hit_box(clay.consistency_raw) == box_of(layer, ("steif", 0))
    assert approx(hit_box(res.header.coordinates.x_raw), box_of(layer, ("3", 0), ("512", 0), ("345,6", 0)))
    assert hit_box(res.header.borehole_label) == box_of(layer, ("KB", 0), ("9", 0))
    assert hit_box(water.depth_raw) == box_of(layer, ("2,10", 0))
    assert resolution.get(res.header.coordinates.labels_raw) is None  # not printed: nothing found


def layer_values(top: str, bottom: str, description: str, block_id: str, **cells: RawValue) -> ExtractedLayer:
    return layer(rv(top, block_id), rv(bottom, block_id), rv(description, block_id), **cells)


# ----------------------------------------------------------------------------------------------
# Family 2: English log, units glued to the numbers
# ----------------------------------------------------------------------------------------------


def english_page() -> PageText:
    return page(
        printed_at(0.05, 0.04, "BOREHOLE BH-12 (FICTIONAL)"),
        printed_at(0.05, 0.06, "Ground level: 12.50m AHD"),
        printed_at(0.05, 0.2, "0.00m")
        + printed_at(0.15, 0.2, "0.40m")
        + printed_at(0.3, 0.2, "FILL: Silty CLAY"),
        printed_at(0.05, 0.23, "0.40m")
        + printed_at(0.15, 0.23, "1.50m")
        + printed_at(0.3, 0.23, "CLAY, stiff, grey")
        + printed_at(0.7, 0.23, "SPT N=14"),
        printed_at(0.05, 0.26, "1.50m")
        + printed_at(0.15, 0.26, "4.00m")
        + printed_at(0.3, 0.26, "SANDSTONE, grey")
        + printed_at(0.7, 0.26, "SPT 50/120mm"),
    )


def test_units_glued_to_numbers() -> None:
    layer = english_page()
    found = find_runs(layer, "0.40")
    assert [texts(layer, m) for m in found] == [["0.40m"], ["0.40m"]] and all(m.partial for m in found)
    assert [texts(layer, m) for m in find_runs(layer, "0.40m")] == [["0.40m"], ["0.40m"]]
    assert [texts(layer, m) for m in find_runs(layer, "N=14")] == [["N=14"]]
    assert [texts(layer, m) for m in find_runs(layer, "14")] == [["N=14"]]
    assert [texts(layer, m) for m in find_runs(layer, "50/120mm")] == [["50/120mm"]]
    assert [texts(layer, m) for m in find_runs(layer, "120")] == [["50/120mm"]]
    assert [texts(layer, m) for m in find_runs(layer, "12.50")] == [["12.50m"]]
    assert find_runs(layer, "1") == []  # not inside "1.50m"
    assert [texts(layer, m) for m in find_runs(layer, "50")] == [["50/120mm"]]  # not the decimals of 12.50m
    assert [texts(layer, m) for m in find_runs(layer, "silty clay")] == [["Silty", "CLAY"]]


def test_english_record_and_spt_rows() -> None:
    layer = english_page()
    b = "p1.b0"
    head = header(borehole_label=rv("BH-12", b), ground_level=rv("12.50", b))
    layers = [
        layer_values("0.00", "0.40", "FILL: Silty CLAY", b),
        layer_values("0.40", "1.50", "CLAY, stiff, grey", b, colour_raw=rv("grey", b)),
        layer_values("1.50", "4.00", "SANDSTONE, grey", b, colour_raw=rv("grey", b)),
    ]
    spt = [
        ExtractedSpt(
            depth_raw=rv("1.50", b), blows_raw=absent(), n_raw=rv("N=14", b), increment_note_raw=absent()
        )
    ]
    res = result(head, layers, spt=spt)
    resolution = resolve(res, [block(b, (0.0, 0.0, 1.0, 0.4))], layer)

    def hit_box(value: RawValue) -> Box | None:
        hit = resolution.get(value)
        assert hit is not None
        return hit.box

    fill, clay, rock = res.layers
    assert hit_box(fill.to_raw) == box_of(layer, ("0.40m", 0))
    assert hit_box(clay.from_raw) == box_of(layer, ("0.40m", 1))
    assert hit_box(clay.to_raw) == box_of(layer, ("1.50m", 0))
    assert hit_box(rock.from_raw) == box_of(layer, ("1.50m", 1))
    # "grey" twice: each layer's colour is the word in its own row's description.
    assert hit_box(clay.colour_raw) == box_of(layer, ("grey", 0))
    assert hit_box(rock.colour_raw) == box_of(layer, ("grey", 1))
    assert hit_box(res.header.ground_level) == box_of(layer, ("12.50m", 0))
    assert hit_box(spt[0].n_raw) == box_of(layer, ("N=14", 0))
    assert hit_box(res.header.borehole_label) == box_of(layer, ("BH-12", 0))


def test_engineering_soil_unit_and_geologic_age_get_word_boxes_in_their_rows() -> None:
    """Both columns repeat a value on several rows ("HB 2", "Quartär"): each layer gets its own row's word."""
    layer = page(
        printed_at(0.05, 0.1, "Tiefe")
        + printed_at(0.6, 0.1, "Homogenbereich")
        + printed_at(0.8, 0.1, "Alter"),
        printed_at(0.05, 0.2, "0,00")
        + printed_at(0.12, 0.2, "0,80")
        + printed_at(0.25, 0.2, "Auffüllung, Sand")
        + printed_at(0.6, 0.2, "HB 1")
        + printed_at(0.8, 0.2, "Quartär"),
        printed_at(0.05, 0.24, "0,80")
        + printed_at(0.12, 0.24, "2,40")
        + printed_at(0.25, 0.24, "Kies, sandig")
        + printed_at(0.6, 0.24, "HB 2")
        + printed_at(0.8, 0.24, "Quartär"),
        printed_at(0.05, 0.28, "2,40")
        + printed_at(0.12, 0.28, "5,00")
        + printed_at(0.25, 0.28, "Kies, schwach sandig")
        + printed_at(0.6, 0.28, "HB 2")
        + printed_at(0.8, 0.28, "Tertiär"),
    )
    b = "p1.b0"
    rows = [
        ("0,00", "0,80", "Auffüllung, Sand", "HB 1", "Quartär"),
        ("0,80", "2,40", "Kies, sandig", "HB 2", "Quartär"),
        ("2,40", "5,00", "Kies, schwach sandig", "HB 2", "Tertiär"),
    ]
    res = result(
        header(),
        [
            layer_values(
                top, bottom, text, b, engineering_soil_unit_raw=rv(unit, b), geologic_age_raw=rv(age, b)
            )
            for top, bottom, text, unit, age in rows
        ],
    )
    resolution = resolve(res, [block(b, WHOLE)], layer)

    def hit_box(value: RawValue) -> Box | None:
        hit = resolution.get(value)
        assert hit is not None and hit.page == 1, value
        return hit.box

    fill, gravel, deep = res.layers
    assert hit_box(fill.engineering_soil_unit_raw) == box_of(layer, ("HB", 0), ("1", 0))
    assert hit_box(gravel.engineering_soil_unit_raw) == box_of(layer, ("HB", 1), ("2", 0))
    assert hit_box(deep.engineering_soil_unit_raw) == box_of(layer, ("HB", 2), ("2", 1))
    assert hit_box(fill.geologic_age_raw) == box_of(layer, ("Quartär", 0))
    assert hit_box(gravel.geologic_age_raw) == box_of(layer, ("Quartär", 1))
    assert hit_box(deep.geologic_age_raw) == box_of(layer, ("Tertiär", 0))


# ----------------------------------------------------------------------------------------------
# Family 3: descriptions over several lines, one depth per boundary
# ----------------------------------------------------------------------------------------------


def wrapped_page() -> PageText:
    """Base depth printed on the last line of each row ("bis" column); descriptions wrap in their column.
    The text layer splits a hyphenated word at the line end ("schluf-" / "fig,")."""
    return page(
        printed_at(0.1, 0.18, "0,00"),
        printed_at(0.3, 0.2, "Kies, sandig,"),
        printed_at(0.3, 0.214, "schwach schluf-"),
        printed_at(0.1, 0.228, "2,50") + printed_at(0.3, 0.228, "fig, grau"),
        printed_at(0.3, 0.26, "Ton, halbfest,"),
        printed_at(0.1, 0.274, "4,00") + printed_at(0.3, 0.274, "dunkelgrau"),
        printed_at(0.3, 0.31, "Legende: grau = Farbe, 2,50 = Tiefe"),
    )


def test_wrapped_descriptions_follow_their_column_and_hyphens() -> None:
    layer = wrapped_page()
    (gravel,) = find_runs(layer, "Kies, sandig, schwach schluffig, grau")
    assert texts(layer, gravel) == ["Kies,", "sandig,", "schwach", "schluf-", "fig,", "grau"]
    assert approx(gravel.box, box_of(layer, ("Kies,", 0), ("schluf-", 0), ("grau", 0)))
    (clay,) = find_runs(layer, "Ton, halbfest, dunkelgrau")
    assert texts(layer, clay) == ["Ton,", "halbfest,", "dunkelgrau"]
    # A printed hyphen that is part of the value is kept.
    assert [texts(layer, m) for m in find_runs(layer, "schwach schluf-")] == [["schwach", "schluf-"]]
    # The depth column on the same lines is not part of the description column.
    assert find_runs(layer, "sandig, 2,50") == []
    assert find_runs(layer, "0,00 Kies") == []


def test_one_printed_depth_serves_two_layers_when_nothing_else_fits() -> None:
    layer = wrapped_page()
    b = "p1.b0"
    res = result(
        header(),
        [
            layer_values(
                "0,00", "2,50", "Kies, sandig, schwach schluffig, grau", b, colour_raw=rv("grau", b)
            ),
            layer_values("2,50", "4,00", "Ton, halbfest, dunkelgrau", b),
        ],
    )
    resolution = resolve(res, [block(b, WHOLE)], layer)
    gravel, clay = res.layers
    base, top = resolution.get(gravel.to_raw), resolution.get(clay.from_raw)
    assert base is not None and top is not None
    # The legend's "2,50" is unused but lies below the next base: the top shares the printed boundary.
    assert base.box == top.box == box_of(layer, ("2,50", 0))
    colour = resolution.get(gravel.colour_raw)
    assert colour is not None and colour.box == box_of(layer, ("grau", 0))  # in its row, not the legend


# ----------------------------------------------------------------------------------------------
# Family 4: the same number printed many times (depth scale, depth column, sample column)
# ----------------------------------------------------------------------------------------------


def scale_page() -> PageText:
    """Drawn to scale: a scale column, the boundary depths, the description and a sample column share
    lines; the boundaries 1.00 and 2.00 are each printed three times on their line."""
    return page(
        printed_at(0.02, 0.1, "0.00") + printed_at(0.1, 0.1, "0.00"),
        printed_at(0.3, 0.15, "Topsoil (fictional)"),
        printed_at(0.02, 0.2, "1.00")
        + printed_at(0.1, 0.2, "1.00")
        + printed_at(0.7, 0.2, "1.00")
        + printed_at(0.8, 0.2, "U1"),
        printed_at(0.3, 0.25, "Sand"),
        printed_at(0.02, 0.3, "2.00") + printed_at(0.1, 0.3, "2.00") + printed_at(0.7, 0.3, "2.00"),
        printed_at(0.3, 0.35, "Sand"),
        printed_at(0.02, 0.4, "3.00") + printed_at(0.1, 0.4, "3.00"),
    )


def test_repeated_numbers_are_assigned_by_order_and_row() -> None:
    layer = scale_page()
    b = "p1.b0"
    sample = ExtractedSample(name_raw=rv("U1", b), type_raw=absent(), from_raw=rv("1.00", b), to_raw=absent())
    res = result(
        header(),
        [
            layer_values("0.00", "1.00", "Topsoil (fictional)", b),
            layer_values("1.00", "2.00", "Sand", b),
            layer_values("2.00", "3.00", "Sand", b),
        ],
        samples=[sample],
    )
    resolution = resolve(res, [block(b, WHOLE)], layer)

    def hit_box(value: RawValue) -> Box | None:
        hit = resolution.get(value)
        assert hit is not None
        return hit.box

    topsoil, upper, lower = res.layers
    # Depths come from the depth column next to the descriptions, never from the scale.
    assert hit_box(topsoil.from_raw) == box_of(layer, ("0.00", 1))
    assert hit_box(topsoil.to_raw) == box_of(layer, ("1.00", 1))
    assert hit_box(upper.from_raw) == box_of(layer, ("1.00", 1))
    assert hit_box(lower.to_raw) == box_of(layer, ("3.00", 1))
    # Two layers described "Sand": each gets its own printed word, in depth order.
    assert hit_box(upper.description_raw) == box_of(layer, ("Sand", 0))
    assert hit_box(lower.description_raw) == box_of(layer, ("Sand", 1))
    # The sample's depth is the "1.00" next to its name, not one a layer already uses.
    assert hit_box(sample.from_raw) == box_of(layer, ("1.00", 2))
    assert hit_box(sample.name_raw) == box_of(layer, ("U1", 0))


def test_a_value_that_fits_several_places_equally_keeps_its_blocks() -> None:
    layer = page(
        printed_at(0.1, 0.05, "Projekt Musterau (fiktiv)"),
        printed_at(0.1, 0.5, "Ton"),
        printed_at(0.1, 0.95, "Projekt Musterau (fiktiv)"),
    )
    b = "p1.b0"
    res = result(header(project=rv("Musterau", b)), [])
    resolution = resolve(res, [block(b, WHOLE)], layer)
    hit = resolution.get(res.header.project)
    assert hit is not None and hit.page == 1 and hit.box is None  # found (agreement), but not placed


def test_too_many_places_are_found_without_a_box() -> None:
    layer = page(*(printed_at(0.1, 0.05 + 0.02 * i, "1.00") for i in range(5)))
    cfg = dataclasses.replace(config(), max_candidates=3)
    assert len(find_runs(layer, "1.00", cfg=cfg)) == 4  # one more than considered
    b = "p1.b0"
    res = result(header(total_depth=rv("1.00", b)), [])
    resolution = resolve_record(
        res, {b: block(b, WHOLE)}, {1: layer}, page_key=lambda n: (0, n), depth_of=depth_number, cfg=cfg
    )
    hit = resolution.get(res.header.total_depth)
    assert hit is not None and hit.box is None


def test_no_trustworthy_layer_no_resolution() -> None:
    b = "p1.b0"
    res = result(header(borehole_label=rv("KB 9", b)), [])
    scanned = german_page()
    scanned = dataclasses.replace(scanned, quality=0.4)
    assert len(resolve(res, [block(b, WHOLE, quality=0.4)], scanned)) == 0
    assert len(resolve(res, [block(b, WHOLE)])) == 0
    # A value on a page without a text layer is not looked for on another page.
    other = dataclasses.replace(german_page(), page=2)
    assert len(resolve(res, [block(b, WHOLE)], other)) == 0


def test_blocks_without_a_box_stand_for_their_page() -> None:
    layer = german_page()
    b = "p1.b3"
    res = result(header(borehole_label=rv("KB 9", b)), [])
    resolution = resolve(res, [block(b, None)], layer)
    hit = resolution.get(res.header.borehole_label)
    assert hit is not None and hit.box == box_of(layer, ("KB", 0), ("9", 0))


def test_locate_text_for_a_label_inside_one_block() -> None:
    layer = german_page()
    title = block("p1.b0", (0.09, 0.045, 0.3, 0.02))
    hit = locate_text("KB 9", [title], {1: layer}, page_key=lambda n: (0, n))
    assert hit is not None and hit.box == box_of(layer, ("KB", 0), ("9", 0))
    assert locate_text("KB 10", [title], {1: layer}, page_key=lambda n: (0, n)) is None
    twice = locate_text("1,20", [block("p1.b1", WHOLE)], {1: layer}, page_key=lambda n: (0, n))
    assert twice is not None and twice.box is None
    assert locate_text("KB 9", [title], {}, page_key=lambda n: (0, n)) is None


# ----------------------------------------------------------------------------------------------
# Provenance entries built from a resolution
# ----------------------------------------------------------------------------------------------


def test_entries_get_word_boxes_and_read_only_when_found() -> None:
    layer = german_page()
    coarse = block("p1.b0", (0.05, 0.03, 0.9, 0.3))
    b = coarse.id
    res = result(
        header(borehole_label=rv("KB 9", b), notes=rv("Not printed anywhere", b)),
        [layer_values("0,00", "1,20", "Mutterboden", b)],
    )
    cite = Citations({b: coarse}, document_id="doc_X", page_order=(1,), text_layers={1: layer})
    cite.resolution = resolve(res, [coarse], layer)
    label = cite.entry(res.header.borehole_label)
    assert label.method == "read" and label.box is not None
    assert approx(label.box, [round(v, 6) for v in box_of(layer, ("KB", 0), ("9", 0))])
    missing = cite.entry(res.header.notes)
    assert (missing.method, missing.box) == ("ocr", [0.05, 0.03, 0.9, 0.3])  # the block, never a guess
    both = cite.entry(res.layers[0].from_raw, res.layers[0].to_raw)
    assert both.method == "read"
    assert approx(both.box, [round(v, 6) for v in box_of(layer, ("0,00", 0), ("1,20", 0))])
    derived = cite.entry(res.layers[0].description_raw, method="derived")
    assert derived.method == "derived" and derived.box is not None and derived.box[2] < 0.1
    # Without a resolution the same citation keeps the block and is an OCR reading.
    plain = Citations({b: coarse}, document_id="doc_X", page_order=(1,)).entry(res.header.borehole_label)
    assert (plain.method, plain.box) == ("ocr", [0.05, 0.03, 0.9, 0.3])


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Bohrung KB 9", ["Bohrung", "KB", "9"]),
        ("bohrung kb 9", ["Bohrung", "KB", "9"]),
        ("KB9", ["KB", "9"]),
        ("Endtiefe 6.00 m", ["Endtiefe", "6,00", "m"]),
    ],
)
def test_spacing_and_case_variants_of_one_value(raw: str, expected: list[str]) -> None:
    layer = german_page()
    assert [texts(layer, m) for m in find_runs(layer, raw)] == [expected]
