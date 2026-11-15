# main's extraction vs bh3: where the algorithms differ and what main needs to reach bh3's accuracy

Written 2026-10-17 by Felix for the backend owner. It compares the extraction pipeline on `main` (commit
`178b43b`, `backend/app/`) with bh3, the pipeline on branch `felix-backend` (`backend/bh3/`). Everything
measured here was measured on the challenge corpus (18 documents, 1034 pages) and on 21 hand-labelled pages;
the labels are not in the repository (data rule) and are available from me on request. Where I could not
measure something, the text says so. Corpus documents are described by their layout, not by file name.

**Status (2026-10-18):** option 1 of section 5 is done. bh3 runs inside main as `backend/app/bh3/`, called
through `backend/app/pipeline/bh3_adapter.py` and `backend/app/bh3/bridge.py`, with main's classifier,
clarification questions, review and database around it. The port ships no per-document rule files:
`doc_rules.json` and `crs_overrides.json` (D4, D6) stayed on `felix-backend`, and
`backend/app/bh3/legends.json` holds only generic phrases. The numbers below were measured on
`felix-backend` before the port.

## 1. What is measured and what is not

| | main (`backend/app`) | bh3 (`backend/bh3`) |
|---|---|---|
| Model stages run on the corpus | not by me: needs Docker (PostGIS, worker) and an OpenRouter key; `docs/eval/report.md` is not committed | yes: first full run 1537 vision calls, 2.76 M + 0.66 M tokens, ≈ $6, 98 min; later replays from cache at zero vision calls |
| Page-level accuracy on labelled pages | no page-level metrics exist (`app/eval/compare.py` compares borehole counts, labels, printed coordinates, CRS status, total depth, layer count) | 21 labelled pages: boundary MAE, boundaries within 15 cm, strata text, SPT recall, names, header fields (`backend/bh3/eval.py`, tables in `backend/bh3/README.md`) |
| Deterministic normalisers | run standalone on this machine on bh3's corpus output: `app/normalize/lithology.py`, `app/normalize/crs.py`, `app/normalize/spt.py` | same inputs, `backend/bh3/din.py`, `geo.py` |

bh3's measured numbers (model `mistral-medium-latest`, prompt v5, gated anchoring, text-layer transcript):

| set | pages | boundaries within 15 cm | strata text | SPT recall | names | header fields exact |
|---|---|---|---|---|---|---|
| unseen (documents never tuned on) | 11 | **0.80** | 0.70 | 0.81 | 1.00 | 45/64 |
| dev | 10 | 0.70 | 0.86 | 0.42 | 1.00 | 38/50 |

How the unseen numbers moved while bh3 was built (same pages, same model) — this is the evidence for the
"why" in section 3:

| version | boundaries | strata text | SPT recall | names | what changed |
|---|---|---|---|---|---|
| v2 first build | 0.85 | 0.72 | 0.57 | 0.73 | footers taken as names, blow increments as tests, probe counts split |
| v3 generic rules | 0.79 | 0.65 | 0.76 | 1.00 | name cleaning, remark/label merging, N = sum of increments, digit re-join, elevation-scale check, header sanity |
| v4 gated anchoring | 0.79 | 0.63 | 0.81 | 1.00 | grid overlay + ruling-line snapping; boundaries only overruled when a line confirms them |
| v5 text-layer transcript | 0.80 | 0.70 | 0.81 | 1.00 | vector pages that fall to the model get their exact embedded text; open strata carried across sheets |

## 2. The pipelines side by side

