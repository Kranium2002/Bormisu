# bh3 output format (for the demo / review UI)

> The Bormisu frontend does not read these files directly: `python -m bh3 api` serves them as the API contract
> (`BoreholeRecord` with `din4023_code`, provenance, lint; documents; page images; review actions). See the
> "API for the frontend" section of `README.md` and `docs/INTEGRATION.md` §0. The files below are the
> complete record behind that API.

Every run writes into the `-o` folder: `boreholes.json` (complete, with provenance per value),
`boreholes.xlsx` (five sheets, flat) and `site/` (the website data product: map layer, one profile file per
hole, source page images, an index). **Build the demo on `site/`**; the JSON is the full record, the xlsx is
for people. `python -m bh3 site <boreholes.json> -o <dir>` rebuilds `site/` from any existing JSON without a
model call.

## site/ — what a borehole map needs (modelled on bohrungen.lgrb-bw.de)

```
site/
  boreholes.geojson       FeatureCollection, one Point per located hole           -> the map layer
  profiles/<slug>.json    Stammdaten + Schichtenverzeichnis + points + provenance  -> the detail view
  pages/<doc>/pNNN.jpg    the source page images (200 dpi)                         -> "show me the scan"
  index.json              documents, counts, CRS status, DIN legend, enrichment report
```

