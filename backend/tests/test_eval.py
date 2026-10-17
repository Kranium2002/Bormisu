"""FICTIONAL evaluation harness tests (app.eval). Every file, label, place and number here is invented.

The data folder is generated in a temporary directory (vector PDFs in the fictional log layout that
app.providers.fakes understands) together with an expected-results file in the data audit's shape. The real
pipeline runs in-process with the fake providers injected where it builds its real ones, as in
tests/test_pipeline_e2e.py. No provider is called.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
import pytest
from PIL import Image
from sqlalchemy import func, select

from app.config import get_settings
from app.db.models import Document, ProviderCall
from app.db.session import get_sessionmaker
from app.eval import cli
from app.eval.compare import ActualBorehole, compare_file
from app.eval.expected import (
    ExpectedFileError,
    find_entry,
    mentions,
    parse_expected,
    parse_pages,
    squash,
)
from app.eval.plan import PlanError, build_plan, excerpt_pdf, parse_pages_arg
from app.eval.report import render, write_report
from app.eval.runner import run_eval
from app.pipeline import classify as classify_module
from app.pipeline import extract as extract_module
from app.pipeline import reread as reread_module
from app.pipeline.schemas import PageLabel
from app.providers import ocr_mistral
from app.providers.fakes import FakeClassifier, FakeExtractor, FakeOcrEngine, FakeRereader, label
from tests.pdf_factory import TextItem, make_pdf

MAX_PAGES = 5000

# ----------------------------------------------------------------------------------------------
# The fictional data folder
# ----------------------------------------------------------------------------------------------

PROJECT = "Imaginary Quarry Lane"
SYSTEM = "ETRS89 / UTM 32N"
LABELS = ("QX-11", "QX-12", "QX-13", "QX-14", "QY-21")
# Printed text of the fictional values; none of it may reach the report.
PRINTED = (
    "512 345,6",
    "5 412 987,1",
    "512 601,3",
    "5 413 102,8",
    "413 377,0",
    "5 316 512,4",
    "7,35",
    "4,85",
    "2,65",
    "3,95",
)
NUMBERS = ("512345", "5412987", "512601", "5413102", "413377", "5316512", "7.35", "4.85", "2.65", "3.95")

QX12_PAGE = [
    TextItem(60, 780, "BOREHOLE LOG QX-12", 14),
    TextItem(60, 760, "SHEET 1 OF 1"),
    TextItem(60, 740, f"Project: {PROJECT}"),
    TextItem(60, 720, f"Easting 512 601,3  Northing 5 413 102,8  ({SYSTEM})"),
    TextItem(60, 690, "Depth (m)"),
    TextItem(60, 670, "0,00 - 0,70  Mutterboden"),
    TextItem(60, 650, "0,70 - 4,85  Sand, kiesig"),
    TextItem(60, 630, "Final depth 4,85 m"),
    *(TextItem(60, 600 - 18 * i, f"Fictional remark line {i} of the imaginary log form") for i in range(12)),
]


def alpha_pdf() -> bytes:
    """Cover, QX-11 over two sheets, QX-12, QX-13 without coordinates, a narrative page."""
    return make_pdf(
        [
            [TextItem(120, 700, "FICTIONAL ALPHA SURVEY", 16), TextItem(120, 670, "COVER PAGE")],
            [
                TextItem(60, 780, "BOREHOLE LOG QX-11", 14),
                TextItem(60, 760, "SHEET 1 OF 2"),
                TextItem(60, 740, f"Project: {PROJECT}"),
                TextItem(60, 720, f"Easting 512 345,6  Northing 5 412 987,1  ({SYSTEM})"),
                TextItem(60, 690, "Depth (m)"),
                TextItem(60, 670, "0,00 - 1,10  Sand, schluffig"),
                TextItem(60, 650, "1,10 - 2,90  Kies, sandig"),
            ],
            [
                TextItem(60, 780, "BOREHOLE QX-11 SHEET 2 OF 2", 14),
                TextItem(60, 690, "Depth (m)"),
                TextItem(60, 670, "2,90 - 7,35  Ton, steif"),
                TextItem(60, 650, "Final depth 7,35 m"),
            ],
            QX12_PAGE,
            [
                TextItem(60, 780, "BOREHOLE LOG QX-13", 14),
                TextItem(60, 760, "SHEET 1 OF 1"),
                TextItem(60, 690, "Depth (m)"),
                TextItem(60, 670, "0,00 - 2,65  Schluff, tonig"),
                TextItem(60, 650, "Final depth 2,65 m"),
            ],
            [
                TextItem(60, 780, "INTRODUCTION", 14),
                TextItem(60, 750, "This fictional text describes imaginary works."),
            ],
        ]
    )


def beta_pdf() -> bytes:
    """A repeat of alpha's QX-12 page, then QY-21 with coordinates but no printed system."""
    return make_pdf(
        [
            QX12_PAGE,
            [
                TextItem(60, 780, "BOREHOLE LOG QY-21", 14),
                TextItem(60, 760, "SHEET 1 OF 1"),
                TextItem(60, 720, "Easting 413 377,0  Northing 5 316 512,4"),
                TextItem(60, 690, "Depth (m)"),
                TextItem(60, 670, "0,00 - 3,95  Sand, schluffig"),
                TextItem(60, 650, "Final depth 3,95 m"),
            ],
        ]
    )


