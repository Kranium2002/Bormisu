# Coordination log

Each session updates only its own section, at the end of every milestone, and merges this file to `integration` with its work. Newest entries on top inside each section.

## Backend status

- 2026-10-17 08:20 · **The user said: no more testing with Mistral.** Please do no live uploads and no eval runs against the keys (this includes the planned "one small real upload" in final acceptance) unless the user asks for it again. Use demo mode, `make seed` and the test suites; providers are mocked in tests.

- 2026-10-17 08:15 · **Merge into `integration`: waiting for the user.** The backend session's merge into `integration` (README section 3 item 4) was denied by its safety classifier, so `integration` still has no backend. A rehearsal in a scratch clone merged `feat/backend` into today's `integration` with no conflicts. That clone was then built with no `.env`: db, migrate, api, worker, gotenberg and web all came up healthy, `/api/health` reported `demo`, `make seed` showed 9 pins through the web proxy, and upload answered 409 `demo_mode`. The user (or a session they allow) can run `git -C D:/Bormisu merge --no-ff feat/backend -m "merge: feat/backend M3"`, and the backend session will then merge `integration` back.
- **Provider budget:** the backend worktree `.env` now has `PROVIDER_BUDGET_USD=1.5` and `EVAL_MAX_USD=1`. Recorded spend is 0.263 USD (Mistral 0.016, OpenRouter 0.247), plus about 0.024 USD of diagnostic calls outside the ledger. The cap sums the `provider_calls` table; deleting documents or `make unseed` does not reset it, but wiping the database volume (`docker compose down -v`) does. With 1.5 the total stays under 2 USD even after one reset. The full sample eval will not run without the user's go-ahead.
- **Live path with keys:** upload → classify → OCR → extraction → review → `/api/v1/map/boreholes.geojson` was verified on a sample excerpt. Each run of the extractor model has reasoning turned off (`LLM_REASONING=off`); with it on, the model spends its whole answer budget thinking.

- 2026-10-17 07:30 · **M2 and M3 backend features done on `feat/backend`** (1,068 tests). **For the frontend:**
  - **Chat** (`POST /api/v1/chat`) streams the UI message stream v1 exactly as in `contracts/realtime-and-chat.md`, with 8 tools and data parts `data-result-set`, `data-citation`, `data-scope` and transient `data-ui-command`. It returns 409 `chat_unavailable` without an OpenAI key, and `/api/health` `providers.chat` says which. When a tool fails, its `tool-output-available` carries `output.error = {code, message}`; please show that as a failed tool step.
  - **New question kinds from the pipeline:** `choose_reading` (one field per disputed value; the field `name` is the value path when there are several, `reading` when there is one), `duplicate` (options `same_boreholes` / `keep_both`), `datum_convention`, `locate_borehole` (map_point) and `unit_ambiguous`. A changed question is re-sent as `clarification.created` with the same id; replace it in the inbox.
  - **New lint rules:** `coordinates_far_from_cluster` (the borehole is unplotted with reason `implausible`), `coordinates_shared`, `duplicate_borehole`, `coordinates_zero`.
  - **Spreadsheet documents** have `page_count: null` and no pages; their provenance has `cell` with `page` and `box` null.
  - **Evidence boxes** are word-level on pages with a text layer and block-level on scans.

- 2026-10-17 06:00 · **M1 done on `feat/backend`** (ahead of 14:00). The real pipeline runs end to end, on fake providers in tests and once live on a sample vector log excerpt: upload → triage → classify (cheap model) → OCR only on borehole pages (Mistral, blocks with boxes and confidence) → extraction (raw text plus block ids) → Python normalisation (DIN, SPT, units, CRS) → records with provenance → review → map.
  - The live check placed two boreholes from a stated "55H MGA94" system at the right place. Classification and OCR of 4 pages took about 20 s, extraction about 1 min.
  - Reruns and retries never repeat a paid call (cached runs). A crash resumes at the next borehole.
  - Every provider call is in a cost ledger, and `PROVIDER_BUDGET_USD` stops processing before the cap.
  - **For the frontend:** `document.progress` moves through classifying (`pages_classified`), extracting (`pages_ocr_done`, `boreholes_extracted`) and needs_review. Failed documents carry a readable `error` and a `job.failed` event with `retryable`.
  - **Known limit:** on some layouts Mistral returns one block for a whole log table, so evidence boxes can be coarse. Tightening boxes from the PDF text layer is in progress for M2.
  - **Please don't upload real files against the backend session's API (port 8000)** unless you mean to: the stack is in live mode with the user's keys, capped by a budget.

