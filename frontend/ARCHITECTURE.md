# Bormisu frontend: architecture

React 19 + TypeScript + Vite. It is a port of the Claude Design prototype `Bormisu App.dc.html`, which is the visual and behavioural reference: same screens, layout, colours, copy and interactions. The prototype is a single file with inline styles. This app splits it into typed modules, CSS modules and a swappable data layer.

## Hard rules

1. **No hard-coded sample data outside `src/sample/`.** The sample data is fictional, for demo mode only. Every file in `src/sample/` starts with this comment:
   `// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.`
   Screens, store, domain and export code must **never** import from `src/sample/`. Only `src/data/createDataSource.ts` may import it, and only behind the flag.
2. **The data source is chosen once**, in `src/data/createDataSource.ts`, from `import.meta.env.VITE_DATA_SOURCE`: `api` (default) or `sample`. When `sample` is active, the app shows a "SAMPLE DATA" banner that can't be dismissed.
3. **The standard format is defined once**, in `src/schema/targetFormat.ts`: the Herrenknecht `BoreholeDataFormat.xlsx` field list (sections, field names, formats, units). Export and labels read from it. Don't repeat field names elsewhere.
4. **No challenge data anywhere.** Nothing from the organisers' dataset gets copied, quoted or used in fixtures.
5. Plain CSS modules (`*.module.css`) plus design tokens in `src/styles/tokens.css`. Inline `style` only for values computed at runtime (positions, colours that depend on state).

## Folder layout

```
frontend/
  index.html  vite.config.ts  tsconfig.json  package.json  .env.example  README.md  ARCHITECTURE.md
  src/
    main.tsx                 bootstraps <App/>, imports global CSS + leaflet CSS
    App.tsx                  shell: Header, banners, the active screen, overlays (SidePanel, CrsDialog), Toast
    styles/tokens.css        CSS variables: colours, fonts, shadows; global resets; @keyframes bpulse
    theme.ts                 TS mirror of the colours used in computed styles (COL, METHOD_COLORS, PAGE_TYPE_META, statusChip, pinColor)
    schema/targetFormat.ts   Herrenknecht standard format: sections + fields {name, format, unit, note}
    domain/
      types.ts               all domain types (below)
      keys.ts                value-key helpers (below)
      review.ts              pure review logic: boreholeStatus, cleanKeys, progress, completenessSummary
      spt.ts                 SPT helpers: sptLint, formatSpt
      format.ts              number formatting: decimalComma(v), metres(v)
      *.test.ts              vitest unit tests for the pure modules
    data/
      DataSource.ts          the DataSource interface
      createDataSource.ts    picks api | sample from VITE_DATA_SOURCE
      apiSource.ts           HTTP client to the FastAPI backend (/api/v1), see docs/design/api-contract.md
      adapters.ts            backend BoreholeRecord (snake_case) -> domain Borehole
    sample/                  DEMO ONLY (see rule 1)
      neckarbogen.ts         hand-made report "neckarbogen_BG_2019.pdf", borehole BK-07 (prototype LAY + initRecs + pageItems)
      generate.ts            deterministic generators (prototype PROJ, BHS, GEO, genBH, genPage, mulberry32)
      documents.ts           prototype DOCS0 + CRS candidates
      sampleSource.ts        DataSource implementation over the sample data (in-memory, simulated upload)
    store/appStore.ts        zustand store: all UI + data state and actions (API below)
    components/              shared: Header, Banner, Toast, MethodBadge, StatusChip, SourceIcon, ScanPage,
                             SidePanel (SourcePanel + CompletenessPanel), Popover, Toggle
    screens/
      map/MapScreen.tsx (+ .module.css)
      queue/QueueScreen.tsx
      review/ReviewScreen.tsx, review/FieldRow.tsx, review/CrsDialog.tsx
      detail/DetailScreen.tsx, detail/ProfileColumn.tsx, detail/ExportMenu.tsx
    export/
      standardXlsx.ts        target-format workbook (exceljs, dynamically imported)
      csv.ts                 tidy CSV + open-questions CSV
      download.ts            blob download helper
  e2e/                       Playwright smoke tests (sample mode)
```