| stage | main (`backend/app/...`) | bh3 (`backend/bh3/...`) |
|---|---|---|
| Inputs | PDF, images, Office via Gotenberg, spreadsheets; stored by SHA-256, duplicates by perceptual hash (`pipeline/triage.py`, `classify.py`) | PDF, images, image folders (natural sort, PDF-vs-PNG dedupe), DOCX media in body order without LibreOffice (`inputs.py`) |
| Page triage | cheap model labels every page with a role (`log_sheet`, `log_continuation`, `summary_table`, …), labels, sheet numbers, handwriting (`classify.py`, `data/prompts/classifier.txt`) | vector pages: keyword + depth-scale triage from the text layer (`vector/triage.py`); raster pages: one 72-dpi vision call → page type, language, unit, read quality, header/column/table-body boxes (`classify.py`) |
| Reading the page | Mistral OCR on every used page ($4 / 1000 pages) → markdown + blocks with boxes; the extractor sees **text**, and a page image only for handwriting, low-confidence blocks or empty OCR (`pipeline/ocr.py`, `extract.py: needs_image`) | vector pages: embedded words parsed deterministically (ruled columns, depth scale fit, `vector/geometry.py`); raster pages: the **image**, cut into ≤ 1540 px tiles with the column titles stitched on top and a labelled coordinate grid, one strict-JSON vision call per tile (`tiles.py`, `extract.py`) |
| Extraction unit | one extractor call per borehole page group with all its OCR text, context pages and cited block ids (`extract.py`, `data/prompts/extractor.txt`) | one call per tile; tiles merged by text identity and depth; disagreements become issues (`tiles.merge_tiles`) |
| Depths | the printed `from_raw` / `to_raw` text the extractor cites; a layer without parseable depths is **not created** (`finalize.py` ≈ line 530) | read off the depth scale by the model, then anchored: scale ticks → y→depth fit, boundaries snapped to detected ruling lines within a gate (`anchor.py`); boundary and thickness-column rules in the prompt |
| Grouping pages into holes | classifier labels and sheet numbers only (`pipeline/group.py`); doubtful boundaries become a `borehole_boundary` question | name (cleaned), sheet n of m, depth continuity, printed coordinates as tie-break, open strata carried across sheets, per-document name rules (`assemble.py`, `reconcile.clean_name`, `doc_rules.json`) |
| Normalisation | Python only: numbers, units, SPT schemes, dates, coordinates, CRS, DIN nouns (`normalize/*`, `data/*.yaml`) | text model for lithology / USCS / colour (batched, cached) + deterministic DIN mapping with secondary components, legends, ditto, hatch read (`din.py`, `legends.json`) |
| Coordinates | registry + pattern yaml, candidates ranked by area of use, `stated / inferred / confirmed / unknown`, `crs_confirm` question (`normalize/crs.py`, `geo/crs_candidates.py`) | regex table for printed systems, per-document assumptions with written evidence, axis-order check against the area of use, outlier flag (`geo.py`, `crs_overrides.json`) |
| Checks | lint after the record exists (`validate/rules.py`, `data/lint_rules.yaml`); clarification questions for units, datum, boundaries, duplicates, readings | hard checks and repairs before the record exists (order, overlaps, elevation-scale detection, remark/label merges, N from increments, header sanity), then `validate.py`; confidence from the checks, not from the model (`reconcile.py`) |
| Provenance | cited OCR blocks, tightened to word boxes on pages with a text layer (`pipeline/provenance.py`, `textlayer.py`) | page + row band from the grid position (`y0`/`y1`), method per value; no word boxes on scans |
| Second reads | handwritten / low-confidence crops read again, disagreements become `choose_reading` (`pipeline/reread.py`) | tile overlap is the second opinion; zero-layer pages re-read with shifted tiles; symbol read for wordless strata |
| Review / storage | PostGIS, revisions, events, clarifications, chat | JSON store + FastAPI serving the same UI contract (`bh3/api/`) |
| Evaluation | harness against an audit file: counts, labels, printed coordinates, CRS status, total depth, layer count (`app/eval`) | golden pages: boundaries, strata text, SPT, names, header; dev + unseen sets (`eval.py`) |
| Cost per page (list prices) | worst case ≈ $0.018: classify 0.002 + OCR 0.004 + extractor ≈ 0.012 (`data/prices.yaml`, `app/eval/defaults.yaml` token assumptions) | measured ≈ $0.006 per page on the first run (`mistral-medium-latest`), ≈ $0.0004 on a replay |

