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

**First run without any keys** (what a fresh clone gives you): `docker compose up --build`, open http://localhost:8080, then `make seed` for fictional demo boreholes on the map. Every screen works; uploads answer "demo mode" until a provider key is set in `.env` (`OPENROUTER_API_KEY` is all it needs; any one of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY` gives live mode), after which a dropped PDF, image, Word file or spreadsheet is processed live.

### Demo mode and live mode

| Mode | When | What works |
|---|---|---|
| `demo` | None of `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY` is set | Everything except processing new uploads: `POST /documents` answers `409 demo_mode`. Review, map, clarifications and place search work on existing (for example seeded) data. |
| `live` | Any one of `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` or `OPENAI_API_KEY` is set | Uploads are processed in the background. |

`GET /api/health` reports the mode and which providers are configured. Keys are read only by the backend from the environment; they never reach the browser, logs or git. The chat assistant needs `OPENAI_API_KEY`.

Which provider does what: every document model call goes to **Gemini 3.5 Flash on OpenRouter** (`OPENROUTER_API_KEY`, model id `google/gemini-3.5-flash`): the page classifier, the extractor, bh3's page reading (classify, header, tiles), second reads, spreadsheet mapping and OCR of scanned pages (Gemini reads the page render and returns its text with boxes, so evidence boxes work on scans). The chat assistant runs on OpenAI (`OPENAI_API_KEY`). OpenAI, then Mistral, are only fallbacks (`LLM_PROVIDER`, `OCR_PROVIDER`); in `auto` mode a refused key (401/403) moves on to the next configured provider. Gemini 3.5 Flash cannot run with reasoning off, so it gets reasoning effort "low" with room for it in the answer (`backend/data/reasoning.yaml`; any model that answers "Reasoning is mandatory" is retried the same way). Log pages are read by bh3 (`EXTRACTOR=bh3`: the page as a picture, depths anchored to the depth scale; vector pages from their text layer), with the OCR-text extractor as the fallback.

| Call | Default model (provider) | Fallbacks in `auto` |
|---|---|---|
| Page classifier, extractor, second reads, sheet mapping | Gemini 3.5 Flash (OpenRouter) | OpenAI, then Mistral |
| bh3 page reading (classify, header, tiles) | Gemini 3.5 Flash (OpenRouter) | OpenAI, then Mistral |
| OCR of scanned log pages | Gemini 3.5 Flash reading the page render, text with boxes (`openrouter_vision`) | Mistral OCR, Mistral OCR via the OpenRouter file parser, OpenAI |
| Chat assistant | OpenAI (`CHAT_MODEL`) | none |
| Narrative search embeddings | `EMBEDDING_MODEL` (OpenRouter) | none |

## How it works

```
 browser ──▶ web (nginx: SPA + /api proxy) ──▶ api (FastAPI) ──▶ db (PostgreSQL 16 + PostGIS + pgvector)
                                                  │  ▲                  ▲
                                   SSE events ◀───┘  │ LISTEN/NOTIFY    │ jobs (Procrastinate)
                                                     │                  │
                                                  worker ───────────────┘
                                                     ├─▶ gotenberg (Word → PDF)
                                                     ├─▶ page classifier (Gemini 3.5 Flash on OpenRouter)
                                                     ├─▶ bh3 page reader: text layer for vector pages (no model),
                                                     │   vision model + depth-scale anchoring for scans (Gemini)
                                                     ├─▶ OCR of scanned log pages: Gemini reads the render, text
                                                     │   with boxes (classic extractor path; Mistral fallback)
                                                     ├─▶ chat assistant (OpenAI)
                                                     └─▶ Python normalisation, coordinate systems and checks
```

1. **Upload.** The file is checked by its content (not its name), stored under its SHA-256, and queued. The same bytes uploaded twice return the existing document.
2. **Triage and classification.** Pages are rendered once. A cheap model labels every page (log sheet, continuation, summary table, narrative, photo …).
3. **OCR only where it matters.** Only scanned pages with borehole data go to OCR: Gemini 3.5 Flash reads the page render and returns every line and table cell with its box (Mistral OCR is the optional fallback).
4. **Extraction.** A stronger model returns the raw text of every value and the OCR blocks it came from. It never returns normalised numbers.
5. **Normalisation and checks (Python only).** Numbers, units, SPT, coordinates and coordinate systems, DIN 4023 lithology codes and depth datums are normalised in Python. Lint rules flag gaps, overlaps, RQD above 100, positions far from the rest of a document and similar problems. Anything uncertain becomes a clarification question: the coordinate system, unclear readings, units, datum conventions, borehole boundaries and duplicates.
6. **Second reads.** Handwritten and low-confidence values are cropped and read again. When the two readings disagree, both are kept and a person chooses.
7. **Review.** Every value carries its provenance: page, box (tightened to the printed words when the page has a text layer), raw text, method, confidence and review status. Edits, approvals and flags are revisions, and every change is streamed to the UI as an event.
8. **Chat.** The assistant answers with SQL-backed tools (place search, borehole search, statistics, evidence) and drives the map through result sets. Every number comes from a tool, and every answer states its scope.

