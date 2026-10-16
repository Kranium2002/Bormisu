# UI ↔ API contract

This is what the UI calls and what it expects back. It is written from the frontend side and based on the backend on `arav/dev` at commit `49c84dd` (FastAPI, `backend/api/`). The backend team owns the final shape. **If you rename something, update this file**, so the UI wiring matches.

UI features per screen: [../personas/ui-features.md](../personas/ui-features.md). Field and endpoint names in this file override the shorthand used there.

---

## 1. Summary for the backend team

The existing API already covers listing, detail, per-borehole export and stats. To support the UI flow (upload → review → detail → map → export) it needs these additions, most important first:

1. **P0 · Provenance per value plus page images.** For every extracted value: the page, the box on the page, the raw text and the method. Also an endpoint that serves page images. Without these there is no "Show source" and no Review screen. All 5 personas named this as their #1 need, and it is the demo's wow moment.
2. **P0 · A unique borehole key.** Borehole IDs like `BH-1` repeat across reports, and `GET /boreholes/{id}` does a substring match (`"BH-1"` also matches `"BH-10"`). Clicking a map pin can open the wrong borehole.
3. **P0 · No made-up defaults.** Unknown values must be `null`, not `"Sand"`, `"SP"`, `0.90`, `"WGS84"` or `"EPB"`. Showing a confident value that isn't in the source is the core user's deal-breaker.
4. **P0 · Upload returns immediately; extraction runs in the background, and the document has a status.** `POST /extract/upload` currently blocks until extraction finishes. That takes minutes on a long PDF, which risks a browser timeout and leaves no queue screen.
5. **P1 · Review actions** (approve, edit, flag), a review status, SPT raw/refusal, a groundwater list, a CRS status, and document-level exports including "open questions".

---

## 2. What exists today (`arav/dev` 49c84dd)

All routes are mounted under both `/api/v1` and `/api`. **The UI uses `/api/v1`.**

| Method | Path | Returns | UI uses it for | Status |
|---|---|---|---|---|
| GET | `/api/health` | `{status, service, version, standards}` | Demo-mode banner | 🟡 add `mode` |
| POST | `/api/v1/extract/upload` | multipart `file`, `force_refresh` → `BoreholeDocumentResponse` (**blocking**) | Upload & queue | 🟡 make it async (§4.4) |
| POST | `/api/v1/extract/file` | `{file_path, force_refresh, max_pages}` → `BoreholeDocumentResponse` | Not used by the UI (dev tool) | – |
| GET | `/api/v1/boreholes` | `?country&min_depth_m&max_depth_m&rock_type&search` → `{count, boreholes: BoreholeRecord[]}` | World map pins, results table, search | 🟡 add fields (§5) |
| GET | `/api/v1/boreholes/{borehole_id}` | `BoreholeRecord` (substring match) | Borehole detail | 🟡 use `uid`, exact match |
| GET | `/api/v1/export/{borehole_id}/excel` | Herrenknecht xlsx, one borehole | Export menu | 🟡 add document-level export |
| GET | `/api/v1/export/{borehole_id}/json` | JSON, one borehole | Export menu (optional) | ✅ |
| GET | `/api/v1/stats` | totals, countries, DIN distribution | Map KPI strip (LATER) | ✅ |
| GET | `/api/v1/dataset/files` | files in the local challenge dataset folder | Not used by the UI (dev tool) | – |

Error shapes today: `HTTPException` returns `{"detail": "..."}`, and the global handlers return `{"error": "...", "detail": ...}`. **The UI reads `detail` in both cases.**

---

## 3. Screen → endpoint wiring (NOW features)

Legend: ✅ works today · 🟡 exists, needs the change in §4 · ❌ missing.

### Upload & queue

