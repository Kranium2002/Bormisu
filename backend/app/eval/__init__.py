"""Evaluation harness (BACKEND.md section 11): the real pipeline on sample files, within a cost cap.

`python -m app.eval --data-dir DIR --expected FILE --files NAME ... --max-usd X` uploads each file through
the API's upload steps, runs `orchestrator.run_pipeline` in this process, compares what was stored with the
file's expected entry and writes docs/eval/report.md with metrics and failure categories only.

Modules: `expected` (reading expected results), `plan` (files, excerpts, estimates), `runner` (upload,
pipeline, cost caps, collection), `compare` (per-file comparison), `report` (Markdown), `cli`.
"""