## 3. Seven differences that cost accuracy, and what to implement

### D1. main reads OCR text; bh3 reads the page

- **main:** the extractor gets Mistral OCR blocks (`[[p7.b12]] 9,50 …`) and must return `from_raw` / `to_raw`
  as printed. A page image is attached only when OCR returned nothing, the page is handwritten, or a block is
  below the confidence threshold (`extract.py: needs_image`). `git grep` finds no depth-scale, tick,
  ruling-line or anchoring logic anywhere in `backend/app`.
- **bh3:** the model reads the picture: "depth scale first, count the cells, read every boundary by projecting
  onto the scale, never take the thickness column" (`prompts.py` rules 1–8), reports the grid position of
  every tick, boundary and test row, and code fits y→depth and snaps boundaries to detected ruling lines
  (`anchor.py`, gate: snap required, ≤ 0.75 m for boundaries, ≤ 0.3 m for SPT depths).
- **Why it matters:** on most scanned logs the stratum boundaries are ruled lines against a graphic depth
  scale, not printed numbers (photographed logs and several scanned reports), and one report prints a
  thickness column that OCR text cannot tell from a depth column. OCR text carries no geometry, so those boundaries are either
  guessed by the extractor or lost: main's `finalize.py` drops a layer whose depths do not parse. Measured in
  bh3: on a photographed log set, boundaries 83 % → 100 % and SPT depths 12 % → 100 % with anchoring;
  unseen SPT recall 0.57 → 0.81; the thickness-column trap is what the prompt rule fixed.
- **Implement in main:** attach the page image for every log page and ask for depths read off the scale with
  grid positions (prompt + schema: `scale_ticks`, `y_grid_top/bottom`), then `anchor.py`'s fit and snap in
  `finalize.py`. Cheapest exact path: call bh3's `extract.process_page` as the vision stage (section 5).
  Cost: ~2–3 tile calls per log page at ≈ 2.4 k tokens each; the OCR call can be dropped for those pages.

### D2. main OCRs vector PDFs; bh3 uses their text layer as data

- **main:** every used page goes through Mistral OCR, vector PDFs included; the embedded text layer is used
  afterwards only to tighten boxes (`textlayer.py`) and for classification.
- **bh3:** a page with a usable text layer is parsed deterministically — ruled columns, depth-scale fit,
  header aliases (`vector/`), zero model calls — and only falls to the model when it yields fewer than two
  layers; then the model gets the page's exact words with their rows as a transcript (`extract.text_transcript`).
- **Why it matters:** the corpus's clean vector-log report scores 100 % boundaries and 9/9 header fields at
  no cost; the transcript lifted one scanned report's strata text from 0.20 → 0.60 and 0.71 → 1.00 on its
  two labelled pages. OCR of a
  vector page re-introduces errors the text layer never had.
- **Implement in main:** skip OCR when `text_layer_quality ≥ 0.8` and feed the extractor the words with row
  positions; run a geometry parse first and use the model only where it fails. Saves the OCR fee on every
  vector page (5 of the 18 corpus documents).

### D3. main lints after the fact; bh3 repairs before the record exists

- **main:** `validate/rules.py` flags gaps, overlaps, inverted layers, values above limits — correct, but it
  never changes the record; the extractor's answer is final.
- **bh3:** `reconcile.py` applies rules that undo systematic model errors: names cleaned of footers and
  contractors (unseen names 0.73 → 1.00), remark / label / consistency-only cells merged into their stratum,
  SPT N = sum of the last two increments and digit re-join on probe sheets (SPT recall +24 points), elevation
  scale detected and converted, header depths outside sane limits dropped, points below the hole dropped,
  confidence computed from the checks (0.8 − 0.1 per failed check).
- **Implement in main:** the same rule set in `finalize.py` before `create_borehole`, keeping the lint for
  what cannot be repaired. Pure Python, one day.

