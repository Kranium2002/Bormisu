"""Upload -> classify -> OCR -> extraction -> borehole records with only OPENAI_API_KEY set.

Every provider call goes to the OpenAI chat-completions endpoint and is answered by a respx mock that behaves
like a careful model on the FICTIONAL report of test_pipeline_e2e: page labels from the page's embedded text,
page transcriptions (one paragraph per printed line) and extractions that cite the block ids they read. The
answers follow the documented response shape (validated against the openai SDK's ChatCompletion).
"""

from __future__ import annotations

import base64
import io
import json
from collections.abc import Iterator
from typing import Any

import httpx
import pypdfium2 as pdfium
import pytest
import respx
from openai.types.chat import ChatCompletion
from PIL import Image
from sqlalchemy import select

from app.config import get_settings
from app.db.models import ProviderCall
from app.db.session import get_sessionmaker
from app.pipeline.types import ExtractionInput
from app.providers.fakes import _lines, fake_extraction
from app.storage import get_storage, page_render_key
from tests.test_pipeline_e2e import (
    POINTS,
    PROJECT,
    SYSTEM,
    classify_rule,
    document,
    fictional_report,
    records,
    upload,
    work,
)

pytestmark = pytest.mark.db
OPENAI = "https://api.openai.com/v1/chat/completions"
EMBEDDED_TEXT = "Embedded text of the page (may be incomplete):\n"


@pytest.fixture
def openai_only(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-test-not-real")
    for name in ("OPENROUTER_API_KEY", "OPEN_ROUTER_KEY", "MISTRAL_API_KEY"):
        monkeypatch.setenv(name, "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def completion(content: str) -> dict[str, Any]:
    body = {
        "id": "chatcmpl-fictional",
        "object": "chat.completion",
        "created": 1_760_000_000,
        "model": "gpt-fictional-2026-01-01",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "logprobs": None,
                "message": {"role": "assistant", "content": content, "refusal": None},
            }
        ],
        "usage": {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200},
    }
    ChatCompletion.model_validate(body)
    return body


def _pixels(png: bytes) -> bytes:
    with Image.open(io.BytesIO(png)) as image:
        return image.convert("RGB").tobytes()


class FictionalOpenAI:
    """The OpenAI endpoint for the fictional report; keeps every request body (by kind)."""

    def __init__(self, pdf: bytes) -> None:
        self.pdf = pdf
        self.document_id: str | None = None
        self.kinds: list[str] = []
        self.unexpected: list[str] = []

    def printed_lines(self, n: int) -> list[str]:
        document = pdfium.PdfDocument(self.pdf)
        try:
            textpage = document[n - 1].get_textpage()
            lines = [text for text, _box in _lines(textpage)]
            textpage.close()
        finally:
            document.close()
        return lines

    def page_of(self, image_url: str) -> int:
        """The page whose stored render was sent (the OCR request carries only the image)."""
        assert self.document_id is not None
        sent = _pixels(base64.b64decode(image_url.split(",", 1)[1]))
        storage = get_storage()
        for n in range(1, len(pdfium.PdfDocument(self.pdf)) + 1):
            key = page_render_key(self.document_id, n)
            if storage.exists(key) and _pixels(storage.get_bytes(key)) == sent:
                return n
        raise AssertionError("the OCR request carries no page render of the document")

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        user = body["messages"][1]
        assert request.headers["authorization"] == "Bearer sk-openai-test-not-real"
        assert not {"provider", "plugins", "usage", "reasoning", "max_tokens"} & set(body)
        response_format = body.get("response_format")
        if response_format is None:  # OCR: one page image, the transcription prompt
            self.kinds.append("ocr")
            (part,) = user["content"]
            n = self.page_of(part["image_url"]["url"])
            return httpx.Response(200, json=completion("\n\n".join(self.printed_lines(n))))
        name = response_format["json_schema"]["name"]
        assert response_format["json_schema"]["strict"] is True
        texts = [p["text"] for p in user["content"] if p["type"] == "text"]
        if name == "PageLabel":
            self.kinds.append("classify")
            embedded = next((t[len(EMBEDDED_TEXT) :] for t in texts if t.startswith(EMBEDDED_TEXT)), "")
            return httpx.Response(200, json=completion(classify_rule(embedded).model_dump_json()))
        if name == "ExtractionResult":
            self.kinds.append("extract")
            inp = ExtractionInput(text=texts[0], context_text="", images=(), blocks={}, estimated_tokens=0)
            return httpx.Response(200, json=completion(fake_extraction(inp).model_dump_json()))
        self.unexpected.append(name)
        return httpx.Response(500)


