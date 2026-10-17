"""Upload -> triage -> classify -> OCR -> grouping -> extraction -> finalisation -> review, end to end.

Every document is a FICTIONAL PDF generated here; every label, place and value is invented. The providers are
fakes (app.providers.fakes): the classifier labels pages by keywords, the OCR engine reads the PDF's own text
layer (one block per printed line, with exact boxes) and the extractor parses the fictional log layout and
cites the blocks it read. No provider is called. Every API response is checked against the contract.
"""

from __future__ import annotations

import io
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
import pypdfium2 as pdfium
import pytest
from pyproj import Transformer
from sqlalchemy import func, select, update

from app.config import get_settings
from app.db.models import Borehole, Document, Event, ExtractionRun, OcrPage, ProviderCall
from app.db.session import get_sessionmaker
from app.pipeline import classify as classify_module
from app.pipeline import extract as extract_module
from app.pipeline import finalize as finalize_module
from app.pipeline import reread as reread_module
from app.pipeline.orchestrator import run_pipeline
from app.pipeline.schemas import PageLabel
from app.pipeline.types import ExtractionOutcome, PageGroup
from app.providers import ocr_mistral
from app.providers.base import ProviderError
from app.providers.fakes import (
    FakeClassifier,
    FakeExtractor,
    FakeOcrEngine,
    FakeRereader,
    _original_pages,
    label,
)
from app.providers.ocr_mistral import OcrResponse
from tests.contract_utils import validate_response
from tests.pdf_factory import TextItem, make_pdf

pytestmark = pytest.mark.db

PROJECT = "Fictional Depot Extension"
SYSTEM = "ETRS89 / UTM 32N"
# Printed (fictional) positions of the two logged boreholes in that system.
POINTS = {"FX-1": (413210.5, 5316044.2), "FX-2": (413480.0, 5316310.7)}
FX1_KEY, FX2_KEY = "FX1:p2-p3", "FX2:p4"


# ----------------------------------------------------------------------------------------------
# The fictional report
# ----------------------------------------------------------------------------------------------


def fictional_report(*, system: str | None = SYSTEM, title: str = "FICTIONAL GROUND INVESTIGATION") -> bytes:
    """Cover, two boreholes over three log sheets (FX-1 continues on a second sheet), a summary table that
    also lists FX-3 (which has no log) and a narrative page. One printed line per text item."""
    where = f"  ({system})" if system else ""
    return make_pdf(
        [
            [TextItem(120, 700, title, 16), TextItem(120, 670, "COVER PAGE")],
            [
                TextItem(60, 780, "BOREHOLE LOG FX-1", 14),
                TextItem(60, 760, "SHEET 1 OF 2"),
                TextItem(60, 740, f"Project: {PROJECT}"),
                TextItem(60, 720, f"Easting 413 210,5  Northing 5 316 044,2{where}"),
                TextItem(60, 690, "Depth (m)"),
                TextItem(60, 670, "0,00 - 1,20  Sand, schluffig"),
                TextItem(60, 650, "1,20 - 3,40  Kies, sandig"),
                TextItem(60, 630, "Groundwater at 2,10"),
            ],
            [
                TextItem(60, 780, "BOREHOLE FX-1 SHEET 2 OF 2", 14),
                TextItem(60, 690, "Depth (m)"),
                TextItem(60, 670, "3,40 - 6,00  Ton, steif"),
                TextItem(60, 650, "Final depth 6,00 m"),
            ],
            [
                TextItem(60, 780, "BOREHOLE LOG FX-2", 14),
                TextItem(60, 760, "SHEET 1 OF 1"),
                TextItem(60, 740, f"Project: {PROJECT}"),
                TextItem(60, 720, f"Easting 413 480,0  Northing 5 316 310,7{where}"),
                TextItem(60, 690, "Depth (m)"),
                TextItem(60, 670, "0,00 - 0,80  Mutterboden"),
                TextItem(60, 650, "0,80 - 4,50  Sand, kiesig"),
                TextItem(60, 630, "Final depth 4,50 m"),
            ],
            [
                TextItem(60, 780, "SUMMARY OF BOREHOLES", 14),
                TextItem(60, 750, "FX-1  6,00 m"),
                TextItem(60, 730, "FX-2  4,50 m"),
                TextItem(60, 710, "FX-3  5,00 m"),
            ],
            [
                TextItem(60, 780, "INTRODUCTION", 14),
                TextItem(60, 750, "This fictional text describes the works on the site."),
            ],
        ]
    )


