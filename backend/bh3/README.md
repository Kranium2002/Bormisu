# bh3 — borehole log extraction, version 3

One package for the whole job: borehole reports of any kind (vector PDFs, scanned PDFs, photos, folders of
page images, DOCX files with embedded scans) go in; out come the BoreholeDataFormat xlsx/json **and the data a
borehole map needs** — one coordinate system for the pins, one petrography code system (DIN 4023) for the layer
tables and profile drawings, and the source page image behind every value. The target experience is
https://bohrungen.lgrb-bw.de/ (map → point → Stammdaten + Schichtenverzeichnis + Bohrprofil); `OUTPUT.md`
documents the files the demo is built on.

```
inputs ─► render ─► classify ─┬─ text-layer log page: vector/ (v1 triage → geometry → header aliases) ──┐ (< 2 layers → vision)
                              └─ raster page: tiles ─► vision model (grid, strict JSON) ─► merge ─► anchor ─► reconcile ─┤
                                                                                                                         ▼
       assemble (group, carry open strata across sheets, validate) ─► normalise (text model: lithology / USCS / colour)
                                           ─► din (words, codes, legends → DIN 4023) ─► geo (printed CRS → WGS84, with status)
                                                                                                                         ▼
       export: boreholes.xlsx (BoreholeDataFormat) + boreholes.json (provenance per value) + site/ (geojson, profiles, page images, index)
```

v3 was made on 2026-10-17 by condensing v1 (`bhpipe`, deterministic geometry parser) and v2 (`bhvision`,
vision-model-first raster path): the parts that measurably worked were moved unchanged (prompts, schemas, tile
geometry and cache keys included), the rest (OCR, LibreOffice conversion, the v1 vision rescue) was deleted,
and the regression eval below reproduced v2's numbers from cache with zero model calls before anything new
was added. New in v3: `din.py`, `geo.py`, `site.py`, the symbol/legend read, the printed-coordinate grouping
tie-break, and per-document knowledge as data files.

## Backend: hosted now, local later

Only the OpenAI chat-completions surface is used (`messages` with data-URI images, `temperature`, `seed`,
`max_tokens`, `response_format`). The hosted Mistral API is the stop-gap for machines without a GPU; on the
customer's servers the same code points at vLLM / Ollama / llama.cpp with a `.env` change (`LLM_BASE_URL`,
`LLM_VISION_MODEL`). Constrained JSON uses `response_format=json_schema` where the server supports it and
falls back to `json_object` + schema-in-prompt (`LLM_JSON_SCHEMA=0`); every answer is validated in code
before use. Mistral Small 3.x has open weights and vision, so the model family used through the API can move
on-prem with unchanged prompts; Qwen2.5-VL is the other candidate. Everything else — geometry, merging,
checks, DIN mapping, coordinate conversion (pyproj, bundled data), the site product — runs offline.

First thing to run on any backend:

```bash
python -m bh3 probe                           # AF02.pdf page 5 at 100/150/200/300 dpi
```

It lists the server's models, flags a configured vision model that does not exist (that is how we found
`pixtral-large-latest` retired), and prints per resolution: latency, prompt tokens, schema mode and the
layers read. Measured on `mistral-medium-latest` (2026-10-17): ~3 s per call, strict `json_schema`
accepted, and **prompt tokens stop growing at ~1540 px long side** — the server downscales anything larger.
That number is `BH_VLM_TILE_PX`; re-measure it for another backend.

## Run

```bash
cd backend && .venv/Scripts/activate                   # Windows; see ../README.md for the venv
DATA=../HKBoreholeChallenge_Data_BFH2026/BoreholeData    # the challenge corpus (never committed)
python -m bh3 classify $DATA                 # page classes + predicted extraction calls, cheap
python -m bh3 run $DATA -o out3              # everything → out3/boreholes.xlsx, .json, site/
python -m bh3 run $DATA/AF02.pdf --pages 5 -o out3_af02
python -m bh3 page $DATA/MEA03-jpg 1 --raw   # one page: merged result, symbols, raw model JSON
python -m bh3 eval out3/boreholes.json --golden tests/golden/unseen
python -m bh3 site out3/boreholes.json -o out3/site    # rebuild the website data product, no model calls
python -m bh3 run $DATA --no-llm             # deterministic only: vector pages; raster pages marked unread
```

