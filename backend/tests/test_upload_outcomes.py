"""Every upload ends in a pin, a clear question, or a readable failure with a retry.

Each case is a FICTIONAL PDF generated here (every label, place, number and coordinate is invented) and runs
through the whole pipeline with the fake providers of app.providers.fakes: the classifier labels pages by
keywords, the OCR engine reads the PDF's own text layer, the extractor parses the fictional log layout. No
provider is called. Every API response is checked against the contract.

(a) a printed coordinate system           -> a pin on /map/boreholes.geojson
(b) coordinates without a system           -> not plotted (crs_unconfirmed) + one crs_confirm question with
                                              ranked candidates; the answer plots it
(c) no coordinates, a printed place        -> not plotted (no_coordinates) + one locate_borehole question;
                                              the map_point answer plots it
(d) no coordinates and no place            -> not plotted (no_coordinates), listed with its reason in
                                              GET /boreholes?plotted=false; no question is asked
(e) a provider failure                     -> failed with a readable error, failed_stage and job.failed;
                                              POST /retry finishes the document once the provider answers
(f) only narrative pages                   -> needs_review with found.boreholes 0, every page with the
                                              reason it was not used; nothing is read or extracted
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from pyproj import Transformer
from sqlalchemy import select

from app.db.models import Event
from app.db.session import get_sessionmaker
from app.pipeline import classify as classify_module
from app.pipeline import extract as extract_module
from app.pipeline.orchestrator import run_pipeline
from app.pipeline.schemas import ExtractionResult, PageLabel
from app.pipeline.types import ExtractionInput
from app.providers import ocr_mistral
from app.providers.base import ProviderError
from app.providers.fakes import FakeClassifier, FakeExtractor, FakeOcrEngine, label
from tests.contract_utils import validate_response
from tests.pdf_factory import TextItem, make_pdf

pytestmark = pytest.mark.db

SYSTEM = "ETRS89 / UTM 32N"
EPSG = "EPSG:25832"
# Fictional grid positions (south-west Germany in that system).
POINT_A = ("413 210,5", "5 316 044,2", (413210.5, 5316044.2))
POINT_B = ("413 480,0", "5 316 310,7", (413480.0, 5316310.7))
LAYERS = ("0,00 - 1,50  Sand, schluffig", "1,50 - 4,20  Ton, steif")


# ----------------------------------------------------------------------------------------------
# Fictional reports
# ----------------------------------------------------------------------------------------------


def log_page(hole: str, *header: str, layers: Sequence[str] = LAYERS, final: str = "4,20") -> list[TextItem]:
    """One log sheet in the fake extractor's layout: title, sheet, header lines, depth column, layers."""
    lines = [*header, "Depth (m)", *layers, f"Final depth {final} m"]
    items = [TextItem(60, 780, f"BOREHOLE LOG {hole}", 14), TextItem(60, 760, "SHEET 1 OF 1")]
    items += [TextItem(60, 740 - 20 * i, text) for i, text in enumerate(lines)]
    return items


def coordinates(point: tuple[str, str, Any], system: str | None) -> str:
    x, y, _ = point
    return f"Easting {x}  Northing {y}" + (f"  ({system})" if system else "")


def narrative(title: str, *sentences: str) -> list[TextItem]:
    return [TextItem(60, 780, title, 14)] + [
        TextItem(60, 750 - 20 * i, text) for i, text in enumerate(sentences)
    ]


def report(*pages: list[TextItem], cover: str) -> bytes:
    """A cover page (its title makes every report unique) followed by `pages`."""
    return make_pdf([[TextItem(120, 700, cover, 16), TextItem(120, 670, "COVER PAGE")], *pages])


_SHEET = re.compile(r"SHEET (\d+) OF (\d+)")


def classify_rule(text: str) -> PageLabel:
    """What a page classifier would say about the fictional pages."""
    if (match := re.search(r"BOREHOLE LOG (\S+)", text)) is not None:
        sheet = _SHEET.search(text)
        extra: dict[str, Any] = {}
        if sheet is not None:
            extra = {"sheet_label": sheet.group(0), "sheet_index": int(sheet.group(1))}
            extra["sheet_total"] = int(sheet.group(2))
        return label(
            "log_sheet",
            borehole_labels=[match.group(1)],
            has_coordinates="Easting" in text,
            has_depth_scale=True,
            **extra,
        )
    if "COVER PAGE" in text:
        return label("cover_or_toc")
    return label("narrative")


