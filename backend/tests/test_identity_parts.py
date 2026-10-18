"""Parts of one borehole read under different labels in one document are merged (app.pipeline.identity
`_merge_across`); the document's own identifier never names a borehole. Fictional labels, depths and pages."""

from __future__ import annotations

from dataclasses import replace
from itertools import pairwise
from typing import Any

from app.pipeline.identity import Tables, document_identifiers, reconcile
from app.pipeline.schemas import RawCoordinates, RawValue
from app.pipeline.types import ExtractionOutcome, PageGroup
from tests.test_identity import _with_header, block, pair

STAMP = "8016/924"  # a fictional archive number stamped on every page
DOCUMENT = Tables({}, frozenset(), frozenset({STAMP}))
Part = tuple[PageGroup, ExtractionOutcome]


def layers(*bounds: str) -> list[tuple[str, str, str]]:
    return [(top, bottom, f"fictional stratum {i}") for i, (top, bottom) in enumerate(pairwise(bounds))]


def part(label: str, pages: tuple[int, ...], rows: Any, *, total: str | None = None) -> Part:
    p = pair(label, pages, [block(pages[0], 1, label)], rows)
    return _with_header(p, total_depth=(total, f"p{pages[0]}.b1")) if total is not None else p


def at(p: Part, x: str, y: str) -> Part:
    group, out = p
    coords = RawCoordinates(
        x_raw=RawValue(raw=x, block_ids=[], state="ok"),
        y_raw=RawValue(raw=y, block_ids=[], state="ok"),
        labels_raw=RawValue(raw=None, block_ids=[], state="not_in_source"),
        system_raw=RawValue(raw=None, block_ids=[], state="not_in_source"),
    )
    header = out.result.header.model_copy(update={"coordinates": coords})
    return group, replace(out, result=out.result.model_copy(update={"header": header}))


def depths(item: Any) -> list[tuple[str | None, str | None]]:
    return [(layer.from_raw.raw, layer.to_raw.raw) for layer in item.outcome.result.layers]


def test_a_stamp_read_as_a_name_merges_into_the_named_borehole() -> None:
    """The archive number on every page made its own group beside the borehole's name on the first sheet."""
    named = part("Bohrung 2", (1,), layers("0,00", "4,00", "9,00"), total="25,00")
    stamp = part(STAMP, (1, 2), layers("0,00", "4,00", "9,00", "12,50", "16,00", "19,00", "22,00", "25,00"))
    (item,) = reconcile([named, stamp], DOCUMENT)
    assert item.group.label_raw == "Bohrung 2" and item.aliases == [STAMP]
    assert item.group.pages == (1, 2)
    assert len(item.outcome.result.layers) == 7  # the stamp part is the base; nothing doubled
    assert item.outcome.result.header.total_depth.raw == "25,00"  # filled from the named part
    assert item.outcome.result.header.borehole_label.raw == "Bohrung 2"


def test_two_renditions_of_one_log_are_one_borehole() -> None:
    """The handwritten form and its typed transcription: from the top to the same depth, same boundaries."""
    form = part("B 1 F", (1,), layers("0,00", "1,20", "3,50", "7,00", "12,00"), total="12,0")
    typed = part("Bohrung 1", (2,), layers("0.00", "1.20", "3.50", "7.00", "12.00"), total="12.00")
    (item,) = reconcile([form, typed], {})
    assert len(item.outcome.result.layers) == 4 and item.group.pages == (1, 2)
    assert item.group.label_raw == "B 1 F" and item.aliases == ["Bohrung 1"]


def test_a_misread_name_on_a_further_sheet_continues_the_log() -> None:
    first = part("B2", (1,), layers("0,00", "1,00", "2,50", "4,00"))
    further = part("Br. F", (2,), layers("4,00", "6,00", "9,00"))
    (item,) = reconcile([first, further], {})
    assert depths(item) == [
        ("0,00", "1,00"),
        ("1,00", "2,50"),
        ("2,50", "4,00"),
        ("4,00", "6,00"),
        ("6,00", "9,00"),
    ]


def test_a_part_without_depths_joins_the_only_borehole() -> None:
    header_only = part(STAMP, (1,), [])
    named = part("Bohrung Nr. 3", (2, 3), layers("0,00", "2,00", "5,00", "8,00"))
    (item,) = reconcile([header_only, named], DOCUMENT)
    assert item.group.label_raw == "Bohrung Nr. 3" and item.aliases == [STAMP]
    assert item.group.pages == (1, 2, 3)


