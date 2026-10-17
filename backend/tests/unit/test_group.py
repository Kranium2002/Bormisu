"""Page grouping (BACKEND.md 7.5) on FICTIONAL page sequences from several document families."""

from __future__ import annotations

import random

import pytest

from app.pipeline.group import (
    MISSING_FIRST_SHEET,
    NO_LABEL,
    PageInfo,
    group_key,
    plan_page_groups,
    sheet_numbers,
)
from app.pipeline.types import PageGroup


def log(n: int, *labels: str, **fields: object) -> PageInfo:
    return PageInfo(n=n, role="log_sheet", labels=labels, **fields)  # type: ignore[arg-type]


def cont(n: int, *labels: str, **fields: object) -> PageInfo:
    return PageInfo(n=n, role="log_continuation", labels=labels, **fields)  # type: ignore[arg-type]


def page(n: int, role: str, **fields: object) -> PageInfo:
    return PageInfo(n=n, role=role, **fields)  # type: ignore[arg-type]


def summary(groups: list[PageGroup]) -> list[tuple[str | None, tuple[int, ...]]]:
    return [(g.label_canonical, g.pages) for g in groups]


def test_multi_sheet_logs_with_sheet_n_of_m() -> None:
    pages = [
        page(1, "cover_or_toc", used=False),
        page(2, "summary_table"),
        log(3, "BH-01", sheet_label="SHEET 1 OF 3", sheet_index=1, sheet_total=3),
        cont(4, "BH-01", sheet_label="SHEET 2 OF 3", sheet_index=2, sheet_total=3),
        cont(5, "BH 1", sheet_label="SHEET 3 OF 3", sheet_index=3, sheet_total=3),
        log(6, "BH-02", sheet_label="SHEET 1 OF 2", sheet_index=1, sheet_total=2),
        cont(7, sheet_label="SHEET 2 OF 2", sheet_index=2, sheet_total=2),  # no label printed
        page(8, "legend_or_key"),
        page(9, "duplicate", used=False),
        page(10, "narrative", used=False),
    ]
    groups = plan_page_groups(pages)
    assert summary(groups) == [("BH1", (3, 4, 5)), ("BH2", (6, 7))]
    assert [g.key for g in groups] == ["BH1:p3-p5", "BH2:p6-p7"]
    assert [g.label_raw for g in groups] == ["BH-01", "BH-02"]
    assert all(g.context_pages == (2, 8) for g in groups)
    assert all(g.uncertain == () for g in groups)


def test_one_sheet_with_several_holes_makes_one_group_per_label() -> None:
    pages = [
        log(1, "TP-01", "TP-02", "TP-03", sheet_index=1, sheet_total=2),
        cont(2, "TP-01", "TP-02", "TP-03", sheet_index=2, sheet_total=2),
        page(3, "coordinate_table"),
        log(4, "TP-04"),
        cont(5),  # unlabelled continuation of TP-04
    ]
    groups = plan_page_groups(pages)
    assert summary(groups) == [("TP1", (1, 2)), ("TP2", (1, 2)), ("TP3", (1, 2)), ("TP4", (4, 5))]
    assert len({g.key for g in groups}) == 4
    assert all(g.context_pages == (3,) and g.uncertain == () for g in groups)


def test_unlabelled_continuation_sheets_join_the_open_group() -> None:
    pages = [
        log(1, "B-7"),
        cont(2),
        log(3, is_continuation=True),  # classifier says log_sheet but also that it continues a log
        log(4, "B-8"),
        cont(5),
    ]
    groups = plan_page_groups(pages)
    assert summary(groups) == [("B7", (1, 2, 3)), ("B8", (4, 5))]
    assert all(g.uncertain == () for g in groups)


def test_multi_hole_continuation_without_labels_joins_every_open_hole() -> None:
    groups = plan_page_groups([log(1, "P1", "P2"), cont(2)])
    assert summary(groups) == [("P1", (1, 2)), ("P2", (1, 2))]


def test_german_blatt_style_sheet_labels_are_read_without_a_sheet_index() -> None:
    pages = [
        log(1, "BK 12", sheet_label="Blatt 1/3"),
        cont(2, sheet_label="Blatt 2/3"),
        cont(3, sheet_label="Blatt 3/3"),
        log(4, sheet_label="Blatt 1/2"),  # a new hole whose label the classifier could not read
        cont(5, "BK13", sheet_label="Blatt 2/2"),  # ... printed on its second sheet
    ]
    groups = plan_page_groups(pages)
    assert summary(groups) == [("BK12", (1, 2, 3)), ("BK13", (4, 5))]
    assert groups[0].uncertain == ()
    assert groups[1].label_raw == "BK13"
    assert NO_LABEL not in groups[1].uncertain
    assert groups[1].uncertain == ("label BK13 printed only from page 5 on",)
    assert groups[1].key == "BK13:p4-p5"


