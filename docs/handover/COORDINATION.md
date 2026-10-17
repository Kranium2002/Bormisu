# Coordination log

Each session updates only its own section, at the end of every milestone, and merges this file to `integration` with its work. Newest entries on top inside each section.

## Backend status

- (empty)

## Frontend status

- 2026-10-17 05:30 · M0 · **Done** (F1, F2, F3, F8, parts of F5):
  - **Docker:** `frontend/Dockerfile` (repo root as context, API mode only, `check:dist` proves no sample data in the image), `nginx.conf` (SPA fallback, cache headers, gzip, `/api/` proxy resolved per request, unbuffered `/api/v1/events` and `/api/v1/chat`, JSON 413 `too_large`), `.github/workflows/frontend.yml`. The compose service `web` on `feat/backend` builds and serves it unchanged.
  - **Contract alignment (FRONTEND.md section 4, items 1–15):** wire types generated from `contracts/openapi.yaml` (`npm run gen:api`); typed errors by `code`; health at boot (demo banner, upload and retry disabled with the reason, drop zone from `upload`); server `review_status`; PATCH with `if_revision`, saves serialised per borehole, the answer applied, `reset` for undo, conflict refetch; server `approve-clean` with its dry-run count; CRS dialog with `verdict`/`note`/`score`/`swap_axes` and a refetch after confirming; DIN 4023 profile from `assets/din4023_patterns`; SPT without a stated depth says so; every new field in Detail and in the exports; page strip from `pages[]`; optional reviewer name sent as `confirmed_by`.
  - **Store split** into slices (F3).
  - Empty map overlay, Not on map texts, world start view.
- **Tests (real results on `feat/frontend` 65e41ce):**
  - `tsc -b` clean.
  - Vitest 721 passed / 1 skipped (the chat stream, M3), including all `contracts/examples` from `feat/backend` 9e937c3 (contract 1.1.0) through the adapters and the API source.
  - Playwright sample mode 33/33.
  - Playwright API mode (`frontend/e2e/api`, `E2E_BASE_URL=http://localhost:8081 npm run e2e -- --project=api`) against `feat/backend` 477336f with `python -m app.seed`: 49 tests, 45 pass and 4 are expected failures marked `knownBug`: BE-CRS-1 and BE-PROV-1 are backend, M1-ROUTER and M1-SSE are not built yet.
  - `docker build` ok; nginx streaming, 413 and SPA fallback checked with curl.
- **Next (M1):**
  - adopt contract 1.1.0: `crs_label`, `ValuePatch.confirmed_by`, `confirmed_by` on approve-clean;
  - router and URL state (F4);
  - SSE events with polling fallback, upload queue with XHR progress, two at a time and a shared project label (F6);
  - review polish on uploaded documents (F7).
- **Blockers:** none. Backend requests are listed below.
- **Root README input:** `frontend/README.md` has the frontend's Quick start, Configuration (`VITE_APP_NAME`, `VITE_TILE_URL`, `VITE_TILE_ATTRIBUTION`), Docker, scripts and both Playwright projects; screens and keyboard shortcuts follow at M2.

## Contract requests (frontend → backend)

Format: `YYYY-MM-DD · requester · what is needed · why · status (open / accepted / done in 1.x.y / rejected + reason)`

