# 04 · Data reviewer / working student (bulk QA)

Geoscience master's student, 20 h/week in the geotechnics team. They clear the extraction review queue and are measured on throughput and accuracy.
They know soil and rock basics but are not an expert. They live on the keyboard, hate mouse-heavy UIs, and work on a laptop plus a second monitor.

## Scenario

All projects, IDs, coordinates and values in this walkthrough are fictional.

- **Projects:**
  - **Projeto Serra Verde** (fictional water-transfer tunnel, Brazil). About 30 single-page scanned SPT logs in Portuguese. Numbers use decimal commas and dot thousand separators ("Cota 1.084,60", "Prof. 12,45").
  - **Project Sungai Jernih** (fictional sewer interceptor, Malaysia). One PDF of about 60 pages covering about 20 locations. The logs are handwritten and partly rotated 90°. Three form types are mixed together: borehole logs, hand-auger logs, and dynamic-probe sheets.
- **Deadline:** the queue must be clear by **17:00 today**.
- **What's at stake:** the tender kick-off is tomorrow at 08:00. The tender engineer needs the SPT profiles and groundwater levels for both projects for three things:
  - pre-selecting the machine type (EPB vs slurry)
  - setting the face-pressure range
  - filling the tender risk register

  Anything I can't resolve goes on the clarification list to the client, and that window closes on Monday. If my data is late, the bid team guesses. If my data is wrong, their guess looks like a fact.
- **Today's state of the queue:** many fields have low confidence. Most boreholes in a project share the same header data.

## Today, without Bormisu

- The scan is open in a PDF viewer on monitor 2. Our Excel borehole template is open on the laptop.
- **Serra Verde:**
  - I copy the project header from the first log into 29 more rows, then fix the per-borehole fields.
  - I retype coordinates and elevations by hand and convert "1.084,60" to 1084.60 in my head. The template uses English number format but my laptop uses German locale, so every paste is a coin toss.
  - I add the SPT increments in my head to check N.
- **Sungai Jernih:**
  - I rotate pages one by one in the viewer.
  - I sort pages into the three form types on a sticky note.
  - I decipher the handwriting and type it in.
  - Probe sheets go into a separate tab that nobody reads.
- My lead spot-checks about 10 % and sends errors back. Most errors are separators, swapped digits, and N values copied from the wrong column.
- **Time (persona estimate):**
  - Serra Verde: about 12 min per log × 30 = **~6 h**.
  - Sungai Jernih: about 27 min per location × 20 = **~9 h**.
  - Total: **~15 h**, most of my 20 h week. 17:00 today is impossible. Realistically I finish Serra Verde and tell the engineer that Sungai Jernih comes Tuesday.

## Walkthrough

