"""One borehole per listed ID within a document (app.pipeline.identity). Fictional labels and pages."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from app.pipeline.identity import Tables, find_listed, ids_from_labels, reconcile
from app.pipeline.schemas import ExtractionResult, RawValue
from app.pipeline.types import BlockRef, ExtractionOutcome, PageGroup

LISTED = ids_from_labels(["701", "702", "702b", "703", "704"])
HEADER_FIELDS = [
    *("project", "client", "location", "contractor", "method", "start_date", "end_date", "total_depth"),
    *("depth_unit", "ground_level", "elevation_datum", "inclination", "depth_origin_note", "notes"),
]


def block(page: int, i: int, text: str) -> BlockRef:
    return BlockRef(
        id=f"p{page}.b{i}",
        page=page,
        text=text,
        box=(0.1, 0.1, 0.2, 0.02),
        confidence=0.9,
        page_text_quality=None,
        page_handwriting="partial",
    )


def result(label: str | None, layers: Any = (), block_id: str | None = None) -> Any:
    def raw(text: str | None) -> dict[str, Any] | None:
        cited = [block_id] if block_id else []
        return None if text is None else {"raw": text, "block_ids": cited, "state": "ok"}

    header: dict[str, Any] = dict.fromkeys(HEADER_FIELDS)
    header["borehole_label"] = raw(label)
    header["coordinates"] = {"x_raw": None, "y_raw": None, "labels_raw": None, "system_raw": None}
    return ExtractionResult.model_validate(
        {
            "header": header,
            "layers": [
                {
                    "from_raw": raw(top),
                    "to_raw": raw(bottom),
                    "description_raw": raw(text),
                    "description_language": "no",
                    "english_lithology": None,
                    "din4023_code": None,
                    "din4023_notation": None,
                    "uscs_raw": None,
                    "colour_raw": None,
                    "consistency_raw": None,
                    "moisture_raw": None,
                    "weathering_raw": None,
                    "stratigraphic_name_raw": None,
                }
                for top, bottom, text in layers
            ],
            "spt": [],
            "core_runs": [],
            "groundwater": [],
            "samples": [],
            "tests": [],
        }
    )


def pair(
    label: str, pages: tuple[int, ...], blocks: list[BlockRef], layers: Any = ()
) -> tuple[PageGroup, ExtractionOutcome]:
    group = PageGroup(key=f"{label}:p{pages[0]}", label_raw=label, label_canonical=label.upper(), pages=pages)
    first = blocks[0].id if blocks else None
    outcome = ExtractionOutcome(
        result=result(label, list(layers), first), blocks={b.id: b for b in blocks}, run_id=None, model="m"
    )
    return group, outcome


def test_prefixed_id_wins_over_a_bare_number() -> None:
    blocks = [block(4, 1, "Rørbrudd ved 703 m?"), block(4, 2, "Kommentar: Hull nr 702b")]
    hit = find_listed(blocks, [4], LISTED)
    assert hit is not None and hit.canonical == "702B" and hit.prefixed


def test_longest_listed_id_stands_and_spaced_suffix_matches() -> None:
    hit = find_listed([block(5, 1, "Hull 702 b")], [5], LISTED)
    assert hit is not None and hit.canonical == "702B"


def test_two_different_bare_ids_are_ambiguous() -> None:
    assert find_listed([block(6, 1, "701 og 703")], [6], LISTED) is None


def test_ids_on_other_pages_are_ignored() -> None:
    assert find_listed([block(1, 1, "Hull nr 701")], [6], LISTED) is None


def test_short_bare_numbers_need_a_borehole_word() -> None:
    listed = ids_from_labels(["1", "2", "3"])
    assert find_listed([block(2, 1, "Sand 1 m")], [2], listed) is None
    hit = find_listed([block(2, 1, "Borehole No. 2")], [2], listed)
    assert hit is not None and hit.canonical == "2"


def test_header_name_gives_way_to_the_listed_id_its_page_prints() -> None:
    items = reconcile(
        [pair("Br Driller", (8,), [block(8, 1, "Br Driller"), block(8, 2, "Kommentar: Hull nr 704")])], LISTED
    )
    assert len(items) == 1
    item = items[0]
    assert item.group.label_raw == "704" and item.group.key == "704:p8"
    assert item.outcome.result.header.borehole_label.raw == "704"
    assert item.outcome.result.header.borehole_label.block_ids == ["p8.b2"]
    assert item.aliases == ["Br Driller"]


def test_parts_with_the_same_listed_id_are_merged_in_page_order() -> None:
    log = pair("Holt nr 702", (2,), [block(2, 1, "Holt nr 702")], layers=[("0", "27", "Grus")])
    plot = pair("702", (3,), [block(3, 1, "Id: 702")])
    other = pair("703", (5,), [block(5, 1, "Hull nr 703")], layers=[("0", "16", "Grus")])
    items = reconcile([plot, other, log], LISTED)
    assert [i.group.label_raw for i in items] == ["702", "703"]
    merged = items[0]
    assert merged.group.pages == (2, 3) and merged.group.key == "702:p2-p3"
    assert len(merged.outcome.result.layers) == 1
    assert set(merged.outcome.blocks) == {"p2.b1", "p3.b1"}
    assert merged.aliases == ["Holt nr 702"]


def test_colliding_block_ids_are_renamed_when_merging() -> None:
    a = pair("701", (2,), [block(2, 1, "Hull nr 701")], layers=[("0", "5", "Leire")])
    b_blocks = [BlockRef("p2.b1", 2, "Id 701 plot", (0.5, 0.5, 0.1, 0.1), None, None, None)]
    b = pair("701", (2,), b_blocks, layers=[("5", "9", "Fjell")])
    merged = reconcile([a, b], LISTED)[0]
    assert len(merged.outcome.blocks) == 2
    cited = {bid for layer in merged.outcome.result.layers for bid in layer.from_raw.block_ids}
    assert cited <= set(merged.outcome.blocks)


def _at(part: tuple[PageGroup, ExtractionOutcome], x: str, y: str) -> tuple[PageGroup, ExtractionOutcome]:
    group, out = part
    point = {"raw": None, "block_ids": [], "state": "ok"}
    coords = out.result.header.coordinates.model_validate(
        {"x_raw": {**point, "raw": x}, "y_raw": {**point, "raw": y}, "labels_raw": None, "system_raw": None}
    )
    header = out.result.header.model_copy(update={"coordinates": coords})
    return group, replace(out, result=out.result.model_copy(update={"header": header}))


def test_without_a_table_parts_of_one_label_merge_unless_they_print_other_positions() -> None:
    sheets = [pair("BH-1", (1,), [block(1, 1, "BH-1")]), pair("BH-1", (2,), [block(2, 1, "BH-1")])]
    assert [i.group.key for i in reconcile(sheets, {})] == ["BH-1:p1-p2"]
    same = [_at(sheets[0], "X:270,631.7", "Y:171,703.9"), _at(sheets[1], "270,631.7", "171,703.9")]
    assert [i.group.key for i in reconcile(same, {})] == ["BH-1:p1-p2"]
    other = [_at(sheets[0], "270,631.7", "171,703.9"), _at(sheets[1], "271,546.0", "172,097.8")]
    assert [i.group.key for i in reconcile(other, {})] == ["BH-1:p1", "BH-1:p2"]


def _with_header(
    part: tuple[PageGroup, ExtractionOutcome], **values: tuple[str, str]
) -> tuple[PageGroup, ExtractionOutcome]:
    """The part with header values (name -> (raw, cited block id))."""
    group, out = part
    update = {name: RawValue(raw=raw, block_ids=[bid], state="ok") for name, (raw, bid) in values.items()}
    header = out.result.header.model_copy(update=update)
    return group, replace(out, result=out.result.model_copy(update={"header": header}))


def _table(page: int, rows: list[tuple[str, ...]]) -> list[BlockRef]:
    """Fictional table cells: one block per cell, one row per 0.05 of page height."""
    out = []
    for r, cells in enumerate(rows):
        for c, text in enumerate(cells):
            out.append(
                BlockRef(
                    f"p{page}.b{10 * r + c}",
                    page,
                    text,
                    (0.1 + 0.15 * c, 0.2 + 0.05 * r, 0.1, 0.02),
                    0.9,
                    0.9,
                    "none",
                )
            )
    return out


TABLE = _table(
    1, [("701", "4890,5", "2875,5", "68"), ("703", "4930,5", "2901", "59,4"), ("704", "4971", "2953,5", "43")]
)


def test_an_id_only_in_the_extractors_reading_of_a_remark_counts() -> None:
    part = pair("Driller AS", (8,), [block(8, 1, "Br Drlr"), block(8, 2, "Kommentar ~~ illegible ~~")])
    part = _with_header(part, notes=("Hull nr 704", "p8.b2"))
    (item,) = reconcile([part], Tables(LISTED, frozenset({1})))
    assert item.group.label_raw == "704" and item.outcome.result.header.borehole_label.block_ids == ["p8.b2"]


def test_the_table_row_a_sheet_took_its_values_from_gives_its_id() -> None:
    group, out = pair("Driller AS", (9,), [block(9, 1, "Br Drlr")])
    out = replace(out, blocks={**out.blocks, **{b.id: b for b in TABLE}})
    part = _with_header((group, out), total_depth=("59,4", "p1.b13"))
    (item,) = reconcile([part], Tables(LISTED, frozenset({1})))
    assert item.group.label_raw == "703" and item.outcome.result.header.borehole_label.block_ids == ["p1.b10"]


def test_a_unique_depth_row_names_a_sheet_but_never_a_taken_or_shared_id() -> None:
    group, out = pair("Driller AS", (7,), [block(7, 1, "Br Drlr")])
    out = replace(out, blocks={**out.blocks, **{b.id: b for b in TABLE}})
    sheet = _with_header((group, out), total_depth=("43 m", "p7.b1"))
    (item,) = reconcile([sheet], Tables(LISTED, frozenset({1})))
    assert item.group.label_raw == "704"
    other = _with_header(pair("Other AS", (8,), [block(8, 1, "x")]), total_depth=("43", "p8.b1"))
    labels = sorted(
        i.group.label_raw or "" for i in reconcile([sheet, other], Tables(LISTED, frozenset({1})))
    )
    assert labels == ["Driller AS", "Other AS"]  # two sheets with the row's depth: neither takes its ID
    taken = pair("704", (5,), [block(5, 1, "Hull nr 704")])
    items = reconcile([taken, sheet], Tables(LISTED, frozenset({1})))
    assert sorted(i.group.label_raw or "" for i in items) == ["704", "Driller AS"]
