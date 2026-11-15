# LGRB Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score what the running app extracts from public LGRB borehole sheets against the portal's own structured data, and write one report.

**Architecture:** One module, `backend/app/eval/lgrb_scorecard.py`, with pure comparison functions and a small command line with two modes: `upload` (send one sheet per borehole to the running stack, remember the document ids) and `score` (read documents and records back over HTTP, compare with `truth/<id>.json`, write `report.md` and `rows.csv`). It talks to the app only through its HTTP API and touches no existing code.

**Tech Stack:** Python 3.12, httpx (sync client, keeps the session cookie), pyproj, pytest, respx. All are already project dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-lgrb-scorecard-design.md`

## Global Constraints

- No portal file, label or key in git. Data and reports live under `/raw_data/` at the repository root (ignored).
- Test values may be real when their source is public (the LGRB portal), with the source named in the test; challenge data stays out. No data file (pdf, xlsx, csv, image) is committed: the CI `data-guard` job rejects them outside `docs/` and `assets/`.
- The score uses the values of the first extraction. Records with `revision != 1` are counted and named in the report.
- Every metric reports matches, mismatches and "not comparable" separately (`Tally` from `app/eval/compare.py:48`).
- ruff: line length 110, `ruff check` and `ruff format --check` must pass (`backend/pyproject.toml`).
- Tolerances from the spec, verbatim: final depth 0.10 m, layer bottoms 0.15 m, collar elevation 0.05 m, position 25 m.

## Facts the implementer needs

- Truth file `raw_data/lgrb-offenburg/truth/<id>.json` (all values are strings): `id` ("7513-275"), `name`,
  `date` ("01.12.1976"), `coordinates` ("32U O: 421360.93 | N: 5369895.685"), `endteufe` ("10,0 m"),
  `ansatzhoehe` ("149,0 m ü. NN"), `layers[]` with `von`, `bis` ("0.25"), `Petrographie` (text),
  `codes.petro` (LGRB code, e.g. "fX(duh(0.9))").
- Sheets: `raw_data/lgrb-offenburg/pdf/<id>/BO_<tk25>_<arnum, 5 digits>_SV_<n>_x.pdf`. A borehole can also
  have shared files whose name holds a range (`BO_7513_00273-00275_SV_1_x.pdf`) and non-SV files (`BP`, `AP`, `LP`).
- API (session cookie after login): `POST /api/v1/auth/login` json `{email, password}` (401 on wrong);
  `POST /api/v1/documents` multipart `file` + form `project`, answers 202 `{document_id, status, duplicate_of}`
  or 200 with `duplicate_of` set for bytes already uploaded, 409 in demo mode;
  `GET /api/v1/documents/{id}` (`status`, `failed_stage`, `pages[].used/role/unused_reason`,
  `open_clarifications`, `created_at`, `updated_at`); `GET /api/v1/documents/{id}/boreholes` (list of records).
- Record fields used: `revision`, `plotted`, `unplotted_reason`, `crs_status`, `metadata.borehole_id`,
  `metadata.aliases`, `metadata.borehole_depth_m`, `metadata.surface_elevation_mASL`, `metadata.start_date`,
  `metadata.coordinates.latitude/longitude`, `stratigraphy[].depth_to_m`, `stratigraphy[].din4023_code`.
- Document statuses that end processing: `needs_review`, `done`, `failed`.

## Review Focus

1. A document that failed or is still processing: its row shows the status; no accuracy number is computed from it.
2. A document with zero or several borehole records: a count failure; every other metric of that row is "not comparable".
3. A truth layer whose petrography is empty or cannot be coded: "not comparable", never a mismatch.
4. One of our layers with `depth_to_m` null: left out of the matching, no crash.
5. `upload` run twice: the second run reuses the document ids (answer 200) and starts no second paid read; a wrong password or demo mode ends with one readable line.

---

### Task 1: Comparison primitives

**Files:**
- Create: `backend/app/eval/lgrb_scorecard.py`
- Test: `backend/tests/test_lgrb_scorecard.py`

**Interfaces:**
- Produces:
  - `first_number(text: str | None) -> float | None` — the first decimal number in a string, comma or point.
  - `match_bottoms(truth: list[float], ours: list[float], tol: float = 0.15) -> tuple[list[tuple[int, int]], float | None]` — index pairs (truth, ours) matched one to one, nearest free partner first, and the mean absolute error of the pairs (None without pairs).
  - `truth_wgs84(text: str | None) -> tuple[float, float] | None` — (latitude, longitude) of a "32U O: … | N: …" string via `pyproj.Transformer.from_crs(25832, 4326, always_xy=True)`; None for any other zone or shape.
  - `truth_din(layer: dict[str, Any]) -> str | None` — the leading letters of `codes.petro` when `valid_din_code` (`app/normalize/lithology.py`) accepts them, else `din_code_from_text(layer["Petrographie"], "de")`, else None.
  - `distance_m(a: tuple[float, float], b: tuple[float, float]) -> float` — `pyproj.Geod(ellps="WGS84").inv`.

- [ ] **Step 1: Write the failing tests**

```python
from app.eval import lgrb_scorecard as sc


