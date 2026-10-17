# Integration guide: frontend ↔ backend

For the teammates who wire the frontend (`frontend/`, branch `prada/frontend`) to the backend (`backend/`, branch `arav/dev`, commit `49c84dd`).
Written Sat 17 Oct 2026 after running both together on one machine.

The agreed API is in `docs/design/api-contract.md` on branch `prada/design` (PR #1). Its §1 lists the backend changes in priority order. This file says what actually happens when you plug the two together today, and in which order to fix things.

**Short version:** the backend starts only with a Mistral key. With one, the map and detail screens already show the backend's records. `GET /api/v1/documents` doesn't exist yet, so the queue is empty and says *The backend has no document list yet (GET /api/v1/documents). Boreholes still show on the map.* (The first run on 17 Oct showed *NO DATA* here; the frontend has tolerated a missing document list since then.) Add that endpoint and declare `uid` and `document_id`, and the queue and the links between reports and boreholes work. Review, upload, saving and CRS need the rest of the contract.

---

## 0. The bh3 backend (branch `felix-integration`): the contract, served

`backend/` on this branch is the bh3 extraction pipeline ([backend/bh3/README.md](../backend/bh3/README.md))
plus a FastAPI service that answers every call in §2 the way `frontend/src/data/apiSource.ts` makes it. It
replaces the §1–§3 steps below for this branch; they stay as the record of the `arav/dev` run.

```bash
cd backend
py -3.10 -m venv .venv && .venv/Scripts/activate            # Windows (Linux/macOS: python3 -m venv .venv && . .venv/bin/activate)
pip install -r requirements.txt
cp .env.example .env                                        # LLM_API_KEY=... for live extraction (Mistral), or LLM_BASE_URL for a local model
python -m bh3 api --store api_data --port 8000              # http://127.0.0.1:8000/api/health → {"mode": "live" | "demo", ...}
# seed the store from an existing bh3 result (one document per source file; page images need the source files):
python -m bh3 api --store api_data --import out3/boreholes.json --data-root <folder with the source documents> --port 8000
```

```bash
cd frontend && npm install && npm run dev                   # proxies /api → http://127.0.0.1:8000
```

What each screen gets from bh3:

| Screen | Served by bh3 | Notes |
|---|---|---|
| Map | `GET /api/v1/boreholes` with `uid`, `document_id`, `plotted`, `unplotted_reason`, `crs_status`, WGS84 `latitude`/`longitude` | pins only for holes whose coordinate system is printed (`stated`), recorded per document with evidence (`inferred`) or confirmed by a reviewer; the rest are listed under *Not on map* with the reason |
| Upload & queue | `GET /api/v1/documents`, `POST /api/v1/documents` → `202 {document_id, status: queued}`, `GET /api/v1/documents/{id}` polled | statuses `queued → classifying → extracting → needs_review` (or `failed` with the error); `found` counts, `pages[] {n, type, used, unused_reason}`, `completeness` from the borehole names the classifier saw on the pages; `409 {"detail": "demo_mode"}` without a model key |
| Review | `provenance[path]` per value with `page`, `box` (the row the value sits in, normalised `[0, y, 1, h]`), `raw`, `method` (`read` = text layer / header aliases, `ocr` = vision model, `derived`, `guessed` = text-model fallback, `edited`), `confidence`, `status`, `state`, `flag`, `ai_value`; `GET /api/v1/documents/{id}/pages/{n}.png?w=1400`; `PATCH /api/v1/boreholes/{uid}/values` with `approve` / `edit` / `flag` / `set_state` / `reset`; `POST …/approve-clean?dry_run=` | the overlay is kept per document under a lock, so *Approve all clean* can fire many PATCHes at once; `uid` may contain `/` (route is `{uid:path}`) |
| Detail | `stratigraphy[] {depth_from_m, depth_to_m, din4023_code, english_lithology, original_description, uscs_group, spt_*, rqd_pct, core_recovery_pct, core}`, `groundwater[] {type, depth_m}`, `rock_head_m`, `lint[]` | `din4023_code` is the DIN 4023 short form bh3 derived (`"S, u"`, `"Kst"`) — exactly what `assets/din4023_patterns` draws; also `din_source` says where the code came from, `din_pattern` / `din_color` the DIN names |
| CRS dialog | `GET /api/v1/documents/{id}/crs-candidates`, `POST /api/v1/documents/{id}/crs` | candidates: the printed system, the one recorded for the document, then common systems and (for UTM-sized numbers with no system named) the UTM zones, each with the points it places; confirming sets `crs_status: confirmed` on the whole document |

Also served: `GET /api/v1/boreholes/{uid}` (exact match), `GET /api/v1/documents/{id}/boreholes`, `GET /api/v1/stats`,
`/api/health` with `mode`. Every route is mounted under `/api/v1` and `/api`. Errors carry `detail`.

Not in the contract and not needed by the UI: document-level export (the UI exports in the browser).
Known limits: boxes are row boxes (the full row width), not word boxes; a reviewer's edits live in the
store's overlay, the bh3 result file is never changed; the store is JSON on disk (`backend/api_data/`,
gitignored) — fine for a demo, not a database.

