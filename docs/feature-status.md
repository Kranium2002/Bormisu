# Feature status: what we build, what waits, what was dropped

One list for the team. Updated 2026-10-17 (Sat).
Sources:
- the persona study: `docs/personas/build-cut.md` on branch `prada/design`, PR #1
- the research log: [research/README.md](research/README.md)
- the frontend: `frontend/`, PR #2

Legend: ✅ built · 🔨 in progress · ⏭️ next (approved, not started) · 🔵 roadmap (later, name on the pitch slide) · ❌ dropped

## ✅ Built (frontend, PR #2, runs on sample data)

| # | Feature | What it does |
|---|---|---|
| 1 | World map | Pins coloured by review status (green / grey / amber), a legend with counts, "Not on map" list for boreholes without usable coordinates, a results table, and search by ID or project |
| 2 | Upload & queue | Drop zone (PDF / DOCX / JPG / PNG, others rejected), status steps, found counts, a page map coloured by page type |
| 3 | Completeness + lint panel | Borehole IDs named in the report vs extracted (missing ones in red), plus lint findings |
| 4 | Extraction review | Scan with value boxes; raw → normalised; method badge (Read / OCR / Derived / Guessed / Edited); approve, edit (the AI value stays visible), flag; "not in source" and "illegible"; lithology on 3 lines; SPT refusal shown as **R**, not N = 50; lint flags; a borehole switcher; keys J / K / A / E / F |
| 5 | Approve all clean | Approves only values read from the text layer, with no flag and no lint |
| 6 | Confirm CRS once per document | Candidate systems on a map preview; confirming turns the pins from amber to normal |
| 7 | Borehole detail | DIN 4023 profile (patterns, stratigraphy, groundwater markers, R marker, rock head, "not logged" hatch), metadata with chips, layers, groundwater, location mini-map |
| 8 | Show source | Click any value or the R marker to see the scan page with the cell boxed |
| 9 | Export | **Herrenknecht standard xlsx**: Metadata / Logdata / Test Results / Provenance, approved values only unless stamped DRAFT. Also a tidy CSV and an open-questions CSV for the client |
| 10 | Sample / API mode | `VITE_DATA_SOURCE`. Sample data is fictional and isolated in `src/sample/`. API mode shows a clear error and never falls back to sample data |
| 11 | Germany map focus | Mask, border, locked view. Being replaced by #12 |

## 🔨 In progress (agent running)

| # | Feature | What it does |
|---|---|---|
| 12 | World / Country dropdown | World view by default. Picking a country masks the rest and narrows the results, with "Show World" to go back. Search switches to the right country. `?focus=DE` deep links. 3 fictional demo projects abroad |
| 13 | My location (R14) | The engineer on site taps MY LOCATION and sees their position, an accuracy circle and the 5 nearest boreholes with distance and direction. The location stays in the browser. Sample mode can simulate a site |

## ⏭️ Next (research says build, waiting for "build it")

| # | Feature | Effort | Why |
|---|---|---|---|
| 14 | Geologically consistent fictional demo project | 1–2 h | **Prerequisite** for 16–18. The current sample boreholes are generated independently, so neighbours look random |
| 15 | R8 Scan peek on hover | 2–4 h | Puts "every number has a source" on the map, with no theory risk |
| 16 | R13 Evidence near this point | 6–9 h | Click a point to see the 3 nearest real boreholes with distance and spread. It refuses beyond 200 m (the upper end of the EN 1997-2 spacing guidance for tunnels) or outside the investigated area. Never a predicted profile |
| 17 | R4 Draw your tunnel → section (lite) + R10 gap bar | 6–8 h + 2–3 h | The highest-value idea: the DAUB TBM-selection workflow starts from this section. Boreholes only, no interpolated lines, per-hole flags (rock head in band, refusal, water above crown), gaps marked |
| 18 | R1 Colour by tunnel band | 3–5 h, if time | Classifies each borehole against a tunnel band in elevation: soil / rock / mixed face here / refusal / not reached / no datum |

