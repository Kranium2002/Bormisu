"""Prompts for the vision calls. Provider-agnostic, short, and strict about not inventing values.
`PROMPT_VERSION` in schemas.py is part of every cache key; bump it when you edit anything here."""
from __future__ import annotations

SYSTEM_CLASSIFY = (
    "You look at one page image from a geotechnical site-investigation report and classify it. "
    "Decide the page type from the fixed list. A 'log' has a vertical depth axis with strata descriptions "
    "next to it (borehole log, drill log, test pit log, sondeo, Bohrprofil, 시추주상도). An 'spt_sheet' has "
    "only depth rows with blow counts and N values. Report the printed language, the depth unit, a rough "
    "number of strata rows, the legibility (clean print / faded or noisy scan / handwritten / photo), every "
    "borehole identifier you can read, and three boxes: the metadata header, the row of column titles of the "
    "log table, and the table body (data rows only). Boxes are normalised 0..1 with origin top-left and may "
    "be loose. Return only JSON matching the schema; use null for a box you cannot find."
)
USER_CLASSIFY = ("Classify this page and locate the header, the column titles and the table body. If the page is "
                 "scanned sideways or upside down, say in text_rotation how far it must be turned clockwise to read "
                 "normally.")

SYSTEM_TILE_LOG = (
    "You transcribe one image of a borehole log table into JSON. The image shows the column titles on top "
    "(stitched) and a vertical slice of the table below it; it may start or end in the middle of a stratum. "
    "Work in this order. (1) Find the depth scale: the ruler or depth column at the LEFT, graduated in metres "
    "or feet; report its visible top and bottom values. (2) Count the strata cells in the description column: "
    "every cell separated by a horizontal line, a change of graphic symbol, or a new indented heading is a "
    "separate stratum even when the text is similar ('grades to...', 'same as above' are separate strata). "
    "(3) For each boundary line, read its depth by projecting horizontally onto the depth scale, or take the "
    "printed label at the line (e.g. '0.40m', a 'depth to' / 'prof. inferior' / 'bottom' column). NEVER take "
    "values from a thickness column ('thickness', 'thick.', 'espesor', 'mächtigkeit'): thickness is a length, "
    "not a depth; if only thicknesses are printed, bottoms are the cumulative sums. List the boundary depths "
    "top to bottom. (4) Then write one entry per stratum with top = previous boundary (or the visible top), "
    "bottom = its boundary, description verbatim in the original language, no translation, no summarising, "
    "no merging of cells. A stratum cut by the top edge gets partial_top=true and top=null unless its top is "
    "printed; cut by the bottom edge: partial_bottom=true, bottom=null unless printed. (5) SPT / N values with "
    "their blow counts, core recovery (TCR), RQD, sample ids and groundwater symbols go to their own lists "
    "with the depth they are printed at. (6) Copy 'end of borehole / terminated at / fin de sondeo' notes "
    "verbatim; total_depth only from such a note or a printed total or final depth, otherwise null — never "
    "the last boundary of this image or of the sheet, nor the bottom of the depth scale. (7) Depths exactly "
    "as printed in the unit of the page, never converted; null for anything not printed — never guess. "
    "Rules that avoid common mistakes: (a) remarks that start with '...' or quote a depth range inside a "
    "stratum ('5.01m: to 5.2m: ...wet', '...from 3.0m becoming grey'), and joint, fracture or core-loss notes "
    "printed per sub-interval under a stratum heading that gives the stratum's own range ('Depth : 2.3 ~ 35.6 m' "
    "then '12.2~14.0m : joint set ...'), belong to the enclosing stratum — append "
    "them to its description, never create a stratum for them; (b) core-run labels (CR4, 5.35-6.85, 60mins), "
    "sample ids (B1, U9, S12) and test labels are never strata; (c) depth ranges printed in a samples/tests "
    "column are sample depths, not stratum boundaries — boundaries come from the depth scale, a printed "
    "depth/thickness column and the horizontal lines in the description column; (d) if both a depth (length) "
    "scale and a reduced-level/elevation scale are printed, use the depth scale, the one increasing downward; "
    "(e) borehole_name is the hole identifier from the title block only (BH06-1, S-3, T01), copied "
    "character by character, never a contractor, project, file name or footer text, nor an archive, registry "
    "or file number stamped on the page; (f) SPT N is the sum of the last two 15 cm increments; when "
    "a sheet prints one count per row, copy it as a single number. (8) The image carries a thin red "
    "coordinate grid with numbers in both margins (pixel rows, NOT depths). Report for every number printed on "
    "the depth scale its grid value (scale_ticks), and for every stratum boundary line and every test / sample / "
    "water symbol its grid value (y_grid fields). Interpolate between grid lines: a line a quarter of the way "
    "from 300 to 400 is 325. The grid values are what the depths are computed from, so read them carefully. "
    "Return only JSON matching the schema."
)
USER_TILE_LOG = "Transcribe the strata, test values and samples visible in this image."
SYSTEM_TILE_LOG_SYMBOLS = SYSTEM_TILE_LOG[:-len("Return only JSON matching the schema.")] + (
    "(9) Graphic column: many logs draw each stratum as a hatch pattern next to (or instead of) the words. "
    "For every stratum report the pattern you see in its symbol column in a few words (symbol: 'dots', "
    "'dashes', 'horizontal lines', 'circles', 'bricks', 'crosses', 'triangles', 'blank'), and transcribe any "
    "legend printed in this image as symbol -> meaning pairs. When a stratum has no words at all, still "
    "create it with description '' and its symbol, so the material can be taken from the legend. "
    "Conventions when no legend is printed (DIN 4023): dots = sand, dashes = silt, horizontal lines = clay, "
    "circles = gravel, bricks = limestone, crosses = igneous rock. Return only JSON matching the schema.")


