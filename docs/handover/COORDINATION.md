# Coordination log

Each session updates only its own section, at the end of every milestone, and merges this file to `integration` with its work. Newest entries on top inside each section.

## Backend status

- (empty)

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
