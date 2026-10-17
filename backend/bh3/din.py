"""Words, codes or legend phrases -> one petrography code system (DIN 4023 short forms).

Per layer, in this order of evidence (the first that applies wins, `din_source` says which):
  marker / ditto   a per-document legend entry says the row is a marker ("Ground Surface", "Cota 856.93") or
                   repeats the previous layer ("DITTO")                                         -> none / ditto
  printed          a DIN short form printed in the description ("G, s, u'", "Kst")             -> printed
  lithology        the normaliser's lithology enum gives the main constituent; secondary constituents come
                   from adjectives in the raw text in any of eight languages                    -> lithology
  legend           a per-document phrase table (legends.json) names the main constituent        -> legend
  words            a constituent noun found in the raw text (uppercase word first)              -> words
  uscs             the USCS group symbol                                                        -> uscs
  symbol           the hatch described by the vision model (`symbol` field, when present)       -> symbol
No evidence -> din_code None and needs_review. Deterministic, offline, no model.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from .din_codes import CODES, SECONDARY, SECONDARY_TO_MAIN, info

LEGENDS_FILE = Path(__file__).with_name("legends.json")

LITHOLOGY_MAIN = {
    "Sand": "S", "Silt": "U", "Clay": "T", "Gravel": "G", "Cobbles": "X", "Boulders": "Y", "Peat": "H", "Organic soil": "H",
    "Fill": "A", "Topsoil": "Mu", "Limestone": "Kst", "Calcarenite": "Kst", "Caliche": "Kst", "Sandstone": "Sst",
    "Siltstone": "Ust", "Claystone": "Tst", "Mudstone": "Tst", "Shale": "Tst", "Marl": "Mst", "Dolomite": "Dst",
    "Chalk": "Krst", "Conglomerate": "Ko", "Breccia": "Br", "Granite": "Pl", "Basalt": "Vu", "Gneiss": "Mem", "Schist": "Meb",
    "Other rock": None, "No recovery": None, "Unknown": None,
}
USCS_MAIN = {"SM": ("S", ["u"]), "SC": ("S", ["t"]), "SP": ("S", []), "SW": ("S", []), "SP-SM": ("S", ["u'"]), "SW-SM": ("S", ["u'"]),
             "SC-SM": ("S", ["t", "u"]), "GP": ("G", []), "GW": ("G", []), "GM": ("G", ["u"]), "GC": ("G", ["t"]), "GP-GM": ("G", ["u'"]),
             "GW-GM": ("G", ["u'"]), "ML": ("U", []), "MH": ("U", ["t"]), "CL": ("T", ["u"]), "CH": ("T", []), "CL-ML": ("U", ["t"]),
             "OL": ("H", []), "OH": ("H", []), "PT": ("H", []), "FILL": ("A", [])}

# secondary constituents: adjective stems and nouns per code, eight languages (en, de, da, no, es, pt, ca, fr)
_SEC: dict[str, dict[str, list[str]]] = {
    "s": {"adj": ["sandy", "sandig", "sandet", "sandete", "sandholdig", "arenos", "arenós", "sableu", "sableux", "sablonneu"],
          "noun": ["sand", "sands", "arena", "areia", "sorra", "sorres", "sable"]},
    "u": {"adj": ["silty", "schluffig", "siltet", "siltig", "siltholdig", "limos", "siltos", "llimós", "llimos", "limoneu", "limoneux"],
          "noun": ["silt", "silts", "schluff", "limo", "silte", "llim", "llims", "limon"]},
    "t": {"adj": ["clayey", "tonig", "leret", "lerholdig", "leirig", "leiret", "arcillos", "argilos", "argilós", "argileu", "argileux"],
          "noun": ["clay", "clays", "ton", "ler", "leire", "arcilla", "argila", "argiles", "argile", "lehm"]},
    "g": {"adj": ["gravelly", "gravely", "kiesig", "gruset", "grusholdig", "gravos", "pedregulhos", "graveleu", "graveleux", "cascalhent"],
          "noun": ["gravel", "gravels", "kies", "grus", "grava", "gravas", "graves", "pedregulho", "cascalho", "gravier", "graviers"]},
    "h": {"adj": ["peaty", "organic", "torfig", "humos", "humusholdig", "organisk", "orgánic", "orgànic", "organique", "tørv"],
          "noun": ["peat", "torf", "turba", "turfa", "humus", "tourbe"]},
    "x": {"adj": ["cobbly", "steinig", "stenet", "steinet"], "noun": ["cobbles", "cobble", "steine", "sten", "stein", "piedras", "pedras"]},
    "y": {"adj": [], "noun": ["boulders", "boulder", "blöcke", "blokke", "bloques", "matacões", "blocs"]},
}
# main constituent nouns (when no lithology enum): code -> nouns
_MAIN_NOUNS: dict[str, list[str]] = {
    "S": ["sand", "sands", "arena", "arenas", "areia", "sorra", "sorres", "sable"],
    "U": ["silt", "silts", "schluff", "limo", "limos", "silte", "llim", "llims", "limon", "loam"],
    "T": ["clay", "clays", "ton", "ler", "leire", "arcilla", "arcillas", "argila", "argiles", "argile"],
    "G": ["gravel", "gravels", "kies", "grus", "grava", "gravas", "graves", "pedregulho", "cascalho", "gravier"],
    "X": ["cobbles", "steine", "sten", "piedras"], "Y": ["boulders", "blöcke", "blokke", "bloques"],
    "H": ["peat", "torf", "turba", "turfa", "tørv"], "Mu": ["topsoil", "mutterboden", "muld", "tierra vegetal", "terreno vegetal", "solo vegetal"],
    "A": ["fill", "made ground", "auffüllung", "fyld", "relleno", "aterro", "rebliment", "remblai"],
    "Kst": ["limestone", "kalkstein", "kalk", "kalksten", "caliza", "calizas", "calcário", "calcario", "calcarenite", "calcaire", "flint"],
    "Sst": ["sandstone", "sandstein", "sandsten", "arenisca", "arenito", "grès"], "Ust": ["siltstone", "schluffstein", "limolita", "siltito"],
    "Tst": ["claystone", "mudstone", "shale", "tonstein", "lersten", "arcillita", "argilito", "lutita"], "Mst": ["marl", "mergel", "marga"],
    "Dst": ["dolomite", "dolomit"], "Krst": ["chalk", "kreide", "kridt"], "Ko": ["conglomerate", "konglomerat", "conglomerado"],
    "Br": ["breccia", "brekzie", "brecha"], "Pl": ["granite", "granit", "granito", "diorite", "gabbro"],
    "Vu": ["basalt", "basalto", "andesite", "rhyolite", "tuff", "lava"], "Mem": ["gneiss", "gneis"], "Meb": ["schist", "schiefer", "phyllite", "slate", "esquisto"],
    "F": ["gyttja", "mudde"], "Kl": ["mud", "klei", "schlick"], "Lg": ["till", "moræneler", "moraeneler"],
}
_WEAK = r"(?:slightly|weakly|trace(?:s)?\s+of|trace|a\s+little|little|some|occasional|few|schwach|leicht|svagt|svakt|lidt|poco|pocos|ligeramente|pouco|poucos|lleugerament|légèrement|un\s+peu)"
_WITH = r"(?:with|and|som|med|mit|con|com|amb|avec|of)"

_PRINTED_MAIN = r"(?:[fmg]?[GSUT]|gY|[XYH]|Mu|Kst|Sst|Ust|Tst|Mst|Dst|Krst|Ko|Br|Pl|Vu|Mem|Meb|Kl|Lg|Mg|L[öo]l?|A)"
_PRINTED_SEC = r"(?:[fmg]?[gsut]|[xyh])'?"
PRINTED_RE = re.compile(rf"(?<![A-Za-z0-9/])({_PRINTED_MAIN}(?:\s*,\s*{_PRINTED_SEC}){{1,4}})(?![A-Za-z0-9])")
PRINTED_ALONE_RE = re.compile(rf"^\s*({_PRINTED_MAIN}(?:\s*,\s*{_PRINTED_SEC}){{0,4}})\s*[.;]?\s*$")


@lru_cache(maxsize=1)
def legends() -> dict:
    if LEGENDS_FILE.exists():
        return json.loads(LEGENDS_FILE.read_text(encoding="utf-8"))
    return {}


def _norm(s: Any) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def _word(stem: str) -> re.Pattern:
    return re.compile(rf"(?<![a-zà-ÿ]){re.escape(stem)}[a-zà-ÿ]*", re.I)


@lru_cache(maxsize=None)
def _sec_patterns(code: str) -> tuple[list[re.Pattern], list[re.Pattern]]:
    d = _SEC[code]
    return [_word(a) for a in d["adj"]], [re.compile(rf"(?<![a-zà-ÿ])(?:{_WEAK}\s+(?:{_WITH}\s+)?|{_WITH}\s+(?:{_WEAK}\s+)?){re.escape(n)}(?![a-zà-ÿ])", re.I) for n in d["noun"]]


def secondaries(text: str, main: Optional[str]) -> list[str]:
    """Secondary constituents in text order: 'Silty fine SAND, with some gravel' -> ['u', "g'"]."""
    low = _norm(text)
    found: dict[str, tuple[int, bool]] = {}
    for code in _SEC:
        if main and SECONDARY.get(main, "").lstrip("fmg") == code:
            continue
        adjs, nouns = _sec_patterns(code)
        for p in adjs:
            m = p.search(low)
            if m:
                weak = bool(re.search(rf"{_WEAK}\s+$", low[:m.start()]))
                if code not in found or m.start() < found[code][0]:
                    found[code] = (m.start(), weak)
        for p in nouns:
            m = p.search(low)
            if m and code not in found:
                found[code] = (m.start(), True)
    return [c + ("'" if w else "") for c, (pos, w) in sorted(found.items(), key=lambda kv: kv[1][0])]


def main_from_words(text: str) -> Optional[str]:
    """The main constituent noun: an UPPERCASE word first (logs capitalise it), else the first noun."""
    raw = str(text or "")
    upper = [w.strip(".,;:()") for w in re.findall(r"\b[A-ZÀ-Ý]{3,}\b", raw)]
    for w in upper:
        for code, nouns in _MAIN_NOUNS.items():
            if w.lower() in nouns:
                return code
    low = _norm(raw)
    best: tuple[int, str] | None = None
    for code, nouns in _MAIN_NOUNS.items():
        for n in nouns:
            m = re.search(rf"(?<![a-zà-ÿ]){re.escape(n)}(?![a-zà-ÿ])", low)
            if m and (best is None or m.start() < best[0]):
                best = (m.start(), code)
    return best[1] if best else None


def printed_code(text: str) -> Optional[str]:
    s = str(text or "")
    m = PRINTED_ALONE_RE.match(s) if len(s.strip()) <= 16 else None
    if not m:
        m = PRINTED_RE.search(s)
    if not m:
        return None
    parts = [p.strip() for p in m.group(1).split(",")]
    if parts[0] not in CODES:
        return None
    return ", ".join(parts)


def _legend_lookup(text: str, document: str) -> Optional[str]:
    low = _norm(text)
    tables = [legends().get(document) or {}, legends().get("_default") or {}]
    for table in tables:
        for phrase, code in sorted(table.items(), key=lambda kv: -len(kv[0])):
            p = phrase.lower()
            if (p == low) or (phrase.startswith("^") and re.match(phrase, str(text or ""), re.I)) or \
                    (not phrase.startswith("^") and re.search(rf"(?<![a-zà-ÿ]){re.escape(p)}(?![a-zà-ÿ])", low)):
                return code
    return None


def _symbol_code(symbol: Optional[str], legend: Optional[dict]) -> Optional[str]:
    if not symbol:
        return None
    s = _norm(symbol)
    if legend:
        for k, v in legend.items():
            if _norm(k) == s or (_norm(k) in s or s in _norm(k)) and len(_norm(k)) >= 4:
                code = v if v in CODES else main_from_words(v)
                if code:
                    return code
    for stem, code in (("dot", "S"), ("stipple", "S"), ("dash", "U"), ("horizontal line", "T"), ("horizontal", "T"), ("circle", "G"),
                       ("brick", "Kst"), ("cross", "Pl"), ("blank", None), ("empty", None)):
        if stem in s:
            return code
    return None


def _compose(main: Optional[str], secs: list[str]) -> Optional[str]:
    if not main:
        return None
    if CODES[main][3] == "rock":
        secs = []                      # rock codes stand alone (composite rock symbols are not drawn)
    return main if not secs else main + ", " + ", ".join(secs)


def classify_layer(layer: dict, document: str = "", prev: Optional[dict] = None, legend: Optional[dict] = None) -> dict:
    desc = layer.get("description") or ""
    litho = layer.get("lithology")
    out: dict[str, Any] = {"din_code": None, "din_main": None, "din_secondary": [], "din_color": None, "din_pattern": None,
                           "din_source": "none", "needs_review": False}
    doc = Path(document).name if document else ""

    def finish(main: Optional[str], secs: list[str], source: str) -> dict:
        code = _compose(main, secs)
        if code is None:
            return out
        i = info(main)
        out.update(din_code=code, din_main=main, din_secondary=secs, din_color=i["color"], din_pattern=i["pattern"], din_source=source)
        return out

    # 1. per-document row semantics: markers and "ditto"
    leg = _legend_lookup(desc, doc)
    if leg == "marker":
        return out
    if leg == "ditto":
        if prev and prev.get("din_code"):
            out.update({k: prev.get(k) for k in ("din_code", "din_main", "din_secondary", "din_color", "din_pattern")})
            out["din_source"] = "ditto"
        else:
            out["needs_review"] = True
        return out
    # 2. a printed DIN short form
    pc = printed_code(desc)
    if pc:
        parts = [p.strip() for p in pc.split(",")]
        return finish(parts[0], parts[1:], "printed")
    # 3. lithology enum + adjectives
    main = LITHOLOGY_MAIN.get(litho) if litho else None
    if main:
        return finish(main, secondaries(desc, main), "lithology")
    # 4. per-document legend phrase
    if leg and leg in CODES:
        return finish(leg, secondaries(desc, leg), "legend")
    # 5. constituent nouns in the text
    main = main_from_words(desc)
    if main:
        return finish(main, secondaries(desc, main), "words")
    # 6. USCS
    u = USCS_MAIN.get(str(layer.get("soil_unit") or "").upper())
    if u:
        return finish(u[0], list(u[1]) or secondaries(desc, u[0]), "uscs")
    # 7. the hatch symbol as described by the vision model
    sc = _symbol_code(layer.get("symbol"), legend)
    if sc:
        return finish(sc, [], "symbol")
    out["needs_review"] = bool(desc.strip()) or bool(layer.get("symbol"))
    return out


def classify_boreholes(boreholes: list[dict]) -> dict:
    """In place: din_* + needs_review on every layer dict. Returns coverage per document and per source."""
    docs: dict[str, dict] = {}
    total = {"layers": 0, "coded": 0, "by_source": {}}
    for b in boreholes:
        doc = Path(b.get("source_file") or "").name
        d = docs.setdefault(doc, {"layers": 0, "coded": 0, "by_source": {}})
        prev: Optional[dict] = None
        legend = (b.get("metadata") or {}).get("_legend")
        for L in b.get("layers") or []:
            r = classify_layer(L, doc, prev, legend)
            L.update(r)
            prev = L
            for t in (d, total):
                t["layers"] += 1
                t["coded"] += 1 if r["din_code"] else 0
                t["by_source"][r["din_source"]] = t["by_source"].get(r["din_source"], 0) + 1
    total["documents"] = docs
    return total
