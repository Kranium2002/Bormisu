"""Contract helpers shared by the backend test suites.

Validates payloads against ``contracts/openapi.yaml`` (OpenAPI 3.1, whose schemas are JSON Schema
2020-12) with plain ``jsonschema`` + ``referencing``; no openapi-core or schemathesis.

Usage from any test module::

    from tests.contract_utils import validate_response, validate_schema

    validate_schema(payload, "BoreholeRecord")
    validate_response("GET", "/api/v1/boreholes/bh_01...", 200, response.json())

The whole spec is registered as one JSON Schema resource under ``SPEC_URI``, so the spec's own
``#/components/...`` references resolve exactly as written. Format keywords (``date``,
``date-time``) are checked.

``CONTRACT_PATH`` (environment) may point at the yaml when the tests run outside a full checkout,
for example inside the backend container with the contracts folder mounted.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import referencing
import referencing.jsonschema
import yaml
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

__all__ = [
    "ERROR_FALLBACK_STATUSES",
    "EXAMPLES_DIR",
    "REPO_ROOT",
    "SPEC_PATH",
    "SPEC_URI",
    "find_operation",
    "iter_operations",
    "iter_refs",
    "load_spec",
    "parse_value_path",
    "resolve_pointer",
    "resolve_value_path",
    "schema_errors",
    "validate_response",
    "validate_schema",
    "value_path_fields",
]

SPEC_URI = "urn:geomemory:openapi"
HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
# Statuses a route may return without declaring them, as long as the body is an Error
# (contract conventions: every non-2xx JSON response is an Error).
ERROR_FALLBACK_STATUSES = frozenset({404, 405, 409, 413, 415, 422, 500, 503})
_MAX_MESSAGE = 300


def _find_spec_path() -> Path:
    env = os.environ.get("CONTRACT_PATH")
    if env:
        path = Path(env).expanduser().resolve()
        return path / "openapi.yaml" if path.is_dir() else path
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "contracts" / "openapi.yaml"
        if candidate.is_file():
            return candidate
    # Not found: keep the checkout layout (backend/tests/ -> repo root) so load_spec() names the miss.
    return here.parents[2] / "contracts" / "openapi.yaml"


SPEC_PATH: Path = _find_spec_path()
REPO_ROOT: Path = SPEC_PATH.parent.parent
EXAMPLES_DIR: Path = REPO_ROOT / "contracts" / "examples"


# --------------------------------------------------------------------------------------------
# Spec loading and references
# --------------------------------------------------------------------------------------------


@cache
def load_spec() -> dict[str, Any]:
    """The parsed OpenAPI document (cached; treat it as read-only)."""
    if not SPEC_PATH.is_file():
        raise FileNotFoundError(
            f"OpenAPI contract not found at {SPEC_PATH}. Set CONTRACT_PATH to contracts/openapi.yaml."
        )
    with SPEC_PATH.open(encoding="utf-8") as handle:
        spec = yaml.safe_load(handle)
    if not isinstance(spec, dict) or "paths" not in spec or "components" not in spec:
        raise ValueError(f"{SPEC_PATH} is not an OpenAPI document with paths and components")
    return spec


@cache
def _registry() -> referencing.Registry[Any]:
    resource = referencing.Resource.from_contents(
        load_spec(), default_specification=referencing.jsonschema.DRAFT202012
    )
    registry: referencing.Registry[Any] = referencing.Registry().with_resource(SPEC_URI, resource)
    return registry


def _escape_token(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def _unescape_token(token: str) -> str:
    return token.replace("~1", "/").replace("~0", "~")


def resolve_pointer(pointer: str) -> Any:
    """Resolve a JSON pointer such as ``/components/schemas/Error`` (or ``#/...``) in the spec."""
    if pointer.startswith("#"):
        pointer = pointer[1:]
    node: Any = load_spec()
    if pointer in ("", "/"):
        return node
    if not pointer.startswith("/"):
        raise KeyError(f"not a local JSON pointer: {pointer!r}")
    for raw in pointer[1:].split("/"):
        token = _unescape_token(raw)
        if isinstance(node, list):
            node = node[int(token)]
        elif isinstance(node, dict) and token in node:
            node = node[token]
        else:
            raise KeyError(f"unresolvable pointer {pointer!r} at {token!r}")
    return node


def iter_refs(node: Any, location: str = "") -> Iterator[tuple[str, str]]:
    """Yield ``(json_pointer_of_the_ref_holder, ref_value)`` for every ``$ref`` below ``node``."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            yield location, ref
        for key, value in node.items():
            yield from iter_refs(value, f"{location}/{_escape_token(str(key))}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from iter_refs(value, f"{location}/{index}")


def _deref(node: Any, pointer: str) -> tuple[Any, str]:
    """Follow local ``$ref`` objects (e.g. components/responses) and track where we end up."""
    seen: set[str] = set()
    while isinstance(node, dict) and isinstance(node.get("$ref"), str):
        ref = node["$ref"]
        if not ref.startswith("#/") or ref in seen:
            raise ValueError(f"cannot follow $ref {ref!r} at {pointer}")
        seen.add(ref)
        pointer = ref[1:]
        node = resolve_pointer(pointer)
    return node, pointer


# --------------------------------------------------------------------------------------------
# Schema validation
# --------------------------------------------------------------------------------------------


@cache
def _validator(pointer: str) -> Draft202012Validator:
    schema = {"$ref": f"{SPEC_URI}#{quote(pointer, safe='/~')}"}
    return Draft202012Validator(
        schema, registry=_registry(), format_checker=Draft202012Validator.FORMAT_CHECKER
    )


_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _json_path(parts: Any) -> str:
    out = "$"
    for part in parts:
        if isinstance(part, int):
            out += f"[{part}]"
        elif _IDENTIFIER.match(str(part)):
            out += f".{part}"
        else:
            out += f"[{json.dumps(str(part), ensure_ascii=False)}]"
    return out


def _short(message: str) -> str:
    return message if len(message) <= _MAX_MESSAGE else message[: _MAX_MESSAGE - 3] + "..."


def _format_error(error: ValidationError) -> str:
    where = _json_path(error.absolute_path)
    if error.validator in ("oneOf", "anyOf") and error.context:
        # The deepest branch error sits in the branch whose type matched; it is the useful one.
        closest = max(error.context, key=lambda e: (len(e.absolute_path), e.validator != "type"))
        return (
            f"{where}: matches no {error.validator} branch "
            f"(closest: {_json_path(closest.absolute_path)}: {_short(closest.message)})"
        )
    return f"{where}: {_short(error.message)}"


def _errors_at(instance: Any, pointer: str) -> list[str]:
    errors = sorted(
        _validator(pointer).iter_errors(instance),
        key=lambda e: ([str(p) for p in e.absolute_path], e.message),
    )
    return [_format_error(error) for error in errors]


def schema_errors(instance: Any, schema_name: str) -> list[str]:
    """Every validation error of ``instance`` against ``#/components/schemas/<schema_name>``.

    Each entry is ``"<json path>: <message>"``; an empty list means the instance is valid.
    """
    schemas = load_spec()["components"].get("schemas", {})
    if schema_name not in schemas:
        raise KeyError(f"unknown schema {schema_name!r}; known: {', '.join(sorted(schemas))}")
    return _errors_at(instance, f"/components/schemas/{_escape_token(schema_name)}")


def validate_schema(instance: Any, schema_name: str) -> None:
    """Raise AssertionError listing every error (with its JSON path) against the named schema."""
    errors = schema_errors(instance, schema_name)
    if errors:
        listing = "\n  ".join(errors)
        raise AssertionError(f"{len(errors)} error(s) against {schema_name}:\n  {listing}")


# --------------------------------------------------------------------------------------------
# Operations and responses
# --------------------------------------------------------------------------------------------


def iter_operations() -> list[tuple[str, str, dict[str, Any]]]:
    """``(METHOD, path_template, operation)`` for every operation in the spec, in spec order."""
    out: list[tuple[str, str, dict[str, Any]]] = []
    for template, item in load_spec()["paths"].items():
        for method in HTTP_METHODS:
            if method in item:
                out.append((method.upper(), template, item[method]))
    return out


@cache
def _path_matchers() -> list[tuple[re.Pattern[str], str]]:
    def specificity(template: str) -> tuple[int, int]:
        literal = re.sub(r"\{[^}]+\}", "", template)
        return (template.count("{"), -len(literal))

    matchers = []
    for template in sorted(load_spec()["paths"], key=specificity):
        parts = re.split(r"(\{[^}]+\})", template)
        regex = "".join("[^/]+" if part.startswith("{") else re.escape(part) for part in parts)
        matchers.append((re.compile(regex), template))
    return matchers


def find_operation(method: str, path: str) -> tuple[str, dict[str, Any]]:
    """Match a concrete request path to its spec template; return ``(template, operation)``.

    ``path`` may carry a query string or be a full URL. Literal templates win over templated
    ones. Raises KeyError when no template matches or the template lacks ``method``.
    """
    parsed = urlsplit(path)
    concrete = parsed.path or "/"
    verb = method.lower()
    matched: list[str] = []
    for regex, template in _path_matchers():
        if regex.fullmatch(concrete):
            matched.append(template)
            operation = load_spec()["paths"][template].get(verb)
            if isinstance(operation, dict):
                return template, operation
    if matched:
        raise KeyError(f"{method.upper()} {concrete}: path matches {matched} but the method is not declared")
    raise KeyError(f"{method.upper()} {concrete}: no path template in the contract matches")


def _media_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _is_json(media: str) -> bool:
    return media == "application/json" or media.endswith("+json")


def _response_key(responses: dict[str, Any], status: int) -> str | None:
    for key in (str(status), f"{status // 100}XX", f"{status // 100}xx", "default"):
        if key in responses:
            return key
    return None


def validate_response(
    method: str,
    path: str,
    status: int,
    body: Any,
    content_type: str = "application/json",
) -> None:
    """Check one HTTP response against the contract; raise AssertionError on any mismatch.

    - The status must be declared on the operation (or covered by ``4XX``/``default``). An
      undeclared status in ``ERROR_FALLBACK_STATUSES`` is accepted when the body is an ``Error``.
    - JSON media types (``application/json``, ``application/geo+json``) validate ``body`` (the
      parsed JSON) against the schema declared for that media type.
    - Other media types (``image/png``, ``text/event-stream``) only check that the status and the
      media type are declared; ``body`` is ignored.
    - A response without declared content (e.g. 204) must have an empty body.
    """
    template, operation = find_operation(method, path)
    verb = method.lower()
    label = f"{method.upper()} {path} -> {status}"
    responses: dict[str, Any] = operation.get("responses", {})
    media = _media_type(content_type)
    key = _response_key(responses, status)

    if key is None:
        if status in ERROR_FALLBACK_STATUSES and _is_json(media):
            errors = schema_errors(body, "Error")
            if errors:
                listing = "\n  ".join(errors)
                raise AssertionError(
                    f"{label}: undeclared status {status} for {template}, and the body is not an Error:"
                    f"\n  {listing}"
                )
            return
        raise AssertionError(
            f"{label}: undeclared status {status} for {verb.upper()} {template} "
            f"(declared: {', '.join(responses) or 'none'})"
        )

    base = f"/paths/{_escape_token(template)}/{verb}/responses/{_escape_token(key)}"
    response, pointer = _deref(responses[key], base)
    content: dict[str, Any] = response.get("content") or {}

    if not content:
        if body not in (None, b"", ""):
            raise AssertionError(f"{label}: the contract declares no body for this status, got {body!r}")
        return
    if media not in content:
        raise AssertionError(
            f"{label}: media type {media!r} not declared for this status (declared: {', '.join(content)})"
        )
    if not _is_json(media):
        return
    if "schema" not in content[media]:
        return
    errors = _errors_at(body, f"{pointer}/content/{_escape_token(media)}/schema")
    if errors:
        listing = "\n  ".join(errors)
        raise AssertionError(f"{label}: {len(errors)} contract error(s) for {template}:\n  {listing}")


# --------------------------------------------------------------------------------------------
# ValuePatch path grammar (the keys of BoreholeRecord.provenance)
# --------------------------------------------------------------------------------------------

_VALUE_PATH = re.compile(
    r"(?P<root>rock_head_m)"
    r"|metadata\.coordinates\.(?P<coord>[A-Za-z_][A-Za-z0-9_]*)"
    r"|metadata\.(?P<meta>[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<array>stratigraphy|groundwater|samples|test_results)"
    r"\[(?P<index>0|[1-9][0-9]*)\]\.(?P<field>[A-Za-z_][A-Za-z0-9_]*)"
)


@cache
def value_path_fields() -> dict[str, frozenset[str]]:
    """Allowed leaf fields per path prefix, derived from the contract's schemas."""
    schemas = load_spec()["components"]["schemas"]

    def fields(name: str) -> frozenset[str]:
        return frozenset(schemas[name].get("properties", {}))

    return {
        "metadata": fields("BoreholeMetadata") - {"coordinates"},
        "metadata.coordinates": fields("Coordinates"),
        "stratigraphy": fields("Layer"),
        "groundwater": fields("GroundwaterReading"),
        "samples": fields("Sample"),
        "test_results": frozenset({"value"}),
    }


def parse_value_path(path: str) -> tuple[str | int, ...]:
    """Split a ValuePatch path into JSON keys and indices; raise ValueError when it is invalid.

    Grammar (contract, ValuePatch): metadata.<BoreholeMetadata field>,
    metadata.coordinates.<Coordinates field>, rock_head_m, stratigraphy[i].<Layer field>,
    groundwater[i].<GroundwaterReading field>, samples[i].<Sample field>, test_results[i].value.
    """
    match = _VALUE_PATH.fullmatch(path)
    if match is None:
        raise ValueError(f"{path!r} does not match the ValuePatch path grammar")
    allowed = value_path_fields()
    if match["root"]:
        return ("rock_head_m",)
    if match["coord"] is not None:
        if match["coord"] not in allowed["metadata.coordinates"]:
            raise ValueError(f"{path!r}: {match['coord']!r} is not a Coordinates field")
        return ("metadata", "coordinates", match["coord"])
    if match["meta"] is not None:
        if match["meta"] not in allowed["metadata"]:
            raise ValueError(f"{path!r}: {match['meta']!r} is not a BoreholeMetadata value field")
        return ("metadata", match["meta"])
    array, field = match["array"], match["field"]
    if field not in allowed[array]:
        raise ValueError(f"{path!r}: {field!r} is not a valid field of {array}[]")
    return (array, int(match["index"]), field)


def resolve_value_path(record: dict[str, Any], path: str) -> Any:
    """Value at a ValuePatch path in a BoreholeRecord body.

    Raises ValueError for a path outside the grammar and KeyError when the record lacks the
    field or the array index (the key must be present; its value may be null).
    """
    node: Any = record
    for part in parse_value_path(path):
        if isinstance(part, int):
            if not isinstance(node, list) or part >= len(node):
                raise KeyError(f"{path!r}: index {part} does not exist in the record")
        elif not isinstance(node, dict) or part not in node:
            raise KeyError(f"{path!r}: field {part!r} does not exist in the record")
        node = node[part]
    return node
