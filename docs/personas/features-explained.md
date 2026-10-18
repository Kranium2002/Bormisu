# Features explained

Every feature from the [persona simulation](personas.md), in plain words: what you see, why someone asked for it, and how it works.

- **Part 1:** the 12 features we build by Sun 11:30 (from [build-cut.md](build-cut.md)), explained fully.
- **Part 2:** the roadmap features we cut for now, grouped by theme (full tables in [feature-backlog.md](feature-backlog.md)).

The personas are simulated (AI agents role-playing Herrenknecht jobs), not interviews. All names and values here are fictional.

## Glossary

| Term | Meaning |
|---|---|
| **SPT** | Standard Penetration Test. A hammer drives a sampler into the ground, counting blows per 15 cm. **N** is the number of blows for the last 30 cm. A higher N means denser ground |
| **Refusal** ("50/30", "N=R") | The ground is too hard for the test: 50 blows drove the sampler only 30 cm. It usually means a boulder or rock. It is **not** "N = 50, dense sand" |
| **CRS** | Coordinate reference system: which grid the X/Y numbers belong to (UTM zone, a national grid, lat/lon). Many reports don't say |
| **Datum** | The zero point for elevations ("sea level" differs by country). "Elevation 12.3" means nothing without it |
| **Rock head** | The depth where soil stops and rock begins. It decides the TBM type |
| **Chainage** | Distance along the tunnel route, e.g. "km 2+350" |
| **Tunnel horizon** | The depth band between the tunnel's crown (top) and invert (bottom). Only ground in this band touches the machine |
| **TCR / RQD** | Core recovery % and rock quality %, both measured on drilled rock cores |
| **UCS / CAI** | Rock strength (MPa) and abrasiveness. Together they drive cutter wear and cost |

---

# Part 1: the 12 features we build by Sun 11:30

## 1. Skeleton, one-command run, demo mode · M · 3 h

**What you see:** `make setup && make run` starts the whole app on one port. Without an API key, the app opens in **demo mode** with a fictional sample report already loaded, and a banner reads "Live extraction needs a key".

**Why:** this one comes from the code assessment, not from a persona. An automated build clones the repo fresh and builds it, and build failures cost points. Keys can't go in git, so that build has no key. Without demo mode it would see an empty or crashing app.

**How it works:** the backend serves the built frontend, so it runs as one process on one port. Lockfiles are committed. CI runs setup, tests and the build on a clean machine on every push.

## 2. Shared data model and fictional fixtures · S · 2 h

**What it is:** you never see it, but every screen depends on it. Each extracted value is stored as a small record:

```
raw: "212,4"   value: 212.4   unit: mASL   page: 7   box: [x,y,w,h]
method: OCR    status: unreviewed   state: ok
```

The `state` field can also say "not in source" or "illegible", so a blank never quietly turns into 0.

Three special shapes:
- **Groundwater** is a list of readings, not one number.
- **SPT** keeps its raw string.
- **Lithology** keeps the printed text, a translation and the DIN code.

**Fixtures:** a script draws a fake 2-page borehole log for tests and demo mode. It has a fictional project, "4,5,5 = 10", "50/30", decimal commas, one rotated page and no CRS. We need this because real challenge data can't go in the public repo.

