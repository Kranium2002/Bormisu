"""FastAPI service that serves bh3's output in the shape the Bormisu frontend expects (docs/design/api-contract.md).

    python -m bh3 api --store api_data --port 8000 [--import out3/boreholes.json --data-root ../HKBoreholeChallenge_Data_BFH2026/BoreholeData]

Nothing here changes the extraction: `store.py` keeps documents, results, review overlays and uploads on disk,
`mapping.py` turns a bh3 borehole into a `BoreholeRecord` with provenance, lint, groundwater and CRS status,
`app.py` holds the routes. Uploads run the normal `bh3 run` steps in a background thread.
"""
