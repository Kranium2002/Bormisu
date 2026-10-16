# 02 · TBM / cutterhead design engineer

A mechanical engineer who picks the machine type, lays out the disc cutters and estimates cutter wear and consumption.

They want hard numbers at tunnel depth (UCS, CAI, RQD, groundwater head, grading), not prose, and they feed them straight into their own Excel and Python tools.

## Scenario

- **Project:** "Project Alpenquell" (fictional). A 6 km water-transfer tunnel for a fictional regional water utility. Bore diameter about 4.2 m. The crown sits 25–40 m below ground. The ground is gneiss and mica schist with a quartzite band and one fault zone. The first 300 m from the portal are in glacial gravel.
- **Input:** the client's ground investigation report. It is one 180-page PDF with 14 boreholes along the alignment. Only 5 boreholes have UCS tests, only 3 have CAI tests, and some of those samples sit far above the tunnel.
- **Deadline:** it is Monday morning. The cutter consumption estimate goes to the tender team on **Wednesday at 12:00**.
- **What's at stake:**
  - Cutter consumption is a priced line item in the offer, and it drives the spare-parts plan and the planned cutter-change stops.
  - If the estimate is too optimistic, the contractor runs short on site and blames the machine. If it is too conservative, the offer loses the tender.
  - The same data also decides the machine type (open gripper vs single shield vs double shield) and which ground assumptions get written into the offer as exclusions.
  - If the data has gaps, the team has to send the client a request for more tests.

## Today, without Bormisu

1. Page through the 180-page PDF to find the borehole logs, the lab summary table and the scanned lab sheets. **2–3 h.**
2. Plot the 14 boreholes on the alignment in CAD, read off each chainage, and work out the tunnel horizon elevation at each hole. Two holes have no surface elevation, so I email the project geologist and wait for them to reply. **3–4 h plus waiting.**
3. Retype every UCS, CAI, BTS and RQD value that falls inside the tunnel horizon into Excel. Check each unit (kN/m², MPa, sometimes kg/cm²). Check whether each "UCS" is a real lab test or a point-load conversion. **3–4 h.**
4. Dig through old project folders for 2–3 reference projects in similar rock. One project has a usable Excel file. The other has only a scanned report, so I retype it as well. **4–8 h.**
5. Run the statistics and plots, sanity-check against the references, and run the wear model. **2 h.**

**Total: about 2–3 working days (persona estimate).** That is all the time I have until Wednesday, so in practice I cut corners. I compare against one reference project instead of three, and I trust the lab summary table without opening the lab sheets.

## Walkthrough

