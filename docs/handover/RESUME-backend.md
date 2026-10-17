# Backend: where to resume (stopped 2026-10-17 evening for the user's usage reset)

## Branches and shas
| Branch | sha | What | Checked |
|---|---|---|---|
| `main` / `integration` | `5b6c37e` | contract 1.2.1 and the upload→pin fixes (2b1c0a9, merged as 7324039) | full suite green at 2b1c0a9 (1140 passed) |
| `feat/bh3-adapter` (worktree D:\Bormisu-backend, checked out) | `3ce1f5c` | bh3 adapter on top of main, **no auth** | ruff, mypy, `tests/test_bh3_adapter.py` 6 passed (fake bridge); full suite last green at `eb2a790` (1146 passed), **not re-run after 3ce1f5c** |
| `feat/bh3` (supervisor, worktree D:\Bormisu-bh3) | `66d302c` | bh3 vendored into `backend/app/bh3` (pypdfium2 port, bridge.py, numpy + opencv-python-headless) | ruff, mypy, 6 bh3 tests; its full suite was still running at commit time |
| `feat/d2-textlayer` (agent worktree) | `5d89829` (wip) | D2: text-layer pages skip OCR (OcrPage built from the text layer under an OcrRun with provider `textlayer`) | ruff, mypy; **not green**: new tests never run, ~11 existing tests that expect vector pages to be OCR'd still need `fictional_report(scanned=...)` (see below) |
| `feat/d6-crs` (agent worktree) | `6b6611e` (wip) | D6: System 34 (EPSG:10250/10160, west-orientated flag), NZGD2000/NZTM wordings, stated axis order by area of use (`Borehole.swap_axes`), 100 km outlier ceiling | ruff, mypy, 183 targeted tests passed; full suite not run |
| `feat/backend` | `179272c` | minimal auth (contract 1.3.0) + five extra fields + locate question + 2b1c0a9 merged in | full suite green (1215 passed) |

Order agreed with the supervisor: bh3 first, auth after. `feat/bh3-adapter` has no auth; `feat/backend` carries auth.