| UI element | Call | Fields used | Status |
|---|---|---|---|
| Drop zone | `POST /api/v1/documents` (multipart `file`) | `document_id`, `status` | ❌ (today: blocking `/extract/upload`) |
| Queue rows | `GET /api/v1/documents` | `document_id, file_name, status, page_count, found` | ❌ |
| Status steps (polled every 2 s until `needs_review`, `done` or `failed`) | `GET /api/v1/documents/{document_id}` | `status`, `error` | ❌ |
| Found chips | same | `found {boreholes, layers, spt, groundwater}` | ❌ |
| Page map | same | `pages[] {n, type, used, unused_reason}` | ❌ |
| Page thumbnail on hover | `GET /api/v1/documents/{document_id}/pages/{n}.png?w=200` | image | ❌ |
| Completeness chip and panel | same as status | `completeness {expected_ids, found_ids, missing, unexpected}`, `lint[]` | ❌ |

### Extraction review

| UI element | Call | Fields used | Status |
|---|---|---|---|
| Borehole switcher | `GET /api/v1/documents/{document_id}/boreholes` | `BoreholeRecord[]` | ❌ |
| Source pane (page image) | `GET /api/v1/documents/{document_id}/pages/{n}.png` | image | ❌ |
| Highlight the box on field focus | from the record | `provenance[path].page`, `.box` | ❌ |
| Raw → normalised | from the record | `provenance[path].raw` + the field value | ❌ (value ✅, raw ❌) |
| Method badge | from the record | `provenance[path].method`, `.confidence` | ❌ |
| Approve / Edit / Flag / Not in source / Illegible | `PATCH /api/v1/boreholes/{uid}/values` | body in §5.3 | ❌ |
| "Approve all clean" (count first) | `POST /api/v1/documents/{document_id}/approve-clean?dry_run=true`, then `dry_run=false` | `{count}` | ❌ |
| 3-line lithology | from the record | `original_description`, `english_lithology`, `din4023_code` | ✅ |
| SPT with R badge | from the record | `spt_raw`, `spt_n_value`, `spt_refusal` | 🟡 `spt_n_value` only today |
| Groundwater readings | from the record | `groundwater[]` | 🟡 a single `water_table_m` today |
| Lint flags | from the record | `lint[]` | ❌ |
| *Stretch:* CRS candidates + mini-map | `GET /api/v1/documents/{document_id}/crs-candidates`, `POST …/crs` | §5.4 | ❌ |

### Borehole detail

| UI element | Call | Fields used | Status |
|---|---|---|---|
| Whole screen | `GET /api/v1/boreholes/{uid}` | `BoreholeRecord` | 🟡 `uid` + exact match |
| DIN 4023 profile column | from the record | `stratigraphy[] {depth_from_m, depth_to_m, din4023_code}` | ✅ |
| ▽ per groundwater reading | from the record | `groundwater[] {type, depth_m}` | 🟡 |
| Amber R marker on the profile | from the record | `stratigraphy[i].spt_refusal`, `spt_depth_m` | ❌ |
| Source icon on every value → Source panel | from the record + page image | `provenance[path]` + `/documents/{document_id}/pages/{n}.png` | ❌ |
| Metadata card | from the record | `metadata.*`, `rock_head_m`, `crs_status` | 🟡 add `rock_head_m` (or the UI derives it), `crs_status` |
| Layer table | from the record | `english_lithology`, `spt_*`, `rqd_pct`, `core_recovery_pct` | ✅ (SPT 🟡) |
| Review status chip | from the record | `review_status` | ❌ |

### World map

| UI element | Call | Fields used | Status |
|---|---|---|---|
| Pins | `GET /api/v1/boreholes` | `uid`, `metadata.coordinates.latitude/longitude`, `review_status`, `crs_status` | 🟡 |
| "Not on map" list | same | records where `plotted == false`, plus `unplotted_reason` | ❌ |
| Search | `GET /api/v1/boreholes?search=` | – | ✅ |
| Popup → detail | `GET /api/v1/boreholes/{uid}` | – | 🟡 |

### Export menu

| UI element | Call | Status |
|---|---|---|
| Project xlsx (target format + Provenance sheet) | `GET /api/v1/documents/{document_id}/export?format=xlsx&include_unreviewed=false` | 🟡 per-borehole xlsx exists; needs document level and a Provenance sheet |
| Tidy CSV (one row per value) | `…/export?format=csv&include_unreviewed=false` | ❌ |
| Open questions CSV | `…/export?format=questions` | ❌ |
| Excluded count ("38 unreviewed values excluded") | `GET …/export/preview` → `{excluded_unreviewed}` | ❌ |
| DRAFT stamp | the backend stamps the file when `include_unreviewed=true` | ❌ |