**Why:** all 5 personas asked for provenance (#1 on the list). Provenance only works if it's in the data model from day one. Adding it later means a rewrite.

## 3. Extraction pipeline · L · 8 h (the biggest item)

**What it does:** turns a dropped PDF or image into structured boreholes, in six stages:
1. **Split** the file into page images.
2. **Classify** each page as log, lab table, text, drawing or photo. Photos and drawings are skipped.
3. **Extract**: a vision LLM reads each log page into the data model.
4. **Locate**: find the box on the page for each value. Use the PDF text layer first, then OCR words. If neither works, mark it "box not found".
5. **Normalise** the values (feature 4).
6. **Check** them (feature 11).

The same code runs from the command line: `bormisu extract report.pdf`.

**Key design choice:** the LLM sits behind an `Extractor` interface with two versions:
- **Live** calls OpenRouter.
- **Replay** reads a saved JSON result.

Tests and demo mode use Replay, so they work offline and return the same result every time.

**Why:** this is the challenge itself. All 5 personas depend on it.

## 4. Normalisers · M · 3 h

Normalisers are small pure functions, each one tested against a table of input/output examples.

- **SPT parser.** Reports write SPT about 10 different ways:
  - `4,5,5 = 10`: three 15 cm increments, N = 5 + 5 = 10
  - `5/2/1/2/3 N=8`
  - `50/30`: refusal
  - `N=R`: refusal

  Output: increments, N, refusal flag, penetration and unit, and a **sum check** (do the increments really add up to the N the report states?).
  **Why it matters:** if "50/30" is stored as N = 50, the ground looks like dense sand. It's really a boulder or rock, which is a completely different TBM risk.
- **Decimal format** is detected per document. "1.084,60" is 1084.6 in European notation. A wrong guess shifts the value by a factor of 1000. The data reviewer named this as their deal-breaker.
- **ft → m** conversion.
- **Coordinates → WGS84** for the map, plus a CRS status: *stated* by the report or *inferred* by us.

**Who asked:** geotechnical engineer, geologist, reviewer. The table-driven tests also count towards the code score.

## 5. Source viewer and "Show source" · M · 3 h (the demo's wow moment)

**What you see:** every number in the app has a small source icon. Click it, and a panel opens with the original scanned page, the exact cell boxed, and a badge saying how the value was read.

It opens from everywhere: review fields, profile layers, the layer table and groundwater readings. It's one shared component, so it behaves the same on every screen.

**Why:** all 5 personas asked for it. It's the senior geologist's deal-breaker: *"the first time I click a value and can't see the exact spot on the source page, I go back to the highlighter."* Engineers sign off on this data and carry the liability, so trust matters more than speed.

## 6. Extraction review screen · M · 5 h

**Layout:** the scan on the left, the extracted fields on the right.

- **Raw value next to the normalised one:** "Cota 212,4" → 212.4 mASL. You can see exactly what the tool changed.
- **Lithology on three lines:**
  - as printed: "arcilla limosa con gravas"
  - translation: "silty clay with gravel"
  - DIN code

  Nothing like "with boulders" gets lost in translation.
- **"R" badge** on every SPT refusal.
- **Method badge instead of a confidence %.** Each value shows Read / OCR / Derived / Guessed / Edited. In the geologist's walkthrough a green "90 %" value was wrong. A percentage looks precise but isn't calibrated, while the badge tells you how the value was obtained, and so how hard to check it.
- **Buttons:**
  - **Approve, Edit, Flag** work on a single value.
  - **"Approve all clean"** approves only Read-type values with no flags. It never approves guessed or OCR values.
- **"Not in source" and "illegible" keys** record why a field is empty.
- **Edits keep the AI's original value visible.** That's a simple history without needing user accounts.

**Who asked:** geotechnical engineer, geologist, reviewer.

## 7. Borehole detail with the DIN 4023 profile · M · 5 h

**What you see:**
- **Profile column:** the standard German way to draw a borehole. It's a vertical bar with depth on the left, and each layer has the DIN colour and hatching for its soil or rock type. Rules are in [din4023-cheatsheet.md](../design/din4023-cheatsheet.md).
- **One ▽ per groundwater reading.** A *strike* (where water first appeared while drilling) and a *rest level* (where it settled later) can be metres apart. Engineers need both.
- **Layer table synced with the profile:** click a layer in either one and it highlights in both.
- **Metadata card with rock head:** worked out from the first rock layer and linked to its source.

**Why rock head:** the TBM type depends on whether the tunnel runs through soil, rock, or a **mixed face** (both at once, the hardest case).

**Who asked:** all 5 personas.

## 8. Project export · M · 3 h

Three files from the same data:
1. **Target-format xlsx:** the 3 parts (metadata, log, tests) laid out exactly like Herrenknecht's template, plus an extra **provenance sheet** saying where each value came from. This file is literally what the challenge asks for.
2. **Tidy CSV** with one row per value. The TBM engineer's Python wear model reads it directly.
3. **"Open questions" CSV:** flags, illegible values, inferred CRS and missing borehole IDs. In tendering this is a **request for information (RFI)** sent to the client. It turns the tool's uncertainty into a useful deliverable.

**Safety default:** only approved values are exported. Choosing "Include unreviewed" stamps everything DRAFT.

**Who asked:** geotechnical engineer, TBM engineer, geologist, bid manager. This feature carries the business-value story.

## 9. Upload & queue with page map · M · 3 h

**What you see:**
- A drop zone.
- Status steps: classifying → extracting → needs review → done.
- Counts of what was found: boreholes, layers, SPT values, groundwater readings.
- **Page strip:** one thumbnail per page, coloured by page type. Unused pages show the reason, e.g. "unused: photo".

**Why:** in a 150-page report the logs are buried in appendices. The core user's first worry is "did it miss anything?", and the page strip answers that at a glance. It's read-only in this build: you can't change a page's type yet.

**Who asked:** 4 of 5 personas.

## 10. World map, thin version · S · 2 h

**What you see:**
- **Pins coloured by review status:** green = reviewed, grey = unreviewed, amber = needs attention. A pin with an *inferred* CRS is amber.
- **Boreholes without usable coordinates go in a list, not on the map.** A plausible but wrong pin is worse than no pin, because it could put a borehole in the wrong valley.
- Search by project or borehole ID.
- Clicking a pin opens a popup, which links to Borehole detail.

**Why:** the challenge brief explicitly asks for an "interactive world map". The bid manager wants it as the opener for client meetings.

## 11. Checks: completeness and lint · M · 3 h

- **Completeness:** reports usually list their boreholes somewhere, in a summary table or on the site plan. The tool compares the IDs listed with the IDs extracted and reports gaps like "BH-07 is mentioned but was not found".
- **Lint** applies automatic plausibility rules:
  - gaps or overlaps between layers
  - log bottom ≠ final depth (a sheet may be missing)
  - an SPT value or groundwater reading below the end of the hole
  - out-of-range values: UCS > 300 MPa, CAI > 6.5, RQD > 100 %
  - CAI "4,2" read as 42

Results show on the queue row and as flags in the review screen.

**Why:** it answers the TBM engineer's question: "is 0 CAI values real, or did the tool miss them?"

## 12. Stretch: confirm the CRS once per document · S · 2 h

**What you see:** instead of fixing coordinates one borehole at a time, the tool shows 2–3 candidate systems, each with its pins previewed on a mini-map. A wrong CRS puts pins in the sea or in another country, so the right one is obvious at a glance. Click confirm, your name is stored, and the pins turn green.

**Note:** this is the first item to drop if we run late.

---

# Part 2: roadmap features (cut for now)

These are grouped by theme. They're cut because they need more groundwork, not because they're unimportant.

## A. Tunnel route family (the biggest roadmap block)

These all depend on knowing where the tunnel runs.

| Feature | What it is | Why someone wants it |
|---|---|---|
| **Alignment upload** | Upload the tunnel route as KML or CSV. It's drawn on the map with chainage ticks | 4/5 personas. Without the route, the data can't be read in terms of the tunnel |
| **Corridor filter** | Each borehole gets a chainage and an offset from the route. "Show holes within 200 m" | Boreholes 2 km from the route are irrelevant |
| **Tunnel horizon band** | A crown-to-invert band drawn on each profile, plus a "tunnel horizon only" filter | The TBM engineer only cares about ground at tunnel depth |
| **Longitudinal section** | A new screen: all boreholes in a row along the route, with the tunnel, rock-head and groundwater lines drawn between them | The single strongest picture for TBM engineers, so it leads the roadmap slide |
| **Ground class per layer** | Soft / mixed / weak rock / hard rock, derived and editable | Feeds map colouring and summaries |
| **Project summary** | Tender-brief cards (% rock vs soil, groundwater, worst ground, data gaps) and P10–P90 parameter tables per rock unit | The bid manager wants one page. The TBM engineer wants parameter ranges |
| **Similar projects** | "Find similar ground" across past projects, with the TBM type used | Needs fields the data doesn't have yet: TBM type, diameter, outcome |

## B. Trust and sign-off

| Feature | What it is | Why |
|---|---|---|
| **Per-value audit trail** | The AI value, then who changed it, when, old → new, and why. A clock icon on edited fields | Geologist: needed to defend the data in a claim years later |
| **Approve & lock revision** | Freeze an approved data set. Any later edit opens a new draft | Geologist: liability needs a fixed version |
| **Evidence pack (PDF)** | Every edited or flagged value with its crop, history and sign-off | The file a claims team needs |
| **Move boundary with reason** | Drag a layer boundary, see which values are affected, give a mandatory reason | The geologist caught a sample depth misread as a layer boundary |
| **"Read from column X" label** | Shows which table column a value came from, and highlights the row and header | How the geologist found that misread |
| **Confidence reason line** | A one-line explanation under each badge | Explains *why* a value is "Guessed" |
| **Spot-check mode** | All flags plus a random 10 % sample, each tick logged | A real QA method that also covers bulk-approved values |
| **"Find similar misreads"** | One misread found → find the same pattern on the same template | Template errors repeat |
| **Review status chain** | Extracted → Reviewed → Approved, with names, plus "18 of 23 reviewed" | Shows how trustworthy a data set is at a glance |
| **Viewer role** | Approve and Edit buttons hidden | Stops sales staff from approving geotechnical data by accident |

User accounts are the blocker for most of this group. The demo covers trust with "Show source" and keeping the AI value visible after edits.

## C. Speed for bulk reviewers

| Feature | What it is | Why |
|---|---|---|
| **Keyboard review flow** | N = next uncertain field, Enter = approve, E = edit, F = flag, `?` = help | The reviewer counted ~4,500 clicks for one batch without it |
| **Auto-follow source** | Focusing a field scrolls the scan to it automatically | Saves one click per field |
| **Bulk approve variants** | "Approve all ≥ threshold", "Approve layer", "Approve page" | Faster clearing of clean data. "Approve all clean" covers the demo |
| **Project header panel** | Values shared by every borehole (project, client) shown once, with "Apply to all" | 30 logs repeat the same header 30 times |
| **Number-format control** | Set decimal and thousands separators per document by hand | The normaliser auto-detects them for now |
| **Review filters** | "Show only guessed / OCR / edited / flagged" | Cuts thousands of fields down to the few dozen that matter |
| **Batch grid** | One row per borehole, cells coloured by confidence | For many one-page logs on the same template |
| **Source viewer tools** | Pop out to a 2nd monitor, rotate, magnify | Scans are unreadable at half a laptop screen |
| **Assign / hand-off / "My approvals" inbox** | Assignee, due time, progress, notifications | Team workflow. Needs accounts |
| **Review summary** | "Edited 212 · illegible 31 · escalated 9" | A hand-off report. The open-questions CSV covers it for now |

Keyboard review is the real productivity win for QA staff, but it's invisible in a 5-minute demo, so it's cut.

## D. Handling messy documents

| Feature | What it is | Why |
|---|---|---|
| **Sheet stitching** | A "Sheets 1/3 ✓ 2/3 ✓ 3/3 ✓" chip, plus "Merge with…" and "Split here" | Logs that run over many sheets are where data silently disappears. For now the pipeline groups sheets by borehole ID and the lint catches missing bottoms |
| **Page-type override and re-extract** | Fix a misclassified page and re-run extraction on just that page | The page map stays read-only for now |
| **Investigation type** | Borehole / cored / test pit / hand auger / dynamic probe | Probe blow counts must never be mixed with SPT values |
| **Georeference from control points** | Match 2–3 points on a site plan to the map, with the error in m | The fallback when no CRS candidate fits |
| **Vertical datum conversion** | Store the datum and convert elevations to sea level | For now: store the datum as stated and label it "datum unconfirmed" |
| **Lab-table linking** | Read lab tables covering many boreholes and link rows to samples by ID and depth | UCS and CAI often sit in separate lab tables. It's a separate extraction problem |
| **Test method per lab value** | Direct UCS vs UCS from point load, natural vs sawn CAI surface | Mixing the methods corrupts the wear estimate |
| **Hints box at upload** | "Report is in Norwegian, CRS is UTM 32" | Helps extraction. Nice to have |

## E. Map and sales extras

| Feature | What it is | Why |
|---|---|---|
| **Presentation mode** | Hide controls and anonymise other clients' projects | The bid manager's deal-breaker is exposing another client's project |
| **KPI strip** | "N projects · M boreholes · K countries" | The opener for experience slides |
| **"Colour by" dropdown** | Colour by review status / ground class / max UCS | Nobody wanted colour by depth as the default |
| **Parameter chips** | "UCS 5 · CAI 3 · RQD 14" | Replaces the vague "has rock data" filter |
| **Column picker, filter chips, region chips** | Customise the results table and filters | Power-user convenience |
| **"Other projects" layer** | Show boreholes from earlier bids nearby | Reuse old data. Must respect confidentiality |
| **Tender basket** | Collect boreholes into a pack | Like the LGRB "Merkliste" |
| **Picture exports** | Map PNG, section PDF, 1-page brief PDF, .pptx | For decks. Screenshots do the job for now |
| **Tablet layout, language switch, read-only API** | Large tap targets, EN/DE/AR, "Copy as pandas" | Single-persona nice-to-haves |

## F. Borehole detail extras

| Feature | What it is | Why |
|---|---|---|
| **Hazard tags** | Boulders, cavities/karst, gas, obstructions, contamination | These are what actually stop TBMs |
| **Extra rock fields** | Weathering grade, fracture frequency, SCR, vane shear | Rock-mass quality for TBM and support design |
| **Depth / elevation toggle** | Switch the axis, with a "surface elevation missing" badge | Without elevation, the tunnel band lands in the wrong place |
| **Core runs tab** | TCR, RQD and SCR per drilling run | Core runs don't line up with soil layers |
| **Parameter track** | SPT N, UCS and RQD plotted vs depth beside the profile | Misread spikes jump out visually |
| **Plain-language summary** | A one-line summary above the profile, built from a template | For the bid manager. Never free LLM text |

---

## How the features fit together

- **One record powers Part 1.** Nearly everything depends on one decision in feature 2: every value carries its raw text, page, box and method. "Show source", approved-only export, the method badges and the open-questions list all read from that one record. That's why the plan builds feature 2 first.
- **Two missing objects block most of the roadmap:** a **project record** (route, diameter, TBM type, confidentiality) and **user accounts**. Groups A and E need the project record. Groups B and C need accounts. Neither shows up on screen, so they lose this weekend to things the jury can see.
- **Groundwater is the shared gap.** Besides "Show source", groundwater is the only need all 5 personas shared, and Herrenknecht's own target format stores it as a single number. That makes a good line for the "problem understanding" part of the pitch.