# ----------------------------------------------------------------------------------------------
# Providers: the fakes, behind switches that can fail like a real provider
# ----------------------------------------------------------------------------------------------


@dataclass
class SwitchedClassifier:
    inner: FakeClassifier
    error: Exception | None = None

    async def label(self, page: Any, image_png: bytes, text: str | None, *, escalate: bool) -> PageLabel:
        if self.error is not None:
            raise self.error
        return await self.inner.label(page, image_png, text, escalate=escalate)


@dataclass
class SwitchedExtractor:
    inner: FakeExtractor
    error: Exception | None = None
    failures: list[str] = field(default_factory=list)

    async def extract(
        self, inp: ExtractionInput, *, document_id: str
    ) -> tuple[ExtractionResult, str | None, float]:
        if self.error is not None:
            self.failures.append(inp.text.splitlines()[0])
            raise self.error
        return await self.inner.extract(inp, document_id=document_id)


@dataclass
class Providers:
    classifier: SwitchedClassifier
    ocr: FakeOcrEngine
    extractor: SwitchedExtractor

    def counts(self) -> tuple[int, int, int]:
        return self.classifier.inner.calls, self.ocr.calls, self.extractor.inner.calls


@pytest.fixture
def providers(monkeypatch: pytest.MonkeyPatch) -> Providers:
    """Inject the fakes where the pipeline builds its real providers."""
    found = Providers(
        SwitchedClassifier(FakeClassifier(classify_rule)),
        FakeOcrEngine(),
        SwitchedExtractor(FakeExtractor()),
    )
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: found.classifier)
    monkeypatch.setattr(ocr_mistral, "MistralOcrClient", lambda: found.ocr)
    monkeypatch.setattr(extract_module, "OpenRouterExtractor", lambda: found.extractor)
    return found


# ----------------------------------------------------------------------------------------------
# API helpers
# ----------------------------------------------------------------------------------------------


async def call(client: httpx.AsyncClient, method: str, path: str, *, expect: int, **kwargs: Any) -> Any:
    """One API call, checked against the contract; returns the parsed JSON body (or None)."""
    response = await client.request(method, path, **kwargs)
    assert response.status_code == expect, response.text
    content_type = response.headers.get("content-type", "application/json").split(";")[0]
    body = response.json() if response.content and "json" in content_type else None
    validate_response(method, path.split("?")[0], response.status_code, body, content_type)
    return body


async def upload(client: httpx.AsyncClient, data: bytes, name: str, *, project: str | None = None) -> str:
    form = {"project": project} if project else {}
    body = await call(
        client,
        "POST",
        "/api/v1/documents",
        expect=202,
        files={"file": (name, data, "application/pdf")},
        data=form,
    )
    assert body["status"] == "queued"
    return str(body["document_id"])


async def work(queue: Any, document_id: str) -> None:
    """Act as the worker: take the document's queued job, run the pipeline, mark the job finished."""
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
    body = await call(client, "GET", f"/api/v1/documents/{document_id}/boreholes", expect=200)
    return {r["metadata"]["borehole_id"]: r for r in body}


async def map_points(client: httpx.AsyncClient) -> dict[str, tuple[float, float]]:
    """Plotted features as uid -> (lon, lat)."""
    response = await client.get("/api/v1/map/boreholes.geojson")
    assert response.status_code == 200
    content_type = response.headers["content-type"].split(";")[0]
    layer = response.json()
    validate_response("GET", "/api/v1/map/boreholes.geojson", 200, layer, content_type)
    return {f["id"]: tuple(f["geometry"]["coordinates"]) for f in layer["features"]}