def expected_entries(*, with_pages: bool = True) -> list[dict[str, Any]]:
    """Expected results in the audit's shape. Two values are wrong on purpose: QX-11's depth and QX-14,
    which no page of the file logs."""

    def pages(value: str) -> dict[str, str]:
        return {"pages": value} if with_pages else {}

    return [
        {
            "doc": "QA-ALPHA.pdf",
            "borehole_count": 4,
            "boreholes": [
                {
                    "id": "QX-11",
                    **pages("2-3"),
                    "coordinates": "Easting 512 345,6 / Northing 5 412 987,1",
                    "crs_datum": "fictional datum note",
                    "total_depth": "7,50 m",
                },
                {
                    "id": "QX 12",
                    **pages("p. 4"),
                    "coordinates": "E 512601,3; N 5413102,8",
                    "crs_status": "stated",
                    "unplotted_reason": None,
                    "total_depth": "4,85 m",
                    "layer_count": 2,
                },
                {"id": "QX-13", **pages("5"), "coordinates": "none printed", "total_depth": "2,65 m"},
                {"id": "QX-14", **pages("6"), "coordinates": "none printed"},
            ],
            "cross_file_links": "none",
        },
        {
            "doc": "QA-BETA.pdf",
            "borehole_count": 1,
            "boreholes": [
                {
                    "id": "QY-21",
                    **pages("2"),
                    "coordinates": "Easting 413 377,0 Northing 5 316 512,4",
                    "crs_status": "inferred",
                    "unplotted_reason": "crs_unconfirmed",
                    "total_depth": "3,95 m",
                    "layer_count": 1,
                },
            ],
            "cross_file_links": "Its first page repeats a log page of QA-ALPHA.",
        },
    ]


@dataclass
class Folder:
    data: Path
    expected: Path
    alpha: Path
    beta: Path


def write_folder(root: Path, *, with_pages: bool = True) -> Folder:
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    alpha, beta = data / "QA-ALPHA.pdf", data / "QA-BETA.pdf"
    alpha.write_bytes(alpha_pdf())
    beta.write_bytes(beta_pdf())
    expected = root / "expected.json"
    expected.write_text(json.dumps(expected_entries(with_pages=with_pages)), encoding="utf-8")
    return Folder(data, expected, alpha, beta)


@pytest.fixture
def folder(tmp_path: Path) -> Folder:
    return write_folder(tmp_path)


# ----------------------------------------------------------------------------------------------
# Fake providers
# ----------------------------------------------------------------------------------------------

_SHEET = re.compile(r"SHEET (\d+) OF (\d+)")


def classify_rule(text: str) -> PageLabel:
    """What a page classifier would say about the fictional pages."""
    sheet = _SHEET.search(text)
    fields: dict[str, Any] = {}
    if sheet is not None:
        fields = {
            "sheet_label": sheet.group(0),
            "sheet_index": int(sheet.group(1)),
            "sheet_total": int(sheet.group(2)),
        }
    if (match := re.search(r"BOREHOLE LOG (\S+)", text)) is not None:
        return label(
            "log_sheet",
            borehole_labels=[match.group(1)],
            has_coordinates="Easting" in text,
            has_depth_scale=True,
            **fields,
        )
    if (match := re.search(r"BOREHOLE (\S+) SHEET", text)) is not None:
        return label(
            "log_continuation",
            borehole_labels=[match.group(1)],
            has_depth_scale=True,
            is_continuation=True,
            **fields,
        )
    if "COVER PAGE" in text:
        return label("cover_or_toc")
    return label("narrative")