Found by running the frontend's API-mode e2e suite (`frontend/e2e/api/`) against `feat/backend` 477336f with the fictional seed; ids refer to that suite's `knownBug(...)` markers. Some may already be fixed by 2344dce.
- 2026-10-17 · frontend · `POST /documents/{id}/crs` closes the open `crs_confirm` clarification of the boreholes it confirms (BE-CRS-1) · after a confirmation the boreholes stay "Needs attention" (`open_clarifications` 1) and the card keeps "1 open question" · open
- 2026-10-17 · frontend · `POST /documents/{id}/crs` writes a provenance entry for `metadata.coordinates.crs_code` (method `edited`), as `BoreholeRecord.approved.json` shows · without it the confirmed CRS has no review row; the frontend falls back to the EPSG code in Detail and in the export · open
- 2026-10-17 · frontend · Additive: a human-readable label of the confirmed CRS on the record (e.g. `coordinates.crs_label`, the candidate's `label`) · `coordinate_system` is "as printed" and stays null, so after a confirmation the UI can only show "EPSG:2193" where the dialog showed "NZGD2000 / New Zealand Transverse Mercator" · open
- 2026-10-17 · frontend · `POST /documents/{id}/retry` answers 409 `demo_mode` in demo mode, like upload (BE-RETRY-1) · today it re-queues, the worker clears the page classification and the document stays in `classifying` for good; the frontend disables RETRY in demo mode meanwhile · open
- 2026-10-17 · frontend · Define what a CRS candidate `verdict` means and check the points, not only the area of use (BE-CRS-2) · for New Zealand coordinates EPSG:3857 (and its swapped twin) score `match` 1.0, tied with NZTM, so the dialog says "pins on site" for points in Europe; the `crs_confirm` clarification also offers a different list than `/crs-candidates` · open
- 2026-10-17 · frontend · Additive: `Document.failed_stage` (the `job.failed` event has `stage`, the Document does not) · the card should mark the step that failed; the frontend infers it from `progress` meanwhile (all pages classified → extraction failed) · open
- 2026-10-17 · frontend · Define how an SPT refusal is corrected (for example an edit of `stratigraphy[i].spt_raw` that the backend re-parses into `spt_refusal`, increments and `spt_n_value: null`) · an edit of `spt_n_value` with "50/12" answers 422; the frontend sends whole numbers to `spt_n_value`, refusal text to `spt_raw` when that is a provenance key, and refuses it otherwise · open
- 2026-10-17 · frontend · Say in the contract that `rock_head_m: null` means "not stated" · the old UI showed "not reached", an interpretation; it now shows "not in source" · open (documentation only)

## Decisions taken during the build

Format: `YYYY-MM-DD · session · decision · reason`

Decisions taken in the handover (2026-10-17):
- 2026-10-17 · handover · Mistral OCR is called directly with `MISTRAL_API_KEY`; the page classifier and the extractor run on OpenRouter; OpenAI is used for chat only · direct OCR returns block boxes, confidence and page selection, and OpenRouter's OCR plugin does not
- 2026-10-17 · handover · Keep Prada's React, Vite, Leaflet and CSS-modules app; no Next.js, MapLibre or shadcn · working, tested code and a fixed deadline
- 2026-10-17 · handover · Exports stay client-side in v1; `approve-clean` is server-side · one tested export implementation; atomic bulk approval
- 2026-10-17 · handover · The database starts empty; `make seed` loads fictional data on request only · the map shows uploaded data only
- 2026-10-17 · handover · Contract 1.0.0 refined after the branch audit: error `code`, PATCH path grammar, `review_status` `in_review`, health `upload` limits, map `attention` · see `contracts/CHANGELOG.md`

Decisions taken during the build:
- 2026-10-17 · frontend · `npm run gen:api` runs `npx openapi-typescript@7.13.0` instead of a devDependency · the generator needs the TypeScript 5 compiler API and the app uses the native TypeScript 7; CI fails when `api-types.gen.ts` is stale
- 2026-10-17 · frontend · Depth units say "bgl" only when `depth_origin` is `ground`; otherwise plain "m", with the origin stated in Detail · a null origin is not stated in the source
- 2026-10-17 · frontend · A value without a provenance entry is shown read-only (no source icon, no review actions) with one console summary per load · the contract allows sparse provenance; every reviewable value needs a PATCH path
- 2026-10-17 · frontend · Lints the client adds on its own (SPT increments) are shown but never count as attention · chips and pins must agree with the server's map layer
- 2026-10-17 · frontend · The web image proxies `/api/` with `client_max_body_size 201m` · the drop zone accepts files up to `upload.max_mb`; multipart framing must not make nginx refuse them before the API decides