def test_first_number_reads_german_decimals() -> None:
    assert sc.first_number("10,0 m") == 10.0
    assert sc.first_number("149,0 m ü. NN") == 149.0
    assert sc.first_number("") is None and sc.first_number(None) is None


def test_match_bottoms_one_to_one_within_tolerance() -> None:
    pairs, mae = sc.match_bottoms([1.0, 2.0], [1.1, 2.4])
    assert pairs == [(0, 0)] and mae == pytest.approx(0.1)
    assert sc.match_bottoms([1.0], [1.05, 1.1])[0] == [(0, 0)]  # the nearer one, the other stays free
    assert sc.match_bottoms([], [1.0]) == ([], None)


def test_truth_wgs84_on_the_central_meridian() -> None:
    lat, lon = sc.truth_wgs84("32U O: 500000.0 | N: 5400000.0")
    assert lon == pytest.approx(9.0, abs=1e-6) and lat == pytest.approx(48.753, abs=0.01)
    assert sc.truth_wgs84("33U O: 500000.0 | N: 5400000.0") is None
    assert sc.truth_wgs84("") is None


def test_truth_din_prefers_the_code_then_the_words() -> None:
    assert sc.truth_din({"Petrographie": "Kies [gerundet] (stark sandig)", "codes": {"petro": "G(s4)"}}) == "G"
    assert sc.truth_din({"Petrographie": "Kies [gerundet] (stark sandig)", "codes": {"petro": ""}}) == "G"
    assert sc.truth_din({"Petrographie": "", "codes": {"petro": ""}}) is None
