# UI features: what users see and click

This is a UI-only spec for the frontend team. It covers the screens, buttons, panels and states that support each persona's workflow. The backend (pipeline, OCR, LLM, normalisers) is built separately, and it appears here only where it becomes visible: as a badge, a state or a warning.

It comes from the [persona simulation](personas.md): 5 simulated Herrenknecht users walked through the planned screens. The scope follows [build-cut.md](build-cut.md).

**Tags:**
- **NOW** is in the build cut for Sun 11:30. Build it.
- **LATER** is on the roadmap. Don't build it this weekend, but leave room for it in the layout.

**Persona codes:** 01 geotechnical engineer (core user) · 02 TBM design engineer · 03 senior geologist (approver) · 04 data reviewer · 05 bid manager

All names, IDs and values in this file are fictional.

---

## 0. Decisions already made for you

The personas disagreed on a few things. These are the calls we made, so the UI is consistent:

| Question | Decision |
|---|---|
| Confidence % or method badge? | **Method badge first**: `Read` / `OCR` / `Derived` / `Guessed` / `Edited`. The % appears only on hover and is used for sorting. A green "90 %" was wrong in the geologist's walkthrough, so green must never imply "correct". |
| Does "Show source" open the Review screen or a side panel? | **A side panel on the same screen** (the Source panel, §2.1). Inside it, an **"Open in review"** button covers editing. |
| What is the bulk-approve button called? | **"Approve all clean"**: approves only `Read` values with no flags and no lint warnings. No "≥ 90 %" threshold. |
| Feature names (the personas used several) | **Longitudinal section** · **Export open questions** · **Page map** · **Completeness** |
| Default map colouring | **By review status.** Every persona who mentioned colour by depth called it useless. |
| Keyboard approve key (LATER) | Support both sets: `A` and `Enter` approve, `J`/`K` and `Tab`/`Shift+Tab` move. |

---

## 1. The workflows the UI must support

### 1.1 The NOW flow (the demo, persona 01)

```
Upload & queue ──► Extraction review ──► Borehole detail ──► World map ──► Export
 drop report        check & approve        DIN profile         pin status      xlsx + open
 page map           raw → normalised       click "R" ⇒ source  (amber = CRS    questions
 completeness       method badges          panel (WOW)          inferred)
```

**Moments the UI must get right:**
1. **After processing finishes:** the queue row has to answer "did it miss anything?" with found counts, the page map, and a "1 borehole ID missing" warning.
2. **In review:** the raw value sits next to the normalised one, and "50/30" shows as an **R** refusal, not N = 50.
3. **In detail:** click the amber **R** on the profile and the Source panel opens with the scan cell boxed. This is the demo's wow moment.
4. **On export:** approved values only by default. Including unreviewed values stamps the file **DRAFT**.

### 1.2 Each persona's path

Steps in **bold** are NOW. The rest are LATER.

| Persona | Click path | Where the UI must support them most |
|---|---|---|
| 01 Geotech | **Upload** → **Queue (page map, completeness)** → **Review (approve all clean, 3-line lithology, SPT)** → **Detail (rock head, GW readings)** → **Export project xlsx** + **open questions** → later: alignment, longitudinal section | Proof that nothing was missed, then fast approval of clean values |
| 02 TBM | Upload → Queue (found chips) → "Review lab values first" → Map (import alignment, corridor, tunnel horizon filter) → **Detail** → **Show source** on a suspicious UCS → Ground parameters → **Export tidy CSV** | One click from a suspicious number to its source page. Unreviewed values excluded by default |
| 03 Geologist | My approvals → **Queue row (completeness)** → **Review (CRS confirm, method badges)** → **Detail → Show source on a layer boundary** → History → Approve & lock → Evidence pack | The source crop appears on the same screen, showing the whole row and column header |
| 04 Reviewer | Queue (workload) → Page triage → **Review** (keyboard, project header, number format, SPT editor) → next borehole ×30 → Hand off → **Export open questions** | A keyboard-only loop, and setting the header, number format and CRS once per document |
| 05 Bid | **Map** (KPI strip, presentation mode) → project pin → Project summary → tap a number → source → Export tender brief PDF | No leak of other clients' names, and every summary number links to its source |

---

## 2. Global UI (on every screen)

### 2.1 NOW

