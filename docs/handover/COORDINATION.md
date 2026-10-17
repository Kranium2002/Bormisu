# Coordination log

Each session updates only its own section, at the end of every milestone, and merges this file to `integration` with its work. Newest entries on top inside each section.

## Backend status

- 2026-10-17 03:00 · M0 part 1 · **Done:** `contracts/examples/` (78 fictional payloads: every main schema, all 9 clarification kinds, all 21 error codes, 7 event payloads, `chat/turn.sse` and `chat/error.sse`), validated by `backend/tests/contract/` (205 tests). Naming rule: `<SchemaName>.<variant>.json` validates against `#/components/schemas/<SchemaName>`; a top-level array validates per item; see `contracts/examples/README.md`. Interpretations: a duplicate upload returns the existing document's id in both `document_id` and `duplicate_of`; `Provenance.document_id` is always filled; unclassified pages are `{type: "unknown", used: false, ocr: "pending"}` without `role`. **Next:** compose stack, `make seed`, all P0/P1 endpoints (in progress on `feat/backend`).

## Frontend status

- (empty)

## Contract requests (frontend → backend)

Format: `YYYY-MM-DD · requester · what is needed · why · status (open / accepted / done in 1.x.y / rejected + reason)`

- (empty)

## Decisions taken during the build

Format: `YYYY-MM-DD · session · decision · reason`

Decisions taken in the handover (2026-10-17):
- 2026-10-17 · handover · Mistral OCR is called directly with `MISTRAL_API_KEY`; the page classifier and the extractor run on OpenRouter; OpenAI is used for chat only · direct OCR returns block boxes, confidence and page selection, and OpenRouter's OCR plugin does not
- 2026-10-17 · handover · Keep Prada's React, Vite, Leaflet and CSS-modules app; no Next.js, MapLibre or shadcn · working, tested code and a fixed deadline
- 2026-10-17 · handover · Exports stay client-side in v1; `approve-clean` is server-side · one tested export implementation; atomic bulk approval
- 2026-10-17 · handover · The database starts empty; `make seed` loads fictional data on request only · the map shows uploaded data only
- 2026-10-17 · handover · Contract 1.0.0 refined after the branch audit: error `code`, PATCH path grammar, `review_status` `in_review`, health `upload` limits, map `attention` · see `contracts/CHANGELOG.md`