_SHEET = re.compile(r"SHEET (\d+) OF (\d+)")


def classify_rule(text: str) -> PageLabel:
    """What a page classifier would say about the fictional pages."""
    sheet = _SHEET.search(text)
    sheet_fields: dict[str, Any] = {}
    if sheet is not None:
        index, total = int(sheet.group(1)), int(sheet.group(2))
        sheet_fields = {"sheet_label": sheet.group(0), "sheet_index": index, "sheet_total": total}
    if (match := re.search(r"BOREHOLE LOG (\S+)", text)) is not None:
        return label(
            "log_sheet",
            borehole_labels=[match.group(1)],
            has_coordinates="Easting" in text,
            has_depth_scale=True,
            **sheet_fields,
        )
    if (match := re.search(r"BOREHOLE (\S+) SHEET", text)) is not None:
        return label(
            "log_continuation",
            borehole_labels=[match.group(1)],
            has_depth_scale=True,
            is_continuation=True,
            **sheet_fields,
        )
    if "SUMMARY OF BOREHOLES" in text:
        return label("summary_table", borehole_labels=re.findall(r"\bFX-\d+\b", text))
    if "COVER PAGE" in text:
        return label("cover_or_toc")
    return label("narrative")


@dataclass
class Fakes:
    classifier: FakeClassifier
    ocr: FakeOcrEngine
    extractor: FakeExtractor

    def counts(self) -> tuple[int, int, int]:
        return self.classifier.calls, self.ocr.calls, self.extractor.calls


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch) -> Fakes:
    """Inject the fakes where the pipeline builds its real providers."""
    found = Fakes(FakeClassifier(classify_rule), FakeOcrEngine(), FakeExtractor())
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: found.classifier)
    monkeypatch.setattr(ocr_mistral, "MistralOcrClient", lambda: found.ocr)
    monkeypatch.setattr(extract_module, "OpenRouterExtractor", lambda: found.extractor)
    return found


@pytest.fixture
def settings_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """Set environment settings for one test; the settings cache is cleared before and after."""

    def set_env(**values: str) -> None:
        for key, value in values.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()

    yield set_env
    get_settings.cache_clear()


# ----------------------------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------------------------


async def call(client: httpx.AsyncClient, method: str, path: str, *, expect: int, **kwargs: Any) -> Any:
    """One API call, checked against the contract; returns the parsed JSON body (or None)."""
    response = await client.request(method, path, **kwargs)
    assert response.status_code == expect, response.text
    content_type = response.headers.get("content-type", "application/json").split(";")[0]
    body = response.json() if response.content and "json" in content_type else None
    validate_response(method, path.split("?")[0], response.status_code, body, content_type)
    return body


async def upload(client: httpx.AsyncClient, data: bytes, *, project: str | None = PROJECT) -> str:
    form = {"project": project} if project else {}
    body = await call(
        client,
        "POST",
        "/api/v1/documents",
        expect=202,
        files={"file": ("fictional-report.pdf", data, "application/pdf")},
        data=form,
    )
    assert body["status"] == "queued" and body["duplicate_of"] is None
    return str(body["document_id"])


async def work(queue: Any, document_id: str) -> None:
    """Act as the worker: take the queued job of the document, run the pipeline, mark the job finished."""
    jobs = [
        job
        for job in queue.jobs.values()
        if job["status"] == "todo" and job["args"] == {"document_id": document_id}
    ]
    assert [job["task_name"] for job in jobs] == ["process_document"]
    jobs[0]["status"] = "doing"
    await run_pipeline(document_id)
    await queue.finish_job_run(jobs[0]["id"], status="succeeded", delete_job=False)


async def document(client: httpx.AsyncClient, document_id: str) -> dict[str, Any]:
    body: dict[str, Any] = await call(client, "GET", f"/api/v1/documents/{document_id}", expect=200)
    return body


async def records(client: httpx.AsyncClient, document_id: str) -> dict[str, dict[str, Any]]:
    """The document's borehole records by printed label."""
    body = await call(client, "GET", f"/api/v1/documents/{document_id}/boreholes", expect=200)
    by_label = {r["metadata"]["borehole_id"]: r for r in body}
    assert len(by_label) == len(body)
    return by_label