def test_continuation_without_an_open_group_is_missing_its_first_sheet() -> None:
    groups = plan_page_groups([page(1, "summary_table"), cont(2, "BH-9", sheet_index=2, sheet_total=2)])
    assert summary(groups) == [("BH9", (2,))]
    assert groups[0].uncertain == (MISSING_FIRST_SHEET,)
    unlabelled = plan_page_groups([cont(4)])
    assert summary(unlabelled) == [(None, (4,))]
    assert unlabelled[0].uncertain == (NO_LABEL, MISSING_FIRST_SHEET)
    assert unlabelled[0].key == "nolabel:p4"


def test_conflicting_labels_still_group_with_reasons() -> None:
    pages = [
        log(1, "BH-1", sheet_label="SHEET 1 OF 3", sheet_index=1, sheet_total=3),
        cont(2, "BH-2", sheet_label="SHEET 2 OF 3", sheet_index=2, sheet_total=3),
        log(3, "BH-1", sheet_label="SHEET 1 OF 1", sheet_index=1, sheet_total=1),
    ]
    groups = plan_page_groups(pages)
    assert summary(groups) == [("BH1", (1,)), ("BH2", (2,)), ("BH1", (3,))]
    first, second, third = groups
    repeated = "label BH-1 appears in more than one log of this document"
    assert first.uncertain == (repeated, "sheets 2-3 of 3 not found")
    assert second.uncertain == (
        MISSING_FIRST_SHEET,
        "label conflict: page 2 numbers on from BH-1 but names BH-2",
        "sheets 3 of 3 not found",
    )
    assert third.uncertain == (repeated,)
    assert len({g.key for g in groups}) == 3


def test_log_sheet_without_a_label_still_groups() -> None:
    groups = plan_page_groups([log(1), log(2)])
    assert summary(groups) == [(None, (1, 2))]
    assert groups[0].uncertain == (NO_LABEL, "page 2 has no borehole label; read as a further sheet")
    restart = plan_page_groups([log(1, "A"), log(2, sheet_index=1)])
    assert summary(restart) == [("A", (1,)), (None, (2,))]
    assert restart[1].uncertain == (NO_LABEL,)


def test_sheet_one_restarts_a_group_with_the_same_label() -> None:
    groups = plan_page_groups([log(1, "S1", sheet_index=1), log(2, "S1", sheet_index=1)])
    assert summary(groups) == [("S1", (1,)), ("S1", (2,))]
    assert groups[0].key != groups[1].key


def test_unused_duplicate_and_non_log_pages_are_not_grouped() -> None:
    pages = [
        page(1, "duplicate", labels=("X-1",)),
        log(2, "X-2", used=False),
        page(3, "narrative", labels=("X-3",)),  # mentions a hole but carries no log
        page(4, "location_plan", has_coordinates=True),  # prints hole coordinates: context
        page(5, "lab_results"),
        log(6, "X-6"),
    ]
    groups = plan_page_groups(pages)
    assert summary(groups) == [("X6", (6,))]
    assert groups[0].context_pages == (4, 5)
    assert plan_page_groups([page(1, "summary_table"), page(2, "blank", used=False)]) == []


def test_groups_and_keys_do_not_depend_on_input_order() -> None:
    pages = [
        log(1, "A-1", sheet_index=1, sheet_total=2),
        cont(2, "A-1", sheet_index=2, sheet_total=2),
        log(3, "A-2"),
        log(4, "A-3", "A-4"),
        page(5, "summary_table"),
    ]
    expected = plan_page_groups(pages)
    shuffled = pages[:]
    random.Random(7).shuffle(shuffled)
    assert plan_page_groups(shuffled) == expected
    assert [g.key for g in expected] == ["A1:p1-p2", "A2:p3", "A3:p4", "A4:p4"]


def test_group_key_ranges_and_hash_for_long_page_lists() -> None:
    assert group_key("BH1", [5, 3, 4, 9]) == "BH1:p3-p5,p9"
    assert group_key(None, [2]) == "nolabel:p2"
    many = list(range(1, 200, 2))
    key = group_key("BH1", many)
    assert key.startswith("BH1:h") and len(key) < 40
    assert key == group_key("BH1", list(reversed(many)))
    assert key != group_key("BH1", many[:-1])


@pytest.mark.parametrize(
    ("sheet_label", "index", "total", "expected"),
    [
        ("SHEET 2 OF 3", None, None, (2, 3)),
        ("Blatt 2/3", None, None, (2, 3)),
        ("Hoja 2 de 3", None, None, (2, 3)),
        ("Folha 1 (2)", None, None, (1, 2)),
        ("Sheet 4", None, None, (4, None)),
        ("3/2", None, None, (None, None)),
        ("SHEET 2 OF 3", 5, 7, (5, 7)),  # the classifier's numbers win
        (None, 2, 900, (2, None)),  # a sheet total that cannot be a sheet count is ignored
        (None, 0, None, (None, None)),
    ],
)
def test_sheet_numbers(
    sheet_label: str | None, index: int | None, total: int | None, expected: tuple[int | None, int | None]
) -> None:
    info = PageInfo(n=1, role="log_sheet", sheet_label=sheet_label, sheet_index=index, sheet_total=total)
    assert sheet_numbers(info) == expected
