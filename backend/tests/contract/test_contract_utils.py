"""Unit tests for tests/contract_utils.py (the contract validator other suites import)."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from tests.contract_utils import (
    EXAMPLES_DIR,
    REPO_ROOT,
    SPEC_PATH,
    find_operation,
    iter_operations,
    load_spec,
    parse_value_path,
    resolve_value_path,
    schema_errors,
    validate_response,
    validate_schema,
)


def example(name: str) -> Any:
    return json.loads((EXAMPLES_DIR / name).read_text(encoding="utf-8"))


DOC_ID = example("Document.needs_review.json")["document_id"]
UID = example("BoreholeRecord.full.json")["uid"]
RS_ID = example("ResultSet.located.json")["result_set_id"]


def test_paths_point_at_the_contract() -> None:
    assert (REPO_ROOT / "contracts" / "openapi.yaml").is_file()
    assert SPEC_PATH.name == "openapi.yaml" and SPEC_PATH.is_file()
    assert EXAMPLES_DIR == REPO_ROOT / "contracts" / "examples"
    assert load_spec() is load_spec()  # cached


@pytest.mark.parametrize(
    ("method", "path", "template"),
    [
        ("GET", "/api/health", "/api/health"),
        ("GET", "/api/v1/documents", "/api/v1/documents"),
        ("post", "/api/v1/documents", "/api/v1/documents"),
        ("GET", f"/api/v1/documents/{DOC_ID}", "/api/v1/documents/{document_id}"),
        ("GET", f"/api/v1/documents/{DOC_ID}/pages/3.png", "/api/v1/documents/{document_id}/pages/{n}.png"),
        (
            "GET",
            f"/api/v1/documents/{DOC_ID}/pages/12.png?w=800",
            "/api/v1/documents/{document_id}/pages/{n}.png",
        ),
        (
            "POST",
            f"/api/v1/documents/{DOC_ID}/approve-clean?dry_run=true",
            "/api/v1/documents/{document_id}/approve-clean",
        ),
        ("GET", f"/api/v1/boreholes/{UID}", "/api/v1/boreholes/{uid}"),
        ("PATCH", f"/api/v1/boreholes/{UID}/values", "/api/v1/boreholes/{uid}/values"),
        ("GET", "/api/v1/boreholes?plotted=false", "/api/v1/boreholes"),
        ("GET", "/api/v1/map/boreholes.geojson", "/api/v1/map/boreholes.geojson"),
        ("GET", f"/api/v1/result-sets/{RS_ID}/geojson", "/api/v1/result-sets/{result_set_id}/geojson"),
        ("GET", f"/api/v1/result-sets/{RS_ID}", "/api/v1/result-sets/{result_set_id}"),
        ("GET", "http://localhost:8000/api/v1/geocode?q=Lindenwick", "/api/v1/geocode"),
    ],
)
def test_find_operation_matches_templates(method: str, path: str, template: str) -> None:
    found, operation = find_operation(method, path)
    assert found == template
    assert "responses" in operation


def test_find_operation_returns_the_operation_for_the_method() -> None:
    _, get_op = find_operation("GET", f"/api/v1/documents/{DOC_ID}")
    _, delete_op = find_operation("DELETE", f"/api/v1/documents/{DOC_ID}")
    assert get_op["operationId"] == "getDocument"
    assert delete_op["operationId"] == "deleteDocument"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/nope"),
        ("GET", f"/api/v1/documents/{DOC_ID}/pages/3.jpg"),
        ("GET", f"/api/v1/boreholes/{UID}/values/extra"),
        ("PUT", f"/api/v1/boreholes/{UID}"),  # path exists, method does not
    ],
)
def test_find_operation_raises_key_error(method: str, path: str) -> None:
    with pytest.raises(KeyError):
        find_operation(method, path)


def test_iter_operations_lists_every_operation_once() -> None:
    operations = iter_operations()
    ids = [op["operationId"] for _, _, op in operations]
    assert len(ids) == len(set(ids))
    assert ("PATCH", "/api/v1/boreholes/{uid}/values") in {(m, t) for m, t, _ in operations}
    assert all(method.isupper() for method, _, _ in operations)
    expected = sum(
        1
        for item in load_spec()["paths"].values()
        for key in item
        if key in {"get", "put", "post", "delete", "patch", "head", "options", "trace"}
    )
    assert len(operations) == expected


def test_validate_schema_accepts_an_example_and_lists_errors_with_paths() -> None:
    record = example("BoreholeRecord.full.json")
    validate_schema(record, "BoreholeRecord")
    assert schema_errors(record, "BoreholeRecord") == []

    broken = copy.deepcopy(record)
    del broken["uid"]
    broken["stratigraphy"][1]["spt_n_value"] = "twenty"
    broken["provenance"]["metadata.borehole_id"]["method"] = "magic"
    broken["updated_at"] = "17 October"
    errors = schema_errors(broken, "BoreholeRecord")
    assert len(errors) == 4
    joined = "\n".join(errors)
    assert "$: 'uid' is a required property" in joined
    assert "$.stratigraphy[1].spt_n_value" in joined
    assert '$.provenance["metadata.borehole_id"].method' in joined
    assert "$.updated_at: '17 October' is not a 'date-time'" in joined
    with pytest.raises(AssertionError, match=r"4 error\(s\) against BoreholeRecord"):
        validate_schema(broken, "BoreholeRecord")


def test_validate_schema_rejects_unknown_schema_names() -> None:
    with pytest.raises(KeyError):
        schema_errors({}, "NoSuchSchema")


def test_oneof_errors_name_the_closest_branch() -> None:
    document = copy.deepcopy(example("Document.needs_review.json"))
    document["completeness"]["missing"] = "FHL-BH03"
    (error,) = schema_errors(document, "Document")
    assert error.startswith("$.completeness:")
    assert "closest: $.completeness.missing" in error


def test_validate_response_accepts_valid_examples() -> None:
    validate_response("GET", "/api/v1/health", 200, example("Health.live.json"))
    validate_response("GET", f"/api/v1/documents/{DOC_ID}", 200, example("Document.needs_review.json"))
    validate_response("GET", "/api/v1/documents", 200, example("DocumentList.json"))
    validate_response("POST", "/api/v1/documents", 202, example("UploadAccepted.queued.json"))
    validate_response("POST", "/api/v1/documents", 200, example("UploadAccepted.duplicate.json"))
    validate_response(
        "GET", f"/api/v1/documents/{DOC_ID}/boreholes", 200, [example("BoreholeRecord.full.json")]
    )
    validate_response("PATCH", f"/api/v1/boreholes/{UID}/values", 200, example("BoreholeRecord.full.json"))
    validate_response(
        "GET",
        "/api/v1/map/boreholes.geojson",
        200,
        example("BoreholeFeatureCollection.json"),
        content_type="application/geo+json",
    )
    validate_response("GET", "/api/v1/geocode?q=Lindenwick", 200, example("PlaceCandidate.list.json"))
    validate_response("POST", f"/api/v1/documents/{DOC_ID}/approve-clean", 200, {"count": 12})


def test_validate_response_rejects_a_broken_body() -> None:
    document = copy.deepcopy(example("Document.needs_review.json"))
    del document["status"]
    document["pages"][0]["type"] = "poster"
    with pytest.raises(AssertionError) as caught:
        validate_response("GET", f"/api/v1/documents/{DOC_ID}", 200, document)
    message = str(caught.value)
    assert "'status' is a required property" in message
    assert "$.pages[0].type" in message

    with pytest.raises(AssertionError, match="count"):
        validate_response("POST", f"/api/v1/documents/{DOC_ID}/approve-clean", 200, {"count": -1})
    with pytest.raises(AssertionError):
        validate_response("GET", f"/api/v1/documents/{DOC_ID}/boreholes", 200, [{"uid": UID}])


def test_validate_response_accepts_error_bodies() -> None:
    not_found = example("Error.document_not_found.json")
    validate_response("GET", f"/api/v1/documents/{DOC_ID}", 404, not_found)  # declared 404
    validate_response("GET", f"/api/v1/boreholes/{UID}", 404, example("Error.borehole_not_found.json"))
    validate_response(
        "GET", f"/api/v1/documents/{DOC_ID}/boreholes", 404, not_found
    )  # undeclared, Error-shaped
    validate_response("POST", "/api/v1/result-sets", 422, example("Error.validation_error.json"))
    validate_response("GET", "/api/v1/documents", 500, example("Error.internal_error.json"))
    validate_response("POST", "/api/v1/documents", 409, example("Error.demo_mode.json"))


def test_validate_response_rejects_bad_errors_and_undeclared_statuses() -> None:
    with pytest.raises(AssertionError, match="not an Error"):
        validate_response("GET", f"/api/v1/documents/{DOC_ID}/boreholes", 404, {"detail": "Not Found"})
    with pytest.raises(AssertionError, match="code"):
        validate_response("GET", f"/api/v1/documents/{DOC_ID}", 404, {"detail": "Not Found"})
    with pytest.raises(AssertionError, match="undeclared status"):
        validate_response("GET", "/api/v1/documents", 201, example("DocumentList.json"))
    with pytest.raises(AssertionError, match="undeclared status"):
        validate_response("GET", "/api/v1/documents", 418, example("Error.internal_error.json"))


def test_validate_response_media_types_and_empty_bodies() -> None:
    validate_response(
        "GET", f"/api/v1/documents/{DOC_ID}/pages/3.png", 200, b"\x89PNG", content_type="image/png"
    )
    validate_response("GET", "/api/v1/events", 200, None, content_type="text/event-stream")
    validate_response("POST", "/api/v1/chat", 200, None, content_type="text/event-stream; charset=utf-8")
    validate_response("DELETE", f"/api/v1/documents/{DOC_ID}", 204, None)
    with pytest.raises(AssertionError, match="no body"):
        validate_response("DELETE", f"/api/v1/documents/{DOC_ID}", 204, {"deleted": True})
    with pytest.raises(AssertionError, match="media type"):
        validate_response(
            "GET", "/api/v1/map/boreholes.geojson", 200, example("BoreholeFeatureCollection.json")
        )
    with pytest.raises(AssertionError, match="undeclared status"):
        validate_response(
            "GET", f"/api/v1/documents/{DOC_ID}/pages/3.png", 201, b"", content_type="image/png"
        )


@pytest.mark.parametrize(
    ("path", "parts"),
    [
        ("rock_head_m", ("rock_head_m",)),
        ("metadata.borehole_depth_m", ("metadata", "borehole_depth_m")),
        ("metadata.surface_elevation_mASL", ("metadata", "surface_elevation_mASL")),
        ("metadata.coordinates.x_raw", ("metadata", "coordinates", "x_raw")),
        ("stratigraphy[2].spt_n_value", ("stratigraphy", 2, "spt_n_value")),
        ("groundwater[0].depth_m", ("groundwater", 0, "depth_m")),
        ("samples[10].name", ("samples", 10, "name")),
        ("test_results[1].value", ("test_results", 1, "value")),
    ],
)
def test_parse_value_path_accepts_the_grammar(path: str, parts: tuple[Any, ...]) -> None:
    assert parse_value_path(path) == parts


@pytest.mark.parametrize(
    "path",
    [
        "geotechnical_tests.water_table_m",
        "metadata.coordinates",
        "metadata.unknown_field",
        "metadata.coordinates.zone",
        "stratigraphy[01].depth_to_m",
        "stratigraphy[-1].depth_to_m",
        "stratigraphy.0.depth_to_m",
        "stratigraphy[0].water_table_m",
        "test_results[0].unit",
        "lint[0].path",
        "uid",
    ],
)
def test_parse_value_path_rejects_other_paths(path: str) -> None:
    with pytest.raises(ValueError):
        parse_value_path(path)


def test_resolve_value_path_requires_the_field_to_exist() -> None:
    record = example("BoreholeRecord.full.json")
    assert resolve_value_path(record, "stratigraphy[1].spt_n_value") == 20
    assert resolve_value_path(record, "metadata.inclination_deg") is None
    with pytest.raises(KeyError):
        resolve_value_path(record, "stratigraphy[99].depth_to_m")
    trimmed = copy.deepcopy(record)
    del trimmed["stratigraphy"][0]["colour"]
    with pytest.raises(KeyError):
        resolve_value_path(trimmed, "stratigraphy[0].colour")
