# Bormisu (GeoMemory)

Bormisu turns borehole reports uploaded at runtime (PDF scans, vector PDFs, photos, Word files and spreadsheets, in any language, some handwritten) into a reviewed PostGIS database.
You explore the boreholes on a world map, check every value against the box on its source page, answer small questions where the input is unclear, and ask a chat assistant that queries the database and drives the map.
The database starts empty. The map shows only boreholes from files you upload; nothing is preloaded or scraped.

## Quick start

```bash
cp .env.example .env          # optional: add provider keys for live mode
docker compose up --build     # db, migrate, api, worker, gotenberg, web
```

Open http://localhost:8080. The API is at http://localhost:8000 (docs at `/api/docs`, health at `/api/health`).

To try the app without uploading anything, load clearly fictional demo data and remove it again later:

```bash
make seed      # docker compose exec api python -m app.seed
make unseed    # docker compose exec api python -m app.seed --remove
```

Requirements: Docker with Compose 2.24 or newer. Nothing else is installed on the host.

### Demo mode and live mode

| Mode | When | What works |
|---|---|---|
| `demo` | `OPENROUTER_API_KEY` or the OCR provider (`MISTRAL_API_KEY`, or OpenRouter as fallback) is missing | Everything except processing new uploads: `POST /documents` answers `409 demo_mode`. Review, map, clarifications and place search work on existing (for example seeded) data. |
| `live` | Both keys are set | Uploads are processed in the background. |

`GET /api/health` reports the mode and which providers are configured. Keys are read only by the backend from the environment; they never reach the browser, logs or git. The chat assistant also needs `OPENAI_API_KEY`.

## How it works

```
 browser ──▶ web (nginx: SPA + /api proxy) ──▶ api (FastAPI) ──▶ db (PostgreSQL 16 + PostGIS + pgvector)
                                                  │  ▲                  ▲
                                   SSE events ◀───┘  │ LISTEN/NOTIFY    │ jobs (Procrastinate)
                                                     │                  │
                                                  worker ───────────────┘
                                                     ├─▶ gotenberg (Word → PDF)
                                                     ├─▶ page classifier (OpenRouter, cheap model)
                                                     ├─▶ Mistral OCR (only pages that carry borehole data)
                                                     └─▶ extractor (OpenRouter) → Python normalisation and checks
```

1. **Upload.** The file is checked by its content (not its name), stored under its SHA-256, and queued. The same bytes uploaded twice return the existing document.
2. **Triage and classification.** Pages are rendered once. A cheap model labels every page (log sheet, continuation, summary table, narrative, photo …).
3. **OCR only where it matters.** Only pages with borehole data go to Mistral OCR, which returns text with boxes and confidence.
4. **Extraction.** A stronger model returns the raw text of every value and the OCR blocks it came from. It never returns normalised numbers.
5. **Normalisation and checks (Python only).** Numbers, units, SPT, coordinates and coordinate systems, DIN 4023 lithology codes and depth datums are normalised in Python. Lint rules flag gaps, overlaps, RQD above 100 and similar problems. Anything uncertain becomes a clarification question.
6. **Review.** Every value carries its provenance: page, box, raw text, method, confidence and review status. Edits, approvals and flags are revisions, and every change is streamed to the UI as an event.

Rules the code follows:
- **No invented values.** Unknown is `null` with a reason. There are no default lithologies, coordinate systems or depths, and never a `0` or `(0, 0)` placeholder.
- **No guessed positions.** A borehole is placed on the map only with a stated or confirmed coordinate system. Otherwise it appears in the "Not on map" list with its reason.
- **Vocabularies are data.** Page roles, CRS candidates, units, DIN terms and lint thresholds live in `backend/data/*.yaml`. No code path depends on a sample file, project or layout.
- **Counts come from SQL.** The chat assistant answers with tools that run typed SQL. The model never writes SQL.

The HTTP and streaming interface is specified in [`contracts/openapi.yaml`](contracts/openapi.yaml) and [`contracts/realtime-and-chat.md`](contracts/realtime-and-chat.md). Fictional example payloads for every schema are in [`contracts/examples/`](contracts/examples/).

## Repository

| Path | What |
|---|---|
| `backend/` | FastAPI app (`app/`), Alembic migrations, vocabularies (`data/`), tests |
| `frontend/` | React + Vite + Leaflet app |
| `contracts/` | API contract shared by backend and frontend, with examples |
| `db/` | PostgreSQL image (PostGIS + pgvector) |
| `assets/din4023_patterns/` | DIN 4023 codes, colours and hatch patterns |
| `docs/` | Design notes, personas, handover briefs |

## Tests and checks

```bash
make test           # backend unit, API, service, migration and contract tests in Docker (PostGIS included)
make contract-test  # only the contract tests
make lint           # ruff + mypy
```

Tests never call a paid provider; provider clients are mocked. On the host (with uv): `cd backend && uv sync && uv run pytest`, with a PostGIS database at `TEST_DATABASE_URL` (default `postgresql+asyncpg://geomemory:geomemory@localhost:5432/geomemory_test`, created automatically).

## Configuration

Every setting is an environment variable, documented in [`.env.example`](.env.example). The most important ones:

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Page classifier and extractor (alias `OPEN_ROUTER_KEY`) |
| `MISTRAL_API_KEY` | — | Mistral OCR on the important pages |
| `OPENAI_API_KEY` | — | Chat assistant |
| `MAX_UPLOAD_MB` | `200` | Upload limit (reported in `/api/health`) |
| `WEB_PORT` / `API_PORT` / `DB_PORT` | `8080` / `8000` / `5432` | Published host ports |

## Data rule

No challenge or customer data is committed: no sample files, no values copied from them, no screenshots of them. Fixtures and seed data are fictional and say so, and CI fails if a PDF, spreadsheet, Word file or scan image is committed outside `docs/` and `assets/`.

## Known limits

- The processing pipeline, CRS ranking against geocoded places and the chat assistant are being completed. See `docs/handover/COORDINATION.md` for the current milestone.
- `postgis/postgis` publishes amd64 images only. On ARM machines the database runs under emulation.
