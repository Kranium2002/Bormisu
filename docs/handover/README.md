# GeoMemory handover: start here

Two Claude Code sessions finish GeoMemory in parallel. Read this file first, then your own brief:

| Session | Brief | Owns |
|---|---|---|
| Backend | [BACKEND.md](BACKEND.md) | `backend/`, `db/`, `docker-compose.yml`, root `.env.example`, `Makefile`, root `README.md`, `.github/workflows/backend.yml`, `contracts/` (edits and `contracts/examples/`) |
| Frontend | [FRONTEND.md](FRONTEND.md) | `frontend/` (including `frontend/Dockerfile`, `frontend/Dockerfile.dockerignore` and `frontend/nginx.conf`), `.github/workflows/frontend.yml` |

Shared and read by both: [`contracts/openapi.yaml`](../../contracts/openapi.yaml), [`contracts/realtime-and-chat.md`](../../contracts/realtime-and-chat.md), [`contracts/CHANGELOG.md`](../../contracts/CHANGELOG.md), [`COORDINATION.md`](COORDINATION.md).

## 1. What we are building

GeoMemory turns borehole reports uploaded at runtime (PDF scans, vector PDFs, photos, DOCX, spreadsheets, in many languages, some handwritten) into a reviewed PostGIS database. Users explore it on an LGRB-style world map, check every value against its source page, answer small questions where the input is unclear, and ask a chat assistant that queries the database and drives the map.

The product plan with all decisions, the full data audit and the production design is the Claude Doc **GeoMemory — Build & Merge Verification Plan** (tabs "GeoMemory — Build & Merge Verification Plan" and "Live production"): https://claude.ai/code/artifact/dc3b9854-14f9-4060-96b1-811f087c050c. Where this handover and that doc differ, **this handover wins** (it is newer and specific to the code).