Spreadsheets (`.xlsx`, `.csv`) skip the page steps. The model proposes a column mapping from the headers and a few sample rows, and Python applies it to every row, citing the source cell.

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
| `OPENROUTER_API_KEY` | — | Default for every document model call (Gemini 3.5 Flash): OCR, page classifier, extractor, bh3 page reading, second reads (alias `OPEN_ROUTER_KEY`) |
| `OPENAI_API_KEY` | — | Chat assistant; fallback for the other calls |
| `MISTRAL_API_KEY` | — | Optional last fallback (OCR with boxes, the models) |
| `CLASSIFIER_MODEL` / `EXTRACTOR_MODEL` / `BH3_MODEL` / `OPENROUTER_OCR_MODEL` | `google/gemini-3.5-flash` | OpenRouter model ids |
| `LLM_PROVIDER` / `OCR_PROVIDER` | `auto` / `auto` | Models: openrouter → openai → mistral; OCR: openrouter_vision → mistral → openrouter (file parser) → openai. Force one by name |
| `EXTRACTOR` | `bh3` | `bh3` (page reader with depth-scale anchoring, classic per-page fallback) or `classic` (OCR text extractor) |
| `PROVIDER_BUDGET_USD` | — | Stops processing before this total provider spend (every call is in a cost ledger) |
| `REQUEST_TIMEOUT_S` / `RATE_LIMIT_WAIT_S` | `120` / `600` | Per-request timeout; how long rate limits (429) are waited out before a page is deferred |
| `MAX_UPLOAD_MB` | `200` | Upload limit (reported in `/api/health`) |
| `WEB_PORT` / `API_PORT` / `DB_PORT` | `8080` / `8000` / `5432` | Published host ports |

## Data rule

No challenge or customer data is committed: no sample files, no values copied from them, no screenshots of them. Fixtures and seed data are fictional and say so, and CI fails if a PDF, spreadsheet, Word file or scan image is committed outside `docs/` and `assets/`.

## Evaluation

`make eval` runs the real pipeline on sample files you point it at (`EVAL_DATA_DIR`, `EVAL_EXPECTED`). It can process page excerpts (`--pages NAME=3-6`), stops before the `--max-usd` cost cap, and writes metrics and failure categories only to `docs/eval/report.md`, never values from the files. See [`docs/eval/README.md`](docs/eval/README.md).

## Credits

The page reader in `backend/app/bh3/` is Felix's bh3 pipeline (branch `felix-backend`, compared in [`MAIN_VS_BH3.md`](MAIN_VS_BH3.md)), ported to pypdfium2 and stripped of per-file rules; the backend calls it through `app/bh3/bridge.py` and falls back to the classic extractor per page.

## Known limits

- **Evidence boxes on scans:** pages with a text layer get word-level boxes. On scanned pages a value points at its row band or the whole page (the review screens say "no box on this page"); precise boxes on scans need the grounding pass, which is not enabled yet.
- **Local site grids:** coordinates on a project's own grid (for example "Oslo lokal") cannot be converted to a map position automatically; such boreholes stay in "Not on map" with a question.
- **Large documents:** every provider request has a timeout and rate limits are waited out, but there is no client-side pacing yet, so a very large upload on a low provider tier can take long.
- **Handwriting:** fully handwritten logs are read, but recall is lower; check them in review.
- **Sign-in:** the sign-in screen exists but the server-side login is not enabled in this version.
- **Conflicting values:** a value printed differently in a summary table and in a log is only asked about once the extractor reports both readings; the question type and its answer handling are in place.
- **Chat units:** the chat tools return metres; feet are converted in the answer text.
- **ARM machines:** `postgis/postgis` publishes amd64 images only, so on ARM the database runs under emulation.
