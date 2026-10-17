"""Expected results per file, read from a JSON file (for example the data audit's summaries).

Accepted shapes: a list of entries; an object with the list under "files", "documents" or "entries"; or an
object that maps a file id to its entry. Every field is optional. A field the harness cannot read with
certainty leaves its comparison "not comparable"; nothing is guessed. Fields (audit names first):

    doc | file | file_name | name | id     the file (or folder) the entry is about
    borehole_count                         number of boreholes in the file
    boreholes[]:
        id | label | borehole_id           label as printed
        pages                              "16-17", "p. 3, 5", 7, [16, 17] or [[16, 17], [20, 20]]
        x_raw, y_raw                       coordinates exactly as printed
        coordinates                        free text holding the coordinates as printed; text without a
                                           digit means none are printed
        crs_status                         stated | inferred | confirmed | unknown
        total_depth_m | total_depth        number in metres | printed length with its unit ("12,40 m")
        layer_count | layers               number of layers | list of layers
        unplotted_reason                   contract enum or null (only when the key is present)
    duplicate_of                           ids of files this file repeats pages of
    cross_file_links                       free text; ids of other files of the run named in it count as
                                           duplicate links (used when `duplicate_of` is absent)

Reading is language-independent: page lists are read only when they are plain numbers and ranges, total
depths only when they are one length with a unit (app.normalize.units), coordinates are compared as text.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Any

from app.normalize.units import parse_length
from app.review.service import canonical_label

CRS_STATUSES = frozenset({"stated", "inferred", "confirmed", "unknown"})
UNPLOTTED_REASONS = frozenset({"no_coordinates", "crs_unknown", "crs_unconfirmed", "implausible"})

_ID_FIELDS = ("doc", "file", "file_name", "name", "id")
_LABEL_FIELDS = ("id", "label", "borehole_id")
_LIST_KEYS = ("files", "documents", "entries")

# One element of a page list: an optional short word ("p.", "pp", "S.") before a number or a range.
_WORD = r"(?:[^\W\d_]{1,8}\.?\s*)?"
_PAGE_ITEM = re.compile(rf"^\s*{_WORD}(\d+)(?:\s*[-‐-―]\s*{_WORD}(\d+))?\s*\.?\s*$")
_QUOTES = str.maketrans(
    {
        "′": "'",  # prime
        "’": "'",
        "‘": "'",
        "´": "'",
        "`": "'",
        '"': "''",
        "“": "''",
        "”": "''",
        "−": "-",  # minus sign
        "–": "-",
        "—": "-",
    }
)
_TOKEN = re.compile(r"[^\W_]+")


class ExpectedFileError(ValueError):
    """The expected-results file cannot be read; the message names no values from it."""


# ----------------------------------------------------------------------------------------------
# Text helpers
# ----------------------------------------------------------------------------------------------


def file_key(text: str) -> str:
    """Comparison key of a file name or id: case-folded letters and digits only."""
    return "".join(ch for ch in unicodedata.normalize("NFKC", text).casefold() if ch.isalnum())


def name_keys(name: str) -> tuple[str, str]:
    """Keys of a file name with and without its extension (the path part is dropped)."""
    base = PurePath(name.replace("\\", "/")).name or name
    return file_key(base), file_key(PurePath(base).stem)


def squash(text: str) -> str:
    """Printed text for comparison: NFKC, one kind of quote and minus, case-folded, no whitespace."""
    folded = unicodedata.normalize("NFKC", text).translate(_QUOTES).casefold()
    return "".join(folded.split())


def mentions(text: str, keys: Iterable[str]) -> bool:
    """Whether `text` names one of the file `keys` as a whole token (adjacent tokens may be joined, so
    "AB-01 png" names "ab01png")."""
    tokens = [t.casefold() for t in _TOKEN.findall(unicodedata.normalize("NFKC", text))]
    joined = {"".join(tokens[i : i + n]) for n in (1, 2, 3) for i in range(len(tokens) - n + 1)}
    return any(key and key in joined for key in keys)


def parse_pages(value: Any, *, max_pages: int) -> frozenset[int] | None:
    """Page numbers from an int, a list of ints or [from, to] pairs, or plain text of numbers and ranges
    separated by commas or semicolons. Anything else (words between numbers, brackets) gives None."""
    pages: set[int] = set()

    def add(first: int, last: int) -> bool:
        if first < 1 or last < first or last - first + 1 > max_pages:
            return False
        pages.update(range(first, last + 1))
        return True

    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return frozenset({value}) if add(value, value) else None
    if isinstance(value, str):
        parts = [p for p in re.split(r"[,;]", value) if p.strip()]
        if not parts:
            return None
        for part in parts:
            match = _PAGE_ITEM.match(part)
            if match is None:
                return None
            first = int(match.group(1))
            last = int(match.group(2)) if match.group(2) else first
            if not add(first, last):
                return None
        return frozenset(pages)
    if isinstance(value, list):
        if not value:
            return None
        for item in value:
            if isinstance(item, bool):
                return None
            if isinstance(item, int):
                if not add(item, item):
                    return None
            elif (
                isinstance(item, list)
                and len(item) == 2
                and all(isinstance(n, int) and not isinstance(n, bool) for n in item)
            ):
                if not add(item[0], item[1]):
                    return None
            elif isinstance(item, str):
                sub = parse_pages(item, max_pages=max_pages)
                if sub is None:
                    return None
                pages.update(sub)
            else:
                return None
        return frozenset(pages)
    return None


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _depth(entry: Mapping[str, Any]) -> float | None:
    number = entry.get("total_depth_m")
    if isinstance(number, int | float) and not isinstance(number, bool):
        return float(number)
    printed = _text(entry.get("total_depth"))
    if printed is None or not any(ch.isdigit() for ch in printed):
        return None
    return parse_length(printed).metres


# ----------------------------------------------------------------------------------------------
# Model
# ----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ExpectedBorehole:
    label: str
    canonical: str
    pages: frozenset[int] | None
    x_raw: str | None
    y_raw: str | None
    coordinates_text: str | None
    has_coordinates: bool | None  # None: the entry does not say
    crs_status: str | None
    total_depth_m: float | None
    layer_count: int | None
    unplotted_known: bool  # the expected unplotted reason is known (it may be None: plotted)
    unplotted_reason: str | None


@dataclass(frozen=True)
class ExpectedFile:
    name: str  # the entry's file field, used only to match files and other entries
    borehole_count: int | None
    boreholes: tuple[ExpectedBorehole, ...]
    duplicate_of: tuple[str, ...] | None  # structured links
    links_text: str | None  # free-text links (audit)

    @property
    def keys(self) -> tuple[str, str]:
        return name_keys(self.name)

    @property
    def listed_completely(self) -> bool:
        """Every borehole of the file is listed (the count, when given, equals the list)."""
        return self.borehole_count is None or self.borehole_count == len(self.boreholes)


def _borehole(entry: Mapping[str, Any], *, max_pages: int) -> ExpectedBorehole | None:
    label = next((v for k in _LABEL_FIELDS if isinstance(v := entry.get(k), str) and v.strip()), None)
    if label is None:
        return None
    x_raw, y_raw = _text(entry.get("x_raw")), _text(entry.get("y_raw"))
    coordinates_text = _text(entry.get("coordinates"))
    has_coordinates: bool | None = None
    if x_raw is not None or y_raw is not None:
        has_coordinates = True
    elif "x_raw" in entry and "y_raw" in entry:
        has_coordinates = False  # both keys present and null
    elif coordinates_text is not None:
        has_coordinates = any(ch.isdigit() for ch in coordinates_text)
    crs_status = _text(entry.get("crs_status"))
    if crs_status not in CRS_STATUSES:
        crs_status = "unknown" if has_coordinates is False else None
    unplotted_known = False
    unplotted: str | None = None
    if "unplotted_reason" in entry:
        value = entry["unplotted_reason"]
        if value is None or value in UNPLOTTED_REASONS:
            unplotted_known, unplotted = True, value
    elif has_coordinates is False:
        unplotted_known, unplotted = True, "no_coordinates"
    layers = entry.get("layers")
    layer_count = _int(entry.get("layer_count"))
    if layer_count is None and isinstance(layers, list):
        layer_count = len(layers)
    return ExpectedBorehole(
        label=label,
        canonical=canonical_label(label),
        pages=parse_pages(entry.get("pages"), max_pages=max_pages),
        x_raw=x_raw,
        y_raw=y_raw,
        coordinates_text=coordinates_text,
        has_coordinates=has_coordinates,
        crs_status=crs_status,
        total_depth_m=_depth(entry),
        layer_count=layer_count,
        unplotted_known=unplotted_known,
        unplotted_reason=unplotted,
    )


def _entry(raw: Mapping[str, Any], fallback_name: str | None, *, max_pages: int) -> ExpectedFile | None:
    name = next((v for k in _ID_FIELDS if isinstance(v := raw.get(k), str) and v.strip()), fallback_name)
    if name is None:
        return None
    holes = raw.get("boreholes")
    boreholes = tuple(
        b
        for item in (holes if isinstance(holes, list) else [])
        if isinstance(item, Mapping) and (b := _borehole(item, max_pages=max_pages)) is not None
    )
    duplicate_of: tuple[str, ...] | None = None
    dup = raw.get("duplicate_of")
    if isinstance(dup, str):
        duplicate_of = (dup,) if dup.strip() else ()
    elif isinstance(dup, list):
        duplicate_of = tuple(d for d in dup if isinstance(d, str) and d.strip())
    elif "duplicate_of" in raw and dup is None:
        duplicate_of = ()
    count = _int(raw.get("borehole_count"))
    return ExpectedFile(
        name=name,
        borehole_count=count,
        boreholes=boreholes,
        duplicate_of=duplicate_of,
        links_text=_text(raw.get("cross_file_links")),
    )


def parse_expected(data: Any, *, max_pages: int) -> list[ExpectedFile]:
    items: list[tuple[Mapping[str, Any], str | None]] = []
    if isinstance(data, list):
        items = [(item, None) for item in data if isinstance(item, Mapping)]
    elif isinstance(data, Mapping):
        listed = next((data[k] for k in _LIST_KEYS if isinstance(data.get(k), list)), None)
        if listed is not None:
            items = [(item, None) for item in listed if isinstance(item, Mapping)]
        else:
            items = [(value, str(key)) for key, value in data.items() if isinstance(value, Mapping)]
    else:
        raise ExpectedFileError("The expected-results file must hold a JSON list or object.")
    entries = [e for raw, name in items if (e := _entry(raw, name, max_pages=max_pages)) is not None]
    if not entries:
        raise ExpectedFileError("The expected-results file has no entry with a file name.")
    return entries


def load_expected(path: Path, *, max_pages: int) -> list[ExpectedFile]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise ExpectedFileError(f"The expected-results file cannot be read ({type(exc).__name__}).") from exc
    except json.JSONDecodeError as exc:
        raise ExpectedFileError(f"The expected-results file is not valid JSON (line {exc.lineno}).") from exc
    return parse_expected(data, max_pages=max_pages)


def find_entry(entries: Sequence[ExpectedFile], name: str) -> ExpectedFile | None:
    """The entry for a file id or name: an exact key match first, then a match without extensions.
    None when nothing matches; ExpectedFileError when several entries match equally well."""
    whole, stem = name_keys(name)
    for key in dict.fromkeys((whole, stem)):
        found = [e for e in entries if key and key in e.keys]
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            raise ExpectedFileError(f"More than one expected entry matches '{name}'.")
    return None
