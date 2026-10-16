# 03 · Senior engineering geologist (skeptic and approver)

Engineering geologist with 25 years in tunnelling ground investigation. They give the final geotechnical sign-off before ground data goes into a binding Herrenknecht tender.
They distrust AI extraction by default, mark up PDFs and printouts by hand, and have moderate tech comfort. They drop a tool the first time a value can't be traced to its source.

## Scenario

Simulated persona. All project names, client names, borehole IDs and values below are fictional.

- **Project:** Harbour Crossing (fictional). A 2.6 km bored road tunnel, 13 m diameter, under a harbour channel. The client is the Kestrelmouth Port Authority (fictional).
- **Ground:** soft to very soft marine clay over completely to highly weathered sandstone, with fresher rock below. About a third of the drive is in mixed face.
- **Input:** the consultant's factual ground investigation report, Rev 1 (Brindlecove Geotechnics, fictional). 14 boreholes, HC-01 to HC-14. Six were drilled over water from a jack-up. Five logs are scans, two of them skewed. Several logs run over 2–3 sheets. SPT is written in mixed notation: "4,5,5 = 10" style and refusals like "50/30". The coordinate system is not stated. Levels are given against chart datum.
- **What happened so far:** a colleague ran the report through Bormisu yesterday and reviewed it. Now it's on my desk.
- **Deadline:** my sign-off is due Wednesday 17:00. The commercial team prices on Thursday. The bid goes out Friday 12:00.
- **Decisions this data feeds:**
  - TBM type: slurry mixshield or EPB.
  - Face support pressure and seal rating, which depend on groundwater and tidal head.
  - Cutterhead layout and disc-cutter wear. The rock-head depth along the alignment sets the mixed-face length. CAI and UCS in the weathered rock set the wear rate.
  - The geotechnical baseline assumptions in our offer.
- **Stakes:** if the rock head is 2 m off in one borehole, the mixed-face length, cutter changes and programme are all wrong. A wrong number I signed can become a contract claim worth millions. My name is on it.

## Today, without Bormisu

1. A colleague retypes the logs into the Excel template. That takes 2–3 days for 14 boreholes. It's not my time, but I inherit their typos.
2. I print the logs and the spreadsheet. I tick every value I check with a pen and highlight the ones I doubt. I check 100% of the critical values: rock head, groundwater, SPT in the transition zone, coordinates and levels. I sample about 20% of the rest.
3. I plot the boreholes on the site plan drawing by hand to check the coordinates. I sketch a section along the alignment to see if the rock head makes sense.
4. Questions go back to the colleague by email. They correct the spreadsheet, and I check again.
5. I sign a cover sheet and scan my marked-up printouts into the project folder. That scan is my defence later.

**Time (persona estimate):** about 8–10 hours of my own time per report of this size, spread over 2 days. If a claim comes later, rebuilding "why did we use this value" takes half a day to a day of digging through binders and email.

## Walkthrough

