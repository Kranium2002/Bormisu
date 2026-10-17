"""OCR with a vision model on OpenRouter (Gemini 3.5 Flash by default): the page render goes in, the page's
text comes back as blocks with boxes (the "openrouter_vision" route; one page a request).

Request: POST {OPENROUTER_BASE_URL}/chat/completions with the prompt of data/prompts/ocr_boxes.txt as the
system message, one user image part {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
holding the page as a PNG of at most OCR_IMAGE_MAX_EDGE pixels, `response_format` json_schema strict
(`PageReading`), `provider.require_parameters`, usage with cost and reasoning per model
(app.providers.reasoning). The answer is {"blocks": [{"kind", "text", "box", "unsure"}]}: one block per line
of text, one per table cell, in reading order. Boxes are [ymin, xmin, ymax, xmax] on a 0-1000 grid of the
image, the convention Gemini is trained on for locating text.

The answer is shaped like a Mistral OCR response, so `ocr_mistral.normalise_page` gives the same OcrPage
blocks as the other routes: block ids p{n}.b{i}, boxes [x, y, w, h] normalised 0-1 on the page render (the
classic extractor cites them; evidence boxes show them on scans). There is no confidence score: a block the
model marks unsure gets UNSURE_CONFIDENCE (below OCR_LOW_CONFIDENCE, so the extractor also gets the page
image and second reads check its values); the others are unscored.

Errors: a 429 waits like every provider call (app.providers.base); an answer that does not match the schema
is asked again once with the validation error; a cut-off answer, a refusal or no answer fail this page only
(retryable: the other pages go on, a retry reads it). A page without text is a valid empty page. Cost: the
usage cost OpenRouter reports, else tokens times data/prices.yaml; every call is written to provider_calls
and PROVIDER_BUDGET_USD is checked before it.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import math
from collections.abc import Sequence
from functools import lru_cache
from typing import Any, Literal

import httpx
from PIL import Image
from pydantic import BaseModel, ConfigDict, ValidationError

from app.config import get_settings
from app.providers import reasoning
from app.providers.base import ProviderError, Usage, check_budget, record_usage, token_cost
from app.providers.llm import _answer, post_openrouter_chat
from app.providers.ocr_mistral import OcrResponse, data_url
from app.providers.ocr_openai import page_png, unfence
from app.providers.schema import strict_json_schema

logger = logging.getLogger("geomemory.providers.ocr_vision")
PROVIDER = "openrouter"
TIMEOUT_S = 240.0
PROMPT_FILE = "ocr_boxes.txt"
USER_TEXT = "Read this page."
FIX_JSON = "Your JSON did not validate:"
BOX_GRID = 1000.0  # boxes come back on a 0-1000 grid of the image
# Confidence of a block the model marks unsure (OCR_LOW_CONFIDENCE is 0.75 by default).
UNSURE_CONFIDENCE = 0.5
# A dense log page with one block per cell stays well below this.
OCR_MAX_OUTPUT_TOKENS = 24_000
# Budget estimate of one page before the call: the page image plus a dense page of blocks with boxes.
ESTIMATE_INPUT_TOKENS = 2_000
ESTIMATE_OUTPUT_TOKENS = 6_000


class PageBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["text", "title", "table_cell", "header", "footer"]
    text: str
    box: list[float]
    unsure: bool


class PageReading(BaseModel):
    model_config = ConfigDict(extra="forbid")

    blocks: list[PageBlock]


def model_tag(model: str) -> str:
    """The OCR run's model (cache key and ocr_runs.model): the route is part of it."""
    return f"openrouter-vision:{model}"


@lru_cache
def ocr_prompt() -> str:
    return (get_settings().data_dir / "prompts" / PROMPT_FILE).read_text(encoding="utf-8")


def corners(box: Sequence[float]) -> dict[str, float] | None:
    """[ymin, xmin, ymax, xmax] on the 0-1000 grid -> Mistral-style corners normalised 0-1, clamped to the
    page (None: not four finite numbers, or no area). Values that are all <= 1 are taken as already
    normalised."""
    if len(box) != 4:
        return None
    try:
        values = [float(v) for v in box]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in values):
        return None
    scale = 1.0 if max(values) <= 1.0 else BOX_GRID
    y0, x0, y1, x1 = (min(max(v / scale, 0.0), 1.0) for v in values)
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    if x1 <= x0 or y1 <= y0:
        return None
    return {
        "top_left_x": round(x0, 5),
        "top_left_y": round(y0, 5),
        "bottom_right_x": round(x1, 5),
        "bottom_right_y": round(y1, 5),
    }