```

- [ ] **Step 2: Run them, expect failure**

Run: `python -m pytest tests/test_lgrb_scorecard.py -q` (from `backend/`)
Expected: FAIL, module `app.eval.lgrb_scorecard` not found

- [ ] **Step 3: Implement the five functions with the signatures above**

- [ ] **Step 4: Run the tests, expect 4 passed**

- [ ] **Step 5: Commit** — `feat(eval): comparison primitives for the LGRB scorecard`

---

### Task 2: Score one borehole, total, render

**Files:**
- Modify: `backend/app/eval/lgrb_scorecard.py`
- Test: `backend/tests/test_lgrb_scorecard.py`

**Interfaces:**
- Consumes: Task 1 functions; `Tally` (`app/eval/compare.py:48`); `canonical_label` (`app/review/service.py:103`).
- Produces:
  - `METRICS = ("count", "final_depth", "boundaries", "din", "position", "elevation", "date", "name")`
  - `score_borehole(truth: dict[str, Any], document: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]` — a row with `id`, `status`, `n_records`, one `Tally` per metric under its name, plus `boundary_extra` (our bottoms with no partner), `boundary_mae` (float | None), `plotted` (bool | None), `unplotted_reason`, `crs_status`, `open_clarifications` (int), `pages_unused` (int), `revision` (int | None), `minutes` (float | None, `updated_at - created_at`).
  - `totals(rows: list[dict[str, Any]]) -> dict[str, Tally]`
  - `render(rows: list[dict[str, Any]], excluded: dict[str, str]) -> str` — markdown: a totals table (metric, right, wrong, not comparable, share right of compared), the side facts (documents failed, boreholes not plotted by reason, open questions, records with `revision != 1`, mean minutes), a per-borehole table, and the excluded boreholes with their reason.

Rules the tests below pin: `boundaries.match` = matched truth bottoms, `boundaries.mismatch` = unmatched truth bottoms; `din` is counted over matched layer pairs only; `position` is "not comparable" when the record is not plotted or the truth has no coordinate; a date compares `truth["date"]` ("DD.MM.YYYY") with `metadata.start_date` (ISO); a name matches when `canonical_label(truth["name"])` equals the canonical `borehole_id` or one of `aliases`.

- [ ] **Step 1: Write the failing tests.** Four small builders in the test file give one fictional borehole that agrees with itself, each taking keyword overrides: `truth()` (id "0000-7", name "Fictional B 7", date "01.02.1990", coordinates "32U O: 500000.0 | N: 5400000.0", endteufe "2,5 m", ansatzhoehe "100,0 m ü. NN", two layers with bottoms 1.0 and 2.5 and codes "S" and "G"), `layer(depth_to_m, din4023_code)`, `record()` (revision 1, plotted, the same depth, elevation, date "1990-02-01", position and two layers) and `document()` (status "needs_review", one used page, no open questions, `created_at` and `updated_at` four minutes apart). Task 3 adds `make_data(tmp_path, borehole_id, uploaded_as=None)`, which writes `truth/<id>.json`, one own sheet under `pdf/<id>/` and, when `uploaded_as` is given, `scorecard/uploads.csv`.

```python
def test_a_clean_borehole_scores_every_metric() -> None:
    row = sc.score_borehole(truth(), document(), [record()])
    assert row["count"].match == 1 and row["final_depth"].match == 1
    assert (row["boundaries"].match, row["boundaries"].mismatch, row["boundary_extra"]) == (2, 0, 0)
    assert row["din"].match == 2 and row["position"].match == 1 and row["date"].match == 1


def test_a_failed_document_gives_no_accuracy_numbers() -> None:
    row = sc.score_borehole(truth(), document(status="failed"), [])
    assert row["status"] == "failed" and all(row[m].compared == 0 for m in sc.METRICS)


def test_two_records_are_a_count_failure_and_nothing_else_is_compared() -> None:
    row = sc.score_borehole(truth(), document(), [record(), record()])
    assert row["count"].mismatch == 1
    assert all(row[m].compared == 0 for m in sc.METRICS if m != "count")


def test_uncodable_truth_petrography_is_not_comparable() -> None:
    t = truth(layers=[{"von": "0.0", "bis": "1.0", "Petrographie": "", "codes": {"petro": ""}}])
    row = sc.score_borehole(t, document(), [record(stratigraphy=[layer(1.0, "S")])])
    assert (row["din"].match, row["din"].mismatch, row["din"].not_comparable) == (0, 0, 1)


def test_a_layer_without_a_bottom_is_left_out() -> None:
    row = sc.score_borehole(truth(), document(), [record(stratigraphy=[layer(None, "S"), layer(1.0, "S"), layer(2.5, "G")])])
    assert row["boundaries"].match == 2


def test_an_unplotted_borehole_is_not_a_position_error() -> None:
    row = sc.score_borehole(truth(), document(), [record(plotted=False, unplotted_reason="crs_unconfirmed")])
    assert row["position"].not_comparable == 1 and row["unplotted_reason"] == "crs_unconfirmed"


def test_render_names_the_denominators() -> None:
    text = sc.render([sc.score_borehole(truth(), document(), [record()])], {"0000-2": "no own sheet"})
    assert "not comparable" in text and "0000-2" in text and "no own sheet" in text