| # | Screen | I do | I expect | What happened / friction | Need (button/feature) |
|---|---|---|---|---|---|
| 1 | Upload & processing queue | Open the queue at 09:30. Both PDFs were uploaded last night by the tender engineer. | A to-do list for me: how many boreholes, how many fields need a human, who owns what, and whether 17:00 is realistic. | One row per document with a status ("needs review") and "30 boreholes found". There's no field count, no low-confidence count, no assignee and no due time. I can't plan my day. I can't tell my lead at 10:00 that Sungai Jernih won't make it. | **Workload strip** above the table: "Open fields 1,180 · low confidence 340 · est. 5 h 10 min · due 17:00". New columns per document: **Assigned to**, **Due**, **Progress (reviewed / total fields)**. Sort by due. |
| 2 | Upload & processing queue | Expand the Sungai Jernih PDF to see what the page classifier did with about 60 pages. | Page thumbnails labelled borehole log / hand-auger log / probe sheet. Rotation already fixed. Pages grouped per location, with "sheet 2 of 3" linked. | "Classifying pages" is only a progress label. I can't see or fix the result. If it called a probe sheet a borehole log, I find out 40 minutes later, deep in review. | New **Page triage** view under each document. A thumbnail strip with a form-type chip, a rotation icon and the location ID on each page. Keys: `R` rotate, `T` change form type, `M` merge with the previous location, `S` split. Button **Re-extract changed pages**. |
| 3 | Extraction review | Open SV-01, the first Serra Verde log. | The cursor lands on the first low-confidence field, and I work the list with the keyboard. | The concept is: click a field, see the highlight, then click Approve, Edit or Flag. That's about 60 fields × 2–3 clicks = ~150 clicks per log, or ~4,500 for this batch. My wrist dies and my throughput dies with it. | Keyboard map, shown with `?`: `Tab` / `Shift+Tab` next / previous field, `N` next low-confidence field, `Enter` approve, `E` edit, `F` flag, `Ctrl+→` next borehole. The focus ring is always visible. |
| 4 | Extraction review | Check the header: project name, client, drilling company, logged-by, date format. | I confirm it once for the whole document. | The same 8 header values sit on all 30 sheets. Per-borehole review means 240 identical confirmations. Worse, if I fix a typo in one borehole, the other 29 keep it. | **Project header** panel pinned at the top of the review screen. Shared values are shown once, with a button **Apply to all 30 boreholes** next to each field. A warning chip shows "29 match · 1 differs (SV-17)". |
| 5 | Extraction review | Check numbers. The source says "Cota 1.084,60" and "Prof. 12,45". | 1084.60 mASL and 12.45 m, each with the original string next to it. | Original vs normalised is shown, which is good. But nothing tells me which number rule the tool used. If it read "1.084" as 1.084 m once, I only catch it by luck. I can't set the rule for the whole document. | **Number format** control in the project header panel: "Decimal: comma · Thousands: dot (detected, 97 %)". Change it once and every field is re-parsed. A lint flags outliers, e.g. "Elevation 1.08 m vs neighbours at ~1,080 m". |
| 6 | Extraction review | Check the coordinates "N 7.412.305,18 / E 612.880,45". No CRS is printed. | A CRS guess I can confirm, and a quick check that the point lands where the project is. | The concept shows a CRS guess with a warning. I'm not an expert, and I can't choose between two UTM zones from a scanned header. There's no map in the review screen, so I can't sanity-check the result. | **CRS picker** per document (type-ahead on EPSG code or zone) with a **live mini-map** of all 30 points inside the review pane. Button **Ask engineer**: it routes the question to a named person and leaves the field "pending", not "approved". |
| 7 | Extraction review | Review the SPT column of SV-01: three 15 cm increments per test, N from the last 30 cm, and refusals like "30/08". | The raw string, the three increments, N, a refusal flag with penetration, and the rule used, so I can verify N in two seconds. | The target format has one numeric SPT field with a confidence badge. Depending on the model's mood, "30/08" becomes N = 30 or N = 38. I can't see which rule it applied. That number feeds the face-pressure range and the risk register. | Inline **SPT editor** row: raw · inc1 · inc2 · inc3 · N · refusal (blows / cm) · rule ("N = inc2 + inc3"). An auto-check verifies that N equals the sum. A mismatch turns the row red. |
| 8 | Extraction review | Step through the 14-row layer table, with the scan on my second monitor. | A full-height scan on monitor 2 that pans to the focused row and boxes it. Fields stay on the laptop. | Source and fields share one window. At half the width of a 14" laptop, a scanned log is unreadable. The highlight only appears on click, so that's 14 clicks per log. Nothing checks that the layers are continuous or that the last "to" matches the hole depth. | Button **Pop out source** (top right of the source pane) opens the viewer in its own window. **Auto-follow source** is on by default: moving focus moves the scan. Keys `+` / `-` zoom, `0` fit width. **Consistency lint** chips: gap, overlap, last depth ≠ BoreholeDepth, SPT or GW below final depth. |
| 9 | Extraction review | Hit a low-confidence lithology: "argila siltosa, mole, vermelha" → "silty clay, soft, red". | Why it's low, so I know whether to check the OCR or the translation. | The badge says 62 %, with no reason. Either I trust it blindly (an accuracy risk, with my name on it) or I check everything (and my throughput is gone). | **Reason line** under each badge: "OCR unsure on 'mole'" / "translation" / "unit guessed" / "template mismatch". Shown on hover or with key `W`. A small PT→EN glossary that suggests the DIN code. |
| 10 | Extraction review | Switch to Sungai Jernih, SJ-BH-04. Page 3 is rotated 90° and handwritten. | The page shown upright, the box drawn on the right word, and a magnifier for handwriting. | The concept doesn't say whether the source pane rotates or whether the boxes follow. I tilt my head for 30 pages. | Source toolbar: **Rotate** (`[` / `]`), **Apply to all pages of this form type**, and **Magnify box** (`Z`), which blows up the source crop of the focused field. |
| 11 | Extraction review | A depth on the hand log is a smudge. I genuinely can't read it. | A clear "illegible" state that is not 0, not empty and not approved. | There's only Approve, Edit and Flag. A flag with no reason means my lead has to reopen every flag to see what I meant. The export shows a blank, and the engineer reads it as "nothing there". | Field-state keys: `X` not in source, `I` illegible, `U` unsure → escalate (with a one-line note). The states show in the detail view and in the export. |
| 12 | Extraction review | SJ-DP-02 is a dynamic-probe sheet (blows per 0.3 m). The tool put those blows in the SPT field. | The tool knows a probe is not an SPT and stores it separately. | The probe blows were force-fitted into SPT without warning. A probe count read as SPT N overstates soil strength, the worst kind of error for a soft-ground bid. I only noticed because I know the form. A first-week student wouldn't. | **Investigation type** dropdown in the review header: Borehole / Hand auger / Dynamic probe. Changing it re-maps the fields. Probe blows go to a separate probe table, never to SPT. |
| 13 | Borehole detail | Open SV-01 after approval to eyeball the profile. | The DIN column, the GW marker, and an SPT N vs depth plot so spikes jump out. | The profile looks nice, but SPT appears only in the table, so a misread N = 300 hides in row 9. There's no "back to review" or "next borehole" key, so I click back through the map. | **SPT N vs depth mini-plot** next to the profile column. Keys: `B` back to review, `→` next borehole in my batch. The metadata card shows **Reviewed by / on**. |
| 14 | World map | Check all 30 Serra Verde pins at once. | Pins in a line along the alignment, with outliers obvious. | The filters are project, country, depth and rock data. There's no "my batch" or "unreviewed" filter. A pin 40 km off is a dot I only see at the right zoom. For the rest of my job, this screen is useless. | Filter chips **My batch** and **Unreviewed**. An automatic **Location outlier** flag ("SV-17 is 38 km from the batch median") pushes that borehole back into my review queue. |
| 15 | Upload & processing queue | At 16:40, mark both documents done and hand off. | A summary for the tender engineer: fields edited, flags, illegible values, the open CRS question. Ready for tomorrow's kick-off. | The status flips to "done" and nobody is notified. My open questions are scattered as flags across 50 boreholes, so the engineer has to hunt for them. | Button **Hand off** on each document. It shows a summary ("edited 212 · illegible 31 · escalated 9") and notifies the assignee. **Export open questions** (xlsx) gives the engineer a list to paste into the client clarification list. |

