"""Archive stamps never name a borehole, and a further sheet whose header names its borehole with more text
joins it (app.pipeline.group, app.pipeline.identity). Fictional labels, stamps, file names and pages."""

from __future__ import annotations

from app.pipeline.group import PageInfo, file_numbers, label_ids, plan_page_groups, stamp_label
from app.pipeline.identity import Tables, reconcile
from tests.test_identity import pair

FILE = "ARCH_1234_00844_SV_1.pdf"


def first_sheet(*labels: str, text: str = "") -> PageInfo:
    return PageInfo(n=1, role="log_sheet", labels=labels, text=text)


def further_sheet(label: str, n: int = 2) -> PageInfo:
    return PageInfo(
        n=n,
        role="log_continuation",
        labels=(label,),
        sheet_label=f"Blatt {n}",
        sheet_index=n,
        is_continuation=True,
    )


def test_an_archive_stamp_and_an_address_header_make_one_borehole() -> None:
    """Sheet 1 names the borehole and carries the file's archive number; sheet 2's header names the borehole
    with its address."""
    pages = [first_sheet("Bohrung Nr. 7", "844"), further_sheet("Nr. 7 Musterstadt, Beispielweg 12")]
    (group,) = plan_page_groups(pages, file_name=FILE)
    assert (group.label_canonical, group.pages, group.uncertain) == ("7", (1, 2), ())


def test_stamp_numbers_are_found_by_their_word_the_page_text_or_the_file_name() -> None:
    numbers = file_numbers(FILE)
    assert numbers == {1234, 844}
    assert stamp_label("Archiv 1234/844") and stamp_label("Registratur 55")
    assert stamp_label("844", "", numbers)  # a number of the file name
    assert stamp_label("312", "Landesamt Archiv Nr. 312 / 1961")  # follows a stamp word on the page
    assert not stamp_label("312", "Bohrung 312") and not stamp_label("7", "", numbers)
    for labels in (("Bohrung Nr. 7", "Archiv 1234/844"), ("Bohrung Nr. 7", "312")):
        groups = plan_page_groups([first_sheet(*labels, text="Archiv Nr. 312")], file_name=None)
        assert [g.label_canonical for g in groups] == ["7"], labels


def test_a_stamp_alone_or_two_real_boreholes_on_one_sheet_stay_as_they_are() -> None:
    (alone,) = plan_page_groups([first_sheet("844")], file_name=FILE)
    assert alone.label_canonical == "844"  # the only label of the page: kept
    two = plan_page_groups([first_sheet("B 1", "B 2")], file_name=FILE)
    assert sorted(g.label_canonical for g in two) == ["B1", "B2"]


def test_a_further_sheet_joins_the_one_borehole_its_header_names() -> None:
    assert {"2", "BLATT2ZUBOHRUNGNR.2"} == label_ids("Blatt 2 zu Bohrung Nr. 2")
    pages = [
        PageInfo(n=1, role="log_sheet", labels=("B 1",)),
        PageInfo(n=2, role="log_sheet", labels=("B 2",)),
        further_sheet("Blatt 2 zu Bohrung B 1, Musterstadt", n=3),
    ]
    groups = {g.label_canonical: g.pages for g in plan_page_groups(pages)}
    assert groups == {"B1": (1, 3), "B2": (2,)}
    # a header naming a borehole no earlier sheet has: a new borehole, missing its first sheet
    other = plan_page_groups(
        [PageInfo(n=1, role="log_sheet", labels=("B 1",)), further_sheet("Nr. 9 Musterstadt")]
    )
    assert len(other) == 2 and "missing first sheet" in other[1].uncertain


def test_a_stamp_part_on_a_named_borehole_page_merges_into_it() -> None:
    """Fallback: when grouping kept the stamp apart, the parts that share its page are one borehole."""
    rows = [("0,00", "1,50", "Sand"), ("1,50", "4,00", "Ton")]
    named = pair("2", (1,), [], rows)
    stamp = pair("844", (1,), [], rows)
    (item,) = reconcile([named, stamp], Tables({}, frozenset(), frozenset({"844"})))
    assert item.group.label_raw == "2" and item.aliases == ["844"]