async def questions(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    body: list[dict[str, Any]] = await call(client, "GET", "/api/v1/clarifications", expect=200)
    return body


async def answer(client: httpx.AsyncClient, question: dict[str, Any], values: dict[str, Any]) -> None:
    url = f"/api/v1/clarifications/{question['clarification_id']}/answer"
    body = {"values": values, "answered_by": "fictional-reviewer"}
    assert (await call(client, "POST", url, expect=200, json=body))["status"] == "answered"


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


def lon_lat(point: tuple[str, str, tuple[float, float]]) -> tuple[float, float]:
    x, y = point[2]
    lon, lat = Transformer.from_crs(EPSG, "EPSG:4326", always_xy=True).transform(x, y)
    return float(lon), float(lat)


def assert_readable(message: str | None) -> None:
    """A sentence for a person: no exception names, tracebacks or internals."""
    assert message and message[0].isupper() and message.rstrip().endswith("."), message
    for internal in ("Traceback", "Error:", "Exception", "sqlalchemy", "  File ", "None"):
        assert internal not in message, message


async def assert_settled(client: httpx.AsyncClient, document_id: str) -> dict[str, Any]:
    """The document reached a state a person can act on: never stuck in queued/classifying/extracting."""
    doc = await document(client, document_id)
    assert doc["status"] in ("needs_review", "done", "failed"), doc["status"]
    if doc["status"] == "failed":
        assert_readable(doc["error"])
        assert doc["failed_stage"] is not None
    else:
        assert doc["error"] is None and doc["failed_stage"] is None
        assert doc["found"] is not None
    return doc


# ----------------------------------------------------------------------------------------------
# (a) A printed system: a pin
# ----------------------------------------------------------------------------------------------


async def test_a_printed_system_ends_in_a_pin(
    client: httpx.AsyncClient, live_mode: None, queue: Any, providers: Providers
) -> None:
    pdf = report(
        log_page(
            "OX-1",
            "Project: Fictional Quarry Road",
            "Project No.: FQ-0017",
            "Borehole name: Quarry gate well",
            "Borehole length 4,60 m",
            coordinates(POINT_A, SYSTEM),
        ),
        narrative("INTRODUCTION", "This fictional text describes the works on the site."),
        cover="FICTIONAL REPORT A",
    )
    doc_id = await upload(client, pdf, "fictional-a.pdf")
    await work(queue, doc_id)

    doc = await assert_settled(client, doc_id)
    assert doc["status"] == "needs_review" and doc["open_clarifications"] == 0
    assert doc["found"]["boreholes"] == 1
    (record,) = (await records(client, doc_id)).values()
    assert (record["crs_status"], record["plotted"], record["unplotted_reason"]) == ("stated", True, None)
    pins = await map_points(client)
    assert set(pins) == {record["uid"]}
    lon, lat = pins[record["uid"]]
    want_lon, want_lat = lon_lat(POINT_A)
    assert lon == pytest.approx(want_lon, abs=1e-5) and lat == pytest.approx(want_lat, abs=1e-5)
    assert (await call(client, "GET", "/api/v1/boreholes?plotted=false", expect=200))["count"] == 0

    # The target format's header fields arrive through the whole pipeline, each with its printed source.
    meta = record["metadata"]
    assert (meta["borehole_name"], meta["project_id"], meta["project_name"]) == (
        "Quarry gate well",
        "FQ-0017",
        "Fictional Quarry Road",
    )
    assert meta["borehole_length_m"] == 4.6 and meta["borehole_depth_m"] == 4.2
    for path in ("metadata.borehole_name", "metadata.project_id", "metadata.borehole_length_m"):
        entry = record["provenance"][path]
        assert entry["page"] == 2 and entry["box"] is not None and entry["method"] == "read", path
    assert record["provenance"]["metadata.borehole_length_m"]["raw"] == "4,60 m"


# ----------------------------------------------------------------------------------------------
# (b) Coordinates without a system: one question with ranked candidates; the answer plots
# ----------------------------------------------------------------------------------------------


async def test_coordinates_without_a_system_end_in_one_crs_question(
    client: httpx.AsyncClient, live_mode: None, queue: Any, providers: Providers
) -> None:
    pdf = report(
        log_page("OX-2", coordinates(POINT_A, None)),
        log_page("OX-3", coordinates(POINT_B, None)),
        cover="FICTIONAL REPORT B",
    )
    doc_id = await upload(client, pdf, "fictional-b.pdf")
    await work(queue, doc_id)

    doc = await assert_settled(client, doc_id)
    assert doc["status"] == "needs_review" and doc["open_clarifications"] == 1
    by_label = await records(client, doc_id)
    assert sorted(by_label) == ["OX-2", "OX-3"]
    for record in by_label.values():
        assert (record["crs_status"], record["plotted"]) == ("inferred", False)
        assert record["unplotted_reason"] == "crs_unconfirmed" and record["open_clarifications"] == 1
    assert await map_points(client) == {}
    not_on_map = await call(client, "GET", "/api/v1/boreholes?plotted=false", expect=200)
    assert {r["unplotted_reason"] for r in not_on_map["boreholes"]} == {"crs_unconfirmed"}

    asked = await questions(client)
    assert [q["kind"] for q in asked] == ["crs_confirm"]  # exactly one question for both boreholes
    question = asked[0]
    assert sorted(question["borehole_uids"]) == sorted(r["uid"] for r in by_label.values())
    assert question["evidence"] and question["evidence"][0]["page"] in (2, 3)
    picker = next(f for f in question["fields"] if f["name"] == "crs")
    assert picker["widget"] == "crs_picker" and picker["required"] is True
    options = [o["value"] for o in picker["options"]]
    assert options and all(v.startswith("EPSG:") for v in options) and len(set(options)) == len(options)
    assert EPSG in options  # the system that fits the printed values is offered
    # Ranked: the same order as the document's candidate list, best first.
    ranked = await call(client, "GET", f"/api/v1/documents/{doc_id}/crs-candidates", expect=200)
    ranked_codes = list(dict.fromkeys(c["crs"] for c in ranked))
    assert options == ranked_codes[: len(options)]

    await answer(client, question, {"crs": EPSG, "swap_axes": False})
    pins = await map_points(client)
    for label_text, point in (("OX-2", POINT_A), ("OX-3", POINT_B)):
        record = (await records(client, doc_id))[label_text]
        assert (record["crs_status"], record["plotted"], record["unplotted_reason"]) == (
            "confirmed",
            True,
            None,
        )
        lon, lat = pins[record["uid"]]
        want_lon, want_lat = lon_lat(point)
        assert lon == pytest.approx(want_lon, abs=1e-5) and lat == pytest.approx(want_lat, abs=1e-5)
    assert (await document(client, doc_id))["open_clarifications"] == 0


# ----------------------------------------------------------------------------------------------
# (c) No coordinates but a printed place: a locate_borehole question; the map point plots
# ----------------------------------------------------------------------------------------------


async def test_a_place_without_coordinates_ends_in_a_locate_question(
    client: httpx.AsyncClient, live_mode: None, queue: Any, providers: Providers
) -> None:
    place = "Fictional Town, Example Road 4"
    pdf = report(
        log_page("OX-4", "Project: Fictional Mill", f"Location: {place}"), cover="FICTIONAL REPORT C"
    )
    doc_id = await upload(client, pdf, "fictional-c.pdf")
    await work(queue, doc_id)

    doc = await assert_settled(client, doc_id)
    assert doc["status"] == "needs_review" and doc["open_clarifications"] == 1
    (record,) = (await records(client, doc_id)).values()
    assert (record["plotted"], record["unplotted_reason"]) == (False, "no_coordinates")
    assert record["metadata"]["location_name"] == place
    coords = record["metadata"]["coordinates"]
    assert all(coords[k] is None for k in ("x_raw", "y_raw", "latitude", "longitude"))

    (question,) = await questions(client)
    assert question["kind"] == "locate_borehole" and question["borehole_uids"] == [record["uid"]]
    assert place in question["question"]
    point_field = next(f for f in question["fields"] if f["widget"] == "map_point")
    assert point_field["required"] is True
    assert question["evidence"][0]["page"] == 2 and question["evidence"][0]["box"] is not None

    await answer(client, question, {point_field["name"]: {"lat": 48.0012, "lon": 7.8421}})
    pins = await map_points(client)
    assert pins[record["uid"]] == pytest.approx((7.8421, 48.0012))
    placed = (await records(client, doc_id))["OX-4"]
    assert (placed["plotted"], placed["unplotted_reason"]) == (True, None)
    assert placed["provenance"]["metadata.coordinates.latitude"]["method"] == "edited"
    assert (await document(client, doc_id))["open_clarifications"] == 0


# ----------------------------------------------------------------------------------------------
# (d) No coordinates and no place: listed as not on the map, with its reason
# ----------------------------------------------------------------------------------------------


async def test_no_coordinates_and_no_place_is_listed_not_on_map(
    client: httpx.AsyncClient, live_mode: None, queue: Any, providers: Providers
) -> None:
    pdf = report(log_page("OX-5", "Project: Fictional Ditch"), cover="FICTIONAL REPORT D")
    doc_id = await upload(client, pdf, "fictional-d.pdf")
    await work(queue, doc_id)

    doc = await assert_settled(client, doc_id)
    assert doc["status"] == "needs_review" and doc["found"]["boreholes"] == 1
    (record,) = (await records(client, doc_id)).values()
    assert (record["plotted"], record["unplotted_reason"], record["crs_status"]) == (
        False,
        "no_coordinates",
        "unknown",
    )
    not_on_map = await call(client, "GET", "/api/v1/boreholes?plotted=false", expect=200)
    assert not_on_map["count"] == 1
    assert [(r["uid"], r["unplotted_reason"]) for r in not_on_map["boreholes"]] == [
        (record["uid"], "no_coordinates")
    ]
    assert await map_points(client) == {}
    # Nothing to ask about: no question, and the record stays reviewable like any other.
    assert await questions(client) == [] and doc["open_clarifications"] == 0
    assert record["stratigraphy"] and record["metadata"]["borehole_depth_m"] == 4.2


# ----------------------------------------------------------------------------------------------
# (e) A provider failure: failed with a readable error; retry finishes it once the provider answers
# ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("stage", "error"),
    [
        ("classify", ProviderError("The page classifier did not answer in time.", retryable=True)),
        ("extract", ProviderError("The extraction model is overloaded. Try again later.", retryable=True)),
        ("extract", RuntimeError("fictional bug deep inside a provider client")),
    ],
)
async def test_a_provider_failure_is_readable_and_retry_finishes(
    client: httpx.AsyncClient,
    live_mode: None,
    queue: Any,
    providers: Providers,
    stage: str,
    error: Exception,
) -> None:
    if stage == "classify":
        providers.classifier.error = error
    else:
        providers.extractor.error = error
    pdf = report(log_page("OX-6", coordinates(POINT_A, SYSTEM)), cover=f"FICTIONAL REPORT E {stage}")
    doc_id = await upload(client, pdf, "fictional-e.pdf")
    await work(queue, doc_id)

    doc = await assert_settled(client, doc_id)
    assert doc["status"] == "failed" and doc["failed_stage"] == stage
    expected = (
        str(error)
        if isinstance(error, ProviderError)
        else f"Processing stopped during {stage}. Retry the document."
    )
    assert doc["error"] == expected
    assert "fictional bug" not in doc["error"]  # internals never reach the client
    assert await records(client, doc_id) == {}
    (failed,) = await events(doc_id, "job.failed")
    assert failed == {"document_id": doc_id, "stage": stage, "detail": doc["error"], "retryable": True}

    # The provider answers again: retry resumes after the last finished stage and ends in a pin.
    providers.classifier.error = providers.extractor.error = None
    retried = await call(client, "POST", f"/api/v1/documents/{doc_id}/retry", expect=202)
    assert retried == {"document_id": doc_id, "status": "queued", "duplicate_of": None}
    assert (await document(client, doc_id))["failed_stage"] is None
    await work(queue, doc_id)
    doc = await assert_settled(client, doc_id)
    assert doc["status"] == "needs_review" and doc["found"]["boreholes"] == 1
    (record,) = (await records(client, doc_id)).values()
    assert record["plotted"] is True and set(await map_points(client)) == {record["uid"]}
    if stage == "extract":
        assert providers.ocr.calls == 1  # the pages read before the failure are not read again
    assert len(await events(doc_id, "job.failed")) == 1


