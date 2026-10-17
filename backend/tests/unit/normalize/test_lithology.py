"""Fictional values only: DIN 4023 codes from multilingual layer descriptions (BACKEND.md 7.8)."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.din import din_codes
from app.normalize.lithology import din_code_from_text, valid_din_code, vocabulary_codes
from app.normalize.numbers import load_data

DESCRIPTIONS = [
    # (family, description, language, code)
    # German logs (DIN 4022/EN ISO 14688 wording): the noun is the main component
    ("de", "Sand, kiesig", "de", "S"),
    ("de", "Kies, stark sandig, schwach schluffig", "de", "G"),
    ("de", "Feinsand, schwach schluffig", "de", "fS"),
    ("de", "Fein- bis Mittelsand", "de", "S"),
    ("de", "Grobkies", "de", "gG"),
    ("de", "Sand mit Kies", "de", "S"),
    ("de", "Ton, schluffig, mit Steinen", "de", "T"),
    ("de", "Auffüllung: Sand, kiesig", "de", "A"),
    ("de", "Sandstein, verwittert", "de", "Sst"),
    ("de compound", "Kalksandstein", "de", "Sst"),
    ("de compound", "Quarzsand", "de", "S"),
    ("de", "Klei, schluffig", "de", "Kl"),
    ("de", "Löss", "de", "Lö"),
    ("de", "Lösslehm", "de", "Löl"),
    ("de", "Mutterboden", "de", "Mu"),
    # English logs (BS 5930 capitals mark the main component)
    ("en", "gravelly SAND", "en", "S"),
    ("en", "Firm brown sandy CLAY with occasional gravel", "en", "T"),
    ("en", "Medium dense brown fine SAND", "en", "fS"),
    ("en", "medium dense SAND", "en", "S"),
    ("en", "fine to medium SAND", "en", "S"),
    ("en", "SAND, medium dense", "en", "S"),
    ("en", "Gravel, fine to coarse, sandy", "en", "G"),
    ("en", "MADE GROUND: sandy gravel with brick", "en", "A"),
    ("en", "Topsoil", "en", "Mu"),
    ("en", "Completely weathered GRANITE", "en", "Pl"),
    ("en", "Mudstone", "en", "Tst"),
    ("en", "Loess", "en", "Lö"),
    ("en", "A sandy CLAY", "en", "T"),
    # French, Spanish, Portuguese, Italian logs: noun first, adjectives after
    ("fr", "sable fin argileux", "fr", "fS"),
    ("fr", "Argile sableuse", "fr", "T"),
    ("fr", "Grès fin", "fr", "Sst"),
    ("fr", "Remblai", "fr", "A"),
    ("es", "Arena limosa con gravas", "es", "S"),
    ("es", "Arcilla arenosa", "es", "T"),
    ("pt", "Argila siltosa", "pt", "T"),
    ("pt", "Areia fina a média", "pt", "S"),
    ("pt-BR", "Silte argiloso", "pt-BR", "U"),
    ("it", "Sabbia limosa", "it", "S"),
    ("it", "Ghiaia con sabbia", "it", "G"),
    # Dutch and Nordic logs
    ("nl", "Zand, matig siltig", "nl", "S"),
    ("nl", "klei, zwak zandig", "nl", "T"),
    ("nb", "Leire, siltig", "nb", "T"),
    ("sv", "Lera, sandig", "sv", "T"),
    ("da", "Ler, sandet", "da", "T"),
    # language not given: only unambiguous terms
    ("unknown language", "Kies, sandig", None, "G"),
    ("unknown language", "clayey SILT", None, "U"),
    # DIN notation printed instead of words
    ("notation", "G, s, u'", None, "G"),
    ("notation", "mS, fs, u*", None, "mS"),
    ("notation", "Lö", None, "Lö"),
]


@pytest.mark.parametrize("case", DESCRIPTIONS, ids=[f"{c[0]}:{c[1]}" for c in DESCRIPTIONS])
def test_main_component(case: tuple[str, str, str | None, str]) -> None:
    _family, description, language, code = case
    assert din_code_from_text(description, language) == code


UNSURE = [
    ("SAND and GRAVEL", "en"),  # co-equal main components: no first-named guess
    ("Sand und Kies", "de"),
    ("Sand, Kies", "de"),
    ("Silt/clay", "en"),
    ("Clay; gravel at base", "en"),
    ("klei", None),  # clay in Dutch, marine clay in German
    ("Quarzsand", None),  # compounds are split only when the language is known
    ("Brown, moist, stiff", "en"),
    ("Kernverlust", "de"),
    ("thousand", None),
    ("", "en"),
    (None, None),
]


@pytest.mark.parametrize(("description", "language"), UNSURE)
def test_no_default_lithology(description: str | None, language: str | None) -> None:
    assert din_code_from_text(description, language) is None


def test_valid_din_code_is_exact_and_case_sensitive() -> None:
    assert valid_din_code("mG") == "mG"
    assert valid_din_code("Mg") == "Mg"
    assert valid_din_code("MG") is None
    assert valid_din_code("s") is None
    assert valid_din_code(" Sst ") == "Sst"
    assert valid_din_code("Lö") == "Lö"
    assert valid_din_code("Lo\u0308") == "Lö"  # decomposed umlaut
    assert valid_din_code("LÖ") is None
    assert valid_din_code("Loe") is None
    assert valid_din_code(None) is None
    assert valid_din_code("") is None


def test_every_din_key_is_valid() -> None:
    for key in din_codes():
        assert valid_din_code(key) == key


def test_vocabulary_codes_are_din_keys() -> None:
    data = load_data("din_vocabulary.yaml")
    keys = set(din_codes())
    assert set(data["terms"]) <= keys
    assert vocabulary_codes() <= keys
    for base, fractions in data["fractions"].items():
        assert base in keys
        assert set(fractions.values()) <= keys


def test_vocabulary_covers_main_soils_and_rocks_in_ten_languages() -> None:
    terms = load_data("din_vocabulary.yaml")["terms"]
    for code in ("S", "G", "U", "T", "H", "A", "Mu", "Sst", "Kst", "Pl"):
        assert len(terms[code]) >= 6, code
    languages = {language for by_language in terms.values() for language in by_language}
    assert {"de", "en", "fr", "es", "pt", "nl", "no", "sv", "da", "it"} <= languages


# -------------------------------------------------------------------------------------------------
# Properties
# -------------------------------------------------------------------------------------------------

_TERMS = [
    (str(code), str(language), str(term))
    for code, by_language in load_data("din_vocabulary.yaml")["terms"].items()
    for language, terms in by_language.items()
    for term in terms
]


@settings(max_examples=300, deadline=None)
@given(st.sampled_from(_TERMS), st.sampled_from(["{t}", "{T}", "{t}, sandy", "grey {T}, moist"]))
def test_every_listed_noun_gives_its_code(entry: tuple[str, str, str], form: str) -> None:
    # (a colour word that is part of no term: "brown COAL" is the listed term "brown coal", lignite)
    code, language, term = entry
    text = form.format(t=term, T=term.upper())
    assert din_code_from_text(text, language) == code, (text, language)


@settings(max_examples=500, deadline=None)
@given(st.one_of(st.none(), st.text(max_size=60)), st.sampled_from([None, "de", "en", "fr", "pt-BR", "xx"]))
def test_result_is_none_or_a_din_key(text: str | None, language: str | None) -> None:
    code = din_code_from_text(text, language)
    assert code is None or code in din_codes()


@settings(max_examples=200, deadline=None)
@given(st.sampled_from(_TERMS), st.sampled_from(_TERMS))
def test_two_different_main_nouns_give_no_code(
    first: tuple[str, str, str], second: tuple[str, str, str]
) -> None:
    base = {"fS": "S", "mS": "S", "gS": "S", "fG": "G", "mG": "G", "gG": "G", "gU": "U"}
    if first[1] != second[1] or base.get(first[0], first[0]) == base.get(second[0], second[0]):
        return
    if {first[0], second[0]} & {"A", "Mu"}:
        return  # fill and topsoil win over the soil they consist of
    text = f"{first[2].upper()} and {second[2].upper()}"
    assert din_code_from_text(f"grey {text}", first[1]) is None, text