- 2026-10-17 04:00 · M0 part 2 · **Done on `feat/backend`:** compose stack (db, migrate, api, worker, gotenberg, web, test), every contract endpoint except the chat tool loop (`POST /chat` returns 409 `chat_unavailable` until M3), `make seed` / `make unseed` with 8 fictional documents and 15 boreholes, pipeline triage. 300+ tests pass. **For the frontend** (from a compatibility check that ran your data layer against this API):
  1. `contract.test.ts` maps example files with `split('.')[0].toLowerCase()`, so 29 of the examples (every `BoreholeRecord.*`, `BoreholeList.*` …) are skipped. The schema name is the case-preserved prefix (`contracts/examples/README.md`). Please also run `adaptBorehole` and `adaptDocument` over every example.
  2. Boot calls `GET /boreholes?limit=5000` (about 15 KB per record with provenance). Please drive the map from `GET /map/boreholes.geojson` (plus `?plotted=false` for the "Not on map" list) and fetch full records per document or uid on demand.
  3. A duplicate upload answers 200 with `document_id == duplicate_of` (the existing document). Show "already uploaded"; it is not a self-link.
  4. `open_clarifications` and the map `attention` count unresolved questions (open **or skipped**). A skipped question can still be answered (200); 409 means it was already answered.
  5. Every non-null value now has a provenance entry. `english_lithology` carries method `guessed` with the box of `original_description`.
  6. SSE ids are commit-ordered (`events.seq`). Reconnecting with `Last-Event-ID` never skips a late commit.
- 2026-10-17 05:00 · **Contract 1.1.0** (additive, see `contracts/CHANGELOG.md`):
  - `Coordinates.crs_label`: the readable name of the coordinate system; use it wherever a system is shown.
  - `ValuePatch.confirmed_by` and `POST /documents/{id}/approve-clean?confirmed_by=`: stored as the revision actor, so "Stored with your name" holds for review actions.
  - `GET /clarifications/{id}/crs-candidates`: ranked candidates for every borehole a `crs_confirm` question covers, across documents. The CRS dialog inside a clarification uses it.
  - CRS candidates are now ranked against the geocoded place of the boreholes (location name, then project, then country). When no reference place is found, the note says so and ties are ordered by area-of-use size.
  - The examples gained about 190 provenance entries, because every value now has one. Adapter tests that count review items in the examples need updating.
- **Seed changed:** the page images and values are new (location and country printed, axis labels as printed). Reload with `make unseed && make seed`.

- 2026-10-17 03:00 · M0 part 1 · **Done:** `contracts/examples/` (78 fictional payloads: every main schema, all 9 clarification kinds, all 21 error codes, 7 event payloads, `chat/turn.sse` and `chat/error.sse`), validated by `backend/tests/contract/` (205 tests). Naming rule: `<SchemaName>.<variant>.json` validates against `#/components/schemas/<SchemaName>`; a top-level array validates per item; see `contracts/examples/README.md`. Interpretations: a duplicate upload returns the existing document's id in both `document_id` and `duplicate_of`; `Provenance.document_id` is always filled; unclassified pages are `{type: "unknown", used: false, ocr: "pending"}` without `role`. **Next:** compose stack, `make seed`, all P0/P1 endpoints (in progress on `feat/backend`).

## Frontend status

- 2026-10-17 06:55 · M1 · **Done** (F4, F6, F7):
  - **Router:** react-router 8 in data mode. `/map?at=&sel=&rs=`, `/queue`, `/review/:uid?key=`, `/boreholes/:uid?layer=` and a not-found page. Deep links, reload and the Back button restore the screen and its selection; the URL is the single navigation truth.
  - **Uploads:** `XMLHttpRequest` with byte progress, two at a time, each cancellable or retryable. Files dropped together share one `project`: typed, else the dropped folder's name. A duplicate answer says "Already uploaded" and jumps to the existing card.
  - **Live updates:** `EventSource` on `/api/v1/events` with the fallback of `realtime-and-chat.md` (three stream errors in a minute → polling the followed documents, 2 s backing off to 30 s, back to the stream when it opens). Every event type is applied idempotently; refetches respect pending review saves. The queue shows the live status, and page thumbnails use `?w=200`.
  - **F7:** a document that reaches review through events is reviewable without a reload.
- **Tests (real results on `feat/frontend`):**
  - `tsc -b` clean.
  - Vitest 902 passed / 1 skipped, with the `contracts/examples` of `feat/backend`.
  - Playwright sample mode 47/47.
  - Playwright API mode against `feat/backend` 9f84623 (contract 1.1.0, M1) plus this frontend in compose, after `python -m app.seed`: 56 tests, 55 pass, 1 skipped (seed-dependent). One expected failure remains marked `knownBug`: BE-CRS-1, a backend issue. The live-upload test drives the stream with a recorded fictional event sequence, because demo mode refuses uploads.
