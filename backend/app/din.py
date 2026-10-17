"""DIN 4023 codes from assets/din4023_patterns/din_codes.json.

Keys are the enum for `din4023_code`. They are case-sensitive (`mG` medium gravel, `Mg` till marl) and
two contain `ö`: never lower-case or normalise them.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from app.config import get_settings


@lru_cache
def din_codes() -> dict[str, dict[str, Any]]:
    path = get_settings().din_codes_path
    with path.open(encoding="utf-8") as handle:
        data: dict[str, dict[str, Any]] = json.load(handle)
    return data


def is_din_code(code: str) -> bool:
    return code in din_codes()


def din_kind(code: str | None) -> str | None:
    """`soil`, `rock` or `geological`; None for unknown codes."""
    if code is None:
        return None
    entry = din_codes().get(code)
    return None if entry is None else str(entry.get("kind"))
