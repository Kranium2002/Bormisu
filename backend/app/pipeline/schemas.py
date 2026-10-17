"""Typed hand-offs between pipeline stages and the models' strict output schemas (BACKEND.md 7.3-7.6).

The extraction schema asks for raw text plus the OCR block ids it came from, never normalised numbers:
Python normalises (app.normalize) and keeps the raw text as provenance.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

PageRoleLiteral = Literal[
    "log_sheet",
    "log_continuation",
    "summary_table",
    "coordinate_table",
    "lab_results",
    "legend_or_key",
    "location_plan",
    "cross_section",
    "narrative",
    "cover_or_toc",
    "photos",
    "blank",
    "other",
]
HandwritingLiteral = Literal["none", "annotations", "partial", "full"]
ValueStateLiteral = Literal["ok", "not_in_source", "illegible"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------------------------
# 7.3 Page classification (cheap model)
# ---------------------------------------------------------------------------------------------


class PageLabel(StrictModel):
    role: PageRoleLiteral
    borehole_labels: list[str] = Field(description="Borehole labels exactly as printed on the page.")
    sheet_label: str | None = Field(description='Sheet text as printed, e.g. "SHEET 2 OF 6".')
    sheet_index: int | None
    sheet_total: int | None
    handwriting: HandwritingLiteral
    language: str | None = Field(description="BCP 47 code of the main text language, e.g. de, en, pt-BR.")
    has_coordinates: bool
    has_depth_scale: bool
    is_continuation: bool
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(description="One sentence.")


# ---------------------------------------------------------------------------------------------
# 7.4 OCR, normalised (provider-independent)
# ---------------------------------------------------------------------------------------------


class OcrBlock(StrictModel):
    id: str = Field(description='Stable block id "p{n}.b{i}" (document page n, 1-based; block i, 0-based).')
    type: str = Field(description="Provider block type: text, table, title, list, header, footer, image ...")
    text: str
    box: list[float] | None = Field(
        description="[x, y, w, h] normalised 0-1, top-left origin of the page render."
    )
    confidence: float | None = Field(description="Average content confidence 0-1, None when not scored.")
    min_confidence: float | None
    table_id: str | None = Field(default=None, description="Id of the page table this block shows, if any.")


class OcrPageResult(StrictModel):
    n: int = Field(ge=1, description="Document page number, 1-based.")
    markdown: str
    tables: list[str] = Field(description="Tables as HTML, in page order.")
    blocks: list[OcrBlock]
    header: str | None = None
    footer: str | None = None


# ---------------------------------------------------------------------------------------------
# 7.6 Extraction (expensive model): raw text plus block ids
# ---------------------------------------------------------------------------------------------


class RawValue(StrictModel):
    raw: str | None
    block_ids: list[str]
    state: ValueStateLiteral

    @classmethod
    def absent(cls) -> RawValue:
        return cls(raw=None, block_ids=[], state="not_in_source")


def _absent_if_none(value: Any) -> Any:
    return {"raw": None, "block_ids": [], "state": "not_in_source"} if value is None else value


# A raw value the model may send as null when it is not printed (keeps the answer short); in Python it is
# always a RawValue, with state not_in_source for null.
OptRaw = Annotated[RawValue, BeforeValidator(_absent_if_none), Field(json_schema_extra={"x-nullable": True})]


class RawCoordinates(StrictModel):
    x_raw: OptRaw = Field(description="First coordinate exactly as printed.")
    y_raw: OptRaw = Field(description="Second coordinate exactly as printed.")
    labels_raw: OptRaw = Field(
        description='Axis labels and order as printed, e.g. "N, E" or "Rechtswert, Hochwert".'
    )
    system_raw: OptRaw = Field(
        description='Coordinate system as printed, e.g. "MGA94 Zone 55"; null when none.'
    )


class ExtractedHeader(StrictModel):
    borehole_label: OptRaw
    project: OptRaw
    client: OptRaw
    location: OptRaw
    contractor: OptRaw
    method: OptRaw
    start_date: OptRaw
    end_date: OptRaw
    total_depth: OptRaw
    depth_unit: OptRaw = Field(
        description='Unit of the depth column or depth scale as printed, e.g. "m", "(m)", "ft", "Tiefe [m]".'
    )
    ground_level: OptRaw
    elevation_datum: OptRaw
    coordinates: RawCoordinates
    inclination: OptRaw
    depth_origin_note: OptRaw = Field(
        description="Notes about the depth origin or sign convention, as printed."
    )
    notes: OptRaw


class ExtractedLayer(StrictModel):
    from_raw: RawValue
    to_raw: RawValue
    description_raw: OptRaw
    description_language: str | None
    english_lithology: str | None = Field(description="English rendering of the description; null if none.")
    din4023_code: str | None = Field(
        description="Main component as a DIN 4023 code from the provided list, or null."
    )
    din4023_notation: str | None
    uscs_raw: OptRaw
    colour_raw: OptRaw
    consistency_raw: OptRaw
    moisture_raw: OptRaw
    weathering_raw: OptRaw
    stratigraphic_name_raw: OptRaw


class ExtractedSpt(StrictModel):
    depth_raw: OptRaw
    blows_raw: OptRaw = Field(description='Blow counts per increment as printed, e.g. "5/7/9" or "50/120".')
    n_raw: OptRaw = Field(description="Printed N value, if any.")
    increment_note_raw: OptRaw = Field(description='Increment scheme as printed, e.g. "3 x 150 mm".')


class ExtractedCoreRun(StrictModel):
    from_raw: RawValue
    to_raw: RawValue
    tcr_raw: OptRaw
    scr_raw: OptRaw
    rqd_raw: OptRaw
    ff_raw: OptRaw


class ExtractedGroundwater(StrictModel):
    type: Literal["strike", "rest", "standpipe", "other"]
    depth_raw: RawValue
    date_raw: OptRaw


class ExtractedSample(StrictModel):
    name_raw: RawValue
    type_raw: OptRaw
    from_raw: OptRaw
    to_raw: OptRaw


class ExtractedTest(StrictModel):
    name: str = Field(description="One of the provided Test Results names.")
    value_raw: RawValue
    unit_raw: OptRaw
    depth_raw: OptRaw
    sample_raw: OptRaw


class ExtractionResult(StrictModel):
    header: ExtractedHeader
    layers: list[ExtractedLayer]
    spt: list[ExtractedSpt]
    core_runs: list[ExtractedCoreRun]
    groundwater: list[ExtractedGroundwater]
    samples: list[ExtractedSample]
    tests: list[ExtractedTest]


EXTRACTION_SCHEMA_VERSION = "2"
CLASSIFIER_SCHEMA_VERSION = "1"