| # | Screen | I do | I expect | What happened / friction | Need (button/feature) |
|---|---|---|---|---|---|
| 1 | Upload & processing queue | Open the link my colleague sent. | To land on the Harbour Crossing report with the status "Reviewed, awaiting approval". | The link opens the world map, so I have to search for the project. The queue only says "done". It doesn't say who reviewed it or that it's waiting for me. | A **"My approvals" inbox** as the landing page for approvers, plus deep links to a report. A per-report **status chain**: Extracted (AI, time) → Reviewed (name, time) → Approved (name, time). |
| 2 | Upload & processing queue | Check that the tool found all boreholes and pages. | "Report lists 14 boreholes, 14 extracted", plus a list of pages the tool did not use. | The queue says "14 boreholes found". I can't tell if the report has 14 or 15. A missed borehole is worse than a wrong value because it leaves a hole in the baseline. There is no list of skipped pages. | A **"Coverage" panel** on the queue row: boreholes named in the report (location plan, summary table) vs boreholes extracted, with mismatches in red. A **"View unused pages"** button with thumbnails and a reason for each ("lab sheet", "photo", "unreadable"). |
| 3 | World map | Zoom to the harbour and check where the 14 points sit. | Points along the planned alignment, with the over-water holes in the channel. | The points look plausible, but I can't tell if they're right or just near the place name. There's no alignment and no site plan to compare against. For this job the world map is only a navigation step. I learn nothing from it. | An **"Overlay" button** in the map toolbar: upload the alignment (KML/DXF) or georeference the report's site plan as a semi-transparent layer. Show chainage on hover. |
| 4 | Extraction review | Open the coordinate block for HC-07. | "CRS: not stated in source" in red, the guess, why it was guessed, and what else it could be. | One line: "UTM zone 31N (guess) ⚠" with an 81% badge. 81% of what? A warning icon isn't a check. I'd also have to confirm it 14 times, once per borehole. | A **"CRS candidates" dropdown** next to the field. Each candidate gets a map preview and its shift against the guess, e.g. "local harbour grid: +412 m E". A **"Check against control point"** input for a known point from the site plan. A **"Confirm CRS for whole report"** button with a mandatory note and my name stored. |
| 5 | Extraction review | Check the surface level of over-water hole HC-07. | The original "Seabed −6.40 m CD" with the datum named, and the water depth at the time of drilling. | The normalised field shows "−6.40 mASL". The tool silently treated chart datum as sea level. Here CD is about 1.8 m below MSL (fictional). Every rock-head elevation inherits that error. | Fields for **"Vertical datum (as stated)"**, **"Offset to MSL + source"** and **"Water depth / seabed level"**. Show the datum next to every elevation. If the datum is unknown, show an amber "datum unconfirmed" state, never a silent mASL. |
| 6 | Borehole detail | Open HC-07's profile and layer table. | The rock head (clay → weathered sandstone) in line with HC-06 and HC-08, about 18–19 m below seabed. | The profile shows the boundary at 16.20 m. It looks wrong, but I only notice because I remember the neighbours. The screen shows one borehole at a time. This boundary sets the mixed-face length, so it drives cutter wear and programme. | A **"Compare neighbours" button** above the profile. It shows the 2 nearest boreholes on each side at the same depth/elevation scale, with a rock-head line joining them. Better still, a **"Section along alignment" screen** (see wishlist). |
| 7 | Borehole detail | Click the 16.20 m boundary to see where it came from. | A side panel with the scan crop and the highlighted box, plus page and sheet ("sheet 2 of 3, p. 47"). | Nothing happens. Source links exist only on the review screen. There, a boundary isn't even a single "field": it's the "to" of one layer and the "from" of the next. | A **"Show in source" icon** on every value in the layer table and every boundary in the profile. It opens a source-crop panel on the same screen, with no screen switch. |
| 8 | Extraction review | Compare the highlight on the scan with the strata column. | The highlight sits on the strata depth column. | The highlight sits on the sample-depth column. The sheet is skewed, so the tool took 16.20 (an undisturbed sample, U-4) instead of 18.60 (the strata boundary). The badge is green, 90%. So green doesn't mean right. | Show **"read from: column 'Sample depth'"** next to the value, using the original column label. Highlight the whole row and its column header, not just the number. |
| 9 | Extraction review | Correct the boundary to 18.60 m. | One edit moves both layers, elevations and thickness update, and I must give a reason. | The concept has a plain "Edit" button. It's not clear if layer 4's "from" updates too, or if the profile redraws. There's no reason field. Nothing tells me if the same misread happened on the other skewed sheets. | A **"Move boundary"** action that changes both layers and previews the affected values (thickness, elevation, profile). A **mandatory reason dropdown** (wrong column / OCR digit / sheet stitching / other) plus a comment. A **"Find similar"** button that lists values read from the same column type on skewed pages. |
| 10 | Borehole detail | Check SPT in the transition zone of HC-07 and HC-11. | The raw notation as written ("50/30", "4,5,5 = 10"), refusal clearly marked, and the penetration with its unit. | The SPT column shows "50". That reads like a dense layer with N = 50, not refusal after 30 mm. In one log "50/30" may mean 30 cm, and the unit is a guess that nothing flags. Dense soil vs weathered rock changes the cutter choice. | An SPT cell that shows the **raw string plus an "R" refusal badge**. A tooltip with seating and test increments, penetration and unit (stated or assumed), reported N and N used. A **"Show all refusals"** filter on the layer table. Never show an extrapolated N without a marker. |
| 11 | Borehole detail | Check groundwater on land hole HC-02 and over-water hole HC-07. | All readings: the water strike while drilling, the rest level after 24 h, standpipe readings with dates, and a tide note for over-water holes. | One ▽ marker and one number (2.10 m). I can't tell if it's a strike, a rest level or a standpipe reading, or its date or datum. For HC-07 a "groundwater level" makes no sense because it's tidal. Face pressure and seal rating depend on this. | A **"Groundwater readings" table** on the detail screen: type, date/time, depth, elevation + datum, source link. The profile shows one ▽ per reading type, with a legend. A named person sets the **"Design level"**, not the tool. |
| 12 | Extraction review | Use the confidence badges to decide what to check. | A way to see what was read, what was computed and what was guessed. | Every value has a % badge. LLM percentages aren't calibrated, and row 8 proved a green badge can be wrong. Derived values (elevation from depth) look the same as values read from the page. | Replace % with a **source-type badge**: Read (text layer) / OCR (scan) / Derived (computed, formula shown) / Guessed / Human-edited. A toggle for **"Show only: guessed, OCR, edited, flagged"**. A **"Spot-check mode"**: all flagged values plus a random 10% sample, with each tick logged. |
| 13 | Borehole detail | Ask "who changed what?" before I approve. | A history per value and per borehole: the AI value, the model/OCR version, and my colleague's edits with reasons and times. | The concept has no history anywhere. My colleague changed 9 values yesterday (they told me in chat). I can't see which 9. | A **"History" tab** next to the layer table and a **clock icon** on every edited field. It shows the original extracted value, then each change: who, when, old → new, reason. A **"Edited by humans"** filter. |
| 14 | Extraction review (report level) | Approve the data set. | One "Approve for tender" action for the whole report. It records my name, the time and a comment, and locks the version. | Approve buttons exist per field only. 14 boreholes × ~25 layers × ~10 fields means thousands of clicks. There's no data-set approval and no lock. My colleague could edit after I sign and nobody would know. | An **"Approve & lock revision"** button in the report header, active only when no flags are open. It creates "Rev A, approved by [name], [date]". Any later edit creates a draft Rev B, removes the approved badge everywhere, and notifies me. |
| 15 | Borehole detail → export; six months later | Export for the tender. Later, open the project during a claim. | An export of the approved revision with raw values, source references and status. Later, a view of exactly what I approved and why. | There's only an export button per borehole. It's unclear what's in it or whether it's approved. There's no list of revisions. | **"Export approved revision"** at report level: xlsx in the target format plus provenance columns. An **"Evidence pack (PDF)"** with each edited or flagged value, its scan crop, its change history and my sign-off. A **"DRAFT – NOT APPROVED"** watermark on every other export. A **"Revisions" tab** with a diff between revisions and the source-file fingerprint (hash + the consultant's report revision). |