@dataclass
class Fakes:
    classifier: FakeClassifier
    ocr: FakeOcrEngine
    extractor: FakeExtractor
    rereader: FakeRereader

    def counts(self) -> tuple[int, int, int]:
        return self.classifier.calls, self.ocr.calls, self.extractor.calls


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch) -> Fakes:
    found = Fakes(FakeClassifier(classify_rule), FakeOcrEngine(), FakeExtractor(), FakeRereader())
    monkeypatch.setattr(classify_module, "OpenRouterClassifier", lambda _doc: found.classifier)
    monkeypatch.setattr(ocr_mistral, "MistralOcrClient", lambda: found.ocr)
    monkeypatch.setattr(extract_module, "OpenRouterExtractor", lambda: found.extractor)
    monkeypatch.setattr(reread_module, "OpenRouterRereader", lambda: found.rereader)
    return found


@pytest.fixture
def settings_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    def set_env(**values: str) -> None:
        for key, value in values.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()

    yield set_env
    get_settings.cache_clear()


def plan_files(folder: Folder, *names: str, pages: tuple[str, ...] = ()) -> list[Any]:
    entries = parse_expected(json.loads(folder.expected.read_text(encoding="utf-8")), max_pages=MAX_PAGES)
    return build_plan(folder.data, entries, names=list(names), pages=pages).files


async def document_count() -> int:
    async with get_sessionmaker()() as session:
        return int(await session.scalar(select(func.count()).select_from(Document)) or 0)


def assert_no_values(report: str) -> None:
    """The report names no fictional value: no label, coordinate, depth, project or file name."""
    folded = report.casefold()
    for text in (*LABELS, *(lab.replace("-", "") for lab in LABELS), PROJECT, SYSTEM, *PRINTED, *NUMBERS):
        assert text.casefold() not in folded, text
    assert "qa-alpha.pdf" not in folded and "qa-beta.pdf" not in folded
    for text in ("Mutterboden", "kiesig", "Imaginary", "remark line"):  # nothing quoted from the pages
        assert text.casefold() not in folded, text


# ----------------------------------------------------------------------------------------------
# Unit tests: reading expected results
# ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "pages"),
    [
        ("16-18", {16, 17, 18}),
        ("p. 3–5, 7", {3, 4, 5, 7}),
        ("pp 2; 4", {2, 4}),
        ("S. 9", {9}),
        (7, {7}),
        ([3, [5, 6]], {3, 5, 6}),
        (["2-3", 9], {2, 3, 9}),
    ],
)
def test_page_lists_are_read(value: Any, pages: set[int]) -> None:
    assert parse_pages(value, max_pages=MAX_PAGES) == frozenset(pages)


@pytest.mark.parametrize(
    "value", ["sheet 1 of 2", "16-43 (logs)", "", "5-3", 0, True, None, [1, "x"], "2 and 3", "1-99999"]
)
def test_unclear_page_lists_are_not_guessed(value: Any) -> None:
    assert parse_pages(value, max_pages=MAX_PAGES) is None


def test_expected_shapes_and_fields() -> None:
    entries = expected_entries()
    for data in (entries, {"files": entries}, {e["doc"]: e for e in entries}):
        parsed = parse_expected(data, max_pages=MAX_PAGES)
        assert [len(e.boreholes) for e in parsed] == [4, 1]
    alpha = parse_expected(entries, max_pages=MAX_PAGES)[0]
    qx11, qx12, qx13, qx14 = alpha.boreholes
    assert qx12.canonical == "QX12" and qx12.pages == frozenset({4})
    assert qx11.total_depth_m == 7.5 and qx11.crs_status is None and qx11.has_coordinates is True
    assert qx12.crs_status == "stated" and qx12.unplotted_known and qx12.unplotted_reason is None
    assert qx13.has_coordinates is False and qx13.crs_status == "unknown"
    assert qx13.unplotted_known and qx13.unplotted_reason == "no_coordinates"
    assert qx14.total_depth_m is None and qx12.layer_count == 2 and qx11.layer_count is None
    with pytest.raises(ExpectedFileError):
        parse_expected([{"borehole_count": 2}], max_pages=MAX_PAGES)


