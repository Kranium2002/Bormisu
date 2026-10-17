"""Office files: DOCX -> Gotenberg (LibreOffice) -> PDF -> the PDF pipeline (BACKEND.md 7.2). FICTIONAL only.

The Word file is generated here as what it is, a zip of XML parts ([Content_Types].xml, _rels/.rels,
word/document.xml with paragraphs and a table), so no dependency is needed and nothing is committed.
Gotenberg is mocked with respx, except in the integration test, which converts through a real Gotenberg
when GOTENBERG_URL answers and is skipped otherwise (`make test` runs it: the compose "test" service
depends on gotenberg).
"""

from __future__ import annotations

import hashlib
import io
import os
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Sequence
from pathlib import Path
from xml.sax.saxutils import escape

import httpx
import pytest
import respx
from sqlalchemy import select

from app.config import get_settings
from app.db.models import Document, Event, Page
from app.db.session import get_sessionmaker
from app.pipeline.office import CONVERT_PATH, OfficeConversionError, office_to_pdf
from app.pipeline.orchestrator import converted_pdf_key, run_pipeline
from app.pipeline.textlayer import find_runs, page_text
from app.pipeline.triage import triage_pdf
from app.storage import get_storage, original_key
from tests.pdf_factory import TextItem, make_pdf

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
PARAGRAPHS = ("FICTIONAL BOREHOLE LOG ZX-9", "Project: Fictional Quarry Annex (test data)", "Depth (m)")
ROWS = (
    ("From", "To", "Description"),
    ("0.00", "1.50", "Sandy GRAVEL, fictional"),
    ("1.50", "4.00", "Stiff CLAY, fictional"),
)
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml"
 ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1"
 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
 Target="word/document.xml"/>
