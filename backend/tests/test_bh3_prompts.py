"""bh3's header rules match the classic extractor's (data/prompts/extractor.txt): drilling dates only from a
drilling-date field, the contractor never from a stamp, only a printed final depth, coordinate prefix digits
in the value, names copied as printed and never an archive stamp. Prompt text only; no model is called."""

from __future__ import annotations

import os

import pytest

from app.bh3 import llm, prompts, schemas

VISION_HEADER_RULES = (
    "copied character by character",
    "is not the BoreholeName when such a field is printed",
    "prefix digits never go to CoordinateSystem",
    "only from a printed drilling-company field",
    "never an archive",
    "names the drilling or boring date or period",
    "'Bohrzeit'",
    "'Bearbeiter'",
    "'Geolog. Aufnahme'",
    "are never drilling dates",
    "roman-numeral month",
    "only a printed total / final depth",
    "'Endteufe'",
    "never the deepest number of a depth scale or the last base on one sheet",
)


@pytest.mark.parametrize("rule", VISION_HEADER_RULES)
def test_the_header_prompt_states_the_rule(rule: str) -> None:
    assert rule in prompts.SYSTEM_HEADER


def test_the_tile_prompt_never_takes_a_sheet_bottom_or_a_stamp() -> None:
    for prompt in (prompts.SYSTEM_TILE_LOG, prompts.SYSTEM_TILE_LOG_SYMBOLS):
        assert "never the last boundary of this image or of the sheet" in prompt
        assert "nor an archive, registry or file number stamped on the page" in prompt


def test_the_text_header_prompt_and_the_field_descriptions_carry_the_rules() -> None:
    for rule in ("drilling or boring date or period", "Bearbeiter", "drilling-company field", "Endteufe"):
        assert rule in llm.SYSTEM_HEADER, rule
    described = schemas.HEADER_SCHEMA["properties"]
    for field in ("BoreholeName", "StartDate", "EndDate", "Contractor", "BoreholeDepth", "CoordinateSystem"):
        assert described[field].get("description"), field
    assert described["LocationName"].get("description") is None  # unchanged fields stay bare


@pytest.mark.skipif(
    "BH_PROMPT_VERSION" in os.environ, reason="the version is overridden to replay stored answers"
)
def test_the_prompt_version_in_every_cache_key_was_bumped() -> None:
    assert schemas.PROMPT_VERSION == "6"