## Domain model (`src/domain/types.ts`)

```ts
export type Screen = 'map' | 'queue' | 'review' | 'detail';
export type Method = 'Read' | 'OCR' | 'Derived' | 'Guessed' | 'Edited';
export type ReviewStatus = 'unreviewed' | 'approved' | 'flagged';
export type FieldState = 'ok' | 'not in source' | 'illegible';
export type BoreholeStatus = 'reviewed' | 'unreviewed' | 'attention';
export type CrsStatus = 'stated' | 'inferred' | 'confirmed' | 'unknown';
export type PageType = 'log' | 'lab_table' | 'text' | 'drawing' | 'photo' | 'unknown';
export type DocumentStep = 0 | 1 | 2 | 3;   // classifying, extracting, needs review, done

/** Box on a page, normalised 0–1, origin top-left (same as the API contract). */
export interface Box { x: number; y: number; w: number; h: number }
export interface Lint { severity: 'error' | 'warning'; message: string }

export interface Spt {
  raw: string; depth: number; refusal: boolean;
  increments?: number[]; n?: number; blows?: number; penetrationCm?: number;
}

/** One extracted value with provenance and review state. The detail screen reads displayed values from here. */
export interface ExtractedValue {
  key: string;            // see keys.ts, unique within a borehole
  field: string;          // target-format field name (schema) or an extension name
  label: string;          // UI label, e.g. "Final depth", "SPT @ 10.50 m"
  group: 'borehole' | 'groundwater' | 'layer';
  layer?: number;
  raw: string;            // as printed in the source
  value: string;          // normalised, as text
  unit: string;
  page: number | null;
  box: Box | null;
  method: Method;
  confidence: number;     // 0–1, only shown on hover
  status: ReviewStatus;
  state: FieldState;
  aiValue: string;        // original AI value, kept after an edit
  note?: string; formula?: string; lint?: Lint; flag?: string;
  kind?: 'crs' | 'lithology' | 'spt';
  din?: string; refusal?: boolean; spt?: Spt;
}

export type PatternId = 'topsoil'|'fill'|'clay'|'silt'|'gravel'|'sst'|'sand'|'lst'|'marl';
export interface Layer {
  n: number; from: number; to: number;
  lithology: string; lithologyAsPrinted: string; din: string;
  pattern: PatternId; fill: string; strat: string;   // stratigraphy code for the Strat. column (STRAT_COLORS)
  method: Method; confidence: number;
  spt?: Spt; tcr?: number; rqd?: number;
}
export type GroundwaterType = 'strike' | 'rest' | 'standpipe' | 'other';
export interface GroundwaterReading { type: GroundwaterType; depth: number; key: string }

export interface Borehole {
  uid: string;            // unique across documents, e.g. "nb:BK-07"
  id: string;             // BoreholeID as printed
  documentId: string | null;
  sourceFile: string;
  project: string;
  lat: number | null; lng: number | null;
  onMap: boolean; unplottedReason: string | null;
  finalDepth: number | null; // null = not stated; logBottom then only bounds the drawing
  logBottom: number;      // bottom of the last logged layer
  crs: { name: string | null; code: string | null; status: CrsStatus };
  layers: Layer[];
  groundwater: GroundwaterReading[];
  rockHead: number | null;
  values: ExtractedValue[];
  primaryPage: number;
}

export interface PageItem { kind: 'text' | 'line'; x: number; y: number; w?: number; h?: number; text?: string; fontSize?: number; fontWeight?: number; color?: string }
/** A rendered page. API pages have imageUrl. Sample pages are drawn from items in a 560x780 px space. */
export interface PageContent { documentId: string; page: number; type: PageType; usage: string; label: string; imageUrl?: string; items?: PageItem[] }

export interface LintFinding { severity: 'error' | 'warning'; boreholeId: string; message: string }
export interface DocumentSummary {
  id: string; name: string; project: string;
  pageTypes: PageType[];            // one per page; 'unknown' = not classified yet
  step: DocumentStep;
  counts: { boreholes: number; layers: number; spt: number; groundwater: number } | null;
  completeness: { listed: number; idPrefix: string; missing: string[]; unexpected: string[]; lint: LintFinding[] } | null;
  reviewBoreholeUid: string | null; // the borehole the Review screen opens for this document
  uploaded?: boolean;
  simulated?: boolean;              // sample mode upload, which shows "Simulated: live extraction needs an API key"
}
export interface CrsCandidate { name: string; code: string; note: string; verdict: 'match' | 'shifted' | 'out_of_range'; points: { uid: string; lat: number; lng: number }[] }
export type ValuePatch = Partial<Pick<ExtractedValue, 'value' | 'status' | 'state' | 'flag' | 'method'>>;
```

