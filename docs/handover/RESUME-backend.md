# Backend: where to resume (paused 2026-10-17 09:10 at the user's request)

## State
- `feat/backend` is merged into `integration` (ad53ef9) and `integration` back into `feat/backend` (M0 to M3, 1,068 tests passing before the WIP commit below).
- The last commit, **"wip: contract 1.2.0 (partial, not verified)"**, holds the half-finished answers to the frontend's open requests in `COORDINATION.md`. It was stopped mid-run: tests have not been run on it, so it is not merged into `integration`.
  - **Contract side:** `Document.failed_stage` (migration 0005), `GET /events?last_event_id=`, `document_id` and `borehole_uids` on `clarification.resolved`, and descriptions of the CRS `verdict` and of `rock_head_m: null`. Changes are in `contracts/*` and `contracts/examples/*`, plus `tests/test_contract_1_2.py`.
  - **Behaviour side:** BE-CRS-1 (`POST /documents/{id}/crs` closes covered `crs_confirm` questions), BE-RETRY-1 (retry answers 409 `demo_mode` in demo mode), and SPT refusal correction through edits of `spt_raw`. Changes are in `api/v1/documents.py`, `geo/crs_service.py`, `review/service.py`, `review/paths.py` and `clarify/answers.py`, plus `tests/test_frontend_requests.py`.
- **Next steps:** finish and verify 1.2.0, then `ruff`, `mypy`, the full suite and `alembic check`. Commit, merge to `integration`, merge back, and update the request statuses in `COORDINATION.md`.

## To do (user, 2026-10-17): extract the missing target-format fields
The contract already has fields for these, but the extraction schema does not ask for them, so they are always null today:
- BoreholeName → `metadata.borehole_name`
- ProjectID → `metadata.project_id`
- BoreholeLength → `metadata.borehole_length_m`
- EngineeringSoilUnit → `stratigraphy[i].engineering_soil_unit`
- GeologicAge → `stratigraphy[i].geologic_age`

Add them as nullable raw values to `ExtractedHeader` and `ExtractedLayer` in `app/pipeline/schemas.py`, add the rules to `data/prompts/extractor.txt`, and bump the prompt and schema versions. Map them in `app/pipeline/finalize.py`: BoreholeLength goes through `parse_length`, with ft→m conversion. Then map them in the spreadsheet whitelist (`data/spreadsheet.yaml`) and add tests with fakes. Do not run a live test.

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
- **No more live provider calls in tests** (the user's decision). Mistral/OpenRouter spend is about 0.29 USD of 2 USD; `.env` has `PROVIDER_BUDGET_USD=1.5`.
- `OPENAI_API_KEY` in `.env` is pasted twice; the user has to fix it.

## Next: proper auth (contract 1.3.0), agreed with the user and the frontend session
Auth is **always on**, with email and password registration and sign-in.

**Endpoints**, all under `/api/v1/auth`:
- `POST /register {email, password, display_name?}` → 201 `{user}` + cookie. Errors: 409 `email_taken`, 422, 429. The first account becomes `admin`; later ones are `reviewer`.
- `POST /login {email, password}` → 200 `{user}` + cookie. Errors: 401 `invalid_credentials` (same answer for an unknown email and a wrong password), 429 with `Retry-After`, 422.
- `POST /logout` → 204, idempotent.
- `GET /me` → 200 `{user}` or 401 `not_authenticated`.
- `POST /password {current_password, new_password}` → 204, and signs out the user's other sessions.

**User** = `{user_id: "usr_<ULID>", email, display_name|null, role: reviewer|admin, created_at}`.

**Validation:**
- email: trimmed, lower-cased, at most 254 characters;
- password: 10 to 128 characters, not equal to the email, not on a common-password list kept in `data/`;
- display_name: at most 80 characters.

**Passwords:** argon2 (`argon2-cffi`).

**Sessions:** a table holding the SHA-256 of a random 256-bit token. Cookie `gm_session`: HttpOnly, SameSite=Lax, Path=/, Secure only when `COOKIE_SECURE=true`. Idle timeout 12 h (sliding), absolute 30 days. A new session on every login.

**Access:** every `/api/v1` route except `GET /health`, `/api/health`, `POST /auth/register` and `POST /auth/login` returns 401 `not_authenticated` without a session. That includes page images, SSE `/events` and `/chat`. Any signed-in user may read and write; `admin` is for user management. 403 `forbidden` exists for role checks.

**Actor:** revisions, `confirmed_by` and `answered_by` come from the session user (display_name, else email); values sent in bodies are ignored.

**CSRF:** an Origin/Referer check on POST/PATCH/DELETE against `CORS_ORIGINS` plus the request's own host; missing or foreign → 403 `forbidden`.

**Rate limits** (config):
- 5 failed sign-ins per email per 15 min;
- 20 per IP per 15 min;
- 10 registrations per IP per hour.

**Health** gains `auth: {enabled: true, registration: "open"}`.

**Contract work:**
- new error codes `not_authenticated`, `invalid_credentials`, `forbidden`, `email_taken`;
- examples `User.*.json`, `AuthLoginRequest.json`, `AuthRegisterRequest.json`;
- a CHANGELOG entry for 1.3.0;
- a cookie security scheme.

**CLI:** `python -m app.users create|reset-password|set-role`. There is no email verification or reset by email (no mail server).

**Tests:** the conftest `client` fixture registers and signs in a fictional user. `make seed` still runs inside the container without auth.

**Planned build:** one workflow:
1. The auth core (models, migration 0006, argon2, sessions, rate limits, CSRF, routes, CLI) and contract 1.3.0, in parallel.
2. Then wire auth into every route, take the actor from the session, and update the fixtures and e2e tests.

The frontend session has acknowledged this design and is building its sign-in, register, sign-out and change-password screens against it.