- **Next (M2):**
  - world map from `GET /map/boreholes.geojson` with clustering, records loaded per document on demand (the backend's boot-size request) (F9);
  - area selection and filters (F10), place search (F11), clarifications inbox and dialog (F12), CRS dialog on real candidates incl. `GET /clarifications/{id}/crs-candidates` (F13);
  - contract 1.1.0 adoption once it is on `integration`.
- **Blockers:** none.

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
- 2026-10-17 · frontend · `POST /documents/{id}/crs` closes the open `crs_confirm` clarification of the boreholes it confirms (BE-CRS-1) · after a confirmation the boreholes stay "Needs attention" (`open_clarifications` 1) and the card keeps "1 open question" · open (still reproduces on `feat/backend` 9f84623)
- 2026-10-17 · frontend · `POST /documents/{id}/crs` writes a provenance entry for `metadata.coordinates.crs_code` (method `edited`), as `BoreholeRecord.approved.json` shows · without it the confirmed CRS has no review row; the frontend falls back to the EPSG code in Detail and in the export · superseded by 1.1.0: `crs_code` is server-computed without provenance; the frontend shows `crs_label` (adoption at the next integration merge)
- 2026-10-17 · frontend · Additive: a human-readable label of the confirmed CRS on the record (e.g. `coordinates.crs_label`, the candidate's `label`) · `coordinate_system` is "as printed" and stays null, so after a confirmation the UI can only show "EPSG:2193" where the dialog showed "NZGD2000 / New Zealand Transverse Mercator" · done in 1.1.0 (`coordinates.crs_label`)
- 2026-10-17 · frontend · `POST /documents/{id}/retry` answers 409 `demo_mode` in demo mode, like upload (BE-RETRY-1) · today it re-queues, the worker clears the page classification and the document stays in `classifying` for good; the frontend disables RETRY in demo mode meanwhile · open (9f84623 still answers 202 in demo mode)
- 2026-10-17 · frontend · Define what a CRS candidate `verdict` means and check the points, not only the area of use (BE-CRS-2) · for New Zealand coordinates EPSG:3857 (and its swapped twin) score `match` 1.0, tied with NZTM, so the dialog says "pins on site" for points in Europe; the `crs_confirm` clarification also offers a different list than `/crs-candidates` · partly done in 1.1.0 (ranking against a geocoded reference place); the meaning of `match` / `shifted` / `out_of_range` is still undefined
- 2026-10-17 · frontend · Additive: `Document.failed_stage` (the `job.failed` event has `stage`, the Document does not) · the card should mark the step that failed; the frontend infers it from `progress` meanwhile (all pages classified → extraction failed) · open
- 2026-10-17 · frontend · Define how an SPT refusal is corrected (for example an edit of `stratigraphy[i].spt_raw` that the backend re-parses into `spt_refusal`, increments and `spt_n_value: null`) · an edit of `spt_n_value` with "50/12" answers 422; the frontend sends whole numbers to `spt_n_value`, refusal text to `spt_raw` when that is a provenance key, and refuses it otherwise · open
- 2026-10-17 · frontend · Additive: accept the last event id as a query parameter on `GET /events` (e.g. `?last_event_id=`) · an `EventSource` recreated after the browser gave up cannot send the `Last-Event-ID` header, so `borehole.*`, `clarification.*` and `job.failed` events of that gap are lost; the frontend refetches the documents it follows meanwhile · open
- 2026-10-17 · frontend · Additive: `document_id` and `borehole_uids` on the `clarification.resolved` event · the frontend can then refresh only the affected counts instead of every document and borehole with open questions · open
- 2026-10-17 · frontend · Additive: `crs_label` (and `crs_code`) in the properties of `GET /map/boreholes.geojson` features · since M2 the map, popups and the RESULTS table read the light map layer instead of every record (your boot-size request); without the label they can only show the CRS status ("confirmed") until the record is loaded · open
- 2026-10-17 · frontend · Please merge `feat/backend` (M0, M1, contract 1.1.0) into `integration` · the frontend adopts `crs_label` and `confirmed_by` only from the contract on `integration`, and the M1 integration check needs both sides there · done: merged by the frontend session on the user's go-ahead (ad53ef9)
- 2026-10-17 · frontend · **Login and logout (the user's request; the backend builds it in parallel).** Proposed additive contract 1.2.0, the backend owns the final shape:
  - Server-side session in an HttpOnly cookie (SameSite=Lax, Path=/, Secure only behind HTTPS), idle expiry about 12 h; no tokens in JavaScript.
  - `GET /api/v1/auth/me` → 200 `{user}` | 401 `not_authenticated`. `POST /api/v1/auth/login` `{username, password}` → 200 `{user}` plus the cookie | 401 `invalid_credentials` (same answer for an unknown user and a wrong password) | 429 `rate_limited` | 422 `validation_error`. `POST /api/v1/auth/logout` → 204, idempotent.
  - `User = {username, display_name, role: viewer | reviewer | admin}`.
  - Health stays public and gains `auth: {enabled}`. Disabled (no users configured): everything works as today, so a fresh clone without `.env` still runs. Enabled: every route except health and login answers 401 without a session; writes (upload, PATCH values, approve-clean, CRS, answer/skip, retry, delete) need reviewer or admin, else 403 `forbidden`; reads and chat are open to viewers. `/events` and `/chat` use the same cookie.
  - The actor of revisions, CRS confirmations and answers comes from the session user; `confirmed_by` / `answered_by` are then ignored.
  - CSRF: an Origin check, or double-submit (`csrf_token` cookie echoed as `X-CSRF-Token`; the frontend sends it whenever the cookie exists).
  - Users from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` plus a CLI; hashed passwords. Examples `User.*.json` and the login/me answers; CHANGELOG entry.
  - Why: real identities for the review audit trail instead of a typed name · open
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
