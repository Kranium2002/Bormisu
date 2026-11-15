# Evaluation harness

`python -m app.eval` runs GeoMemory's real pipeline (classifier, Mistral OCR, extractor, normalisation) on
sample files, compares what it stored with an expected-results file and writes
`docs/eval/report.md` (created by the run; none is committed). It is the evaluation from `docs/handover/BACKEND.md` section 11.

It spends real money: every run uses the provider keys from `.env` and stops at a cost cap you choose. It is
never part of `make test` or CI. The tests (`backend/tests/test_eval.py`) run it on fictional PDFs with fake
providers.

## What the report contains

Counts, rates, costs, durations, document statuses, model ids and failure category names. Nothing from the
sample files: no labels, coordinates, depths, project names, error texts or page numbers. Files appear only
as the short ids you type after `--files`. Without `--files` they appear as `file-01`, `file-02` …

Review `report.md` before you commit it. The harness writes no sample values, but the ids you choose do appear.

## Before the first run

1. **Keys.** `.env` in the repository root holds `MISTRAL_API_KEY` and `OPEN_ROUTER_KEY`. `make eval` passes
   it to the run. If you call Python directly, export the variables yourself. Without keys the harness stops
   with "demo mode".
2. **Database.** The harness writes documents, boreholes and the cost ledger (`provider_calls`) like the app
   does, into a migrated database. On the host the compose database is at `localhost:${DB_PORT}` (default
   5432), not `db:5432`. A separate database keeps evaluation documents out of the app:

   ```bash
   docker compose up -d db
   docker compose exec db createdb -U geomemory geomemory_eval
   cd backend
   DATABASE_URL=postgresql+asyncpg://geomemory:geomemory@localhost:5432/geomemory_eval uv run alembic upgrade head
   ```

   If you use the app's own database instead, the evaluated documents show up in the UI. Their page images
   then live in the host storage folder (`--storage-dir`), not in the container volume, so the UI cannot
   show those images.
3. **Storage.** Originals, page images and OCR output go to `STORAGE_DIR` (default `/data/storage`). On the
   host, pass `--storage-dir`, for example `--storage-dir ../local/eval-storage`. The repository's
   `.gitignore` already ignores `/local/`.
4. **Word files.** DOCX files are converted by Gotenberg. Compose does not publish its port. For an eval that
   includes Word files, run `docker run --rm -p 3000:3000 gotenberg/gotenberg:8` and set
   `GOTENBERG_URL=http://localhost:3000`.
5. **Budget.** `PROVIDER_BUDGET_USD` (total ledger cap) always applies. `--max-usd` caps this run.

## Running it

Plan first. A dry run resolves the files and prints page counts and cost estimates. It calls no provider
and touches no database. Without `--estimate-usd-per-page`, the estimates are worst case. `--data-dir` and
`--expected` default to `EVAL_DATA_DIR` and `EVAL_EXPECTED` from `.env`:

```bash
cd backend
uv run --env-file ../.env python -m app.eval --files FILE-A FILE-B --pages FILE-B=10-14 --max-usd 0.5 --dry-run
```

Then run with the same arguments without `--dry-run`, plus `--database-url` and `--storage-dir`:

```bash
uv run --env-file ../.env python -m app.eval --files FILE-A FILE-B --pages FILE-B=10-14 --max-usd 0.5 \
  --database-url postgresql+asyncpg://geomemory:geomemory@localhost:5432/geomemory_eval \
  --storage-dir ../local/eval-storage
```

`make eval EVAL_MAX_USD=0.5` runs every expected entry it finds, with the settings in `.env`. Set
`DATABASE_URL` and `STORAGE_DIR` there for the host first. To run only some files, call Python directly
with `--files`.

| Option | Meaning |
|---|---|
| `--data-dir DIR` | Folder with the sample files (default `EVAL_DATA_DIR`) |
| `--expected FILE` | Expected results, JSON (default `EVAL_EXPECTED`) |
| `--files NAME …` | Files or folders to run, in this order. A name matches a file or folder anywhere below `--data-dir`, with or without its extension, ignoring case and punctuation. A folder uploads each accepted file in it as its own document. Default: every expected entry found in the folder |
| `--pages NAME=FROM-TO …` | Process only these pages of a PDF. The excerpt (pypdfium2) is uploaded as its own document |
| `--max-usd X` | Cost cap of this run in USD (required) |
| `--estimate-usd-per-page X` | Estimate checked before each file (see below) |
| `--out FILE` | Report path (default `docs/eval/report.md`) |
| `--database-url URL` | Database to use (default `DATABASE_URL`) |
| `--storage-dir DIR` | Storage folder to use (default `STORAGE_DIR`) |
| `--dry-run` | Print the plan and estimates, then stop |
| `-v` | Log pipeline progress |

Order matters for duplicates. A file can only be recognised as a repeat of a file that ran before it, so put
the original first (for example `--files ORIGINAL REPEAT`).

## Cost control

1. **Before each file.** The harness adds up the cost recorded in `provider_calls` since the run started. It
   adds the file's estimate: pages to process × USD per page. If that total would pass `--max-usd`, the
   file and every later one are not started (`not_started_cost_cap`). The same check runs against
   `PROVIDER_BUDGET_USD` for the whole ledger.
