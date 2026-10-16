# Contract changelog

Rules: inside 1.x only additive changes (new endpoints, new optional fields, new enum values the other side can ignore). Anything else needs a 2.0 and both sessions' agreement in `docs/handover/COORDINATION.md`. Every change gets a dated entry here in the same commit as the change.

## 1.0.0 (2026-10-17)

First frozen contract: `contracts/openapi.yaml` and `contracts/realtime-and-chat.md`. It supersedes `docs/design/api-contract.md` (Prada's UI-to-API contract, written against the `arav/dev` prototype). Most shapes are kept so the existing frontend adapters keep working. The differences below are deliberate; the frontend session adapts to them.

### Changed compared with docs/design/api-contract.md
- `uid` is an opaque id `bh_<ULID>`, not `<document_id>:<borehole_id>`. Printed borehole labels repeat inside one report (for example the same "BH 2" from different jobs), so they cannot be part of a key.
- `GET /documents` returns `{ "documents": [...] }` (the frontend already accepts this form).
- `stratigraphy[].din4023_code` is a key of `assets/din4023_patterns/din_codes.json` (for example `T`, `U`, `S`, `G`, `Kst`, `mG`), case-sensitive, or `null`. English words such as "Clay" are no longer sent; the English text is in `english_lithology`.
- `unplotted_reason` is a code: `no_coordinates`, `crs_unknown`, `crs_unconfirmed`, `implausible`. The UI maps codes to labels.
- `geotechnical_tests` and `stratigraphy[].water_table_m` are replaced by `test_results[]` and `groundwater[]`.
- `tbm_engineering_assessment` is removed. The app does not invent engineering interpretations.
- Errors are always `{detail: string, code: string, errors?: [...]}`. FastAPI's validation array moves to `errors`. The UI branches on `code` (`document_not_found`, `demo_mode`, `validation_error` …) and no longer on the text "Not Found".
- `review_status` is `unreviewed | in_review | approved`, computed by the backend (the design contract's `reviewed` was ambiguous).
- The PATCH path grammar is defined: the record's `provenance` keys are the only valid paths, indices are positions at `revision`, edits never reorder arrays. The legacy path `geotechnical_tests.water_table_m` is gone; groundwater is `groundwater[i].depth_m`.
- Coordinates are never `0.0` placeholders. Unknown coordinates are `null` and the borehole has `plotted: false` with an `unplotted_reason`.

### Added
- Document: `project`, `mime_type`, `size_bytes`, `sha256`, `progress`, `duplicate_of`, `open_clarifications`, `created_at`, `updated_at`.
- Page: `role`, `borehole_ids`, `sheet_label`, `handwriting`, `language`, `ocr`, `duplicate_of`.
- BoreholeRecord: `revision`, `updated_at`, `pages`, `samples`, `test_results`, `open_clarifications`; metadata `aliases`, `elevation_datum`, `depth_origin`, `borehole_depth_source`, `borehole_length_m`, `inclination_deg`, `drilling_method`, `start_date`, `end_date`; coordinates `crs_code`, `x_raw`, `y_raw`, `axis_labels_raw`; layer `din4023_notation`, `stratigraphic_name`, `engineering_soil_unit`, `geologic_age`, `colour`, `moisture`, `weathering`, `is_core`, `spt_increment_mm`; groundwater `elevation_m`, `raw`; provenance `document_id`, `readings`, `cell` (spreadsheet sources).
- ValuePatch: action `reset` (undo a review action) and optional `if_revision`.
- CrsCandidate: `score`, `verdict`, `note`, `swap_axes`; CrsConfirmRequest: `swap_axes`.
- Endpoints: `POST /documents/{id}/retry`, `DELETE /documents/{id}`, `GET /map/boreholes.geojson`, `POST /result-sets`, `GET /result-sets/{id}`, `GET /result-sets/{id}/geojson`, `GET /geocode`, `GET /clarifications`, `POST /clarifications/{id}/answer`, `POST /clarifications/{id}/skip`, `GET /events` (SSE), `POST /chat` (UI message stream), `GET /api/v1/health`.
- Health: `status` is `ok | degraded`; `providers` lists which providers are configured; `upload` gives `max_mb` and accepted `extensions`, which the drop zone mirrors.
- `GET /boreholes?plotted=false` for the "Not on map" list. Map features carry `attention` and `open_clarifications`.
- Upload `project` groups files dropped together; CRS questions are asked once per project.
- `contracts/examples/*.json` (written by the backend session as its first M0 task): fictional example payloads, validated against this file by the backend contract tests and loaded by the frontend adapter tests.

### Removed or deferred
- `/extract/file`, `/extract/upload`, `/dataset/files`, the unversioned `/api/...` aliases and the per-borehole `/export/...` routes of the prototype.
- Server-side document export (`/documents/{id}/export`) is deferred to P2. In v1 the frontend exports client-side from domain data, as it already does in both modes.