Background you may read when needed:
- `D:\Bormisu\GeoMemory_Product_and_Build_Plan.md` (untracked, main checkout only): the original product plan.
- `docs/design/` and `docs/personas/` (from `prada/design`): personas, UI features, build cut, brand, DIN cheatsheet, target format, LGRB reference screenshots.
- `D:\Bormisu\local\data-audit\` (git-ignored, real data): one audit per sample file with every borehole, coordinates as printed, traps and fixture pages. `summaries.json` is the machine-readable form.
- Sample files (real data, git-ignored): `D:\Bormisu\HKBoreholeChallenge_Data_BFH2026-20261016T175641Z-1-001\HKBoreholeChallenge_Data_BFH2026\`.

## 2. One-time setup (done, do not repeat)

The setup ran on Sat 17 Oct 2026 before either session started:
- `integration` was created from `origin/main` without upstream tracking, so a stray `git push` cannot reach `main`. It merges `origin/prada/design`, `origin/prada/frontend` and `origin/arav/dev` with `--no-ff`.
- The only conflict was `.gitignore` (add/add with `arav/dev`). The result keeps `main`'s file plus one appended block for challenge data and runtime folders. Runtime folders are anchored to the repo root (`/storage/`, `/local/`, `/uploads/` …) so they never hide source packages such as `backend/app/storage/`. `data/` and `cache/` are deliberately not ignored, because `backend/data/` holds the vocabularies.
- `contracts/` and `docs/handover/` were committed on `integration`.
- Worktrees: `D:\Bormisu-backend` on `feat/backend` and `D:\Bormisu-frontend` on `feat/frontend`, both from `integration`.
- `.env` (API keys, git-ignored) was copied into `D:\Bormisu-backend` only; the frontend needs no keys. It uses `MISTRAL_API_KEY`, `OPEN_ROUTER_KEY` (accepted as an alias of `OPENROUTER_API_KEY`) and `OPENAI_API_KEY`.

Start the backend session in `D:\Bormisu-backend` and the frontend session in `D:\Bormisu-frontend`.

Files outside git exist only in the main checkout, so use their absolute paths from a worktree: the sample data in `D:\Bormisu\HKBoreholeChallenge_Data_BFH2026-20261016T175641Z-1-001\HKBoreholeChallenge_Data_BFH2026\`, the data audit in `D:\Bormisu\local\data-audit\`, and the original plan `D:\Bormisu\GeoMemory_Product_and_Build_Plan.md`.

## 3. How the two sessions work together

1. **The contract is the interface.** Build against `contracts/openapi.yaml` and `contracts/realtime-and-chat.md`, not against the other session's code. If something is missing or wrong, do not work around it silently.
2. **Contract changes.** Only the backend session edits `contracts/`. Changes inside 1.x are additive and get a `CHANGELOG.md` entry in the same commit. The frontend session asks for changes by adding an entry under "Requests" in `COORDINATION.md` on its branch and merging that to `integration`.
3. **Seeing the other side.** Both worktrees share one repository, so each session can read the other's latest commits without pushing: `git log feat/backend`, `git show feat/backend:contracts/openapi.yaml`, `git diff integration feat/frontend`.
4. **Integration.** `integration` stays checked out in `D:\Bormisu`, which is the integration workspace. Never check it out in your own worktree; git refuses a branch that is checked out elsewhere. At the end of every milestone, with green tests and everything committed:
   ```bash
   git -C D:/Bormisu merge --no-ff feat/<you> -m "merge: feat/<you> M<n>"   # into integration
   git merge integration                                                  # back into your branch
   ```
   If git reports `index.lock`, the other session is merging; retry in a minute. If the first merge conflicts, resolve it inside `D:\Bormisu` and commit there: only shared files should conflict, and for `COORDINATION.md` keep both sides. Never edit files in `D:\Bormisu` otherwise. Never rewrite `integration` history, never force-push, never push to `origin` unless the user asks.
5. **Status.** At each milestone end, update your section in `COORDINATION.md` (done, next, blockers, contract requests) and commit it with your merge.
6. **Ports and URLs.** Compose serves the app at http://localhost:8080 (nginx: SPA and `/api` proxy). The API listens on 8000 inside the network and is published on http://localhost:8000 for development. The Vite dev server proxies `/api` to http://127.0.0.1:8000.

## 4. Deadline, milestones and cut line

From `docs/design/challenge-brief.md`: submission closes **Sun 18 Oct 2026, 11:30** (public GitHub repo plus slides). Half the score comes from an AI agent that builds the repo **from a fresh clone**; build failures cost points. The team plan is: feature freeze Sun 00:00, fresh-clone run on a second machine Sun 08:30, submit Sun 10:30.

Consequences for both sessions:
- `main`-quality at every merge: `docker compose up --build` must work from a fresh clone, with and without `.env`. Never leave `integration` broken overnight.
- Work in the priority order of your brief. When a milestone slips, cut from the bottom of your brief's cut list; never cut the build, demo mode, the upload-to-review-to-map flow, provenance boxes or the no-invented-values rules.
- After the freeze only bug fixes, tests, README and the fresh-clone rehearsal.

| Milestone | Target | Backend delivers | Frontend delivers | Integration check (both) |
|---|---|---|---|---|
| **M0 Contract stub** | Sat 10:00 | Compose with db, api, worker. Every P0 endpoint returns contract-valid responses from **fictional seed data** (`make seed`). `/api/health` reports `mode`. | App builds in Docker behind nginx, talks to the stub in API mode, contract mismatches fixed in adapters. | `docker compose up --build` then http://localhost:8080 shows the seeded boreholes on the map, detail and review work. |
| **M1 Vertical slice** | Sat 14:00 | Real pipeline on one clean vector PDF: upload → classify → OCR → extract → normalise → review PATCH → map. Page images and provenance boxes. | Upload, queue progress (SSE with polling fallback), review with boxes, detail, map from live data. | Upload a sample vector log; its boreholes appear, values open their source box, an edit persists after reload. |
| **M2 Breadth** | Sat 20:00 | Scans, handwriting double reads, DOCX via Gotenberg, spreadsheets, CRS candidates and confirmation, clarifications, duplicates, retry. | Clarification inbox and form dialog, CRS dialog on real candidates, world map with clustering, filters, area selection, place search, unplotted list. | A mixed batch of at least 5 different sample files processes; questions appear in the inbox; answering a CRS question places a whole file on the map. |
| **M3 Chat and polish** | Sun 00:00 | `/chat` tool loop with result sets, citations, scope, UI commands; events stream complete; eval report. | Chat drawer, command dispatcher, citation chips, map animations with reduced-motion support, responsive layout, e2e on compose. | The end-to-end acceptance list in section 6 passes on a fresh clone. |

## 5. Rules for both sessions

- **No overfitting.** No code path may depend on a file name, a project name, a borehole label, a page number, a country or a layout of one sample document. Vocabularies (DIN codes, unit aliases, CRS candidates, page-role keywords) live in data files, not in branches of code. Every parser and normaliser is tested on inputs from at least three different document families. Sample files are for evaluation, never for special cases.
- **No invented values.** Unknown is `null` with a reason. No default lithology, CRS, depth, confidence or engineering interpretation. Never use `0` or `(0, 0)` as a placeholder.
- **Empty start.** The database starts empty and the map shows uploaded boreholes only. `make seed` loads clearly fictional data on request for development; nothing seeds itself on start. The frontend's sample mode stays a dev and test tool and never ships in the Docker build.
- **Shared examples.** `contracts/examples/*.json` holds fictional payloads for every main schema. The backend's contract tests validate them; the frontend's adapter tests load them. A rename then fails both suites.
- **Product name.** The repository, the design system and today's UI say "Bormisu"; "GeoMemory" is the plan's working title. Keep "Bormisu" in the UI, read from one config constant so the user can change it in one place.
- **Secrets.** Provider keys are read only by the backend from the environment. They never reach the browser, logs, test snapshots or git. The frontend has no keys at all.
- **Key usage.** The user's OpenRouter, Mistral and OpenAI keys are only for running GeoMemory's own pipeline and chat (including the evaluation run in BACKEND.md section 11). Never use them for coding help or other agent work. Unit and integration tests mock every provider.
- **Data.** No challenge data in git: not the sample files, not values copied from them, not screenshots of them. Repository fixtures are fictional and say so in their first line.
- **Quality bar.** Typed code, linted, formatted, tested. `docker compose up --build` works from a fresh clone with only `.env` added. Every visible control works or is disabled with a reason. Report real test results; never present a mock as connected.

## 6. End-to-end acceptance (the project is done when all pass on a fresh clone)

- [ ] `docker compose up --build` starts db, api, worker, gotenberg and web; http://localhost:8080 loads; `/api/health` says `live` with keys and `demo` without.
- [ ] Uploading a 100-page mixed report shows thumbnails within seconds; only pages classified as borehole data are OCRed; the queue shows live progress.
- [ ] Boreholes from a vector log, a scanned log and a handwritten log all reach Review with page boxes for their values.
- [ ] Editing, approving, flagging and resetting a value persists across reload and shows in Detail, map and chat answers.
- [ ] A file whose coordinates have no stated system produces one CRS question; answering it plots every borehole of that file.
- [ ] Boreholes without coordinates are listed under the map with their reason, never placed at 0,0.
- [ ] The map works for the whole world, clusters pins, colours by review status (depth classes as a toggle), selects by rectangle or polygon, and searches any town (zero results still fly there and outline the area).
- [ ] Chat: "How many boreholes deeper than 10 m are in Auckland?" answers with a SQL count, the map animates to the set, citations open the right page and box, and the answer states its scope. "Wie viele …?" answers in German.
- [ ] Killing the worker mid-document and restarting it resumes without duplicate boreholes or repeated OCR charges.
- [ ] Unit, contract, integration and e2e test suites pass; the eval report from BACKEND.md section 11 is committed under `docs/eval/` without challenge data values.
