"""Stage 4: borehole metadata from the header/footer text of a log page.

Deterministic label→value extraction with a multilingual alias dictionary.
Fields that stay empty can be filled by the LLM fallback (llm.fill_header), which
receives only the header text, never the whole page.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from ..models import Page, Provenance, Word, parse_number

# field -> aliases (lower-case). Order matters only for ties; longest alias wins per match.
FIELD_ALIASES: dict[str, list[str]] = {
    "BoreholeName": ["hole no", "hole number", "borehole no", "borehole number", "bore hole no", "b.h. no", "bh no",
                     "b.h.no", "drill hole no", "hole id", "borehole id", "test pit no", "tp no", "log of bore hole",
                     "log of borehole", "borehole", "bore hole", "sondeo nº", "sondeo n°", "sondeo no", "sondeo",
                     "sondaje", "bohrung nr", "bohrung", "bohrloch", "boring no", "brønn", "punkt", "point"],
    "ProjectName": ["project name", "project title", "project", "projekt", "proyecto", "obra", "título", "titulo",
                    "bauvorhaben", "prosjekt", "job name", "feature"],
    "ProjectID": ["file / job no", "job no", "job number", "project no", "project number", "estudio nº", "estudio no",
                  "doc. no", "doc no", "report no", "auftrag", "contract no", "ref"],
    "LocationName": ["location", "site", "situación", "situacion", "lugar", "ort", "lage", "sted", "address", "area"],
    "Client": ["client", "cliente", "comitente", "peticionario", "auftraggeber", "customer", "conducted for",
               "project owner", "owner", "oppdragsgiver"],
    "StartDate": ["date started", "start date", "date commenced", "commenced", "fecha inicio", "fecha de inicio",
                  "begonnen", "beginn", "started", "drill date", "date drilled", "boring date", "excavation date",
                  "date of boring", "date"],
    "EndDate": ["date completed", "end date", "completion date", "fecha final", "fecha fin", "finished", "completed",
                "beendet", "ende"],
    "Surface Elevation": ["surface elevation", "ground elevation", "ground level", "collar elevation", "elevation",
                          "g.l.", "reduced level", "r.l.", "boca sondeo", "cota boca", "cota de boca", "cota terreno",
                          "ansatzhöhe", "gok", "höhe", "terrengkote", "z"],
    "X-Coordinate": ["x-coord", "x coord", "x-coordinate", "easting", "east", "e", "x", "rechtswert", "øv-koordinat",
                     "ov-koordinat"],
    "Y-Coordinate": ["y-coord", "y coord", "y-coordinate", "northing", "north", "n", "y", "hochwert", "ns-koordinat"],
    "CoordinateSystem": ["coordinate system", "coord. system", "datum", "grid", "kartdatum", "sistema de coordenadas",
                         "koordinatensystem", "utm zone", "utm sone", "projection"],
    "BoreholeDepth": ["total depth", "final depth", "depth of hole", "hole depth", "borehole depth", "depth drilled",
                      "profundidad total", "profundidad", "bohrtiefe", "endteufe", "total dybde", "depth ( m )",
                      "depth (m)", "depth"],
    "Groundwaterlevel": ["g.w. depth", "gw depth", "groundwater depth", "groundwater level", "ground water level",
                         "water level", "water table", "water depth", "nivel freático", "nivel freatico",
                         "grundwasser", "grunnvann", "gwl", "g.w.l", "water"],
    # extras kept in Notes
    "Contractor": ["contractor", "drilling contractor", "contratista", "bohrfirma", "borefirma", "drilled by",
                   "driller", "empresa"],
    "LoggedBy": ["logged by", "profiled by", "geologist", "logged", "bearbeiter", "operador"],
    "Method": ["drilling method", "method", "método", "metodo", "bohrverfahren", "rig type", "rig", "machine",
               "máquina", "maquina", "equipment"],
    "Inclination": ["inclination", "inclinación", "angle from horizontal", "angle", "neigung", "dip"],
    "Casing": ["casing depth", "casing"],
    "Sheet": ["sheet", "hoja", "page", "blatt", "side"],
}
EXTRA_FIELDS = {"Client", "Contractor", "LoggedBy", "Method", "Inclination", "Casing", "Sheet"}
NUMERIC_FIELDS = {"Surface Elevation", "X-Coordinate", "Y-Coordinate", "BoreholeDepth", "Groundwaterlevel"}

# short aliases (x, y, e, n, z, date, water, depth) only count when followed by ':' or '='
_SHORT = {"x", "y", "e", "n", "z", "ref", "area", "point", "date", "water", "depth", "feature", "owner", "ende",
          "rig", "angle", "dip", "page", "side", "sheet", "gok", "höhe"}


def _build_regex() -> re.Pattern:
    items: list[tuple[str, str]] = []
    for f, aliases in FIELD_ALIASES.items():
        for a in aliases:
            items.append((f, a))
    items.sort(key=lambda t: -len(t[1]))
    parts = []
    for f, a in items:
        esc = re.escape(a).replace(r"\ ", r"\s+")
        if a in _SHORT:
            parts.append(rf"(?P<{_tag(f, a)}>\b{esc}\s*[:=])")
        else:
            parts.append(rf"(?P<{_tag(f, a)}>(?<![A-Za-z]){esc}\.?\s*(?:\(\s*m\s*\)\s*)?[:=]?)")
    return re.compile("|".join(parts), re.I)


_TAGS: dict[str, str] = {}


def _tag(f: str, a: str) -> str:
    t = "g" + str(len(_TAGS))
    _TAGS[t] = f
    return t


LABEL_RE = _build_regex()

DATE_RE = re.compile(r"(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})")


def norm_date(s: str) -> Optional[str]:
    m = DATE_RE.search(s)
    if not m:
        return None
    d, mth, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000 if y < 50 else 1900
    if mth > 12 and d <= 12:
        d, mth = mth, d
    if not (1 <= mth <= 12 and 1 <= d <= 31):
        return None
    return f"{y:04d}-{mth:02d}-{d:02d}"


def _clean_value(v: str) -> str:
    v = v.strip(" :=|,;")
    v = re.sub(r"^[-–]\s+", "", v)      # a dash used as separator, not a sign
    v = v.rstrip(" -–")
    v = re.sub(r"\s{2,}", " ", v)
    return v


@dataclass
class HeaderResult:
    fields: dict[str, Any] = field(default_factory=dict)
    prov: dict[str, Provenance] = field(default_factory=dict)
    extras: dict[str, str] = field(default_factory=dict)
    text: str = ""          # header text (for the LLM fallback)
    raw: dict[str, str] = field(default_factory=dict)   # field -> the printed text the value was parsed from


def header_lines(page: Page, words: list[Word]) -> list[list[Word]]:
    hp = Page(page.doc_id, page.source_file, page.page_no, page.width, page.height, words=words)
    return [ln for ln in hp.lines_of_text(ytol=3.0) if sum(len(w.text) for w in ln) >= 2]


def extract_header(page: Page, words: list[Word]) -> HeaderResult:
    res = HeaderResult()
    lines = header_lines(page, words)
    res.text = "\n".join(" ".join(w.text for w in ln) for ln in lines)
    found: dict[str, list[tuple[str, float, Word]]] = {}

    GW_CTX = re.compile(r"nivel\s+fre[aá]tico|ground\s*water|groundwater|water\s+level|grundwasser|grunnvann", re.I)
    for li, ln in enumerate(lines):
        text = " ".join(w.text for w in ln)
        # map char offsets -> words for provenance
        offsets = []
        pos = 0
        for w in ln:
            offsets.append((pos, pos + len(w.text), w))
            pos += len(w.text) + 1
        matches = list(LABEL_RE.finditer(text))
        if not matches:
            continue
        # a line of bare column headers (no ':' or '=' anywhere) is not a key/value line
        if len(matches) >= 3 and not any(ch in text for ch in ":="):
            continue
        for i, m in enumerate(matches):
            fld = _TAGS[m.lastgroup]
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            raw = _clean_value(text[start:end])
            if not raw:
                continue
            # a label immediately followed by another label means the value was empty
            w0 = next((w for a, b, w in offsets if a <= m.start() < b), ln[0])
            conf = min((w.conf for a, b, w in offsets if start <= a < end), default=w0.conf)
            # generic 'depth' under a 'groundwater' column header on the previous line → groundwater level
            if fld == "BoreholeDepth" and li > 0 and m.group(0).strip(" :=").lower() in ("depth", "profundidad", "prof."):
                above = " ".join(w.text for w in lines[li - 1] if w.x1 > w0.x0 - 40 and w.x0 < w0.x1 + 80)
                if GW_CTX.search(above):
                    fld = "Groundwaterlevel"
            found.setdefault(fld, []).append((raw, conf, w0))

    for fld, cands in list(found.items()):
        # numeric fields: first candidate that actually carries a number; others: first non-empty
        chosen = None
        if fld in NUMERIC_FIELDS:
            chosen = next((c for c in cands if _first_number(c[0][:20]) is not None), None)
            if chosen is None and fld == "Groundwaterlevel":
                chosen = next((c for c in cands if re.search(r"none|not|dry|nicht|no se", c[0], re.I)), None)
        else:
            chosen = next((c for c in cands if c[0]), None)
        if chosen is None:
            continue
        raw, conf, w0 = chosen
        val: Any = raw
        if fld in NUMERIC_FIELDS:
            val = _first_number(raw[:20])
            if val is None:
                val = "not encountered"
            elif fld == "BoreholeDepth" and val <= 0.05:
                continue
            # feet → metres
            if re.search(r"\bft\b|feet|'", raw) and isinstance(val, float):
                val = round(val * 0.3048, 3)
        elif fld in ("StartDate", "EndDate"):
            val = norm_date(raw) or raw
        elif fld == "BoreholeName":
            val = re.sub(r"\s+", " ", raw)[:60]
            # cut trailing words that are obviously another field ("BH 1 Sheet 1 of 1")
            val = re.split(r"\b(sheet|hoja|page|date|project|location|situaci)", val, flags=re.I)[0].strip(" -:")
            # keep only the identifier: 'BH_AB01', 'S-1', 'NBH-58', 'TP 12', '7 - Fernández…' → '7' (+ rest → location)
            m_id = re.match(r"^((?:[A-Za-z]{1,6}[-_ .]?)?\d{1,4}[A-Za-z]?(?:[-_/]\d{1,3})?)\b[\s:–-]*(.*)$", val)
            if m_id:
                val, rest = m_id.group(1).strip(), m_id.group(2).strip()
                if rest and re.search(r"[A-Za-z\u00C0-\u024F]{4,}", rest) and "LocationName" not in found \
                        and "LocationName" not in res.fields:
                    res.fields["LocationName"] = rest
                    res.prov["LocationName"] = Provenance(page.source_file, page.page_no, w0.y0, w0.y1, w0.x0, w0.x1, "header-alias", conf)
            elif not re.search(r"\d", val) or len(val) > 20:
                continue          # 'Borehole cased to 6.00 metres' is not a name
        if fld in EXTRA_FIELDS:
            res.extras[fld] = str(val)
        else:
            res.fields[fld] = val
            res.raw[fld] = str(raw).strip()
            res.prov[fld] = Provenance(page.source_file, page.page_no, w0.y0, w0.y1, w0.x0, w0.x1, "header-alias", conf)

    # coordinate system from parentheses after a coordinate pair: 'E: 314957.000, N: 5819600.000 (55H MGA94)'
    if "CoordinateSystem" not in res.fields:
        m = re.search(r"\(([^()]*(?:MGA|UTM|WGS|GDA|ETRS|NAD|GK|Gauss|Lambert|zone|sone)[^()]*)\)", res.text, re.I)
        if m:
            res.fields["CoordinateSystem"] = m.group(1).strip()
            res.prov["CoordinateSystem"] = Provenance(page.source_file, page.page_no, method="header-alias", confidence=0.7)
        else:
            m = re.search(r"\b(WGS\s?84|UTM\s*(?:zone)?\s*\d{1,2}[A-Z]?|MGA\s?\d{2}|ETRS\s?89|GDA\s?\d{2,4}|AHD|NAP|DHHN|NN)\b", res.text)
            if m:
                res.fields["CoordinateSystem"] = m.group(1)
                res.prov["CoordinateSystem"] = Provenance(page.source_file, page.page_no, method="header-alias", confidence=0.5)

    # free-text groundwater statement: 'Groundwater was observed to stand at 1.85m'
    if "Groundwaterlevel" not in res.fields:
        m = re.search(r"(?:groundwater|water)[^.\n]{0,40}?(\d{1,3}[.,]\d{1,2})\s*m\b", res.text, re.I)
        if m:
            res.fields["Groundwaterlevel"] = float(m.group(1).replace(",", "."))
            res.prov["Groundwaterlevel"] = Provenance(page.source_file, page.page_no, method="header-regex", confidence=0.6)

    # 'terminated at 12.00 m' / 'end of borehole at 10.36m' / 'fin de sondeo a 8,00 metros'
    m = re.search(r"(?:terminated|end of (?:bore|hole|boring|borehole|excavation)|fin de(?:l)? sondeo|bohrende|endteufe)"
                  r"[^0-9\n=]{0,30}(\d{1,3}[.,]\d{1,2})\s*m", res.text, re.I)
    if m:
        res.fields["BoreholeDepth"] = float(m.group(1).replace(",", "."))
        res.prov["BoreholeDepth"] = Provenance(page.source_file, page.page_no, method="header-regex", confidence=0.8)

    return res


def _first_number(s: str) -> Optional[float]:
    """Tolerate '+17,42 m', '35.700 (AHD)', '-32.930147', '5819600.000', '1 234,5', '1.234,56'."""
    m = re.search(r"[+-]?\d(?:[\d .,]*\d)?", s)
    if not m:
        return None
    t = m.group(0).replace(" ", "")
    if "." in t and "," in t:
        # the later separator is the decimal one
        if t.rindex(".") > t.rindex(","):
            t = t.replace(",", "")
        else:
            t = t.replace(".", "").replace(",", ".")
    elif t.count(".") > 1:
        t = t.replace(".", "")
    elif t.count(",") > 1:
        t = t.replace(",", "")
    else:
        t = t.replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def _coerce(field: str, v):
    """Header value as the right type for its field (numbers, dates)."""
    if field in NUMERIC_FIELDS:
        n = _first_number(str(v))
        return n if n is not None else v
    if field in ("StartDate", "EndDate"):
        return norm_date(str(v)) or v
    return v
