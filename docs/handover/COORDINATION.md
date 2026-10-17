# Coordination log

Each session updates only its own section, at the end of every milestone, and merges this file to `integration` with its work. Newest entries on top inside each section.

## Backend status

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

- (empty)

## Contract requests (frontend → backend)

Format: `YYYY-MM-DD · requester · what is needed · why · status (open / accepted / done in 1.x.y / rejected + reason)`

- (empty)

## Decisions taken during the build

Format: `YYYY-MM-DD · session · decision · reason`

Decisions taken in the handover (2026-10-17):
- 2026-10-17 · handover · Mistral OCR is called directly with `MISTRAL_API_KEY`; the page classifier and the extractor run on OpenRouter; OpenAI is used for chat only · direct OCR returns block boxes, confidence and page selection, and OpenRouter's OCR plugin does not
- 2026-10-17 · handover · Keep Prada's React, Vite, Leaflet and CSS-modules app; no Next.js, MapLibre or shadcn · working, tested code and a fixed deadline
- 2026-10-17 · handover · Exports stay client-side in v1; `approve-clean` is server-side · one tested export implementation; atomic bulk approval
- 2026-10-17 · handover · The database starts empty; `make seed` loads fictional data on request only · the map shows uploaded data only
- 2026-10-17 · handover · Contract 1.0.0 refined after the branch audit: error `code`, PATCH path grammar, `review_status` `in_review`, health `upload` limits, map `attention` · see `contracts/CHANGELOG.md`