## Top frictions

1. **No keyboard flow.** Approving fields one by one with the mouse costs about 4,500 clicks for Serra Verde alone. On clean logs, that makes the tool slower than my Excel routine.
2. **No shared header and no document-level settings.** I decide the project header, number format and CRS 30 times instead of once. A fix in one borehole doesn't carry over to the others.
3. **SPT is a single number.** There's no raw string, no increments, no refusal and no rule. Probe blows get force-fitted into SPT. This is the accuracy trap that feeds machine type and face pressure.
4. **Page classification is a black box.** I can't check or fix rotation, form type or sheet stitching before review, so the errors show up late.
5. **Confidence comes without a reason, and there are no states for illegible, not in source or escalate.** So I either approve blindly or flag everything.

## Wishlist

| Feature | Type | Screen | Priority | Why |
|---|---|---|---|---|
| Keyboard review flow (`Tab`, `N`, `Enter`, `E`, `F`, `Ctrl+→`, `?`) | feature | Extraction review | must | Clicks are my bottleneck. The keyboard is 3–4× faster. |
| Auto-follow source on field focus | feature | Extraction review | must | Saves one click per field and keeps my eyes on the evidence. |
| Project header panel with **Apply to all boreholes** | feature | Extraction review | must | Confirm shared values once, not 30 times. |
| Document-level **Number format** (decimal / thousands separator) | data field | Extraction review | must | One wrong separator moves an elevation or a borehole by a factor of 1,000. |
| Document-level **CRS picker** with live mini-map preview | feature | Extraction review | must | I can't guess a UTM zone, but I can see a pin in the wrong place. |
| **SPT editor**: raw · increments · N · refusal · rule, with a sum check | feature | Extraction review | must | N feeds machine type and face pressure, so I must be able to verify it in seconds. |
| Field-state keys: not in source / illegible / unsure → escalate | feature | Extraction review | must | Blank, zero and "can't read" mean different things to the engineer. |
| **Investigation type** per location (borehole / hand auger / dynamic probe) | data field | Extraction review | must | Probe blows must never land in the SPT field. |
| **Page triage** view (thumbnails, form type, rotation, location, sheet x of y) | screen | Upload & processing queue | must | Fix the classification before two hours of review, not after. |
| Review audit trail (who, when, manual vs bulk vs auto) | data field | Borehole detail | must | I'm measured on accuracy, so I need proof of what I actually checked. |
| **Approve remaining high-confidence** (`Shift+Enter`), logged as bulk | button | Extraction review | should | Clean fields shouldn't cost a keystroke each. |
| Confidence reason line ("OCR", "translation", "unit guessed") | data field | Extraction review | should | It tells me where to look, so I don't re-check everything. |
| **Pop out source** to the second monitor | button | Extraction review | should | Scans are unreadable at half a laptop screen. |
| Rotate keys + **Apply to all pages of this form type** + **Magnify box** | button | Extraction review | should | Rotated handwritten pages are half the Sungai Jernih batch. |
| Layer consistency lint (gaps, overlaps, final depth, SPT or GW below the end) | feature | Extraction review | should | It catches extraction slips I'd miss at speed. |
| **Ask engineer** button routed to a named person | button | Extraction review | should | I'm not the expert. A question needs an owner, not just a flag. |
| Queue workload strip (open fields, low confidence, ETA, assignee, due) | data field | Upload & processing queue | should | I need to know by 10:00 whether 17:00 is realistic. |
| **Hand off** button + **Export open questions** (xlsx) | button | Upload & processing queue | should | The engineer gets one list for the client clarification round. |
| Batch grid mode (one row per borehole, cells coloured by confidence, source crop on focus) | screen | New: Batch grid | should | 30 one-page logs on the same template are a spreadsheet job. |
| Map filters **My batch** and **Unreviewed** + location outlier flag | feature | World map | should | Turns the map into a QA check instead of a showroom. |
| SPT N vs depth mini-plot next to the profile | feature | Borehole detail | nice | Spikes from misreads jump out visually. |
| Keys `B` back to review and `→` next borehole | button | Borehole detail | nice | No detour through the map. |
| PT→EN soil glossary with a DIN code suggestion | feature | Extraction review | nice | I know the basics, not Portuguese soil terms. |