| # | Screen | I do | I expect | What happened / friction | Need (button/feature) |
|---|---|---|---|---|---|
| 1 | Upload & processing queue | Drop the 180-page Alpenquell report. It has a text body, logs in an appendix, scanned lab sheets at the back, and some logs that run over 2–3 sheets. | Progress for the document, then a count of what was found, especially lab tests. | Status steps through "classifying pages → extracting → needs review". The only count is "14 boreholes found". I can't tell if the scanned lab appendix was read at all. If the tool shows "0 CAI", I can't tell whether the report has no CAI tests or the tool missed them. | "Found" chips under the status bar: `14 BH · 196 layers · 41 core runs · 18 UCS · 6 CAI · 4 BTS · 9 GW readings`. A "Pages" expander that shows the page classifier result, e.g. "p. 141–176: lab sheets". |
| 2 | Upload & processing queue | The document is at "needs review". I have two days, so I want to check the values that feed my model first. | A shortcut to the lab values. | The queue row only links to the review screen for the whole document, with metadata, 196 layers and everything else mixed together. | A "Review lab values first" button on the queue row. It opens the review screen filtered to UCS / CAI / BTS / RQD / groundwater. |
| 3 | World map | Search for "Alpenquell". | The 14 boreholes and my tunnel line. | I get 14 dots coloured by final depth and no tunnel. Final depth is useless to me. Where the ground rises, a 60 m hole can still stop short of the tunnel. | An "Import alignment" button in the map toolbar, top right, next to the draw tools. It accepts CSV (chainage, X, Y, crown elevation, diameter) or LandXML/DXF, and draws the line with chainage ticks. |
| 4 | World map | Keep only the boreholes near the line. | A corridor filter, plus a chainage and offset for each borehole. | The only option is polygon drawing. I'd have to trace a corridor around a 6 km line by hand, and the boreholes still get no chainage. | A "Corridor ± [200] m" field in the alignment panel. Every borehole inside gets "Chainage" and "Offset" columns in the results table. |
| 5 | World map, filter panel | Tick "has rock data". | To see which holes have UCS and CAI at tunnel level. | All 14 holes pass because they all have RQD. In reality 5 have UCS and 3 have CAI, and two of the CAI samples come from 8 m depth, far above the crown. | Parameter chips with counts (`UCS 5 · CAI 3 · BTS 2 · RQD 14 · grain size 4`). A "Tunnel horizon only" toggle that keeps crown minus 1 diameter to invert plus 0.5 diameter, in mASL per chainage, with editable margins. |
| 6 | World map | Look for stretches where nobody drilled to tunnel level. This feeds tender risk and any request to the client for more holes. | A section view along the tunnel. | The plan view can't show whether a hole reaches the tunnel. The colours show depth class only. | A "Longitudinal section" button in the alignment panel (spec under Wishlist). Also a "Colour by" dropdown in the legend: final depth / review status / rock type at tunnel level / reaches invert yes-no / max UCS in band. |
| 7 | World map, results table | Sort the boreholes by chainage. | Columns I can work with. | The table has generic columns only: ID, name, depth, status. It has no chainage, no elevation and no test counts. | A column picker (gear icon, right end of the table header) with chainage, offset, surface elevation + datum, "reaches invert" (yes / no / unknown), # UCS in band and # CAI in band. An "Export selection" button in the table footer, next to the selection count. |
| 8 | Borehole detail | Open AQ-BH-07 at chainage 2+350. | The profile with the tunnel tube drawn across it, and UCS/CAI next to the layers. | The DIN 4023 column is good. The layer table shows from/to, lithology, SPT, RQD and TCR. UCS and CAI don't appear anywhere, and the tunnel isn't drawn. | A "Lab tests" tab beside the layer table with sample ID, from/to, elevation, lithology, test, value, unit, method, status and source. A shaded "Tunnel horizon" band across the profile column. A thin parameter track right of the column with UCS dots and RQD bars. |
| 9 | Borehole detail | Read the depth axis. | Elevation in mASL, because the alignment is defined in elevation. | The axis shows depth below ground, and the surface elevation sits in the metadata card. If the elevation is missing or on an unknown local datum, the tunnel band lands in the wrong place and nothing warns me. | A "Depth / Elevation" toggle in the profile header and a datum label on the axis. A red badge "Surface elevation missing: tunnel band position unknown". That hole drops out of band filters until someone fixes it. |
| 10 | Borehole detail | Check the RQD in the fractured gneiss at 31–37 m. | RQD per core run, as logged. | RQD appears once per lithology layer. I can't tell if that is one run's value, an average or the worst run. Core runs and layers don't line up. | A "Core runs" tab (from/to, TCR, SCR, RQD, fracture frequency). A "derived" tag on any value the tool averaged or moved between intervals. |
| 11 | Borehole detail → Extraction review | One UCS reads 241 MPa in mica schist, which looks wrong. | One click to the source lab sheet. | Nothing links the value to its source. I open the review screen and scroll this document's field list to find it. | A "Show source" icon next to every number in the detail page, the summary and the export preview. It opens the review screen at that field with the page crop highlighted. |
| 12 | Extraction review | Check how the UCS was measured, then approve it. | The test method and the unit next to the value. | The original "24 100 kN/m²" → 24.1 MPa is shown, which is good. But the next sheet only has point-load results, and they landed in the same UCS field as direct lab tests. There is one field and no method. There is also no range check, so a decimal comma misread could turn CAI "4,2" into 42. | A "Test method" field on each lab value: direct UCS / from point load / estimated. A "Surface" field for CAI: natural / sawn. A plausibility flag (UCS > 300 MPa, CAI > 6.5, RQD > 100 %). An "Approve all on this page" button for lab tables. |
| 13 | Missing screen: Ground parameters | Get UCS / CAI / BTS / RQD ranges and the groundwater head at the tunnel for the whole corridor. | A table per rock unit with n, min, P10, median, P90 and max, plus a histogram. | This screen doesn't exist. I'd have to export and do everything in Python, and the export doesn't work for that either (row 15). | A new "Ground parameters" screen, opened with a "Summarise selection" button on the results table. Rows are rock units; columns are n, min, P10, P50, P90 and max per parameter. Groundwater head above the invert is shown in bar. An "Include unreviewed values" toggle, off by default, shows how many values are excluded. The n is shown large, and cells turn amber when n < 5. |
| 14 | Missing screen: Compare projects | Put Alpenquell next to two older projects in similar rock (fictional "Grauwand", 2021, and "Kalterbach", 2019). | Box plots of UCS and CAI per rock type, project by project. Ideally also the cutter consumption those machines actually had. | The map can filter by project, but nothing compares projects. I also can't search for "projects in gneiss with UCS 100–200 MPa". | A "Compare" button on the project filter and on the watchlist. It opens a comparison screen with box plots per parameter per rock type. A "Find similar ground" search by lithology + parameter range. |
| 15 | Borehole detail, Export | Export into my wear model. | One long-format CSV for the whole selection. | Export only exists on the single-borehole page, in the 3-part Herrenknecht sheet layout, one file per hole. That means 14 files that I then stitch together by hand. | "Export selection" on the results table and on Ground parameters. It writes a tidy CSV/XLSX with one row per value: project, BH, chainage, offset, from, to, elevation mASL, rock unit, parameter, value, unit, method, qualifier (<, >), status, confidence, source doc + page. Units in the header, decimal point, no merged cells. The file is stamped with a dataset version. |