def raw_page(reading: PageReading, width: int, height: int) -> dict[str, Any]:
    """The reading as one page of a Mistral OCR response (see ocr_mistral.normalise_page)."""
    blocks: list[dict[str, Any]] = []
    for block in reading.blocks:
        text = block.text.strip()
        if not text:
            continue
        entry: dict[str, Any] = {"type": block.kind, "content": text, **(corners(block.box) or {})}
        if block.unsure:
            entry["confidence_scores"] = {
                "average_content_confidence_score": UNSURE_CONFIDENCE,
                "minimum_content_confidence_score": UNSURE_CONFIDENCE,
            }
        blocks.append(entry)
    return {
        "index": 0,
        "markdown": "\n\n".join(str(b["content"]) for b in blocks),
        "tables": [],
        "blocks": blocks,
        "dimensions": {"dpi": None, "width": width, "height": height},
    }


def _size(png: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(png)) as image:
        return image.width, image.height


class OpenRouterVisionOcrClient:
    """OcrEngine over a vision model on OpenRouter; one page per call."""

    def __init__(self, http: httpx.AsyncClient | None = None) -> None:
        self.settings = get_settings()
        if self.settings.openrouter_api_key is None:
            raise ProviderError("OpenRouter is not configured.", retryable=False)
        self._http = http

    async def ocr(self, data: bytes, mime: str, *, document_id: str | None, page_count: int) -> OcrResponse:
        if page_count != 1:
            raise ProviderError("OCR with a vision model takes one page per request.", retryable=False)
        settings = self.settings
        model = settings.openrouter_ocr_model
        png = await asyncio.to_thread(page_png, data, mime)
        width, height = await asyncio.to_thread(_size, png)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": ocr_prompt()},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_TEXT},
                    {"type": "image_url", "image_url": {"url": data_url(png, "image/png")}},
                ],
            },
        ]
        response_format = {
            "type": "json_schema",
            "json_schema": {"name": "PageReading", "strict": True, "schema": strict_json_schema(PageReading)},
        }
        for attempt in range(2):
            await check_budget(token_cost(model, ESTIMATE_INPUT_TOKENS, ESTIMATE_OUTPUT_TOKENS))
            thinking = reasoning.openrouter_reasoning(model, "off")  # copying text needs no thinking
            body: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "temperature": 0,
                "max_tokens": reasoning.output_tokens(OCR_MAX_OUTPUT_TOKENS, thinking),
                "response_format": response_format,
                "provider": {
                    "require_parameters": True,
                    "data_collection": settings.openrouter_data_collection,
                },
                "usage": {"include": True},
                "reasoning": thinking,
            }
            payload = await post_openrouter_chat(
                self._http, body, label="OpenRouter OCR", timeout_s=TIMEOUT_S
            )
            usage = payload.get("usage") or {}
            in_tok, out_tok = usage.get("prompt_tokens"), usage.get("completion_tokens")
            reported = usage.get("cost")
            cost = (
                float(reported)
                if isinstance(reported, int | float) and not isinstance(reported, bool)
                else token_cost(model, in_tok, out_tok)
            )
            text, finish, refusal = _answer(payload)
            ok = text is not None and finish != "length"
            await record_usage(
                Usage(PROVIDER, "ocr", payload.get("model") or model, in_tok, out_tok, 1, cost, ok),
                document_id,
            )
            if finish == "length":
                raise ProviderError("The page reading was cut off (too long).", retryable=True)
            if text is None or not text.strip():
                if refusal is not None:
                    raise ProviderError("The model declined to read this page.", retryable=True)
                raise ProviderError("OpenRouter OCR returned no reading for this page.", retryable=True)
            try:
                reading = PageReading.model_validate(json.loads(unfence(text)))
            except (ValueError, ValidationError) as exc:
                if attempt == 1:
                    raise ProviderError(
                        "The page reading did not match the expected structure.", retryable=True
                    ) from exc
                messages = [
                    *messages,
                    {"role": "assistant", "content": text},
                    {"role": "user", "content": f"{FIX_JSON} {str(exc)[:1500]}\nReturn corrected JSON only."},
                ]
                continue
            tag = model_tag(model)
            raw = {
                "pages": [raw_page(reading, width, height)],
                "model": tag,
                "usage_info": {"pages_processed": 1},
            }
            return OcrResponse(raw, tag, 1)
        raise ProviderError("The page reading did not match the expected structure.", retryable=True)