def test_boreholes_from_the_top_to_different_depths_stay_apart() -> None:
    b1 = part("B1", (1,), layers("0,00", "2,00", "4,00", "10,00"), total="10,00")
    b2 = part("B2", (2,), layers("0,00", "3,00", "8,00", "15,00"), total="15,00")
    assert len(reconcile([b1, b2], {})) == 2
    # without printed total depths: two full logs from the top to different depths
    assert (
        len(
            reconcile(
                [
                    part("B1", (1,), layers("0", "2", "4", "10")),
                    part("B2", (2,), layers("0", "3", "8", "15")),
                ],
                {},
            )
        )
        == 2
    )


def test_boreholes_at_different_positions_stay_apart() -> None:
    b1 = at(part("B1", (1,), layers("0,00", "2,00", "4,00")), "3422925", "5370335")
    b2 = at(part("B2", (2,), layers("4,00", "6,00")), "3423100", "5370400")
    assert len(reconcile([b1, b2], {})) == 2
    same = at(part("B2", (2,), layers("4,00", "6,00")), "3422925", "5370335")
    assert len(reconcile([b1, same], {})) == 1


def test_two_logs_over_the_same_depths_with_other_boundaries_stay_apart() -> None:
    """Two boreholes of a site drilled to the same depth: their strata differ."""
    b1 = part("B1", (1,), layers("0,00", "0,50", "2,30", "6,10", "10,00"), total="10,00")
    b2 = part("B2", (2,), layers("0,00", "1,40", "3,80", "7,70", "10,00"), total="10,00")
    assert len(reconcile([b1, b2], {})) == 2


def test_two_listed_ids_or_a_second_borehole_are_never_merged() -> None:
    listed = Tables({"701": "701", "702": "702"}, frozenset())
    a = part("701", (1,), layers("0,00", "1,00", "4,00"))
    b = part("702", (2,), layers("4,00", "6,00"))
    assert len(reconcile([a, b], listed)) == 2
    # a part without depths is not attached when the document has two boreholes with depths
    b1 = part("B1", (1,), layers("0,00", "2,00", "4,00", "10,00"), total="10,00")
    b2 = part("B2", (2,), layers("0,00", "3,00", "8,00", "15,00"), total="15,00")
    assert len(reconcile([b1, b2, part(STAMP, (3,), [])], DOCUMENT)) == 3


def test_document_identifiers_are_labels_on_every_page_beside_other_names() -> None:
    assert document_identifiers([["BO 8016/924"], ["BO 8016/924", "Bohrung 2"], ["BO 8016/924"]]) == {
        "BO8016/924"
    }
    assert document_identifiers([["BH-1"], ["BH-1"]]) == frozenset()  # the only name: the borehole's
    assert document_identifiers([["BO 8016/924", "Bohrung 2"]]) == frozenset()  # one page tells nothing
    assert document_identifiers([["A"], ["B"]]) == frozenset()


def test_an_id_read_one_character_wrong_takes_the_one_free_listed_id() -> None:
    listed = Tables({"701": "701", "702": "702", "702B": "702b", "705": "705"}, frozenset())
    parts = [
        part("701", (1,), layers("0,00", "2,00", "5,00")),
        part("702", (2,), layers("0,00", "3,00", "6,00")),
        part("Hull nr 7024", (3,), layers("0,00", "1,00", "4,00")),  # "702b" with the b read as 4
    ]
    labels = sorted(i.group.label_raw or "" for i in reconcile(parts, listed))
    assert labels == ["701", "702", "702b"]
    named = next(i for i in reconcile(parts, listed) if i.group.label_raw == "702b")
    assert named.aliases == ["Hull nr 7024"]
    # two readings one character from the same free ID: neither takes it
    twins = [*parts[:2], part("7024", (3,), layers("0", "1", "4")), part("702c", (4,), layers("0", "2", "5"))]
    assert "702b" not in {i.group.label_raw for i in reconcile(twins, listed)}


def test_a_misread_borehole_word_and_number_sign_still_lets_the_id_be_repaired() -> None:
    listed = Tables({"701": "701", "702": "702", "702B": "702b", "705": "705"}, frozenset())
    parts = [
        part("701", (1,), layers("0,00", "2,00", "5,00")),
        part("702", (2,), layers("0,00", "3,00", "6,00")),
        part("Holl m 7026", (3,), layers("0,00", "1,00", "4,00")),  # "Hull nr 702b" misread throughout
    ]
    labels = sorted(i.group.label_raw or "" for i in reconcile(parts, listed))
    assert labels == ["701", "702", "702b"]
    # a short number is not repaired by one character ("Bohrung 7" never becomes 17)
    short = Tables({"16": "16", "17": "17", "18": "18"}, frozenset())
    shorts = [part("16", (1,), layers("0", "2", "5")), part("Bohrung 7", (2,), layers("0", "1", "4"))]
    assert "17" not in {i.group.label_raw for i in reconcile(shorts, short)}
