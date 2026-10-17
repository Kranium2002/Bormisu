# Contract examples (fictional)

**Every file in this folder is fictional.** The projects ("Fictional Harbour Link", "Demo Ridge Tunnel"), towns (Lindenwick, Harrowmere), companies, people, file names, borehole labels, depths, coordinates and lab values are invented for contract tests. Nothing here is copied from a real report or from the challenge samples. Coordinates are plausible real-world positions so that maps and coordinate transforms behave normally.

These payloads are shared by both sessions:
- the backend contract tests (`backend/tests/contract/test_examples.py`) validate every file against `contracts/openapi.yaml` and `contracts/realtime-and-chat.md`;
- the frontend adapter tests load them as API responses.

A rename or a shape change therefore fails both suites. Change an example only together with the contract, and record the change in `contracts/CHANGELOG.md` (additive only inside 1.x).

## Naming rule

`<SchemaName>.<variant>.json` (or `<SchemaName>.json`) validates against `#/components/schemas/<SchemaName>` of `contracts/openapi.yaml`. When the top-level JSON is an array, every item validates against that schema (for example `CrsCandidate.list.json`, `PlaceCandidate.list.json`). Other files at the top level are not allowed.

| Folder | Rule |
|---|---|
| `./` | Schema examples as above. `Error.<code>.json` exists for every error code listed in the `Error` schema. `Clarification.<kind>.json` exists for every clarification kind, plus `Clarification.answered.json`. |
| `events/` | `<event-type>.json` is the `data` JSON of one server-sent event from `GET /api/v1/events` (realtime-and-chat.md section 1), named exactly by the `event:` type, e.g. `events/document.updated.json`. `document.updated` carries a full `Document`, `clarification.created` a full `Clarification`, the others the small objects in the table. |
| `chat/` | `*.sse` is a complete response body of `POST /api/v1/chat` in the AI SDK UI message stream v1 (realtime-and-chat.md section 2): one `data: <json>` line per chunk, a blank line after each, ending with `data: [DONE]`. LF line endings only. `turn.sse` is a normal turn with tools, data parts and text; `error.sse` is a failed turn. |

## One consistent world

Ids are opaque (`doc_`, `bh_`, `rs_`, `cl_` plus a ULID) and are reused across files when they refer to the same thing:

| Id holder | What it is |
|---|---|
| `Document.needs_review.json` | `fictional-harbour-link-logs.pdf`: 15 pages covering every page type and role; boreholes FHL-BH01 (`BoreholeRecord.full.json`) and FHL-BH02 (`BoreholeRecord.unplotted_no_coordinates.json`); 8 open clarifications |
| `Document.needs_review_scan.json` | `demo-ridge-tunnel-scan.pdf`: borehole DRT-B12 (`BoreholeRecord.crs_unconfirmed.json`), coordinates printed without a system; `CrsCandidate.list.json` and `Clarification.crs_confirm.json` belong to it. `CrsCandidate.clarification.json` is the answer of `GET /clarifications/{id}/crs-candidates` for that question (1.1.0), ranked with the geocoded place of `PlaceCandidate.harrowmere.json` as reference |
| `Document.done.json` | `fictional-vector-log.pdf`: borehole DRT-B7 (`BoreholeRecord.approved.json`), CRS confirmed through `Clarification.answered.json` |
| `Document.spreadsheet.json` | `fictional-harbour-link-labdata.xlsx`: source of the spreadsheet-cell value (`Logdata!C5`) in `BoreholeRecord.full.json` |
| `Document.queued/classifying/extracting/failed.json` | Documents in the other pipeline states; `DocumentList.json` holds all eight, newest first |

`BoreholeFeatureCollection.json` holds the two plotted boreholes, `ResultSet.*.json`, `BoreholeList*.json`, `ValuePatch.*.json`, `events/` and `chat/` refer to the same ids. The contract tests check this cross-file consistency (ids exist, counts match, provenance keys resolve in their record).

## Conventions the examples pin down

- Unknown is `null`, never `0` or `(0, 0)`. A borehole without coordinates has `plotted: false` and an `unplotted_reason`.
- `din4023_code` is a key of `assets/din4023_patterns/din_codes.json`, case-sensitive (`mG` medium gravel is not `Mg` till marl).
- Provenance keys follow the `ValuePatch` path grammar and point at a field that exists in the same record; values with `cell` have `page` and `box` null.
- Every non-null value at a `ValuePatch` path has a provenance entry, except the server-computed `thickness_m`, `description_language`, `metadata.coordinates.crs_code`, `metadata.coordinates.crs_label` and `metadata.aliases` (contract 1.1.0, `BoreholeRecord` description). `english_lithology` is a model's rendering: method `guessed`, page and box of `original_description`.
- `metadata.coordinates.crs_label` is set exactly when `crs_code` is set, with the backend registry's label.
- `ValuePatch.approve_confirmed_by.json` shows the optional `confirmed_by` (1.1.0).
- `review_status` follows the contract: `approved` only when every provenance entry is approved, `unreviewed` when none is reviewed yet, else `in_review`.
- Clarification widgets per kind: `crs_confirm` uses `crs_picker` (options carry evidence), `locate_borehole` `map_point`, `choose_reading` `choose_reading`, `datum_convention` `select`, `unit_ambiguous` `number_unit` with `unit_options`, `borehole_boundary` `page_range`, `duplicate` `select`/`boolean`, `conflicting_sources` `select` with evidence per option, `chat_parameter` `select`.
