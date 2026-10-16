# Frontend brief (Claude Code session: frontend)

You turn Prada's React app into the GeoMemory web client and ship it in Docker behind nginx. Work in the worktree `D:\Bormisu-frontend` on branch `feat/frontend`. Read [README.md](README.md) first (setup, deadline, coordination, shared rules, acceptance list). Your interface to the backend session is [`contracts/openapi.yaml`](../../contracts/openapi.yaml) and [`contracts/realtime-and-chat.md`](../../contracts/realtime-and-chat.md); build against them, not against backend code.

---

## 1. Mission

At the end, a user opens http://localhost:8080 and can:
1. See an LGRB-style **world map** of every uploaded, located borehole: clustered pins, popups, a results table under the map, a "Not on map" list with reasons, place search for any town, area selection by rectangle, polygon or circle, filters.
2. **Upload** any mix of files, watch live progress per document and page, and retry failures.
3. **Review** every extracted value next to its source page with the box highlighted; approve, edit, flag, mark "not in source" or "illegible", undo; approve all clean values at once.
4. Open a **borehole detail** with a DIN 4023 profile drawn from the real pattern assets, the layer table, groundwater and metadata, every value linked to its source.
5. Answer **clarification questions** (CRS, unreadable handwriting, datum, units, boundaries) in a small form dialog, from an inbox or inline.
6. Ask the **chat assistant** "How many boreholes deeper than 10 m are in Auckland?" and watch the map animate to the answer, with citations that open the source page.
7. **Export** the target-format workbook and CSVs.

## 2. Starting point: `prada/frontend` (audited 2026-10-17)

