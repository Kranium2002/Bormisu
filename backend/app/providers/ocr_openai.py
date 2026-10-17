"""OCR with an OpenAI key: a vision model transcribes the page render (chat completions, one page a request).

Request (shapes checked against the openai SDK 2.54 types CompletionCreateParams and
ChatCompletionContentPartImageParam): POST {OPENAI_BASE_URL}/chat/completions with the prompt of
data/prompts/ocr_transcribe.txt as the system message, one user content part {"type": "image_url",
"image_url": {"url": "data:image/png;base64,...", "detail": "high"}} holding the page as a PNG of at most
OCR_IMAGE_MAX_EDGE pixels, and `max_completion_tokens`. The answer (choices[0].message.content) is the page
as plain markdown; tables come back as HTML inside it.

Like the OpenRouter route this returns text only: no block boxes and no confidence. The answer is shaped like
a Mistral OCR response with `blocks` empty, so the extraction input makes one citable paragraph block per
paragraph and provenance falls back to the page (pages with a text layer still get word-level boxes from it).
Cost: usage tokens times data/prices.yaml for OPENAI_OCR_MODEL, recorded per call.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
from functools import lru_cache
from typing import Any

import httpx
import pypdfium2 as pdfium
from PIL import Image, ImageOps

from app.config import get_settings
from app.providers.base import ProviderError, Usage, check_budget, record_usage, token_cost
from app.providers.llm import post_openai_chat
from app.providers.ocr_mistral import OcrResponse, data_url

logger = logging.getLogger("geomemory.providers.ocr_openai")
PROVIDER = "openai"
TIMEOUT_S = 240.0
PROMPT_FILE = "ocr_transcribe.txt"
OCR_IMAGE_MAX_EDGE = 1600
# A dense page with HTML tables stays well below this; reasoning tokens (if the model reasons) count too.
OCR_MAX_OUTPUT_TOKENS = 16_000
# Budget estimate of one page before the call: a high-detail page image plus a dense transcription.
ESTIMATE_INPUT_TOKENS = 2_000
ESTIMATE_OUTPUT_TOKENS = 3_000
_FENCE = re.compile(r"^```[a-zA-Z]*\s*\n(?P<body>.*?)\n?```\s*$", re.DOTALL)


def model_tag(model: str) -> str:
    """The OCR run's model (cache key and ocr_runs.model): the provider is part of it."""
    return f"openai:{model}"


@lru_cache
def ocr_prompt() -> str:
    return (get_settings().data_dir / "prompts" / PROMPT_FILE).read_text(encoding="utf-8")


def page_png(data: bytes, mime: str) -> bytes:
    """The page as a PNG of at most OCR_IMAGE_MAX_EDGE pixels (a PDF's first page is rendered; a PNG that is
    small enough is sent unchanged)."""
    if mime == "application/pdf":
        document = pdfium.PdfDocument(data)
        try:
            page = document[0]
            width, height = page.get_size()
            bitmap = page.render(scale=OCR_IMAGE_MAX_EDGE / max(width, height))
            image = bitmap.to_pil()
            page.close()
        finally:
            document.close()
    else:
        with Image.open(io.BytesIO(data)) as source:
            if source.format == "PNG" and max(source.size) <= OCR_IMAGE_MAX_EDGE:
                return data
            image = ImageOps.exif_transpose(source)
            image.load()
    scale = min(1.0, OCR_IMAGE_MAX_EDGE / max(image.width, image.height))
    if scale < 1.0:
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(size, Image.Resampling.LANCZOS)
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def unfence(text: str) -> str:
    """The transcription without a code fence around the whole answer (some models add one)."""
    match = _FENCE.match(text.strip())
    return match.group("body") if match else text.strip()


class OpenAIOcrClient:
    """OcrEngine over OpenAI chat completions; one page per call."""

    def __init__(self, http: httpx.AsyncClient | None = None) -> None:
        self.settings = get_settings()
        if self.settings.openai_api_key is None:
            raise ProviderError("OpenAI is not configured.", retryable=False)
        self._http = http

    async def ocr(self, data: bytes, mime: str, *, document_id: str | None, page_count: int) -> OcrResponse:
        if page_count != 1:
            raise ProviderError("OCR with OpenAI takes one page per request.", retryable=False)
        model = self.settings.openai_ocr_model_name
        await check_budget(token_cost(model, ESTIMATE_INPUT_TOKENS, ESTIMATE_OUTPUT_TOKENS))
        png = await asyncio.to_thread(page_png, data, mime)
        body: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": ocr_prompt()},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url(png, "image/png"), "detail": "high"},
                        }
                    ],
                },
            ],
            "max_completion_tokens": OCR_MAX_OUTPUT_TOKENS,
        }
        payload = await post_openai_chat(self._http, body, label="OpenAI OCR", timeout_s=TIMEOUT_S)
        usage = payload.get("usage") or {}
        in_tok, out_tok = usage.get("prompt_tokens"), usage.get("completion_tokens")
        choice = (payload.get("choices") or [{}])[0] or {}
        text = (choice.get("message") or {}).get("content")
        finish = choice.get("finish_reason")
        ok = isinstance(text, str) and finish != "length"
        await record_usage(
            Usage(
                PROVIDER,
                "ocr",
                payload.get("model") or model,
                in_tok,
                out_tok,
                1,
                token_cost(model, in_tok, out_tok),
                ok,
            ),
            document_id,
        )
        if finish == "length":
            raise ProviderError("The page transcription was cut off (too long).", retryable=True)
        if not isinstance(text, str):
            raise ProviderError("OpenAI OCR returned no text for this page.", retryable=True)
        tag = model_tag(model)
        raw = {
            "pages": [
                {"index": 0, "markdown": unfence(text), "tables": [], "blocks": [], "dimensions": None}
            ],
            "model": tag,
            "usage_info": {"pages_processed": 1},
        }
        return OcrResponse(raw, tag, 1)
