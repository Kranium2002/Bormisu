# 01 · Geotechnical engineer, tender phase (core user)

Civil/geotechnical engineer, about 6 years in the Geotechnics & Tender team at Herrenknecht HQ in Schwanau. They work on two monitors and are an Excel power user. They read gINT logs, know some GIS, and turn client site-investigation reports into the ground model that a TBM bid is built on.

## Scenario

- **Project:** Project Nordlys Metro. This is a fictional 6.5 km metro extension in a fictional Nordic city. It has a single-bore TBM tunnel, two underground stations and one stretch under a river where the rock cover is thin. The client is a fictional city transit agency.
- **Input:** the report arrives Friday at 15:00. It is about 150 pages long:
  - The body is native text. A block of about 40 scanned pages sits in the middle.
  - Newer logs are in English. Older logs in the scanned block are in Norwegian.
  - Coordinates are in a local city grid, and the CRS is not stated.
  - Several logs run over 2–3 sheets. Some points are rock soundings that only give the depth to rock.
  - The lab results (UCS, Brazilian tensile, CAI) are in one summary table in an appendix.
- **Deadline:** the tender is due **Monday at 12:00**. The client's tender Q&A desk is closed until Monday at 08:00.
- **What's at stake:** this data decides:
  - the TBM type: EPB for clay and till, a hard-rock shield for gneiss, or a mixed-ground shield if the tunnel crosses the rock head
  - the cutterhead design: disc cutters and how to handle boulders
  - the cutter-consumption line in the price, which depends on UCS and CAI
  - the pressure rating, which depends on groundwater at the tunnel axis
  - the risk premium for mixed-face sections
  
  If one borehole near the river crossing is missed, a dip in the rock head can be missed too. That means the wrong machine or an underpriced bid.

## Today, without Bormisu

| Step | How I do it now | Time (persona estimate) |
|---|---|---|
| Find the logs | Scroll 150 pages and note where the appendices start. Count holes from the summary table and site plan. Ctrl+F does nothing in the scanned block. | 1.5 h |
| Native-text logs (~25) | Copy-paste into my Excel template. Columns come out scrambled, so it is half retyping. | 6 h |
| Scanned Norwegian logs (~13) | Retype by hand and translate soil descriptions word by word. | 7.5 h |
| Lab tests | Retype the UCS, tensile and CAI table and match each row to a borehole and depth by sample ID. | 2 h |
| Unstated CRS | Try candidate grids in QGIS until the holes line up with the streets on the site plan. | 1–2 h |
| Longitudinal section | In Excel or CAD: chainage on the x-axis, boreholes as bars, rock head and groundwater lines by hand. | 3–4 h |
| Cross-check | Count holes, look for missing sheets, re-read suspicious values. | 1.5 h |
| **Total** | | **~23–25 h (persona estimate)** |

In reality that is Friday night plus the whole weekend. I triage: holes far from the alignment get skipped, and the scanned Norwegian block gets done last, when I'm tired. That is where the errors come from.

## Walkthrough