## Top frictions

1. **No audit trail, no data-set sign-off, no lock.** I can't defend a number if I can't see who changed it and why. Without this, I won't sign.
2. **Provenance only exists on the review screen.** I spot problems in the profile and layer table, but I can't click from there to the source. The highlight also has to show the column and its label, not just the number. That's how the misread was caught.
3. **Raw notation is collapsed into one number.** SPT refusal "50/30" becomes "50", and four groundwater readings become one ▽. The tool hides exactly the detail I check.
4. **CRS and vertical datum are guessed, then shown like normal values.** A warning icon isn't a check. Treating chart datum as mASL without saying so shifts every rock-head elevation.
5. **Percentage badges and a one-borehole-at-a-time view.** A green 90% was wrong. I need source-type badges, plus a neighbour or section view to catch boundaries that don't fit.

## Wishlist

| Feature | Type (button / feature / data field / screen) | Screen | Priority (must / should / nice) | Why (one line) |
|---|---|---|---|---|
| Approve & lock revision (report level) | button | Extraction review (report header) | must | My sign-off must be one recorded act, and it must break if the data changes after it. |
| Per-value change history (History tab + clock icon) | feature | Borehole detail, Extraction review | must | I need to see who extracted or changed what, when, and why. |
| "Show in source" on every value and layer boundary | button | Borehole detail | must | I find problems in the profile, so the trace has to start there. |
| "Read from" column/label shown next to each value | data field | Extraction review | must | A highlight on the wrong column is how I caught the misread. |
| Source-type badge (Read / OCR / Derived / Guessed / Edited) instead of % | feature | Extraction review, Borehole detail | must | Uncalibrated percentages mislead; I need to know how a value was obtained. |
| SPT raw string, increments, penetration + unit, refusal flag, N used | data field | Borehole detail, Extraction review | must | Showing "50/30" as "50" misstates the ground and the cutter choice. |
| Groundwater readings table (type, date, depth, elevation, datum, source) | data field | Borehole detail | must | Face pressure depends on which reading, taken when, against which datum. |
| CRS candidates + control-point check + "Confirm CRS for whole report" | feature | Extraction review | must | An unstated CRS needs one human check per report, recorded with a name. |
| Vertical datum, offset to MSL, water depth / seabed level | data field | Extraction review, Borehole detail | must | Treating chart datum as mASL shifts every rock head. |
| "Move boundary" edit with mandatory reason and affected-values preview | feature | Extraction review | must | An edit without a reason can't be defended. |
| Coverage panel (boreholes in report vs extracted, unused pages) | feature | Upload & processing queue | must | A missed borehole leaves a hole in the baseline. |
| Export approved revision with provenance; DRAFT watermark on all else | feature | Borehole detail (report-level export) | must | Only approved data may reach the commercial team. |
| Evidence pack (PDF) | feature | Report-level export | should | That's the file I hand to the claims team. |
| Revisions tab with diff and source-file fingerprint | screen | New: Revisions (report level) | should | When the consultant issues Rev 2, I need to see what moved. |
| Section along alignment / "Compare neighbours" | screen | New: Section view (opened from Borehole detail) | should | Rock-head plausibility is a cross-borehole check, and it sets the mixed-face length. |
| Spot-check mode (all flags + random sample, each tick logged) | feature | Extraction review | should | It proves I checked a defined sample, not a random scroll. |
| "Show only guessed / OCR / edited / flagged" filter | button | Extraction review | should | It cuts thousands of fields down to the few dozen that matter. |
| Per-borehole status chain with names (Extracted → Reviewed → Approved) | data field | Upload & processing queue, World map, Borehole detail | should | It shows at a glance who did what and what is waiting for me. |
| "My approvals" inbox with deep links | screen | New: Approvals (landing page for approvers) | should | The world map is not where my work starts. |
| Alignment / site-plan overlay | button | World map | should | It lets me check locations against the drawing and see chainage for the tender. |
| Weathering grade and vane shear strength fields | data field | Borehole detail, Extraction review | should | They are key parameters in weathered rock and soft clay, and the schema lacks both. |
| "Find similar" misreads | button | Extraction review | nice | One misread on a skewed sheet usually means more on the same template. |
| Client clarification list from open flags | feature | Extraction review (report level) | nice | An unstated CRS or datum is a tender query to the client, not my guess. |