2. **During a file.** For this process the harness lowers `PROVIDER_BUDGET_USD` to the ledger total at the
   start plus `--max-usd`. It never raises it. Each provider call checks this budget first, so a call that
   would pass the cap is refused. The document then fails with category `cost_cap` and the run ends.

Calls already in flight when the cap is reached still finish. The extractor runs `CONCURRENCY_EXTRACT`
groups at once (default 4), so a run can pass the cap by up to that many calls. For a tight cap, set
`CONCURRENCY_EXTRACT=1`. Calls that other processes record in the same database during the run count
toward the cap too.

The USD per page comes from `--estimate-usd-per-page` when given. Otherwise it is the mean cost per page
of the files already run in this run. Before any file has run, it is a worst-case prior: every page
classified, read by OCR and sent to the extractor. The prior is priced from `backend/data/prices.yaml`, with
the token assumptions in `backend/app/eval/defaults.yaml`. Rerunning a file whose bytes were already fully
processed costs nothing: the same document is reused.

## Expected-results file

JSON: a list of entries, an object with the list under `files`, or an object that maps file ids to entries.
The data audit's `summaries.json` works as it is. Every field is optional. A field the harness cannot read
for certain makes its comparison **not comparable**; it never guesses. Fictional example:

```json
[
  {
    "doc": "QA-ALPHA.pdf",
    "borehole_count": 2,
    "boreholes": [
      {"id": "QX-11", "pages": "2-3", "coordinates": "Easting 512 345,6 Northing 5 412 987,1",
       "total_depth": "7,50 m", "crs_status": "stated", "layer_count": 3, "unplotted_reason": null},
      {"id": "QX-13", "pages": "p. 5", "coordinates": "none printed"}
    ],
    "duplicate_of": [],
    "cross_file_links": "none"
  }
]
```

| Field | Read as |
|---|---|
| `doc` (or `file`, `file_name`, `name`, `id`) | The file or folder the entry is about; matched like `--files` names |
| `borehole_count` | Expected number of boreholes |
| `boreholes[].id` (or `label`) | Label as printed; compared after the pipeline's own canonicalisation (upper case, no spaces, dashes or underscores, no leading zeros) |
| `boreholes[].pages` | Page numbers and ranges only (`"16-18"`, `"p. 3–5, 7"`, `[3, [5, 6]]`). Text with other words or brackets is not read |
| `boreholes[].x_raw`, `y_raw` | Coordinates exactly as printed, compared per axis |
| `boreholes[].coordinates` | Free text. The stored `x_raw` and `y_raw` must both appear in it (whitespace, quote marks and case ignored). Text without any digit means no coordinates are printed |
| `boreholes[].crs_status` | `stated`, `inferred`, `confirmed` or `unknown`. When no coordinates are printed, `unknown` is expected |
| `boreholes[].total_depth_m` / `total_depth` | A number in metres, or one printed length with its unit (read by `app.normalize.units`) |
| `boreholes[].layer_count` (or a `layers` list) | Expected number of layers |
| `boreholes[].unplotted_reason` | Contract value or `null`. When no coordinates are printed, `no_coordinates` is expected |
| `duplicate_of` | Ids of files this file repeats pages of |
| `cross_file_links` | Free text, used when `duplicate_of` is absent. Ids of earlier files of the run named in it count as expected duplicate links |

The audit describes CRS, layers and unplotted reasons in prose. Those metrics therefore stay not
comparable, except where no coordinates are printed. Add the structured fields above to an entry to compare
them.

## Comparisons and failure categories

Boreholes are matched by canonical label, including the aliases the pipeline recorded. The per-borehole
metrics count matched boreholes only. A borehole that was not found counts once, under labels.

| Metric | Failure categories |
|---|---|
| Borehole count | `borehole_count_mismatch` |
| Labels | `label_missed`, `label_unexpected` (only when the entry lists every borehole) |
| Coordinates as printed | `coordinates_mismatch`, `coordinates_missed`, `coordinates_unexpected` |
| CRS status | `crs_status_mismatch` |
| Total depth (tolerance in `defaults.yaml`) | `total_depth_mismatch`, `total_depth_missing` |
| Layer count | `layer_count_mismatch` |
| Unplotted reason | `unplotted_reason_mismatch` |
| Duplicates | `duplicate_missed`, `duplicate_unexpected` |
| Processing | `failed_at_<stage>`, `cost_cap`, `provider_budget`, `upload_<code>`, `harness_error`, `not_started_cost_cap`, `not_started_provider_budget` |

**Excerpts.** With `--pages`, the harness compares only expected boreholes whose pages all lie inside the
excerpt. Boreholes the excerpt cuts are counted as "partly in" and left out. The borehole count is
compared only when the entry lists every borehole with readable pages; otherwise it is "not comparable".

## Data rule

The sample files, the audit and anything copied from them stay outside the repository. The harness reads
them only at run time, from the paths you pass. `report.md` is the only file it writes into the
repository.
