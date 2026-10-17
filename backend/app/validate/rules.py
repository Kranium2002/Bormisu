"""Record lint rules. Severity and wording come from data/lint_rules.yaml; detection is here.

Each rule takes the record body (JSON form) and yields (path, rule_id, params). Rules never change
values: a value that looks wrong is kept as printed and linted.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from functools import lru_cache
from typing import Any

import yaml

from app.config import get_settings

Finding = tuple[str, str, dict[str, Any]]
Rule = Callable[[dict[str, Any]], Iterator[Finding]]


@lru_cache
def _config() -> dict[str, Any]:
    path = get_settings().data_dir / "lint_rules.yaml"
    with path.open(encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle)
    return data


def _tol() -> float:
    return float(_config().get("tolerance_m", 0.005))


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _fmt(value: float) -> str:
    return f"{value:g}"


def _rule(rule_id: str) -> dict[str, Any]:
    rule: dict[str, Any] = _config()["rules"][rule_id]
    return rule


def _limit(rule_id: str) -> float:
    return float(_rule(rule_id)["limit"])


def _total_depth(body: dict[str, Any]) -> float | None:
    return _num((body.get("metadata") or {}).get("borehole_depth_m"))


def layer_order(body: dict[str, Any]) -> Iterator[Finding]:
    layers = body.get("stratigraphy") or []
    tol = _tol()
    for i, layer in enumerate(layers):
        top, bottom = _num(layer.get("depth_from_m")), _num(layer.get("depth_to_m"))
        if top is not None and bottom is not None and bottom <= top:
            yield f"stratigraphy[{i}].depth_to_m", "layer_inverted", {"to": _fmt(bottom), "from_": _fmt(top)}
    for i in range(1, len(layers)):
        prev_to = _num(layers[i - 1].get("depth_to_m"))
        next_from = _num(layers[i].get("depth_from_m"))
        if prev_to is None or next_from is None:
            continue
        if next_from - prev_to > tol:
            params = {"size": _fmt(round(next_from - prev_to, 3)), "prev": i, "next": i + 1}
            yield f"stratigraphy[{i}].depth_from_m", "layer_gap", params
        elif prev_to - next_from > tol:
            params = {"size": _fmt(round(prev_to - next_from, 3)), "prev": i, "next": i + 1}
            yield f"stratigraphy[{i}].depth_from_m", "layer_overlap", params


def last_layer_vs_total_depth(body: dict[str, Any]) -> Iterator[Finding]:
    layers = body.get("stratigraphy") or []
    depth = _total_depth(body)
    if not layers or depth is None:
        return
    last = len(layers) - 1
    bottom = _num(layers[last].get("depth_to_m"))
    if bottom is None:
        return
    params = {"to": _fmt(bottom), "depth": _fmt(depth)}
    if bottom - depth > _tol():
        yield f"stratigraphy[{last}].depth_to_m", "last_layer_beyond_total_depth", params
    elif depth - bottom > _tol():
        yield f"stratigraphy[{last}].depth_to_m", "last_layer_short_of_total_depth", params


def below_total_depth(body: dict[str, Any]) -> Iterator[Finding]:
    depth = _total_depth(body)
    if depth is None:
        return
    tol = _tol()
    for i, layer in enumerate(body.get("stratigraphy") or []):
        spt = _num(layer.get("spt_depth_m"))
        if spt is not None and spt - depth > tol:
            yield (
                f"stratigraphy[{i}].spt_depth_m",
                "spt_below_total_depth",
                {"spt": _fmt(spt), "depth": _fmt(depth)},
            )
    for i, reading in enumerate(body.get("groundwater") or []):
        gw = _num(reading.get("depth_m"))
        if gw is not None and gw - depth > tol:
            yield (
                f"groundwater[{i}].depth_m",
                "groundwater_below_total_depth",
                {"gw": _fmt(gw), "depth": _fmt(depth)},
            )
    for i, sample in enumerate(body.get("samples") or []):
        top = _num(sample.get("depth_from_m"))
        if top is not None and top - depth > tol:
            params = {"name": sample.get("name"), "value": _fmt(top), "depth": _fmt(depth)}
            yield f"samples[{i}].depth_from_m", "sample_below_total_depth", params


def percent_limits(body: dict[str, Any]) -> Iterator[Finding]:
    rqd_limit, rec_limit = _limit("rqd_above_100"), _limit("recovery_above_100")
    for i, layer in enumerate(body.get("stratigraphy") or []):
        rqd = _num(layer.get("rqd_pct"))
        if rqd is not None and rqd > rqd_limit:
            yield (
                f"stratigraphy[{i}].rqd_pct",
                "rqd_above_100",
                {"value": _fmt(rqd), "limit": _fmt(rqd_limit)},
            )
        rec = _num(layer.get("core_recovery_pct"))
        if rec is not None and rec > rec_limit:
            params = {"value": _fmt(rec), "limit": _fmt(rec_limit)}
            yield f"stratigraphy[{i}].core_recovery_pct", "recovery_above_100", params


def strength_limits(body: dict[str, Any]) -> Iterator[Finding]:
    ucs, cai = _rule("ucs_above_300"), _rule("cai_above_6_5")
    ucs_limit, cai_limit = float(ucs["limit"]), float(cai["limit"])
    ucs_names = {str(n).upper() for n in ucs.get("test_names", [])}
    ucs_units = {str(u).lower() for u in ucs.get("units", [])}
    cai_names = {str(n).upper() for n in cai.get("test_names", [])}
    for i, layer in enumerate(body.get("stratigraphy") or []):
        value = _num(layer.get("ucs_mpa"))
        if value is not None and value > ucs_limit:
            yield (
                f"stratigraphy[{i}].ucs_mpa",
                "ucs_above_300",
                {"value": _fmt(value), "limit": _fmt(ucs_limit)},
            )
    for i, test in enumerate(body.get("test_results") or []):
        value = _num(test.get("value"))
        name = str(test.get("name") or "").strip().upper()
        unit = str(test.get("unit") or "").strip().lower()
        if value is None:
            continue
        if name in ucs_names and unit in ucs_units and value > ucs_limit:
            yield (
                f"test_results[{i}].value",
                "ucs_above_300",
                {"value": _fmt(value), "limit": _fmt(ucs_limit)},
            )
        if name in cai_names and value > cai_limit:
            yield (
                f"test_results[{i}].value",
                "cai_above_6_5",
                {"value": _fmt(value), "limit": _fmt(cai_limit)},
            )


def spt_consistency(body: dict[str, Any]) -> Iterator[Finding]:
    for i, layer in enumerate(body.get("stratigraphy") or []):
        n_value = layer.get("spt_n_value")
        if layer.get("spt_refusal") is True and n_value is not None:
            yield f"stratigraphy[{i}].spt_n_value", "spt_refusal_with_n", {"value": n_value}


def coordinate_range(body: dict[str, Any]) -> Iterator[Finding]:
    coords = (body.get("metadata") or {}).get("coordinates") or {}
    lat, lon = _num(coords.get("latitude")), _num(coords.get("longitude"))
    if lat is None or lon is None:
        return
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        yield (
            "metadata.coordinates.latitude",
            "coordinates_out_of_range",
            {"lat": _fmt(lat), "lon": _fmt(lon)},
        )


RULES: tuple[Rule, ...] = (
    layer_order,
    last_layer_vs_total_depth,
    below_total_depth,
    percent_limits,
    strength_limits,
    spt_consistency,
    coordinate_range,
)


def lint_body(body: dict[str, Any]) -> list[dict[str, Any]]:
    """All findings for a record body, as contract `Lint` objects."""
    findings: list[dict[str, Any]] = []
    for rule in RULES:
        for path, rule_id, params in rule(body):
            spec = _rule(rule_id)
            findings.append(
                {
                    "path": path,
                    "rule": rule_id,
                    "severity": spec["severity"],
                    "message": str(spec["message"]).format(**params),
                }
            )
    return findings