async def map_points(client: httpx.AsyncClient) -> dict[str, tuple[float, float]]:
    """Plotted features as uid -> (lon, lat)."""
    response = await client.get("/api/v1/map/boreholes.geojson")
    assert response.status_code == 200
    content_type = response.headers["content-type"].split(";")[0]
    assert content_type == "application/geo+json"
    layer = response.json()
    validate_response("GET", "/api/v1/map/boreholes.geojson", 200, layer, content_type)
    return {f["id"]: tuple(f["geometry"]["coordinates"]) for f in layer["features"]}


def expected_lon_lat(label_text: str) -> tuple[float, float]:
    x, y = POINTS[label_text]
    lon, lat = Transformer.from_crs("EPSG:25832", "EPSG:4326", always_xy=True).transform(x, y)
    return float(lon), float(lat)


def _key(text: str) -> str:
    return " ".join(text.split())


async def ocr_blocks(document_id: str) -> dict[tuple[int, str], tuple[float, ...]]:
    """(page, printed line) -> the fake OCR block box as stored."""
    async with get_sessionmaker()() as session:
        rows = (await session.scalars(select(OcrPage).where(OcrPage.document_id == document_id))).all()
    return {(row.n, _key(b["text"])): tuple(b["box"]) for row in rows for b in row.blocks or []}


# The fake OCR rounds its line boxes to whole pixels; the text layer's word boxes are exact.
BOX_TOLERANCE = 2e-3


def inside(box: Sequence[float], outer: Sequence[float]) -> bool:
    return (
        box[0] >= outer[0] - BOX_TOLERANCE
        and box[1] >= outer[1] - BOX_TOLERANCE
        and box[0] + box[2] <= outer[0] + outer[2] + BOX_TOLERANCE
        and box[1] + box[3] <= outer[1] + outer[3] + BOX_TOLERANCE
    )


def assert_box(
    entry: dict[str, Any],
    blocks: dict[tuple[int, str], tuple[float, ...]],
    page: int,
    line: str,
    *,
    whole_line: bool = False,
) -> None:
    """The value's box is the box of its printed words inside the cited OCR line (the page has a text
    layer); `whole_line`: the value is the whole printed line."""
    line_box = blocks[(page, _key(line))]
    assert entry["page"] == page, entry
    assert entry["method"] in ("read", "derived", "guessed"), entry
    assert inside(entry["box"], line_box), (line, entry["box"], line_box)
    if whole_line:
        assert entry["box"] == pytest.approx(list(line_box), abs=BOX_TOLERANCE), (line, entry["box"])
    else:
        assert entry["box"][2] < line_box[2] - BOX_TOLERANCE, (line, entry["box"], line_box)


async def events(document_id: str, kind: str) -> list[dict[str, Any]]:
    async with get_sessionmaker()() as session:
        rows = (
            await session.scalars(
                select(Event.payload)
                .where(Event.document_id == document_id, Event.type == kind)
                .order_by(Event.id)
            )
        ).all()
    return [dict(r) for r in rows]


async def count(model: Any, document_id: str) -> int:
    async with get_sessionmaker()() as session:
        value = await session.scalar(
            select(func.count()).select_from(model).where(model.document_id == document_id)
        )
    return int(value or 0)


async def set_stage(document_id: str, stage: str) -> None:
    async with get_sessionmaker()() as session:
        await session.execute(update(Document).where(Document.id == document_id).values(stage=stage))
        await session.commit()


# ----------------------------------------------------------------------------------------------
# Upload to map, review, idempotent rerun
# ----------------------------------------------------------------------------------------------