```

- [ ] **Step 2: Run them, expect failure** (`score_borehole` not defined)
- [ ] **Step 3: Implement `score_borehole`, `totals`, `render`**
- [ ] **Step 4: Run the file, expect 11 passed**
- [ ] **Step 5: Commit** — `feat(eval): score a borehole against portal truth and render the report`

---

### Task 3: Command line over HTTP

**Files:**
- Modify: `backend/app/eval/lgrb_scorecard.py`
- Test: `backend/tests/test_lgrb_scorecard.py`

**Interfaces:**
- Consumes: `score_borehole`, `render`.
- Produces:
  - `own_sheets(folder: Path, borehole_id: str) -> list[Path]` — the borehole's own Schichtenverzeichnis files, `BO_<tk25>_<arnum zero-padded to 5>_SV_<n>(_x)?.pdf`, ordered by part number `<n>`. Range files and non-SV files never count.
  - `sheet_for_upload(folder: Path, borehole_id: str, joined_dir: Path) -> Path | str` — one own sheet: that file. Several: `joined_dir/<id>.pdf`, the parts joined in order with pypdfium2 (`PdfDocument.new()` and `import_pages`, as `sub_pdf` in `app/pipeline/ocr.py` does); an existing joined file is reused, never rebuilt, so a second run uploads the same bytes. None: the string `"no own sheet"`.
  - `sign_in(client: httpx.Client, email: str, password: str) -> None` — raises `SystemExit("Sign-in failed: …")` on 401.
  - `upload(client: httpx.Client, data_dir: Path, project: str) -> None` — for every `truth/*.json`: take `sheet_for_upload(data_dir/"pdf"/<id>, <id>, data_dir/"scorecard"/"joined")`, post it, and write `data_dir/scorecard/uploads.csv` with columns `id,file,document_id,reason` (reason filled and `document_id` empty for excluded boreholes). Answers 200 and 202 both give the id; 409 ends with `SystemExit("The app is in demo mode: set a provider key.")`.
  - `score(client: httpx.Client, data_dir: Path) -> Path` — reads `uploads.csv`, fetches document and records per row, writes `scorecard/report.md` and `scorecard/rows.csv`, returns the report path.
  - `main(argv: list[str] | None = None) -> int` — `python -m app.eval.lgrb_scorecard {upload,score} --data DIR [--base-url http://localhost:8000] [--project "LGRB Offenburg"] --email EMAIL`; the password comes from the environment variable `LGRB_SCORECARD_PASSWORD` only.

- [ ] **Step 1: Write the failing tests**

```python
def test_own_sheets_ignore_shared_and_profile_files_and_parts_are_joined(tmp_path: Path) -> None:
    folder = tmp_path / "0000-7"
    folder.mkdir()
    for name in ("BO_0000_00005-00009_SV_1_x.pdf", "BO_0000_00007_BP_1_x.pdf"):
        (folder / name).write_bytes(one_page_pdf())  # a one-page PDF made with pypdfium2 in the test file
    assert sc.sheet_for_upload(folder, "0000-7", tmp_path / "joined") == "no own sheet"
    for name in ("BO_0000_00007_SV_2_x.pdf", "BO_0000_00007_SV_1_x.pdf"):
        (folder / name).write_bytes(one_page_pdf())
    assert [p.name for p in sc.own_sheets(folder, "0000-7")] == ["BO_0000_00007_SV_1_x.pdf", "BO_0000_00007_SV_2_x.pdf"]
    joined = sc.sheet_for_upload(folder, "0000-7", tmp_path / "joined")
    assert joined == tmp_path / "joined" / "0000-7.pdf" and len(pdfium.PdfDocument(str(joined))) == 2
    before = joined.read_bytes()
    assert sc.sheet_for_upload(folder, "0000-7", tmp_path / "joined").read_bytes() == before  # reused


@respx.mock
def test_upload_twice_reuses_the_document(tmp_path: Path) -> None:
    make_data(tmp_path, "0000-7")  # truth/0000-7.json and its one own sheet
    route = respx.post("http://app.test/api/v1/documents").mock(
        side_effect=[
            httpx.Response(202, json={"document_id": "doc_1", "status": "queued", "duplicate_of": None}),
            httpx.Response(200, json={"document_id": "doc_1", "status": "needs_review", "duplicate_of": "doc_1"}),
        ]
    )
    with httpx.Client(base_url="http://app.test") as client:
        sc.upload(client, tmp_path, "Fictional project")
        sc.upload(client, tmp_path, "Fictional project")
    rows = list(csv.DictReader((tmp_path / "scorecard" / "uploads.csv").open(encoding="utf-8")))
    assert route.call_count == 2 and [r["document_id"] for r in rows] == ["doc_1"]


@respx.mock
def test_a_wrong_password_ends_with_one_line() -> None:
    respx.post("http://app.test/api/v1/auth/login").mock(return_value=httpx.Response(401, json={}))
    with httpx.Client(base_url="http://app.test") as client, pytest.raises(SystemExit, match="Sign-in failed"):
        sc.sign_in(client, "someone@example.org", "wrong")


@respx.mock
def test_score_writes_report_and_rows(tmp_path: Path) -> None:
    make_data(tmp_path, "0000-7", uploaded_as="doc_1")
    respx.get("http://app.test/api/v1/documents/doc_1").mock(return_value=httpx.Response(200, json=document()))
    respx.get("http://app.test/api/v1/documents/doc_1/boreholes").mock(
        return_value=httpx.Response(200, json=[record()])
    )
    with httpx.Client(base_url="http://app.test") as client:
        report = sc.score(client, tmp_path)
    assert report.read_text(encoding="utf-8").startswith("# LGRB scorecard")
    assert (tmp_path / "scorecard" / "rows.csv").exists()
```

- [ ] **Step 2: Run them, expect failure** (`own_sheet` not defined)
- [ ] **Step 3: Implement `own_sheet`, `sign_in`, `upload`, `score`, `main`, and `if __name__ == "__main__": raise SystemExit(main())`**
- [ ] **Step 4: Run the file (15 passed), then `ruff check .` and `ruff format --check .` in `backend/`**
- [ ] **Step 5: Commit** — `feat(eval): upload and score commands for the LGRB scorecard`

---

### Task 4: The run

No code. Needs the stack at `http://localhost:8000` in live mode and the harvest in `raw_data/lgrb-offenburg/`.

- [ ] **Step 1: Create a local ingest account** with `docker compose exec api python -m app.users create --email … --password …`; keep email and password in the worktree file `.env.ingest` (ignored by `.env.*`), never in chat or git.
- [ ] **Step 2: Upload** — `python -m app.eval.lgrb_scorecard upload --data <repo>/raw_data/lgrb-offenburg --email …`. Check: `scorecard/uploads.csv` has one row per truth file; note how many are excluded and why.
- [ ] **Step 3: Wait** until every uploaded document has status `needs_review`, `done` or `failed` (poll `GET /api/v1/documents/{id}`; run long waits in the background).
- [ ] **Step 4: Score** — `python -m app.eval.lgrb_scorecard score --data … --email …`. Read `scorecard/report.md`.
- [ ] **Step 5: Add the cost line by hand** to the report's side facts: total and per document from the ledger, `docker compose exec db psql -U geomemory -d geomemory -c "select count(distinct document_id), round(sum(cost_usd)::numeric, 3) from provider_calls where document_id in (…)"`.
- [ ] **Step 6: Spot-check three rows** (best, median, worst boundary recall) against the PDF and the review screen at `http://localhost:8081`, so a scoring bug is not reported as a reader error. Fix the scorer if one shows up; note anything odd in the report.

## Deviations from the spec, for the reader

- The coordinate test uses a point on the UTM 32 central meridian (longitude exactly 9.0), a sharper check than a sample value. Public LGRB values may be used in tests where they help (decided by Felix, 2026-11-15).
- The spec's three self-checks live in `backend/tests/test_lgrb_scorecard.py`, like every other check in this repo, not inside the script.
- The truth's main soil code is taken from the portal's own petrography code first and from its words second; the code is LGRB's own and needs no interpretation.
- One upload per borehole: its own Schichtenverzeichnis, with part files joined in order (12 of the 34 harvested boreholes come in 2 to 4 parts, mostly the deep ones; leaving them out would flatter the score). The 2 boreholes that only have a sheet shared with a neighbour are excluded and listed with the reason.