### Value keys (`src/domain/keys.ts`)

```ts
export const K = {
  boreholeId: 'BoreholeID', project: 'ProjectName', startDate: 'StartDate', method: 'DrillingMethod',
  finalDepth: 'BoreholeDepth', elevation: 'SurfaceElevation', xy: 'XY', crs: 'CoordinateSystem',
  rockHead: 'RockHead', notes: 'Notes', gwStrike: 'GW.strike', gwRest: 'GW.rest',
  gw: (i: number) => `GW[${i}]`,   // API groundwater readings, by index in the backend list
  bottom: (n: number) => `layer[${n}].bottom`, lithology: (n: number) => `layer[${n}].lithology`,
  spt: (n: number) => `layer[${n}].spt`, tcr: (n: number) => `layer[${n}].tcr`, rqd: (n: number) => `layer[${n}].rqd`,
} as const;
```

Prototype → key mapping:

| Prototype | Key |
|---|---|
| bhid | BoreholeID |
| proj | ProjectName |
| date | StartDate |
| meth | DrillingMethod |
| fd | BoreholeDepth |
| elev | SurfaceElevation |
| xy | XY |
| crs | CoordinateSystem |
| rock | RockHead |
| notes | Notes |
| gw1 / gwS | GW.strike |
| gw2 / gwR | GW.rest |
| d{n} | layer[n].bottom |
| l{n} | layer[n].lithology |
| s{n} | layer[n].spt |
| t6 | layer[6].tcr |
| q6 | layer[6].rqd |

## Review rules (`src/domain/review.ts`, unit-tested)

- `boreholeStatus(b)`:
  - `attention` if `crs.status === 'inferred'`, or any value is `flagged`, or any value has a `lint` while not `approved`.
  - otherwise `reviewed` if every value is `approved`.
  - otherwise `unreviewed`.
- `cleanKeys(b)` returns the keys of values with status `unreviewed`, method `Read`, no lint, no flag and state `ok`. "Approve all clean" approves exactly these.
- `progress(b)` returns `{ approved, total }`.
- Generated sample boreholes get statuses matching the prototype's base code: `r` = all approved, `a` = unreviewed plus one lint warning, `u`/`x` = unreviewed. All Neckarbogen boreholes have `crs.status: 'inferred'` until the CRS is confirmed.

## DataSource (`src/data/DataSource.ts`)

```ts
export interface DataSource {
  readonly kind: 'api' | 'sample';
  load(): Promise<{ boreholes: Borehole[]; documents: DocumentSummary[] }>;
  getPage(documentId: string, page: number): Promise<PageContent>;
  upload(files: File[], onUpdate: (doc: DocumentSummary) => void): Promise<void>;
  watch?(documentId: string, onUpdate: (doc: DocumentSummary) => void): void;   // follow a document still being extracted at load
  updateValue(uid: string, key: string, patch: ValuePatch): Promise<void>;      // may throw PartialSaveError {applied}
  crsCandidates(documentId: string): Promise<CrsCandidate[]>;
  confirmCrs(documentId: string, code: string): Promise<void>;
}
```