We use the **document** as the "project" unit for this weekend. A real project object is on the roadmap.

---

## 4. Changes needed, by priority

### P0: the demo breaks without these (target: Sat 12:00 walking skeleton)

**4.1 Provenance per value.** Add a `provenance` map to `BoreholeRecord`, keyed by the field's path. This is additive, so the existing fields stay as they are. Each entry:

```json
"provenance": {
  "metadata.borehole_depth_m":   { "page": 7, "box": [0.61, 0.82, 0.07, 0.02], "raw": "18,00 m",
                                   "method": "ocr", "confidence": 0.82, "status": "unreviewed",
                                   "state": "ok", "ai_value": 18.0 },
  "stratigraphy[2].spt_n_value": { "page": 7, "box": [0.18, 0.44, 0.30, 0.03], "raw": "50/30",
                                   "method": "read", "confidence": 0.95, "status": "unreviewed",
                                   "state": "ok", "ai_value": null }
}
```

- `box` is `[x, y, w, h]`, **normalised 0–1 relative to the page image**, with the origin at the top-left. `null` means the box was not found: the UI then shows the whole page with a "box not found" note.
- `method`: `read` (text layer) · `ocr` · `derived` (computed, e.g. thickness) · `guessed` (the LLM inferred it, not printed on the page) · `edited` (set by a human).
- If the vision model can't return boxes, a fallback is good enough for the demo: the page number plus a box for the **row** the value sits in.

**4.2 Page images.** `GET /api/v1/documents/{document_id}/pages/{n}.png?w=1400` returns the rendered page as PNG. Pages are 1-based. `w` sets the width and is optional. The UI needs the same page numbering as `provenance[].page`.

**4.3 A unique borehole key.** Add `uid` and `document_id` to `BoreholeRecord`, e.g. `uid = "<document_id>:<borehole_id>"` (URL-encoded in paths). `GET /api/v1/boreholes/{uid}` must match **exactly**. Keep the old ID route only if something else needs it.

**4.4 Async upload + document status.** `POST /api/v1/documents` saves the file, starts extraction in the background (FastAPI `BackgroundTasks` is enough) and returns `202 {document_id, status: "queued"}` at once. `GET /api/v1/documents/{document_id}` returns the document object (§5.2). The UI polls it every 2 s.

**4.5 No made-up defaults.** In `schemas.py` these defaults turn "unknown" into a confident-looking value. Make them `None`:

| Field | Default today | Should be |
|---|---|---|
| `StratigraphicLayer.din4023_code` | `"Sand"` | `None` |
| `StratigraphicLayer.uscs_group` | `"SP"` | `None` |
| `DocumentInfo.confidence_score` | `0.90` | `None` |
| `CoordinatesModel.coordinate_system` | `"WGS84"` | `None` (plus `crs_status`, §4.8) |
| `TBMEngineeringAssessment.*` | `"Moderate"`, `"Stable"`, `"Dry / Minor"`, `"EPB"` | `None` when not computed |

The UI shows `null` as *"not in source"* in grey italics. It never shows 0 or a default.

### P1: NOW features (target: Sat 16:00 go / no-go)

**4.6 Review actions.**
- `PATCH /api/v1/boreholes/{uid}/values` with the body in §5.3. It updates `provenance[path].status` / `.state`. On an edit it sets `method: "edited"`, keeps `ai_value` and writes the new value into the field.
- `POST /api/v1/documents/{document_id}/approve-clean?dry_run=true|false` approves every value with `method == "read"`, no flag and no lint warning. It returns `{count}`.
- Add `review_status` to `BoreholeRecord`: `unreviewed` until any value is approved, `reviewed` when all are approved or have a state.