| Element | Where | What it does | States |
|---|---|---|---|
| **App bar** "BORMISU · Borehole Intelligence for Herrenknecht" + nav: **Map · Upload & queue · Review** | Top, dark green `#003E25` | Navigation. Borehole detail opens from the map, review or queue | active tab gets a green underline `#7DB713` |
| **Demo-mode banner** "Demo mode: fictional sample loaded. Live extraction needs an API key." | Under the app bar | Shown when the backend reports that no key is set | shown / hidden |
| **Source icon** (small document icon) | Next to **every** extracted number and layer boundary, on every screen | Opens the Source panel | – |
| **Source panel** (slide-over from the right) | Right edge of the screen | Contents: page image zoomed to the value, the value's **box highlighted**, the label "page 7 · sheet 2 of 3", the method badge, the raw text as printed. Button **"Open in review"**. `Esc` closes it | loading / box found / **"box not found: page shown"** |
| **Method badge** `Read` · `OCR` · `Derived` · `Guessed` · `Edited` | On every value in Review and Detail | Hover shows the confidence % and, for `Derived`, the formula | 5 types, each with its own colour, none of them green |
| **Field state** | Any empty value | Shows *"not in source"* or *"illegible"* in **grey italics**. A blank never shows as 0 | not in source / illegible |
| **Review status chip** `Unreviewed` · `Reviewed` · `Approved` | Queue rows, map pins, Detail header | Display only | grey / green / green with a check |
| **R badge** | Every SPT refusal (Review, layer table, profile) | Tooltip: raw "50/30", blows, penetration + unit. Never shown as N = 50 | amber |
| **DRAFT stamp** | Any export or view that includes unreviewed data | Automatic | – |

### 2.2 LATER

- **Roles:** a Viewer role hides Approve and Edit everywhere, so sales can't approve geotechnical data (05).
- **Status chain with names:** Extracted (AI, time) → Reviewed (name, time) → Approved (name, time) (03).
- **Clock icon on edited values:** opens the history: AI value, then who / when / old → new / reason (03).
- **"My approvals" inbox:** the approver's landing page, plus deep links straight to a report (03).
- **Notifications:** hand-off, "Ask engineer", and an edit after approval (03, 04).
- **Presentation mode:** hides controls and anonymises other clients' projects, e.g. "Metro · Middle East · 2021" (05, deal-breaker).
- **"Add to tender pack" basket**, a dataset version stamp on exports, a language switch, a tablet layout (05, 02).

---

## 3. Upload & queue

**Purpose:** get a report in, and prove what was read and what was skipped. **Used by:** everyone, 01 first.

