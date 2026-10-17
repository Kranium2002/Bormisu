# Bormisu frontend: architecture

React 19 + TypeScript 7 + Vite 8, zustand for state, Leaflet for maps, exceljs for the xlsx export, CSS modules. It started as a port of the Claude Design prototype `Bormisu App.dc.html` (same screens, layout, colours and interactions) and is now the web client of the GeoMemory backend: it builds against contract 1.0.0 (`../contracts/openapi.yaml`, `../contracts/realtime-and-chat.md`), not against backend code.

## Hard rules

1. **No invented values.** Unknown is `null` (or empty display text shown in grey italics as "not in source"). Never `0`, `(0, 0)`, a default lithology or pattern, an invented SPT depth, a default confidence, or a CRS status the server did not send. Exports leave unknown cells blank.
2. **Wire shapes live in one place.** `src/data/api-types.gen.ts` is generated from the contract (`npm run gen:api`; CI fails when it is stale). Only `src/data/adapters.ts` and `src/data/apiSource.ts` import it. Everything else uses the domain types in `src/domain/types.ts`.
3. **No hard-coded sample data outside `src/sample/`.** Every file there starts with `// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.` Only `src/data/createDataSource.ts` imports it, lazily and behind the flag, so an API build holds no sample data (`npm run check:dist` proves it; the Docker build runs it).
4. **The data source is chosen once**, in `createDataSource.ts`, from `VITE_DATA_SOURCE`: `api` (default; the Docker image always) or `sample` (dev and tests only, with a SAMPLE DATA banner that can't be dismissed).
5. **The target format is defined once**, in `src/schema/targetFormat.ts` (sections, field names, formats, units, plus `EXTRA_FIELDS`). Export and labels read from it.
6. **No challenge data anywhere.** Fixtures, tests and screenshots are fictional and say so.
7. **Nothing country-, CRS-family- or language-specific in product code.** CRS labels, verdicts and notes come from the backend; the product name comes from `APP_NAME` (`src/config.ts`, build arg `VITE_APP_NAME`).
8. Plain CSS modules plus design tokens in `src/styles/tokens.css`. Inline `style` only for runtime values.

## Folder layout

```
frontend/
  Dockerfile  Dockerfile.dockerignore  nginx.conf      production image (repo root is the build context)
  scripts/check-dist.mjs                               fails when a build contains sample data
  src/
    main.tsx  App.tsx  config.ts                       bootstrap, shell, build-time settings
    domain/      types.ts (all domain types), status.ts (review status, attention, clean values),
                 pages.ts (page placeholders, usage text), din.ts (DIN 4023 lookup), keys.ts,
                 review.ts (value patches), spt.ts, format.ts
    data/        DataSource.ts (interface), errors.ts (ApiError, UnreachableError, SaveError),
                 api-types.gen.ts (generated), adapters.ts, apiSource.ts, createDataSource.ts,
                 contract.test.ts (fixtures validated against the contract)
    sample/      DEMO ONLY fictional data source
    store/       zustand store combined from slices (below)
    components/  shared UI: Header, Banner, ReviewerName, SidePanel/SourcePanel, ScanPage, DinPatternDefs …
    screens/     map/, queue/, review/, detail/
    export/      standardXlsx.ts, csv.ts, scope.ts, download.ts
    schema/      targetFormat.ts
    test/        fixtures.ts (domain builders), contract/*.json (fictional wire payloads)
  e2e/           Playwright: sample-mode suite; e2e/api/ runs against a live stack (E2E_BASE_URL)
```

`@din` is a Vite alias for `../assets/din4023_patterns`, the DIN 4023 pattern set shared with the backend.

## Domain model (`src/domain/types.ts`)

- `Borehole`: opaque `uid` (server `bh_<ULID>`, never parsed), the printed `id`, `revision`, the server's `reviewStatus` (`unreviewed | in_review | approved`), `openClarifications`, position (`lat`/`lng` null when unknown, `onMap`, `unplottedReason` code), `crs` (`name` as printed, `code` EPSG, `status`), `meta` (aliases, datum, depth origin and source, coordinates as printed), `layers`, `groundwater`, `samples`, `testResults`, `rockHead`, `values`, `pages`.
- `ExtractedValue`: one reviewable value with its provenance (`page` + `box`, or a spreadsheet `cell`), `method` and `confidence` (null when unknown), review `status` and `state`, the AI value, `readings` when two readers disagreed, and `hasProvenance` (false only for a backend bug: such a value has no source icon and can't be reviewed, because only provenance keys are valid PATCH paths).
- `Layer`: depths, English and printed lithology, `din` (a key of `din_codes.json`, case-sensitive, or null), `dinNotation`, stratigraphic name, engineering soil unit, age, colour, consistency, moisture, weathering, core flag, SPT (`depth` null when not stated), TCR, RQD.
- `DocumentSummary`: `status`, one `DocumentPage` per page (placeholders until classified), `progress`, counts, completeness, `openClarifications`, `duplicateOf`, `error`.
- `Health`: `mode` (`live`, `demo` without provider keys, `sample`), providers, upload limits.
- Status rules (`status.ts`): `displayStatus(b)` is `attention` (a flagged value, a lint error or an open clarification) or else the server's review status. `deriveReviewStatus` mirrors the backend for the moment between a click and the answer. `isClean` mirrors the backend's approve-clean rule (read, or OCR with confidence ≥ 0.9; unreviewed, ok, no flag, no lint).

## Data source (`src/data/DataSource.ts`)

`health`, `load`, `getBorehole`, `documentBoreholes`, `getDocument`, `getPage`, `upload` (with a `project` label), `watch`, `updateValue` (resolves with the borehole as the source now holds it), `approveClean(documentId, dryRun)`, `retry`, `crsCandidates`, `confirmCrs({code, swapAxes, confirmedBy})`.

- **API source.** Every error answer becomes an `ApiError` with the contract's `code`; the UI branches on `code` and shows `detail`, never parsing it. Network failures, non-JSON 5xx and HTML where JSON was expected are `UnreachableError` ("backend unreachable"); only `route_not_found` reads "Backend endpoint not available". Saves are serialised per borehole and send `if_revision`; a `revision_conflict` refetches the record; a failure throws `SaveError` whose `current` is what the server holds. "Undo" is the `reset` action. Documents still being processed are polled with backoff (2 s doubling to 30 s) that never gives up after one error. Server-sent events replace polling in M1.
- **Sample source.** In memory, deterministic, simulated uploads; implements the same interface, including revisions and approve-clean.

## Store (`src/store/`)

One zustand store (`useAppStore`) combined from slices, with selectors (`useBorehole`, `useValue`, `useDocument`, `useReviewBorehole`, `useSelectedBorehole`, `useIsReviewable`, `usePage`):

| Slice | Holds |
|---|---|
| `dataSlice` | data source, health, load state, boreholes, documents, page cache |
| `reviewSlice` | Review screen, saves, approve all clean, CRS dialog |
| `mapSlice` | Detail selection, search, map focus |
| `uploadSlice` | drop zone (types and size limit from health), uploads, document updates, retry |
| `panelSlice` | navigation, side panel, export menu, toast, Escape |
| `settingsSlice` | the reviewer's optional name (localStorage), sent as `confirmed_by` |

**Saves** (`saves.ts`, `SaveTracker`): a review action updates the store optimistically; while saves of a borehole are pending, answers and refetches are only collected; when the last one settles, the newest record (highest revision) replaces the borehole. A failed save therefore rolls back exactly to what the server holds, and an older answer never overwrites a newer one. **Approve all clean** asks the server for the count (`dry_run=true`), confirms, then reloads the document's boreholes. **CRS confirmation** sends the candidate's `swap_axes` and the reviewer's name, then reloads the document's boreholes instead of moving pins locally.

Escape closes, in order: editing → confirm clean → export menu → CRS dialog → side panel.

## Screens

| Screen | Notes |
|---|---|
| Header, banners | Nav (MAP, UPLOAD & QUEUE with a badge for documents in review, REVIEW), search, the reviewer-name setting, `APP_NAME`. SAMPLE DATA banner in sample mode; "Live extraction needs API keys" in demo mode |
| Map | Leaflet with the configured basemap (grayscale CSS). Pins coloured by `displayStatus`, legend counts, NOT ON MAP list with reason labels, RESULTS table; every row opens Detail. World view, clustering and area selection arrive with F9/F10 |
| Upload & queue | Drop zone mirroring the server's types and size limit (disabled with a reason in demo mode), document cards with steps, progress bar, page strip from `pages[]` (tooltips from `pageUsageText`), completeness chip, open-clarification badge, duplicate link, error with Retry |
| Review | Scan page with value boxes; values grouped BOREHOLE / GROUNDWATER / LAYER n / SAMPLES / TEST RESULTS; approve, edit (AI value struck through), flag, not in source, illegible, undo; readings side by side; spreadsheet cells as "Sheet!C5"; APPROVE ALL CLEAN with the server's count; CRS dialog with verdicts, notes, scores and the swap-axes flag |
| Detail | DIN 4023 profile, metadata (raw coordinates as printed next to converted ones), layers, groundwater, location map, exports |

**DIN 4023 profile.** `DinPatternDefs` inlines `assets/din4023_patterns/patterns.svg` once at the app root; layers fill with `url(#<pattern_id>)` looked up in `din_codes.json` (`src/domain/din.ts`). Tiles repeat at their native size (`userSpaceOnUse`, never stretched); an unknown or missing code is plain `#E0E0E0` with the code as text; `A` (fill) gets a white underlay. The Strat. column shows the stratigraphic name as text on a neutral fill. An SPT refusal without a stated depth is drawn inside its layer and labelled "depth not stated". The legend lists the codes used and says "nach DIN 4023".

## Export (`src/export/`)

Client-side in both modes, from domain data:
- **Standard xlsx** (`standardXlsx.ts`): sheets Metadata, Logdata, Test Results (field names in row 1, units in row 2) plus Provenance. Template columns come first and in order; fields the template lacks (drilling method, datum, depth origin, inclination; layer colour, consistency, moisture, weathering) follow as extra columns. Without "include unreviewed", only approved values are exported; with it, a `DRAFT – NOT APPROVED` title row and a `_DRAFT` file suffix. A blank never means 0.
- **CSV** (`csv.ts`): the tidy CSV (one row per value) and the open-questions CSV for the client.
- One BoreholeID per borehole on every sheet (`exportId`): the reviewed value once approved, else the ID as printed.

## Docker

`frontend/Dockerfile` builds with the repository root as context (the compose service `web`): stage 1 `node:22-alpine` runs `npm ci`, `npm run build` (API mode, `VITE_API_BASE=/api/v1`) and `npm run check:dist`; stage 2 is nginx. `nginx.conf` serves the SPA with an `index.html` fallback, caches hashed assets for a year and `index.html` never, gzips text, proxies `/api/` to `API_UPSTREAM` (default `http://api:8000`, resolved per request so nginx starts even when the API is down), streams `/api/v1/events` and `/api/v1/chat` unbuffered, and answers an oversized upload with the contract's JSON `too_large` error. Build args: `VITE_APP_NAME`, `VITE_TILE_URL`, `VITE_TILE_ATTRIBUTION`. The image holds no keys.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `npm run dev:sample` | Vite dev server in API mode (proxies `/api` to `VITE_API_PROXY`, default http://127.0.0.1:8000) / sample mode |
| `npm run build` | `tsc -b` and the production build |
| `npm run check:dist` | fails when `dist/` contains sample data |
| `npm run gen:api` | regenerates `src/data/api-types.gen.ts` from the contract |
| `npm test` | Vitest: domain, adapters on the contract fixtures, store with fake sources, view models, exports |
| `npm run e2e` | Playwright in sample mode (system Chrome locally, bundled Chromium in CI) |

Node ≥ 22.12 is required (`engines`, `.nvmrc`).