| # | Screen | I do | I expect | What happened / friction | Need (button/feature) |
|---|---|---|---|---|---|
| 1 | Upload & queue | Drag the 150-page PDF onto the drop zone. | A page count and an ETA. Ideally a strip of page thumbnails coloured by type: log, lab table, text, drawing, photo. | The planned queue has one row per document, a status (classifying → extracting → needs review → done) and a borehole count. For 150 pages that is a black box. I can't see which pages it treats as logs, or whether the scanned block was read at all. With no ETA, I don't know whether to wait or start typing by hand as a fallback. | **Page map** strip under the document row: one cell per page, coloured by detected type. Click opens the page. Right-click overrides the type ("this is a log", "skip"). **ETA** and a **"Notify me when ready"** toggle on the row. |
| 2 | Upload & queue | Look for a way to file this under Project Nordlys Metro and attach the alignment. | A project picker in the upload dialog and an "Add alignment" slot. | There is none. The concept has no project object at upload, only a project filter on the map later. The boreholes land as loose points. I also can't pass on what I already know ("EN + Norwegian", "local city grid"). | **Project** dropdown plus **"New project"** in the upload dialog. **"Upload alignment"** button on the project (KML, DXF, or CSV with chainage/X/Y/Z). An optional **Hints** box for languages, CRS and datum. |
| 3 | Upload & queue | Processing finishes: "38 boreholes found, needs review". | To know whether 38 is right. The report's summary table and site plan list every hole. | "38 found" means nothing on its own. If the report lists 44 holes, 6 are missing and I would never know. This is the core of "nothing was missed", and no planned screen covers it. | New **Completeness** panel, opened from the queue row. It shows the IDs expected from the summary table and site plan against the IDs found: missing ones in red, unexpected ones in amber. It also counts pages typed "unknown", sheet gaps ("sheet 2 of 3 not found") and lab rows not linked to a borehole. |
| 4 | Extraction review | Open NM-121. Its log runs over three sheets, and one of them is in the scanned block. | One borehole, three sheets stitched, depth continuous from 0 to 38 m. | The concept doesn't show whether stitching happened. Worst cases: NM-121 appears twice, or the log stops at 14.5 m and nobody notices, because the header says 38 m final depth. | A chip in the review header: **"Sheets 1/3 ✓ 2/3 ✓ 3/3 ✓"**, each linked to its page. An automatic red warning: **"Log bottom 14.5 m ≠ final depth 38.0 m"**. **"Merge with…"** and **"Split here"** buttons in the header. |
| 5 | World map | Open the map to see the holes along the alignment. | Points along a line through the city. | The CRS is unstated. The concept shows a CRS guess with a warning per borehole, in review. The guess will put the points in the sea or in the wrong country. Worse, it might put them 500 m off in the right city, which looks plausible. Fixing it 38 times in review is absurd. | **"Set CRS for all boreholes in this document"** on the document or project. A **Georeference** tool: click 2–3 holes on the report's site plan, click their real positions on the map, and the tool fits the grid and shows the residual in metres. Holes without a confirmed CRS get a **"Not georeferenced"** state. They are listed, not plotted. |
| 6 | Extraction review | Start on the first native-text English log. | Page on the left, fields on the right, confidence badges. Clicking a field highlights its box on the page. | This part is good. It is the reason I'd try the tool. But approval is field by field. 38 holes × ~12 layers × ~8 fields is several thousand clicks, which won't happen by Monday. | **"Approve all ≥ 90 %"** button at the top of the field list, next to a confidence filter. Row-level **"Approve layer"**. A **"Next uncertain field"** button. Keyboard shortcuts: J/K to move, A to approve, E to edit, F to flag, N for next uncertain. |
| 7 | Extraction review | Review a scanned Norwegian log. A layer reads roughly "morene, siltig, med stein og blokk". | The original text, an English translation and the mapped DIN soil name, all visible at once. | The concept shows the original value next to the normalised one for numbers (Cota → mASL). For descriptions it doesn't say. If I only see "till, silty", I lose "with cobbles and boulders". Boulders decide the cutterhead design. I want to judge old local terms myself. | A **three-line lithology cell**: as printed / translation / DIN mapping. A **"Boulders/cobbles"** tag extracted per layer, shown as an icon in the layer table. |
| 8 | Extraction review | Check the SPT values. The logs use "4,5,5 = 10" style, plus a refusal written as "50/8 cm". | N = 10 with the raw string next to it. Refusal clearly marked as refusal. | The target format stores SPT as one number. "50/8 cm" saved as 50 tells the design team "very dense". It may actually be a boulder or the rock head, which changes the interpretation. | The SPT cell shows the **raw string**, seating blows, test blows, N and a **"Refusal"** flag. Refusals get an amber marker on the profile. |
| 9 | Borehole detail | Look for the depth to rock in each hole. | Rock-head depth and elevation in the metadata card. | The detail screen shows layers, SPT, RQD and TCR. The most important number for a TBM tender is where soil stops and rock starts, and it isn't a field. I'd have to read it off each profile. The rock soundings only give depth to rock, and I'm not sure the tool even counts them as boreholes. | A **"Rock head: 11.2 m / +23.4 m"** row in the metadata card, editable and linked to its source. A **Termination** field (in rock / refusal / target depth). A **Borehole type** field (cored / open hole / sounding / test pit), plus a map filter on it. |
| 10 | Extraction review | Find the lab tests. UCS, tensile and CAI sit in one appendix table covering all holes, keyed by sample ID and depth. | Each test linked to its borehole and depth, and visible in the detail view. | The 4 screens assume one log page = one borehole. A lab table covering 30 holes doesn't fit, and the concept doesn't say whether it is read or linked. These values drive cutter wear and the price. Without them the export is useless to me. | A review mode for **multi-borehole tables**: each row shows its matched borehole, depth and a confidence. An **"Unlinked tests"** list with a **"Link to borehole…"** button. A **Lab tests** tab on Borehole detail, next to the layer table. |
| 11 | Borehole detail | Look at the profile of a key hole by the river crossing. | A DIN 4023 column on an elevation axis, a groundwater marker, and where the tunnel sits in this hole. | The profile and the synced table are readable and fine. But the axis is depth only and the tunnel isn't shown. I need to see "crown in clay, invert in gneiss" at a glance. | A **Depth / Elevation** axis toggle above the profile. A **tunnel band** (crown to invert) across the profile when an alignment is loaded. Lab-test markers on the axis. |
| 12 | (missing) Alignment section | Build the picture for the design team. | Boreholes placed by chainage, the tunnel drawn at design level, a rock-head line and a groundwater line. | This screen doesn't exist. The world map is the wrong scale, and the detail screen shows one hole. So I would export and go back to Excel or CAD for the one picture the briefing needs. | New screen **Alignment section**: x = chainage, y = elevation. Each hole is a narrow DIN column at its chainage, labelled with its offset ("12 m L"). The tunnel is drawn at design level. Rock-head and groundwater lines are dashed between holes and labelled "interpolated". Clicking a column opens Borehole detail. **"Export PNG / PDF / DXF"** button at the top right. |
| 13 | World map | Filter to the project and look for older data nearby. | A project filter, and maybe holes from an earlier bid in the same city. | Colouring by depth is useless to me. For this task the world map is mostly a demo screen. Its one real value would be showing holes we already have near this alignment from earlier bids. | A **"Colour by"** dropdown in the legend: review status / ground at tunnel level (soil, rock, mixed) / max UCS / depth. A **"Within X m of alignment"** filter. An **"Other projects"** layer toggle. |
| 14 | Borehole detail | Export everything to the standard xlsx. | One workbook for the whole project: metadata, layer logs and tests for all holes. | The export button is on Borehole detail, so it is one borehole at a time: 38 downloads and a manual merge. It's also unclear whether a blank means "not in source" or 0, and whether unreviewed values are marked. | An **"Export project (xlsx)"** button above the map results table and on the project. Options: "approved only" or "include unreviewed (marked)". Extra columns for source file, page and review status. A blank always means "not in source", never 0. |
| 15 | (missing) Review summary | Before sending the briefing, check what I haven't reviewed and what to ask the client. | % reviewed, flagged fields, open issues in one place. | Flags exist in review, but nothing collects them. On Monday at 08:00 I have to send the client clarification questions about the CRS, missing sheets and unreadable values. | A **Review summary** on the project: % of fields approved, flagged list, unknown pages, missing sheets. An **"Export open questions"** button that turns flags into a client RFI list (borehole, page, question). |