### D4. main groups by classifier labels only; bh3 has fall-backs

- **main:** `group.py` walks log pages by the classifier's labels and sheet numbers; a page without a label
  joins the open group or becomes a "nolabel" group with a `borehole_boundary` question.
- **bh3:** name key first, then sheet 1 of n, then depth continuity (a page starting at 0 after a page ending
  deep is a new hole), then the printed coordinates as the tie-break when the name is missing or unusable,
  plus label stripping ("BORING NO. T01" → T01) and a per-document name regex for layouts that print the
  number away from the title (`doc_rules.json`).
- **Why it matters:** a report of multi-sheet logs went from 87 holes to the correct 14, and a long report
  from 84 to 71, once those
  tie-breaks existed; main has nothing to fall back on when the label is missing or misread.
- **Implement in main:** the same tie-breaks behind the labels in `group.py`; the coordinate rule needs the
  header's `x_raw`/`y_raw` per page, which main already extracts.

### D5. Petrography: noun only vs full DIN notation

- **main:** `normalize/lithology.py` derives the main component from nouns in `data/din_vocabulary.yaml`,
  ignores adjectives by design, returns None for two nouns, and knows no rock names beyond the DIN list's
  own names. The extractor may add `din4023_code` and `din4023_notation` when printed.
- **bh3:** `din.py` composes the full short form: main component (from the text model's lithology enum, the
  nouns, a per-document phrase table, USCS, or the hatch read for wordless strata) plus secondary
  components from adjectives in eight languages with the weak mark (`"G, s, u'"`), rock codes, legend and
  ditto rows. main's fill priority, grain-size fractions and gyttja → F were ported into bh3 today.
- **Measured on the same 3805 corpus descriptions:**

  | | main `din_code_from_text` | bh3 `din.classify_layer` |
  |---|---|---|
  | layers with a code | 2884 (75 %) | 3506 (92 %) |
  | where both code: exact agreement | 2540 of 2883 (88 %) | |
  | where both code: same soil family (S = fS = mS …) | 2644 (91 %) | |
  | only main codes | 1 | |
  | only bh3 codes | | 623, mostly Kst 143, U 101, T 75, G 63, S 60, Pl 44 |

  The remaining disagreements are flint (`X` vs `Kst`), breccia read as sand by main, and "silty SAND" phrases
  where the capitalised noun and the text model's lithology differ. Before the port the agreement was 80 %.
- **Implement in main:** rock nouns (limestone, sandstone, granite, basalt, gneiss, schist, chalk, marl, in the
  corpus languages), secondary components from adjectives, legend / ditto rows, and a code from the hatch
  symbol when the description is empty (bh3's `--symbols` read: ≈ 2 extra calls per such page).

### D6. Coordinate systems: strict vs evidence-based

- **main:** a printed system must match the registry or the datum + grid + zone patterns; otherwise `unknown`
  and a `crs_confirm` question. On the corpus's 36 printed spellings main resolves 6 (`55H MGA94`,
  `UTM32E89`, `WGS84`, `Mt Eden Circuit 2000`, `NZTM`, the full NZTM name); `S34S` (29 holes) and the
  NZGD2000 variants (11 holes) give no code.
- **bh3:** the same six plus System 34 Sjælland (west-orientated: the printed "E" is negated before the
  east-orientated EPSG reconstruction) and the NZGD2000 wording variants; a per-document assumptions file with
  the evidence written next to each entry (`crs_overrides.json`); both axis orders tried and the one inside
  the area of use kept (one report prints northing first, another prints latitude in X, and a Korean belt
  is northing-first); holes more than 100 km from their document's others are flagged, not pinned. Result:
  148 of the corpus's 382 holes have a pin; the rest print no coordinates or a local site grid.
- **Implement in main:** the registry entries above (`data/crs_registry.yaml`, `crs_patterns.yaml`), the
  negated-axis quirk for System 34, an `assumed` status fed by a project evidence file, and the outlier flag;
  keep the question for everything else.

