"""DIN 4023:2023-02 short forms (Kurzformen), colours and hatch names, as data.

Tables 1 (soils), 2 (rock), 3 (common geological names) of the standard; the hatch name is the pattern's
label in the DIN 4023 "Schraffuren" sheet, which a renderer maps to its own SVG pattern. Secondary
constituents are the lower-case form (G, s = gravel, sandy); a weak secondary carries an apostrophe (u').
"""
from __future__ import annotations

# code -> (german name, english name, colour, kind)   kind: soil | rock | geo
CODES: dict[str, tuple[str, str, str | None, str]] = {
    # Tabelle 1: Bodenarten
    "gY": ("Großer Block", "large boulders", "rot", "soil"),
    "Y": ("Block", "boulders", "rot", "soil"),
    "X": ("Stein", "cobbles", "rot", "soil"),
    "G": ("Kies", "gravel", "gelb", "soil"),
    "gG": ("Grobkies", "coarse gravel", "gelb", "soil"),
    "mG": ("Mittelkies", "medium gravel", "gelb", "soil"),
    "fG": ("Feinkies", "fine gravel", "gelb", "soil"),
    "S": ("Sand", "sand", "orange", "soil"),
    "gS": ("Grobsand", "coarse sand", "orange", "soil"),
    "mS": ("Mittelsand", "medium sand", "orange", "soil"),
    "fS": ("Feinsand", "fine sand", "orange", "soil"),
    "U": ("Schluff", "silt", "oliv", "soil"),
    "gU": ("Grobschluff", "coarse silt", "türkis", "soil"),
    "T": ("Ton", "clay", "violett", "soil"),
    "H": ("Torf, Humus", "peat, humus", "dunkelbraun", "soil"),
    "V": ("Vulkanische Aschen", "volcanic ash", "grau", "soil"),
    "Bk": ("Braunkohle", "lignite", "dunkelbraun", "soil"),
    # Tabelle 2: Felsarten
    "Ko": ("Konglomerat", "conglomerate", "gelb", "rock"),
    "Br": ("Brekzie", "breccia", "gelb", "rock"),
    "Sst": ("Sandstein", "sandstone", "orange", "rock"),
    "Ust": ("Schluffstein", "siltstone", "oliv", "rock"),
    "Tst": ("Tonstein", "claystone / mudstone", "violett", "rock"),
    "Mst": ("Mergelstein", "marlstone", "violettblau", "rock"),
    "Kst": ("Kalkstein", "limestone", "dunkelblau", "rock"),
    "Dst": ("Dolomitstein", "dolomite", "dunkelblau", "rock"),
    "Ahst": ("Anhydrit", "anhydrite", "gelbgrün", "rock"),
    "Gyst": ("Gips", "gypsum", "gelbgrün", "rock"),
    "Sast": ("Salzgestein", "rock salt", "gelbgrün", "rock"),
    "Vst": ("Tuffstein", "tuff", "grau", "rock"),
    "Stk": ("Steinkohle", "coal", "schwarz", "rock"),
    "Q": ("Quarzit", "quartzite", "rosa", "rock"),
    "Vu": ("Vulkanite", "volcanic rock (e.g. basalt)", "rot", "rock"),
    "Pl": ("Plutonite", "plutonic rock (e.g. granite)", "rot", "rock"),
    "Mem": ("Massige Metamorphite", "massive metamorphic rock (e.g. gneiss)", "rot", "rock"),
    "Meb": ("Blättrige Metamorphite", "foliated metamorphic rock (e.g. schist)", "violett", "rock"),
    # Tabelle 3: gebräuchliche geologische Benennungen
    "Mu": ("Mutterboden", "topsoil", "gelblichbraun", "geo"),
    "L": ("Verwitterungslehm, Hanglehm", "weathered loam", "grau", "geo"),
    "Lx": ("Hangschutt", "slope debris", "grau", "geo"),
    "Lg": ("Geschiebelehm", "boulder loam (till)", "grau", "geo"),
    "Mg": ("Geschiebemergel", "boulder marl (till)", "violettblau", "geo"),
    "Lö": ("Löss", "loess", "oliv", "geo"),
    "Löl": ("Lösslehm", "loess loam", "oliv", "geo"),
    "Kl": ("Klei, Schlick", "marine clay / mud", "lila", "geo"),
    "Wk": ("Wiesenkalk", "lake marl", "hellblau", "geo"),
    "Bt": ("Bänderton", "varved clay", "violett", "geo"),
    "F": ("Mudde", "gyttja / organic mud", "lila", "geo"),
    "A": ("Anthropogene Böden", "fill / made ground", None, "geo"),
    "Krst": ("Kreidestein", "chalk", "hellblau", "geo"),
    "Ktst": ("Kalktuff", "calcareous tufa", "hellblau", "geo"),
}

# hatch (Schraffur) names on the DIN 4023 sheet where they differ from the german name
PATTERN = {"A": "Auffüllung", "H": "Torf/Humus", "Kl": "Klei, Schlick", "Y": "Blöcke", "X": "Steine", "F": "Mudde",
           "gY": "Blöcke", "V": "Vulkan. Aschen", "Vu": "Vulkanite", "Pl": "Plutonite", "Mem": "massige Metamorphite",
           "Meb": "blättrige Metamorphite", "L": "Hanglehm", "Mu": "Mutterboden"}

# secondary (adjective) form of the soil codes: "G, s, u'"
SECONDARY = {"Y": "y", "X": "x", "G": "g", "gG": "gg", "mG": "mg", "fG": "fg", "S": "s", "gS": "gs", "mS": "ms", "fS": "fs",
             "U": "u", "gU": "gu", "T": "t", "H": "h"}
SECONDARY_TO_MAIN = {v: k for k, v in SECONDARY.items()}


def info(code: str) -> dict:
    de, en, color, kind = CODES[code]
    return {"code": code, "name_de": de, "name_en": en, "color": color, "pattern": PATTERN.get(code, de), "kind": kind}


def legend() -> list[dict]:
    return [info(c) for c in CODES]