- **sampleSource:**
  - Resolves from in-memory data, so `getPage` is immediate.
  - `upload` simulates progress with timers: step 0 → 1 after 1.8 s → 2 after 5.2 s, as in the prototype, with `simulated: true`.
  - Unsupported file types are rejected before this point, in the store.
- **apiSource:**
  - Calls `/api/v1` as described in the API contract.
  - When an endpoint is missing, it throws a clear `Error('Backend endpoint not available: …')`, which the UI shows as an error state. It never falls back to sample data.

## Store (`src/store/appStore.ts`, zustand)

State:

```
source, loadState: 'loading' | 'ready' | 'error', loadError
screen, sampleBannerVisible (always true in sample mode), toast
boreholes, documents, pages (cache keyed `${docId}:${page}`)
selectedUid, selectedLayer                       // detail
reviewUid, focusKey, reviewPage, editing: {key, mode: 'edit'|'flag', text} | null, confirmCleanOpen
panel: {kind:'source', uid?, key?, documentId, page, box?: Box|null, pageOnly?: boolean} | {kind:'completeness', documentId} | null
crsDialogOpen, crsLoading, crsCandidates, crsPick
exportOpen, includeUnreviewed
query, searchMessage, dropError, dragActive
```

Actions:

```
init()  go(screen)  showToast(text)
openBorehole(uid)  selectLayer(n)
openReview(uid?)  focusValue(key, scrollList?)  setReviewPage(n)
startEdit(key, mode)  setEditText(t)  saveEdit()  cancelEdit()
toggleApprove(key)  toggleFlag(key)  setState(key, 'not in source' | 'illegible')   // setState toggles: same state again resets to ok + unreviewed
askClean()  approveClean()  cancelClean()
openSource(uid, key)  openPage(documentId, page)  openCompleteness(documentId)  closePanel()
openCrsDialog()  pickCrs(i)  confirmCrs()  closeCrsDialog()
toggleExport()  toggleIncludeUnreviewed()  exportFile(kind: 'xlsx' | 'csv' | 'questions')
setQuery(q)  search()   // flyTo is signalled via a mapFocus: {uid, zoom, nonce} state field the MapScreen subscribes to
addFiles(files)  setDragActive(b)
```

Selectors: `useBorehole(uid)`, `useValue(uid, key)`, `useDocument(id)`, `usePage(docId, page)`, which loads into the cache on demand.

Review edits are **optimistic**: update the store, then call `source.updateValue`. On failure, roll back and show a toast. Saves of one value are queued, so the source applies them in order; a failure rolls the value back to what the source holds, never over a newer successful save (see "As built: logic review fixes").

Escape closes, in order: editing → confirmClean → exportOpen → crsDialog → panel.

## Screens: behaviour reference

Each screen follows the prototype section (lines in `Bormisu App.dc.html`) and its logic in the prototype script (lines 514–747).