Measured on 17 Oct with the challenge corpus imported (18 documents, 382 boreholes, 148 with pins):
`GET /api/v1/boreholes` 2.8 s / 6 MB, a page image at `w=1400` 1.7 MB, PATCH round trip persisted across a restart.

---

## 1. Run backend + frontend together

### Backend (branch `arav/dev`)

There is no `requirements.txt` yet. These are the imports the API needs to start:

```bash
# from the folder that contains backend/ (a checkout of arav/dev)
cp .env.example .env    # put MISTRAL_API_KEY=... in .env. Never commit .env.
uv run --no-project \
  --with fastapi --with uvicorn --with pydantic --with python-multipart --with openpyxl \
  --with python-dotenv --with 'mistralai>=1.2,<2' --with pillow --with httpx \
  -- python -I -m uvicorn backend.api.main:app --app-dir . --port 8000
curl http://127.0.0.1:8000/api/health        # → {"status":"healthy",...}
```

- **Pin `mistralai` below 2.** The current versions (2.10, 3.2) have no `from mistralai import Mistral`, so the import fails. 1.12.4 works.
- **Without `MISTRAL_API_KEY` it does not start.** `routes/extract.py` builds `UniversalBoreholePipeline()` at import time, and the constructor raises `ValueError: MISTRAL_API_KEY is not configured in .env`. This is backend fix #1 (§3).
- Real extraction also imports `fitz` (PyMuPDF), `docx` (python-docx), `pandas` and `tabulate`. They load lazily, so startup doesn't need them. Add them to the requirements file.
- Port 8000 may be taken on your machine. Use any port and tell the frontend (below).
- Data lives in `backend/cache/universal_*.json` (gitignored). An empty cache gives an empty map, not an error.

### Frontend (branch `prada/frontend`)

```bash
cd frontend
npm install
npm run dev                                          # API mode, http://localhost:5173, proxies /api → http://127.0.0.1:8000
VITE_API_PROXY=http://127.0.0.1:8765 npm run dev     # backend on another port
```

- `VITE_API_PROXY` can also go in `frontend/.env.local`. `npm run preview` (after `npm run build`) uses the same proxy.
- `npm run dev:sample` is the demo mode with fictional data. It never talks to the backend.
- The UI calls `/api/v1/...` (`VITE_API_BASE`, default `/api/v1`). It holds no API keys.

### CORS

- In dev you don't need CORS. The browser talks only to Vite, and Vite forwards `/api` to the backend.
- A build served from another origin needs an absolute base at build time, e.g. `VITE_API_BASE=http://<host>:8000/api/v1 npm run build`.
- The backend's CORS is open (`allow_origins=["*"]`). A `PATCH` preflight from another origin passed on 17 Oct.

---

## 2. What the UI calls vs what `arav/dev` serves

From `frontend/src/data/apiSource.ts`. All paths are under `/api/v1`. Results come from the run on 17 Oct.

