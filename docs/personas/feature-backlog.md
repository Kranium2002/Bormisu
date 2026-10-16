# Feature backlog (from the persona simulation)

Method: on 2026-10-17, 5 simulated personas walked through the 4 planned screens (world map, borehole detail, extraction review, upload & queue). This file merges and deduplicates their wishlists.

These are simulated users (AI agents role-playing realistic jobs), not interviews with real people. All project names, IDs and values are fictional.

Walkthroughs: [01 Geotechnical engineer](walkthroughs/01-geotech-engineer.md) · [02 TBM design engineer](walkthroughs/02-tbm-design-engineer.md) · [03 Senior geologist](walkthroughs/03-senior-geologist.md) · [04 Data reviewer](walkthroughs/04-data-reviewer.md) · [05 Bid manager](walkthroughs/05-bid-manager.md)

## Top 10 across all personas

How to read the tables:

- **Personas:** Geotech = 01 geotechnical engineer (core user), TBM = 02 TBM design engineer, Geologist = 03 senior geologist (approver), Reviewer = 04 data reviewer, Bid = 05 bid manager. A persona counts if their walkthrough, wishlist or schema gaps ask for the item.
- **Priority:** the highest priority any persona gave the item.
- **Effort:** one developer. S = 2 h or less, M = 2–5 h, L = more than 5 h. Assumes the 4 planned screens exist and the pipeline stores page and box per value.
- **Demo value:** how visible the item is in a 5-minute live demo.
- **Ranking:** persona count, then priority (and how many personas said "must"), then demo value, then effort.

| Rank | Feature | Screen | Personas (n/5: which) | Priority | Effort | Demo value |
|---|---|---|---|---|---|---|
| 1 | Provenance on every value, plus "Show source" from any number (detail, summary, export) to the highlighted page crop | Cross-cutting (Borehole detail, Project summary, Extraction review) | 5/5: all | must | M | high |
| 2 | Groundwater as a list of readings (type, date, depth, level + datum, source), one ▽ per reading type | Borehole detail | 5/5: all | must | M | medium |
| 3 | Tunnel alignment: upload (KML / CSV first), draw it with chainage ticks, chainage + offset per borehole, corridor filter | World map | 4/5: Geotech, TBM, Geologist, Bid | must | M | high |
| 4 | Page map: thumbnails coloured by detected page type, type override, unused pages with a reason, re-extract chosen pages | Upload & queue | 4/5: Geotech, TBM, Geologist, Reviewer | must | M | high |
| 5 | Approved-only by default: "Include unreviewed" toggle with an excluded count, DRAFT watermark on anything that uses unreviewed data | Cross-cutting (exports, summaries) | 4/5: Geotech, TBM, Geologist, Bid | must | S | medium |
| 6 | Longitudinal section along the alignment (chainage × elevation, DIN columns, tunnel, rock-head and groundwater lines, gaps at tunnel level) | New screen | 4/5: Geotech, TBM, Geologist, Bid (as a simple route strip) | must | L | high |
| 7 | Vertical datum as stated + offset to MSL, datum label on every elevation, "datum unconfirmed" state instead of a silent mASL | Extraction review, Borehole detail | 4/5: Geotech, TBM, Geologist, Reviewer | must | M | low |
| 8 | "Export open questions": flags, illegible values and unconfirmed CRS or datum as a client clarification (RFI) list | Cross-cutting (queue, review, Project summary) | 4/5: Geotech, Geologist, Reviewer, Bid | should | S | medium |
| 9 | SPT as recorded: raw string, increments, N, refusal flag + penetration and unit, N rule, sum check | Extraction review, Borehole detail | 3/5: Geotech, Geologist, Reviewer | must | M | high |
| 10 | Confirm CRS once per document: candidates with a mini-map preview, confirmed by a named person | Extraction review | 3/5: Geotech, Geologist, Reviewer | must | M | high |

Next in line (3/5, must): project-level data export, Completeness check, per-value audit trail, tunnel horizon band and filter, explicit field states. The Completeness check missed the top 10 only on tie-breaks. It is the core user's first friction and part of their deal-breaker, so build it early.