```
┌ BORMISU   Map │ Upload & queue │ Review                                        ┐
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────── Drop PDF, DOCX or images here ───────────────┐            │
│  └───────────────────────────────────────────────────────────────┘            │
│  DOCUMENT            STATUS                                   CHECKS          │
│  nordlys_GI.pdf      ● classifying ● extracting ◐ needs review ○ done        │
│   [14 BH] [196 layers] [41 SPT] [9 GW readings]               ⚠ 1 ID missing │
│   ▮▮▯▯▮▮▮▮▯▯▯▯▮▮▮▯▯▯▯▯▯▯▮▮  ← page map (colour = page type)               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### NOW

| Control | Where | What it does | States |
|---|---|---|---|
| **Drop zone** | Top | Accepts PDF, DOCX, JPG, PNG. Uploads and adds a row | drag-over / uploading / error "file type not supported" |
| **Status steps** `classifying → extracting → needs review → done` | Row | Display, polled from the backend | per step: pending / active / done / failed |
| **Found chips** `14 BH · 196 layers · 41 SPT · 9 GW readings` | Under the status | Display. Tells "0 found" apart from "not processed yet" | 0 is shown explicitly |
| **Page map** | Under the row | One cell per page, coloured by type: log / lab table / text / drawing / photo. Hover shows a thumbnail and the reason for unused pages ("unused: photo"). Click opens the page in the Source panel. **Read-only** | – |
| **Completeness chip** "Report lists 14 · extracted 13 · ⚠ 1 missing" | Right side of the row | Click opens the **Completeness panel**: borehole IDs named in the report vs extracted, **missing in red, unexpected in amber**, plus lint results (log bottom ≠ final depth, gaps, out-of-range values) | ok / warning / error |
| **Row click** | Row | → Extraction review for this document | disabled until "needs review" |

### LATER

- **Project picker** and **"New project"** in the upload dialog (01).
- **Hints box:** languages, CRS, datum (01).
- **Progress and ETA:** "page 40 of 160 · ~12 min left", plus a **"Notify me"** bell (01, 05).
- **Page triage:**
  - page-type override by right-click
  - rotate (`R`), change form type (`T`), merge (`M`), split (`S`)
  - **"Re-extract changed pages"**

  (01, 04)
- **"View unused pages"** gallery with a reason per page (03).
- **"Review lab values first"** row action (02).
- **Assignment:** "Assign reviewer", Assigned / Due / Progress columns, a workload strip, "Hand off" (04, 05).
- **"Use as draft"** switch (05).

### What the UI needs from the backend

- **Document:** id, name, status, page count.
- **Per page:** type and unused reason.
- **Found counts.**
- **Completeness:** expected IDs, found IDs, lint list `{borehole, rule, message, severity}`.

---

## 4. Extraction review

**Purpose:** check every extracted value against the scan, fix it, approve it. **Used by:** 01, 03, 04. This is our differentiator.

```
┌ Review · nordlys_GI.pdf · BH NM-121 · sheet 1/2        [Approve all clean]  ┐
├────────────────────────────────┬────────────────────────────────────────────┤
│ SOURCE  page 7                 │ FIELDS                                     │
│                                │ Surface elev.  "Cota 212,4" → 212.4 m      │
│     ┌─────────┐                │                [OCR]        ✓  ✎  ⚑       │
│     │ boxed   │ ← highlighted  │ CRS            not stated · inferred ⚠     │
│     └─────────┘   on focus     │ ── Layer 3 · 2.10–4.80 m ─────────────────  │
│                                │   arcilla limosa con gravas   (as printed) │
│                                │   silty clay with gravel      (English)    │
│                                │   DIN: T, u, g                (mapping)    │
│                                │ SPT @ 4.50 m   "50/30" → [R] refusal       │
│                                │ GW   strike 1.80 m · rest 1.20 m  [Read]   │
└────────────────────────────────┴────────────────────────────────────────────┘
```

### NOW

| Control | Where | What it does | States |
|---|---|---|---|
| **Source pane** | Left half | The page image. Focusing a field scrolls the page to its box and highlights it | box found / "box not found" |
| **Borehole switcher** "BH NM-121 · sheet 1/2 ◀ ▶" | Header | Moves between boreholes in the document | – |
| **Raw → normalised** `"Cota 212,4" → 212.4 m` | Each field | The raw text stays visible, so the user sees exactly what the tool changed | – |
| **Method badge** | Each field | See §2.1 | 5 types |
| **✓ Approve · ✎ Edit · ⚑ Flag** | Each field and each layer row | Approve marks it reviewed. Edit opens inline input and **keeps the AI value shown struck-through**. Flag asks for a short reason | unreviewed / approved / edited / flagged |
| **"Not in source"** and **"Illegible"** buttons | Each empty or edited field (menu or small buttons) | Sets the field state | grey italics |
| **3-line lithology** | Each layer | as printed / English / DIN mapping | – |
| **SPT field** | Each test | Raw string, N, and an **R badge** for refusals. Tooltip shows the increments | **red if the increments don't add up to N** |
| **Groundwater readings** | Borehole section | A list, one row per reading (strike / rest / standpipe): depth + method badge | – |
| **Lint flags** | On the affected field | e.g. "UCS 420 MPa out of range", "log bottom 14.5 m ≠ final depth 38.0 m" | warning (amber) / error (red) |
| **"Approve all clean"** | Header, right | Approves every `Read` value with no flag and no lint warning. Shows a count first: "Approve 212 clean values?" | disabled when there are 0 |

**Stretch (NOW if time, drop first):**
- **Confirm CRS once per document.** The CRS field opens a picker with 2–3 candidates, each with a **mini-map preview** of all the pins. A wrong CRS lands the pins in the sea, so the right one is obvious.
- **"Confirm for whole document"** stores the CRS and the user's name. The map pins turn from amber to green.

### LATER

- **Keyboard flow (04 calls it a must):**
  - `N` next uncertain field
  - `A`/`Enter` approve, `E` edit, `F` flag
  - `X` not in source, `I` illegible, `U` unsure → escalate
  - `Ctrl+→` next borehole
  - `?` shows the keyboard map
  - the focus ring is always visible
- **Project header panel (04):** values shared by all boreholes are shown once, with **"Apply to all 30 boreholes"** and a warning chip "29 match · 1 differs".
- **Number format control (04):** "Decimal: comma · Thousands: dot (detected)". Changing it re-parses every field.
- **Sheet stitching (01):** chip "Sheets 1/3 ✓ 2/3 ✓ 3/3 ✓", plus **"Merge with…"** and **"Split here"**.
- **Investigation type dropdown (04):** borehole / hand auger / dynamic probe. Probe blows never go to SPT.
- **Source pane tools (04):** **"Pop out source"** to a 2nd monitor, rotate `[` `]`, magnify `Z`.
- **Review filters (03, 02):** "Show only guessed / OCR / edited / flagged", "lab values first", spot-check mode.
- **"Read from: column 'Sample depth'" (03):** highlights the whole row and its column header on the scan.
- **"Move boundary" (03):** shows a preview of the affected values and requires a reason.
- **Vertical datum fields and "datum unconfirmed" (03).**
- **Approve & lock revision (03):** disabled while flags are open. Any later edit creates draft Rev B.
- **Lab-table linking (01, 02):** an "Unlinked tests" list, "Link to borehole…", and a test-method dropdown (direct UCS / from point load).

### What the UI needs from the backend

- **Every value as one record:** `{raw, value, unit, page, box, method, confidence, status, state, ai_value}`, plus `lint[]`.
- **Endpoints:**
  - `PATCH value`: approve / edit / flag / set state
  - `POST approve-clean`: returns a count
  - CRS candidates with their WGS84 points (stretch)

---

## 5. Borehole detail

**Purpose:** see one borehole the way engineers think about it, and trust every number on it. **Used by:** everyone.

```
┌ BH NM-121 · Project Nordlys Metro (fictional) · [Reviewed]     [Export ▾]   ┐
├──────────────┬──────────────────────────────────────────────────────────────┤
│ PROFILE      │ METADATA                                                      │
│  0 m ▓▓▓▓    │ Final depth 18.0 m · Rock head 11.2 m ⓘ · Elev. 212.4 m ⓘ    │
│  2 m ░░░░ ▽  │ X/Y …  CRS: inferred ⚠   Dates …   [mini-map]                 │
│  4 m ▒▒▒▒    ├──────────────────────────────────────────────────────────────┤
│  6 m ▒▒▒▒ R  │ LAYERS                                                        │
│  8 m ████    │ from–to   │ lithology            │ SPT     │ RQD │ TCR │ ⓘ    │
│ 10 m ████    │ 2.10–4.80 │ silty clay w. gravel │ R 50/30 │  –  │  –  │ ⓘ    │
│ (DIN 4023)   │ GROUNDWATER  strike 1.80 m ⓘ · rest 1.20 m ⓘ                 │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

