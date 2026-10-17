"""Fictional values only: SPT increments, printed N and refusals across standards (BACKEND.md 7.8)."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.normalize.numbers import load_data
from app.normalize.spt import parse_spt, schemes

# (family, blows_raw, n_raw, increment_note_raw, n_value, refusal, increments, computed_n, penetration_cm)
FULL_TESTS = [
    # ASTM D1586 / US logs: 3 x 6 in, separators "-", "/", spaces
    ("us", "5-7-9", None, None, 16, False, [5, 7, 9], 16, None),
    ("us", "5/7/9", None, None, 16, False, [5, 7, 9], 16, None),
    ("us", "5 7 9", None, None, 16, False, [5, 7, 9], 16, None),
    ("us", "6 8 10", None, "3 x 6 in", 18, False, [6, 8, 10], 18, None),
    # ISO 22476-3 / UK logs: 6 x 75 mm, seating drive before the slash
    ("uk", "2,3/4,5,6,7", None, None, 22, False, [2, 3, 4, 5, 6, 7], 22, None),
    ("uk", "2,3,4,5", None, "6 x 75 mm", 14, False, [2, 3, 4, 5], 14, None),
    ("uk", "1,2,3,4,5,6", "N=18", "75 mm increments", 18, False, [1, 2, 3, 4, 5, 6], 18, None),
    ("uk", "N=23 (2,3/5,6,6,6)", None, None, 23, False, [2, 3, 5, 6, 6, 6], 23, None),
    # Australian logs: increments with N printed after them
    ("au", "5,7,9 N=16", None, None, 16, False, [5, 7, 9], 16, None),
    ("au", "4, 6, 8", "N = 14", None, 14, False, [4, 6, 8], 14, None),
    # Brazilian NBR 6484 logs: blows per 15 cm pairs, last two count
    ("br", "5/15 7/15 9/15", None, None, 16, False, [5, 7, 9], 16, None),
    ("br", "3/15 4/15 6/15", None, "3 x 15 cm", 10, False, [3, 4, 6], 10, None),
    # German logs: N30 printed, or increments over 3 x 10 cm with the note
    ("de", "N30 = 23", None, None, 23, False, None, None, None),
    ("de", "4/6/9", None, "3 x 10 cm", 19, False, [4, 6, 9], 19, None),
    # Japanese logs: N over the 30 cm test drive printed as a pair with its unit
    ("jp", "23/30 cm", None, None, 23, False, None, None, None),
    # 2 x 300 mm scheme from the note
    ("2x300", "5/7", None, "2 x 300 mm", 7, False, [5, 7], 7, None),
    # printed N only
    ("n only", None, "N=12", None, 12, False, None, None, None),
    ("n only", None, "(31)", None, 31, False, None, None, None),
    ("n only", "17", None, None, 17, False, None, None, None),
]


def _check(result: object, expected: tuple[object, ...]) -> None:
    n_value, refusal, increments, computed_n, penetration_cm = expected
    assert result.n_value == n_value  # type: ignore[attr-defined]
    assert result.refusal == refusal  # type: ignore[attr-defined]
    assert result.increments == increments  # type: ignore[attr-defined]
    assert result.computed_n == computed_n  # type: ignore[attr-defined]
    if penetration_cm is None:
        assert result.penetration_cm is None  # type: ignore[attr-defined]
    else:
        assert result.penetration_cm == pytest.approx(penetration_cm)  # type: ignore[attr-defined]


@pytest.mark.parametrize("case", FULL_TESTS, ids=[f"{c[0]}:{c[1]}|{c[2]}|{c[3]}" for c in FULL_TESTS])
def test_complete_tests(case: tuple[object, ...]) -> None:
    family, blows, n_raw, note, *expected = case
    result = parse_spt(blows, n_raw, note)  # type: ignore[arg-type]
    _check(result, tuple(expected))
    assert result.reason is None, (family, result.reason)


REFUSALS = [
    # (family, blows_raw, n_raw, note, increments, penetration_cm)
    ("uk", "50/120", None, None, [50], 12.0),  # 120 cannot be cm: mm
    ("uk", "50/195", None, None, [50], 19.5),
    ("de", "50/12cm", None, None, [50], 12.0),
    ("de", "50 auf 12 cm", None, None, [50], 12.0),
    ("br", "27/12", None, None, [27], None),  # unit not printed and both readings fit: kept unknown
    ("br", "27/12", None, "3 x 15 cm", [27], 12.0),  # the note prints the document's unit
    ("br", "5/15 7/15 30/10", None, None, [5, 7, 30], 10.0),
    ("us", '25-50/4"', None, None, [25, 50], 10.16),
    ("us", "12, 20, 25 for 50 mm", None, None, [12, 20, 25], 5.0),
    ("uk", "4,6/8,12,30/45mm", None, None, [4, 6, 8, 12, 30], 4.5),
    ("au", "10, 25/100mm HB", None, None, [10, 25], 10.0),
    ("any", "R", None, None, None, None),
    ("any", "Ref.", None, None, None, None),
    ("any", "refusal", None, None, None, None),
    ("es", "rechazo", None, None, None, None),
    ("any", ">50", None, None, None, None),
    ("any", None, "50+", None, None, None),
    ("any", None, "R", None, None, None),
    ("any", "5/7/9", "R", None, [5, 7, 9], None),
    ("any", None, "50/120 mm", None, [50], 12.0),
]


@pytest.mark.parametrize("case", REFUSALS, ids=[f"{c[0]}:{c[1]}|{c[2]}|{c[3]}" for c in REFUSALS])
def test_refusals_have_no_n(case: tuple[object, ...]) -> None:
    _family, blows, n_raw, note, increments, penetration = case
    result = parse_spt(blows, n_raw, note)  # type: ignore[arg-type]
    assert result.refusal is True
    assert result.n_value is None
    assert result.increments == increments
    if penetration is None:
        assert result.penetration_cm is None
    else:
        assert result.penetration_cm == pytest.approx(penetration)


def test_unitless_penetration_that_fits_both_readings_is_named() -> None:
    result = parse_spt("27/12")
    assert result.reason is not None and "without a unit" in result.reason


def test_printed_n_is_kept_when_it_differs_from_the_increments() -> None:
    result = parse_spt("5/7/9 (18)")
    assert result.n_value == 18
    assert result.printed_n == 18
    assert result.computed_n == 16
    assert result.reason is not None and "differs" in result.reason

    result = parse_spt("5,7,9", "17")
    assert (result.n_value, result.printed_n, result.computed_n) == (17, 17, 16)


@pytest.mark.parametrize(
    ("blows", "n_raw", "note", "why"),
    [
        ("2,3,4,5", None, None, "scheme not stated"),
        ("23/30", None, None, "full test drive in cm or a refusal in mm"),
        ("xyz", None, None, "not understood"),
        ("N60=23", None, None, "not understood"),
        ("", None, None, "no SPT values"),
        (None, None, None, "no SPT values"),
        ("1,2,3,4,5", None, "6 x 75 mm", "do not fit"),
        ("5/7/9", None, "1 x 13 furlongs", "increment note"),
    ],
)
def test_undecided_records_say_why(blows: str | None, n_raw: str | None, note: str | None, why: str) -> None:
    result = parse_spt(blows, n_raw, note)
    assert result.n_value is None
    assert result.reason is not None and why in result.reason


def test_scheme_is_reported_in_mm() -> None:
    assert parse_spt("5/7/9").increment_mm == 150
    assert parse_spt("1,2,3,4,5,6").increment_mm == 75
    assert parse_spt("2,3,4,5").increment_mm is None


def test_schemes_data_is_consistent() -> None:
    data = load_data("spt_schemes.yaml")
    ids = {s.id for s in schemes()}
    assert len(ids) == len(schemes())
    for scheme in schemes():
        assert 0 <= scheme.seating < scheme.increments
        assert scheme.test_count * scheme.increment_mm == pytest.approx(data["test_drive_mm"])
    assert set(data["by_count"].values()) <= ids


# -------------------------------------------------------------------------------------------------
# Properties
# -------------------------------------------------------------------------------------------------


@settings(max_examples=200, deadline=None)
@given(
    increments=st.lists(st.integers(min_value=0, max_value=49), min_size=3, max_size=3),
    separator=st.sampled_from(["/", "-", " ", ", ", ","]),
)
def test_three_increments_sum_the_last_two(increments: list[int], separator: str) -> None:
    result = parse_spt(separator.join(str(i) for i in increments))
    assert result.increments == increments
    assert result.computed_n == increments[1] + increments[2]
    assert result.n_value == result.computed_n
    assert result.refusal is False


@settings(max_examples=200, deadline=None)
@given(
    increments=st.lists(st.integers(min_value=0, max_value=30), min_size=6, max_size=6),
    seating_mark=st.booleans(),
)
def test_six_increments_sum_the_last_four(increments: list[int], seating_mark: bool) -> None:
    text = ",".join(str(i) for i in increments)
    if seating_mark:
        first, second, *rest = (str(i) for i in increments)
        text = f"{first},{second}/{','.join(rest)}"
    result = parse_spt(text)
    assert result.computed_n == sum(increments[2:])
    assert result.n_value == sum(increments[2:])


@settings(max_examples=200, deadline=None)
@given(
    blows=st.integers(min_value=1, max_value=100),
    penetration_mm=st.integers(min_value=46, max_value=294),
)
def test_partial_penetration_in_mm_is_a_refusal(blows: int, penetration_mm: int) -> None:
    result = parse_spt(f"{blows}/{penetration_mm}mm")
    assert result.refusal is True
    assert result.n_value is None
    assert result.penetration_cm == pytest.approx(penetration_mm / 10)


@settings(max_examples=400, deadline=None)
@given(
    st.text(max_size=30),
    st.one_of(st.none(), st.text(max_size=10)),
    st.one_of(st.none(), st.text(max_size=15)),
)
def test_never_raises_and_refusal_never_has_n(blows: str, n_raw: str | None, note: str | None) -> None:
    result = parse_spt(blows, n_raw, note)
    if result.refusal:
        assert result.n_value is None
    if result.n_value is not None:
        assert result.refusal is False
        assert result.n_value >= 0
    if result.n_value is None and not result.refusal:
        assert result.reason


@settings(max_examples=200, deadline=None)
@given(st.text(alphabet="0123456789/-, NR=()>+mcin", max_size=25))
def test_parse_is_deterministic(text: str) -> None:
    assert parse_spt(text) == parse_spt(text)
