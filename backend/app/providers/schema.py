"""Strict JSON schema for structured outputs from a Pydantic model.

Strict mode needs every object closed (`additionalProperties: false`) and every property required, with
nullable fields expressed as a type union. References are inlined because not every provider endpoint
resolves `$defs`.
"""

from __future__ import annotations

import copy
from typing import Any

from pydantic import BaseModel

_DROP = ("title", "default", "examples")


def _inline(node: Any, defs: dict[str, Any]) -> Any:
    if isinstance(node, dict):
        if "$ref" in node:
            target = defs[node["$ref"].split("/")[-1]]
            merged = {**copy.deepcopy(target), **{k: v for k, v in node.items() if k != "$ref"}}
            return _inline(merged, defs)
        out = {k: _inline(v, defs) for k, v in node.items() if k not in _DROP and k != "$defs"}
        variants = out.get("anyOf")
        if isinstance(variants, list) and len(variants) == 2 and {"type": "null"} in variants:
            other = next(v for v in variants if v != {"type": "null"})
            if isinstance(other.get("type"), str) and set(other) <= {
                "type",
                "description",
                "enum",
                "minimum",
                "maximum",
            }:
                del out["anyOf"]
                merged = {**other, "type": [other["type"], "null"]}
                if "enum" in merged:
                    merged["enum"] = [*merged["enum"], None]
                out.update(merged)
        if out.get("type") == "object" and "properties" in out:
            out["additionalProperties"] = False
            out["required"] = list(out["properties"])
        return out
    if isinstance(node, list):
        return [_inline(item, defs) for item in node]
    return node


def strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    raw = model.model_json_schema()
    defs = raw.get("$defs", {})
    schema: dict[str, Any] = _inline(raw, defs)
    return schema