def test_entries_match_file_ids() -> None:
    entries = parse_expected(expected_entries(), max_pages=MAX_PAGES)
    assert find_entry(entries, "QA-ALPHA") is entries[0]
    assert find_entry(entries, "qa_alpha.PDF") is entries[0]
    assert find_entry(entries, "QA-GAMMA") is None
    twins = parse_expected([{"doc": "QA-ALPHA.pdf"}, {"doc": "QA-ALPHA.png"}], max_pages=MAX_PAGES)
    with pytest.raises(ExpectedFileError):
        find_entry(twins, "QA-ALPHA")


def test_printed_text_helpers() -> None:
    assert squash("51° 30′ 12″ N") == squash("51°30'12'' n")
    assert squash("−12,5") == "-12,5"
    assert mentions("Repeats a page of QA-ALPHA (p. 4).", {"qaalpha"})
    assert mentions("see qa alpha png", {"qaalphapng"})
    assert not mentions("QA-ALPHAX is unrelated", {"qaalpha"})


# ----------------------------------------------------------------------------------------------
# Unit tests: comparison
# ----------------------------------------------------------------------------------------------


def actual(label_canonical: str, **fields: Any) -> ActualBorehole:
    base: dict[str, Any] = {
        "canonical": label_canonical,
        "aliases": frozenset(),
        "x_raw": None,
        "y_raw": None,
        "crs_status": "unknown",
        "unplotted_reason": "no_coordinates",
        "depth_m": None,
        "layer_count": 0,
    }
    base.update(fields)
    return ActualBorehole(**base)


def test_excerpt_compares_only_boreholes_inside_it() -> None:
    alpha = parse_expected(expected_entries(), max_pages=MAX_PAGES)[0]
    qx12 = actual(
        "QX12",
        x_raw="512 601,3",
        y_raw="5 413 102,8",
        crs_status="stated",
        unplotted_reason=None,
        depth_m=4.85,
        layer_count=2,
    )
    stored = [actual("QX11"), qx12, actual("QX13", depth_m=2.65)]
    result = compare_file(
        alpha, stored, excerpt=(3, 5), duplicates_expected=set(), duplicates_found=(), tolerance_m=0.005
    )
    # QX-11 (pages 2-3) is partly inside, QX-14 (page 6) outside: neither is compared or counted.
    assert (result.partly_in_excerpt, result.outside_excerpt, result.without_pages) == (1, 1, 0)
    assert result.expected_in_scope == 2 and result.found == 2 and result.matched == 2
    assert result.tallies["borehole_count"].match == 1 and result.tallies["labels"].match == 2
    assert result.unexpected == 0 and not result.failures

    no_pages = parse_expected(expected_entries(with_pages=False), max_pages=MAX_PAGES)[0]
    result = compare_file(
        no_pages, stored, excerpt=(3, 5), duplicates_expected=set(), duplicates_found=(), tolerance_m=0.005
    )
    assert result.tallies["borehole_count"].not_comparable == 1 and result.expected_in_scope is None
    assert result.tallies["labels"].compared == 0 and result.without_pages == 4
    assert not result.failures


def test_comparison_categories() -> None:
    alpha = parse_expected(expected_entries(), max_pages=MAX_PAGES)[0]
    stored = [
        actual("QX11", x_raw="512 345,6", y_raw="5 412 987,1", depth_m=7.35, layer_count=3),
        actual(
            "QX12",
            x_raw="512 601,3",
            y_raw="5 413 102,9",  # one digit off
            crs_status="stated",
            unplotted_reason=None,
            depth_m=4.85,
            layer_count=2,
        ),
        actual("QX13", depth_m=2.65, layer_count=1),
        actual("QZ99"),
    ]
    result = compare_file(
        alpha, stored, excerpt=None, duplicates_expected={"x"}, duplicates_found=(), tolerance_m=0.005
    )
    assert result.failures == {
        "label_missed": 1,
        "label_unexpected": 1,
        "total_depth_mismatch": 1,
        "coordinates_mismatch": 1,
        "duplicate_missed": 1,
    }
    assert result.tallies["borehole_count"].match == 1  # 4 expected, 4 stored
    assert result.tallies["crs_status"].match == 2 and result.tallies["crs_status"].not_comparable == 1
    assert result.tallies["unplotted_reason"].match == 2
    assert result.tallies["layer_count"].match == 1


# ----------------------------------------------------------------------------------------------
# Unit tests: planning
# ----------------------------------------------------------------------------------------------