### NOW

| Control | Where | What it does | States |
|---|---|---|---|
| **DIN 4023 profile column** | Left | Depth axis, DIN colours and hatching per layer (see [din4023-cheatsheet.md](../design/din4023-cheatsheet.md)) | – |
| **Layer ↔ table sync** | Profile + layer table | Click a layer in one and it highlights in both | selected |
| **▽ per groundwater reading** | On the profile | One marker per reading type (strike / rest), with a legend | – |
| **Amber R marker** | On the profile at each SPT refusal | **Click opens the Source panel with the cell boxed: the demo's wow moment** | – |
| **Source icon ⓘ** | Every value, layer row and boundary | Opens the Source panel (§2.1) | – |
| **Metadata card** | Right, top | Final depth, **rock head** (derived from the first rock layer, with ⓘ), surface elevation, X/Y with CRS status, dates, a mini-map | "CRS: inferred" amber; "not in source" grey italics |
| **Layer table** | Right, middle | Columns: from–to, lithology (English, with the printed text on hover), SPT (R badge), RQD, TCR, ⓘ | – |
| **Groundwater readings** | Right, bottom | Type, depth, ⓘ | – |
| **Review status chip** | Header | See §2.1 | – |
| **Export ▾** | Header, right | Opens the Export menu (§7) for this borehole's project | – |

### LATER

