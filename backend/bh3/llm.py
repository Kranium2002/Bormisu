"""Constrained LLM step. Used ONLY for

  1. normalising free-text layer descriptions into schema fields (lithology, USCS unit, colour, ...)
  2. filling metadata fields the alias extractor could not find, from the header text alone
  3. the vision calls of the raster path (`complete_vision_json`, used by bh3.vlm)

The client speaks the OpenAI chat-completions protocol, so the same code works with
a hosted API today and with a local server (Ollama, vLLM, llama.cpp server, LM Studio)
later — change LLM_BASE_URL / LLM_MODEL in .env, nothing else.

Determinism measures: temperature 0, fixed seed, JSON-schema constrained output where the
server supports it (fallback: json_object + validation), and an on-disk cache keyed by
sha256(model + prompt) so re-runs never call the model twice for the same input.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv

log = logging.getLogger(__name__)

load_dotenv()  # reads .env from CWD or parents

DEFAULT_BASE_URL = "https://api.mistral.ai/v1"
DEFAULT_MODEL = "mistral-small-latest"


class LLMConfig:
    def __init__(self, enabled: bool = True, cache_dir: Optional[str] = None, model: Optional[str] = None,
                 vision_model: Optional[str] = None):
        self.enabled = enabled
        self.base_url = os.environ.get("LLM_BASE_URL", DEFAULT_BASE_URL)
        self.api_key = (os.environ.get("LLM_API_KEY") or os.environ.get("MISTRAL_API_KEY")
                        or os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY") or "ollama")
        self.model = model or os.environ.get("LLM_MODEL", DEFAULT_MODEL)
        self.vision_model = vision_model or os.environ.get("LLM_VISION_MODEL", self.model)
        self.cache_dir = Path(cache_dir or os.environ.get("LLM_CACHE_DIR", ".llm_cache"))
        self.max_batch = int(os.environ.get("LLM_BATCH", "25"))
        self.supports_schema = os.environ.get("LLM_JSON_SCHEMA", "1") != "0"
        self.extra_headers = {}


# ---------------------------------------------------------------------------
# schemas
# ---------------------------------------------------------------------------
USCS = ["GW", "GP", "GM", "GC", "GW-GM", "GW-GC", "GP-GM", "GP-GC", "GC-GM", "SW", "SP", "SM", "SC", "SW-SM", "SW-SC",
        "SP-SM", "SP-SC", "SC-SM", "ML", "CL", "OL", "MH", "CH", "OH", "CL-ML", "PT", "ROCK", "FILL", "UNKNOWN"]
LITHOLOGY = ["Topsoil", "Fill", "Clay", "Silt", "Sand", "Gravel", "Cobbles", "Boulders", "Peat", "Organic soil",
             "Sandstone", "Siltstone", "Claystone", "Mudstone", "Shale", "Limestone", "Dolomite", "Chalk", "Marl",
             "Caliche", "Calcarenite", "Conglomerate", "Breccia", "Granite", "Gneiss", "Schist", "Basalt", "Other rock",
             "No recovery", "Unknown"]

LAYER_SCHEMA = {
    "type": "object",
    "properties": {
        "layers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "lithology": {"type": "string", "enum": LITHOLOGY},
                    "soil_unit": {"type": "string", "enum": USCS},
                    "color": {"type": "string"},
                    "consistency": {"type": "string",
                                    "description": "soil consistency/density or rock strength as written, e.g. 'very soft', 'medium dense', 'moderately strong'; empty if absent"},
                    "moisture": {"type": "string", "description": "dry/moist/wet/saturated or empty"},
                    "is_rock": {"type": "boolean"},
                    "stratigraphic_name": {"type": "string", "description": "formation / unit name if stated, else empty"},
                    "geologic_age": {"type": "string", "description": "if stated, else empty"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["id", "lithology", "soil_unit", "color", "consistency", "moisture", "is_rock",
                             "stratigraphic_name", "geologic_age", "confidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["layers"],
    "additionalProperties": False,
}

HEADER_FIELDS = ["BoreholeName", "LocationName", "StartDate", "EndDate", "ProjectID", "ProjectName",
                 "Surface Elevation", "X-Coordinate", "Y-Coordinate", "CoordinateSystem", "BoreholeDepth",
                 "Groundwaterlevel", "Client", "Contractor"]
HEADER_SCHEMA = {
    "type": "object",
    "properties": {f: {"type": ["string", "null"]} for f in HEADER_FIELDS},
    "required": HEADER_FIELDS,
    "additionalProperties": False,
}

SYSTEM_LAYERS = (
    "You are a geotechnical data-entry assistant. You receive borehole layer descriptions (any language) "
    "and must classify each one into fixed vocabularies. Rules: 'lithology' is the dominant material; "
    "'soil_unit' is the USCS group symbol if given in the text or clearly implied (e.g. 'Sandy CLAY, high plasticity' -> CH; "
    "'Clayey SAND' -> SC; 'Topsoil' -> FILL unless a soil type is given; any rock -> ROCK); when unsure use UNKNOWN. "
    "Copy colour/consistency/moisture words from the text (translated to English), do not invent. "
    "Return only JSON matching the schema, one entry per input id, same order."
)
SYSTEM_HEADER = (
    "You extract borehole metadata from the header text of a drilling log (any language). "
    "Return only JSON with exactly the requested keys; use null when a value is not present in the text. "
    "Dates as YYYY-MM-DD when possible. Numbers as plain decimal strings in metres (convert feet). "
    "'Surface Elevation' is the ground/collar level; if only start and end elevations are given, BoreholeDepth = start - end. "
    "Never guess values that are not in the text."
)


# ---------------------------------------------------------------------------
# client
# ---------------------------------------------------------------------------
class LLM:
    def __init__(self, cfg: Optional[LLMConfig] = None):
        self.cfg = cfg or LLMConfig()
        self._client = None
        self.calls = 0
        self.cache_hits = 0
        if self.cfg.enabled:
            self.cfg.cache_dir.mkdir(parents=True, exist_ok=True)

    @property
    def client(self):
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(base_url=self.cfg.base_url, api_key=self.cfg.api_key,
                                  default_headers=self.cfg.extra_headers or None, timeout=120)
        return self._client

    # -- cache ---------------------------------------------------------------
    def _cache_key(self, model: str, messages: list[dict], schema: dict) -> Path:
        h = hashlib.sha256(json.dumps([model, messages, schema], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return self.cfg.cache_dir / f"{h}.json"

    # -- core call -----------------------------------------------------------
    def _complete_json(self, messages: list[dict], schema: dict, name: str, model: Optional[str] = None) -> Optional[dict]:
        if not self.cfg.enabled:
            return None
        model = model or self.cfg.model
        ck = self._cache_key(model, messages, schema)
        if ck.exists():
            self.cache_hits += 1
            return json.loads(ck.read_text(encoding="utf-8"))
        kwargs: dict[str, Any] = dict(model=model, messages=messages, temperature=0)
        if "mistral" in self.cfg.base_url:
            kwargs["extra_body"] = {"random_seed": 0}      # Mistral's name for the seed
        else:
            kwargs["seed"] = 0
        if self.cfg.supports_schema:
            kwargs["response_format"] = {"type": "json_schema",
                                         "json_schema": {"name": name, "strict": True, "schema": schema}}
        else:
            kwargs["response_format"] = {"type": "json_object"}
        out = None
        for attempt in range(3):
            try:
                self.calls += 1
                resp = self.client.chat.completions.create(**kwargs)
                content = resp.choices[0].message.content or ""
                out = _parse_json(content)
                if out is not None:
                    break
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                log.warning("LLM call failed (%s): %s", attempt, msg[:200])
                if "json_schema" in msg or "response_format" in msg or "400" in msg:
                    # server does not support structured outputs → degrade gracefully
                    kwargs["response_format"] = {"type": "json_object"}
                    kwargs["messages"] = messages + [{"role": "system", "content": "Respond with JSON matching this schema: " + json.dumps(schema)}]
                time.sleep(1.5 * (attempt + 1))
        if out is not None:
            ck.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        return out

    # -- tasks ---------------------------------------------------------------
    def normalise_layers(self, descriptions: list[str]) -> list[Optional[dict]]:
        """Return one dict per description (or None when the model was unavailable)."""
        results: list[Optional[dict]] = [None] * len(descriptions)
        if not self.cfg.enabled or not descriptions:
            return results
        idx = list(range(len(descriptions)))
        for b in range(0, len(idx), self.cfg.max_batch):
            batch = idx[b:b + self.cfg.max_batch]
            user = json.dumps([{"id": i, "text": descriptions[i][:600]} for i in batch], ensure_ascii=False)
            msgs = [{"role": "system", "content": SYSTEM_LAYERS}, {"role": "user", "content": user}]
            out = self._complete_json(msgs, LAYER_SCHEMA, "layers")
            if not out:
                continue
            for item in out.get("layers", []):
                i = item.get("id")
                if isinstance(i, int) and 0 <= i < len(results):
                    results[i] = item
        return results

    def fill_header(self, header_text: str, missing: list[str]) -> dict[str, Any]:
        if not self.cfg.enabled or not header_text.strip() or not missing:
            return {}
        msgs = [{"role": "system", "content": SYSTEM_HEADER},
                {"role": "user", "content": f"Fields wanted: {', '.join(missing)}\n\nHEADER TEXT:\n{header_text[:4000]}"}]
        out = self._complete_json(msgs, HEADER_SCHEMA, "header") or {}
        return {k: v for k, v in out.items() if k in missing and v not in (None, "", "null")}

    # -- vision call with its own error path ----------------------------------
    def complete_vision_json(self, image_bytes: bytes, mime: str, system: str, user_text: str, schema: dict,
                             name: str, model: Optional[str] = None, max_tokens: int = 4096,
                             prompt_version: str = "1") -> tuple[Optional[dict], dict]:
        """One image + text → JSON matching `schema`. Returns (result | None, meta).

        meta keys: cache_hit, calls, schema_mode ('json_schema' | 'json_object'), truncated, error,
        prompt_tokens, completion_tokens, latency_s.
        Unlike `_complete_json` this never downgrades the schema on an arbitrary 400 (for images a 400 is
        usually "image too large"), detects `finish_reason == 'length'` (caller should re-tile) and does
        not cache failed or truncated answers. The image is hashed separately for the cache key.
        """
        meta: dict[str, Any] = {"cache_hit": False, "calls": 0, "schema_mode": None, "truncated": False,
                                "error": None, "prompt_tokens": 0, "completion_tokens": 0, "latency_s": 0.0}
        if not self.cfg.enabled:
            meta["error"] = "llm-disabled"
            return None, meta
        model = model or self.cfg.vision_model
        img_hash = hashlib.sha256(image_bytes).hexdigest()
        key = hashlib.sha256(json.dumps([model, system, user_text, schema, img_hash, max_tokens, prompt_version],
                                        sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        ck = self.cfg.cache_dir / f"v_{key}.json"
        if ck.exists():
            self.cache_hits += 1
            meta["cache_hit"] = True
            cached = json.loads(ck.read_text(encoding="utf-8"))
            meta["schema_mode"] = cached.get("_schema_mode")
            return cached.get("result"), meta

        data = base64.b64encode(image_bytes).decode()
        messages = [{"role": "system", "content": system},
                    {"role": "user", "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}}]}]
        kwargs: dict[str, Any] = dict(model=model, messages=messages, temperature=0, max_tokens=max_tokens)
        if "mistral" in self.cfg.base_url:
            kwargs["extra_body"] = {"random_seed": 0}
        else:
            kwargs["seed"] = 0
        schema_mode = "json_schema" if self.cfg.supports_schema else "json_object"

        def _set_format(mode: str) -> None:
            if mode == "json_schema":
                kwargs["response_format"] = {"type": "json_schema",
                                             "json_schema": {"name": name, "strict": True, "schema": schema}}
                kwargs["messages"] = messages
            else:
                kwargs["response_format"] = {"type": "json_object"}
                kwargs["messages"] = [messages[0],
                                      {"role": "system", "content": "Respond with JSON matching this schema exactly: "
                                                                    + json.dumps(schema)}] + messages[1:]

        _set_format(schema_mode)
        out = None
        delay = 2.0
        for attempt in range(6):
            t0 = time.time()
            try:
                self.calls += 1
                meta["calls"] += 1
                resp = self.client.chat.completions.create(**kwargs)
                meta["latency_s"] += time.time() - t0
                usage = getattr(resp, "usage", None)
                if usage:
                    meta["prompt_tokens"] += int(getattr(usage, "prompt_tokens", 0) or 0)
                    meta["completion_tokens"] += int(getattr(usage, "completion_tokens", 0) or 0)
                choice = resp.choices[0]
                if getattr(choice, "finish_reason", None) == "length":
                    meta["truncated"] = True
                    meta["error"] = "truncated"
                    log.warning("vision call truncated (max_tokens=%d) for %s", max_tokens, name)
                    return None, meta
                out = _parse_json(choice.message.content or "")
                if out is None:
                    meta["error"] = "unparseable"
                    log.warning("vision call returned unparseable JSON for %s", name)
                break
            except Exception as e:  # noqa: BLE001
                meta["latency_s"] += time.time() - t0
                msg = str(e)
                low = msg.lower()
                log.warning("vision call failed (%s): %s", attempt, msg[:200])
                if "429" in msg or "rate limit" in low or "too many requests" in low:
                    time.sleep(delay)
                    delay = min(delay * 2, 60)
                    continue
                if "413" in msg or "too large" in low or "payload" in low or "image" in low and "size" in low:
                    meta["error"] = "image-too-large"
                    return None, meta
                if schema_mode == "json_schema" and ("json_schema" in low or "response_format" in low
                                                     or "structured" in low or "schema" in low):
                    schema_mode = "json_object"
                    _set_format(schema_mode)
                    log.info("server rejected json_schema; falling back to json_object for %s", name)
                    continue
                if "timeout" in low or "connection" in low or "502" in msg or "503" in msg or "500" in msg:
                    time.sleep(delay)
                    delay = min(delay * 2, 60)
                    continue
                meta["error"] = msg[:200]
                return None, meta
        meta["schema_mode"] = schema_mode
        if out is not None:
            ck.write_text(json.dumps({"result": out, "_schema_mode": schema_mode, "_model": model},
                                     ensure_ascii=False), encoding="utf-8")
        return out, meta


def _parse_json(content: str) -> Optional[dict]:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
    return None