## Top frictions

1. **The tool doesn't know where my tunnel is.** There is no alignment, no chainage and no elevation-based tunnel band. Every screen works per borehole and in depth below ground. My question is always "what is at tunnel level between km X and km Y?" Without an answer to that, I do the hard part outside the tool.
2. **Lab values have no home.** The planned detail page shows SPT, RQD and TCR. UCS, CAI and BTS appear on no screen, and nothing summarises across boreholes. Those are exactly the numbers that drive cutter wear.
3. **Export is per borehole and in a presentation layout.** I need one tidy, machine-readable table for the whole selection, with chainage, elevation, method and source on every row.
4. **I can't trust a number I can't trace or qualify.** There is no test method (direct UCS vs point load) and no CAI surface condition. Exported values carry no reviewed/unreviewed flag, there is no range check, and no number links to its source page. With only 3 CAI values, one bad value moves the P90 and with it the cutter budget.
5. **There is no cross-project comparison and no "similar ground" search.** Reference projects are my only sanity check on a wear estimate, and today they take the longest to dig out.

## Wishlist

| Feature | Type | Screen | Priority | Why |
|---|---|---|---|---|
| Import tunnel alignment (CSV / LandXML / DXF: chainage, X, Y, crown elevation, diameter) | button | World map (toolbar, top right) | must | There is no "along the alignment" without the line. |
| Corridor filter that gives every borehole a chainage and an offset | feature | World map (alignment panel) | must | Lets me sort and bin everything by chainage. |
| "Tunnel horizon only" filter (crown − margin to invert + margin, in mASL per chainage) | feature | World map (filter panel) | must | My calculation only cares about rock the cutterhead actually cuts. |
| Lab tests tab (sample, from/to, elevation, test, value, unit, method, status, source) | feature | Borehole detail | must | UCS and CAI have no home on the planned screens. |
| Ground parameters summary (n, min, P10, P50, P90, max per rock unit; histogram; groundwater head at the tunnel) | screen | New: Ground parameters | must | This table is the direct input to the wear model. |
| "Include unreviewed values" toggle, off by default, with an excluded count | feature | Ground parameters, Export | must | I need to know my ranges rest on checked values only. |
| Export selection as a tidy long-format CSV/XLSX (one row per value) | button | World map results table footer; Ground parameters | must | My Python and Excel tools read rows, not 14 formatted sheets. |
| "Show source" link on every number | button | Borehole detail; Ground parameters | must | One click from a suspicious value to the page crop. |
| Test method per lab value (direct UCS / from point load / estimated; CAI surface natural / sawn) | data field | Extraction review; Lab tests tab; Export | must | Mixing point-load UCS with lab UCS corrupts the wear estimate. |
| Parameter availability chips with counts (UCS, CAI, BTS, RQD, grain size, k) | feature | World map (filter panel) | should | "Has rock data" hides that only a few holes have lab tests. |
| Plausibility flags (out-of-range UCS / CAI / RQD, unit and decimal-comma checks) | feature | Extraction review | should | Catches "4,2 → 42" before it reaches my model. |
| Longitudinal section: chainage on x, elevation on y, ground surface, tunnel tube, boreholes as DIN 4023 sticks, test values as dots, data gaps at tunnel level shaded red | screen | New: Longitudinal section (from the alignment panel) | should | Shows tender risk and where to ask the client for more holes. |
| Compare projects: box plots per parameter per rock type, side by side | screen | New: Compare projects (from project filter / watchlist) | should | Reference projects are my sanity check on the estimate. |
| "Find similar ground" search (lithology + parameter range across all projects) | feature | World map (search) | should | Finding reference projects today means asking around the office. |
| Core runs tab (from/to, TCR, SCR, RQD, fracture frequency) with a "derived" tag | feature | Borehole detail | should | RQD is logged per run; per-layer values hide where it came from. |
| Depth / Elevation axis toggle, datum label, "surface elevation missing" badge | feature | Borehole detail | should | Without a reliable elevation, the tunnel band is in the wrong place. |
| Tunnel horizon band and UCS/RQD parameter track on the profile column | feature | Borehole detail | should | Shows at a glance what the cutterhead meets in this hole. |
| "Found" chips per document (BH, layers, core runs, UCS, CAI, BTS, GW counts) and a page classifier list | feature | Upload & processing queue | should | Tells me whether "0 CAI" means none in the report or the tool missed them. |
| "Review lab values first" button | button | Upload & processing queue | should | My time goes to the 30 values that drive the model, not 196 layers. |
| "Colour by" dropdown (review status, rock type at tunnel level, reaches invert, max UCS) | feature | World map (legend) | should | Depth class answers no question I have. |
| Column picker (chainage, offset, elevation + datum, reaches invert, # UCS / # CAI in band) | feature | World map (results table) | should | Lets me triage boreholes without opening each one. |
| Dataset version stamp on every export | data field | Export | should | My calc report must say which data state it used. |
| "Approve all on this page" for lab tables | button | Extraction review | nice | Lab sheets have 10–20 values per page and approving them one by one is slow. |
| Read-only API or "Copy as pandas snippet" for the current selection | feature | World map; Ground parameters | nice | Skips the file round-trip for repeat runs. |
| Reference project outcome: TBM type, diameter, actual cutter consumption | data field | Project (Compare projects) | nice | Lets me compare actual consumption, not only geology. |
| "Re-run extraction on pages …" | button | Upload & processing queue | nice | Fixes a missed lab appendix without reprocessing 180 pages. |

## Schema gaps

- **Test method per lab value.** UCS can be a direct lab test, converted from point load, or estimated. The schema needs the method, the number of specimens, the moisture state and the loading direction relative to foliation.
- **Point load index Is50 (MPa)** as its own field, so it doesn't get folded into UCS.
- **CAI test conditions:** surface (natural / sawn), stylus hardness and the standard used. Sawn-surface CAI reads lower than natural-surface CAI.
- **Tensile strength method:** Brazilian (BTS) or direct.
- **Wear and boreability indices:** quartz or equivalent quartz content (%), DRI, CLI, Sievers J value, AVS. For soft ground: LCPC abrasivity and breakability.
- **Fracturing:** fracture frequency (per m), SCR, joint spacing, and joint orientation (dip / dip direction) relative to the tunnel axis.
- **Core runs as their own interval table.** TCR, SCR and RQD are logged per run, and runs don't line up with lithology layers.
- **Full grading:** D10, D50 and D60; gravel / sand / silt / clay %; cobbles and boulders. "Grainsize-fines" alone can't drive EPB vs slurry selection or soft-ground wear.
- **Groundwater observations:** date, type (strike / standing / piezometer), piezometric head and an artesian flag. One "Groundwaterlevel" value per layer row isn't enough to get the pressure at the tunnel.
- **Sample depth from / to.** The schema has a single SampleDepth.
- **Borehole inclination and azimuth,** to convert along-hole depth to elevation. Depth vs length alone isn't enough.
- **Elevation datum name and conversion note** on Surface Elevation.
- **Value qualifier (<, >, ≈, range)** and provenance on every value: source document, page, region, review status, confidence.
- **Project-level reference data:** tunnel alignment, TBM type, diameter and actual cutter consumption. This is outside the borehole format, but it is what makes a project comparison useful.

## Deal-breaker

If one UCS or CAI value in my export turns out to be a misread or a hidden point-load conversion, and I can't trace it to its source page in one click, I'm back to retyping the lab sheets myself.

## Pitch quote

(simulated) "Give me UCS, CAI and RQD at tunnel level along the chainage, with the n and the source page behind every number, in a CSV my wear model reads, and I'll stop retyping lab sheets."

## With Bormisu

1. Upload the report. Extraction runs unattended (about 30–60 min) while I do other work.
2. Import the alignment and set the corridor and tunnel horizon margins. **About 15 min.**
3. Review the roughly 30 lab and RQD values that feed the model, using "Review lab values first" and "Show source". **1–1.5 h.**
4. Open Ground parameters, export the selection and run the wear model. **About 1 h.**
5. Compare with two reference projects that are already in the database. **About 30 min.** Add 1–2 h of review per reference project if it still has to be uploaded.

**Total: about half a day, 3–4 h hands-on (persona estimate).** I can also spend the time I save on checking the references properly and writing the request to the client for more CAI tests.