- **Depth / Elevation axis toggle,** with a datum label and a red badge "Surface elevation missing" (01, 02).
- **Tunnel horizon band** across the profile (needs an alignment) (01, 02).
- **Parameter track** beside the profile: SPT N, UCS, RQD vs depth (02, 04).
- **"Compare neighbours"**: the 2 nearest boreholes on each side, with a rock-head line joining them (03).
- **Tabs:** **Lab tests** (01, 02), **Core runs** (02), **History** (03).
- **Plain-language one-line summary** above the profile, built from a template (05).
- **Hazard tags** (boulders, cavities, gas) and a ground-class colour strip (01, 05).
- **Layer-table filters:** "Show all refusals", "Edited by humans" (03).

### What the UI needs from the backend

- **Borehole metadata** (target-format fields, each as a value record).
- **Layers:** `{from, to, lithology_raw, lithology_en, din_code, spt{raw, n, refusal, increments}, rqd, tcr}`.
- **Groundwater** `[]`, **rock head**.

---

## 6. World map

**Purpose:** the way in. See where the data is and what state it's in. **Used by:** 05 first, then 01.

```
┌ BORMISU   Map │ Upload & queue │ Review          [Search project / BH ID]   ┐
├───────────────────────────────────────────────────────┬────────────────────┤
│                                                       │ NOT ON MAP (3)     │
│          ● green = reviewed                           │ BH-14  no coords   │
│          ● grey  = unreviewed                         │ BH-15  no coords   │
│          ● amber = needs attention / CRS inferred     │ BH-16  CRS unknown │
│                                                       │                    │
├───────────────────────────────────────────────────────┴────────────────────┤
│ RESULTS  ID │ project │ depth │ status │ CRS                                │
└────────────────────────────────────────────────────────────────────────────┘
```

### NOW

| Control | Where | What it does | States |
|---|---|---|---|
| **Pins coloured by review status** | Map | green = reviewed, grey = unreviewed, **amber = needs attention or CRS inferred**. Clustered at world zoom | – |
| **Pin popup** | On click | Borehole ID, project, final depth, status chip, **"Open detail"** → Borehole detail | – |
| **"Not on map" list** | Right side | Boreholes without usable coordinates are **listed, not plotted**. A plausible wrong pin is worse than no pin | count in the header |
| **Search** | App bar | By project or borehole ID. Flies to the result | no results |
| **Results table** | Under the map | ID, project, depth, status, CRS status. Row click → Detail | – |
| **Legend** | Bottom-left | Explains the 3 pin colours | – |

### LATER

- **KPI strip** "N projects · M boreholes · K countries" and a **Projects / Boreholes** toggle (05).
- **"Colour by" dropdown:** review status / ground class at tunnel level / max UCS (01, 02, 05).
- **Presentation mode** and **"Export map (PNG / slide)"**, top-right (05).
- **Tunnel route (02, 01):**
  - **"Import alignment"** (CSV / KML)
  - **"Corridor ± 200 m"**
  - **"Tunnel horizon only"**
  - **"Longitudinal section"** button
