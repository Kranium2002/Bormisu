"""Standard Penetration Test: increments, printed N and refusals (BACKEND.md 7.8).

`blows_raw` may print increments ("5/7/9", "5-7-9", "5 7 9", "2,3/4,5,6,7" with the seating drive before
the slash), a printed N ("N=23", "(23)"), a refusal ("50/120", "50/12cm", "27/12", "R", ">50", "refusal")
or count/penetration pairs ("5/15 7/15 9/15"). The increment scheme comes from `increment_note_raw` or,
when unique, the number of printed increments; data/spt_schemes.yaml says which increments sum to N.
A refusal never gets an N. A printed N that differs from the computed N is kept and reported.

Rules for slashes, applied in order:
- one item "a/b" is a count over a penetration (a refusal unless the penetration is the full test drive),
  except when the increment note names a two-increment scheme;
- "a/b/c" (only slashes) lists increments; a unit after the last number makes it a penetration;
- items that are all "a/b" are count/penetration pairs;
- in a list with other separators, a "/" inside the list marks the end of the seating drive, a final
  "a/b" is a refusal pair when it carries a unit, follows such a mark, or the list is not comma-separated.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache

from app.normalize.api import SptResult
from app.normalize.numbers import MINUS_SIGNS, ascii_digits, load_data, str_list, word_pattern
from app.normalize.units import lookup_unit, to_metres

_MAX_FIELD = 200  # characters; one SPT record is short, and Python refuses int() of very long digit runs


@dataclass(frozen=True)
class SptScheme:
    id: str
    increment_mm: float
    increments: int
    seating: int

    @property
    def test_count(self) -> int:
        return self.increments - self.seating


@dataclass(frozen=True)
class _Config:
    schemes: tuple[SptScheme, ...]
    by_count: dict[int, str]
    tolerance_mm: float
    test_drive_mm: float
    max_drive_mm: float
    refusal_pattern: re.Pattern[str]
    label_pattern: re.Pattern[str]
    unit_pattern: str  # regex alternation of penetration unit aliases
    joiner_pattern: re.Pattern[str]


@lru_cache(maxsize=1)
def _config() -> _Config:
    data = load_data("spt_schemes.yaml")
    schemes = tuple(
        SptScheme(
            id=str(s["id"]),
            increment_mm=float(s["increment_mm"]),
            increments=int(s["increments"]),
            seating=int(s.get("seating", 0)),
        )
        for s in data.get("schemes") or []
    )
    terms = sorted(str_list(data.get("refusal_terms")), key=len, reverse=True)
    words = [word_pattern(t) for t in terms if len(t) > 1]
    letters = [rf"(?<![A-Za-z]){re.escape(t)}(?![A-Za-z])" for t in terms if len(t) == 1]
    refusal = "|".join([f"(?i:{w})" for w in words] + letters) or r"(?!)"
    labels = sorted(str_list(data.get("n_labels")), key=len, reverse=True)
    label = "|".join(re.escape(lbl) for lbl in labels) or r"(?!)"
    units_data = load_data("units.yaml").get("units") or {}
    aliases: set[str] = set()
    for key in str_list(data.get("penetration_units")):
        aliases.add(key)
        aliases.update(str_list((units_data.get(key) or {}).get("aliases")))
    # only short symbols and words: "mbgl"-style aliases are not penetrations
    unit_aliases = sorted((a for a in aliases if len(a) <= 6 and " " not in a), key=len, reverse=True)
    unit_pattern = "|".join(re.escape(a) for a in unit_aliases)
    joiners = sorted(str_list(data.get("penetration_joiners")), key=len, reverse=True)
    joiner = "|".join(word_pattern(j) for j in joiners) or r"(?!)"
    return _Config(
        schemes=schemes,
        by_count={int(k): str(v) for k, v in (data.get("by_count") or {}).items()},
        tolerance_mm=float(data.get("length_tolerance_mm", 5)),
        test_drive_mm=float(data.get("test_drive_mm", 300)),
        max_drive_mm=float(data.get("max_drive_mm", 450)),
        refusal_pattern=re.compile(refusal),
        label_pattern=re.compile(rf"(?<![A-Za-z])(?:{label})(?![A-Za-z])", re.IGNORECASE),
        unit_pattern=unit_pattern,
        joiner_pattern=re.compile(rf"(?<=[0-9])\s*(?i:{joiner})\s*(?=[0-9])"),
    )


def schemes() -> tuple[SptScheme, ...]:
    return _config().schemes


def _scheme_by_id(scheme_id: str | None) -> SptScheme | None:
    return next((s for s in _config().schemes if s.id == scheme_id), None)


def _clean(raw: str) -> str:
    text = ascii_digits(unicodedata.normalize("NFC", raw))  # NFKC would split ″ (inches) into two primes
    for minus in MINUS_SIGNS:
        text = text.replace(minus, "-")
    return re.sub(r"\s+", " ", text).strip()


def _number(text: str) -> float:
    return float(text.replace(",", "."))


# -------------------------------------------------------------------------------------------------
# Increment note
# -------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Note:
    scheme: SptScheme | None = None
    unit: str | None = None  # length unit the note prints, for unitless penetrations
    reason: str | None = None


def _match_scheme(count: int | None, increment_mm: float | None) -> SptScheme | None:
    cfg = _config()
    found = [
        s
        for s in cfg.schemes
        if (increment_mm is None or abs(s.increment_mm - increment_mm) <= cfg.tolerance_mm)
        and (count is None or count in (s.increments, s.test_count))
    ]
    return found[0] if len(found) == 1 else None


def _parse_note(raw: str | None) -> _Note:
    if raw is None or not raw.strip():
        return _Note()
    text = _clean(raw)
    units = _config().unit_pattern
    match = re.search(rf"([0-9]+)\s*[x×*]\s*([0-9]+(?:[.,][0-9]+)?)\s*({units})?(?![A-Za-z])", text, re.I)
    count: int | None = None
    if match:
        count = int(match.group(1))
        length, unit = _number(match.group(2)), match.group(3)
    else:
        single = re.search(rf"([0-9]+(?:[.,][0-9]+)?)\s*({units})(?![A-Za-z])", text, re.I)
        if single is None:
            return _Note(reason=f"increment note '{raw.strip()}' names no increment length")
        length, unit = _number(single.group(1)), single.group(2)
    if unit is None:
        # "3 x 150": the length unit is not printed; accept it only when one reading fits a scheme
        by_mm = _match_scheme(count, length)
        by_cm = _match_scheme(count, length * 10)
        scheme = by_mm if by_cm is None else by_cm if by_mm is None else None
        if scheme is None:
            return _Note(reason=f"increment note '{raw.strip()}' has no unit and fits no single scheme")
        return _Note(scheme=scheme)
    metres = to_metres(length, unit)
    if metres is None:
        return _Note(reason=f"unknown unit in increment note '{raw.strip()}'")
    scheme = _match_scheme(count, metres * 1000)
    if scheme is None:
        return _Note(
            unit=unit, reason=f"increment note '{raw.strip()}' matches no scheme in spt_schemes.yaml"
        )
    return _Note(scheme=scheme, unit=unit)


# -------------------------------------------------------------------------------------------------
# Printed N
# -------------------------------------------------------------------------------------------------


@dataclass
class _Reading:
    printed_n: int | None = None
    refusal: bool = False
    increments: list[int] | None = None
    split: int | None = None  # number of seating increments marked by a slash
    pen_value: float | None = None
    pen_unit: str | None = None
    pen_mm: float | None = None
    pen_context: list[float] = field(default_factory=list)  # full penetrations of pair records
    parsed: bool = False
    reasons: list[str] = field(default_factory=list)


def _pen_regex() -> str:
    return rf"([0-9]+)/([0-9]+(?:[.,][0-9]+)?)\s*({_config().unit_pattern})?"


def _parse_n(raw: str | None) -> _Reading:
    reading = _Reading()
    if raw is None or not raw.strip():
        return reading
    cfg = _config()
    text = _clean(raw)
    text = cfg.label_pattern.sub(" ", text, count=1)
    text = re.sub(r"^[\s=:]+", "", text).strip(" ()[]")
    if cfg.refusal_pattern.search(text):
        reading.refusal = reading.parsed = True
        text = cfg.refusal_pattern.sub(" ", text).strip(" ()[]-,;")
    if not any(ch.isdigit() for ch in text):
        if text and not reading.refusal:
            reading.reasons.append(f"N '{raw.strip()}' holds no number")
        return reading
    if re.fullmatch(r"(?:>=?|≥)\s*([0-9]+)|([0-9]+)\s*\+", text):
        reading.refusal = reading.parsed = True
        reading.reasons.append(f"N printed as '{text}' (more blows than counted)")
        return reading
    if match := re.fullmatch(_pen_regex(), text, re.I):
        reading.parsed = True
        reading.increments = [int(match.group(1))]
        reading.pen_value, reading.pen_unit = _number(match.group(2)), match.group(3)
        reading.refusal = True
        return reading
    if re.fullmatch(r"[0-9]+", text):
        reading.printed_n = int(text)
        reading.parsed = True
        return reading
    reading.reasons.append(f"N '{raw.strip()}' not understood")
    return reading


# -------------------------------------------------------------------------------------------------
# Blow counts
# -------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Item:
    numbers: tuple[float, ...]
    unit: str | None


def _items(text: str) -> tuple[list[_Item], list[str]] | None:
    units = _config().unit_pattern
    parts = re.split(r"(\s*[,;]\s*|\s*-\s*|\s+)", text)
    items: list[_Item] = []
    separators: list[str] = []
    for index, part in enumerate(parts):
        if index % 2:
            if items:
                separators.append(part.strip() or " ")
            continue
        if not part:
            continue
        match = re.fullmatch(rf"([0-9]+(?:/[0-9]+(?:\.[0-9]+)?)*)({units})?", part, re.I)
        if match is None:
            return None
        items.append(_Item(tuple(float(n) for n in match.group(1).split("/")), match.group(2)))
    return items, separators


def _structure(reading: _Reading, items: list[_Item], separators: list[str], note: _Note) -> None:
    """Fill increments, seating split and refusal penetration from the printed items."""
    sizes = [len(item.numbers) for item in items]
    if len(items) == 1:
        item = items[0]
        if sizes[0] == 1:
            if item.unit:
                reading.reasons.append("a penetration without a blow count")
                return
            reading.printed_n = int(item.numbers[0])
            return
        if sizes[0] == 2:
            two_increments = note.scheme is not None and note.scheme.increments == 2
            if two_increments and not item.unit:
                reading.increments = [int(n) for n in item.numbers]
                return
            reading.increments = [int(item.numbers[0])]
            reading.pen_value, reading.pen_unit = item.numbers[1], item.unit
            reading.refusal = True  # decided against the test drive length in _resolve_penetration
            return
        if item.unit:
            reading.increments = [int(n) for n in item.numbers[:-1]]
            reading.pen_value, reading.pen_unit = item.numbers[-1], item.unit
            reading.refusal = True
            return
        reading.increments = [int(n) for n in item.numbers]
        return

    if any(size > 2 for size in sizes):
        reading.reasons.append("blow counts not understood")
        return
    if all(size == 1 for size in sizes):
        if items[-1].unit:
            reading.increments = [int(i.numbers[0]) for i in items[:-1]]
            reading.pen_value, reading.pen_unit = items[-1].numbers[0], items[-1].unit
            reading.refusal = True
            return
        if any(item.unit for item in items):
            reading.reasons.append("a unit inside the blow counts")
            return
        reading.increments = [int(i.numbers[0]) for i in items]
        return
    if all(size == 2 for size in sizes):
        _pairs(reading, items, note)
        return

    pair_positions = [i for i, size in enumerate(sizes) if size == 2]
    pen_item: _Item | None = None
    comma_list = any(sep in ",;" for sep in separators)
    if pair_positions[-1] == len(items) - 1 and (
        items[-1].unit or len(pair_positions) >= 2 or not comma_list
    ):
        pen_item = items[-1]
        pair_positions = pair_positions[:-1]
        items = items[:-1]
    if len(pair_positions) > 1 or any(item.unit for item in items):
        reading.reasons.append("blow counts not understood")
        return
    numbers: list[int] = []
    for position, item in enumerate(items):
        if position in pair_positions:
            reading.split = len(numbers) + 1
        numbers.extend(int(n) for n in item.numbers)
    if pen_item is not None:
        numbers.append(int(pen_item.numbers[0]))
        reading.pen_value, reading.pen_unit = pen_item.numbers[1], pen_item.unit
        reading.refusal = True
    reading.increments = numbers


def _pairs(reading: _Reading, items: list[_Item], note: _Note) -> None:
    """Count/penetration pairs ("5/15 7/15 9/15"): equal penetrations are full increments."""
    pens = [item.numbers[1] for item in items]
    full = pens[:-1] if len(set(pens)) > 1 else pens
    if len(set(full)) != 1:
        reading.reasons.append("penetrations of the increments differ")
        return
    reading.increments = [int(item.numbers[0]) for item in items]
    reading.pen_context = full
    units = {item.unit for item in items if item.unit}
    unit = units.pop() if len(units) == 1 else None
    if len(set(pens)) > 1:
        if pens[-1] > full[0]:
            reading.reasons.append("last penetration longer than the full increment")
            reading.increments = None
            return
        reading.pen_value, reading.pen_unit = pens[-1], unit or items[-1].unit
        reading.refusal = True
    elif unit:
        reading.pen_unit = unit


def _parse_blows(raw: str | None, note: _Note) -> _Reading:
    reading = _Reading()
    if raw is None or not raw.strip():
        return reading
    cfg = _config()
    text = _clean(raw)

    bracket = re.search(r"[(\[]\s*(?:N\s*[=:]?\s*)?([0-9]+)\s*[)\]]\s*$", text)
    if bracket and text[: bracket.start()].strip():
        reading.printed_n = int(bracket.group(1))
        text = text[: bracket.start()]
    elif bracket:
        reading.printed_n = int(bracket.group(1))
        reading.parsed = True
        return reading

    units = cfg.unit_pattern
    n_expr = rf"(?:(?:>=?|≥)\s*[0-9]+|[0-9]+\s*\+|[0-9]+(?:\s*/\s*[0-9]+(?:[.,][0-9]+)?\s*(?:{units})?)?)"
    labelled = re.search(
        rf"{cfg.label_pattern.pattern}\s*(?:[=:]\s*({n_expr})(?![0-9/.,])|\s({n_expr})\s*(?=$|[;(\[]))",
        text,
        re.IGNORECASE,
    )
    if labelled:
        n_reading = _parse_n(labelled.group(1) or labelled.group(2))
        reading.printed_n = n_reading.printed_n if n_reading.printed_n is not None else reading.printed_n
        if n_reading.refusal:
            reading.refusal = True
            reading.pen_value, reading.pen_unit = n_reading.pen_value, n_reading.pen_unit
        reading.reasons.extend(n_reading.reasons)
        text = text[: labelled.start()] + " " + text[labelled.end() :]
    text = cfg.label_pattern.sub(" ", text)

    if cfg.refusal_pattern.search(text):
        reading.refusal = True
        text = cfg.refusal_pattern.sub(" ", text)
    qualified = re.search(r"(?:>=?|≥)\s*([0-9]+)|([0-9]+)\s*\+(?![0-9])", text)
    if qualified:
        reading.refusal = True
        reading.reasons.append(f"printed as '{qualified.group(0).strip()}' (more blows than counted)")
        text = text[: qualified.start()] + " " + text[qualified.end() :]

    text = cfg.joiner_pattern.sub("/", text)
    text = re.sub(r"\s*/\s*", "/", text)
    text = re.sub(rf"([0-9])\s+({units})(?![A-Za-z])", r"\1\2", text, flags=re.I)
    text = re.sub(rf"([0-9]),([0-9]+)(?=(?:{units})(?![A-Za-z]))", r"\1.\2", text, flags=re.I)
    text = re.sub(r"[()\[\]{}]", " ", text).strip(" ,;-")
    if not text:
        reading.parsed = reading.refusal or reading.printed_n is not None
        return reading
    reading.parsed = True
    parsed = _items(text)
    if parsed is None or not parsed[0]:
        reading.reasons.append(f"blow counts '{raw.strip()}' not understood")
        reading.parsed = reading.refusal or reading.printed_n is not None
        return reading
    _structure(reading, parsed[0], parsed[1], note)
    return reading


# -------------------------------------------------------------------------------------------------
# Penetration and N
# -------------------------------------------------------------------------------------------------


def _unit_mm(value: float, unit: str | None) -> float | None:
    if unit is None or lookup_unit(unit) is None:
        return None
    metres = to_metres(value, unit)
    return None if metres is None else metres * 1000


def _context_unit(reading: _Reading, scheme: SptScheme | None) -> str | None:
    """The unit of unitless pair penetrations, from full increments that match a scheme length."""
    if not reading.pen_context:
        return None
    full = reading.pen_context[0]
    candidates = [scheme] if scheme is not None else list(_config().schemes)
    tol = _config().tolerance_mm
    fits = {
        unit
        for s in candidates
        for unit, factor in (("cm", 10.0), ("mm", 1.0))
        if abs(full * factor - s.increment_mm) <= tol
    }
    return fits.pop() if len(fits) == 1 else None


def _resolve_penetration(reading: _Reading, note: _Note, scheme: SptScheme | None) -> None:
    if reading.pen_value is None:
        return
    cfg = _config()
    unit = reading.pen_unit or note.unit or _context_unit(reading, scheme)
    if unit is not None:
        reading.pen_mm = _unit_mm(reading.pen_value, unit)
    else:
        as_cm, as_mm = reading.pen_value * 10, reading.pen_value
        if as_mm <= cfg.max_drive_mm < as_cm:
            reading.pen_mm = as_mm
        elif as_cm <= cfg.max_drive_mm:
            full_cm = abs(as_cm - cfg.test_drive_mm) <= cfg.tolerance_mm
            if full_cm and reading.increments is not None and len(reading.increments) == 1:
                # "23/30": 23 blows over the whole test drive (cm) or a refusal after 30 mm
                reading.refusal = False
                reading.increments = None
                reading.reasons.append(
                    f"'{reading.pen_value:g}' without a unit: a full test drive in cm or a refusal in mm"
                )
                reading.pen_value = None
                reading.parsed = False
                return
            reading.reasons.append(f"penetration '{reading.pen_value:g}' printed without a unit")
        else:
            reading.reasons.append(f"penetration '{reading.pen_value:g}' is longer than an SPT drive")
    single = reading.increments is not None and len(reading.increments) == 1 and reading.split is None
    if reading.pen_mm is not None and single and reading.pen_mm >= cfg.test_drive_mm - cfg.tolerance_mm:
        # one count over the whole test drive is the N itself ("23/30 cm")
        assert reading.increments is not None
        reading.printed_n = reading.increments[0] if reading.printed_n is None else reading.printed_n
        reading.refusal = False
        reading.increments = None
        reading.pen_value = reading.pen_mm = None


def _choose_scheme(reading: _Reading, note: _Note) -> SptScheme | None:
    if note.scheme is not None:
        return note.scheme
    if note.reason is not None:
        return None  # a printed note that names no scheme: the count of increments must not overrule it
    if reading.pen_context:
        unit = reading.pen_unit
        full = reading.pen_context[0]
        if unit is not None and (mm := _unit_mm(full, unit)) is not None:
            by_length = _match_scheme(len(reading.increments or []) or None, mm)
            if by_length is not None:
                return by_length
    if reading.increments is None or reading.refusal:
        return None
    return _scheme_by_id(_config().by_count.get(len(reading.increments)))


def _computed_n(reading: _Reading, scheme: SptScheme | None) -> tuple[int | None, str | None]:
    increments = reading.increments
    if increments is None or reading.refusal:
        return None, None
    if reading.split is not None:
        test = increments[reading.split :]
        if scheme is not None and len(test) != scheme.test_count:
            return None, f"{len(test)} test increments after the seating mark do not fit {scheme.id}"
        return sum(test), None
    if scheme is None:
        return None, f"increment scheme not stated; N cannot be computed from {len(increments)} increments"
    if len(increments) == scheme.increments:
        return sum(increments[scheme.seating :]), None
    if len(increments) == scheme.test_count:
        return sum(increments), None
    return None, f"{len(increments)} increments do not fit {scheme.id}"


def parse_spt(
    blows_raw: str | None, n_raw: str | None = None, increment_note_raw: str | None = None
) -> SptResult:
    """Increments, N and refusal from the printed SPT columns; None with a reason when undecided."""
    if any(text is not None and len(text) > _MAX_FIELD for text in (blows_raw, n_raw, increment_note_raw)):
        return SptResult(n_value=None, refusal=None, reason="SPT text too long to be one record")
    note = _parse_note(increment_note_raw)
    blows = _parse_blows(blows_raw, note)
    printed = _parse_n(n_raw)
    reasons: list[str] = []

    scheme = _choose_scheme(blows, note)
    _resolve_penetration(blows, note, scheme)
    if printed.pen_value is not None:
        _resolve_penetration(printed, note, scheme)
    scheme = scheme or _choose_scheme(blows, note)

    refusal = blows.refusal or printed.refusal
    printed_n = printed.printed_n if printed.printed_n is not None else blows.printed_n
    if printed.printed_n is not None and blows.printed_n is not None and printed.printed_n != blows.printed_n:
        reasons.append(f"N printed as {printed.printed_n} and as {blows.printed_n}")
    computed_n, computed_reason = _computed_n(blows, scheme)
    if note.reason:
        reasons.append(note.reason)
    reasons.extend(blows.reasons + printed.reasons)

    pen_mm = blows.pen_mm if blows.pen_mm is not None else printed.pen_mm
    increments = blows.increments if blows.increments is not None else printed.increments
    if refusal:
        n_value = None
    else:
        n_value = printed_n if printed_n is not None else computed_n
        if printed_n is None and computed_reason:
            reasons.append(computed_reason)
    if printed_n is not None and computed_n is not None and printed_n != computed_n and not refusal:
        reasons.append(
            f"printed N {printed_n} differs from N {computed_n} computed from the increments"
            f"{f' ({scheme.id})' if scheme else ''}"
        )
    anything = blows.parsed or printed.parsed or increments is not None or printed_n is not None
    if refusal:
        refusal_flag: bool | None = True
    elif n_value is not None or (increments is not None and computed_n is not None):
        refusal_flag = False
    else:
        refusal_flag = None
    if not anything and not reasons:
        reasons.append("no SPT values printed")
    return SptResult(
        n_value=n_value,
        refusal=refusal_flag,
        increments=increments,
        increment_mm=None if scheme is None else round(scheme.increment_mm),
        penetration_cm=None if pen_mm is None else round(pen_mm / 10, 3),
        printed_n=printed_n,
        computed_n=computed_n,
        reason="; ".join(dict.fromkeys(reasons)) or None,
    )