**boreholes.geojson** — `properties` per feature: `id`, `slug` (file name of the profile), `name`, `document`,
`pages`, `depth` (final depth, m), `elevation` (collar, m), `date`, `method`, `project`, `location`, `n_layers`,
`confidence` (0..1), `crs_status`, `epsg`, `profile` (relative path). Colour the pins by `depth` like LGRB
does, and show `crs_status` in the popup: `exact` = the page printed a system the pipeline could parse;
`assumed` = the system comes from `bh3/crs_overrides.json`, a per-document assumption with written evidence.
Holes without a pin are in `index.json → unlocated[]` with a `reason` (`no coordinates printed`, a local grid
nobody can name, or `outlier`: a point > 100 km from the document's other holes, i.e. a misread number).

**profiles/<slug>.json**
- `master`: the Metadata fields (`BoreholeName`, `LocationName`, dates, project, `Surface Elevation`,
  printed `X-Coordinate` / `Y-Coordinate` / `CoordinateSystem`, `BoreholeDepth`, `Groundwaterlevel`) plus
  `lat`, `lon`, `epsg`, `crs_status`, `crs_note`, `Client`, `Contractor`, `Method`, `Inclination`,
  `document`, `pages`, `confidence`, `route`, `read_quality`, `name_generated`.
- `layers[]` = the Schichtenverzeichnis, one row per stratum, ordered by depth:
  `no`, `from`, `to`, `thickness` (m); **`petrography`** = the DIN 4023 short form (`"S, u"` = sand, silty;
  `"G, s, u'"` = gravel, sandy, weakly silty; `"Kst"` = limestone; `"A"` = fill; `"Mu"` = topsoil);
  `din_color` (the DIN colour name, e.g. `orange` for sand) and `din_pattern` (the hatch name on the DIN 4023
  Schraffuren sheet, e.g. `Sand`, `Kalkstein`, `Auffüllung`) — the UI owns the SVG patterns, keyed by the
  main code; `din_source` says where the code came from (`printed` a DIN code on the page, `lithology` the
  normalised description, `legend` a per-document phrase table, `words` a constituent noun in the raw text,
  `uscs` the USCS symbol, `ditto` repeats the previous row, `symbol` the hatch described by the vision model,
  `none` nothing); `needs_review` is true when a row has text but no code could be derived.
  Then `lithology`, `uscs`, `stratigraphy`, `age`, `color`, `consistency`, `moisture`, `is_rock`,
  `description` (verbatim, original language), `spt` (N values inside the interval), `samples`,
  `confidence`, `provenance` {`file`, `page`, `y0`, `y1`, `method`, `confidence`}.
- `points[]`: SPT / RQD / TCR / SAMPLE / GWL values with `depth`, `depth_to`, `value`, `label`, `provenance`.
- `groundwater[]`: depths (m) — the header value first, then every water symbol read on the pages.
- `issues[]`: what the checks flagged, with the page (`p5: ...`).
- `pages[]`: `{page, image, dpi}` — `image` is the relative path of the 200-dpi page image. `provenance.y0`
  / `y1` are page rows in PDF points (72 per inch): multiply by `dpi / 72` to draw the band of a layer on the
  image. A landscape strip that was rotated upright before reading uses the rotated image (`_rot90`).

**index.json**: `counts` (documents, boreholes, located, unlocated, layers, layers_with_code,
layers_by_source), `documents[]` (per source file: holes, located, crs_status counts, layers, coded, pages
with image), `unlocated[]`, `din_legend[]` (every DIN code with `name_de`, `name_en`, `color`, `pattern`,
`kind` soil/rock/geo — use it to draw the legend), `enrichment` (what ran), `source_sha1`, `built`.

How to draw an LGRB-style profile from a profile file: for each layer draw a box from `from` to `to`
(scale 1 : 100 by default), fill it with the pattern for the main code (`petrography.split(",")[0]`) in
`din_color`, write `petrography` and `description` to the right, depths to the left, groundwater as the
DIN triangle at `groundwater[0]`, samples / SPT from `points`.

## boreholes.json

A list of borehole objects. Every number that came off a page carries a `prov` block saying where it came
from and how sure the pipeline is.

```json
{
  "borehole_id": "AF02:S-3",                // "<document id>:<BoreholeName>", "@p<page>" appended if not unique
  "source_file": "../HKBoreholeChallenge_Data_BFH2026/BoreholeData/AF02.pdf", // the document (for an image folder: the folder; for a DOCX: the .docx)
  "pages": [5],                              // 1-based pages of this document that belong to this hole
  "metadata": {                              // BoreholeDataFormat Metadata fields, present only when found
    "BoreholeName": "S-3", "ProjectName": "...", "ProjectID": "...", "LocationName": "...",
    "StartDate": "2014-08-25", "EndDate": "2014-08-25",        // ISO dates
    "X-Coordinate": 416019.05, "Y-Coordinate": 3388483.65, "CoordinateSystem": "...",
    "Surface Elevation": 14.81, "BoreholeDepth": 8.0, "BoreholeLength": 8.0, "Groundwaterlevel": 1.2,
    "_confidence": 0.73,                     // 0..1 for the whole hole (see below)
    "_route": "vlm",                         // vector | vlm | vector→vlm | vlm-spt  (how the pages were read)
    "_read_quality": "clean",                // clean | faded | handwritten | photo  (raster pages only)
    "_name_generated": true,                 // present when no name was printed and one was invented
    "_extra": {"Client": "...", "Contractor": "...", "Method": "...", "Inclination": "90°", "Sheet": "1 of 2",
                "PageNotes": "p5: Fin de sondeo a 8,00 metros. | ...", "DepthUnitOriginal": "ft"}
  },
  "meta_prov": {"X-Coordinate": {"file": "...", "page": 5, "method": "vlm", "confidence": 0.73, ...}, ...},
  "layers": [                                // strata, ordered by depth, metres below ground
    {"top": 0.0, "bottom": 0.5, "description": "TERRENO VEGETAL.",   // verbatim, original language
     "lithology": "Topsoil", "soil_unit": "UNKNOWN", "color": "", "consistency": "", "moisture": "",
     "stratigraphic_name": "", "geologic_age": "", "is_rock": false, "norm_confidence": 0.8,   // from the text model, may be null
     "prov": {"file": "../HKBoreholeChallenge_Data_BFH2026/BoreholeData/AF02.pdf", "page": 5, "y0": 0, "y1": 0, "x0": 0, "x1": 0,
              "method": "vlm", "confidence": 0.73}}
  ],
  "points": [                                // single values with a depth
    {"kind": "SPT", "depth": 1.0, "depth_to": 1.45, "value": 12.0, "label": "12 [3,5,7]", "prov": {...}},
    {"kind": "RQD", "depth": 5.0, "depth_to": 6.0, "value": 80.0, "label": null, "prov": {...}},
    {"kind": "TCR", ...}, {"kind": "SAMPLE", "value": "SS", "label": "SS", ...}, {"kind": "GWL", "depth": 2.0, "value": null, "label": "2.00 m @ 1:00 pm"}
  ],
  "issues": ["p5: layers 2 and 3 overlap by 0.20 m", "BoreholeDepth taken from last layer bottom", ...]
}
```

Field notes:
- `prov.method`: `geometry*` = deterministic parse of a vector page (exact; `y0/y1/x0/x1` are PDF points of
  the cell); `header-alias` / `header-regex` = deterministic header extraction; `vlm` = read by the vision
  model; `y0`/`y1` are the page rows (PDF points at the page's own scale) of the stratum's top and bottom
  boundary as located on the coordinate grid, 0 when the model gave no position; `x0`/`x1` stay 0; `llm` =
  text-model fallback for a missing header field (confidence 0.6).
- `prov.confidence` on a vision-read page is computed from checks (order, overlaps, bottoms vs total depth,
  value ranges, tile agreement) and read quality, never from the model's self-assessment. 0.8 means every
  check passed on a clean scan; each failed check costs 0.1; handwriting/photos start 0.15 lower.
- `metadata._confidence` = mean of the value confidences minus penalties from `issues` (gaps/overlaps 0.05
  each, "check"/"generated" 0.15 each). Use it to sort holes for review; use `issues` to say why.
- `points.value` is a number when the page printed one, otherwise a string as printed (`"R"`, `"50/3"`).
  `label` keeps the raw text (for SPT: N and the blow increments).
- `top`/`bottom` can be `null` when the page did not print them and no neighbour could fill them in; the
  xlsx shows them empty.
- Depths are metres. If a page was in feet, values are converted and `_extra.DepthUnitOriginal = "ft"`.

## boreholes.xlsx

| sheet | one row per | key columns |
|---|---|---|
| Metadata | borehole | BoreholeDataFormat metadata, `Client`, `Contractor`, `Method`, `SourceFile`, `Pages`, `Confidence`, `Issues` |
| Logdata | layer | `BoreholeID`, `LayerNo`, `DepthTop`, `DepthBottom`, `Thickness`, normalised fields (lithology, USCS, colour…), SPT/RQD/TCR/samples joined into the interval, `Description (raw)`, `Page`, `Method`, `Confidence` |
| Points | single value | `Kind`, `Depth`, `DepthTo`, `Value`, `Label`, `Page`, `Method`, `Confidence` |
| Pages | page | `Class` (log/lab/cover/…), `Route`, `ReadQuality`, `TextLayer`, `ParserNotes` (notes + issues of that page) |
| Issues | issue | `BoreholeID`, `Issue` |

## Per-page raw material (for a "show the source" view)

`site/pages/` already holds the page images. The working cache `.bh3_work/` (the `--workdir`) holds more,
keyed by a 12-char hash of the source file: `render/<hash>/p<NNN>_<dpi>.jpg` (page images),
`tiles/<hash>/p<NNN>_<dpi>_t<i>of<n>.jpg` (what the model saw), `results/<hash>/p<NNN>.raw.json`
(classifier answer with the band boxes, every tile answer, header answer). The hash is `bh3.render.file_sha1(path)`.

## Metadata additions in boreholes.json / xlsx

`metadata.lat`, `metadata.lon`, `metadata.epsg`, `metadata.crs_status`, `metadata.crs_note` (xlsx: `Latitude`,
`Longitude`, `EPSG`, `CRSStatus` on the Metadata sheet); per layer `din_code`, `din_color`, `din_pattern`,
`din_source` (xlsx: `Soil/Rockprofile` = `din_code`).