- **More filters:** parameter chips "UCS 5 · CAI 3 · RQD 14", region chips, borehole-type filter, "My batch" / "Unreviewed" chips (02, 05, 01, 04).
- **Results table extras:** a column picker (chainage, offset, # UCS in band), "Export selection", "Summarise selection" (02).
- **Location outlier flag:** "SV-17 is 38 km from the batch median" (04).
- **Other layers:** "Other projects" layer and georeferencing from control points (01).

### What the UI needs from the backend

- **Borehole list:** `{id, project, lat, lon, crs_status, review_status, final_depth}`.
- **Unplotted list,** with a reason per borehole.

---

## 7. Export menu

Opened from the **Export ▾** button in Borehole detail (and later from the project and the map table).

### NOW

| Option | What you get |
|---|---|
| **Project xlsx (target format)** | The 3 sheets as in Herrenknecht's template (metadata, log, tests), plus a **Provenance** sheet (value → file, page, method, status) |
| **Tidy CSV (one row per value)** | For engineers' own tools (02) |
| **Open questions (CSV)** | Flags, illegible values, inferred CRS, missing borehole IDs. Columns: borehole, page, question. This is the client clarification (RFI) list |
| **"Include unreviewed values"** toggle | **Off by default.** Shows the excluded count: "38 unreviewed values excluded". Turning it on stamps the file **DRAFT** |

Blank cells in an export mean "not in source", never 0.

### LATER

- **"Export approved revision"**, with every other export watermarked "DRAFT – NOT APPROVED" (03).
- **Evidence pack (PDF)**: each edited or flagged value with its crop and history (03).
- **Tender brief (PDF, 1 page)**, **slides (.pptx)**, **map PNG**, **longitudinal section PNG / PDF / DXF** (05, 01).

---

## 8. New screens (all LATER)

Leave room in the nav for these. Don't build them this weekend.

| Screen | Who | What it shows |
|---|---|---|
| **Longitudinal section** | 01, 02, 03, 05 | x = chainage, y = elevation. Each borehole is a narrow DIN column at its chainage. The tunnel is drawn as a tube. Interpolated rock-head and groundwater lines are dashed and labelled "interpolated". Gaps at tunnel level are shaded red |
| **Project summary / tender brief** | 05 | Ground-class share bar ("40 % rock · 45 % soft · 15 % mixed"). Four cards: Ground, Groundwater, Worst ground, Data gaps. A coverage stamp "18 / 23 reviewed" on each card. Every number links to its source |
| **Ground parameters** | 02 | Per rock unit: n, min, P10, P50, P90, max for UCS / CAI / RQD. n shown large. **Cells amber when n < 5** |
| **Compare projects** | 02 | Box plots per parameter, projects side by side |
| **Review summary** | 01, 04 | % approved, flags, illegible, unknown pages, missing sheets, "Export open questions" |
| **My approvals / Revisions** | 03 | The approver's inbox. A revision list with a diff and a source-file fingerprint |
| **Batch grid** | 04 | One row per borehole, cells coloured by confidence |

---

## 9. Colour and state cheat sheet

| Colour / style | Means | Used on |
|---|---|---|
| **Green** `#7DB713` | Reviewed / approved, active nav | Pins, status chips, nav underline |
| **Grey** | Unreviewed | Pins, status chips |
| **Amber** | Needs attention: CRS inferred, SPT refusal (R), unexpected ID, lint warning, n < 5 (later) | Pins, R badge, Completeness, lint flags |
| **Red** | Error: missing borehole ID, SPT sum mismatch, log bottom ≠ final depth, "CRS not stated" | Completeness, SPT field, lint |
| *Grey italics* | Not in source / illegible. Never 0 | Any empty value, cards, exports |
| **Struck-through grey** | The AI's original value after an edit | Review fields |
| Dashed line | Interpolated (later) | Longitudinal section |
| **DIN 4023 palette** | Soil and rock types (an engineering standard, not branding) | Profile column only |

Brand: Herrenknecht green `#7DB713`, dark green `#003E25` for the app bar, text `#181818` / `#555555`, borders `#D6D6D6`, background `#FCFCFC`, Univers (fallback Inter), headings in ALL CAPS. See [herrenknecht-brand.md](../design/herrenknecht-brand.md).

---

## 10. Mock data for building the UI before the backend is ready

The frontend can build against fixtures shaped like this (fictional values). Agree on the final shape with the backend team.

```json
{
  "borehole": {
    "id": "NM-121",
    "project": "Nordlys Metro (fictional)",
    "review_status": "unreviewed",
    "crs_status": "inferred",
    "lat": 0, "lon": 0,
    "final_depth": { "raw": "18,00 m", "value": 18.0, "unit": "m", "page": 7,
                     "box": [412, 1180, 96, 22], "method": "OCR", "confidence": 0.82,
                     "status": "unreviewed", "state": "ok", "ai_value": 18.0 },
    "rock_head": { "value": 11.2, "unit": "m", "method": "Derived", "page": 7, "box": [60, 900, 300, 18] },
    "layers": [
      { "from": 2.10, "to": 4.80,
        "lithology_raw": "arcilla limosa con gravas",
        "lithology_en": "silty clay with gravel",
        "din_code": "T, u, g",
        "spt": { "raw": "50/30", "n": null, "refusal": true, "increments": [50], "penetration_cm": 30 },
        "method": "Read", "page": 7, "box": [120, 640, 380, 40], "status": "unreviewed" }
    ],
    "groundwater": [
      { "type": "strike", "depth": 1.80, "method": "Read", "page": 7, "box": [700, 520, 60, 18] },
      { "type": "rest",   "depth": 1.20, "method": "Read", "page": 7, "box": [700, 545, 60, 18] }
    ],
    "lint": [ { "rule": "log_bottom_vs_final_depth", "severity": "error",
                "message": "Log bottom 14.5 m ≠ final depth 18.0 m" } ]
  }
}
```