## Next steps (in order)
1. Merge `feat/bh3` at `a944bf0` (not 66d302c) into `feat/bh3-adapter` (the supervisor owns `backend/pyproject.toml` and `uv.lock` for that change; take theirs). `uv sync` the venv for numpy/opencv.
2. Merge `feat/d2-textlayer` and `feat/d6-crs` into `feat/bh3-adapter` (read each agent's commit note first; a "wip:" commit is not green). Resolve conflicts in `finalize.py` (D6 touches `_Builder.coordinates`), `ocr.py` (D2).
3. Run ruff, mypy, the full suite (alone: one pytest session per test database; agents used `geomemory_test_d2` / `geomemory_test_d6`). Then run `tests/test_bh3_adapter.py` against the REAL `app.bh3` too: the adapter must pick it up with `EXTRACTOR=bh3` (tests force `EXTRACTOR=classic` in `tests/conftest.py`).
4. Live check, approved by the user: **at most 1 USD for this session on OpenRouter, stop at about 0.90 USD**, Mistral direct off, OpenAI only for chat. Small excerpts first (AF01, an AUS01 excerpt) through `python -m app.eval` (`docs/eval/README.md`, `--max-usd`, a separate `geomemory_eval` database). Keep a running total from `provider_calls`. The supervisor's numbers: AUS01 and AF01 p1–2 come from the text layer with zero model calls; AF01 p3 goes to vision; two scanned pages cost about 0.017 USD with mistral-large-4-0.
5. Message the supervisor (bormisu-9f) "<sha> green" for `feat/bh3-adapter`; they merge it into integration, run AF01 live and push.
6. Then merge `feat/bh3-adapter` into `feat/backend` (auth) and map the five extra fields from bh3 there: `BoreholeName`, `ProjectID`, `BoreholeLength` from `metadata`/`_raw`, `soil_unit` (only when printed) → `engineering_soil_unit`, `geologic_age` (text model, so not as printed text).

## bh3 adapter (`backend/app/pipeline/bh3_adapter.py`)
- `EXTRACTOR=bh3|classic` (default bh3; classic when `app.bh3` does not import). `BH3_MODEL` (OpenRouter, default `mistralai/mistral-large-4-0`), `OPENAI_BH3_MODEL` (blank: `CHAT_MODEL`); the text normaliser runs on `CLASSIFIER_MODEL`.
- The extract stage reads the used log pages one per `bridge.read_pages` call (thread), so a page that raises or comes back `page_type == "unread"` goes to the classic extractor alone; `bridge.build(..., doc_id, llm)`; each bh3 Borehole becomes a `PageGroup` (`key` "bh3:<hash>") + `ExtractionResult` with cited blocks, finalised by `finalize_group` (CRS service and questions, lint, word boxes). Classic then runs only for groups none of whose pages is in a bh3 borehole.
- Mapping: depths are bh3 metres as "6.00" with unit m (tops above −0.5 m clamp to 0; an open top/bottom takes the neighbour's boundary); header strings from `metadata["_raw"]` (printed), else the coerced value; `din_main` → `din4023_code`, `din_code` → notation; SPT label "24 [2,3/4,6,6,8]" → N + blows; RQD/TCR/SCR → core runs; GWL → groundwater (strike/rest from the label); text-model output is never cited as printed (colour, consistency, class); a USCS group only when the description prints it; an unnamed hole is "unlabelled p<page>".
- Evidence: provenance points → normalised box using the page's long side (PDF: pdfium size; images: 842 pt); a row band spans the page width; zeros mean the page. Text-layer pages then get word boxes and method `read`.
- Cost: `on_call` writes `provider_calls` (`bh3:<purpose>`, OpenRouter `usage.cost`, OpenAI priced from `data/prices.yaml`); `guard` raises `bridge.BudgetExceeded` before a call that would pass `PROVIDER_BUDGET_USD`; the document then fails readably and classic does not work around it.
- Grouping (D4, classic path): a printed "borehole number" prefix is dropped ("BORING NO. T01" → T01; `data/page_roles.yaml` `label_prefixes`). In bh3 mode bh3's own grouping (name, sheet n of m, depth continuity, coordinates) applies.
- Untested: the adapter against the real bh3 package and any live run.

## Done today on main (2b1c0a9)
- 429s waited out (Retry-After, backoff, `RATE_LIMIT_WAIT_S`), deferred OCR rounds, OpenRouter OCR concurrency 1.
- Unread pages no longer fail a document: `Document.warnings`, retry of needs_review/done documents with unread pages (contract 1.2.1).
- Printed degrees without an axis order get a `crs_confirm` question; ties go to the reading on or near land (`data/land_110m.json`, Natural Earth, public domain).
- Text-only OCR pages also send the page image to the classic extractor.

## Frontend coordination
- The frontend builds the EN/DE review sheet itself (no backend change) and shows `Document.warnings` with RETRY once 1.2.1 is wired (it is on main).
- Auth e2e against `a42243d` passed on the frontend side; the frontend sign-in tolerates a health without `auth`.

## Agent branches: what is left
**D2 (`feat/d2-textlayer` 5d89829, wip).**
- Skip rule: `text_layer_quality >= OCR_TEXT_LAYER_MIN_QUALITY` (default 0.9 = `read_min_text_quality`), not handwritten, at least 40 characters, raster images under half the page.
- Still to do:
  - Run the new tests in `test_pipeline_classify_ocr.py`.
  - Update `test_pipeline_e2e.py`: `test_upload_to_map_and_review` call counts become (6, 0, 2) with `pages_seen` 0 and `read` provenance; the unread-page test and both rate-limit tests need `fictional_report(scanned=[3])`.
  - Give scanned reports to the 2 pipeline tests in `test_ocr_openrouter.py`, the 3 in `test_ocr_openai.py` and the one in `test_pipeline_openai_only.py`.
  - Update BACKEND.md 7.4.
  - Run the full suite.
- Known limit: text converted to outlines on a page with at least 40 real characters still skips OCR.

**D6 (`feat/d6-crs` 6b6611e, wip).**
- Done: System 34 via pyproj EPSG:10250/10160, with easting negated in `plotting.to_wgs84` for `west_orientated` entries; `named_systems` wording table in `data/crs_patterns.yaml`; HK80 aliases; stated system with swapped axes kept stated with `swap_axes`; `coordinates_far_from_cluster` gets `max_distance_km: 100` (beyond it, always an error and unplotted `implausible`).
- Open decisions:
  - Keep the existing 25 km floor for the cluster rule, or raise it to 100?
  - NZGD2000 alone resolves to NZTM only inside its area of use on or near land. Remove `national_grid` from the patterns if that is too loose.
- Limits:
  - System 34 uses pyproj's approximate transformation (the grid `dk_sdfi_s34s_2022.tif` is not installed).
  - `swap_axes` is not in the contract's BoreholeRecord.
- Still to do: run the full suite (with `test_spreadsheet.py`).

## To do (user, 2026-10-17): support Chinese and Indian reports
All of this is data in `backend/data/*.yaml` plus tests on fictional examples. No code branches per country, and no live test.

**Text normalisation**
- NFKC for full-width digits and punctuation (`１２．５`, `，`, `：`).
- Devanagari digits `०-९` → 0-9.
- Indian lakh/crore grouping `1,00,000` in `numbers.py` (data-driven grouping patterns).

**Units and labels**
- Chinese: 米, 厘米, 毫米, 千帕, 兆帕, 击, and column labels 深度/层底深度/层厚, 孔号, 孔深, 地下水位, 标贯击数.
- Hindi: मीटर, गहराई.
- Indian practice: kg/cm² and t/m² (already convertible).

**Lithology (DIN vocabulary)**
- Chinese: 砂/细砂/中砂/粗砂, 粉土, 粉质黏土/黏土, 砾石/卵石, 填土/杂填土, 淤泥, 泥岩, 砂岩, 灰岩, 花岗岩 …
- Hindi: रेत, बजरी, चिकनी मिट्टी, गाद, भराव मिट्टी …
- Indian Standard IS 1498 group symbols (CL/CI/CH, ML/MI/MH, SW/SP/SM/SC) in `uscs_group` with a mapping to DIN main components.

**Dates**
- 2026年3月4日 and Hindi month names.
- Indian reports are day-first by convention, but only when the document says so; otherwise ambiguous dates stay as printed.

**Sheets**
- 第2页 共3页, 第2/3页, and the Hindi पृष्ठ 2 / 3.

**Coordinate systems (registry and patterns)**
- China: CGCS2000 geographic (EPSG:4490) and its 3°/6° Gauss-Krüger zones; Beijing 1954 and Xian 1980 zones. Axis labels X坐标/Y坐标: in Chinese surveying X is the northing, so swap detection must expect it.
- India: Kalianpur 1975 / Everest zones (EPSG:24378–24383) and WGS 84 UTM 42N–46N.
- Height datums: 1985国家高程基准 (Yellow Sea) and mean sea level.

**Lab test aliases**
- 含水率, 液限, 塑限, 塑性指数, 单轴抗压强度, 黏聚力, 内摩擦角, 渗透系数, 压缩模量, 天然重度 …
- Hindi and Indian-English equivalents.

**Prompts and tests**
- Prompts: add Chinese and Hindi examples to the classifier and extractor role descriptions.
- Tests: fictional Chinese and Indian logs (generated PDFs need a CJK and a Devanagari font for the text layer; check that pdfium and Pillow handle them, or use image-only pages with fake OCR).

## Rules in force
- Live provider calls: the user approved **at most 1 USD for this session on OpenRouter** for the bh3 live check (stop at about 0.90 USD), through the supervisor and then directly on 2026-10-17. Tests never call providers. Mistral direct is off (its key returns 401); OpenAI only for chat.
- Ledger before this session's live check: about 0.29 USD (Mistral + OpenRouter). `.env` has `PROVIDER_BUDGET_USD=1.5` and `EVAL_MAX_USD=1`.
- `OPENAI_API_KEY` in `.env` is pasted twice; the user has to fix it.
- No PyMuPDF; packages only in the venv; no challenge data in git; no per-file knowledge (bh3's crs_overrides, doc_rules and per-file legends are dropped).
- One pytest session per test database at a time (parallel runs on one database collide).

## Auth (contract 1.3.0, on `feat/backend` only)
Minimal by the user's decision (hackathon):
- register / login / logout / me with a `gm_session` cookie; argon2;
- first account admin; 401 `not_authenticated` on every `/api/v1` route except health, register, login and logout;
- password 8..128;
- no rate limits, no Origin check, no password change in the browser, no session expiry;
- `python -m app.users` for accounts;
- `AUTH_ENABLED=false` opens everything.
The frontend's sign-in (auth/frontend) matches and its e2e passed. Merge it after bh3.