</Relationships>"""


def _paragraph(text: str) -> str:
    return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def _table(rows: Sequence[Sequence[str]], widths: Sequence[int]) -> str:
    border = '<w:{side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>'
    borders = "".join(border.format(side=s) for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    body = "".join(
        "<w:tr>"
        + "".join(
            f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/></w:tcPr>{_paragraph(cell)}</w:tc>'
            for cell, w in zip(row, widths, strict=True)
        )
        + "</w:tr>"
        for row in rows
    )
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr>'
        f"<w:tblGrid>{grid}</w:tblGrid>{body}</w:tbl>"
    )


def make_docx(
    paragraphs: Sequence[str] = PARAGRAPHS, rows: Sequence[Sequence[str]] = ROWS, widths: Sequence[int] = ()
) -> bytes:
    """A minimal FICTIONAL Word document: paragraphs, then a bordered table (A4, 2 cm margins)."""
    widths = widths or (1500, 1500, 5000)
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W}"><w:body>'
        + "".join(_paragraph(p) for p in paragraphs)
        + _table(rows, widths)
        + _paragraph("")
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0"'
        ' w:gutter="0"/></w:sectPr></w:body></w:document>'
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as package:
        for name, part in (
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", RELS),
            ("word/document.xml", document),
        ):
            # A fixed timestamp keeps the generated file byte-for-byte the same on every call.
            package.writestr(
                zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0)), part, zipfile.ZIP_DEFLATED
            )
    return out.getvalue()


def convert_url() -> str:
    return get_settings().gotenberg_url.rstrip("/") + CONVERT_PATH


@pytest.fixture
def docx_file(tmp_path: Path) -> Path:
    path = tmp_path / "fictional-log.docx"
    path.write_bytes(make_docx())
    return path


def converted_pdf() -> bytes:
    """What Gotenberg answers in the mocked tests: a FICTIONAL two-page vector PDF."""
    return make_pdf(
        [
            [TextItem(72, 770, PARAGRAPHS[0], 14), TextItem(72, 740, "0.00  1.50  Sandy GRAVEL, fictional")],
            [TextItem(72, 770, "1.50  4.00  Stiff CLAY, fictional")],
        ]
    )


# ----------------------------------------------------------------------------------------------
# The generated Word file
# ----------------------------------------------------------------------------------------------


def test_generated_docx_is_a_word_package() -> None:
    with zipfile.ZipFile(io.BytesIO(make_docx())) as package:
        assert package.namelist() == ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]
        root = ET.fromstring(package.read("word/document.xml"))
        ET.fromstring(package.read("[Content_Types].xml"))
        ET.fromstring(package.read("_rels/.rels"))
    texts = [t.text for t in root.iter(f"{{{W}}}t")]
    assert texts[:3] == list(PARAGRAPHS)
    assert [len(row.findall(f"{{{W}}}tc")) for row in root.iter(f"{{{W}}}tr")] == [3, 3, 3]
    assert "Stiff CLAY, fictional" in texts
    assert make_docx() == make_docx()


# ----------------------------------------------------------------------------------------------
# office_to_pdf with a mocked Gotenberg
# ----------------------------------------------------------------------------------------------


async def test_office_to_pdf_returns_the_converted_pdf(docx_file: Path) -> None:
    pdf = converted_pdf()
    with respx.mock(assert_all_called=True) as router:
        route = router.post(convert_url()).mock(
            return_value=httpx.Response(200, content=pdf, headers={"content-type": "application/pdf"})
        )
        assert await office_to_pdf(docx_file) == pdf
    request = route.calls.last.request
    body = request.content
    # Multipart upload under a generated name with the original extension (it picks the import filter).
    assert b'name="files"; filename="document.docx"' in body
    assert make_docx() in body  # the generated file is the same on every call (fixed timestamps)
    assert docx_file.name.encode() not in body


async def test_office_to_pdf_uses_a_given_client(docx_file: Path) -> None:
    pdf = converted_pdf()
    with respx.mock(assert_all_called=True) as router:
        router.post(convert_url()).mock(return_value=httpx.Response(200, content=pdf))
        async with httpx.AsyncClient() as client:
            assert await office_to_pdf(docx_file, client=client) == pdf
            assert not client.is_closed  # the caller's client is not closed by the conversion


@pytest.mark.parametrize(
    ("response", "status"),
    [
        (httpx.Response(200, content=b"<html>conversion error page</html>"), "200"),
        (httpx.Response(200, content=b""), "200"),
        (httpx.Response(503, content=b"%PDF-1.7 but a server error"), "503"),
        (httpx.Response(400, json={"message": "unsupported file"}), "400"),
    ],
)
async def test_a_non_pdf_answer_is_a_readable_error(
    docx_file: Path, response: httpx.Response, status: str
) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.post(convert_url()).mock(return_value=response)
        with pytest.raises(OfficeConversionError) as info:
            await office_to_pdf(docx_file)
    message = str(info.value)
    assert message == f"The office-file converter could not read this file ({status})."
    assert "http" not in message and "Traceback" not in message


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("connection refused"),
        httpx.ReadTimeout("timed out"),
        httpx.RemoteProtocolError("x"),
    ],
)
async def test_an_unreachable_converter_is_a_readable_error(docx_file: Path, error: Exception) -> None:
    with respx.mock(assert_all_called=True) as router:
        router.post(convert_url()).mock(side_effect=error)
        with pytest.raises(OfficeConversionError) as info:
            await office_to_pdf(docx_file)
    assert str(info.value) == "The office-file converter is not reachable."
    assert isinstance(info.value.__cause__, httpx.HTTPError)


# ----------------------------------------------------------------------------------------------
# The DOCX path through the triage stage (mocked Gotenberg)
# ----------------------------------------------------------------------------------------------

DOCX_DOC = "doc_01JFAKE0000000000000OFFC1"


@pytest.fixture
def triage_only(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.pipeline import orchestrator

    monkeypatch.setattr(orchestrator, "STAGES", ("triage",))


async def _docx_document(data: bytes) -> str:
    digest = hashlib.sha256(data).hexdigest()
    key = original_key(digest, ".docx")
    get_storage().put_bytes(key, data)
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=DOCX_DOC,
                file_name="fictional-log.docx",
                sha256=digest,
                mime_type=DOCX_MIME,
                size_bytes=len(data),
                storage_key=key,
                status="queued",
            )
        )
        await session.commit()
    return DOCX_DOC


@pytest.mark.db
async def test_docx_is_converted_then_triaged_like_a_pdf(db: None, triage_only: None) -> None:
    data = make_docx()
    doc_id = await _docx_document(data)
    pdf = converted_pdf()
    with respx.mock(assert_all_called=True) as router:
        route = router.post(convert_url()).mock(return_value=httpx.Response(200, content=pdf))
        await run_pipeline(doc_id)
        assert route.call_count == 1
    storage = get_storage()
    assert storage.get_bytes(converted_pdf_key(doc_id)) == pdf
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        assert doc is not None and (doc.status, doc.stage, doc.page_count) == ("classifying", "triage", 2)
        assert storage.get_bytes(doc.storage_key) == data  # the original is kept
        pages = (await session.scalars(select(Page).where(Page.document_id == doc_id).order_by(Page.n))).all()
    assert [p.n for p in pages] == [1, 2]
    assert all(storage.exists(p.render_key or "") and storage.exists(p.thumb_key or "") for p in pages)
    assert all(p.text_layer_key and p.text_layer_quality and p.text_layer_quality > 0.9 for p in pages)
    # A rerun does not convert again.
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as router:
        again = router.post(convert_url()).mock(return_value=httpx.Response(200, content=pdf))
        await run_pipeline(doc_id)
        assert again.call_count == 0


@pytest.mark.db
async def test_converter_down_fails_the_document_with_a_retryable_reason(db: None, triage_only: None) -> None:
    doc_id = await _docx_document(make_docx())
    with respx.mock(assert_all_called=True) as router:
        router.post(convert_url()).mock(side_effect=httpx.ConnectError("connection refused"))
        await run_pipeline(doc_id)
    async with get_sessionmaker()() as session:
        doc = await session.get(Document, doc_id)
        assert doc is not None and doc.status == "failed" and doc.stage is None
        assert doc.error == "The office-file converter is not reachable."
        event = await session.scalar(select(Event).where(Event.type == "job.failed"))
        assert event is not None and event.payload["stage"] == "triage" and event.payload["retryable"] is True
        assert (await session.scalar(select(Page).where(Page.document_id == doc_id))) is None


# ----------------------------------------------------------------------------------------------
# Integration: a real Gotenberg (skipped when GOTENBERG_URL does not answer)
# ----------------------------------------------------------------------------------------------


def _gotenberg() -> str | None:
    url = os.environ.get("GOTENBERG_URL", "").strip().rstrip("/")
    if not url:
        return None
    try:
        response = httpx.get(f"{url}/health", timeout=3.0)
    except httpx.HTTPError:
        return None
    return url if response.status_code == 200 else None


async def test_real_gotenberg_converts_a_generated_docx(docx_file: Path, tmp_path: Path) -> None:
    if _gotenberg() is None:
        pytest.skip("Gotenberg is not reachable at GOTENBERG_URL (make test provides one)")
    pdf = await office_to_pdf(docx_file)
    assert pdf.startswith(b"%PDF-")
    path = tmp_path / "converted.pdf"
    path.write_bytes(pdf)
    pages = list(triage_pdf(path))
    assert len(pages) >= 1
    first = pages[0]
    assert first.text_layer_quality is not None and first.text_layer_quality > 0.9
    assert first.width_px < first.height_px  # A4 portrait, as the document's section says
    for expected in (*PARAGRAPHS, "Sandy GRAVEL, fictional", "Stiff CLAY, fictional"):
        assert " ".join(expected.split()) in " ".join(first.text.split()), expected
    assert all(0 <= v <= 1 for w in first.words for v in w.box)
    # The converted page's text layer gives tight boxes like any vector PDF.
    layer = page_text(1, [(w.text, w.box) for w in first.words], quality=first.text_layer_quality)
    (clay,) = find_runs(layer, "Stiff CLAY, fictional")
    depths = find_runs(layer, "1.50")
    assert len(depths) == 2 and clay.box[2] < 0.5 and clay.box[3] < 0.05
