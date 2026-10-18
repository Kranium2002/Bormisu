"""DIN 4023 codes when the model gives none (app.pipeline.finalize): from a printed short notation, else the
description's words in the layer's, the page's or any listed language; the model's own valid code stays.
Fictional descriptions only."""

from __future__ import annotations

from app.pipeline.finalize import build_record
from app.pipeline.types import PageGroup
from tests.test_finalize import blk, block_map, header, layer, outcome, result, rv

BLOCKS = block_map(
    [
        blk("p1.b0", "Bohrung FX-9", (0.1, 0.05, 0.2, 0.02), quality=None),
        blk("p1.b1", "0,00", (0.1, 0.2, 0.05, 0.02), quality=None),
        blk("p1.b2", "1,50", (0.1, 0.3, 0.05, 0.02), quality=None),
        blk("p1.b3", "3,00", (0.1, 0.4, 0.05, 0.02), quality=None),
        blk("p1.b4", "4,20", (0.1, 0.5, 0.05, 0.02), quality=None),
        blk("p1.b5", "Feinsand (schwach schluffig) (fS(u'))", (0.2, 0.2, 0.4, 0.02), quality=None),
        blk("p1.b6", "Kies, sandig", (0.2, 0.3, 0.4, 0.02), quality=None),
        blk("p1.b7", "Auffüllung, Bauschutt", (0.2, 0.4, 0.4, 0.02), quality=None),
    ]
)
GROUP = PageGroup(key="g-fx9", label_raw="FX-9", label_canonical="FX9", pages=(1,))


def test_a_missing_din_code_comes_from_the_printed_notation_or_the_description() -> None:
    layers = [
        # the model gave no code and tagged the German description as English
        layer(
            rv("0,00", "p1.b1"),
            rv("1,50", "p1.b2"),
            rv("Feinsand (schwach schluffig) (fS(u'))", "p1.b5"),
            language="en",
        ),
        # the model's own valid code stays
        layer(rv("1,50", "p1.b2"), rv("3,00", "p1.b3"), rv("Kies, sandig", "p1.b6"), din="S", language="de"),
        # a printed short notation the model copied names the main component
        layer(rv("3,00", "p1.b3"), rv("4,20", "p1.b4"), rv("Auffüllung, Bauschutt", "p1.b7"), language="de"),
    ]
    layers[2] = layers[2].model_copy(update={"din4023_notation": "A"})
    res = result(header(borehole_label=rv("FX-9", "p1.b0"), depth_unit=rv("m", "p1.b1")), layers)
    draft = build_record("doc_fictional", GROUP, outcome(res, BLOCKS), language="de")
    assert draft.body is not None
    codes = [item["din4023_code"] for item in draft.body["stratigraphy"]]
    assert codes == ["fS", "S", "A"]
    first = draft.provenance["stratigraphy[0].din4023_code"]
    assert (first.method, first.page, first.raw) == ("derived", 1, "Feinsand (schwach schluffig) (fS(u'))")
    assert draft.provenance["stratigraphy[1].din4023_code"].method == "guessed"  # the vocabulary says G