## 🔵 Roadmap: later, and why not now

**From the research** ([research/README.md](research/README.md)):

| Feature | Why later |
|---|---|
| R2 3D borehole sticks | No persona asked for it. Leaflet can't do 3D, and a second map engine plus WebGL in CI is a build risk (12–20 h) |
| R7 Similar-ground finder | Only useful with project outcomes (TBM type, cutter wear), which we don't have. Weak across classification standards |
| R9 Ask the map (LLM) | The LLM can produce valid but **wrong** filters, and it's a live-API risk on stage. Filter chips do the same job |
| R11 One-click tender brief PDF | The full version takes 12–16 h. A print view of the section (#17) is the cheap version |

**From the persona study** (`build-cut.md`). These are cut because they need groundwork we don't have yet:

| Feature | Why later |
|---|---|
| Tunnel alignment upload (KML / LandXML), corridor, chainage | Needs a project model and file parsers. #17 covers the core of it by drawing the line |
| Lab tables: UCS / CAI linked by sample, Lab tests tab, ground parameters P10–P90 | Lab tables are their own extraction problem. **No lab values reach the frontend yet** |
| Per-value audit trail, approve & lock revision, evidence pack, viewer role, assign / hand-off / notifications | All need user accounts |
| Project summary / tender brief cards, similar reference projects, presentation mode with anonymisation | Need ground class, tunnel horizon and project-outcome fields |
| Georeference from control points, vertical datum conversion | Large. For now an inferred CRS shows as amber, and datums are shown as printed ("datum unconfirmed") |
| Sheet stitching (merge / split), page-type override and re-extract, investigation type, project header panel, number-format control | For now the pipeline groups sheets by borehole ID, lint flags missing bottoms, and the normaliser detects decimal style |
| Power-review tools: move boundary with reason, spot-check mode, review filters, bulk approve by threshold, pop-out / rotate source | Little demo value. Keyboard keys and "approve all clean" are built |
| Map extras: KPI strip, parameter chips, column picker, "other projects" layer, tender basket | The map stays focused; the World/Country dropdown (#12) covers the most-asked one |
| Detail extras: hazard tags, core-runs tab, parameter track, depth / elevation toggle, plain-language summary | Need more extracted fields |
| Picture exports (map PNG, section PDF, pptx), phone layout, read-only API, language switch | Screenshots do the job for the pitch. The layout is desktop-first (1280 px) |

## ❌ Dropped, and why

| Feature | Why dropped |
|---|---|
| R3 Drill-down flythrough | Eye candy with no work step behind it |
| R5 TBM simulator / cutter-wear meter | Wear models (CSM, NTNU, Gehring) need CAI, UCS and CLI, which we don't extract. A cartoon wear meter in front of Herrenknecht engineers says we don't know their job |
| R6 Ground-risk heatmap | Interpolates sparse, mixed-standard data, and a shaded pixel has no source page. It contradicts our core promise |
| R12 AR on a phone | Phone GPS is about ±5 m, AR anchoring needs better, and iPhones have no web AR. **Replaced by R14 "My location" (#13)** |
| "Drill here next" (part of R10) | That's site-investigation planning by a qualified engineer, not a tool's job |
| A single predicted profile (part of R13) | Can't be defended across projects. Inside a project, 4–14 boreholes are far below the ~100+ needed for geostatistics. We show nearest evidence instead |
| Interpolated lines between boreholes (in R4) | That's the geologist's interpretation. Drawn by a tool, it could be read as a contractual baseline |

## Not ours: the backend team (`arav/dev`)

Extraction pipeline, normalisers, and the API changes the UI needs ([api-contract.md](design/api-contract.md) §1, on `prada/design`):
- per-value provenance + page images
- a unique borehole `uid`
- `null` instead of made-up defaults
- async upload with document status
