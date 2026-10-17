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
    main.tsx  App.tsx  config.ts                       bootstrap, layout route (shell), build-time settings
    router.tsx  routing/   routes (createBrowserRouter), urlState.ts (every URL built or read), RouteSync,
                           navigator (injected into the store), route screens, not-found page
    domain/      types.ts (all domain types), status.ts (review status, attention, clean values),
                 pages.ts (page placeholders, usage text), din.ts (DIN 4023 lookup), keys.ts,
                 review.ts (value patches), spt.ts, format.ts
    data/        DataSource.ts (interface), errors.ts (ApiError, UnreachableError, SaveError,
                 UploadCancelledError), api-types.gen.ts (generated), adapters.ts, apiSource.ts,
                 events.ts (live events and the polling fallback), createDataSource.ts,
                 contract.test.ts (fixtures and contracts/examples validated against the contract)
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
- `ExtractedValue`: one reviewable value with its provenance (`page` + `box`, or a spreadsheet `cell`), `method` and `confidence` (null when unknown), review `status` and `state`, the AI value, `readings` when two readers disagreed, and `hasProvenance` (false when the backend sent no entry, which the contract allows: such a value has no source icon and can't be reviewed, because only provenance keys are valid PATCH paths; the API source logs one `console.info` summary per load, never a warning per value).
- `Layer`: depths, English and printed lithology, `din` (a key of `din_codes.json`, case-sensitive, or null), `dinNotation`, stratigraphic name, engineering soil unit, age, colour, consistency, moisture, weathering, core flag, SPT (`depth` null when not stated), TCR, RQD.
- `DocumentSummary`: `status`, one `DocumentPage` per page (placeholders until classified), `progress`, counts, completeness, `openClarifications`, `duplicateOf`, `error`.
- `Health`: `mode` (`live`, `demo` without provider keys, `sample`), providers, upload limits, `auth` (sign-in on, registration open; absent means off).
- `User`: `userId`, `email`, `displayName` (null when none), `role` (`reviewer | admin`), `createdAt`. `Registration`: email, password, optional display name.
- Status rules (`status.ts`): `displayStatus(b)` is `attention` (a flagged value, a lint error or an open clarification) or else the server's review status. `deriveReviewStatus` mirrors the backend for the moment between a click and the answer. `isClean` mirrors the backend's approve-clean rule (read, or OCR with confidence ≥ 0.9; unreviewed, ok, no flag, no lint).

## Data source (`src/data/DataSource.ts`)

`health`, `load`, `getBorehole`, `documentBoreholes`, `getDocument`, `getPage`, `thumbnailUrl` (page images at width 200), `upload(file, {project, onProgress})` (one file, returns `{done, cancel}`), `subscribe(onEvent, onStatus)` (live events), `follow(documentId)`, `updateValue` (resolves with the borehole as the source now holds it), `approveClean(documentId, dryRun)`, `retry`, `crsCandidates`, `confirmCrs({code, swapAxes, confirmedBy})`.

- **API source.** Every error answer becomes an `ApiError` with the contract's `code`; the UI branches on `code` and shows `detail`, never parsing it. Network failures, non-JSON 5xx and HTML where JSON was expected are `UnreachableError` ("backend unreachable"); only `route_not_found` reads "Backend endpoint not available". Saves are serialised per borehole and send `if_revision`; a `revision_conflict` refetches the record; a failure throws `SaveError` whose `current` is what the server holds. "Undo" is the `reset` action. Uploads use `XMLHttpRequest` for byte progress and can be cancelled; a 200 duplicate answer is the earlier document, never a duplicate of itself.
- **Live events** (`events.ts`): `EventSource` on `GET /events`, which reconnects itself and resends `Last-Event-ID`; each named event is mapped through the adapters to a `LiveEvent`. After three stream errors within a minute (or without `EventSource`) the source polls `GET /documents/{id}` for the documents it follows every 2 s, backing off to 30 s after errors and never giving up after one; a terminal or deleted document stops being followed. It keeps trying the stream and goes back to `live` once it opens; a recreated stream refetches the followed documents once (it cannot resend `Last-Event-ID`). Status `offline` means neither the stream nor a poll succeeded for 60 s.
- **Sample source.** In memory, deterministic, simulated uploads; implements the same interface, including revisions and approve-clean.

## Store (`src/store/`)

One zustand store (`useAppStore`) combined from slices, with selectors (`useBorehole`, `useValue`, `useDocument`, `useReviewBorehole`, `useSelectedBorehole`, `useIsReviewable`, `usePage`):

| Slice | Holds |
|---|---|
| `dataSlice` | data source, health, load state, boreholes, documents, page cache |
| `reviewSlice` | Review screen, saves, approve all clean, CRS dialog |
| `mapSlice` | Detail selection, search, map focus |
| `uploadSlice` | drop zone (types and size limit from health), the upload queue (two at a time, byte progress, cancel, retry, the project label typed or taken from a dropped folder), document updates, retry |
| `eventsSlice` | the live subscription (`startLive` after load, `stopLive` on teardown), `liveStatus`, `applyLiveEvent` for every event type, server-reported job failures |
| `panelSlice` | navigation through the injected router navigator, route, side panel, export menu, toast, Escape |
| `settingsSlice` | the reviewer's optional name (localStorage), sent as `confirmed_by` without sign-in |
| `authSlice` | sign-in state and user, sign-in, registration, sign-out, password change, ended sessions (see Sign-in) |
| `chatSlice` | the chat drawer's state |

**Saves** (`saves.ts`, `SaveTracker`): a review action updates the store optimistically; while saves of a borehole are pending, answers and refetches are only collected; when the last one settles, the newest record (highest revision) replaces the borehole. A failed save therefore rolls back exactly to what the server holds, and an older answer never overwrites a newer one. **Approve all clean** asks the server for the count (`dry_run=true`), confirms, then reloads the document's boreholes. **CRS confirmation** sends the candidate's `swap_axes` and the reviewer's name, then reloads the document's boreholes instead of moving pins locally.

**Live events** apply idempotently: `document.updated` replaces the document (and loads its boreholes once it reaches review, so an uploaded document becomes reviewable without a reload); `borehole.created` / `borehole.updated` refetch through `takeBoreholes`, which respects pending saves, one refetch per uid at a time; `document.deleted` removes the document and its boreholes; `job.failed` shows the stage and detail with RETRY when retryable; clarification events refetch the affected counts.

Escape closes, in order: editing → confirm clean → export menu → CRS dialog → side panel.

## Sign-in (contract 1.3.0)

The backend's sign-in is email and password with an HttpOnly session cookie (`gm_session`, SameSite=Lax): no token ever reaches JavaScript, and CSRF is the server's Origin check (same-origin fetch and XHR send cookies and Origin), so the frontend adds no header. `health.auth` says whether the server has sign-in (`enabled`) and whether anyone may create an account (`registration: 'open'`; the first account becomes admin). A health answer without `auth` (contract 1.1.0) and sample mode mean no sign-in: the app works exactly as before, with the optional "Your name" setting.

- **Data layer.** Until `openapi.yaml` carries 1.3.0, the wire shapes are local types in `adapters.ts` (`WireUser`, `adaptUser`). `apiSource` implements `currentUser` (GET /auth/me; 401 is null), `signIn`, `register`, `signOut` (idempotent) and `changePassword`. Every request (fetch and the XHR upload) that answers 401 `not_authenticated` calls the session listener once per burst, except /auth/login, /auth/register, /auth/password, /auth/me and /auth/logout, whose 401 is an answer; a 401 of a request sent before the latest sign-in is not reported again. An `EventSource` can't see status codes: while sign-in is on, a stream failure checks GET /auth/me, and after the session ended the stream is not reopened (the store unsubscribes). A 429 carries `Retry-After` as `ApiError.retryAfter` (seconds).
- **Store** (`authSlice`, `dataSlice.init`). `authState` is `unknown` until health is read (`disabled` from the start in sample mode). Without sign-in: `disabled`, everything loads as before. With it: GET /auth/me; no user is `signedOut` and nothing loads; a user is `signedIn`, then the boot loads as before. `signIn` / `register` set the user and run the load and the live subscription; a 422's field errors go to `authFieldErrors` by the last name in `loc`, other failures to `authError` (wrong credentials, email taken, "Try again in N minutes" from Retry-After, unreachable). `signOut` posts the logout, then `resetData` stops live updates, cancels uploads, ends loads in flight and forgets every loaded record and the state built on it (selection, review, result set, panels, chat drawer); the URL stays. `sessionEnded` (the source's listener) does the same without the request and says "Your session ended. Sign in again."; the route is kept, so the user is back on it after signing in. Signed in, `confirmed_by` / `answered_by` are sent as null: the server records the session's user.
- **UI.** `AuthGate` (wraps the app shell) shows the app when `disabled` or `signedIn`, a centred loading state while `unknown` (the app's NO DATA state when the boot failed), and `SignInScreen` when `signedOut`: SIGN IN, and CREATE ACCOUNT when registration is open, with the password rules, client checks of what the form can see (lengths, the password equal to the email, the repeat; `components/auth/authRules.ts`), errors next to the fields and on top (role=alert), the focus on the first invalid field. `UserMenu` in the header: signed in, the display name (else the email) opening the email, the role, CHANGE PASSWORD (`ChangePasswordDialog`, modal with a focus trap) and SIGN OUT; without sign-in, `ReviewerName`.
- **Tests.** `apiSource.auth.test.ts`, `store/auth.test.ts`, `components/auth/auth.test.tsx`; `e2e/api/auth.spec.ts` plays the 1.3.0 server with Playwright routes against today's stack. `e2e/api/auth-session.ts` (E2E_AUTH=1) registers a fictional account and starts pages with its session, for when the backend ships sign-in.

## Routing (`src/router.tsx`, `src/routing/`)

react-router in data mode (`createBrowserRouter`); nginx and Vite fall back to `index.html`. Routes: `/` → `/map`, `/map?at=<lat>,<lng>,<zoom>&sel=<uid>&rs=<result set>`, `/queue`, `/review/:uid?key=<value key>`, `/boreholes/:uid?layer=<n>`, anything else a not-found page. The URL is the source of navigation truth: `RouteSync` applies every location to the store one way (`screen`, `selectedUid`, `reviewUid`, map view, selected layer and value); navigation actions (`go`, `openBorehole`, `openReview`, search) update the store and call the navigator injected in `main.tsx`, which pushes a history entry, or replaces it when only the query changes (pan, zoom, popup, layer, focused value after a short rest). Without a navigator (unit tests) the actions set the store directly. Reload and deep links restore the screen and selection; an unknown uid shows "Borehole not found", never a blank page. All URL building and parsing lives in `urlState.ts`.

## Screens

| Screen | Notes |
|---|---|
| Header, banners | Nav (MAP, UPLOAD & QUEUE with a badge for documents in review, REVIEW), search, the reviewer-name setting, `APP_NAME`. SAMPLE DATA banner in sample mode; "Live extraction needs API keys" in demo mode |
| Map | Leaflet with the configured basemap (grayscale CSS); world view first, fit to the data. Pins from the light map layer on a canvas renderer, clustered (leaflet.markercluster), coloured by `displayStatus` or by depth class (`screens/map/depthClasses.ts`, "depth not stated" is its own class) with a legend that counts the pins shown. Popups (textContent only) with DETAIL, REVIEW, SOURCE. Rectangle, polygon and circle selection (leaflet-geoman, loaded on demand) → result set (`rs=` in the URL), highlighted with the others dimmed; fly-to with a dashed outline for places. Left panel: place search (on submit), filters (→ `POST /result-sets`), NOT ON MAP with reason labels. RESULTS table under the map: sortable, paginated, synced with the selection, the keyboard path to every pin |
| Upload & queue | Drop zone mirroring the server's types and size limit (disabled with a reason in demo mode), a "Project (optional)" field, upload rows with byte progress, cancel, remove and retry, an "Already uploaded" notice that jumps to the existing card, the live-status line, document cards with steps, progress bar, page strip from `pages[]` (thumbnail and `pageUsageText` on hover or focus), completeness chip, open-clarification badge, duplicate link, the server's failure stage and detail with Retry |
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
| `npm run e2e` | Playwright project `sample` (system Chrome locally, bundled Chromium in CI); `E2E_BASE_URL=http://localhost:8081 npm run e2e -- --project=api` runs the API project against a seeded compose stack |

Node ≥ 22.12 is required (`engines`, `.nvmrc`).