def test_plan_resolves_files_folders_and_excerpts(folder: Folder) -> None:
    photos = folder.data / "site photos" / "QA-GAMMA"
    photos.mkdir(parents=True)
    for n in (1, 2):
        Image.new("RGB", (40, 30), (n * 60, 90, 120)).save(photos / f"img{n}.png")
    (photos / "notes.txt").write_text("fictional", encoding="utf-8")
    entries = parse_expected(expected_entries(), max_pages=MAX_PAGES)

    plan = build_plan(
        folder.data, entries, names=["QA-BETA", "qa-gamma", "QA-ALPHA.pdf"], pages=["QA-ALPHA=2-4"]
    )
    beta, gamma, alpha = plan.files
    assert [f.short_id for f in plan.files] == ["QA-BETA", "qa-gamma", "QA-ALPHA.pdf"]
    assert beta.expected is entries[1] and beta.page_estimate == 2 and beta.excerpt is None
    assert len(gamma.sources) == 2 and gamma.ignored_files == 1 and gamma.expected is None
    assert alpha.excerpt == (2, 4) and alpha.excerpt_pages == 3 and alpha.page_estimate == 3

    anonymous = build_plan(folder.data, entries, names=None)
    assert [f.short_id for f in anonymous.files] == ["file-01", "file-02"]
    for names, pages in (
        (["QA-DELTA"], ()),
        (["QA-ALPHA"], ("QA-BETA=1-2",)),
        (["QA-ALPHA"], ("QA-ALPHA=5-9",)),
        (["qa-gamma"], ("qa-gamma=1-1",)),
        (["QA-ALPHA", "qa_alpha"], ()),
    ):
        with pytest.raises(PlanError):
            build_plan(folder.data, entries, names=names, pages=pages)
    assert parse_pages_arg("QA-ALPHA=3") == ("QA-ALPHA", 3, 3)
    with pytest.raises(PlanError):
        parse_pages_arg("QA-ALPHA=4-2")


def test_excerpt_is_a_new_pdf_with_those_pages(folder: Folder) -> None:
    data = excerpt_pdf(folder.alpha, 2, 4)
    pdf = pdfium.PdfDocument(data)
    try:
        assert len(pdf) == 3
        textpage = pdf[0].get_textpage()
        assert "BOREHOLE LOG QX-11" in textpage.get_text_range()
        textpage.close()
    finally:
        pdf.close()
    with pytest.raises(PlanError):
        excerpt_pdf(folder.alpha, 5, 7)


# ----------------------------------------------------------------------------------------------
# The real pipeline with fake providers
# ----------------------------------------------------------------------------------------------


@pytest.mark.db
async def test_eval_runs_the_pipeline_and_reports_metrics_only(
    db: None, live_mode: None, fakes: Fakes, folder: Folder, tmp_path: Path
) -> None:
    run = await run_eval(plan_files(folder, "QA-ALPHA", "QA-BETA"), max_usd=1.0)

    assert run.stopped_by is None and [f.started for f in run.files] == [True, True]
    alpha, beta = run.files
    (doc,) = alpha.documents
    assert doc.status == "needs_review" and not doc.reused and doc.pages == 6 and doc.pages_ocr == 4
    async with get_sessionmaker()() as session:
        stored = await session.get(Document, doc.document_id)
    assert stored is not None
    # Uploaded like the API does: content hash, original stored under it.
    assert stored.sha256 == hashlib.sha256(folder.alpha.read_bytes()).hexdigest()
    assert stored.storage_key == f"originals/{stored.sha256}.pdf" and stored.project is None

    a = alpha.comparison
    assert a is not None
    assert a.expected_in_scope == 4 and a.found == 3 and a.matched == 3
    assert a.failures == {"borehole_count_mismatch": 1, "label_missed": 1, "total_depth_mismatch": 1}
    tallies = {m: (t.match, t.mismatch, t.not_comparable) for m, t in a.tallies.items()}
    assert tallies == {
        "borehole_count": (0, 1, 0),
        "labels": (3, 1, 0),
        "coordinates": (3, 0, 0),
        "crs_status": (2, 0, 1),
        "total_depth": (2, 1, 0),
        "layer_count": (1, 0, 2),
        "unplotted_reason": (2, 0, 1),
        "duplicates": (1, 0, 0),
    }
    b = beta.comparison
    assert b is not None
    assert beta.documents[0].duplicate_docs == {doc.document_id}  # the repeated page was recognised
    assert not b.failures, b.failures
    assert {m: t.match for m, t in b.tallies.items()} == {
        "borehole_count": 1,
        "labels": 1,
        "coordinates": 1,
        "crs_status": 1,
        "total_depth": 1,
        "layer_count": 1,
        "unplotted_reason": 1,
        "duplicates": 1,
    }

    report = write_report(run, tmp_path / "eval" / "report.md").read_text(encoding="utf-8")
    assert "| QA-ALPHA | needs_review |" in report and "| QA-BETA | needs_review |" in report
    for category in ("borehole_count_mismatch", "label_missed", "total_depth_mismatch"):
        assert f"| {category} | 1 | QA-ALPHA |" in report
    assert "| Labels found (boreholes) | 5 | 4 | 80 % | 0 |" in report
    assert_no_values(report)

    # A second run reuses the finished documents: nothing is called or paid again.
    calls = fakes.counts()
    again = await run_eval(plan_files(folder, "QA-ALPHA"), max_usd=0.0)
    assert again.stopped_by is None and fakes.counts() == calls
    (reused,) = again.files[0].documents
    assert reused.reused and reused.finished_before and reused.document_id == doc.document_id
    assert again.files[0].estimate_usd == 0 and await document_count() == 2