**4.7 SPT and groundwater.**
- Add `spt_raw` (string as printed), `spt_refusal` (bool), `spt_increments` (int[]), `spt_penetration_cm` and `spt_depth_m` to the layer. `"50/30"` → `spt_refusal: true`, `spt_n_value: null`. **Never store N = 50.**
- Add `groundwater: [{type, depth_m, date}]` at borehole level. `type` is one of `strike` · `rest` · `standpipe` · `other`. Keep `water_table_m` for backward compatibility.

**4.8 CRS status and plottability.**
- `crs_status`: `stated` (printed in the report) · `inferred` (we guessed) · `confirmed` (a human confirmed) · `unknown`.
- `plotted: bool` and `unplotted_reason` (`"no coordinates"` / `"CRS unknown"`).
- Keep the original coordinates as printed in `provenance`.

**4.9 Checks.** `lint: [{path, rule, severity, message}]` on the borehole (`severity`: `warning` | `error`). Rules for the demo:
- gaps or overlaps between layers
- log bottom ≠ `borehole_depth_m`
- SPT or groundwater below the final depth
- UCS > 300, CAI > 6.5, RQD or TCR > 100

`completeness` on the document compares the borehole IDs the report lists with the IDs extracted.

**4.10 Document export.** `GET /api/v1/documents/{document_id}/export?format=xlsx|csv|questions&include_unreviewed=false`:
- **xlsx:** the existing target-format sheets for all boreholes in the document, plus a `Provenance` sheet (path, page, method, status).
- **csv:** one row per value, with columns `uid, path, value, unit, raw, page, method, status`.
- **questions:** columns `borehole_id, page, question`, built from flags, `illegible` / `not_in_source` states, `crs_status != stated/confirmed`, and missing IDs.

With `include_unreviewed=true`, stamp the file DRAFT: a title row in xlsx, a first comment line in csv. `GET …/export/preview` returns `{excluded_unreviewed}`.

**4.11 Health mode.** Add `mode: "live" | "demo"` to `/api/health`. It is `demo` when no `MISTRAL_API_KEY` / `OPENROUTER_API_KEY` is set. In demo mode, `POST /documents` returns `409 {"detail": "demo_mode"}`, and the UI shows the banner.

### P2: stretch

**4.12 CRS candidates.**
- `GET /api/v1/documents/{document_id}/crs-candidates` → `[{crs, label, points: [{uid, lat, lon}]}]`.
- `POST /api/v1/documents/{document_id}/crs` with `{crs, confirmed_by, note}` sets `crs_status: "confirmed"` on all its boreholes.

---

## 5. Shapes

### 5.1 `BoreholeRecord` (existing fields unchanged, new fields marked `+`)

```json
{
  "uid": "doc_7f3a:NM-121",                    "+": "unique key",
  "document_id": "doc_7f3a",                   "+": "",
  "source_file": "nordlys_GI.pdf",
  "review_status": "unreviewed",               "+": "unreviewed | reviewed | approved",
  "crs_status": "inferred",                    "+": "stated | inferred | confirmed | unknown",
  "plotted": true,                             "+": "",
  "unplotted_reason": null,                    "+": "",
  "rock_head_m": 11.2,                         "+": "optional; the UI derives it if missing",
  "metadata": {
    "borehole_id": "NM-121", "project_name": "Nordlys Metro (fictional)",
    "borehole_depth_m": 18.0, "surface_elevation_mASL": 212.4,
    "coordinates": { "latitude": 0.0, "longitude": 0.0, "local_x": null, "local_y": null,
                     "coordinate_system": null }
  },
  "stratigraphy": [
    { "depth_from_m": 2.10, "depth_to_m": 4.80, "thickness_m": 2.70,
      "original_description": "arcilla limosa con gravas",
      "english_lithology": "silty clay with gravel",
      "din4023_code": "Clay", "uscs_group": null,
      "spt_n_value": null,
      "spt_raw": "50/30", "spt_refusal": true, "spt_increments": [50],
      "spt_penetration_cm": 30, "spt_depth_m": 4.50,                       "+": "spt_* fields",
      "rqd_pct": null, "core_recovery_pct": null }
  ],
  "groundwater": [                                                         
    { "type": "strike", "depth_m": 1.80, "date": null },
    { "type": "rest",   "depth_m": 1.20, "date": null }
  ],                                           "+": "list; keep water_table_m too",
  "geotechnical_tests": { "...": "unchanged" },
  "tbm_engineering_assessment": { "...": "nulls when not computed" },
  "provenance": { "metadata.borehole_depth_m": { "page": 7, "box": [0.61, 0.82, 0.07, 0.02],
                  "raw": "18,00 m", "method": "ocr", "confidence": 0.82,
                  "status": "unreviewed", "state": "ok", "ai_value": 18.0 } },   "+": "",
  "lint": [ { "path": "metadata.borehole_depth_m", "rule": "log_bottom_vs_final_depth",
              "severity": "error", "message": "Log bottom 14.5 m ≠ final depth 18.0 m" } ]  
}
```