| Screen | Template lines | Notes |
|---|---|---|
| Header, banner, nav | 27–44 | Nav: MAP, UPLOAD & QUEUE (amber badge = documents at step 2), REVIEW. MAP is active on detail too. Search box with message popover |
| Map | 48–79 | Leaflet, grayscale OSM tiles. Pins by `boreholeStatus` (green / grey / amber), BK-07 radius 8. Popup with OPEN DETAIL. REVIEW STATUS legend with counts. NOT ON MAP aside. RESULTS table |
| Upload & queue | 81–123 | Page-type legend, drop zone (PDF / DOCX / JPG / PNG, else red error), doc cards: steps with pulse, completeness chip → Completeness panel, count chips, page strip (click → page in Source panel), hint |
| Review | 125–186 | Header: sheet tabs, progress bar, › BOREHOLE DETAIL, APPROVE ALL CLEAN (n) + confirm popover. Left: scan page 560×780 with value boxes (focus / flagged / lint / approved styles), caption. Right: sticky header, rows grouped BOREHOLE / GROUNDWATER / LAYER n. Field row: raw → normalised, lithology 3-line, state, AI value struck through, note, lint, flag, inline edit / flag input, more-actions on focus (CHOOSE CRS…, Not in source, Illegible, Larger source view), method badge, ✓ ✎ ⚑ |
| Detail | 188–301 | Sticky header: breadcrumb, id, status chip, reviewed text, › OPEN IN REVIEW (if reviewable), EXPORT ▾ menu with include-unreviewed toggle. Profile SVG 378×660 with DIN patterns, Strat. column, ticks, layers (click selects), not-logged hatch if logBottom < finalDepth, ET label, rock head line, selection rect, GW triangles (click → source), R marker (click → source). Metadata table with chips + source icon. Location mini map. Layers table. Groundwater table |
| Side panel | 303–339 | Source: title, label, method, raw, "Box not found: page shown", scaled page with highlighted box, OPEN IN REVIEW. Completeness: ID chips, legend, LINT list |
| CRS dialog | 341–355 | Candidates, Leaflet map with pins per candidate, dashed site circle, "out of range" overlay, CONFIRM FOR WHOLE DOCUMENT |
| Toast | 357 | 3.2 s |

## Export (`src/export/`)

- **Standard xlsx (`standardXlsx.ts`):** built from `schema/targetFormat.ts`.
  - Sheet `Metadata`: one row per borehole, columns = the 14 metadata fields in order.
  - Sheet `Logdata`: one row per layer, columns = `BoreholeID`, `DepthFrom`, `DepthTo`, then the 12 log-data fields.
  - Sheet `Test Results`: columns = `BoreholeID`, `SampleName`, `SampleDepth`, then the 19 test-result fields.
  - Row 1 holds the field names, row 2 the units.
  - Sheet `Provenance`: key, field, raw, value, unit, page, method, status, state.
  - With `includeUnreviewed`: a `DRAFT – NOT APPROVED` title row and the file name suffix `_DRAFT`.
  - Without it, unreviewed values are left blank. A blank never means 0.
- **CSV (`csv.ts`):** the tidy CSV and open-questions CSV, as in prototype `doExport`.
- Export runs client-side from domain data in **both** modes, so there is one code path.

## Scripts

- `npm run dev`: API mode.
- `npm run dev:sample`: sample mode.
- `npm run build`: `tsc -b && vite build`.
- `npm test`: vitest.
- `npm run e2e`: Playwright smoke tests against `dev:sample`, using system Chrome (`channel: 'chrome'`).

## As built: foundation notes for the screen agents

Additive to the spec above. Shared files (store, domain, data, sample, export, components, App) are done; screens only touch `src/screens/<their folder>/`.

- **Store extras** (`src/store/appStore.ts`):
  - `escape()` (App installs the Escape listener), `loadPage(docId, page)` (used by `usePage`).
  - `listScroll: {key, nonce} | null`: set by `focusValue(key, true)`; the Review list scrolls `key` into view when `nonce` changes. `mapFocus: {uid, zoom, nonce}`: set by `search()`; the map flies there and opens the popup.
  - `pages` values are `PageLoad = {status:'loading'} | {status:'ready', content} | {status:'error', error}`; `usePage()` returns a `PageLoad`.
  - Extra selectors: `useReviewBorehole()`, `useSelectedBorehole()`, `useIsReviewable(uid)` (a borehole with a document and located values; every sample borehole qualifies, so "› OPEN IN REVIEW" can show for all of them).
  - `openBorehole(uid)` selects the first SPT-refusal layer (BK-07 → layer 5, as in the prototype), else layer 1. `openReview(uid?)` focuses the CRS when inferred, else the first open lint (`initialFocusKey`).
  - `exportFile(kind)` exports every borehole of the selected borehole's document; file prefix = first token of the document name (`neckarbogen_…`).