# ----------------------------------------------------------------------------------------------
# (f) Nothing to extract: a settled, readable document without boreholes
# ----------------------------------------------------------------------------------------------


async def test_a_document_without_logs_settles_with_no_boreholes(
    client: httpx.AsyncClient, live_mode: None, queue: Any, providers: Providers
) -> None:
    pdf = report(
        narrative("INTRODUCTION", "This fictional text describes a desk study.", "No ground was drilled."),
        narrative("CONCLUSIONS", "Further fictional investigation is recommended."),
        cover="FICTIONAL REPORT F",
    )
    doc_id = await upload(client, pdf, "fictional-f.pdf")
    await work(queue, doc_id)

    doc = await assert_settled(client, doc_id)
    assert doc["status"] == "needs_review"
    assert doc["found"] == {"boreholes": 0, "layers": 0, "spt": 0, "groundwater": 0}
    assert doc["open_clarifications"] == 0 and doc["completeness"] is None
    # Every page says why it was not used; nothing was read or extracted (nothing was paid for).
    assert [(p["n"], p["used"], p["ocr"], p["unused_reason"]) for p in doc["pages"]] == [
        (1, False, "skipped", "cover or contents page"),
        (2, False, "skipped", "narrative text"),
        (3, False, "skipped", "narrative text"),
    ]
    assert doc["progress"]["pages_classified"] == 3 and doc["progress"]["boreholes_extracted"] == 0
    assert providers.counts() == (3, 0, 0)
    assert await records(client, doc_id) == {} and await questions(client) == []
    # A rerun of the finished document changes nothing.
    await run_pipeline(doc_id)
    assert providers.counts() == (3, 0, 0)
    assert (await document(client, doc_id))["status"] == "needs_review"