The `"+"` keys only mark what's new. Don't send them.

### 5.2 Document

```json
{
  "document_id": "doc_7f3a",
  "file_name": "nordlys_GI.pdf",
  "status": "needs_review",
  "error": null,
  "page_count": 24,
  "found": { "boreholes": 14, "layers": 196, "spt": 41, "groundwater": 9 },
  "pages": [ { "n": 1, "type": "text", "used": false, "unused_reason": "cover page" },
             { "n": 7, "type": "log",  "used": true,  "unused_reason": null } ],
  "completeness": { "expected_ids": ["NM-101", "NM-102"], "found_ids": ["NM-101"],
                    "missing": ["NM-102"], "unexpected": [] }
}
```

- `status`: `queued` · `classifying` · `extracting` · `needs_review` · `done` · `failed`
- `pages[].type`: `log` · `lab_table` · `text` · `drawing` · `photo` · `unknown`

### 5.3 `PATCH /api/v1/boreholes/{uid}/values`

```json
{ "path": "stratigraphy[2].spt_n_value", "action": "approve" }
{ "path": "metadata.borehole_depth_m",   "action": "edit",  "value": 18.5 }
{ "path": "metadata.surface_elevation_mASL", "action": "flag", "reason": "datum unclear" }
{ "path": "metadata.drilling_date",      "action": "set_state", "state": "not_in_source" }
```

- `action`: `approve` · `edit` · `flag` · `set_state`
- `state`: `ok` · `not_in_source` · `illegible`

The response is the updated `BoreholeRecord`.

### 5.4 CRS candidates (stretch)

```json
[ { "crs": "EPSG:25832", "label": "ETRS89 / UTM 32N", "points": [ { "uid": "doc_7f3a:NM-121", "lat": 0.0, "lon": 0.0 } ] } ]
```

---

## 6. Conventions

- Base path `/api/v1`. CORS is already open (`*`).
- `null` = unknown. Never a default value. `provenance[path].state` says why it's empty.
- Path keys use dots and brackets: `metadata.borehole_depth_m`, `stratigraphy[3].spt_n_value`, `groundwater[0].depth_m`.
- Boxes are normalised `[x, y, w, h]` (0–1, top-left origin). Pages are 1-based.
- Depths are in m below ground, elevations in m, coordinates for the map in WGS84 lat/lon.
- All sample data in fixtures and docs is fictional. No challenge data in the repo.

---

## 7. Other things we noticed (not UI, but they cost points)

1. **Tests fail on a fresh clone.** `backend/tests/test_api_and_schemas.py` expects ≥ 10 boreholes in the local cache, and the cache is gitignored. The AI judge builds from a fresh clone, so these tests fail there. Fix: commit a small **fictional** fixture (one generated document JSON) and point the tests and demo mode at it.
2. **Upload filename used as a path.** `UPLOADS_DIR / file.filename` lets a filename like `../../x` write outside `uploads/`. Use a generated name, e.g. `document_id + suffix`.
3. **A personal path as a default.** `.env.example` and `analytics.py` default `DATASET_PATH` to a personal Windows folder. Use a relative default, or none.
4. **Substring match** in `get_borehole` and the export routes (see §4.3).
