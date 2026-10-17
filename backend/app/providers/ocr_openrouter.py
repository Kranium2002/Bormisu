"""Mistral OCR through OpenRouter's file-parser plugin (no Mistral key needed).

Request (OpenRouter docs, checked 2026-10-17): chat/completions with a user content part
{"type": "file", "file": {"filename", "file_data": "data:application/pdf;base64,..."}} and
plugins [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}]. The parsed document comes back in
choices[0].message.annotations[] as {"type": "file", "file": {"hash", "name", "content": [{"type": "text",
"text"}, {"type": "image_url", ...}]}}. The parser bills about 2 USD per 1,000 pages to OpenRouter.

This route returns text only: no block boxes and no confidence. One page is sent per request so every text
maps to its page; images are wrapped into a one-page PDF first. The answer is shaped like a Mistral OCR
response with `blocks` empty, so the extraction input makes one citable paragraph block per paragraph and
provenance falls back to the page (pages with a text layer still get word-level boxes from it).
"""

from __future__ import annotations

import base64
import io
import logging
from typing import Any

import httpx
from PIL import Image

from app.config import get_settings
from app.providers import reasoning
from app.providers.base import ProviderError, Usage, check_budget, record_usage, token_cost
from app.providers.llm import post_openrouter_chat
from app.providers.ocr_mistral import OcrResponse

logger = logging.getLogger("geomemory.providers.ocr_openrouter")
PROVIDER = "openrouter"
MODEL_TAG = "openrouter:file-parser/mistral-ocr"
TIMEOUT_S = 240.0
# The model only has to acknowledge the file; the parsed text comes from the plugin's annotations.
ACK_PROMPT = "Reply with OK."
ACK_MAX_TOKENS = 8


def image_to_pdf(data: bytes) -> bytes:
    """A one-page PDF holding the image (EXIF orientation applied)."""
    from PIL import ImageOps

    with Image.open(io.BytesIO(data)) as img:
        page = ImageOps.exif_transpose(img).convert("RGB")
        out = io.BytesIO()
        page.save(out, format="PDF", resolution=150.0)
        return out.getvalue()


def _parsed_text(payload: dict[str, Any]) -> str | None:
    choices = payload.get("choices") or []
    message = (choices[0] if choices else {}).get("message") or {}
    texts: list[str] = []
    for annotation in message.get("annotations") or []:
        if annotation.get("type") != "file":
            continue
        for part in (annotation.get("file") or {}).get("content") or []:
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                texts.append(part["text"])
    return "\n\n".join(t for t in texts if t.strip()) if texts else None


class OpenRouterOcrClient:
    """OcrEngine over OpenRouter; one page per call."""

    def __init__(self, http: httpx.AsyncClient | None = None) -> None:
        self.settings = get_settings()
        if self.settings.openrouter_api_key is None:
            raise ProviderError("OpenRouter is not configured.", retryable=False)
        self._http = http

    async def ocr(self, data: bytes, mime: str, *, document_id: str | None, page_count: int) -> OcrResponse:
        if page_count != 1:
            raise ProviderError("OCR through OpenRouter takes one page per request.", retryable=False)
        settings = self.settings
        per_page = float(settings.openrouter_ocr_usd_per_page)
        await check_budget(per_page)
        pdf = data if mime == "application/pdf" else image_to_pdf(data)
        # The acknowledging model is CLASSIFIER_MODEL: reasoning off unless it requires it (then room for it).
        thinking = reasoning.openrouter_reasoning(settings.classifier_model, "off")
        body = {
            "model": settings.classifier_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": ACK_PROMPT},
                        {
                            "type": "file",
                            "file": {
                                "filename": "page.pdf",
                                "file_data": "data:application/pdf;base64,"
                                + base64.b64encode(pdf).decode("ascii"),
                            },
                        },
                    ],
                }
            ],
            "plugins": [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}],
            "max_tokens": reasoning.output_tokens(ACK_MAX_TOKENS, thinking),
            "temperature": 0,
            "provider": {"data_collection": settings.openrouter_data_collection},
            "usage": {"include": True},
            "reasoning": thinking,
        }
        payload = await post_openrouter_chat(self._http, body, label="OpenRouter OCR", timeout_s=TIMEOUT_S)
        usage = payload.get("usage") or {}
        in_tok, out_tok = usage.get("prompt_tokens"), usage.get("completion_tokens")
        reported = usage.get("cost")
        model_cost = token_cost(settings.classifier_model, in_tok, out_tok)
        # The parser fee may not be in the reported cost; never record less than the documented page price.
        cost = max(float(reported) if isinstance(reported, int | float) else 0.0, per_page + model_cost)
        text = _parsed_text(payload)
        await record_usage(
            Usage(PROVIDER, "ocr", MODEL_TAG, in_tok, out_tok, 1, cost, text is not None), document_id
        )
        if text is None:
            raise ProviderError("OpenRouter OCR returned no parsed text for this page.", retryable=True)
        raw = {
            "pages": [{"index": 0, "markdown": text, "tables": [], "blocks": [], "dimensions": None}],
            "model": MODEL_TAG,
            "usage_info": {"pages_processed": 1},
        }
        return OcrResponse(raw, MODEL_TAG, 1)
