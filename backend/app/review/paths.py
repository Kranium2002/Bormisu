"""Value paths (contract ValuePatch grammar) and typed access to a record body.

Valid paths: metadata.<BoreholeMetadata field>, metadata.coordinates.<Coordinates field>, rock_head_m,
stratigraphy[i].<Layer field>, groundwater[i].<GroundwaterReading field>, samples[i].<Sample field>,
test_results[i].value. Indices are 0-based positions in the record.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

from app.din import is_din_code
from app.normalize.spt import parse_spt
from app.schemas.boreholes import (
    BoreholeMetadata,
    Coordinates,
    GroundwaterReading,
    Layer,
    Sample,
    TestResult,
)

_ARRAY_MODELS: dict[str, type[BaseModel]] = {
    "stratigraphy": Layer,
    "groundwater": GroundwaterReading,
    "samples": Sample,
    "test_results": TestResult,
}
_COORDS = re.compile(r"^metadata\.coordinates\.([a-z_]+)$")
_META = re.compile(r"^metadata\.([A-Za-z_]+)$")
_ARRAY = re.compile(r"^(stratigraphy|groundwater|samples|test_results)\[(0|[1-9][0-9]{0,5})\]\.([a-z0-9_]+)$")


class PathError(ValueError):
    """The path does not follow the grammar or does not exist in the record."""


class ValueParseError(ValueError):
    """The value cannot be parsed for the path's type."""


def spt_n_rule(index: int | None) -> str:
    """How SPT text is corrected (contract ValuePatch): spt_n_value takes a whole number only."""
    return (
        "spt_n_value takes a whole number of blows; correct blow counts and refusals in "
        f"stratigraphy[{index}].spt_raw instead, which the server parses again into spt_refusal, "
        "spt_n_value (null on a refusal), spt_increments, spt_increment_mm and spt_penetration_cm"
    )


def _spt_n_message(vp: ValuePath, value: str, reason: str) -> str:
    """An unusable spt_n_value text: a refusal ("50/12", "R") has no N; SPT text belongs in spt_raw."""
    if value.strip() and parse_spt(value).refusal is True:
        reason = f"'{value.strip()}' is an SPT refusal, which has no N value"
    return f"{reason}. {spt_n_rule(vp.index)}"


@dataclass(frozen=True)
class ValuePath:
    section: str  # metadata | coordinates | rock_head_m | stratigraphy | groundwater | samples | test_results
    field: str
    index: int | None = None

    def __str__(self) -> str:
        if self.section == "rock_head_m":
            return "rock_head_m"
        if self.section == "metadata":
            return f"metadata.{self.field}"
        if self.section == "coordinates":
            return f"metadata.coordinates.{self.field}"
        return f"{self.section}[{self.index}].{self.field}"

    @property
    def model(self) -> type[BaseModel] | None:
        if self.section == "metadata":
            return BoreholeMetadata
        if self.section == "coordinates":
            return Coordinates
        return _ARRAY_MODELS.get(self.section)


def parse_path(path: str) -> ValuePath:
    if path == "rock_head_m":
        return ValuePath("rock_head_m", "rock_head_m")
    if m := _COORDS.match(path):
        field = m.group(1)
        if field not in Coordinates.model_fields:
            raise PathError(path)
        return ValuePath("coordinates", field)
    if m := _META.match(path):
        field = m.group(1)
        if field not in BoreholeMetadata.model_fields or field == "coordinates":
            raise PathError(path)
        return ValuePath("metadata", field)
    if m := _ARRAY.match(path):
        section, index, field = m.group(1), int(m.group(2)), m.group(3)
        if section == "test_results" and field != "value":
            raise PathError(path)
        if field not in _ARRAY_MODELS[section].model_fields:
            raise PathError(path)
        return ValuePath(section, field, index)
    raise PathError(path)


def _container(body: dict[str, Any], vp: ValuePath) -> dict[str, Any] | None:
    if vp.section == "rock_head_m":
        return body
    if vp.section == "metadata":
        meta = body.get("metadata")
        return meta if isinstance(meta, dict) else None
    if vp.section == "coordinates":
        meta = body.get("metadata")
        coords = meta.get("coordinates") if isinstance(meta, dict) else None
        return coords if isinstance(coords, dict) else None
    items = body.get(vp.section)
    if not isinstance(items, list) or vp.index is None or vp.index >= len(items):
        return None
    item = items[vp.index]
    return item if isinstance(item, dict) else None


def path_exists(body: dict[str, Any], path: str | ValuePath) -> bool:
    try:
        vp = parse_path(path) if isinstance(path, str) else path
    except PathError:
        return False
    return _container(body, vp) is not None


