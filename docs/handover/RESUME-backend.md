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
