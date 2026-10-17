"""FICTIONAL record builders for tests."""

from __future__ import annotations

from typing import Any

from app.review.paths import get_value, iter_paths, uncovered_paths
from app.schemas.boreholes import BoreholeBody, ProvenanceIn


def full_provenance(
    body: dict[str, Any],
    *,
    page: int = 1,
    method: str = "ocr",
    confidence: float = 0.95,
    **overrides: ProvenanceIn,
) -> dict[str, ProvenanceIn]:
    """Provenance for every non-null value of a fictional body (boxes are placeholders on page `page`)."""
    data = BoreholeBody.model_validate(body).model_dump(mode="json")
    prov: dict[str, ProvenanceIn] = {}
    for i, path in enumerate(uncovered_paths(data, {})):
        value = get_value(data, path)
        prov[path] = ProvenanceIn(
            page=page,
            box=[0.05, min(0.02 + 0.01 * i, 0.95), 0.2, 0.012],
            raw=str(value),
            method=method,  # type: ignore[arg-type]
            confidence=confidence,
        )
    prov.update({k.replace("__", "."): v for k, v in overrides.items()})
    assert set(prov) <= set(iter_paths(data))
    return prov
