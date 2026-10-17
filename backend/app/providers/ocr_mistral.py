"""Mistral OCR, called directly (POST {MISTRAL_BASE_URL}/ocr) with inline base64 data URLs.

Response shape (Mistral OpenAPI, checked 2026-10-17): `pages[]` with `index` (0-based within the sent
document), `markdown`, `tables[]` ({id, content, format}), `header`, `footer`, `dimensions` ({dpi, width,
height} in pixels of the page screenshot) and `blocks[]` ({type, content, top_left_x, top_left_y,
bottom_right_x, bottom_right_y, confidence_scores: {average_content_confidence_score,
minimum_content_confidence_score, ...}}); `model`; `usage_info.pages_processed`. Block corners are integers in
screenshot pixels; values that are all <= 1 are taken as already normalised.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import get_settings
from app.pipeline.schemas import OcrBlock, OcrPageResult
from app.providers.base import ProviderError, Usage, check_budget, ocr_cost, post_with_retries, record_usage

logger = logging.getLogger("geomemory.providers.mistral_ocr")
PROVIDER = "mistral"
TIMEOUT_S = 300.0


@dataclass(frozen=True)
class OcrResponse:
    raw: dict[str, Any]
    model: str | None
    pages_processed: int


def data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


class MistralOcrClient:
    def __init__(self, http: httpx.AsyncClient | None = None) -> None:
        self.settings = get_settings()
        if self.settings.mistral_api_key is None:
            raise ProviderError("Mistral OCR is not configured.", retryable=False)
        self._http = http

    async def ocr(self, data: bytes, mime: str, *, document_id: str | None, page_count: int) -> OcrResponse:
        model = self.settings.mistral_ocr_model
        await check_budget(ocr_cost(model, page_count))
        document = (
            {"type": "document_url", "document_url": data_url(data, mime)}
            if mime == "application/pdf"
            else {"type": "image_url", "image_url": data_url(data, mime)}
        )
        body = {
            "model": model,
            "document": document,
            "include_blocks": True,
            "confidence_scores_granularity": "block",
            "table_format": "html",
            "extract_header": True,
            "extract_footer": True,
            "include_image_base64": False,
        }
        key = self.settings.mistral_api_key
        assert key is not None
        headers = {"Authorization": f"Bearer {key.get_secret_value()}"}
        url = self.settings.mistral_base_url.rstrip("/") + "/ocr"
        if self._http is not None:
            response = await post_with_retries(
                self._http, url, json=body, headers=headers, provider="Mistral OCR"
            )
        else:
            async with httpx.AsyncClient(timeout=TIMEOUT_S) as http:
                response = await post_with_retries(
                    http, url, json=body, headers=headers, provider="Mistral OCR"
                )
        try:
            payload: dict[str, Any] = response.json()
        except ValueError as exc:
            raise ProviderError("Mistral OCR sent an unreadable answer.", retryable=True) from exc
        pages = int(
            (payload.get("usage_info") or {}).get("pages_processed") or len(payload.get("pages") or [])
        )
        returned_model = payload.get("model")
        await record_usage(
            Usage(PROVIDER, "ocr", returned_model or model, None, None, pages, ocr_cost(model, pages)),
            document_id,
        )
        return OcrResponse(payload, returned_model, pages)


def _box(block: dict[str, Any], width: float | None, height: float | None) -> list[float] | None:
    try:
        x0, y0 = float(block["top_left_x"]), float(block["top_left_y"])
        x1, y1 = float(block["bottom_right_x"]), float(block["bottom_right_y"])
    except (KeyError, TypeError, ValueError):
        return None
    if max(x0, y0, x1, y1) > 1.0:
        if not width or not height:
            return None
        x0, x1, y0, y1 = x0 / width, x1 / width, y0 / height, y1 / height
    x0, x1 = sorted((min(max(x0, 0.0), 1.0), min(max(x1, 0.0), 1.0)))
    y0, y1 = sorted((min(max(y0, 0.0), 1.0), min(max(y1, 0.0), 1.0)))
    return [round(x0, 5), round(y0, 5), round(x1 - x0, 5), round(y1 - y0, 5)]


def normalise_page(raw_page: dict[str, Any], document_page: int) -> OcrPageResult:
    """Provider page -> OcrPageResult with block ids p{n}.b{i} and normalised boxes."""
    dims = raw_page.get("dimensions") or {}
    width, height = dims.get("width"), dims.get("height")
    blocks = []
    for i, block in enumerate(raw_page.get("blocks") or []):
        scores = block.get("confidence_scores") or {}
        blocks.append(
            OcrBlock(
                id=f"p{document_page}.b{i}",
                type=str(block.get("type") or "text"),
                text=str(block.get("content") or ""),
                box=_box(block, width, height),
                confidence=scores.get("average_content_confidence_score"),
                min_confidence=scores.get("minimum_content_confidence_score"),
            )
        )
    tables = [str(t.get("content") or "") for t in raw_page.get("tables") or []]
    return OcrPageResult(
        n=document_page,
        markdown=str(raw_page.get("markdown") or ""),
        tables=tables,
        blocks=blocks,
        header=raw_page.get("header"),
        footer=raw_page.get("footer"),
    )