@pytest.mark.db
async def test_cost_cap_stops_before_a_file(db: None, live_mode: None, fakes: Fakes, folder: Folder) -> None:
    fakes.extractor.cost_usd = 0.25  # three boreholes in alpha: 0.75 USD
    run = await run_eval(plan_files(folder, "QA-ALPHA", "QA-BETA"), max_usd=1.0, estimate_usd_per_page=0.15)

    alpha, beta = run.files
    assert alpha.started and alpha.estimate_usd == pytest.approx(0.9)
    assert alpha.cost_usd == pytest.approx(0.75) and run.spent_usd == pytest.approx(0.75)
    assert alpha.calls == {"extract": 3}
    # Beta's two pages would bring the run to 1.05 USD: it is never uploaded.
    assert beta.not_started == "cost_cap" and run.stopped_by == "cost_cap" and not beta.documents
    assert beta.estimate_usd == pytest.approx(0.3) and beta.comparison is None
    assert await document_count() == 1 and fakes.extractor.calls == 3
    report = render(run)
    assert "| Stopped by | eval cost cap (--max-usd) |" in report
    assert "| not_started_cost_cap | 1 | QA-BETA |" in report and "not started (cost_cap)" in report
    assert_no_values(report)


@pytest.mark.db
async def test_cost_cap_holds_inside_a_file(
    db: None, live_mode: None, fakes: Fakes, folder: Folder, settings_env: Any
) -> None:
    settings_env(CONCURRENCY_EXTRACT="1")
    fakes.extractor.cost_usd = 0.4
    budget_before = get_settings().provider_budget_usd
    run = await run_eval(plan_files(folder, "QA-ALPHA", "QA-BETA"), max_usd=0.5, estimate_usd_per_page=0.0)

    alpha, beta = run.files
    (doc,) = alpha.documents
    # The second extraction would pass the cap: the provider guard refuses it and the run ends.
    assert fakes.extractor.calls == 1 and run.spent_usd == pytest.approx(0.4)
    assert doc.status == "failed" and doc.budget_stop and doc.failure == "cost_cap"
    assert run.stopped_by == "cost_cap" and beta.not_started == "cost_cap"
    assert get_settings().provider_budget_usd == budget_before  # the lowered budget does not leak
    assert "| cost_cap | 1 | QA-ALPHA |" in render(run)


@pytest.mark.db
async def test_provider_budget_applies_before_a_file(
    db: None, live_mode: None, fakes: Fakes, folder: Folder, settings_env: Any
) -> None:
    async with get_sessionmaker()() as session:  # spend recorded by earlier (fictional) calls
        session.add(ProviderCall(provider="fake", purpose="extract", model="fake-extractor", cost_usd=2.0))
        await session.commit()
    settings_env(PROVIDER_BUDGET_USD="2.1")
    run = await run_eval(plan_files(folder, "QA-ALPHA"), max_usd=5.0, estimate_usd_per_page=0.05)

    assert run.stopped_by == "provider_budget" and run.files[0].not_started == "provider_budget"
    assert run.effective_budget_usd == pytest.approx(2.1) and run.spent_usd == 0
    assert await document_count() == 0 and fakes.counts() == (0, 0, 0)
    assert "| Stopped by | PROVIDER_BUDGET_USD |" in render(run)