async def test_upload_to_map_and_review(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes
) -> None:
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    assert doc["status"] == "needs_review" and doc["error"] is None
    pages = {p["n"]: p for p in doc["pages"]}
    assert {n: (p["role"], p["used"], p["ocr"]) for n, p in pages.items()} == {
        1: ("cover_or_toc", False, "skipped"),
        2: ("log_sheet", True, "done"),
        3: ("log_continuation", True, "done"),
        4: ("log_sheet", True, "done"),
        5: ("summary_table", True, "done"),
        6: ("narrative", False, "skipped"),
    }
    assert pages[1]["unused_reason"] == "cover or contents page"
    assert pages[6]["unused_reason"] == "narrative text"
    assert pages[3]["borehole_ids"] == ["FX-1"] and pages[3]["sheet_label"] == "SHEET 2 OF 2"
    assert doc["completeness"] == {
        "expected_ids": ["FX-1", "FX-2", "FX-3"],
        "found_ids": ["FX-1", "FX-2"],
        "missing": ["FX-3"],
        "unexpected": [],
    }
    assert doc["progress"]["boreholes_extracted"] == 2
    assert doc["progress"]["pages_ocr_total"] == doc["progress"]["pages_ocr_done"] == 4
    assert doc["found"] == {"boreholes": 2, "layers": 5, "spt": 0, "groundwater": 1}
    assert doc["open_clarifications"] == 0
    # 6 page labels, one OCR request with the 4 important pages, one extraction per borehole.
    assert fakes.counts() == (6, 1, 2) and fakes.ocr.pages_seen == 4
    first_input = next(i for i in fakes.extractor.inputs if "FX-1" in i.text.splitlines()[0])
    assert "=== page 5 (summary_table) ===" in first_input.context_text  # context reaches every group

    by_label = await records(client, doc_id)
    assert sorted(by_label) == ["FX-1", "FX-2"]
    fx1, fx2 = by_label["FX-1"], by_label["FX-2"]
    assert fx1["pages"] == [2, 3] and fx2["pages"] == [4]
    assert [(s["depth_from_m"], s["depth_to_m"]) for s in fx1["stratigraphy"]] == [
        (0.0, 1.2),
        (1.2, 3.4),
        (3.4, 6.0),
    ]
    assert [s["original_description"] for s in fx1["stratigraphy"]] == [
        "Sand, schluffig",
        "Kies, sandig",
        "Ton, steif",
    ]
    assert [s["din4023_code"] for s in fx1["stratigraphy"]] == ["S", "G", "T"]  # from the DIN vocabulary
    assert all(s["english_lithology"] is None for s in fx1["stratigraphy"])  # not given: never invented
    assert (
        fx1["metadata"]["borehole_depth_m"] == 6.0 and fx1["metadata"]["borehole_depth_source"] == "printed"
    )
    assert fx1["metadata"]["project_name"] == PROJECT
    (water,) = fx1["groundwater"]
    assert (water["type"], water["depth_m"], water["raw"], water["date"]) == ("strike", 2.1, "2,10", None)
    coords = fx1["metadata"]["coordinates"]
    assert (coords["local_x"], coords["local_y"]) == POINTS["FX-1"]
    assert coords["coordinate_system"] == SYSTEM and coords["crs_code"] == "EPSG:25832"
    for record in (fx1, fx2):
        assert record["crs_status"] == "stated" and record["plotted"] is True
        assert record["unplotted_reason"] is None and record["review_status"] == "unreviewed"
        assert record["revision"] == 1 and record["source_file"] == "fictional-report.pdf"
    assert fx2["metadata"]["borehole_depth_m"] == 4.5 and len(fx2["stratigraphy"]) == 2

    # Provenance: the boxes are the fake OCR boxes of the printed lines the extractor cited.
    blocks = await ocr_blocks(doc_id)
    prov = fx1["provenance"]
    assert_box(prov["metadata.borehole_id"], blocks, 2, "BOREHOLE LOG FX-1")
    assert_box(prov["metadata.project_name"], blocks, 2, f"Project: {PROJECT}")
    coordinate_line = "Easting 413 210,5 Northing 5 316 044,2 (ETRS89 / UTM 32N)"
    for path in ("x_raw", "y_raw", "coordinate_system", "local_x", "local_y", "latitude", "longitude"):
        assert_box(prov[f"metadata.coordinates.{path}"], blocks, 2, coordinate_line)
    assert_box(prov["stratigraphy[0].depth_from_m"], blocks, 2, "0,00 - 1,20 Sand, schluffig")
    assert_box(prov["stratigraphy[1].original_description"], blocks, 2, "1,20 - 3,40 Kies, sandig")
    assert_box(prov["stratigraphy[2].depth_to_m"], blocks, 3, "3,40 - 6,00 Ton, steif")
    assert_box(prov["metadata.borehole_depth_m"], blocks, 3, "Final depth 6,00 m")
    assert_box(prov["groundwater[0].depth_m"], blocks, 2, "Groundwater at 2,10")
    assert_box(fx2["provenance"]["stratigraphy[1].depth_to_m"], blocks, 4, "0,80 - 4,50 Sand, kiesig")
    assert prov["stratigraphy[0].depth_from_m"]["raw"] == "0,00"
    assert prov["metadata.coordinates.x_raw"]["raw"] == "413 210,5"
    assert prov["stratigraphy[0].din4023_code"]["method"] == "derived"
    for record in (fx1, fx2):
        for path, entry in record["provenance"].items():
            assert entry["document_id"] == doc_id, path
            assert entry["box"] is not None, path  # every value points into a printed line
            assert any(
                page == entry["page"] and inside(entry["box"], box) for (page, _), box in blocks.items()
            ), path

    # The stated system plots both boreholes where the printed coordinates are.
    plotted = await map_points(client)
    assert set(plotted) == {fx1["uid"], fx2["uid"]}
    for record in (fx1, fx2):
        lon, lat = plotted[record["uid"]]
        want_lon, want_lat = expected_lon_lat(record["metadata"]["borehole_id"])
        assert lon == pytest.approx(want_lon, abs=1e-5) and lat == pytest.approx(want_lat, abs=1e-5)
        assert 7.5 < lon < 8.2 and 47.8 < lat < 48.2  # south-west Germany for this fictional grid point

    # Review: an edit and an approval persist; approve-clean approves what is clean and nothing twice.
    values = f"/api/v1/boreholes/{fx1['uid']}/values"
    edit = {
        "path": "stratigraphy[0].original_description",
        "action": "edit",
        "value": "Sand, schluffig, braun",
    }
    await call(client, "PATCH", values, expect=200, json={**edit, "if_revision": 1})
    await call(
        client, "PATCH", values, expect=200, json={"path": "metadata.borehole_id", "action": "approve"}
    )
    reloaded = await call(client, "GET", f"/api/v1/boreholes/{fx1['uid']}", expect=200)
    assert reloaded["revision"] == 3 and reloaded["review_status"] == "in_review"
    assert reloaded["stratigraphy"][0]["original_description"] == "Sand, schluffig, braun"
    edited = reloaded["provenance"]["stratigraphy[0].original_description"]
    assert (
        edited["method"] == "edited"
        and edited["ai_value"] == "Sand, schluffig"
        and edited["status"] == "unreviewed"
    )
    assert reloaded["provenance"]["metadata.borehole_id"]["status"] == "approved"
    clean_url = f"/api/v1/documents/{doc_id}/approve-clean"
    dry = await call(client, "POST", clean_url, expect=200)
    assert dry["count"] > 0
    done = await call(
        client, "POST", f"{clean_url}?dry_run=false&confirmed_by=fictional-reviewer", expect=200
    )
    assert done["count"] == dry["count"]
    assert (await call(client, "POST", clean_url, expect=200))["count"] == 0
    after = await records(client, doc_id)
    approved = [p for p, e in after["FX-1"]["provenance"].items() if e["status"] == "approved"]
    assert "stratigraphy[0].depth_from_m" in approved and "metadata.borehole_id" in approved
    assert after["FX-1"]["stratigraphy"][0]["original_description"] == "Sand, schluffig, braun"
    revisions_before = {label_text: r["revision"] for label_text, r in after.items()}

    # Idempotent: a rerun calls nothing; rerunning the extraction stage creates nothing and keeps the review.
    calls = fakes.counts()
    await run_pipeline(doc_id)
    await set_stage(doc_id, "ocr")
    await run_pipeline(doc_id)
    assert fakes.counts() == calls
    assert await count(Borehole, doc_id) == 2 and await count(ExtractionRun, doc_id) == 2
    assert len(await events(doc_id, "borehole.created")) == 2
    again = await records(client, doc_id)
    assert {label_text: r["revision"] for label_text, r in again.items()} == revisions_before
    assert again["FX-1"]["stratigraphy"][0]["original_description"] == "Sand, schluffig, braun"
    final = await document(client, doc_id)
    assert final["status"] == "needs_review" and final["completeness"]["missing"] == ["FX-3"]