## Schema gaps

- **Investigation type and method:** borehole, hand auger, dynamic probe, and the drilling method. The format assumes every location is a borehole.
- **SPT detail:**
  - raw notation
  - seating and test increments
  - increment length (150 mm / 75 mm)
  - penetration at refusal and a refusal flag
  - the N rule applied

  A single numeric `SPT` can't be verified.
- **Dynamic-probe results** (blows per 0.3 m): there's no field for them, so they end up in `SPT`, which is wrong.
- **Groundwater detail:** the reading date and time, and the type (struck / after x hours / rest level). One `Groundwaterlevel` number is not enough.
- **Elevation datum:** the datum name and the original value. `Surface Elevation` forces mASL with no record of what it was converted from.
- **Depth interval from / to** as explicit layer fields. Today they're only implied in the notes.
- **CRS detail:** EPSG code or zone, and whether the CRS was stated in the source or guessed.
- **Field status / null reason:** not in source / illegible / not applicable / unsure.
- **Provenance:** source document, page, bounding box, original label and original value per field.
- **Review metadata:** confidence, reviewer, timestamp, manual vs bulk vs auto approval, and edit history.
- **Source number format / locale** per document.
- **Sheet continuation** (sheet x of y) and **termination reason** (refusal / target depth / abandoned).

## Deal-breaker

If I still need three mouse clicks per field, or the tool silently turns "1.084,60" into 1.08 and I get blamed for approving it, I go back to retyping in Excel.

## Pitch quote

(simulated) "Give me a keyboard flow, one project header and an honest 'I can't read this' key, and I'll clear two days of retyping before 17:00."

## With Bormisu

**~5.5 h for both batches (persona estimate), assuming the musts are built.**

| Step | Time |
|---|---|
| Queue check + page triage for Sungai Jernih | ~25 min |
| Serra Verde header, number format and CRS, set once | ~10 min |
| Serra Verde: 30 logs × ~4 min (only low-confidence fields and SPT rows) | ~2 h |
| Sungai Jernih: 20 locations × ~8 min (handwriting, rotation, probe sheets) | ~2 h 40 min |
| Hand off + export open questions | ~10 min |

Starting at 09:30, with lunch, I'm done by about 16:00. I have time to re-check the escalations before 17:00.

**With the concept as currently drawn (no musts): ~10 h (persona estimate).** That's faster than Excel on handwriting, barely faster on clean logs, and still not done by 17:00.
