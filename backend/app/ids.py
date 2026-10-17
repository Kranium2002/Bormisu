"""Opaque ids: a type prefix plus a ULID (doc_…, bh_…, rs_…, cl_…)."""

from ulid import ULID

PREFIXES = ("doc", "bh", "rs", "cl", "ocr", "ext", "pg")


def new_id(prefix: str) -> str:
    if prefix not in PREFIXES:
        raise ValueError(f"unknown id prefix {prefix!r}")
    return f"{prefix}_{ULID()}"
