# Bormisu frontend

Bormisu turns messy geotechnical reports into reviewed borehole data for Herrenknecht. This is its web app:

- **Upload & queue:** drop PDFs, DOCX files or images. Watch each document go from *classifying* to *extracting* to *needs review*, with a page map and a completeness check (boreholes the report names but no log was found for).
- **Review:** every extracted value sits next to the scanned page with its box highlighted, shown as printed and as normalised, with its method (Read, OCR, Derived, Guessed, Edited). You can approve, edit (the AI value stays visible, struck through), flag, mark "not in source" or "illegible", approve all clean values at once, and confirm the coordinate system once for the whole report on a map preview.
- **Map:** boreholes coloured by review status, on a map of Germany (everything else is masked out; see [Map focus](#map-focus)). Boreholes without usable coordinates, or outside Germany, are listed under *Not on map* instead of being guessed onto it. Search by borehole ID or project.
- **Borehole detail:** the DIN 4023 profile (soil patterns, stratigraphy, groundwater, SPT refusals, rock head, the part of the hole that wasn't logged), metadata with provenance, layers, groundwater, a location map, and exports.

React 19 + TypeScript + Vite, zustand for state, Leaflet for maps, exceljs for the xlsx export.

| Map | Review | Borehole detail |
|---|---|---|
| ![Map](docs/screenshots/map.png) | ![Review](docs/screenshots/review.png) | ![Detail](docs/screenshots/detail.png) |

*Screenshots use the fictional sample data (`npm run dev:sample`).*

## Quick start

```bash
npm install
npm run dev:sample   # demo mode: fictional sample data, no backend needed → http://localhost:5173
```

With the backend (FastAPI, see `docs/design/api-contract.md`):

```bash
npm run dev          # API mode: proxies /api to http://127.0.0.1:8000
VITE_API_PROXY=http://127.0.0.1:9000 npm run dev   # backend on another port
```

In API mode the app never falls back to sample data. Without a backend it shows *NO DATA: Cannot reach the Bormisu backend at /api/v1…* with a RETRY button. If an endpoint is missing it shows *Backend endpoint not available: GET /api/v1/…*.

## Data source flag

The data source is chosen once, in `src/data/createDataSource.ts`, from `VITE_DATA_SOURCE`:

| Value | Where data comes from | How to get it |
|---|---|---|
| `api` (default) | the FastAPI backend under `VITE_API_BASE` (default `/api/v1`) | `npm run dev`, `npm run build` |
| `sample` | fictional demo data in `src/sample/`, in memory; uploads are simulated | `npm run dev:sample` (loads `.env.sample`) |

Sample mode shows a *DEMO* banner that can't be dismissed. The sample data is made up: no file in this repo comes from the challenge dataset. Only `createDataSource.ts` imports `src/sample/`, lazily and behind the flag, so an API build contains no sample data at all. See [.env.example](.env.example) for the variables. The frontend holds no API keys.

## Map focus

The Map screen's map is restricted to one region, set once from `VITE_MAP_FOCUS` (`src/geo/mapFocus.ts`):

| Value | Map screen |
|---|---|
| `DE` (default) | Opens on Germany and can't pan or zoom out beyond it. Everything outside Germany is masked in the map background colour, with a thin dark-green border. Boreholes outside Germany are listed under *Not on map* as *Outside map focus (Germany)*, and searching for one shows that message instead of flying there. |
| `world` | No restriction: the whole world, every borehole with coordinates is plotted. |

Any other value counts as `DE`. `.env.sample` sets `DE` explicitly; to try the other mode, run `VITE_MAP_FOCUS=world npm run dev:sample` (a variable from the shell wins over the env files). The CRS dialog and the detail mini-map are never restricted. The RESULTS table always lists every borehole.

The Germany outline (`src/geo/germany.ts`) comes from [Natural Earth](https://www.naturalearthdata.com/) 1:50m admin-0 countries, public domain, coordinates rounded to 4 decimals. A point within 2 km outside the outline still counts as inside, because the 1:50m outline is generalised by up to about a kilometre (a borehole on the German bank of the Rhine must not drop off the map).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server, API mode |
| `npm run dev:sample` | Vite dev server, sample mode |
| `npm run build` | Type check (`tsc -b`, including the e2e tests) and production build to `dist/` |
| `npm run preview` | Serves the production build |
| `npm test` | Vitest unit tests |
| `npm run e2e` | Playwright smoke tests in sample mode, with the system Chrome |

## Folder overview

```
src/
  App.tsx              shell: header, demo banner, active screen, side panel, CRS dialog, toast
  schema/              the Herrenknecht standard format, defined once (targetFormat.ts)
  domain/              types, value keys, pure review / SPT / number-format logic
  data/                DataSource interface, API client + adapters, the api|sample switch
  sample/              DEMO ONLY fictional data (sample mode)
  store/               zustand store: all state and actions (optimistic review edits)
  components/          shared UI: header, panels, scan page, chips, badges, Leaflet helpers
  screens/             map/, queue/, review/, detail/: one folder per screen
  export/              standard xlsx, tidy CSV, open-questions CSV
  geo/                 map focus setting, Germany outline (Natural Earth), point-in-polygon
  styles/tokens.css    design tokens (colours, fonts) and global styles
e2e/                   Playwright smoke tests
```

[ARCHITECTURE.md](ARCHITECTURE.md) is the binding spec: domain types, value keys, the DataSource interface, the store API and the hard rules. Read it before changing code.

## Export and the Herrenknecht standard format

Exports run in the browser from the reviewed data, so API and sample mode share one code path. Open a borehole and use **EXPORT ▾**. An export covers every borehole of that borehole's report.

**Project xlsx (target format)** follows `BoreholeDataFormat.xlsx`. Field names, order, formats and units come from `src/schema/targetFormat.ts` and nowhere else.

| Sheet | One row per | Columns |
|---|---|---|
| `Metadata` | borehole | the 14 metadata fields (BoreholeID … Notes) |
| `Logdata` | layer | `BoreholeID`, `DepthFrom`, `DepthTo`, then the 12 log-data fields |
| `Test Results` | sample | `BoreholeID`, `SampleName`, `SampleDepth`, then the 19 test-result fields (header only for now) |
| `Provenance` | exported value | `BoreholeID`, key, field, raw (as printed), value, unit, page, method, status, state |

- Row 1 holds the template field names and row 2 the units, so the sheets line up with the template.
- **Approved values only, by default.** Unreviewed values are left blank, and a blank never means 0. The BoreholeID column always carries the ID, so every row can be joined across sheets.
- **Include unreviewed values** exports everything, adds a `DRAFT – NOT APPROVED` title row above the header, and adds `_DRAFT` to the file name.
- **Mapping details:**
  - Numeric fields are written as numbers.
  - "Not in source" and "illegible" values are blank.
  - The single X / Y value is split into `X-Coordinate` and `Y-Coordinate`.
  - An SPT refusal keeps its raw text (e.g. `50/30`, never N = 50), and a regular SPT is written as its N.
  - Groundwater goes to the layer row that contains its depth.
  - `StratigraphicName` and `Soil/Rockprofile` come from the layer's stratigraphy code and DIN 4023 code.

**Tidy CSV:** one row per value (borehole, field, layer, raw, value, unit, page, method, status, state), UTF-8 with a BOM so Excel reads umlauts.

**Open questions (CSV):** the list of questions for the client: boreholes the report names but no log was found for, coordinate system not stated (or unknown), lint findings, flags and illegible values.

## Testing

```bash
npm test         # unit tests: domain rules, schema, API adapters + error handling, sample data,
                 # store flows (approve all clean, edit vs flag, states, CRS confirmation, search,
                 # uploads, export scope), xlsx/CSV builders, screen view models
npm run e2e      # Playwright, sample mode, system Chrome (channel: 'chrome'); PORT sets the port (default 5174)
```

The e2e suite starts `npm run dev:sample` itself and stops it afterwards. Map tiles are stubbed, so it runs offline, and every test fails on any console error. It covers:

- **Map:** pins, legend counts, the *Not on map* list, a results row and a pin popup opening the detail, and search ("EQ-03" flies to the pin; "BK-13" explains why it isn't on the map).
- **Map focus (DE):** the Germany mask and border sit between the tiles and the pins; neither the zoom-out button nor the wheel zooms out beyond Germany; all 45 sample pins are drawn and on top. A test moves one sample project to Brussels (by patching the sample module in the browser, not the repo): its boreholes leave the map for *Not on map*, the counts add up, and searching for one explains why. `VITE_MAP_FOCUS=world npm run e2e` runs the suite in world mode, where the DE tests are skipped and a world test checks the old behaviour.
- **Detail:** the profile; the R marker opens the source panel with the highlighted box; the tidy CSV downloads; the standard xlsx downloads, and its sheets and row-1 field names are checked with exceljs.
- **Queue:** three documents; the completeness panel lists BK-12 as missing; a `.txt` upload shows the red error; a `.pdf` upload adds a simulated document that goes through the steps.
- **Review:** approve all clean updates the progress; an edit keeps the AI value struck through; flag and un-flag; state buttons toggle; confirming the CRS turns the Neckarbogen pins from amber.