def get_value(body: dict[str, Any], path: str | ValuePath) -> Any:
    vp = parse_path(path) if isinstance(path, str) else path
    container = _container(body, vp)
    if container is None:
        raise PathError(str(vp))
    return container.get(vp.field)


def set_value(body: dict[str, Any], path: str | ValuePath, value: Any) -> None:
    vp = parse_path(path) if isinstance(path, str) else path
    container = _container(body, vp)
    if container is None:
        raise PathError(str(vp))
    container[vp.field] = value


def _prepare_number(value: Any) -> Any:
    """Accept numbers and plain numeric strings ("12.5", "12,5", "−3"); the model does the rest."""
    if isinstance(value, str):
        text = value.strip().replace("−", "-").replace(" ", "").replace(" ", "")
        if text.count(",") == 1 and "." not in text:
            text = text.replace(",", ".")
        return text
    return value


def coerce_value(body: dict[str, Any], path: str | ValuePath, value: Any) -> Any:
    """Validate `value` for the path's field type and return its JSON form, or raise ValueParseError."""
    vp = parse_path(path) if isinstance(path, str) else path
    if vp.section == "rock_head_m":
        if value is None:
            return None
        if isinstance(value, bool):
            raise ValueParseError("rock_head_m needs a number, not true/false")
        try:
            number = float(_prepare_number(value))
        except (TypeError, ValueError) as exc:
            raise ValueParseError("rock_head_m must be a number in metres") from exc
        if not math.isfinite(number):
            raise ValueParseError("rock_head_m must be a finite number")
        if number < 0:
            raise ValueParseError("rock_head_m cannot be negative")
        return number
    model = vp.model
    container = _container(body, vp)
    if model is None or container is None:
        raise PathError(str(vp))
    annotation = str(model.model_fields[vp.field].annotation)
    candidate = value
    numeric = (
        ("float" in annotation or "int" in annotation)
        and "str" not in annotation
        and "bool" not in annotation
    )
    if numeric and isinstance(value, bool):
        raise ValueParseError(f"{vp.field} needs a number, not true/false")
    if isinstance(value, bool):
        candidate = value
    elif numeric:
        candidate = _prepare_number(value)
    elif "str" in annotation and isinstance(value, int | float):
        candidate = str(value)
    trial = dict(container)
    trial[vp.field] = candidate
    try:
        validated = model.model_validate(trial)
    except ValidationError as exc:
        messages = "; ".join(e["msg"] for e in exc.errors() if vp.field in [str(p) for p in e["loc"]])
        message = messages or f"value is not valid for {vp}"
        if vp.section == "stratigraphy" and vp.field == "spt_n_value" and isinstance(value, str):
            message = _spt_n_message(vp, value, message)
        raise ValueParseError(message) from exc
    result = validated.model_dump(mode="json")[vp.field]
    if isinstance(result, float) and not math.isfinite(result):
        raise ValueParseError(f"{vp.field} must be a finite number")
    if vp.field == "din4023_code" and result is not None and not is_din_code(result):
        raise ValueParseError("din4023_code must be a DIN 4023 code from din_codes.json (case-sensitive)")
    if vp.field == "spt_n_value" and isinstance(value, float) and not value.is_integer():
        raise ValueParseError("spt_n_value must be a whole number")
    return result


def iter_paths(body: dict[str, Any]) -> Iterator[str]:
    """Every path the grammar allows for this body (whether or not it has provenance)."""
    yield "rock_head_m"
    meta = body.get("metadata") or {}
    for name in BoreholeMetadata.model_fields:
        if name != "coordinates":
            yield f"metadata.{name}"
    if isinstance(meta.get("coordinates"), dict):
        for name in Coordinates.model_fields:
            yield f"metadata.coordinates.{name}"
    for section, model in _ARRAY_MODELS.items():
        for i, _ in enumerate(body.get(section) or []):
            if section == "test_results":
                yield f"test_results[{i}].value"
            else:
                for name in model.model_fields:
                    yield f"{section}[{i}].{name}"


# Values the server computes itself; they need no provenance entry of their own.
SERVER_COMPUTED_SUFFIXES = (".thickness_m", ".description_language")
SERVER_COMPUTED_PATHS = frozenset(
    {"metadata.coordinates.crs_code", "metadata.coordinates.crs_label", "metadata.aliases"}
)


def uncovered_paths(body: dict[str, Any], provenance: dict[str, Any]) -> list[str]:
    """Paths with a non-null value but no provenance entry (values nobody can check against a source)."""
    missing = []
    for path in iter_paths(body):
        if path in provenance or path in SERVER_COMPUTED_PATHS or path.endswith(SERVER_COMPUTED_SUFFIXES):
            continue
        value = get_value(body, path)
        if value is None or value == [] or value == "":
            continue
        missing.append(path)
    return missing