Verified facts:
- React 19, TypeScript 7 (native `tsc`), Vite 8 (rolldown), zustand 5, Leaflet 1.9.4, exceljs 4.4, vitest 5, Playwright 1.64, CSS modules. About 10k lines.
- With Node 22: `npm ci` ok, **224/224 unit tests** (18 files), `npm run build` ok, **24/24 Playwright tests** in sample mode.
- **Node ≥ 22.12 is required.** On Node 20.9, tests fail (`node:util` has no `styleText`) and the build fails (TypeScript 7's bin). There is no `engines` field. This machine's system Node is 20.9, so run every npm or npx command with the portable Node 22 first on the PATH: `export PATH="/d/Bormisu-tools/node22:$PATH"` (README section 2). Playwright can use the installed Chrome (`channel: 'chrome'`) locally.
- One timing-flaky test: `src/export/standardXlsx.test.ts` can pass 5 s on a cold run.
- `ARCHITECTURE.md` is binding: no sample data outside `src/sample`, the data source is chosen once in `createDataSource.ts`, the target format is defined once in `src/schema/targetFormat.ts`, no challenge data, CSS modules.

Keep (it is good and tested): the `DataSource` interface with api and sample modes; `adapters.ts` as the only place that knows wire field names; the pure domain layer (`src/domain/*`); the provenance-centred Source panel and scan overlays with normalised boxes; optimistic edits with the per-value save queue and `PartialSaveError` rollback; client-side exports with DRAFT stamping and blank-never-zero; profile geometry; Leaflet teardown and `textContent`-only popups; the Playwright fixtures that fail on console errors and stub tiles.

Gaps found by the audit (you fix them; section 4 and 5):
- No Dockerfile, nginx config or production `/api` proxy (only the Vite dev proxy).
- No router: navigation is a zustand field, so no deep links, no Back button, reload loses the selection.
- Map is Germany-centred (`GERMANY_BOUNDS` in `mapModel.ts`, `BoreholeMap.tsx`, `CrsMap.tsx`), one SVG marker per borehole, no clustering, no area selection.
- German-specific heuristics: two `shortCrsName` regexes for Gauss-Krüger, "inferred from 7-digit Rechtswert" text, German stratigraphy colours (`STRAT_COLORS`), fixed page-usage strings in `theme.ts`.
- 9 hand-drawn hatchings chosen by regex with **default `sand`** for anything unknown, ignoring the 49 DIN 4023 assets on `main`.
- SPT depth defaults to the layer midpoint when the source gives none, shown as "SPT @ x m".
- Undo is impossible in API mode (no reset action); PATCH responses are ignored; "Approve all clean" sends hundreds of PATCHes; polling stops forever after one network error; uploads have no progress; `confirmed_by` is the literal "Bormisu reviewer".
- `appStore.ts` is 714 lines holding everything.
- No chat, no clarifications, no live events, no health check, no API-mode tests.
- Many target-format fields are never filled in API mode (BoreholeName, LocationName, EndDate, ProjectID, BoreholeLength, DrillingMethod, StratigraphicName, EngineeringSoilUnit, GeologicAge, Core, samples, Test Results).

## 3. Decisions

| Topic | Decision | Reason |
|---|---|---|
| Framework | Keep React + Vite + TypeScript + zustand + CSS modules. No Next.js, Tailwind or shadcn | Working, tested code and a fixed deadline. The plan's Next.js and MapLibre ideas are superseded by this handover |
| Node | `"engines": { "node": ">=22.12" }`, `.nvmrc` with `22`, Docker `node:22-alpine` | Toolchain requirement found by the audit |
| Routing | `react-router` in library mode with `createBrowserRouter`; nginx falls back to `index.html` | Deep links, Back button, shareable URLs |
| Map | Keep Leaflet 1.9. Add `leaflet.markercluster` and `@geoman-io/leaflet-geoman-free`; render pins on a canvas renderer | LGRB itself uses Leaflet; clustering and draw tools are mature plugins |
| Basemap | Tile URL and attribution from build args `VITE_TILE_URL` and `VITE_TILE_ATTRIBUTION`, defaulting to the OpenStreetMap standard tiles with their attribution; keep Prada's grey CSS treatment | Works worldwide; swappable for a self-hosted or commercial source without code changes |
| Wire types | Generate TypeScript types from `contracts/openapi.yaml` with `openapi-typescript` into `src/data/api-types.gen.ts`; `adapters.ts` and `apiSource.ts` are the only importers; CI checks the generated file is current | One source of truth instead of hand-written `Api*` interfaces |
| Live updates | `EventSource('/api/v1/events')` with the fallback rules in `realtime-and-chat.md` | Replaces fragile 2 s polling |
| Chat | `useChat` from `@ai-sdk/react` with `DefaultChatTransport` from `ai`, headless, own components in CSS modules. Pin exact versions and read that version's docs for `useChat`, transports, `onData` and data parts. Do not use AI Elements | The backend streams the AI SDK UI message stream v1; AI Elements does not fit CSS modules |
| DIN 4023 patterns | Import `assets/din4023_patterns/din_codes.json` and `patterns.svg` from the repository root through a Vite alias (`@din`); inline `patterns.svg` once in the DOM | Single source shared with the backend's code validation |
| Product name | One constant `APP_NAME` (build arg `VITE_APP_NAME`, default "Bormisu"); remove the customer name from code paths other than brand tokens | README section 5 |
| Exports | Stay client-side in v1 (the backend has no export endpoint); extend them to every new field | Already tested; one implementation |
| Sample mode | Keep for `npm run dev:sample` and the sample-mode e2e suite; the Docker build is always API mode | ARCHITECTURE rule; the user wants uploaded data only in the product |

## 4. Contract alignment (M0, before new features)

Do these against `contracts/examples/*.json` (the backend's first commit) and update the adapter tests to load those files.

1. **Types.** Generate `api-types.gen.ts`; replace the hand-written `Api*` interfaces.
2. **uid.** Use the server's opaque `uid` (`bh_<ULID>`). Delete the `${document_id}:${borehole_id}` fallback; a record without `uid` is an adapter error.
3. **Errors.** Every error is `{detail, code, errors?}`. Branch on `code` (`demo_mode`, `document_not_found`, `revision_conflict`, `validation_error`, `chat_unavailable` …), show `detail`. Keep "backend unreachable" for network failures and non-JSON 5xx only; use "endpoint missing" only for `route_not_found`.
4. **Health.** Call `GET /api/v1/health` at boot. `mode: demo` shows a banner ("Live extraction needs API keys") and disables upload with that reason. `providers.chat: false` disables the chat button with a tooltip. The drop zone's accept list and size limit come from `upload.extensions` and `upload.max_mb`.
5. **Review status.** Show the server's `review_status` (`unreviewed`, `in_review`, `approved`) on chips and pins. Keep the client derivation only for the optimistic moment between a click and the PATCH response.
6. **PATCH.** Apply the returned `BoreholeRecord` to the store after every PATCH. Send `if_revision`; on 409 `revision_conflict`, refetch the record and tell the user. Undo uses `action: "reset"` (un-approve, un-flag); "back to ok" is `set_state` with `ok`. Valid paths are exactly the keys of the record's `provenance` map; remove `geotechnical_tests.water_table_m`.
7. **Approve all clean.** `POST /documents/{id}/approve-clean?dry_run=true` for the count in the confirm dialog, then `dry_run=false`, then refetch the document's boreholes. Delete the client loop of single PATCHes.
8. **Provenance.** Methods are exactly `read | ocr | derived | guessed | edited`. A value without a provenance entry shows no source icon and cannot be approved; log a console warning (it is a backend bug). Show `readings` side by side when present. Spreadsheet values have `cell` instead of `page`/`box`: show "Sheet!C5" as the source.
9. **Coordinates and CRS.** Use `crs_status` and `plotted` from the server. Remove the `coordinate_system ? 'stated' : 'unknown'` fallback and the `(0, 0)` special case: `null` means unknown. Map `unplotted_reason` codes to labels: `no_coordinates` "No coordinates in source", `crs_unknown` "Coordinate system unknown", `crs_unconfirmed` "Coordinate system needs confirmation", `implausible` "Coordinates implausible". Show `x_raw`, `y_raw` and `axis_labels_raw` as printed next to the converted values.
10. **CRS dialog.** Use the API's `verdict`, `note`, `score` and `swap_axes`; send `swap_axes` with the confirmation. After confirming, refetch the document's boreholes and the map layer instead of moving pins locally. Use the backend's `label` everywhere; delete both `shortCrsName` functions and the Rechtswert wording.
11. **Layers.** `din4023_code` is a DIN key or `null`; draw it with the DIN assets (section 5, F8). Show `din4023_notation` and `english_lithology`; show `original_description` on hover. Show `stratigraphic_name` as text on a neutral fill; delete `STRAT_COLORS`.
12. **SPT.** Keep raw, N, refusal and increments. When `spt_depth_m` is null, draw the marker inside the layer but label it "depth not stated"; never print an invented depth.
13. **New fields into values and exports.** BoreholeName, LocationName, EndDate, ProjectID, BoreholeLength, DrillingMethod, elevation datum, depth origin, inclination; per layer StratigraphicName, EngineeringSoilUnit, GeologicAge, Core, colour, moisture, weathering; `samples[]` to SampleName and SampleDepth; `test_results[]` to the Test Results sheet.
14. **Documents.** Use `pages[].type`, `role`, `used`, `unused_reason`, `ocr`, `handwriting`, `duplicate_of` for the page strip and its tooltips; delete `pageUsage()` in `theme.ts`. Show `progress` as a bar, `open_clarifications` as a badge, `duplicate_of` as a link, `error` with a Retry button (`POST /documents/{id}/retry`).
15. **Names.** Replace `confirmed_by: 'Bormisu reviewer'` with an optional "Your name" setting kept in `localStorage`, sent as `confirmed_by` and `answered_by` (or `null`). Show "Stored with your name" only when a name is set.

## 5. Work items

Priority order; each item lists what "done" means. Write tests with each item.

### P0: by M1 (Sat 14:00)

**F1 Toolchain and Docker.** `engines`, `.nvmrc`, `testTimeout: 30000` in the vitest config. `frontend/Dockerfile`: build context is the repository root (so `assets/` is reachable); stage 1 `node:22-alpine`, `npm ci`, build with `VITE_DATA_SOURCE=api`, `VITE_API_BASE=/api/v1` and the tile and name args; stage 2 `nginx:alpine` serving `dist/`. `frontend/Dockerfile.dockerignore` excludes `.git`, `**/node_modules`, `backend/`, `local/`, `storage/`, `HKBoreholeChallenge*`, `*.zip`. `frontend/nginx.conf`:
- SPA fallback to `/index.html`; long cache for hashed `/assets/`, no cache for `index.html`; gzip.
- `location /api/` proxies to `http://api:8000` with `client_max_body_size` equal to the backend's `MAX_UPLOAD_MB` (200m).
- `location /api/v1/events` and `/api/v1/chat`: `proxy_buffering off`, `proxy_cache off`, `proxy_http_version 1.1`, `proxy_set_header Connection ""`, `proxy_read_timeout 3600s`.
- No keys and no environment secrets in the image.

Done when `docker compose up --build` serves the app on :8080, `/api/v1/health` answers through nginx, SSE events arrive unbuffered, and the build output has no sample chunk.

**F2 Contract alignment.** Section 4, with adapter tests on `contracts/examples`.

**F3 Store split.** Split `appStore.ts` into slices (data, review, map, upload, panel), then add new slices (events, clarifications, chat, selection) as separate files. Do this before F6.

**F4 Router and URL state.** Routes: `/map`, `/queue`, `/review/:uid`, `/boreholes/:uid`, `/inbox`. The map URL holds view, filters, result set id and selected uid; reload restores them.

**F5 Health and empty states.** Demo banner, disabled controls with reasons, an empty map with "Upload a report to see boreholes here", empty queue and inbox texts.

**F6 Upload and live queue.** Uploads through `XMLHttpRequest` for byte progress, two at a time, each cancellable. Files dropped together send one `project` (typed by the user, else the dropped folder's name). A 200 duplicate answer shows "already uploaded" with a link. Events update cards live; fallback polling backs off from 2 s to 30 s and never stops for good after one error. Page strip thumbnails use `?w=200`.

**F7 Review.** Section 4 items 5–8 working end to end on a seeded document: approve, edit, flag, set state, reset, approve all clean, conflict handling, readings shown.

**F8 Detail with real DIN 4023 profile.** Look up `din4023_code` in `din_codes.json` and fill with `url(#<pattern_id>)` from the inlined `patterns.svg`. Follow `assets/din4023_patterns/README.md`: tiles repeat and are never stretched; `patternUnits="userSpaceOnUse"`; one global scale factor per profile; unknown or missing code is plain `#E0E0E0` with the code text; code `A` gets a white underlay; keys are case-sensitive (`mG` is not `Mg`). Legend lists the codes used and the note "nach DIN 4023". Remove the 9 inline patterns and the regex classifier.

### P1: by M2 (Sat 20:00)

**F9 World map.**
- Start at a world view; fit to the data when pins exist.
- Pins come from `GET /map/boreholes.geojson` with clustering on a canvas renderer. Colour by review status: approved green, unreviewed grey, `attention` amber. A toggle colours by depth class instead; the classes are a config array, not code.
- Popup (`textContent` only) shows ID, project, depth and status, with Detail, Review and Source buttons.
- The results table under the map syncs with the selection.
- The "Not on map" list comes from `GET /boreholes?plotted=false` with reason labels.
- Done when 5,000 fictional pins pan smoothly.

**F10 Area selection and filters.** Geoman rectangle, polygon and circle send `POST /result-sets` with the area; the filter panel (search, country, project, depth range, DIN codes, has SPT, has groundwater, review status, include unreviewed) sends the same call. The result set highlights on the map, fills the table, and its id goes in the URL. "Reset" clears it.

**F11 Place search.** Calls `GET /geocode?q=` on submit only, never as typeahead. One candidate flies there with `flyToBounds`; several candidates show a short list with uploaded places first. A place with zero boreholes still flies there, outlines the area dashed and says "No uploaded boreholes here". A 503 shows "Place search unavailable".

**F12 Clarifications.**
- The nav badge counts open clarifications, from events plus `GET /clarifications`.
- The `/inbox` list is grouped by document.
- One `ClarificationDialog` renders `fields` by widget: `text`, `number_unit`, `select`, `boolean`, `map_point`, `choose_reading` with evidence crops, `page_range`, and `crs_picker` (reuses the CRS dialog). It shows `evidence` pages with boxes beside the form.
- Answer calls `POST /clarifications/{id}/answer`; on 422 it shows field errors. "Skip for now" calls `/skip`.
- The dialog also opens from document cards, the review screen and the chat.

**F13 CRS dialog on real candidates.** Candidate list with verdict colours and notes, a mini-map preview of each candidate's points with the same basemap, a swap-axes indicator, and confirm for the whole project or document.

### P1: by M3 (Sun 00:00)

**F14 Chat drawer.** A right-hand drawer with the transcript, streaming text, a stop button, short tool-progress lines ("Finding Auckland…", "Counting boreholes…"), and an "include unreviewed" toggle next to the input. It renders the data parts from `realtime-and-chat.md` 2.2:
- result cards with "Show on map" and "Open table";
- numbered citation chips that open the Source panel at the page and box;
- the scope line;
- inline clarification forms.

The request sends `context`: selected uids, the active result set, the filters, `map_view` only when the user refers to the visible area, units, and include unreviewed. A 409 `chat_unavailable` shows a disabled state.

**F15 Command dispatcher and map animation.**
- One module executes the allowlisted `data-ui-command`s from `onData`; anything else is ignored and logged.
- `fit_result_set` and `fit_bounds` use `flyToBounds` with 48 px padding and draw a dashed outline when asked. Under `prefers-reduced-motion` they move instantly.
- `focus_borehole` flies to the pin and opens its popup.
- `request_area` starts draw mode with the prompt as a hint and sends the area with the next message.

Test the dispatcher with recorded fictional streams.

### P2: only after everything above

- Units m/ft toggle.
- German UI strings.
- Delete document.
- Stats strip.
- Keyboard review extras.
- `axe` checks in Playwright.

### Cut order if behind

Cut in this order: P2 items, then the polygon and circle tools (keep rectangle), then the depth-class toggle, then `request_area`, then tool-progress lines.

Never cut:
- the Docker build;
- the health and demo states;
- upload, live queue, review and detail with real DIN patterns;
- the world map with clustering;
- clarifications;
- the chat with `show_result_set`, `fit_result_set` and citations.

## 6. Layout and look

- Brand tokens from `docs/design/herrenknecht-brand.md` as CSS variables in `tokens.css`: dark green app bar `#003E25`, green accent `#7DB713`, grey neutrals, Inter as the font (Univers is licensed). Do not copy the customer's logo; use the placeholder mark.
- LGRB information architecture from `docs/design/reference-site.md` and its screenshots, but not LGRB's colours:
  - left accordion with place search and filters;
  - the map in the centre with the results table under it;
  - the detail drawer on the right.
  - The chat drawer also opens on the right; when both are open, the chat stacks above the detail drawer.
- Semantics from `docs/personas/ui-features.md` section 9: green approved, grey unreviewed, amber attention, red error, grey italics "not in source", struck-through AI value after an edit, amber "R" for SPT refusal.
- Responsive:
  - ≥ 1280 px: three panes.
  - 768–1279 px: drawers overlay the map.
  - < 768 px: full-screen sheets.
  - No horizontal page scroll at 390 px.
- Accessibility:
  - every map action has a keyboard path through the results table;
  - focus is trapped in dialogs;
  - result counts are announced with `aria-live`;
  - contrast is at least 4.5:1.

## 7. Testing

| Suite | What |
|---|---|
| Unit (vitest) | Adapters on `contracts/examples`, error mapping by `code`, SSE client and fallback, upload queue, form widgets, command dispatcher, DIN pattern lookup (unknown code → `#E0E0E0`), result-set URL state |
| e2e, sample mode (existing 24) | Keep green; extend for router, map clustering and the inbox in sample mode |
| e2e, API mode (new) | `E2E_BASE_URL=http://localhost:8080` against `docker compose up` plus `make seed`: map pins, review approve and reset persisting across reload, approve all clean, CRS confirmation, clarification answer. Chat with Playwright route interception serving a recorded **fictional** stream, so no key is needed |
| Build | `npm run build` and `npm run gen:api` with no diff in `.github/workflows/frontend.yml`; Playwright with bundled Chromium in CI (make the `channel: 'chrome'` setting conditional) |

Run all suites before every merge to `integration`, and report real results in `COORDINATION.md`.

## 8. Do not

- Call any model provider from the browser, or put any key or secret in the frontend.
- Import from `src/sample` outside `createDataSource.ts`, or ship sample data in the API build.
- Add default values: no `sand`, no `0`, no `(0, 0)`, no invented SPT depth, no "stated" CRS the server did not send.
- Parse `detail` text, or trust coordinates inside chat commands other than `fit_bounds.bbox`.
- Use challenge data in fixtures, screenshots or tests. `docs/screenshots` must show fictional data only.
- Hard-code a country, a CRS family, a language or a sample's project name.

## 9. Working with the backend session

- Until the backend's M0 lands, work in sample mode and on `contracts/examples`. Then switch to the seeded API.
- Ask for contract changes in `COORDINATION.md` under "Contract requests"; never work around a gap silently.
- Send your part of the root README (screens, keyboard shortcuts, how to run the frontend alone) through `COORDINATION.md`.
- Merge to `integration` at each milestone with green suites and a status entry. Read the backend's progress with `git log feat/backend`.