# ----------------------------------------------------------------------------------------------
# Resume after a crash between two groups
# ----------------------------------------------------------------------------------------------


async def test_crash_after_first_group_resumes_without_repeating_calls(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_finalize = finalize_module.finalize_group
    crashes: list[str] = []

    async def crash_once(document_id: str, group: PageGroup, outcome: ExtractionOutcome) -> str | None:
        if group.key == FX2_KEY and not crashes:
            crashes.append(group.key)
            raise RuntimeError("simulated worker crash")
        return await real_finalize(document_id, group, outcome)

    monkeypatch.setattr(finalize_module, "finalize_group", crash_once)
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    assert (
        doc["status"] == "failed" and doc["error"] == "Processing stopped during extract. Retry the document."
    )
    assert "simulated" not in doc["error"]  # internals never reach the client
    assert crashes == [FX2_KEY]
    assert sorted(await records(client, doc_id)) == ["FX-1"]  # the first group committed on its own
    assert doc["progress"]["boreholes_extracted"] == 1
    failed = await events(doc_id, "job.failed")
    assert failed == [{"document_id": doc_id, "stage": "extract", "detail": doc["error"], "retryable": True}]
    calls = fakes.counts()
    assert calls[2] == 2  # both groups were extracted; only the second one's finalisation crashed

    retry = await call(client, "POST", f"/api/v1/documents/{doc_id}/retry", expect=202)
    assert retry == {"document_id": doc_id, "status": "queued", "duplicate_of": None}
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    assert doc["status"] == "needs_review" and doc["error"] is None
    assert fakes.counts() == calls  # nothing classified, read or extracted again
    by_label = await records(client, doc_id)
    assert sorted(by_label) == ["FX-1", "FX-2"] and by_label["FX-1"]["revision"] == 1
    assert await count(Borehole, doc_id) == 2
    async with get_sessionmaker()() as session:
        runs = (await session.scalars(select(ExtractionRun).where(ExtractionRun.document_id == doc_id))).all()
    assert sorted((r.group_id, r.status) for r in runs) == [(FX1_KEY, "done"), (FX2_KEY, "done")]
    assert len(await events(doc_id, "borehole.created")) == 2


# ----------------------------------------------------------------------------------------------
# Pages whose OCR failed hold back their borehole until a retry reads them
# ----------------------------------------------------------------------------------------------


@dataclass
class FlakyOcr:
    """Fails (retryably) the first request whose pages print `marker`, then answers like `inner`."""

    inner: FakeOcrEngine
    marker: str
    failed: list[int] = field(default_factory=list)
    # Set by the OCR stage: the request is an image-only PDF of renders, so the text is read from these
    # pages of the original (like FakeOcrEngine does).
    current_pages: list[int] | None = None

    async def ocr(self, data: bytes, mime: str, *, document_id: str | None, page_count: int) -> OcrResponse:
        texts: list[str] = []
        original = await _original_pages(document_id, self.current_pages)
        self.inner.current_pages = self.current_pages
        pdf = pdfium.PdfDocument(io.BytesIO(original if original is not None else data))
        try:
            for index in range(len(pdf)):
                page = pdf[index]
                textpage = page.get_textpage()
                texts.append(textpage.get_text_range())
                textpage.close()
                page.close()
        finally:
            pdf.close()
        if self.marker in " ".join(texts) and not self.failed:
            self.failed.append(page_count)
            raise ProviderError("Mistral OCR did not answer in time.", retryable=True)
        return await self.inner.ocr(data, mime, document_id=document_id, page_count=page_count)


async def test_unread_pages_hold_back_their_borehole_until_retry(
    client: httpx.AsyncClient,
    live_mode: None,
    queue: Any,
    fakes: Fakes,
    monkeypatch: pytest.MonkeyPatch,
    settings_env: Any,
) -> None:
    settings_env(OCR_MAX_PAGES_PER_REQUEST="1")  # one OCR request per page
    flaky = FlakyOcr(fakes.ocr, "BOREHOLE LOG FX-2")
    monkeypatch.setattr(ocr_mistral, "MistralOcrClient", lambda: flaky)
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    assert doc["status"] == "failed" and flaky.failed == [1]
    assert doc["error"] == (
        "Text could not be read on page(s) 4, so the boreholes on them were not extracted yet. "
        "Retry the document to read these pages again."
    )
    assert {p["n"]: p["ocr"] for p in doc["pages"] if p["used"]} == {
        2: "done",
        3: "done",
        4: "failed",
        5: "done",
    }
    assert sorted(await records(client, doc_id)) == ["FX-1"]  # the readable group went ahead
    assert fakes.extractor.calls == 1 and doc["completeness"] is None  # the document is not closed yet
    assert (await events(doc_id, "job.failed"))[-1]["retryable"] is True
    async with get_sessionmaker()() as session:
        stored = await session.get(Document, doc_id)
        assert stored is not None and stored.stage == "classify"  # rewound so a retry reads page 4 again

    await call(client, "POST", f"/api/v1/documents/{doc_id}/retry", expect=202)
    ocr_calls = fakes.ocr.calls
    await work(queue, doc_id)
    doc = await document(client, doc_id)
    assert doc["status"] == "needs_review" and doc["completeness"]["missing"] == ["FX-3"]
    assert fakes.ocr.calls == ocr_calls + 1  # only page 4 is read again
    assert fakes.extractor.calls == 2 and sorted(await records(client, doc_id)) == ["FX-1", "FX-2"]


# ----------------------------------------------------------------------------------------------
# Coordinates without a printed system: asked once, plotted after the answer
# ----------------------------------------------------------------------------------------------


async def test_unstated_system_is_asked_once_and_the_answer_plots(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes
) -> None:
    doc_id = await upload(
        client, fictional_report(system=None, title="FICTIONAL SITE WITHOUT SYSTEM"), project=None
    )
    await work(queue, doc_id)

    by_label = await records(client, doc_id)
    assert sorted(by_label) == ["FX-1", "FX-2"]
    for record in by_label.values():
        assert record["crs_status"] == "inferred" and record["plotted"] is False
        assert record["unplotted_reason"] == "crs_unconfirmed"
        coords = record["metadata"]["coordinates"]
        assert (
            coords["coordinate_system"] is None and coords["latitude"] is None and coords["longitude"] is None
        )
        assert record["open_clarifications"] == 1
    assert await map_points(client) == {}
    questions = await call(client, "GET", "/api/v1/clarifications", expect=200)
    crs_questions = [q for q in questions if q["kind"] == "crs_confirm"]
    assert len(crs_questions) == 1 and len(questions) == 1
    question = crs_questions[0]
    assert question["document_id"] == doc_id and question["status"] == "open"
    assert sorted(question["borehole_uids"]) == sorted(r["uid"] for r in by_label.values())
    doc = await document(client, doc_id)
    assert doc["status"] == "needs_review" and doc["open_clarifications"] == 1

    answer = {"values": {"crs": "EPSG:25832", "swap_axes": False}, "answered_by": "fictional-reviewer"}
    url = f"/api/v1/clarifications/{question['clarification_id']}/answer"
    answered = await call(client, "POST", url, expect=200, json=answer)
    assert answered["status"] == "answered"

    plotted = await map_points(client)
    by_label = await records(client, doc_id)
    assert set(plotted) == {r["uid"] for r in by_label.values()}
    for label_text, record in by_label.items():
        assert record["crs_status"] == "confirmed" and record["plotted"] is True
        lon, lat = plotted[record["uid"]]
        want_lon, want_lat = expected_lon_lat(label_text)
        assert lon == pytest.approx(want_lon, abs=1e-5) and lat == pytest.approx(want_lat, abs=1e-5)
    assert (await document(client, doc_id))["open_clarifications"] == 0


# ----------------------------------------------------------------------------------------------
# Provider budget
# ----------------------------------------------------------------------------------------------


async def test_budget_stops_the_pipeline_with_a_readable_reason(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, settings_env: Any
) -> None:
    async with get_sessionmaker()() as session:  # spend recorded by earlier (fictional) calls
        session.add(ProviderCall(provider="fake", purpose="extract", model="fake-extractor", cost_usd=2.0))
        await session.commit()
    settings_env(PROVIDER_BUDGET_USD="1.5")
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    assert doc["status"] == "failed"
    assert doc["error"] == (
        "The provider budget of 1.50 USD is used up (2.00 USD spent). Raise PROVIDER_BUDGET_USD to go on."
    )
    assert (await events(doc_id, "job.failed"))[-1] == {
        "document_id": doc_id,
        "stage": "extract",
        "detail": doc["error"],
        "retryable": False,
    }
    assert fakes.extractor.calls == 0 and await records(client, doc_id) == {}

    settings_env(PROVIDER_BUDGET_USD="10")
    await call(client, "POST", f"/api/v1/documents/{doc_id}/retry", expect=202)
    await work(queue, doc_id)
    assert (await document(client, doc_id))["status"] == "needs_review"
    assert fakes.extractor.calls == 2 and sorted(await records(client, doc_id)) == ["FX-1", "FX-2"]


# ----------------------------------------------------------------------------------------------
# A partly handwritten page: second reads and one choose_reading question
# ----------------------------------------------------------------------------------------------


async def test_handwritten_page_gets_second_reads_and_one_question(
    client: httpx.AsyncClient, live_mode: None, queue: Any, fakes: Fakes, monkeypatch: pytest.MonkeyPatch
) -> None:
    def partly_handwritten(text: str) -> PageLabel:
        page_label = classify_rule(text)
        if "BOREHOLE LOG FX-2" in text:
            return page_label.model_copy(update={"handwriting": "partial"})
        return page_label

    fakes.classifier.rule = partly_handwritten
    # The second reader sees one word of the handwritten page differently.
    rereader = FakeRereader(replace={"Mutterboden": "Mutterbaden"})
    monkeypatch.setattr(reread_module, "OpenRouterRereader", lambda: rereader)
    doc_id = await upload(client, fictional_report())
    await work(queue, doc_id)

    doc = await document(client, doc_id)
    assert doc["status"] == "needs_review" and doc["error"] is None
    assert doc["progress"]["boreholes_extracted"] == 2
    assert {p["n"]: p.get("handwriting") for p in doc["pages"] if p["used"]}[4] == "partial"
    # One call for the values of page 4; FX-1 (pages 2-3) is printed and confident and is not read again.
    assert rereader.calls == 1 and len(rereader.crops) == rereader.batches[0] > 0
    printed = " ".join(c.printed for c in rereader.crops)
    assert "Mutterboden" in printed and "FX-2" in printed and "FX-1" not in printed

    by_label = await records(client, doc_id)
    fx1, fx2 = by_label["FX-1"], by_label["FX-2"]
    assert fx1["revision"] == 1 and fx1["open_clarifications"] == 0
    path = "stratigraphy[0].original_description"
    entry = fx2["provenance"][path]
    assert entry["readings"] == [
        {"reader": "ocr", "text": "Mutterboden", "confidence": 0.97},
        {"reader": "reread", "text": "Mutterbaden", "confidence": 0.9},
    ]
    assert entry["status"] == "unreviewed" and fx2["stratigraphy"][0]["original_description"] == "Mutterboden"
    assert [p for p, e in fx2["provenance"].items() if e["readings"]] == [path]  # the rest agreed
    assert fx2["revision"] == 2 and fx2["open_clarifications"] == 1
    assert fx2["review_status"] == "unreviewed"

    questions = await call(client, "GET", "/api/v1/clarifications", expect=200)
    assert [q["kind"] for q in questions] == ["choose_reading"]
    question = questions[0]
    assert question["borehole_uids"] == [fx2["uid"]] and question["path"] == path
    (form,) = question["fields"]
    assert form["name"] == "reading" and form["widget"] == "choose_reading"
    assert [o["value"] for o in form["options"]] == ["Mutterboden", "Mutterbaden"]
    for option in form["options"]:
        assert (option["evidence"]["page"], option["evidence"]["box"]) == (4, entry["box"])

    # Rerunning the stage pays nothing, changes nothing and asks nothing new.
    await set_stage(doc_id, "extract")
    await run_pipeline(doc_id)
    assert rereader.calls == 1
    assert len(await call(client, "GET", "/api/v1/clarifications", expect=200)) == 1
    assert (await records(client, doc_id))["FX-2"]["revision"] == 2
    assert (await document(client, doc_id))["status"] == "needs_review"

    # The answer edits and approves the chosen reading.
    url = f"/api/v1/clarifications/{question['clarification_id']}/answer"
    answer = {"values": {"reading": "Mutterbaden"}, "answered_by": "fictional-reviewer"}
    assert (await call(client, "POST", url, expect=200, json=answer))["status"] == "answered"
    fx2 = (await records(client, doc_id))["FX-2"]
    assert fx2["stratigraphy"][0]["original_description"] == "Mutterbaden"
    assert fx2["provenance"][path]["status"] == "approved" and fx2["open_clarifications"] == 0