### D7. Evaluation: counts vs page-level accuracy

- **main:** `app/eval/compare.py` compares borehole counts, labels, printed coordinates, CRS status, total
  depth and layer count against an audit file. It cannot see whether a boundary is 1 m off or a stratum's text
  is wrong, which is where the extraction errors are.
- **bh3:** golden JSON per page (name, layers with top/bottom/first words, SPT, groundwater, total depth, a
  few header fields) and `eval.py` scoring boundary MAE, boundaries within 15 cm, strata text, SPT recall,
  names and header fields, on a dev set and an unseen set.
- **Implement in main:** the golden format and those metrics in `compare.py`; run on the 21 pages so both
  pipelines are judged by the same yardstick.

## 4. What main does better — keep it

- Word-level evidence boxes on text-layer pages (`textlayer.py`); bh3 has row bands only.
- Clarification questions (units, datum convention, borehole boundaries, duplicates, disagreeing readings)
  and the reread of handwritten crops; bh3 lowers the confidence and lists an issue instead.
- OCR gating by page role, resumable stages, per-call cost ledger with a budget, duplicate detection by
  perceptual hash (an image set that repeats pages of a long report).
- The no-default rule enforced in the schema, aliases per borehole, revisions and events.
- Fill priority, grain-size fractions and organic mud in the DIN mapping (now also in bh3).

## 5. Two ways to get there

1. **bh3 as main's extraction stage (≈ 1 day, numbers come with it).** Keep main's triage, classifier and
   OCR gating, database, clarifications and reread. Replace the extract + finalize core for log pages with an
   adapter that runs `bh3.extract.process_page` on the page render (or the PDF page) and `bh3.assemble` on
   the group, then maps bh3's `Borehole` / `Layer` / `PointValue` to main's `ExtractionResult` + provenance
   (row boxes, `method` read/ocr/derived, confidence). bh3 is backend-agnostic (OpenAI-compatible surface,
   `LLM_BASE_URL`), so it runs through OpenRouter as well as through a local model.
2. **Port the rules piecewise (≈ 3–4 days).** D3 and D4 are pure Python (`finalize.py`, `group.py`); D5 and
   D6 are vocabulary and registry work plus the secondary-component logic; D2 is a routing change; D1 is the
   big one — prompt, schema, tiling, anchoring — and is where the measured accuracy comes from.

Recommendation: 1 first, measure, then 2 where main's stricter design (questions, word boxes) should win.

## 6. Verification

- Run both on the 21 labelled pages with bh3's metrics added to main's harness; targets are bh3's unseen
  numbers above (boundaries 0.80, strata 0.70, SPT 0.81, names 1.00).
- Cost per page from the ledger on the same pages (bh3 ≈ $0.006 measured; main's worst-case prior ≈ $0.018).
- Corpus level: holes per document against the known counts (14 on the multi-sheet report, about 37 printed
  boring numbers on the long report's log pages), pins per document, DIN coverage per document.

## Appendix: reproducing the numbers

- bh3's tables: branch `felix-backend`, `backend/bh3/README.md` (measured sections), `python -m bh3 eval
  <boreholes.json> --golden <golden dir>`; the golden files are mine, outside the repository.
- The normaliser comparison: export main's `backend/app` and `backend/data` into a folder, set `PYTHONPATH`
  to it and `DIN_CODES_PATH` to `assets/din4023_patterns/din_codes.json`, then for every layer of a bh3
  `boreholes.json` call `app.normalize.lithology.din_code_from_text(description, None)` and compare its code
  with the first token of bh3's `din_code`; for every distinct `metadata.CoordinateSystem` text call
  `app.normalize.crs.resolve_printed_system(text)` next to `bh3.geo.parse_crs(text)`.
- The SPT parsers are not comparable on bh3's output: bh3 stores one composite label per test
  (`"24 [2,3/4,6,6,8]"`) while main's `parse_spt` expects the blows and the N value as separate printed strings.
