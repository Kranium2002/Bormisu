"""Fictional values only: sub-interval notes read as strata go back into their printed stratum."""

from __future__ import annotations

from app.pipeline.layer_ranges import merge_declared_ranges
from app.pipeline.schemas import ExtractedLayer, RawValue


def _raw(text: str | None, block: str) -> RawValue:
    if text is None:
        return RawValue.absent()
    return RawValue(raw=text, block_ids=[block], state="ok")


def _layer(top: str, base: str, text: str, n: int) -> ExtractedLayer:
    return ExtractedLayer(
        from_raw=_raw(top, f"p1.b{n}"),
        to_raw=_raw(base, f"p1.b{n + 1}"),
        description_raw=_raw(text, f"p1.b{n + 2}"),
        description_language="en",
        english_lithology=text,
        din4023_code=None,
        din4023_notation=None,
        uscs_raw=RawValue.absent(),
        colour_raw=RawValue.absent(),
        consistency_raw=RawValue.absent(),
        moisture_raw=RawValue.absent(),
        weathering_raw=RawValue.absent(),
        stratigraphic_name_raw=RawValue.absent(),
    )


def test_notes_inside_a_heading_range_join_the_stratum() -> None:
    layers = [
        _layer("0.00", "1.40", "*Fill Depth : 0.0 ~ 1.4 m * Clayey gravel", 10),
        _layer("1.40", "6.10", "*Slate Depth : 1.4 ~ 9.6 m - grey, weak", 20),
        _layer("6.10", "7.70", "6.1~7.7m : -joint set:2set(20,60°) -aperture : 0.1~1.0mm", 30),
        _layer("7.70", "8.20", "-Joint infilling : Calcite", 40),
        _layer("8.20", "9.60", "8.2~9.6m : Crushed zone", 50),
        _layer("9.60", "12.30", "*Quartzite Depth : 9.6 ~ 12.3 m - white, strong", 60),
    ]
    merged = merge_declared_ranges(layers)
    assert [(m.from_raw.raw, m.to_raw.raw) for m in merged] == [
        ("0.00", "1.40"),
        ("1.40", "9.60"),
        ("9.60", "12.30"),
    ]
    slate = merged[1]
    assert slate.description_raw.raw is not None
    assert slate.description_raw.raw.startswith("*Slate Depth")
    assert "Crushed zone" in slate.description_raw.raw and "Calcite" in slate.description_raw.raw
    assert slate.to_raw.block_ids == ["p1.b51"]
    assert set(slate.description_raw.block_ids) == {"p1.b22", "p1.b32", "p1.b42", "p1.b52"}


def test_rows_without_headings_are_untouched() -> None:
    layers = [
        _layer("0.0", "2.5", "1.0-2.5 m: sandy clay", 10),
        _layer("2.5", "4.0", "2.5-4.0 m: gravel", 20),
        _layer("4.0", "6.0", "silt", 30),
    ]
    assert merge_declared_ranges(layers) == layers


def test_a_range_that_is_not_the_strata_extent_is_no_heading() -> None:
    """'lenses 2-3 m thick' inside a 0-5 m stratum does not make the next stratum a note of it."""
    layers = [
        _layer("0.0", "5.0", "Clay with sand lenses 2-3 m thick", 10),
        _layer("5.0", "5.2", "Peat", 20),
    ]
    assert merge_declared_ranges(layers) == layers


def test_a_note_outside_the_heading_range_stays_a_stratum() -> None:
    layers = [
        _layer("0.0", "3.0", "*Sand Depth : 0.0 ~ 3.0 m", 10),
        _layer("3.0", "4.5", "3.0~4.5m : Weathered rock", 20),
    ]
    assert merge_declared_ranges(layers) == layers
