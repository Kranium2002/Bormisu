# LGRB scorecard: design

Status: draft for approval. Size: a small change (one script, about 150 lines, plus a run).

## Intent

Herrenknecht has seen the product work on the 19 documents they handed out. The next meeting can end in a
contract, and the questions there are "how accurate on documents you never saw" and "what does it cost per
report". Today the only scored run is the old bh3 command-line tool on 21 hand-labelled pages; nothing has
been scored through the real upload path.

The LGRB Baden-Württemberg portal publishes, per borehole, the redacted original sheet (PDF) and its own
structured layer table. Feeding the PDFs through the running app and comparing with that table gives a
scorecard on unseen, public data that may be shown and repeated.

## Goals

- One table per run: per borehole and in total, what the app extracted versus the portal's data.
- Numbers come from the running stack over its HTTP API, exactly what a user gets after an upload.
- Every metric states its denominator and how many cases were "not comparable".

## Non-goals

- Improving extraction. The scorecard only measures; what to fix is decided from its result.
- A user interface, or changes to `python -m app.eval` and its report.
- SPT, colour, stratigraphic unit, strata wording (see "Not scored").

## Anti-goals

- Numbers that flatter. Review edits, answered questions or hand-picked sheets must not leak in: the score
  uses the values of the first extraction, and the selection rule of the harvest is written down.
- Any portal file, label or key in git. Data and reports live under `/raw_data/` (ignored).

## Approaches

1. **Standalone scorer over HTTP (chosen).** `backend/app/eval/lgrb_scorecard.py` logs in, reads
   `GET /api/v1/documents/{id}` and `/documents/{id}/boreholes`, compares with `truth/<id>.json`. Scores
   what the product actually returns; touches no tested code.
2. **Extend `python -m app.eval`.** It runs the pipeline in its own process, reads the database directly and
   reports counts only (labels, depth, layer count). It would need new metrics and a second truth format
   inside code that CI tests. Bigger, and it would not score the deployed path.
3. **Port the old bh3 `eval.py`.** It scores per-page golden files against the command-line tool's output.
   The truth would have to be converted to page files and the result still would not come from the app.

## What is scored

| Portal truth | Record field | Rule |
|---|---|---|
| one sheet = one borehole | number of records of the document | exactly 1, else a count failure |
| Endteufe | `metadata.borehole_depth_m` | within 0.10 m |
| layer bottoms (bis) | `stratigraphy[].depth_to_m` | matched one to one within 0.15 m; recall, precision, mean error of matches |
| Petrographie | `stratigraphy[].din4023_code` | truth phrase through `din_code_from_text(…, "de")`, equal main code on matched layers |
| Koordinaten (32U) | `metadata.coordinates` | truth to WGS84 with pyproj; within 25 m when plotted, else "not plotted" |
| Ansatzhöhe | `metadata.surface_elevation_mASL` | within 0.05 m |
| Bohrdatum | `metadata.start_date` | same date |
| Aufschlussname | `metadata.borehole_id`, aliases | equal after `canonical_label`; reported apart, the archive name is often not printed |

Reported next to the score, never folded into it: plotted or not and why, coordinate-system status, open
questions, failed documents and the stage, pages the classifier skipped, model cost and minutes per
document.

## Not scored, and why

- Stratigraphic unit and colour: the page reader leaves both empty.
- Bohrgut, Zusatzinfos, "LGRB geprüft": no field in our record.
- Strata wording: the portal's text is LGRB's coded re-reading, not the sheet's words.
- Coordinates on sheets that print Gauss-Krüger without a datum or nothing: that is a question for a person,
  not a reading error; it shows up under "not plotted".

## Run

1. Upload the harvested PDFs as one project ("LGRB Offenburg") with a local ingest account.
2. Wait until every document is in review or failed.
3. Run the scorer; it writes `raw_data/lgrb-offenburg/scorecard/report.md` and `rows.csv`.

## Self-check in the script

- Bottoms [1.0, 2.0] against [1.1, 2.4] give 1 of 2 within 0.15 m, mean error 0.1.
- The sample coordinate "32U O: 421467.9 | N: 5369448.861" lands near 48.47 N, 7.94 E.
- `din_code_from_text("Kies [gerundet] (stark sandig)", "de") == "G"`.

## Left to the builder

- The matching of bottoms (nearest free partner within tolerance is enough).
- Report layout, and where cost per document is read from (API if exposed, else the provider ledger table).
- A first look at how many portal petrography phrases the DIN mapper cannot code; if it is many, say so in
  the report rather than extend the mapper.