Flags: `--resume` is the default (per-page raw answers under `.bh3_work/results/`), `--no-resume` re-reads;
`--prefer images` when a folder holds a PDF *and* its page images (default: the PDF); `--no-vector` sends
everything through the vision path; `--preprocess always|never` (default `auto`); `--workers N`;
`--pages 1,3,5-8`; `--max-pages N`; `--no-anchor`; `--symbols` / `--no-symbols` (default `auto`: the symbol
read runs only on pages with strata that have no words); `--max-calls N` / `--max-tokens-total N` (off by
default) stop a run cleanly at a budget — resumable. Every run ends with its cost line (`≈ $` from
`LLM_PRICE_IN/OUT`) and the text-model call count.

Replaying answers cached under an older prompt version, with zero vision calls (how the corpus product below
was built from the first run's answers): `BH_PROMPT_VERSION=2 BH_VLM_TRANSCRIPT=0 python -m bh3 run ...
--no-anchor --max-calls 60`.

## Stages (modules)

| stage | module | what it does |
|---|---|---|
| inputs | `inputs.py` | PDF / image / folder of images (natural sort, PDF-vs-PNG dedupe) / DOCX (images in body order, no LibreOffice) |
| render | `render.py` | page JPEGs at 72 dpi (classify) and 200 dpi (tiles), cached under `.bh3_work/render/<sha1>`; text-layer words for vector pages |
| vector path | `vector/` | the frozen v1 parser: `triage` (keywords, depth scale), `geometry` (ruled columns → layers / points), `header` (aliases, dates, numbers), `textlayer` |
| classify | `classify.py` | one 72-dpi call → page type, language, unit, read quality, band boxes; raw-answer store |
| extract | `extract.py` | routing, tiles (`tiles.py`: body cut into ≤ 1540 px slices, column titles stitched on top, red coordinate grid), vision calls (`vlm.py`, 4 workers, truncation re-tiling), text-layer transcript hint, zero-layer shifted re-read, symbol/legend read, anchoring (`anchor.py`: y→depth fit, ruling-line snapping, gated), document-rule names |
| reconcile | `reconcile.py` | hard checks (order, overlaps, bottoms vs total depth, value ranges, elevation-scale detection), remark/label/consistency merges, name cleaning, confidence from checks |
| assemble | `assemble.py` | pages → holes (name, sheet n of m, printed coordinates, depth continuity), open strata carried across sheets, header merge + text-model fallback, `validate.py` |
| normalise | `llm.py` | text model: lithology / USCS / colour / consistency per description (batched, cached) |
| din | `din.py`, `din_codes.py`, `legends.json` | words, printed codes, legend phrases, USCS or hatch symbols → DIN 4023 short form + colour + hatch name |
| geo | `geo.py`, `crs_overrides.json` | printed coordinate system → EPSG → WGS84 (pyproj), axis-order check, status exact / assumed / unknown / outlier |
| export | `export.py`, `site.py` | xlsx (Metadata / Logdata / Points / Pages / Issues), JSON with provenance, `site/` |
| eval | `eval.py`, `tests/golden/` | scores against hand-labelled pages |

## One code system: DIN 4023

Logs write the same stratum as words in six languages, as a USCS symbol, or only as a hatch pattern next to a
legend. `din.py` turns every layer into the DIN 4023 short form (`S, u` = sand, silty; `G, s, u'` = gravel,
sandy, weakly silty; `Kst` = limestone; `A` = fill; `Mu` = topsoil) with the DIN colour and the hatch name of
the Schraffuren sheet, so a renderer can draw the profile. Evidence order, recorded per layer in `din_source`:
a printed DIN code; the normalised `lithology` plus secondary constituents from adjectives in the raw text
(en / de / da / no / es / pt / ca / fr, "slightly / schwach / poco …" → weak mark); a per-document phrase table
(`legends.json`: Danish KALK → Kst, Portuguese "solo de aterro" → A, "DITTO" repeats the previous row, "Ground
Surface" / "Cota 856.93" are markers, not strata); a constituent noun in the text; the USCS symbol; the hatch
named by the vision model (`symbol`, with the page legend or the DIN conventions). Rock codes stand alone.
Nothing is invented: a layer with text but no evidence gets no code and `needs_review`.

Three rules ported from the team's normaliser on `main` (`backend/app/normalize/lithology.py` there): made
ground wins over the soil that describes it ("FYLD: SAND, fint" → `A, s`, DIN 4023 4.2.8), a single grain-size
word next to the main noun narrows sand and gravel to the DIN fraction ("SAND, fint" → `fS`, "fine to coarse
SAND" stays `S`), and organic muds (gyttja, Mudde) are `F`, not peat.

Measured on the corpus output (3828 layers, 3805 with text): 3509 coded (92 %); by source lithology 3412,
ditto 35, legend 33, words 18, symbol 6, uscs 5. The uncoded rest are notes rows ("Field vane at 43.0 m",
"Core loss", "Dense" alone, Korean joint descriptions, Report01 test rows) — correctly left blank. Run side by
side with `main`'s noun-only normaliser on the same 3805 descriptions: it codes 75 % (no rock names in its
vocabulary, no legends, no ditto), bh3 92 %; where both code, 88 % agree exactly and 91 % on the main soil
family; the rest are flint (`X` vs `Kst`), breccia read as sand, and "silty SAND" style phrases where the
normaliser's lithology enum and the capitalised noun disagree.

## One coordinate system

`geo.py` resolves every hole with printed X/Y to WGS84. `exact` when the printed system parses (MGA94 zone,
NZTM, Mt Eden 2000, WGS84, UTM zone + hemisphere, ETRS89/UTM32, Danish System 34 — west-orientated, so its
"E" is negated before the east-orientated reconstruction, OSGB, SVY21, HK80); `assumed` when
`crs_overrides.json` names the system for the document, each entry with the evidence (place names on the
pages, magnitude of the numbers, the printed elevation; e.g. NAM02 "Ground UTM" + Coquitlam → NAD83 / UTM 10N,
SAM02 Praça Sete + 850 m → SIRGAS 2000 / UTM 23S); `unknown` otherwise (Benghazi, Buenos Aires and Oslo site
grids, and every hole without coordinates); `outlier` when a located hole sits more than 100 km from the
document's other holes (a misread digit — AF02 has one). Axis order is checked, not trusted: both (x, y) and
(y, x) are transformed and the one inside the CRS's area of use wins (FullReport02 prints northing first,
AF01 prints latitude in X, SEA01's Korean belt is northing-first). The map shows `crs_status` in the popup.

## Document-specific knowledge (allowed for the prototype, kept as data)

The corpus is small and the pitch needs a working prototype, so per-document knowledge is allowed — but it
lives in three data files, never in code branches, and every entry says why: `crs_overrides.json`
(coordinate systems with evidence), `legends.json` (phrase tables, markers, ditto), `doc_rules.json` (a name
regex for the Ramboll GeoGIS layout of EUR01, where the boring number follows the coordinate-system label).
A new customer layout costs one entry in these files, or one labelled example page.

## Measured (2026-10-17, `mistral-medium-latest`, prompt v5 + generic rules + gated anchoring + text-layer transcript)

Two hand-labelled sets, both labelled by me (Claude) from the page images — spot-check them:

- **dev set** `tests/golden/` (10 pages): one page per document type, used while building the pipeline.
- **unseen set** `tests/golden/unseen/` (11 pages): two pages each from documents never looked at during
  development (EUR01 Ramboll vector, EUR02 faded Fugro, NAM02 Golder continuation sheets, SEA02 Azerbaijani,
  FullReport02 OPUS/Aurecon with a broken text layer, ToughOne2 handwritten logs and a Mackintosh probe sheet).
  This is the number to quote for "unseen data".

Columns: b<tol = share of golden boundaries matched within 0.15 m; desc = golden strata whose first words
appear in a layer at the right depth; sptR = golden test values found at the right depth (±0.3 m); Hx/He =
header fields exact / expected. **bh3 reproduces both tables from cache (`vision calls=0`).**

### Unseen set, per page

| page | route | layers found/exp | bMAE (m) | b<tol | desc | sptR | depth | name | Hx/He |
|---|---|---|---|---|---|---|---|---|---|
| EUR01 p5, Ramboll vector, landscape | vector→vlm | 13/15 | 0.15 | 0.62 | 0.60 | – | – | yes | 4/7 |
| EUR01 p26, Ramboll core pieces (cm offsets) | vector→vlm | 17/7 | 0.01 | 1.00 | 1.00 | – | – | yes | 3/5 |
| EUR02 p3, faded Fugro, sheet 1 | vlm | 8/3 | 0.23 | 0.67 | 0.67 | 1.00 | yes | yes | 1/6 |
| EUR02 p17, faded Fugro, sheet 1 | vlm | 6/6 | 0.25 | 0.67 | 0.50 | 0.88 | yes | yes | 6/6 |
| FullReport02 p41, Aurecon (text layer unusable) | vlm | 6/4 | 0.02 | 1.00 | 0.00* | 1.00 | – | yes | 10/10 |
| FullReport02 p46, OPUS basalt core | vlm | 4/4 | 0.05 | 0.75 | 1.00 | – | yes | yes | 6/8 |
| NAM02 p1, Golder continuation (one stratum) | vlm | 1/1 | 0.00 | 1.00 | 1.00 | 0.00 | – | yes | 4/6 |
| NAM02 p16, Golder, sonic, one boundary | vlm | 3/2 | 0.81 | 0.50 | 0.50 | – | – | yes | 4/6 |
| SEA02 p2, Azerbaijani/English, clean scan | vlm | 6/4 | 0.06 | 0.80 | 0.75 | 1.00 | yes | yes | 3/6 |
| ToughOne2 p4, handwritten Mackintosh probe | vlm-spt | – | – | – | – | 0.76 | NO | yes | 1/1 |
| ToughOne2 p11, handwritten borehole log | vlm | 10/10 | 0.00 | 1.00 | 1.00 | 1.00 | – | yes | 3/3 |
| **all 11** | | | **0.16** | **0.80** | **0.70** | **0.81** | 4/5 | **11/11** | **45/64** |

\* FullReport02 p41: strata headings carry their depth ("5.78m: Tuffaceous SILT"); the pipeline strips the
prefix, so the first-words match fails although the four strata and their depths are right (b<tol 1.00).

### Dev set, per page

| page | route | layers | bMAE (m) | b<tol | desc | sptR | depth | name | Hx/He |
|---|---|---|---|---|---|---|---|---|---|
| AF02 p5, scanned Spanish, thickness-column trap | vlm | 4/3 | 0.12 | 0.75 | 1.00 | – | yes | yes | 6/6 |
| AUS01 p1, vector SMEC | vector | 6/6 | 0.00 | 1.00 | 1.00 | 1.00 | NO | yes | 9/9 |
| SAM01 p1, vector, 1 row/m | vector | 11/10 | 0.00 | 1.00 | 1.00 | 0.00† | yes | yes | 4/4 |
| SEA01 p4, scanned Korean rock log | vlm | 5/6 | 1.17 | 0.57 | 0.67 | – | yes | yes | 3/5 |
| ToughOne2 p3, handwritten hand-auger log | vlm | 4/3 | 0.00 | 1.00 | 1.00 | – | yes | yes | 1/1 |
| profile01.jpg, Catalan, 567 px wide | vlm | 8/8 | 0.18 | 0.38 | 0.88 | 0.50 | – | yes | 0/2 |
| MEA03 BH-1.jpg, photo | vlm | 5/5 | 0.02 | 1.00 | 1.00 | 1.00 | yes | yes | 4/5 |
| SAM02.docx p2, Brazilian SPT log | vlm | 5/5 | 2.13 | 0.83 | 1.00 | 0.00 | yes | yes | 5/5 |
| NAM02 p10, Golder continuation | vlm | 1/2 | 2.15 | 0.50 | 0.00 | 0.00 | – | yes | 4/6 |
| EUR02 p5, "strata as previous page" | vlm | 1/1 | 4.50 | 0.00 | 1.00 | – | – | yes | 2/7 |
| **all 10** | | | 1.03 | 0.70 | **0.86** | 0.42 | 6/7 | **10/10** | **38/50** |

† SAM01 goes through the vector path, which recognises the N column but emits no SPT points on that layout;
the vector→vlm fallback only triggers on missing layers.

### What changed the numbers (unseen set, same pages, same model)

| version | b<tol | desc | sptR | name | notes |
|---|---|---|---|---|---|
| v2 baseline (first build) | 0.85 | 0.72 | 0.57 | 0.73 | footers taken as names, blow increments as tests, digit-split probe counts |
| v3 generic rules | 0.79 | 0.65 | 0.76 | 1.00 | name cleaning, remark/label merging, N = sum of increments, digit re-join, elevation-scale check, header sanity |
| v4 + gated anchoring | 0.79 | 0.63 | **0.81** | 1.00 | grid overlay + ruling-line snapping; the gate keeps the model's boundary unless it snaps to a line within 0.75 m; SPT depths re-anchored within 0.3 m |
| v5 + text-layer transcript, sheets carried | **0.80** | **0.70** | **0.81** | 1.00 | vector pages that fall to the model get their exact embedded text (with page rows) in the prompt; open strata continue across sheets |
| bh3 (this build) | 0.80 | 0.70 | 0.81 | 1.00 | same answers from cache; plus DIN codes, lat/lon, site product, printed-coordinate grouping, document rules |

Honest reading: the rules fixed the systematic errors that mattered for identity and test values (names
100 %, SPT recall +24 points on unseen pages). Boundaries did not improve on average: the model places
boundary lines on the coordinate grid too coarsely for the anchoring to overrule its own depth reading on
most pages, so the gate lets it through only where a ruling line confirms it. Ungated anchoring was measured
and rejected (unseen b<tol 0.64). Strata text is right on 8 of 10 dev pages and the misses on unseen pages
are mostly labelling ambiguity (sample-top vs stratum-top depth columns, per-piece core descriptions).

### Symbol / legend read (prototype, 2026-10-17)

Pages whose strata are drawn, not written, get a second tile read with a schema that names the hatch of
every stratum (`symbol`: dots, dashes, horizontal lines, circles, bricks, crosses …) and transcribes any legend
on the page; the plain read stays authoritative and only `symbol` / `legend` are copied onto its layers, so the
measured numbers above are untouched. `din.py` turns the symbol into a code through the page legend, else
the DIN conventions. Tried on SEA02 p2 (dots on the sand strata, crosses / diagonal lines on the Quaternary
rows, a wordless stratum at 4.5–6.0 m got `dots` → S), ToughOne2 p4 (a probe sheet, nothing to read) and
profile02.jpg (no symbol column): 5 calls, $0.05. Default `auto` = only pages with wordless strata.

## Full corpus (1034 pages, 18 documents)

The first full run (2026-10-17, prompt v2) cost 1537 vision calls, 2.76 M + 0.66 M tokens ≈ $6, 98 min. Its
per-page answers are cached; the v3 product below was built by replaying them through the final code
(grouping, checks, DIN, CRS, site) with zero vision calls — see the replay flags under *Run*.

Replay of the cached answers through the final code (2026-10-17): **39 vision calls** (the automatic symbol read on
22 pages with wordless strata, $0.39), 39 text-model calls, 700 s wall. Holes dropped from 475 to 382 because
the printed-coordinate tie-break and the name rules stopped over-splitting multi-sheet holes (NAM02: 87 → 14,
one hole per 6–10 sheets, as the sheets say; EUR01: 84 → 71 with the Ramboll boring numbers read from the
text layer). `coded` = layers with a DIN 4023 code, `located` = holes with a map pin, `med conf` = the
pipeline's own check score (not accuracy; see the labelled sets), `iss/hole` = flagged issues per hole.

| document | holes | layers | coded | located | points | med conf | iss/hole |
|---|---|---|---|---|---|---|---|
| AF01 (vector, WGS84 printed) | 2 | 14 | 13 (92 %) | 1 | 2 | 0.96 | 1.0 |
| AF02 (scanned Spanish, Morocco) | 11 | 80 | 78 (97 %) | 7 + 1 outlier | 125 | 0.75 | 0.4 |
| AUS01 (vector SMEC, MGA94) | 6 | 48 | 45 (93 %) | 6 | 53 | 0.98 | 0.7 |
| EUR01 (Ramboll, 147 p, S34S / UTM32) | 71 | 1347 | 1325 (98 %) | 59 | 387 | 0.38 | 16.7 |
| EUR02 (faded Fugro, BNG assumed) | 8 | 115 | 102 (88 %) | 8 | 803 | 0.23 | 19.8 |
| FullReport01 (Benghazi, local grid) | 26 | 66 | 39 (59 %) | 0 | 163 | 0.73 | 0.7 |
| FullReport02 (Auckland, NZTM) | 17 | 113 | 99 (87 %) | 17 | 277 | 0.88 | 0.6 |
| MEA01 (1980s photocopies, Bahrain) | 16 | 89 | 76 (85 %) | 4 | 285 | 0.60 | 2.8 |
| MEA03 (7 photos, no coordinates) | 7 | 35 | 33 (94 %) | 0 | 139 | 0.75 | 1.0 |
| NAM02 (Golder, 98 p, UTM 10N assumed) | 14 | 208 | 191 (91 %) | 13 | 460 | 0.49 | 16.1 |
| Report01 / SEA03 (Papakura, Mt Eden 2000) | 22 | 232 | 172 (74 %) | 17 | 438 | 0.90 | 2.0 |
| SAM01 (vector, Buenos Aires local grid) | 32 | 434 | 388 (89 %) | 0 | 1006 | 0.98 | 0.0 |
| SAM02.docx (Belo Horizonte, UTM 23S assumed) | 18 | 59 | 31 (52 %) | 10 | 63 | 0.55 | 3.2 |
| SEA01 (Korean rock logs, East Belt assumed) | 6 | 163 | 122 (74 %) | 6 | 398 | 0.29 | 15.0 |
| SEA02 (Azerbaijani, no coordinates) | 44 | 228 | 220 (96 %) | 0 | 750 | 0.60 | 4.4 |
| ToughOne1 (drilling-parameter plot) | 1 | 4 | 0 | 0 | 0 | 0.55 | 3.0 |
| ToughOne2 (113 p handwritten, no coordinates) | 79 | 583 | 567 (97 %) | 0 | 1596 | 0.45 | 2.1 |
| BoreholeData (two Catalan profile images) | 2 | 10 | 8 (80 %) | 0 | 18 | 0.75 | 1.0 |
| **all 18** | **382** | **3828** | **3509 (91 %)** | **148** | **6963** | | |

DIN codes by source: lithology 3412, ditto 35, legend 33, words 18, symbol 6, USCS 5; 319 layers without a
code (notes rows, Korean joint descriptions, test rows, "strata as previous page" sub-rows). The symbol read
named a hatch on 56 layers (bricks 13, dots 12, crosses 11, horizontal lines 10, dashes 7); on 50 of them the
words already gave the code, 6 wordless strata got their code from the hatch alone. Pins: 148 holes (exact
or assumed); 234 holes have no pin — 232 print no coordinates or a local grid (SAM01, FullReport01,
ToughOne1 need the project grid definition), 2 are flagged as outliers (misread digits). `out3_all/site/`
is 296 MB, of which the 18 page-image folders are nearly all; `--no-pages` builds it without them.

Low confidence rows are driven by multi-sheet holes where every sheet break still raises a flag (EUR01,
EUR02, NAM02, SEA01) and by handwriting (ToughOne2), where low confidence is the intended behaviour.

## Cost / time

Per page: 1 classify call (~0.8k tokens at 72 dpi) and, for log pages, 1–3 tile calls (~2.4k tokens each) +
1 header call (~1.5k); pages with wordless strata get a second tile read. Mistral medium answers in ~3 s; a
14-page scanned document takes ~2.5 min with 4 workers. `classify` over a folder prints the predicted call
count before any extraction; every run prints its cost. Re-runs are cache-only (`.llm_cache/` keyed by
model + prompt version + image hash). Rule of the house: no corpus-scale model runs without asking; rule
changes are verified offline on cached answers (`bh3 site`, `bh3 eval`); prompt changes are tried on ≤ 3 pages.

## Tests

```bash
python -m pytest tests -q               # 42 tests: inputs, tiles, anchor, reconcile, eval, din, geo, site — offline (local benchmarking suite, kept out of the repo)
python tests/mock_llm_server.py 8099    # then LLM_BASE_URL=http://127.0.0.1:8099/v1 exercises the model plumbing offline
```

## Roadmap: training, and why it is not in the pitch build

Fine-tuning was considered and deferred, for three reasons that will still be true in a week:

- **Hosted:** Mistral's fine-tuning API covers text models; image fine-tuning is not documented for Pixtral or
  Medium. OpenAI offers hosted vision fine-tuning, a different provider and data-residency story.
- **Local:** a LoRA on an open vision model (Qwen2.5-VL 7B, Pixtral 12B, Mistral Small 3.x) needs 200–500
  corrected page→JSON pairs, a 24 GB GPU for a few hours and a held-out hand-labelled set to know whether it
  helped. None of that existed when the pitch build was made.
- **Evidence first:** the measured errors are systematic (positions, column mix-ups), and the generic rules and
  geometry anchoring in this version remove most of them without any training.

Recipe when the time comes:

1. **Correction loop.** The pipeline's JSON is already the label format (see `OUTPUT.md`). A reviewer corrects
   the xlsx; a small `review` command turns corrected rows back into `tests/golden/*.json`. Every processed
   report then grows the training and evaluation set at near-zero cost.
2. **Public scans as bulk data.** Openly licensed scanned records (BGS SOBI scans under OGL, GSI Ireland CC BY,
   Washington DNR, HK GEO); run the pipeline on them, use a strong teacher model to pseudo-label, keep the
   hand-labelled pages as the only truth for evaluation. (From this network the GSI host refused connections
   and the BGS scan host timed out, so no public numbers are in this build.)
3. **Fine-tune on-prem.** LoRA on Qwen2.5-VL-7B or Mistral Small 3.x with vLLM serving the result behind the
   same OpenAI-compatible URL — nothing in the pipeline changes except `.env`. Judge it on the unseen and
   public sets, never on the training pages.
4. **Few-shot before fine-tuning.** For a customer with two or three recurring report templates, one labelled
   example page per template in the prompt gives most of the consistency gain without any training; it is a
   prompt change and can be done in a day.

Deferred and named: reading stand-alone legend sheets (one vision call per sheet), column crops for landscape
layouts (EUR01's second tile still misreads the scale), lab / test-result pages, vertical datum conversion,
call-count reductions (header in tile 0, local page filter), batch endpoint.