- **Domain extras**: `review.ts` also has `isClean`, `initialFocusKey`, `editPatch`, `flagPatch`, `UNFLAG_PATCH`, `patchOf`, `applyValuePatch` (syncs `finalDepth`, layer `from/to`, `logBottom`, groundwater and rock head on edits), `confirmCrsOn` (also moves the borehole to the candidate's point). `spt.ts` has `refusalTitle(spt)` for the R badge tooltip. `format.ts` has `parseNumber`. `types.ts` exports `PAGE_W = 560`, `PAGE_H = 780`; `Completeness` is a named type with optional `expectedIds`; `DocumentSummary` has optional `error` (API status `failed`).
- **Schema extras**: `section(id)`, `multiField('X-Coordinate','Y-Coordinate')` (one value holding two fields, split on `' / '` by the export), `EXTRA_FIELDS` (`DepthFrom`, `DepthTo`, `DrillingMethod`, `RockHead`), `FieldDef.layerProp` (log fields filled from a layer property: StratigraphicName ← `strat`, Soil/Rockprofile ← `din`).
- **Theme extras**: `PATTERN_FILLS`, `STRAT_FALLBACK`, `PAGE_TYPE_LEGEND`, `pageUsage(type, page)`, and text tones in `COL` (`greenText`, `amberText`, `greenBg`, `amberBg`, …).
- **Components**: `ScanPage({content, boxes?, scale?})` with `ScanBox {id, box, variant: 'focus'|'flagged'|'lint'|'approved'|'idle'|'highlight', title?, onClick?}`; `MethodBadge({method, confidence?, formula?})` + `methodTitle()`; `StatusChip({status, size?: 'sm'|'md'})`; `SourceIcon({onClick, dim?})` (stops propagation); `Popover({width, top?, label, children})` (anchor to a `position: relative` parent); `Toggle({on, onToggle, label?, id?})`; `EmptyState({title, message?, tone?, action?})`; `SidePanel` / `SourcePanel` / `CompletenessPanel` / `PanelHeader` (done, rendered by App).
- **Sample data**: 48 boreholes in 7 projects (3 not on the map: BK-13 and BK-14 have no coordinates, SK-05 has an unknown CRS). Neckarbogen (`nb`) boreholes all have an inferred CRS; BK-07 is `nb:BK-07` on pages 7–8, the other Neckarbogen logs are on pages 9–20 (the document has 28 pages, 14 of them logs). Elbquerung (`eq`) logs are on pages 5–13. Other projects live in archive files (`documentId` = project slug, not in the queue). CRS candidates exist only for `nb`.
- **Not in sample data on purpose** (screens derive it): the CRS dialog's "site per report text" circle (use the centroid of the `match` candidate's points) and its intro sentence (use the X / Y value's `raw`, e.g. "R 3 513 420 · H 5 405 870", and the point count).

## As built: integration notes

Additive to the sections above.

- **Store:**
  - `setState(key, state)` toggles. The same state again resets the value to `ok` + `unreviewed` (`statePatch` in `review.ts`).
  - `editPatch` clears a "not in source" / "illegible" state whenever the saved text is non-empty.
  - `focusValue` drops an unsaved inline edit of another row, so only one row is ever in edit mode. `openCrsDialog` also clears it.
  - `crsLoading` is true while `openCrsDialog` waits for candidates. The store preselects the candidate the document currently uses and ignores answers for a dialog that was closed meanwhile.
  - `addFiles` gives an uploaded document its Review target (the first reviewable borehole of that document) once extraction reaches *needs review*, and keeps it on later status polls. API polls don't carry one.
- **Export scope:** `exportScope(all, b)` lives in `src/export/scope.ts`. Both `exportFile` and the export menu's count use it.
- **Standard xlsx:** the Metadata `BoreholeID` column falls back to the ID as printed, so approved-only exports have no anonymous rows. Logdata, Test Results and Provenance always carried the ID.
- **API patches:** `patchActions` sends `set_state` for any state change, including `ok`, which the contract allows.
- **Leaflet:** `src/components/leaflet.ts` has the one OSM tile layer (single host, attribution), a compact attribution for the small maps, and `removeMap(map)`, which every map uses on unmount. It ends a running zoom animation first, because Leaflet's 250 ms zoom-end timer otherwise reads the removed pane (`_leaflet_pos`).
- **Profile SVG** is `role="group"`, not `img`: an img's children are presentational, and its layers, GW triangles and R marker are buttons.
- **e2e** (`e2e/`): `fixtures.ts` stubs OSM tiles and fails any test with a console error. There is one spec per screen, plus the shell smoke test.

## As built: logic review fixes

Additive to the sections above. Each fix has a regression test that names the review finding (c1–c24).

- **Save queue (store `saveValue`):** saves of one value run one after the other. The store tracks what the source holds (`confirmed`). When the newest save of a value settles and any save in its chain failed, the value is set back to `confirmed`, so a late failure can't undo a newer successful edit. `PartialSaveError {applied}` (from `DataSource.ts`) means part of the patch was saved: that part is kept and only the rest rolls back. The API source throws it when, for example, an edit request succeeds and the approve request after it fails.
- **Document updates (store `documentUpdated`):** uploads and `watch` use the same handler. After extraction, the reload takes only that document's boreholes (others may have newer local edits) and its completeness checks. `init()` calls `source.watch` for documents that are still being classified or extracted. The API source polls each document at most once at a time. The sample source has no `watch`, so the prototype's extracting card stays as it is.
- **Navigation:** leaving Review (`go`, `openBorehole`, `search`) drops `editing` and `confirmCleanOpen`. `loadPage` tries a failed page again. A CRS confirmation answer closes only the dialog it came from. Search ignores queries without a letter or digit.
- **Domain:** `applyValuePatch` re-reads an edited SPT (`parseSptText`: N, refusal, layer SPT, increment lint). An empty final depth becomes `null` again. `confirmCrsOn` sets the CRS value's state to `ok` and puts a borehole with a candidate point on the map.
- **Export:** `exportId(b, o)` is the one BoreholeID on every sheet and CSV row: the reviewed value once exported, else the ID as printed. `DepthFrom` is the layer's own start depth. A layer that continues the one above takes that layer's reviewed bottom. An edited SPT exports its new N, or `blows/penetration` for a refusal.
- **API adapter:** `targets[key] = {paths, type}` replaces `paths[key]`. `type` decides how an edit is sent: numbers as numbers, IDs and dates as typed (leading zeros kept), SPT as N. X / Y has two paths (`local_x`/`local_y`, else `longitude`/`latitude`, easting first). Its provenance is combined from both, and an edit is split into one update per coordinate. Every groundwater reading is kept as `GW[i]`, and the legacy `water_table_m` keeps its own path. A missing final depth is `null`. Every backend lint finding lands on a review row: its own value, else the layer's bottom depth, the reading, X / Y, or the BoreholeID. `documentLint` fills the Completeness panel's LINT list.
- **Profile:** groundwater, rock head and the SPT refusal marker are drawn only while their value isn't "not in source" / "illegible" (`isStated`).
- **Map:** every RESULTS row and every NOT ON MAP item opens Detail, so a borehole without coordinates is never a dead end. The summary no longer says "in Germany". The first view is Germany unless a pin lies outside it; in that case it is the pins' bounds.
- Vitest also runs `*.test.tsx` (component tests render with `react-dom/server`).
