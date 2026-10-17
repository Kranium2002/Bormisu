"""Printed coordinate pairs -> geographic or projected values (BACKEND.md 7.8).

Reads decimal degrees (signed or with N/S/E/W in several languages), degrees-minutes-seconds with
° ' " or "d m s" or spaces or colons, degrees with decimal minutes (also three comma-separated groups
whose middle group is below 60: "48,12,345" = 48° 12.345'), and projected grid values with any digit
grouping (spaces, points, commas, apostrophes) and glued labels ("E 512345", "6 123 456 mN").

The order comes from the printed labels (`labels_raw`, or labels glued to the values; vocabulary in
data/crs_patterns.yaml). Values are kept in their printed order and units; when the value read as X
behaves like a latitude or northing, `swap_suspected` is set and a note says why. (0, 0) is never
returned: it is a placeholder, not a position.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from app.normalize.api import CoordinateResult, NumberStyle
from app.normalize.numbers import MINUS_SIGNS, ascii_digits, load_data, parse_number, str_list
from app.normalize.units import lookup_unit

Role = Literal["ns", "ew", "x", "y"]

_QUOTES = {
    "\u2032": "'",
    "\u2019": "'",
    "\u2018": "'",
    "\u00b4": "'",
    "`": "'",
    "\u2033": '"',
    "\u201d": '"',
    "\u201c": '"',
    "º": "°",
    "˚": "°",
}
_MARK = r"[^\W\d_]+"
_NUM = r"[0-9]+(?:[.,][0-9]+)?"
_PRE = rf"^\s*(?:(?P<pre>{_MARK})\.?\s*[:=]?\s*)?(?P<sign>[-+]?)\s*"
_POST = rf"\s*(?P<post>{_MARK})?\.?\s*$"
_DMS_PATTERNS = (
    # 52°31'12.5"N, 52° 31.208' S, 52.52°
    re.compile(
        _PRE + rf"(?P<d>{_NUM})\s*°\s*(?:(?P<m>{_NUM})\s*'\s*)?(?:(?P<s>{_NUM})\s*(?:\"|'')\s*)?" + _POST
    ),
    # 52d 31m 12s N
    re.compile(
        _PRE + rf"(?P<d>{_NUM})\s*d\s*(?:(?P<m>{_NUM})\s*m\s*)?(?:(?P<s>{_NUM})\s*s\s*)?" + _POST, re.I
    ),
    # 52:31:12.5
    re.compile(_PRE + rf"(?P<d>[0-9]{{1,3}}):(?P<m>[0-9]{{1,2}}(?:[.,][0-9]+)?)(?::(?P<s>{_NUM}))?" + _POST),
    # 52 31 12.5 N / 52 31.208
    re.compile(
        _PRE
        + r"(?P<d>[0-9]{1,3})\s+(?P<m>[0-9]{1,2}(?:[.,][0-9]+)?)(?:\s+(?P<s>[0-9]{1,2}(?:[.,][0-9]+)?))?"
        + _POST
    ),
)
# 48,12,345: degrees, whole minutes (< 60) and the decimal part of the minutes
_COMMA_DM = re.compile(_PRE + r"(?P<d>[0-9]{1,3}),(?P<m>[0-9]{1,2}),(?P<f>[0-9]+)" + _POST)


@dataclass(frozen=True)
class _Vocabulary:
    labels: dict[str, Role]
    projected_labels: frozenset[str]  # labels that name a grid axis, never a hemisphere ("easting", "RW")
    geographic_labels: frozenset[str]  # "lat", "long" ...
    hemispheres: dict[str, tuple[Role, int]]
    ambiguous: frozenset[str]
    northing_like_min: float
    easting_like_max: float
    min_decimals: int


def _key(text: str) -> str:
    return re.sub(r"[\s.]+", "", unicodedata.normalize("NFC", text).casefold())


@lru_cache(maxsize=1)
def _vocabulary() -> _Vocabulary:
    data = load_data("crs_patterns.yaml")
    hemispheres: dict[str, tuple[Role, int]] = {}
    hemi = data.get("hemispheres") or {}
    hemisphere_roles: tuple[tuple[str, Role, int], ...] = (
        ("north", "ns", 1),
        ("south", "ns", -1),
        ("east", "ew", 1),
        ("west", "ew", -1),
    )
    for name, role, sign in hemisphere_roles:
        for word in str_list(hemi.get(name)):
            hemispheres[_key(word)] = (role, sign)
    labels: dict[str, Role] = {}
    geographic: set[str] = set()
    axis = data.get("axis_labels") or {}
    label_roles: tuple[tuple[str, Role], ...] = (
        ("east", "ew"),
        ("north", "ns"),
        ("lon", "ew"),
        ("lat", "ns"),
        ("x", "x"),
        ("y", "y"),
    )
    for name, role in label_roles:
        for word in str_list(axis.get(name)):
            labels[_key(word)] = role
            if name in ("lon", "lat"):
                geographic.add(_key(word))
    projected = frozenset(
        _key(w)
        for name in ("east", "north")
        for w in str_list(axis.get(name))
        if len(_key(w)) > 1 and _key(w) not in hemispheres
    )
    checks = data.get("swap_checks") or {}
    return _Vocabulary(
        labels=labels,
        projected_labels=projected,
        geographic_labels=frozenset(geographic),
        hemispheres=hemispheres,
        ambiguous=frozenset(_key(w) for w in str_list(hemi.get("ambiguous"))),
        northing_like_min=float(checks.get("northing_like_min", 1_000_000)),
        easting_like_max=float(checks.get("easting_like_max", 1_000_000)),
        min_decimals=int(data.get("decimal_degree_min_decimals", 4)),
    )


@dataclass(frozen=True)
class _Axis:
    value: float
    form: Literal["decimal", "dms", "dm"]
    role: Role | None = None
    hemisphere: bool = False
    degree_sign: bool = False
    projected_label: bool = False
    geographic_label: bool = False
    decimals: int = 0
    unit: str | None = None
    note: str | None = None
    printed_value: float = 0.0  # the number with its printed sign, before any hemisphere sign


@dataclass(frozen=True)
class _Marker:
    role: Role | None = None
    sign: int | None = None
    unit: str | None = None
    projected: bool = False
    geographic: bool = False


def _marker(text: str | None) -> _Marker | str:
    if not text:
        return _Marker()
    vocab = _vocabulary()
    key = _key(text)
    if key in vocab.hemispheres:
        role, sign = vocab.hemispheres[key]
        return _Marker(role=role, sign=sign)
    if key in vocab.labels:
        return _Marker(
            role=vocab.labels[key],
            projected=key in vocab.projected_labels,
            geographic=key in vocab.geographic_labels,
        )
    if key in vocab.ambiguous:
        return f"'{text}' may mean east or west"
    unit = lookup_unit(text)
    if unit is not None and unit.dimension in ("length", "angle"):
        return _Marker(unit=unit.key)
    return f"unrecognised text '{text}'"


def _combine(pre: _Marker, post: _Marker) -> _Marker | str:
    if pre.role and post.role and pre.role != post.role:
        return "two different axis marks on one value"
    if pre.sign is not None and post.sign is not None and pre.sign != post.sign:
        return "two different hemispheres on one value"
    return _Marker(
        role=pre.role or post.role,
        sign=pre.sign if pre.sign is not None else post.sign,
        unit=pre.unit or post.unit,
        projected=pre.projected or post.projected,
        geographic=pre.geographic or post.geographic,
    )


def _decimals(value: float) -> int:
    text = repr(abs(value))
    if "e" in text or "." not in text:
        return 0
    frac = text.split(".")[1].rstrip("0")
    return len(frac)


def _normalise(text: str) -> str:
    text = ascii_digits(unicodedata.normalize("NFC", text))
    for old, new in _QUOTES.items():
        text = text.replace(old, new)
    for minus in MINUS_SIGNS:
        text = text.replace(minus, "-")
    return text.strip()


def _signed(value: float, sign_text: str, marker: _Marker) -> float | str:
    if sign_text == "-":
        value = -value
    if marker.sign is not None:
        if value < 0 and marker.sign > 0:
            return "minus sign and hemisphere disagree"
        value = abs(value) * marker.sign
    return value


def _axis_from_match(match: re.Match[str], form_hint: str) -> _Axis | str:
    pre, post = _marker(match.group("pre")), _marker(match.group("post"))
    if isinstance(pre, str):
        return pre
    if isinstance(post, str):
        return post
    marker = _combine(pre, post)
    if isinstance(marker, str):
        return marker
    groups = match.groupdict()
    deg_text, min_text, sec_text = groups.get("d"), groups.get("m"), groups.get("s")
    assert deg_text is not None
    degrees = float(deg_text.replace(",", "."))
    note = None
    if form_hint == "comma_dm":
        minutes = float(f"{groups['m']}.{groups['f']}")
        seconds = 0.0
        form: Literal["decimal", "dms", "dm"] = "dm"
        note = "three comma-separated groups read as degrees and decimal minutes"
        if len(groups["f"] or "") <= 2 and float(groups["f"] or 0) < 60:
            note += " (the last group could also be seconds)"
    else:
        minutes = float(min_text.replace(",", ".")) if min_text else 0.0
        seconds = float(sec_text.replace(",", ".")) if sec_text else 0.0
        if min_text and not degrees.is_integer():
            return "decimal degrees followed by minutes"
        if sec_text and not minutes.is_integer():
            return "decimal minutes followed by seconds"
        form = "dms" if sec_text else "dm" if min_text else "decimal"
    if minutes >= 60 or seconds >= 60:
        return "minutes or seconds of 60 or more"
    if degrees > 180:
        return "degrees above 180"
    value = degrees + minutes / 60 + seconds / 3600
    signed = _signed(value, match.group("sign"), marker)
    if isinstance(signed, str):
        return signed
    return _Axis(
        value=round(signed, 9),
        printed_value=round(-value if match.group("sign") == "-" else value, 9),
        form=form,
        role=marker.role,
        hemisphere=marker.sign is not None,
        degree_sign=True,
        projected_label=marker.projected,
        geographic_label=marker.geographic,
        decimals=_decimals(signed),
        unit="deg",
        note=note,
    )


_GROUPED = re.compile(r"^\d{1,6}(?:\s+\d{1,6})+(?:[.,]\d+)?$")


def _parse_axis(raw: str, style: NumberStyle | None) -> _Axis | str:
    text = _normalise(raw)
    if not text:
        return "no value"
    if len(text) > 80:
        return "text too long for a coordinate"
    for pattern in _DMS_PATTERNS:
        match = pattern.match(text)
        if match:
            return _axis_from_match(match, "dms")
    match = _COMMA_DM.match(text)
    if match:
        return _axis_from_match(match, "comma_dm")

    pre_match = re.match(rf"^\s*(?P<pre>{_MARK}(?:\s+{_MARK})?)\s*[.:=]*\s*(?P<rest>.*)$", text)
    pre_text, rest = (pre_match.group("pre"), pre_match.group("rest")) if pre_match else (None, text)
    post_match = re.match(rf"^(?P<rest>.*?[0-9°'\"])\s*(?P<post>{_MARK}(?:\s+{_MARK})?)\.?\s*$", rest)
    post_text = None
    if post_match:
        rest, post_text = post_match.group("rest"), post_match.group("post")
    pre = _marker(pre_text)
    post = _marker(post_text)
    if isinstance(pre, str):
        return pre
    if isinstance(post, str):
        return post
    marker = _combine(pre, post)
    if isinstance(marker, str):
        return marker
    number = parse_number(rest, style=style)
    if number.value is None and _GROUPED.match(rest.strip()):
        # grid values printed in digit groups ("34 21 600" for 3421600, Gauss-Krueger style): the groups are
        # one number when they cannot be degrees, minutes and seconds
        groups = rest.split()
        joined = "".join(groups)
        whole = re.split(r"[.,]", joined)[0]
        if len(whole) >= 6 and (
            marker.role is not None or any(int(re.split(r"[.,]", g)[0]) >= 60 for g in groups[1:])
        ):
            number = parse_number(joined, style=style)
    if number.value is None:
        return number.reason or "not a number"
    unit = marker.unit
    if number.unit is not None:
        resolved = lookup_unit(number.unit)
        if resolved is None or resolved.dimension not in ("length", "angle"):
            return f"unrecognised unit '{number.unit}'"
        unit = resolved.key
    unit_spec = lookup_unit(unit) if unit else None
    degree_sign = unit_spec is not None and unit_spec.dimension == "angle"
    signed = _signed(number.value, "", marker)
    if isinstance(signed, str):
        return signed
    return _Axis(
        value=signed,
        printed_value=number.value,
        form="decimal",
        role=marker.role,
        hemisphere=marker.sign is not None,
        degree_sign=degree_sign,
        projected_label=marker.projected,
        geographic_label=marker.geographic,
        decimals=_decimals(signed),
        unit=unit,
    )


def _label_roles(labels_raw: str | None) -> tuple[list[Role], bool, bool, list[int | None]]:
    """Roles of the first two recognised label words, whether any is projected- or geographic-only, and
    the sign a printed hemisphere label gives ("Lat S")."""
    if not labels_raw:
        return [], False, False, []
    vocab = _vocabulary()
    roles: list[Role] = []
    signs: list[int | None] = []
    projected = geographic = False
    for word in re.findall(r"[^\W\d_]+", unicodedata.normalize("NFC", labels_raw)):
        key = _key(word)
        if key in vocab.labels:
            role = vocab.labels[key]
            projected = projected or key in vocab.projected_labels
            geographic = geographic or key in vocab.geographic_labels
            sign = vocab.hemispheres[key][1] if key in vocab.hemispheres else None
        elif key in vocab.hemispheres:
            role, sign = vocab.hemispheres[key]
        else:
            continue
        if roles and roles[-1] == role and len(roles) == 1 and sign is not None:
            signs[-1] = sign  # "Lat S": the hemisphere qualifies the label before it
            continue
        roles.append(role)
        signs.append(sign)
        if len(roles) == 2:
            break
    return roles, projected, geographic, signs


_TRAILING_NOTE = re.compile(r"\s*\((?=[^()]*[^\W\d_])[^()]*\)\s*$")


def _parse_axis_noted(text: str, style: NumberStyle | None, notes: list[str]) -> _Axis | str:
    """One coordinate; a value that only reads without a note in parentheses after it, e.g. the system
    printed next to the number ("5 819 600.0 (55H MGA94)"), is read without the note."""
    axis = _parse_axis(text, style)
    if isinstance(axis, _Axis):
        return axis
    bare = _TRAILING_NOTE.sub("", text)
    if bare != text and bare.strip():
        retried = _parse_axis(bare.strip(), style)
        if isinstance(retried, _Axis):
            notes.append(f"text in parentheses after '{bare.strip()}' is not part of the coordinate")
            return retried
    return axis


def _split_pair(text: str, style: NumberStyle | None) -> tuple[str, str] | str | None:
    """Two coordinates printed in one field."""
    if len(text) > 120:
        return "text too long for a coordinate pair"
    for separator in (r";", r"\|", r"/", r",\s+", r"\s{2,}", r",", r"\s+"):
        found: list[tuple[str, str]] = []
        for match in re.finditer(separator, text):
            first, second = text[: match.start()].strip(), text[match.end() :].strip()
            if not first or not second:
                continue
            if isinstance(_parse_axis(first, style), _Axis) and isinstance(_parse_axis(second, style), _Axis):
                found.append((first, second))
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            return "the field can be split into two coordinates in more than one way"
    return None


def _result_none(reason: str, notes: list[str]) -> CoordinateResult:
    return CoordinateResult(kind=None, notes=notes, reason=reason)


# Two 2-digit groups read as the system text, and grid values of five digits (an optional glued label and
# decimals): the leading digits of both values were printed raised ("R 22 925  H 70 335" with "34" and
# "53" set above the first digits).
_RAISED_PAIR = re.compile(r"^\s*([0-9]{2})\s+([0-9]{2})\s*$")
_FIVE_DIGITS = re.compile(
    r"^(?P<label>\s*(?:[^\W\d_]+\.?\s*[:=]?\s*)?)(?P<digits>[0-9](?:\s?[0-9]){4})(?P<frac>[.,][0-9]+)?\s*$"
)


def raised_prefixes(system_raw: str | None, x_raw: str | None, y_raw: str | None) -> tuple[str, str] | None:
    """The two values with the raised leading digits in front, when the printed system text is nothing but
    two digit pairs ("34 53") and both values have five digits ("22 925", "70 335" -> "3422925",
    "5370335"); the first pair belongs to the first value. None for anything else."""
    if system_raw is None or x_raw is None or y_raw is None:
        return None
    pair = _RAISED_PAIR.match(ascii_digits(unicodedata.normalize("NFKC", system_raw)))
    if pair is None:
        return None
    joined: list[str] = []
    for prefix, raw in zip(pair.groups(), (x_raw, y_raw), strict=True):
        match = _FIVE_DIGITS.match(ascii_digits(unicodedata.normalize("NFKC", raw)))
        if match is None:
            return None
        digits = re.sub(r"\s", "", match.group("digits"))
        joined.append(f"{match.group('label')}{prefix}{digits}{match.group('frac') or ''}")
    return joined[0], joined[1]


def parse_coordinates(
    x_raw: str | None,
    y_raw: str | None,
    labels_raw: str | None = None,
    style: NumberStyle | None = None,
) -> CoordinateResult:
    """Typed coordinates from the printed pair; kind None with a reason when they cannot be read."""
    notes: list[str] = []
    x_text = x_raw.strip() if x_raw and x_raw.strip() else None
    y_text = y_raw.strip() if y_raw and y_raw.strip() else None
    if x_text is None and y_text is None:
        return _result_none("no coordinates printed", notes)
    if x_text is None or y_text is None:
        single = x_text or y_text or ""
        pair = _split_pair(single, style)
        if not isinstance(pair, tuple):
            return _result_none(pair or "only one coordinate printed", notes)
        x_text, y_text = pair
        notes.append("both coordinates printed in one field")

    x_axis = _parse_axis_noted(x_text, style, notes)
    if isinstance(x_axis, str):
        return _result_none(f"first coordinate '{x_text}': {x_axis}", notes)
    y_axis = _parse_axis_noted(y_text, style, notes)
    if isinstance(y_axis, str):
        return _result_none(f"second coordinate '{y_text}': {y_axis}", notes)
    if x_axis.value == 0 and y_axis.value == 0:
        return _result_none("(0, 0) is a placeholder, not a position", notes)
    for axis in (x_axis, y_axis):
        if axis.note:
            notes.append(axis.note)

    label_roles, label_projected, label_geographic, label_signs = _label_roles(labels_raw)
    axes = [x_axis, y_axis]
    roles: list[Role | None] = [x_axis.role, y_axis.role]
    for i in range(2):
        if i < len(label_roles):
            if roles[i] is None:
                roles[i] = label_roles[i]
            elif {roles[i], label_roles[i]} == {"ns", "ew"}:
                notes.append(f"label '{labels_raw}' and the mark on value {i + 1} disagree; the mark is used")

    # Degree forms and lat/long labels say "degrees"; N/S/E/W letters only do so for values that fit
    # degrees (they also label grid axes: "N 5 412 345").
    degrees = label_geographic or any(
        a.form != "decimal" or a.degree_sign or a.geographic_label for a in axes
    )
    grid = label_projected or any(a.projected_label or a.unit not in (None, "deg") for a in axes)
    beyond_degrees = any(abs(a.value) > 180 for a in axes)

    plain_beyond = any(abs(a.value) > 180 and a.form == "decimal" and not a.degree_sign for a in axes)
    if (degrees and grid) or (plain_beyond and any(a.form != "decimal" or a.degree_sign for a in axes)):
        return _result_none("one value is in degrees and the other is a grid value", notes)
    if degrees or (
        not grid
        and not beyond_degrees
        and (any(a.hemisphere for a in axes) or min(a.decimals for a in axes) >= _vocabulary().min_decimals)
    ):
        if not degrees and not any(a.hemisphere for a in axes):
            notes.append("plain numbers with many decimals read as decimal degrees")
        signs = label_signs + [None] * (2 - len(label_signs))
        values = [
            -abs(a.value) if signs[i] == -1 and not a.hemisphere and a.value > 0 else a.value
            for i, a in enumerate(axes)
        ]
        return _geographic(values, roles, _unique(notes))
    if beyond_degrees or grid:
        return _projected(axes, roles, _unique(notes))
    return _result_none(
        "values fit both degrees and a local grid; the coordinate system is needed to read them", notes
    )


def _unique(notes: list[str]) -> list[str]:
    return list(dict.fromkeys(notes))


def _assign(roles: list[Role | None], first: Role, second: Role) -> tuple[int | None, int | None]:
    """Indexes of the `first`-like and `second`-like axes from the roles (x counts as first, y as second)."""
    a = next((i for i, r in enumerate(roles) if r == first), None)
    b = next((i for i, r in enumerate(roles) if r == second), None)
    if a is None:
        a = next((i for i, r in enumerate(roles) if r == "x" and i != b), None)
    if b is None:
        b = next((i for i, r in enumerate(roles) if r == "y" and i != a), None)
    if a is None and b is not None:
        a = 1 - b
    if b is None and a is not None:
        b = 1 - a
    return a, b


def _geographic(values: list[float], roles: list[Role | None], notes: list[str]) -> CoordinateResult:
    lon_index, lat_index = _assign(roles, "ew", "ns")
    swap = False
    # Only N/S/E/W marks or lat/long labels state the order; X/Y labels do not for degrees (geodetic X is
    # often the latitude), so with both values inside ±90 the order stays to be confirmed.
    assumed = not any(r in ("ns", "ew") for r in roles) and all(abs(v) <= 90 for v in values)
    if lon_index is None or lat_index is None:
        if abs(values[0]) > 90 >= abs(values[1]):
            lon_index, lat_index = 0, 1
        elif abs(values[1]) > 90 >= abs(values[0]):
            lon_index, lat_index = 1, 0
            notes.append("latitude printed first (decided by the value ranges, no labels printed)")
        else:
            lat_index, lon_index = 0, 1  # nothing says: latitude first, the usual way to write degrees
    if assumed:
        notes.append("axis order not printed and both values fit a latitude; to be confirmed with the system")
    if lon_index == lat_index:
        return _result_none("both values are marked as the same axis", notes)
    lat, lon = values[lat_index], values[lon_index]
    if abs(lat) > 90:
        if abs(lon) <= 90:
            notes.append("the value read as latitude exceeds 90 while the other fits a latitude")
            return CoordinateResult(
                kind="geographic",
                swap_suspected=True,
                notes=notes,
                reason="the latitude is outside ±90; the axes look swapped",
            )
        return _result_none("latitude outside ±90", notes)
    if abs(lon) > 180:
        return _result_none("longitude outside ±180", notes)
    return CoordinateResult(
        kind="geographic",
        latitude=lat,
        longitude=lon,
        swap_suspected=swap,
        notes=notes,
        order_assumed=assumed,
    )


def _projected(axes: list[_Axis], roles: list[Role | None], notes: list[str]) -> CoordinateResult:
    east_index, north_index = _assign(roles, "ew", "ns")
    if east_index is None or north_index is None:
        east_index, north_index = 0, 1
    if east_index == north_index:
        return _result_none("both values are marked as the same axis", notes)
    if east_index == 1:
        notes.append("printed order: northing first")
    local_x, local_y = axes[east_index].printed_value, axes[north_index].printed_value
    units = {a.unit for a in axes if a.unit}
    for unit in sorted(units):
        if unit != "m":
            notes.append(f"values printed in {unit}; kept in the printed unit")
    vocab = _vocabulary()
    swap = abs(local_x) >= vocab.northing_like_min and abs(local_y) < vocab.easting_like_max
    if swap:
        notes.append("the value read as easting has the magnitude of a northing and the other of an easting")
    return CoordinateResult(
        kind="projected", local_x=local_x, local_y=local_y, swap_suspected=swap, notes=notes
    )
