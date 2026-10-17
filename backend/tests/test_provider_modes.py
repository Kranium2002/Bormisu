"""Health providers and mode for every combination of provider keys (fake values; nothing is called)."""

from __future__ import annotations

import itertools
from collections.abc import Iterator
from typing import Any

import pytest

from app.api.v1.system import build_health
from app.config import get_settings

KEYS = ("MISTRAL_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY")


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    def set_env(keys: dict[str, bool], **values: str) -> None:
        for name in KEYS:
            monkeypatch.setenv(name, "test-not-a-key" if keys.get(name) else "")
        for name, value in values.items():
            monkeypatch.setenv(name, value)
        get_settings.cache_clear()

    yield set_env
    get_settings.cache_clear()


@pytest.mark.parametrize(
    ("mistral", "openrouter", "openai"), list(itertools.product((False, True), repeat=3))
)
def test_health_and_mode_for_every_key_combination(
    env: Any, mistral: bool, openrouter: bool, openai: bool
) -> None:
    env(dict(zip(KEYS, (mistral, openrouter, openai), strict=True)))
    health = build_health()
    llm = openrouter or openai
    assert health.providers.ocr is (mistral or openrouter or openai)
    assert health.providers.classifier is llm and health.providers.extractor is llm
    assert health.providers.chat is openai
    # Any one of OPENROUTER_API_KEY or OPENAI_API_KEY gives live mode; Mistral alone covers OCR only.
    assert health.mode == ("live" if llm else "demo")
    settings = get_settings()
    expected_ocr = [
        r for r, on in (("mistral", mistral), ("openrouter", openrouter), ("openai", openai)) if on
    ]
    assert settings.ocr_routes == expected_ocr
    assert settings.llm_routes == [r for r, on in (("openrouter", openrouter), ("openai", openai)) if on]


@pytest.mark.parametrize(
    ("keys", "values", "ocr", "llm", "mode"),
    [
        ({"OPENROUTER_API_KEY": True}, {"LLM_PROVIDER": "openai"}, True, False, "demo"),
        ({"OPENAI_API_KEY": True}, {"LLM_PROVIDER": "openai"}, True, True, "live"),
        ({"OPENAI_API_KEY": True}, {"OCR_PROVIDER": "openrouter"}, False, True, "demo"),
        ({"OPENAI_API_KEY": True}, {"OCR_PROVIDER": "openai"}, True, True, "live"),
        ({"OPENAI_API_KEY": True, "MISTRAL_API_KEY": True}, {"OCR_PROVIDER": "mistral"}, True, True, "live"),
        ({"OPENAI_API_KEY": True}, {"OCR_FALLBACK": "none"}, False, True, "demo"),
        ({"OPENAI_API_KEY": True, "MISTRAL_API_KEY": True}, {"OCR_FALLBACK": "none"}, True, True, "live"),
    ],
)
def test_forced_providers(
    env: Any, keys: dict[str, bool], values: dict[str, str], ocr: bool, llm: bool, mode: str
) -> None:
    env(keys, **values)
    health = build_health()
    assert health.providers.ocr is ocr
    assert health.providers.classifier is llm and health.providers.extractor is llm
    assert health.mode == mode


def test_models_per_provider(env: Any) -> None:
    env({"OPENAI_API_KEY": True}, CHAT_MODEL="gpt-fictional")
    settings = get_settings()
    assert settings.llm_model("classifier", "openai") == "gpt-fictional"
    assert settings.llm_model("extractor", "openai") == "gpt-fictional"
    assert settings.openai_ocr_model_name == "gpt-fictional"
    assert settings.llm_model("classifier", "openrouter") == settings.classifier_model
    assert settings.llm_model("extractor", "openrouter") == settings.extractor_model
    env(
        {"OPENAI_API_KEY": True},
        OPENAI_CLASSIFIER_MODEL="gpt-fictional-small",
        OPENAI_EXTRACTOR_MODEL="gpt-fictional-large",
        OPENAI_OCR_MODEL="gpt-fictional-vision",
        OPENAI_BASE_URL="",
    )
    settings = get_settings()
    assert settings.llm_model("classifier", "openai") == "gpt-fictional-small"
    assert settings.llm_model("extractor", "openai") == "gpt-fictional-large"
    assert settings.openai_ocr_model_name == "gpt-fictional-vision"
    assert settings.openai_base_url == "https://api.openai.com/v1"  # blank: the default