async def test_openai_key_alone_runs_the_whole_pipeline(
    client: httpx.AsyncClient, queue: Any, openai_only: None
) -> None:
    health = (await client.get("/api/v1/health")).json()
    assert health["mode"] == "live"
    assert health["providers"] | {"geocoder": None} == {
        "ocr": True,
        "classifier": True,
        "extractor": True,
        "chat": True,
        "geocoder": None,
    }
    pdf = fictional_report()
    model = FictionalOpenAI(pdf)
    doc_id = await upload(client, pdf)
    model.document_id = doc_id
    with respx.mock() as mock:  # any other outgoing request fails the test
        route = mock.post(OPENAI).mock(side_effect=model)
        await work(queue, doc_id)
    assert model.unexpected == []
    # Six page labels, the four important pages read one by one, one extraction per borehole.
    assert sorted(model.kinds) == sorted(["classify"] * 6 + ["ocr"] * 4 + ["extract"] * 2)
    assert route.call_count == 12

    doc = await document(client, doc_id)
    assert doc["status"] == "needs_review" and doc["error"] is None
    pages = {p["n"]: (p["role"], p["used"], p["ocr"]) for p in doc["pages"]}
    assert pages == {
        1: ("cover_or_toc", False, "skipped"),
        2: ("log_sheet", True, "done"),
        3: ("log_continuation", True, "done"),
        4: ("log_sheet", True, "done"),
        5: ("summary_table", True, "done"),
        6: ("narrative", False, "skipped"),
    }
    assert doc["found"] == {"boreholes": 2, "layers": 5, "spt": 0, "groundwater": 1}

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
    assert fx1["metadata"]["project_name"] == PROJECT and fx1["metadata"]["borehole_depth_m"] == 6.0
    coords = fx1["metadata"]["coordinates"]
    assert (coords["local_x"], coords["local_y"]) == POINTS["FX-1"] and coords["coordinate_system"] == SYSTEM
    assert fx1["plotted"] is True and fx2["plotted"] is True
    assert fx2["metadata"]["borehole_depth_m"] == 4.5 and len(fx2["stratigraphy"]) == 2
    # The OCR has no boxes, but the pages have a text layer: values still point at their printed words. The
    # axis labels ("Easting, Northing") are two separate words on the page, so they keep the page citation.
    unboxed = sorted(
        (record["metadata"]["borehole_id"], path)
        for record in (fx1, fx2)
        for path, entry in record["provenance"].items()
        if entry["box"] is None
    )
    assert unboxed == [
        ("FX-1", "metadata.coordinates.axis_labels_raw"),
        ("FX-2", "metadata.coordinates.axis_labels_raw"),
    ]
    for record in (fx1, fx2):
        for path, entry in record["provenance"].items():
            assert entry["document_id"] == doc_id and entry["page"] in record["pages"], path
    assert fx1["provenance"]["stratigraphy[0].depth_from_m"]["raw"] == "0,00"

    async with get_sessionmaker()() as session:
        calls = (await session.scalars(select(ProviderCall))).all()
    assert {c.provider for c in calls} == {"openai"}
    assert sorted(c.purpose for c in calls) == sorted(["classify"] * 6 + ["ocr"] * 4 + ["extract"] * 2)
    assert all(c.ok and c.cost_usd > 0 for c in calls)  # priced from data/prices.yaml (CHAT_MODEL)
