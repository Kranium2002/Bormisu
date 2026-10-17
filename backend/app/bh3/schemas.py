"""JSON schemas for the vision calls. Strict style: every key required, `null` allowed where a value may be
absent, enums for anything downstream code branches on. Kept moderate in size so that 7B–32B local models
can follow them; nothing here is provider-specific.

Four schemas:
  CLASSIFY  – one low-resolution full-page image → page type, quality, coarse band boxes (drives tiling)
  TILE_LOG  – one tile of a borehole log table (+ stitched column header) → layers / points
  TILE_SPT  – one tile of a blow-count (SPT) sheet → rows only (no layers; prevents invented strata)
  HEADER    – the header band crop of a first sheet → metadata fields
"""
from __future__ import annotations

from .llm import HEADER_FIELDS as _BH_HEADER_FIELDS

PROMPT_VERSION = __import__("os").environ.get("BH_PROMPT_VERSION", "4")   # part of every cache key; override only to replay stored answers

PAGE_TYPES = ["log", "spt_sheet", "lab", "narrative", "cover", "photo", "plot", "other"]
READ_QUALITY = ["clean", "faded", "handwritten", "photo"]
DEPTH_UNITS = ["m", "ft", "unknown"]


def _num_or_null(desc: str = "") -> dict:
    d: dict = {"type": ["number", "null"]}
    if desc:
        d["description"] = desc
    return d


def _str_or_null(desc: str = "") -> dict:
    d: dict = {"type": ["string", "null"]}
    if desc:
        d["description"] = desc
    return d


def _bbox(desc: str) -> dict:
    return {"type": ["array", "null"], "description": desc + " Normalised [x0, y0, x1, y1] in 0..1 of the image, "
                                                      "origin top-left. null if absent.",
            "items": {"type": "number"}, "minItems": 4, "maxItems": 4}


def _obj(props: dict, desc: str = "") -> dict:
    d: dict = {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}
    if desc:
        d["description"] = desc
    return d


CLASSIFY_SCHEMA = _obj({
    "page_type": {"type": "string", "enum": PAGE_TYPES,
                  "description": "log = borehole/test-pit/drill log with a depth axis and strata descriptions; "
                                 "spt_sheet = blow-count table only (depth rows, blows per 15 cm, N), often handwritten; "
                                 "lab = laboratory results (sieve, Atterberg, UCS...); plot = drilling parameter curves "
                                 "or sounding diagrams without strata; cover = title/TOC/divider; photo = core box or "
                                 "site photo; narrative = running text"},
    "language": {"type": "string", "description": "ISO 639-1 code of the printed text, e.g. en, es, ko, de"},
    "depth_unit": {"type": "string", "enum": DEPTH_UNITS},
    "rows_estimate": {"type": "integer", "description": "approximate number of distinct strata/rows on the page (0 if none)"},
    "read_quality": {"type": "string", "enum": READ_QUALITY},
    "borehole_names_visible": {"type": "array", "items": {"type": "string"},
                               "description": "borehole / hole / sondeo identifiers printed on the page, verbatim"},
    "header_band": _bbox("Box around the metadata header (project, hole no, dates, coordinates)."),
    "column_header_band": _bbox("Box around the row of column titles of the log table (Depth, Description, SPT...)."),
    "table_body": _bbox("Box around the data rows of the log table below the column titles, excluding footers."),
    "text_rotation": {"type": "integer", "enum": [0, 90, 180, 270],
                      "description": "how many degrees CLOCKWISE this image must be turned so that its main printed text "
                                     "reads normally (left to right, lines running across); 0 if it already does"},
    "notes": {"type": "string", "description": "anything unusual: rotated page, two logs on one page, feet units, "
                                               "unreadable areas. Empty string if nothing."},
})

LAYER_ITEM = _obj({
    "top": _num_or_null("top depth of the stratum as printed (depth below ground in the page's unit)"),
    "bottom": _num_or_null("bottom depth as printed; null if the stratum continues past the bottom of the image"),
    "description": {"type": "string", "maxLength": 400,
                    "description": "verbatim description in the original language, trimmed to 400 characters"},
    "partial_top": {"type": "boolean", "description": "true if the stratum starts above the top edge of this image"},
    "partial_bottom": {"type": "boolean", "description": "true if the stratum continues below the bottom edge of this image"},
    "y_grid_top": {"type": ["integer", "null"], "description": "red grid value (pixel row) of the stratum's top boundary line; "
                                                              "interpolate between labelled lines, e.g. 250 halfway between 200 and 300"},
    "y_grid_bottom": {"type": ["integer", "null"], "description": "red grid value of the stratum's bottom boundary line"},
})

SPT_ITEM = _obj({
    "depth": _num_or_null("depth where the test starts or is plotted"),
    "depth_to": _num_or_null("end depth of the test interval if printed"),
    "n_value": _str_or_null("N value as printed, e.g. '12', 'R', '50/3', '>50'"),
    "blows": _str_or_null("blow counts per increment as printed, e.g. '3,5,7'"),
    "y_grid": {"type": ["integer", "null"], "description": "red grid value (pixel row) where this test is printed"},
})

