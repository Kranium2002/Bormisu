"""Compatibility module: the structured-output client is app.providers.llm (OpenRouter or OpenAI).

`OpenRouterClient` is the provider-aware `LlmClient`; LLM_PROVIDER and the keys at hand pick the provider.
"""

from __future__ import annotations

from app.providers.llm import LlmClient, OutputTruncatedError, StructuredResult, image_part, text_part

OpenRouterClient = LlmClient

__all__ = [
    "LlmClient",
    "OpenRouterClient",
    "OutputTruncatedError",
    "StructuredResult",
    "image_part",
    "text_part",
]