@pytest.mark.db
async def test_excerpt_is_uploaded_and_compared_by_its_pages(
    db: None, live_mode: None, fakes: Fakes, folder: Folder
) -> None:
    run = await run_eval(plan_files(folder, "QA-ALPHA", pages=("QA-ALPHA=2-4",)), max_usd=1.0)

    (current,) = run.files
    (doc,) = current.documents
    assert doc.status == "needs_review" and doc.pages == 3
    async with get_sessionmaker()() as session:
        stored = await session.get(Document, doc.document_id)
    assert stored is not None
    assert stored.page_count == 3 and stored.sha256 != hashlib.sha256(folder.alpha.read_bytes()).hexdigest()
    assert fakes.classifier.calls == 3  # only the excerpt's pages were processed
    result = current.comparison
    assert result is not None
    assert (result.expected_in_scope, result.found, result.outside_excerpt) == (2, 2, 2)
    assert result.tallies["borehole_count"].match == 1 and result.tallies["labels"].match == 2
    assert result.failures == {"total_depth_mismatch": 1}  # QX-11's deliberately wrong depth
    report = render(run)
    assert "| QA-ALPHA | needs_review | 3 | 3 |" in report
    assert_no_values(report)


@pytest.mark.db
async def test_excerpt_without_page_ranges_is_not_comparable(
    db: None, live_mode: None, fakes: Fakes, tmp_path: Path
) -> None:
    folder = write_folder(tmp_path, with_pages=False)
    run = await run_eval(plan_files(folder, "QA-ALPHA", pages=("QA-ALPHA=2-4",)), max_usd=1.0)

    result = run.files[0].comparison
    assert result is not None and result.found == 2
    assert result.tallies["borehole_count"].not_comparable == 1 and result.tallies["labels"].compared == 0
    assert not result.failures
    report = render(run)
    assert "borehole_count: excerpt without page ranges for every borehole" in report
    assert "| QA-ALPHA | needs_review | 3 | 3 | 3 |" in report and "| n/c | 2 |" in report
    assert_no_values(report)


# ----------------------------------------------------------------------------------------------
# Command line
# ----------------------------------------------------------------------------------------------


async def test_cli_dry_run_and_argument_errors(folder: Folder, capsys: pytest.CaptureFixture[str]) -> None:
    base = ["--data-dir", str(folder.data), "--expected", str(folder.expected), "--max-usd", "1"]
    args = cli.parser().parse_args([*base, "--files", "QA-ALPHA", "QA-BETA", "--dry-run"])
    assert await cli.amain(args) == 0
    out = capsys.readouterr().out
    assert "QA-ALPHA: 1 document(s), about 6 page(s), expected entry found" in out
    assert "QA-BETA: 1 document(s), about 2 page(s)" in out

    for extra in (["--files", "QA-ALPHA", "--pages", "QA-ALPHA=7-9"], ["--files", "QA-DELTA"]):
        assert await cli.amain(cli.parser().parse_args([*base, *extra, "--dry-run"])) == 2
    assert "Cannot plan the run" in capsys.readouterr().out
    # Without provider keys the real pipeline cannot run.
    assert await cli.amain(cli.parser().parse_args([*base, "--files", "QA-ALPHA"])) == 2
    assert "demo mode" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        cli.parser().parse_args(["--data-dir", str(folder.data)])  # --max-usd is required


@pytest.mark.db
async def test_cli_runs_and_writes_the_report(
    db: None, live_mode: None, fakes: Fakes, folder: Folder, tmp_path: Path
) -> None:
    out = tmp_path / "report.md"
    args = cli.parser().parse_args(
        [
            "--data-dir",
            str(folder.data),
            "--expected",
            str(folder.expected),
            "--files",
            "QA-BETA",
            "--max-usd",
            "0.5",
            "--out",
            str(out),
            "--database-url",
            get_settings().database_url,
        ]
    )
    assert await cli.amain(args) == 0
    report = out.read_text(encoding="utf-8")
    assert report.startswith("# Evaluation report") and "| QA-BETA | needs_review |" in report
    assert_no_values(report)
    assert await document_count() == 1  # the engine works again after the CLI disposed its own
