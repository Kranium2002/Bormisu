"""A part of a borehole read only on a retry (its page was unread the first time) joins the borehole the
first run stored. Fictional labels; every stage call is replaced, no database or provider."""

from __future__ import annotations

from typing import Any

import pytest

from app.pipeline import bh3_adapter, identity, orchestrator
from app.pipeline import extract as extract_module
from app.pipeline import finalize as finalize_module
from app.pipeline import group as group_module
from app.pipeline.types import ExtractionOutcome, PageGroup
from tests.test_identity import block, pair

LOG = pair("HX-4", (2,), [block(2, 1, "HX-4")], [("0.0", "4.0", "Sand")])
PLOT = pair("HX-4", (7,), [block(7, 1, "HX-4")])  # the drilling plot of the same hole: no depth column


@pytest.mark.xfail(
    strict=True, reason="review/toughone: a part read on a retry is stored as a second borehole"
)
async def test_a_part_read_on_the_retry_is_not_a_second_borehole(monkeypatch: pytest.MonkeyPatch) -> None:
    stored: dict[str, PageGroup] = {}
    unread: set[int] = {7}
    outcomes: dict[str, ExtractionOutcome] = {LOG[0].key: LOG[1], PLOT[0].key: PLOT[1]}

    async def plan(_: str) -> list[PageGroup]:
        return [LOG[0], PLOT[0]]

    async def state(_: str) -> tuple[set[str], set[int]]:
        return set(stored), set(unread)

    async def extract(_: str, group: PageGroup, **__: Any) -> ExtractionOutcome:
        return outcomes[group.key]

    async def finalize(_: str, group: PageGroup, __: ExtractionOutcome) -> str:
        stored[group.key] = group
        return group.key

    async def nothing(*_: Any, **__: Any) -> Any:
        return None

    async def yes(_: str) -> bool:
        return True

    async def no_tables(_: str) -> identity.Tables:
        return identity.Tables({})

    monkeypatch.setattr(group_module, "plan_groups", plan)
    monkeypatch.setattr(orchestrator, "_extraction_state", state)
    monkeypatch.setattr(orchestrator, "_has_boreholes", yes)
    monkeypatch.setattr(bh3_adapter, "active", lambda *_: False)
    monkeypatch.setattr(extract_module, "extract_group", extract)
    monkeypatch.setattr(finalize_module, "finalize_group", finalize)
    monkeypatch.setattr(finalize_module, "finalize_document", nothing)
    monkeypatch.setattr(identity, "document_tables", no_tables)

    await orchestrator.stage_extract("doc_fictional", extractor=object())  # type: ignore[arg-type]
    assert list(stored) == [LOG[0].key]  # page 7 unread: the log goes to review alone
    unread.clear()
    await orchestrator.stage_extract("doc_fictional", extractor=object())  # type: ignore[arg-type]
    assert len({g.label_canonical for g in stored.values()}) == len(stored)  # one borehole per label
