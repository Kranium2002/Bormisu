# pipeline — borehole report extraction

The pipeline lives in **`bh3/`** ([README](bh3/README.md), output format for the demo team in
[bh3/OUTPUT.md](bh3/OUTPUT.md)). It turns borehole reports of any kind (vector PDFs, scanned PDFs, photos,
folders of page images, DOCX files with embedded scans) into the BoreholeDataFormat xlsx/json and into the
data a borehole map needs: pins in one coordinate system, a layer table per hole with DIN 4023 petrography
codes, and the source page behind every value.

```bash
py -3.10 -m venv .venv && .venv/Scripts/activate        # Windows
pip install -r requirements.txt
cp .env.example .env                                     # set LLM_API_KEY (hosted) or LLM_BASE_URL (local model)
python -m bh3 probe                                      # check the backend
python -m bh3 run ../HKBoreholeChallenge_Data_BFH2026/BoreholeData -o out3   # everything → out3/boreholes.xlsx, .json, site/
python -m bh3 eval out3/boreholes.json --golden tests/golden/unseen
python -m pytest tests -q                                # local benchmarking suite (not in the repo)
```

History: v1 `bhpipe` (deterministic geometry parser, exact on clean vector logs, blind on scans) and v2
`bhvision` (vision-model-first for raster pages) were condensed into `bh3` on 2026-10-17; the parts that
measurably worked were moved, the rest (OCR, LibreOffice, the v1 vision rescue) deleted. The regression eval
on the labelled dev and unseen pages reproduces v2's numbers from cache with zero model calls.