CORE_RUN_ITEM = _obj({
    "top": _num_or_null(), "bottom": _num_or_null(),
    "tcr": _num_or_null("total core recovery in percent"), "rqd": _num_or_null("RQD in percent"),
})

SAMPLE_ITEM = _obj({
    "id": _str_or_null("sample identifier as printed"), "type": _str_or_null("sample type, e.g. SS, UD, D, B"),
    "depth": _num_or_null(), "depth_to": _num_or_null(),
    "y_grid": {"type": ["integer", "null"], "description": "red grid value (pixel row) where the sample is printed"},
})

GW_ITEM = _obj({"depth": {"type": "number"}, "note": _str_or_null("date/time or remark if printed"),
                "y_grid": {"type": ["integer", "null"], "description": "red grid value (pixel row) of the water symbol"}})

TICK_ITEM = _obj({"depth": {"type": "number", "description": "the number printed on the depth scale"},
                  "y_grid": {"type": "integer", "description": "red grid value (pixel row) of that number / its tick mark"}})

TILE_LOG_SCHEMA = _obj({
    "borehole_name": _str_or_null("hole identifier printed on this image, verbatim"),
    "sheet_no": {"type": ["integer", "null"]},
    "sheet_total": {"type": ["integer", "null"]},
    "depth_unit": {"type": "string", "enum": DEPTH_UNITS},
    "visible_depth_top": _num_or_null("depth at the top edge of the depth scale visible in this image"),
    "visible_depth_bottom": _num_or_null("depth at the bottom edge of the depth scale visible in this image"),
    "scale_ticks": {"type": "array", "items": TICK_ITEM,
                    "description": "every number printed on the depth scale in this image, top to bottom, with its grid value"},
    "n_strata": {"type": "integer", "description": "number of separate strata cells in the description column of this image "
                                                   "(cells separated by horizontal lines or distinct symbol blocks)"},
    "boundary_depths": {"type": "array", "items": {"type": "number"},
                        "description": "depth of every horizontal stratum boundary line, read from the depth scale or a "
                                       "printed bottom-depth label, top to bottom, excluding 0"},
    "layers": {"type": "array", "items": LAYER_ITEM},
    "spt": {"type": "array", "items": SPT_ITEM},
    "core_runs": {"type": "array", "items": CORE_RUN_ITEM},
    "samples": {"type": "array", "items": SAMPLE_ITEM},
    "groundwater": {"type": "array", "items": GW_ITEM},
    "terminal_note": _str_or_null("'End of borehole at 8.00 m', 'Fin de sondeo', etc. verbatim if printed"),
    "total_depth": _num_or_null("final depth of the hole if printed anywhere in this image"),
})

# optional variant (--symbols): the hatch of each stratum and the legend printed on the page, for pages whose
# strata are drawn, not written. Separate schema so the cache keys of the plain variant stay valid.
LAYER_ITEM_SYMBOL = _obj({**LAYER_ITEM["properties"],
    "symbol": _str_or_null("the graphic hatch/pattern drawn in the stratum's symbol column, in a few words: "
                           "'dots', 'dashes', 'horizontal lines', 'circles', 'bricks', 'crosses', 'triangles', 'blank'")})
LEGEND_ITEM = _obj({"symbol": {"type": "string", "description": "the hatch/pattern in a few words, as above"},
                    "meaning": {"type": "string", "description": "what the legend says it stands for, verbatim"}})
TILE_LOG_SYMBOL_SCHEMA = _obj({**{k: v for k, v in TILE_LOG_SCHEMA["properties"].items() if k != "layers"},
    "layers": {"type": "array", "items": LAYER_ITEM_SYMBOL},
    "legend": {"type": "array", "items": LEGEND_ITEM,
               "description": "every entry of a symbol legend printed in this image (empty if none)"}})

SPT_ROW_ITEM = _obj({
    "depth_from": _num_or_null(), "depth_to": _num_or_null(),
    "blows": {"type": "array", "items": {"type": ["number", "null"]}, "maxItems": 4,
              "description": "blow counts per increment as printed (usually 3 values per 15 cm)"},
    "n_value": _str_or_null("N as printed, e.g. '17', 'R', '50/5'"),
    "remark": _str_or_null(),
})

TILE_SPT_SCHEMA = _obj({
    "borehole_name": _str_or_null(),
    "depth_unit": {"type": "string", "enum": DEPTH_UNITS},
    "rows": {"type": "array", "items": SPT_ROW_ITEM},
    "total_depth": _num_or_null(),
})

HEADER_FIELDS = list(_BH_HEADER_FIELDS) + ["Inclination", "Sheet", "LoggedBy", "DepthUnit"]
HEADER_SCHEMA = _obj({f: _str_or_null() for f in HEADER_FIELDS},
                     "Metadata printed in the header of a borehole log. Strings exactly as printed.")

SCHEMAS = {"classify": CLASSIFY_SCHEMA, "tile_log": TILE_LOG_SCHEMA, "tile_spt": TILE_SPT_SCHEMA, "header": HEADER_SCHEMA}