✅ works · 🟡 exists, shape mismatch · ❌ missing (404)

| When | Call | UI expects | `arav/dev` today |
|---|---|---|---|
| App start | `GET /boreholes` | `{count, boreholes: BoreholeRecord[]}` | 🟡 Route works. Records lack `uid`, `document_id`, `provenance`, `lint`, `groundwater[]`, `crs_status`, `plotted`, `spt_raw/refusal` |
| App start (same time) | `GET /documents` | `Document[]` or `{documents: [...]}` | ❌ 404. The frontend tolerates it: the map loads, and the queue is empty with a notice |
| Upload | `POST /documents` (multipart `file`) | `202 {document_id, status}` | ❌ Only `POST /extract/upload` exists, and it blocks until extraction ends |
| Upload, every 2 s until `needs_review` / `done` / `failed` | `GET /documents/{id}` | Document (contract §5.2) | ❌ |
| Review scan, Source panel | `GET /documents/{id}/pages/{n}.png?w=1400` | PNG | ❌ No page rendering at all |
| Approve / edit / flag / not in source / illegible | `PATCH /boreholes/{uid}/values` | `{path, action, value \| reason \| state}`, one action per request | ❌ |
| CHOOSE CRS… | `GET /documents/{id}/crs-candidates` | `[{crs, label, points: [{uid, lat, lon}]}]` | ❌ |
| CONFIRM FOR WHOLE DOCUMENT | `POST /documents/{id}/crs` | body `{crs, confirmed_by, note}` | ❌ |

**The UI does not call these**, so they are optional for the demo:

- `GET /boreholes/{id}`: the detail screen uses the list.
- `/export/*`: all three exports are built in the browser from reviewed data. Contract §4.10 (document export) isn't needed for the UI.
- `POST …/approve-clean`: the UI sends one `PATCH` per value instead.
- `/api/health`, `/stats`, `/dataset/files`, `/extract/*`.

The UI understands `409 {"detail": "demo_mode"}` on upload and shows *Live extraction needs an API key*.

---

## 3. Backend changes, in priority order

