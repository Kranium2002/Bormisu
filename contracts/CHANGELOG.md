# Contract changelog

Rules: inside 1.x only additive changes (new endpoints, new optional fields, new enum values the other side can ignore). Anything else needs a 2.0 and both sessions' agreement in `docs/handover/COORDINATION.md`. Every change gets a dated entry here in the same commit as the change.

## 1.2.1 (2026-10-17)

Additive only: one new optional field on `Document` and a retry that accepts more documents. Clients built against 1.2.0 keep working.

### Added
- `Document.warnings` (`string[]`, optional, empty by default): readable notes on a document in review that is not complete, e.g. "Page 1 was not read; boreholes on it are missing. Retry the document to read it." Show them on the document as they are, with the retry action.

### Changed behaviour (no shape change)
- A page that cannot be read (OCR refused, also after rate limits were waited out) no longer fails the whole document: everything that was read is finalised (boreholes, pins, clarifications), the document goes to `needs_review` and `warnings` names the unread pages. Only a document where nothing at all could be extracted still fails (`failed_stage` `extract`, retryable).
- `POST /documents/{id}/retry` also accepts a `needs_review` or `done` document with unread pages and reads only those pages again (stored OCR, boreholes and answers are kept). 409 `not_failed` otherwise, as before.
- Rate limits (HTTP 429 from a provider) are waited out on the server (Retry-After honoured) and the page is tried again later in the same job, so a burst of 429s no longer leaves pages unread.
- Decimal degrees printed without a stated axis order (no N/E or lat/long label; X/Y labels included) are read and asked about with a `crs_confirm` question instead of being left unread; the candidate ranking puts the axis order whose points are on or near land first when other evidence ties.

## 1.2.0 (2026-10-17)

Additive only: one new optional field on `Document`, one optional query parameter, two new fields in an event payload and clarified descriptions. Clients built against 1.1.0 keep working.

### Added
- `Document.failed_stage` (`[string, null]`): the pipeline stage that failed, the same name as `stage` in the `job.failed` event (`triage`, `classify`, `ocr`, `extract`, `reread`; spreadsheets `sheet_read`, `sheet_map`, `sheet_extract`). `null` unless `status` is `failed`, and also when the document failed before any stage ran (it could not be queued). Stored when a stage fails, cleared on retry and on success.
- `GET /api/v1/events?last_event_id=<integer>`: the same meaning as the `Last-Event-ID` header (replay every stored event after that id), for an `EventSource` created anew, which cannot set the header. The header wins when both are sent; a header that is not a whole number is ignored.
- `clarification.resolved` event payload: `document_id` and `borehole_uids` of the resolved question (realtime-and-chat.md section 1), so a client can refresh only the affected open-question counts.
- Map features (`GET /map/boreholes.geojson`, `GET /result-sets/{id}/geojson`): `crs_code` and `crs_label` (`[string, null]`), the record's stated or confirmed system, so the map, popups and result tables can name it without loading full records.
- Examples: `failed_stage` in every `Document` (`"ocr"` in `Document.failed.json`, matching `events/job.failed.json`; `null` elsewhere); `document_id` and `borehole_uids` in `events/clarification.resolved.json`.

### Changed behaviour (no shape change)
- `POST /documents/{id}/crs` (and a `crs_confirm` answer) also resolves every open or skipped `crs_confirm` question whose boreholes all have a stated or confirmed system afterwards: status `answered`, `answered_by` the confirming person, answer `{crs, swap_axes, via: "crs_endpoint"}`, event `clarification.resolved`. A question that still covers an unconfirmed borehole stays open.
- `POST /documents/{id}/retry` answers 409 with code and detail `demo_mode` in demo mode and leaves the document untouched (it used to re-queue a document no provider could process).
- An edit of `stratigraphy[i].spt_raw` re-parses the SPT and updates `spt_refusal`, `spt_n_value` (null on refusal), `spt_increments`, `spt_increment_mm` and `spt_penetration_cm` in the same revision; an edit of `spt_n_value` with refusal text answers 422 `unparseable_value` and says to correct `spt_raw`.

### Clarified (descriptions only, no shape change)
- `CrsCandidate.verdict`: match = every transformed point lies inside the system's EPSG area of use and, when a reference place is known, the centroid of the points lies within the server's match distance of it; shifted = every point inside the area of use or within the server's margin around it, but some only in the margin or the centroid far from the reference place; out_of_range = at least one point outside the area of use and its margin, or not transformable. The margin and the distance are the server's data (CRS registry), not part of the contract. `GET /documents/{id}/crs-candidates` refers to this definition.
- `BoreholeRecord.rock_head_m`: as printed or edited, else derived from the top of the first rock layer (DIN 4023 code). `null` means not stated in the source and not derivable from the printed layers; it never means "not reached".

## 1.1.0 (2026-10-17)

Additive only: new optional fields, one optional query parameter, one new endpoint and clarified descriptions. Clients built against 1.0.0 keep working.

### Added
- `Coordinates.crs_label` (`[string, null]`): human-readable name of `crs_code` (the server registry's label, else the EPSG name). The backend fills it whenever `crs_code` is set (stated or confirmed). Server-computed like `crs_code`: no provenance entry, not a PATCH path.
- `ValuePatch.confirmed_by` (`[string, null]`): who performed the review action. Stored as the revision's actor, trimmed and cut to 100 characters; `"reviewer"` when absent or blank.
- `POST /api/v1/documents/{document_id}/approve-clean`: optional query parameter `confirmed_by` with the same meaning (default `"reviewer"`).
- `GET /api/v1/clarifications/{clarification_id}/crs-candidates` (`listClarificationCrsCandidates`, P1): `CrsCandidate[]` ranked for all boreholes in the clarification's `borehole_uids`, which may span several documents. 404 `clarification_not_found`; `[]` when the clarification is not `crs_confirm` or its boreholes have no printed coordinates.
- Examples: `CrsCandidate.clarification.json` (the new endpoint's answer for `Clarification.crs_confirm.json`) and `ValuePatch.approve_confirmed_by.json`; `crs_label` in every example record; provenance entries for every value that lacked one.

### Clarified (descriptions only, no shape change)
- `open_clarifications` (Document, BoreholeRecord, map feature) counts unresolved questions: status `open` or `skipped`. Map `attention` is true for an unresolved question too.
- A skipped question can still be answered later: `POST /clarifications/{id}/answer` on a skipped one returns 200; 409 `already_resolved` only when it is already answered. `POST /clarifications/{id}/skip` now declares that 409 too.
- Provenance rule in the `BoreholeRecord` description: every non-null value at a ValuePatch path has a provenance entry, except the server-computed `stratigraphy[i].thickness_m`, `stratigraphy[i].description_language`, `metadata.coordinates.crs_code`, `metadata.coordinates.crs_label` and `metadata.aliases`. `english_lithology`, when it is a model's rendering of the printed description, carries method `guessed` with the box of `original_description`.
- `GET /documents/{id}/crs-candidates` describes its ranking evidence (area of use, distance to a reference place geocoded on the server, compactness, specificity) and order (verdict, score, smaller area of use, EPSG code). An unavailable geocoder never fails the call.

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