## Schema gaps

- **Provenance per value:** source file and fingerprint, page/sheet, region on the page, the column or label it was read from, the original string and unit, the method (text layer / OCR / derived / guessed) and the engine or model version.
- **Review and approval:** per-value edit history (who, when, old, new, reason), report revision, approver, approval date and scope.
- **Source document:** consultant, report reference, report revision and issue date. The target has ProjectID and ProjectName but nothing about the document itself.
- **SPT detail:** raw notation, seating and test increments, penetration and its unit, refusal flag, reported N vs N used, test depth (top/bottom), hammer type or energy ratio. The target has one numeric "SPT" field.
- **Groundwater:** the target has one number. I need several readings, each with a type (strike / rest / standpipe / piezometer), date/time, depth, elevation, datum and a tidal or artesian note.
- **Vertical datum:** datum name and offset to MSL. The target forces "mASL". Over-water holes also need water depth, seabed level and drilling platform.
- **Coordinates:** CRS status (stated / inferred / confirmed), EPSG code, confirmed-by, and the original coordinate strings.
- **Ground parameters:** weathering grade for rock, and undrained shear strength from vane tests (peak and remoulded) for soft clay. "Cohesion" doesn't cover either.

## Deal-breaker

The first time I click a value in an approved data set and can't see the exact spot on the source page, plus who changed it and why, I go back to my highlighter and don't come back.

## Pitch quote

(simulated) "I don't need the machine to be right every time; I need it to show me where every number came from, so I can sign my name under it."

## With Bormisu

**Time (persona estimate):** about 3 hours of my own time for this report, in one sitting, if the musts are built:

- 30 min to confirm the CRS and vertical datum, once per report.
- 1–1.5 h on the guessed, OCR, flagged and edited values.
- 45 min for a random spot-check.
- 15 min for sign-off and export.

If a claim comes later, the evidence pack and revision history get me an answer in 15–30 minutes instead of half a day.

Without the musts, I'd still do my full paper check. The tool would then add time instead of saving it.