Surprise: apart from "show me the source", the only need all 5 personas share is groundwater as a list of readings. The target format stores it as one number, and even the sales persona hit the gap.

## By screen

### World map

| Feature | Type | Personas | Priority | Effort | Notes |
|---|---|---|---|---|---|
| Tunnel alignment: upload, draw with chainage ticks, chainage + offset per borehole, "within X m" corridor filter | feature | 4/5: Geotech, TBM, Geologist, Bid | must | M | Top 10 #3. Start with KML and CSV (chainage, X, Y, crown level, diameter). DXF and LandXML make it L. Stored on the project. |
| "Not georeferenced" state: list the borehole, don't plot it | feature | 3/5: Geotech, Geologist, Bid | must | S | A plausible wrong pin is worse than none. Bid sees these holes as a data gap. |
| Georeference from 2–3 control points (residual in m), plus a site-plan overlay | feature | 2/5: Geotech, Geologist | must | L | The fallback when no CRS candidate fits. |
| KPI strip ("N projects · M boreholes · K countries") and a Projects / Boreholes toggle | feature | 1/5: Bid | must | S | At world zoom, one pin per project. |
| Presentation mode: hide controls, anonymise other clients' projects | feature | 1/5: Bid | must | M | Bid's deal-breaker. Needs the confidentiality fields (see Schema gaps). |
| "Colour by" dropdown: review status / ground class at tunnel level / max UCS / depth | feature | 3/5: Geotech, TBM, Bid | should | S | Nobody wanted colour by depth as the default. Default to review status (green / grey / amber, as in the design prompt). |
| Parameter availability chips with counts (e.g. UCS 5 · CAI 3 · RQD 14) | feature | 1/5: TBM | should | S | Replaces the vague "has rock data" filter. |
| Column picker for the results table (chainage, offset, elevation + datum, reaches invert, # UCS / # CAI in band) | feature | 1/5: TBM | should | S | |
| "My batch" and "Unreviewed" filter chips | feature | 1/5: Reviewer | should | S | Location outliers come from the lint (Extraction review). |
| Region chips and place search | feature | 1/5: Bid | should | S | |
| "Other projects" layer | feature | 1/5: Geotech | nice | S | Reuses holes from earlier bids nearby. Must respect confidentiality. |
| "Add to tender pack" basket (like the LGRB Merkliste) | feature | 1/5: Bid | nice | M | |

Map PNG export is under Cross-cutting (picture exports).

### Borehole detail

| Feature | Type | Personas | Priority | Effort | Notes |
|---|---|---|---|---|---|
| Groundwater readings table (type, date, depth, level + datum, source) | data field | 5/5: all | must | M | Top 10 #2. One ▽ per reading type, with a legend. A named person sets the design level, not the tool. |
| Rock head depth + elevation, and termination reason (in rock / refusal / target depth / abandoned) | data field | 3/5: Geotech, Geologist, Reviewer | must | S | Derived from the first rock layer, editable, linked to its source. Reviewer needs the termination reason only. |
| Lab tests: read multi-borehole lab tables, link rows by sample ID and depth, "Unlinked tests" list, Lab tests tab | feature | 2/5: Geotech, TBM | must | L | Linking happens in Extraction review. The tab shows sample, from/to, elevation, test, value, unit, method, status and source. |
| Hazard tags per layer: boulders/cobbles, cavities/karst, gas, obstructions, contamination | data field | 3/5: Geotech, TBM, Bid | should | M | Icon in the layer table. Feeds the "Worst ground" card. |
| Rock and soil fields: weathering grade, fracture frequency, SCR, vane shear strength | data field | 3/5: Geotech, TBM, Geologist | should | S | |
| Depth / Elevation axis toggle with a datum label and a "surface elevation missing" badge | feature | 2/5: Geotech, TBM | should | S | Without a reliable elevation, the tunnel band lands in the wrong place. |
| Core runs tab (from/to, TCR, SCR, RQD, fracture frequency), "derived" tag on averaged or moved values | feature | 2/5: Geotech, TBM | should | M | Core runs don't line up with layers. |
| Parameter track next to the profile: SPT N, UCS and RQD vs depth | feature | 2/5: TBM, Reviewer | should | M | Misread spikes jump out. |
| Plain-language one-line summary above the profile | feature | 1/5: Bid | should | S | Build it from approved fields with a template, not free text (see Conflicts). |

### Extraction review

| Feature | Type | Personas | Priority | Effort | Notes |
|---|---|---|---|---|---|
| SPT as recorded: raw · increments · N · refusal (blows / penetration + unit) · N rule, with a sum check | data field | 3/5: Geotech, Geologist, Reviewer | must | M | Top 10 #9. "50/30" is refusal, not N = 50. Refusal gets an "R" badge and an amber marker on the profile. |
| Confirm CRS once per document: candidates with a mini-map preview and shift vs the guess, confirmed with name and note | feature | 3/5: Geotech, Geologist, Reviewer | must | M | Top 10 #10. Reviewer can't pick a UTM zone, so add "Ask engineer" (see field states). |
| Bulk approve: "Approve all ≥ threshold", "Approve layer", "Approve all on this page" | button | 3/5: Geotech, TBM, Reviewer | must | S | Logged as bulk in the audit trail. Exclude guessed, OCR-unsure, flagged and lint-failing values (see Conflicts). |
| Plausibility and consistency lint: gaps, overlaps, log bottom vs final depth, SPT or GW below the end, out-of-range values, decimal-separator and location outliers | feature | 3/5: Geotech, TBM, Reviewer | must | M | Examples: UCS > 300 MPa, CAI > 6.5, RQD > 100 %, CAI "4,2" read as 42. Results feed the Completeness check. |
| Keyboard review flow: next / previous field, next uncertain field, approve, edit, flag, next borehole, `?` help | feature | 2/5: Geotech, Reviewer | must | M | Reviewer counts ~4,500 clicks for one batch without it. Add `B` (back to review) and `→` (next borehole) on Borehole detail. |
| Lithology in three lines: as printed / translation / DIN 4023 mapping | data field | 2/5: Geotech, Reviewer | must | S | Keeps "with cobbles and boulders" visible. A glossary that suggests the DIN code is nice to have. |
| Sheet stitching: "Sheets 1/3 ✓ 2/3 ✓ 3/3 ✓" chip, "Merge with…", "Split here" | button | 2/5: Geotech, Reviewer | must | M | Multi-sheet logs are where data silently disappears. |
| Investigation type per location: borehole / cored / open hole / sounding / test pit / hand auger / dynamic probe | data field | 2/5: Geotech, Reviewer | must | M | Changing it re-maps fields. Probe blows go to their own table, never to SPT. |
| Test method per lab value: direct UCS / from point load / estimated; CAI surface natural / sawn; Brazilian vs direct tensile | data field | 2/5: Geotech, TBM | must | S | Mixing point-load UCS with lab UCS corrupts the wear estimate. |
| Explain confidence: source-type badge (Read / OCR / Derived / Guessed / Edited) plus a one-line reason | feature | 2/5: Geologist, Reviewer | must | S | Replaces the bare % badge. In the Geologist walkthrough a green 90 % was wrong. |
| "Read from: column 'X'" label; highlight the whole row and its column header | data field | 1/5: Geologist | must | S | This is how the Geologist caught a sample depth read as a layer boundary. |
| Auto-follow source on field focus | feature | 1/5: Reviewer | must | S | Saves one click per field. |
| Project header panel: shared values shown once with "Apply to all boreholes", plus number format (decimal / thousands separator) | feature | 1/5: Reviewer | must | M | One wrong separator moves a value by a factor of 1,000. |
| "Move boundary" with an affected-values preview and a mandatory reason | feature | 1/5: Geologist | must | M | Changes both layers at once. The reason goes into the audit trail. |
| Review filters: "Show only uncertain / guessed / OCR / edited / flagged" and "Review lab values first" | button | 2/5: TBM, Geologist | should | S | Cuts thousands of fields down to the few dozen that matter. |
| Spot-check mode: all flags plus a random 10 % sample, each tick logged | feature | 1/5: Geologist | should | M | Should also sample bulk-approved values. |
| Source viewer tools: pop out to a second monitor, rotate (and apply to all pages of a form type), magnify box, zoom keys | feature | 1/5: Reviewer | should | M | Scans are unreadable at half a laptop screen. |
| "Find similar" misreads on the same template | button | 1/5: Geologist | nice | M | |

### Upload & queue

| Feature | Type | Personas | Priority | Effort | Notes |
|---|---|---|---|---|---|
| Page map: thumbnails coloured by page type, type override, unused pages with a reason, re-extract chosen pages | feature | 4/5: Geotech, TBM, Geologist, Reviewer | must | M | Top 10 #4. Reviewer's keys (rotate, change type, merge, split) add about another M. |
| Completeness check: expected vs found borehole IDs, "found" counts per data type, sheet gaps, unlinked lab rows | feature | 3/5: Geotech, TBM, Geologist | must | M | Expected IDs come from the report's summary table and site plan. Answers "is 0 CAI real, or did the tool miss them?" High demo value. |
| Assign, hand off and notify: assignee, due time, progress (reviewed / total fields), workload estimate, "My approvals" inbox | feature | 3/5: Geologist, Reviewer, Bid | should | M | Bid can't review and needs to hand work on. Geologist wants to land on what waits for them. |
| Processing progress, ETA and "Notify me when ready" | feature | 2/5: Geotech, Bid | should | S | |
| Hints box at upload (languages, CRS, datum) | feature | 1/5: Geotech | nice | S | |

The project picker at upload is under Cross-cutting (project as a first-class object).

### New screens suggested

| Feature | Type | Personas | Priority | Effort | Notes |
|---|---|---|---|---|---|
| Longitudinal section along the alignment | screen | 4/5: Geotech, TBM, Geologist, Bid | must | L | Top 10 #6. Opened from the alignment panel and from Borehole detail ("Compare neighbours"). Interpolated lines are dashed and labelled. Bid wants a simple chainage strip coloured by ground class. |
| Project summary: tender-brief cards (ground-class share, groundwater, worst ground, data gaps) and a ground-parameters table (n, min, P10, P50, P90, max per rock unit) | screen | 2/5: TBM, Bid | must | L | Computed over the tunnel horizon only. Every number taps through to its sources. Coverage stamp on every card. Cells turn amber when n < 5. |
| Similar / reference projects: "Find similar ground" search, match reason, TBM type used, "Can we name it?" tag, side-by-side box plots | screen | 2/5: TBM, Bid | must | L | Needs the project record fields (TBM type, diameter, year, cutter consumption). |
| Sign-off and revisions: "Approve & lock revision" in the review header, revisions list with diff and source-file fingerprint, version stamp on every export | screen | 2/5: TBM, Geologist | must | M | Any later edit opens a draft revision and removes the approved badge. |
| Review summary: % approved, flags, illegible values, unknown pages, missing sheets | screen | 2/5: Geotech, Reviewer | should | M | Doubles as the hand-off summary ("edited 212 · illegible 31 · escalated 9"). Home of "Export open questions". |
| Batch grid: one row per borehole, cells coloured by confidence, source crop on focus | screen | 1/5: Reviewer | should | L | For many one-page logs on the same template. |

### Cross-cutting

| Feature | Type | Personas | Priority | Effort | Notes |
|---|---|---|---|---|---|
| Provenance on every value, plus "Show source" from anywhere | feature | 5/5: all | must | M | Top 10 #1. Source file, page, box, column label, original text, method. Opens a crop panel on the same screen. |
| Approved-only by default, "Include unreviewed" toggle, DRAFT watermark | feature | 4/5: Geotech, TBM, Geologist, Bid | must | S | Top 10 #5. |
| Vertical datum as stated + offset to MSL, "datum unconfirmed" state | data field | 4/5: Geotech, TBM, Geologist, Reviewer | must | M | Top 10 #7. Over-water holes also need water depth and seabed level. |
| "Export open questions" as a client clarification (RFI) list | button | 4/5: Geotech, Geologist, Reviewer, Bid | should | S | Top 10 #8. Columns: borehole, page, question. |
| Tunnel horizon (crown to invert): band on the profile, "tunnel horizon only" filter, basis for every summary | feature | 3/5: Geotech, TBM, Bid | must | M | Comes from the alignment, or from a simple crown / invert depth when there is none (Bid). |
| Per-value history and audit trail: AI value, then who / when / old → new / reason; manual vs bulk vs auto | feature | 3/5: Geotech, Geologist, Reviewer | must | M | History tab plus a clock icon on edited fields. |
| Explicit field states: not in source / illegible / unsure → escalate to a named person | feature | 3/5: Geotech, Reviewer, Bid | must | S | Shown everywhere, including exports. A blank never means 0. |
| Review status chain (Extracted → Reviewed → Approved, with names) and a coverage stamp ("18 of 23 reviewed") | data field | 3/5: Geologist, Reviewer, Bid | must | S | On queue rows, map pins, detail, summary cards and exports. |
| Project-level data export: target-format xlsx plus a tidy long CSV (one row per value) with source, method, status and version columns | button | 3/5: Geotech, TBM, Geologist | must | M | Replaces one download per borehole. |
| Project as a first-class object: project picker and "New project" at upload; project record (alignment, diameter, TBM type, confidentiality) | feature | 3/5: Geotech, TBM, Bid | must | M | Enabler for the alignment, Project summary, similar projects and presentation mode. Low demo value on its own. |
| Ground class per layer (soft / mixed / weak rock / hard rock), derived and editable | data field | 3/5: Geotech, TBM, Bid | must | M | Feeds "Colour by", the share bar and a colour strip next to the DIN column. |
| Picture exports for decks: map PNG, section PNG / PDF, 1-page tender brief PDF, slides (.pptx) | button | 2/5: Geotech, Bid | must | M | Footer on every export: data basis, review coverage, date, DRAFT if needed. Section DXF later. |
| Evidence pack (PDF): each edited or flagged value with its crop, history and sign-off | button | 1/5: Geologist | should | M | The file for a later claims team. |
| "Viewer" role with Approve / Edit hidden | feature | 1/5: Bid | should | S | Stops sales from approving geotechnical data by accident. |
| Tablet layout with large tap targets (presentation mode, Project summary) | feature | 1/5: Bid | should | M | |
| Read-only API or "Copy as pandas snippet" for the current selection | feature | 1/5: TBM | nice | S | |
| Summary language switch (EN / DE / AR) | feature | 1/5: Bid | nice | M | |

## Schema gaps

Fields the personas need that the target format ([target-format.md](../design/target-format.md)) lacks. The test-results list in the target sheet ends with "…", so new test fields fit. The rest can go in extra columns or an extra provenance sheet, so the target sheets stay exactly as specified.

| Area | What the target format lacks | Needed by |
|---|---|---|
| Provenance | Per value: source file and fingerprint, page/sheet, box on the page, column or label it was read from, original string and unit, extraction method (text / OCR / derived / guessed), engine version | 5/5: all |
| Review | Status, confidence, reviewer, timestamp, manual / bulk / auto approval, edit history (who, when, old, new, reason) | 5/5: all |
| Review | Field state / null reason: not in source, illegible, not applicable, unsure | 3/5: Geotech, Reviewer, Bid |
| Review | Report revision, approver, approval date and scope, dataset version | 2/5: TBM, Geologist |
| Values | Qualifier (<, >, ≈, range) | 1/5: TBM |
| Source document | Consultant, report reference, report revision, issue date | 1/5: Geologist |
| Source document | Number format / locale (decimal and thousands separator) | 1/5: Reviewer |
| Location | Vertical datum name, offset to MSL, original value before conversion | 4/5: Geotech, TBM, Geologist, Reviewer |
| Location | Chainage and offset from the alignment | 4/5: Geotech, TBM, Geologist, Bid |
| Location | CRS as an EPSG code or zone, status (stated / inferred / confirmed), confirmed-by, original coordinate strings | 3/5: Geotech, Geologist, Reviewer |
| Location | Inclination and azimuth for inclined holes | 2/5: Geotech, TBM |
| Location | Water depth, seabed level and drilling platform for over-water holes | 1/5: Geologist |
| Location | Country / region (LocationName is free text) | 1/5: Bid |
| Borehole | Investigation type (borehole, cored, open hole, sounding, test pit, hand auger, dynamic probe) and drilling method | 2/5: Geotech, Reviewer |
| Borehole | Termination reason (target depth, refusal, in rock, abandoned) | 2/5: Geotech, Reviewer |
| Borehole | Rock head depth and elevation | 2/5: Geotech, Geologist |
| Borehole | Sheet continuation (sheet x of y) | 2/5: Geotech, Reviewer |
| Layers | Explicit top and bottom depth fields (the sheet only implies them) | 2/5: Geotech, Reviewer |
| Layers | Derived ground class (soft soil / mixed / weak rock / hard rock) | 3/5: Geotech, TBM, Bid |
| Layers | Hazards: boulders/cobbles (and max size), cavities/karst, gas, obstructions, contamination | 3/5: Geotech, TBM, Bid |
| Layers | Weathering grade | 2/5: Geotech, Geologist |
| Rock mass | Fracture frequency, SCR, joint spacing, joint orientation relative to the tunnel axis | 2/5: Geotech, TBM |
| Rock mass | Core runs as their own interval table (TCR / SCR / RQD per run, not per layer) | 2/5: Geotech, TBM |
| In-situ tests | SPT detail: raw notation, seating and test increments, increment length, penetration at refusal and its unit, refusal flag, reported N vs N used, N rule, test depth top/bottom, hammer type or energy ratio | 3/5: Geotech, Geologist, Reviewer |
| In-situ tests | Dynamic probe results (blows per 0.3 m) in their own table | 1/5: Reviewer |
| In-situ tests | Vane shear strength (peak and remoulded) | 1/5: Geologist |
| Groundwater | A list of readings instead of one number: date/time, type (strike / rest / standpipe / piezometer / perched / tidal), depth, level, datum, artesian flag | 5/5: all |
| Groundwater | Chemistry (chloride, sulphate, pH) | 1/5: Bid |
| Lab tests | Sample ID, depth from/to (not a single SampleDepth), test standard | 2/5: Geotech, TBM |
| Lab tests | Test method (direct / from point load / estimated), number of specimens, moisture state, loading direction relative to foliation | 2/5: Geotech, TBM |
| Lab tests | Point load index Is50 as its own field | 2/5: Geotech, TBM |
| Lab tests | Tensile strength method (Brazilian vs direct) | 2/5: Geotech, TBM |
| Lab tests | Wear and boreability: quartz / equivalent quartz content, DRI, CLI, Sievers J, AVS; LCPC abrasivity and breakability for soils | 2/5: Geotech, TBM |
| Lab tests | CAI conditions: surface (natural / sawn), stylus hardness, standard | 1/5: TBM |
| Lab tests | Full grading: D10, D50, D60; gravel / sand / silt / clay % | 1/5: TBM |
| Project record | Alignment geometry, tunnel length, diameter, tunnel horizon (crown / invert) | 3/5: Geotech, TBM, Bid |
| Project record | TBM type used, machine reference, year, outcome, lessons learned, actual cutter consumption | 2/5: TBM, Bid |
| Project record | Confidentiality: data owner, sharing permission (internal / anonymised / public), client-safe display name | 1/5: Bid |

## Conflicts

| Conflict | Who wants what | Suggested resolution |
|---|---|---|
| Detail vs simplicity | TBM and Geologist want raw strings, P10/P90, test method and history on every value. Bid doesn't read logs and wants one plain page. | Two layers over the same data. Bid lands on Project summary with plain cards, and every number taps through to the engineer view. Engineers keep the dense tables. The role sets the default landing page. |
| Bulk approval vs distrust of confidence | Geotech ("Approve all ≥ 90 %") and Reviewer (`Shift+Enter`) want to approve clean fields in bulk. Geologist says the % is uncalibrated: a green 90 % was wrong. | Allow bulk approve, but log it as "bulk" in the audit trail. Exclude anything guessed, OCR-unsure, derived, flagged or failing the lint. Show the source-type badge first and use the % only to sort. Spot-check mode samples bulk-approved values. |
| Fresh data vs approved data | Bid wants to use a report that finished processing an hour before the meeting. Geologist says only approved data may reach the commercial team. TBM wants unreviewed values off by default. | Approved-only by default. "Use as draft" is allowed, but every card and export then carries a DRAFT watermark and a coverage stamp. Presentation mode can't hide the watermark. |
| A full map vs only confirmed pins | Bid wants a rich world map with every project for the experience slide. Geotech and Geologist say a pin from a guessed CRS must not be plotted. | Plot only confirmed locations at borehole zoom. At world zoom a project pin can sit at the project's stated city or region, which is safe while the CRS is still open. KPI counts still include unplotted holes, with a "3 not georeferenced" note. |
| Reuse across projects vs client confidentiality | Geotech ("Other projects" layer) and TBM (compare projects, find similar ground) want every past project visible. Bid must never show another client's project names or IDs. | Store a sharing permission per project. Internal views show everything. Presentation mode and every client-facing export anonymise by that permission ("Metro · Middle East · 2021"). |
| Export format | Geotech and Geologist want the standard xlsx in the target format. TBM wants a tidy long table, one row per value, for their Python tools. | Offer both from the same data. Keep the target-format sheets exactly as specified and put provenance in extra columns or an extra sheet. Stamp both with the dataset version. |
| Keyboard-dense vs touch-friendly | Reviewer wants a dense, keyboard-first review screen on a laptop plus a second monitor. Bid presents from a tablet and wants large tap targets. | Different screens, different rules. Review stays dense and keyboard-first. Large tap targets only in presentation mode and on Project summary. |
| Tool-computed vs human-set values | Bid wants the tool to state "max head at invert" and a plain-language summary. Geologist says a named person sets the design groundwater level. Geotech's deal-breaker is a confident value that isn't in the source. | The tool computes from readings and shows its basis ("from 4 standpipe readings"). The design level is a separate field a person sets. Plain-language text is built from approved fields with a template, not free LLM text, and each phrase links to its source. |
| How much to invest in the world map | Bid calls the map the opener of every pitch. Geotech, Geologist and Reviewer call it a demo or navigation step, and nobody wants colour by depth. | Keep the map as the landing page and demo opener, but limit new map work to "Colour by", presentation mode, the alignment overlay and map export. Engineers get deep links and the project as their entry point. |

## Time saved (simulated estimates)

| Persona | Today | With Bormisu |
|---|---|---|
| 01 Geotechnical engineer (core user) | ~23–25 h hands-on, about 3 working days. In practice Friday night plus the whole weekend, skipping far-off holes and rushing the scanned block. (persona estimate) | ~6 h hands-on plus ~30 min background processing, done Friday night or Saturday morning, if the musts are built. 15–18 h with the 4 screens as planned. (persona estimate) |
| 02 TBM design engineer | 2–3 working days, and they still cut corners: one reference project instead of three, and no check of the lab sheets. (persona estimate) | About half a day, 3–4 h hands-on, with extraction running unattended. Add 1–2 h of review per reference project not yet in the database. (persona estimate) |
| 03 Senior geologist | 8–10 h of their own time per 14-borehole report over 2 days, on top of a colleague's 2–3 days of retyping. Half a day to a day to answer a later claim. (persona estimate) | ~3 h in one sitting if the musts are built, and 15–30 min to answer a later claim. Without the musts the tool adds time, because the full paper check still happens. (persona estimate) |
| 04 Data reviewer | ~15 h for both batches (~6 h + ~9 h). The 17:00 deadline can't be met. (persona estimate) | ~5.5 h with the musts, done around 16:00. ~10 h with the concept as drawn, still past 17:00. (persona estimate) |
| 05 Bid manager | 2–3 working days of a geotechnical engineer plus about half a day of their own. With 1 hour they get about a third of it. (persona estimate) | 15–20 min if the reports are already reviewed. Add 15–30 min of processing for a new report, and the brief stays DRAFT until an engineer reviews it. (persona estimate) |

All figures are estimates made by simulated personas, not measurements. Each engineering persona said the savings depend on the "must" features. With only the 4 screens as planned, the gain shrinks, and for the approver it disappears.