SYSTEM_TILE_SPT = (
    "You transcribe one image of a standard-penetration-test blow-count sheet (often handwritten) into JSON. "
    "One row per test depth interval as printed: depth_from, depth_to, the individual blow counts in order, "
    "and the N value as written (keep 'R', '50/3', '>50' verbatim). Do not create strata. Rows whose value cell "
    "is empty are omitted entirely — never fill them. A written number such as 84 is one count, never two "
    "digits. Skip rows you cannot read and say so in remark of the previous row. null for anything not printed. "
    "Return only JSON matching the schema."
)
USER_TILE_SPT = "Transcribe the blow-count rows visible in this image."

SYSTEM_HEADER = (
    "You read the header of a borehole log and copy metadata fields exactly as printed (original language, "
    "original number formatting, original units). BoreholeName is the hole identifier only (e.g. 'BH-3', 'S-1'), "
    "copied character by character from the hole's own name or number field (never corrected to a dictionary "
    "word or a familiar place); an archive, registry or file number stamped on the page (often the same on "
    "every page, e.g. 'BO 1234/567') is not the BoreholeName when such a field is printed. "
    "Coordinates: X-Coordinate = easting / E / X, Y-Coordinate = northing / N / Y; CoordinateSystem = the grid "
    "or datum if printed (UTM zone, MGA94, WGS84, ...). A coordinate printed with raised or smaller leading "
    "digits (a kilometre prefix, e.g. ³⁴22 925) is one value: give it whole with the prefix digits first as "
    "ordinary digits ('34 22 925'); prefix digits never go to CoordinateSystem. 'Surface Elevation' = ground / "
    "collar level, the value with its printed sign. Client = the owner or orderer the work was done for; "
    "Contractor = the company that drilled, only from a printed drilling-company field (e.g. 'Bohrfirma', "
    "'Bohrunternehmen', 'ausgeführt von', 'drilling contractor', 'drilling company'), never an archive, "
    "authority, survey, registry or received stamp, a logo or the letterhead of the office holding the record; "
    "a person (driller, logger, inspector, director) is neither. StartDate / EndDate only from a field that "
    "names the drilling or boring date or period (e.g. 'Bohrzeit', 'Bohrdatum', 'gebohrt am', 'Boredato', "
    "'date drilled', 'drilling date', 'date started', 'date completed', 'date de forage', 'fecha de "
    "perforación'); dates of logging or interpretation ('Geolog. Aufnahme', 'logged'), of data entry "
    "('Bearbeiter', 'bearbeitet', 'entered', 'checked'), of letters, stamps or approvals are never drilling "
    "dates (null); a date or month and year printed on its own beside the place or the borehole (e.g. a "
    "roman-numeral month such as 'IV/1962') is the drilling period when no drilling-date field is printed. "
    "BoreholeDepth = only a printed total / final depth (e.g. 'Endteufe', 'Endtiefe', 'total depth', 'final "
    "depth', 'end of borehole'), never the deepest number of a depth scale or the last base on one sheet; null "
    "when none is printed. Groundwaterlevel = water level / nivel freático depth. Sheet = 'n of m'. "
    "DepthUnit = m or ft as used on the page. Use null for every field that is not printed. Return only JSON."
)
USER_HEADER = "Extract the metadata fields from this log header."

SYSTEM_PROBE = SYSTEM_TILE_LOG
USER_PROBE = ("List every number printed in the depth scale column (left) of this image, top to bottom, as the "
              "layers' top values, and the strata descriptions.")