This is contract §1 (branch `prada/design`, PR #1), re-ordered by what unblocks the UI first. Items marked *new* came up in the run on 17 Oct.

1. **Start without a key** *(new)*. Build the pipeline lazily, on the first upload. Without a key, answer the upload with `409 {"detail": "demo_mode"}`. Add a `requirements.txt` with `mistralai>=1.2,<2`. Without this, a fresh clone (and the AI judge) can't start the API or run its tests.
   ```python
   _pipeline = None
   def get_pipeline() -> UniversalBoreholePipeline:
       global _pipeline
       if _pipeline is None:
           _pipeline = UniversalBoreholePipeline()   # raises without MISTRAL_API_KEY
       return _pipeline
   ```
2. **`GET /api/v1/documents`** *(new: the smallest unblocker)*. One cache file = one document. `document_id` = the file stem without `universal_` (no `/` in it). `file_name` = `document_info.file_name`. `status: "needs_review"`. Everything else can be `null` for now. This alone fills the queue and gives Review its documents.
3. **`uid` + `document_id` on every record** (contract §4.3). Set them in `get_all_records()`, e.g. `uid = f"{document_id}:{borehole_id}"`. **Declare them in `BoreholeRecord`.** See pitfall 3: undeclared keys are dropped from responses.
4. **No made-up defaults** (contract §4.5). Unknown is `null`. See pitfall 4 for the full list, including two that are set in `_normalize_borehole_json`, not in `schemas.py`.
5. **Provenance per value + page images** (contract §4.1, §4.2). Use the exact paths in §4 below. Render pages with PyMuPDF (`fitz` is already imported). Without these, Review and *Show source* stay empty.
6. **Async upload + status** (contract §4.4). `POST /documents` → `202 {document_id, status: "queued"}`; `GET /documents/{id}` for the poll. Save the file under a generated name, not `file.filename`.
7. **`PATCH /boreholes/{uid}/values`** (contract §4.6), plus *new*:
   - an action that sets a value back to unreviewed, e.g. `{"action": "reset"}`. The UI needs it for un-approve, un-flag and clearing a state.
   - store the flag reason as `provenance[path].flag`. The adapter reads it there.
   - one lock per document file. *Approve all clean* sends many PATCHes at once (pitfall 7).
   - the route must accept a `/` in the uid: `@router.patch("/{uid:path}/values")` (pitfall 8).
8. **SPT, groundwater, CRS status, plotting, lint, completeness** (contract §4.7–4.9).
9. **CRS candidates + confirm** (contract §4.12, stretch).

Not needed by the UI: document export (§4.10), `approve-clean`, `GET /boreholes/{id}`. `mode` in `/api/health` (§4.11) is nice to have: the UI only learns about demo mode from the upload's 409.

---

## 4. What the frontend adapter already tolerates

`frontend/src/data/adapters.ts` maps backend records to the UI. It already copes with today's backend:

- `GET /documents` as a bare list or as `{documents: [...]}`.
- **No `uid`:** uses `"<document_id>:<borehole_id>"`, and `"doc:<borehole_id>"` without a `document_id`. That fallback collides for repeated IDs (pitfall 2).
- **No `provenance`:** values are *Guessed*, with no page and no box (rock head is *Derived*; an SPT falls back to *Read*, a frontend bug to fix). The Review screen then has nothing to show, and *Show source* says *No source document for this borehole*.
- **No `groundwater[]`:** uses `geotechnical_tests.water_table_m` as one rest level.
- **No `crs_status`:** `stated` when `coordinate_system` is set, else `unknown`.
- **No `plotted`:** decided from latitude / longitude. `0, 0` counts as no coordinates.
- **No `rock_head_m`:** the top of the first rock layer, shown as *Derived* with its formula.
- **No `spt_raw` / `spt_refusal`:** the SPT shows as `N = <spt_n_value>`. A refusal can't be shown.
- **No `lint`:** only the client-side SPT increment check runs.
- `borehole_depth_m: null` stays empty. It never becomes the log bottom.
- `box: null` → the whole page with *Box not found: page shown*.
- `method` in any case (`read`, `OCR`, …). Unknown methods count as *Guessed*. Unknown page types count as `unknown`.
- Errors: it reads `detail` (or `error`) from the body.
  - 404 `Not Found` → *Backend endpoint not available: GET /api/v1/…*
  - 409 `demo_mode` → *Live extraction needs an API key*
  - 5xx without detail, or a non-JSON answer → *Cannot reach the Bormisu backend…*
- `review_status` is ignored. The UI derives it from the values.

**Provenance paths the adapter reads.** The backend must use exactly these keys:

| Value | Path |
|---|---|
| Borehole ID, project, start date, final depth, elevation, remarks | `metadata.borehole_id`, `metadata.project_name`, `metadata.drilling_date`, `metadata.borehole_depth_m`, `metadata.surface_elevation_mASL`, `metadata.notes` |
| X / Y | `metadata.coordinates.local_x` + `.local_y`, or `.longitude` + `.latitude` when there are no local coordinates |
| CRS | `metadata.coordinates.coordinate_system` |
| Rock head | `rock_head_m` |
| Layer *i* (0-based) | `stratigraphy[i].depth_to_m`, `.english_lithology`, `.spt_n_value`, `.core_recovery_pct`, `.rqd_pct` |
| Groundwater reading *i* | `groundwater[i].depth_m` (or `geotechnical_tests.water_table_m`) |

A layer has no value of its own for `depth_from_m`: its top is the bottom of the layer above. Lint on `depth_from_m` lands on that bottom.

---

## 5. Step-by-step plan with smoke tests

Do the steps in order. After each one, run its checks in the browser with `npm run dev` against your backend. Use only fictional test files and fixtures: no challenge data in the repo.

| Step | Backend change (§3) | Smoke test |
|---|---|---|
| 0 | none | The map shows the backend's records; UPLOAD & QUEUE is empty with *The backend has no document list yet (GET /api/v1/documents).* With the backend stopped: *NO DATA FROM THE BACKEND* and *Cannot reach the Bormisu backend at /api/v1…* with RETRY. |
| 1 | #1 start without key | `curl /api/health` is 200 with no `.env`. The backend tests import. |
| 2 | #2 + #3 documents list, `uid`, `document_id` | Map: pins, legend counts, *Not on map*, RESULTS. Search an ID: it flies to the pin. Two reports with the same borehole ID: two rows, and each opens its own detail. No *two children with the same key* in the console. |
| 3 | #4 no defaults | Detail: an unknown CRS isn't *WGS84 · STATED*. A layer without a DIN code isn't *Sand*. An unknown final depth shows *not in source*. |
| 4 | #6 async upload | Queue: drop a PDF. The card appears at once, then goes *classifying → extracting → needs review*. Counts and the page strip fill in. *OPEN REVIEW ›* works. A failed extraction shows its error on the card. |
| 5 | #5 provenance + pages | Review: the page image shows with boxes on the values. Raw → normalised. Method badges are not all *Guessed*. Detail: *Show source* opens the page with the box. |
| 6 | #7 PATCH | Review: approve, edit (the AI value stays, struck through), flag, *Not in source*, *Illegible*. Reload: everything is still there. *APPROVE ALL CLEAN (n)*: after a reload all n are approved. |
| 7 | #8 SPT, GW, lint, completeness | Detail: an R marker for `50/30`, one triangle per groundwater reading. Queue: the completeness chip and panel list the missing IDs. Lint shows on the right review row. |
| 8 | #9 CRS | Review → CRS row → *CHOOSE CRS…*: candidates on the mini map. Confirm: pins stop being amber. |
| 9 | none | Detail → EXPORT: the xlsx opens in Excel. Approved only by default; *Include unreviewed* stamps it DRAFT. |

### Checklist per screen (run before the demo)

- **Shell:** no *DEMO* banner in API mode. No console errors on load.
- **Map:** World and one country (`?focus=DE`). Legend + *Not on map* add up to all boreholes. A RESULTS row and a pin popup open the detail. Search for an ID, and for an ID that has no coordinates.
- **Upload & queue:** a PDF upload walks through the steps. A `.txt` is refused in the browser. With the backend in demo mode: *Live extraction needs an API key*.
- **Review:** page image, boxes, keyboard J / K / A / E / F. Approve all clean. CRS dialog. A failed save rolls back and shows *Not saved: …*.
- **Detail:** profile, R marker → Source panel, metadata chips, layers, groundwater, mini map.
- **Export:** xlsx, tidy CSV, open questions. A blank cell never means 0.

---

## 6. Known pitfalls

1. **Substring ID match.** `GET /boreholes/{id}` and `/export/{id}/*` return the first record whose ID *contains* the text (`borehole_id.lower() in bid.lower()`), so `BH-1` can return `BH-10`. With two fictional reports that both had an FX-1, `GET /boreholes/FX-1` always returned the one from the file listed first: the other FX-1 can't be reached. The UI doesn't call these routes. If you wire them, use `uid` and an exact match.
2. **Repeated borehole IDs collide in the UI** while the backend sends no `uid` / `document_id`. Both FX-1 got the uid `doc:FX-1`. React logged *Encountered two children with the same key*, and the second RESULTS row opened the first borehole's detail. Fixed by backend step #3. A frontend fallback fix is also planned.
3. **New fields vanish.** `BoreholeRecord` uses `extra="ignore"`, and the routes use `response_model`. Keys that are in the cache JSON but not in the Pydantic model are dropped from every response. We put `uid`, `document_id`, `provenance`, `lint`, `groundwater` and `crs_status` into a cache file: none of them reached the API. Declare every new field in `schemas.py`.
4. **Made-up defaults** turn "unknown" into confident values:
   - `din4023_code = "Sand"`. A weathered sandstone layer without a code came back as *Sand*.
   - `uscs_group = "SP"`, `confidence_score = 0.90`, and the TBM risk defaults (`"Moderate"`, `"Stable"`, `"Dry / Minor"`, EPB).
   - `coordinate_system = "WGS84"`. Every borehole showed *CRS WGS84 · STATED*, even one without coordinates.
   - In `_normalize_borehole_json`: `borehole_depth_m` = deepest layer bottom, and `borehole_id = "BH-01"` when missing.
5. **Blocking upload.** `POST /extract/upload` runs OCR and the LLM inside the request. A long PDF takes minutes: the browser or proxy may time out, and there is no queue. It also writes to `uploads/<file.filename>`, so a crafted name can escape the folder. If you only remove the key check, a key-less upload answers `500 File upload extraction failed: 'NoneType' object has no attribute 'chat'`. Answer `409 {"detail": "demo_mode"}` instead.
6. **No page images, no provenance → no Review.** Today the Review screen says *NOTHING TO REVIEW*, and every *Show source* says *No source document for this borehole*. If provenance lands before page images, the scan pane shows a broken image. A frontend placeholder is planned.
7. **Parallel saves.** *Approve all clean* sends one `PATCH` per value, all at once. A read-modify-write of the same JSON file loses updates unless the backend locks per document.
8. **A `/` in a uid breaks routing.** German IDs like `KB 3/1` exist. The UI encodes it (`KB%203%2F1`), but uvicorn decodes `%2F` before routing, so `/boreholes/{uid}/values` answers 404 *Not Found*. The UI then says *Backend endpoint not available*, which is misleading. Use `{uid:path}` in the route, or IDs without `/`.
9. **Undo isn't in the contract.** Un-approve, un-flag and clearing *Not in source* / *Illegible* need a "back to unreviewed" action. Until it exists, the UI refuses them in API mode with a toast.
10. **Tests need the gitignored cache.** `backend/tests/test_api_and_schemas.py` expects ≥ 10 boreholes, "Spain" or "Norway" in the countries, and a PDF in the dataset folder. On a fresh clone they all fail, and they can't even import without a key. Commit a small **fictional** fixture, point `CACHE_DIR` at it in the tests (monkeypatch), and make the pipeline lazy (#1).
11. **Personal default path.** `DATASET_PATH` defaults to a personal Windows folder in `.env.example`, `analytics.py` and both pipelines. Use a relative default, or none.
12. **Slow polling.** The UI polls `GET /documents/{id}` every 2 s per document, and reloads `GET /boreholes` when a document reaches *needs review*. `get_all_records()` re-reads and re-validates every cache file on every request. Fine for a few reports. Cache it if it gets slow.

---

## 7. What the run on 17 Oct showed

Setup: `arav/dev` 49c84dd with the pipeline constructor stubbed out (no key, no files changed), on port 8765. The frontend in API mode on port 5195 with `VITE_API_PROXY`. System Chrome via Playwright. The test records were **fictional** and deleted afterwards.

- **Without any key:** the backend doesn't start (pitfall 5 and step #1).
- **Unchanged UI:** *NO DATA · Backend endpoint not available: GET /api/v1/documents*. (Fixed in the frontend since: a missing document list now leaves the map working, see step 0 in §5.)
- **With only `GET /documents` answered as `[]`:**
  - Map, legend, *Not on map*, RESULTS, search and the detail screen worked with the backend's records. All values were *Guessed*.
  - The tidy CSV export worked (approved only, so empty).
  - Review said *NOTHING TO REVIEW*.
  - Upload said *Backend endpoint not available: POST /api/v1/documents*.
- **With contract-shaped answers for the three read endpoints:**
  - The queue card, completeness chip, Review list (raw → normalised, method badges, lint, SPT) and APPROVE ALL CLEAN rendered. One catch: an SPT without a provenance entry counted as *Read*, so it was in the clean count.
  - The real backend's 404s then showed as clear messages: approve rolled back with *Not saved: Backend endpoint not available: PATCH …*, and CRS showed a toast.
  - The page image was a broken image.
- **Backend stopped:** *Cannot reach the Bormisu backend at /api/v1…* with RETRY.