## Top frictions

1. **No completeness check.** I can't say "nothing was missed". The concept has no expected-vs-found borehole list, no sheet-gap check, no list of unread pages and no list of orphan lab tests. That is the one promise I need, and the concept doesn't make it.
2. **No alignment section.** The briefing needs a longitudinal section by chainage, with the tunnel level and the rock head. The world map is a demo, not a work tool. Without the section I'm back in Excel/CAD for the most important output.
3. **Unstated CRS is handled per borehole.** I need one document-wide fix and georeferencing from control points. Unconfirmed points must not be plotted, because a plausible wrong position is worse than none.
4. **Review doesn't scale.** Field-by-field approval of thousands of values won't fit in a weekend. I need bulk approve by confidence, keyboard shortcuts and "next uncertain field", so my time goes to the doubtful values only.
5. **Tender-critical data has no home, and export is per borehole.** Rock head, SPT refusal vs N, boulders and lab tests from multi-borehole tables are not modelled. The xlsx export is one hole at a time.

## Wishlist

| Feature | Type | Screen | Priority | Why |
|---|---|---|---|---|
| Completeness panel: expected vs found IDs, sheet gaps, log bottom vs final depth, unknown pages, unlinked lab rows | screen | Upload & queue (new panel) | must | "Nothing missed" is what I sign off on, and I can't prove it today either. |
| Page map strip with page-type override | feature | Upload & queue | must | I need to see what was read and fix a misclassified page in one click. |
| Project picker and "Upload alignment" (KML / DXF / CSV) | feature | Upload & queue | must | Everything I brief is relative to the alignment. |
| "Set CRS for all boreholes in this document" | button | Extraction review | must | One unstated grid and 38 holes: fix it once, not 38 times. |
| Georeference from 2–3 control points (site plan ↔ map), with residual in m | feature | World map | must | The only way to place an unstated local grid with confidence. |
| "Not georeferenced" state: list, don't plot | feature | World map | must | A plausible wrong point is worse than no point. |
| "Approve all ≥ 90 %" and "Approve layer" | button | Extraction review | must | Thousands of values, one weekend. |
| "Next uncertain field" and keyboard shortcuts (J/K/A/E/F/N) | feature | Extraction review | must | Review time should go to the doubtful values only. |
| Sheet-stitching chip ("Sheets 1/3 ✓…"), "Merge with…" and "Split here" | button | Extraction review | must | Multi-sheet logs are where data silently disappears. |
| Lithology as printed / translation / DIN mapping | data field | Extraction review, Borehole detail | must | I need to judge the original Norwegian wording myself. |
| SPT raw string, seating/test blows and refusal flag | data field | Extraction review, Borehole detail | must | "50/8 cm" is not N = 50. It may be a boulder or rock. |
| Rock head depth/elevation, termination reason, borehole type | data field | Borehole detail | must | The soil/rock interface decides the TBM type and the mixed-face risk. |
| Lab-test linking for multi-borehole tables, "Unlinked tests" list, Lab tests tab | feature | Extraction review, Borehole detail | must | UCS and CAI drive cutter wear and the tender price. |
| Alignment section (chainage × elevation, tunnel, rock head, groundwater) | screen | New: Alignment section | must | This is the picture I brief the design team with. |
| "Export project (xlsx)" with source page and review status columns | button | World map (results table) | must | One workbook for the whole project, not 38 downloads. |
| "Export PNG / PDF / DXF" of the section | button | Alignment section | should | It goes straight into the briefing deck and into CAD. |
| Review summary (% approved, flagged, unknown pages, missing sheets) | screen | New: Review summary | should | Shows me and my lead what is still open before Monday. |
| "Export open questions" (flags → client RFI list) | button | Review summary | should | I send the client clarification questions first thing Monday. |
| Depth / Elevation axis toggle and tunnel band on the profile | feature | Borehole detail | should | Shows at a glance what the cutterhead will face in this hole. |
| Boulders/cobbles tag per layer | data field | Extraction review, Borehole detail | should | Boulders drive cutterhead and crusher design. |
| Groundwater as a list of readings (date, type, level) | data field | Borehole detail | should | One number hides artesian or seasonal water, and pressure at the axis sets the machine concept. |
| "Colour by" dropdown (review status / ground at tunnel level / max UCS / depth) | feature | World map | should | Colouring by depth tells me nothing for a tender. |
| "Within X m of alignment" filter and "Other projects" layer | feature | World map | nice | Lets me reuse holes from our earlier bids in the same city. |
| ETA and "Notify me when ready" | feature | Upload & queue | nice | I can do other work while 150 pages process. |
| Hints box at upload (languages, CRS, datum) | feature | Upload & queue | nice | I often know the grid better than the guess does. |

