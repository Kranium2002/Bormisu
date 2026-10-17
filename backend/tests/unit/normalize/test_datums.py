"""Fictional values only: depth origin and sign convention from printed notes (BACKEND.md 7.8)."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.normalize.datums import parse_depth_origin
from app.normalize.numbers import load_data

ORIGINS = [
    # (family, note, datum, origin, negative_down)
    ("en onshore", "All depths in metres below ground level.", None, "ground", None),
    ("en abbreviation", "Depths in m bgl", None, "ground", None),
    ("en offshore", "Depth below seabed (mbsf)", None, "seabed", None),
    ("en offshore mudline", "Penetration below mudline", None, "mudline", None),
    ("en tidal", "Depths relative to LAT", None, "relative", None),
    ("en sign", "Negative values denote depth below seabed", None, "seabed", True),
    ("en sign positive", "Depths below ground, positive downwards", None, "ground", False),
    ("de", "Tiefen in m u. GOK", None, "ground", None),
    ("de sign", "Tiefen unter Gelände, negative Werte bezeichnen die Tiefe", None, "ground", True),
    ("de relative", "Höhen bezogen auf NHN", None, "relative", None),
    ("fr", "Profondeurs par rapport au terrain naturel", None, "ground", None),
    ("fr relative", "Cotes par rapport au NGF", None, "relative", None),
    ("es", "Valores negativos indican profundidad bajo el nivel del terreno", None, "ground", True),
    ("pt", "Profundidades em relação ao nível do mar", None, "relative", None),
    ("nl", "Diepte in m-mv", None, "ground", None),
    ("it", "Profondità dal piano campagna", None, "ground", None),
    ("no", "Dybde under terreng", None, "ground", None),
    ("datum field only", None, "m below seabed", "seabed", None),
]


@pytest.mark.parametrize("case", ORIGINS, ids=[c[0] for c in ORIGINS])
def test_depth_origins(case: tuple[str, str | None, str | None, str, bool | None]) -> None:
    _family, note, datum, origin, negative = case
    result = parse_depth_origin(note, datum)
    assert result.origin == origin
    assert result.negative_down is negative
    assert result.reason is None


@pytest.mark.parametrize(
    ("note", "why"),
    [
        (None, "no depth note"),
        ("", "no depth note"),
        ("Elevation in m AHD", "no depth origin"),
        ("below ground level and below seabed", "more than one depth origin"),
        ("negative downwards; positive downwards", "both sign conventions"),
    ],
)
def test_undecided_notes_say_why(note: str | None, why: str) -> None:
    result = parse_depth_origin(note)
    assert result.reason is not None and why in result.reason


def test_vocabulary_lists_every_origin() -> None:
    origins = load_data("units.yaml")["depth_origins"]
    assert set(origins) == {"ground", "mudline", "seabed", "relative"}


# -------------------------------------------------------------------------------------------------
# Properties
# -------------------------------------------------------------------------------------------------

_PHRASES = [
    (origin, phrase)
    for origin, phrases in load_data("units.yaml")["depth_origins"].items()
    for phrase in phrases
]
_SPECIFIC = [(o, p) for o, p in _PHRASES if o != "relative"]


@settings(max_examples=200, deadline=None)
@given(
    entry=st.sampled_from(_SPECIFIC),
    before=st.sampled_from(["", "Depth ", "Note: depths are ", "Tiefe "]),
    after=st.sampled_from(["", ".", " (m)", "; see legend"]),
)
def test_each_listed_phrase_is_found_in_context(entry: tuple[str, str], before: str, after: str) -> None:
    origin, phrase = entry
    result = parse_depth_origin(f"{before}{phrase.upper()}{after}")
    assert result.origin == origin, phrase


@settings(max_examples=300, deadline=None)
@given(st.one_of(st.none(), st.text(max_size=60)), st.one_of(st.none(), st.text(max_size=20)))
def test_never_raises(note: str | None, datum: str | None) -> None:
    result = parse_depth_origin(note, datum)
    assert result.origin in (None, "ground", "mudline", "seabed", "relative")
    if result.origin is None:
        assert result.reason