## Schema gaps

- **Layer depths:** explicit layer top and bottom depth fields. The sheet only implies them.
- **Rock head:** depth and elevation of the rock head. A termination reason (target depth / refusal / in rock). A borehole type (cored / open hole / sounding / test pit).
- **Location:**
  - the elevation datum name and its offset to MSL
  - the CRS as an EPSG code, plus a "stated / assumed" flag
  - chainage and offset from the alignment
  - inclination and azimuth for inclined holes
- **SPT:** the raw string, seating blows, test blows, a refusal flag and the penetration at refusal.
- **Groundwater:** a list of readings instead of one number. Each reading needs a date, a type (strike / rest / standpipe / piezometer) and a level. Add an artesian flag.
- **Ground features:** boulders/cobbles present and their max size, weathering grade, fracture frequency and SCR. Core-run intervals need to be stored separately from layers, because TCR and RQD are measured per run, not per layer.
- **Cuttability and abrasivity beyond UCS/CAI:** point load index (Is50), quartz or equivalent quartz content, and LCPC abrasivity for soils. "Tensile strength" also needs its test method (for example Brazilian).
- **Lab-test metadata:** sample ID, depth from/to and test standard.
- **Provenance per value:** source file, page, box, original text, confidence, review status, reviewer and timestamp.

## Deal-breaker

If it ever shows a confident value that isn't in the source, or silently drops a borehole, a sheet or a lab row, I'm back in Excel the same day, because I sign the ground model the tender price is built on.

## Pitch quote

(simulated) "I don't need it to be perfect. I need it to show me the page behind every number and the pages it couldn't read, so I can sign off the ground model before the weekend instead of during it."

## With Bormisu

| Step | Time (persona estimate) |
|---|---|
| Upload, pick the project, attach the alignment | 10 min (then ~30 min processing in the background) |
| Page map and completeness check | 20 min |
| Georeference the local grid with control points | 15 min |
| Review ~25 native-text logs (bulk approve, then only the uncertain fields) | ~1 h 40 min |
| Review ~13 scanned Norwegian logs | ~2 h 10 min |
| Link and check lab tests | 30 min |
| Alignment section and design-team briefing | 45 min |
| Project xlsx export and client RFI list | 15 min |
| **Total** | **~6 h hands-on (persona estimate)** |

That means I'm done Friday night or Saturday morning instead of on Monday morning. My review time goes to the scanned block, where the errors actually are. With only the 4 screens as planned, I'd estimate 15–18 h (persona estimate). Retyping gets faster, but the CRS, the section, the completeness check and the export merge stay manual.
