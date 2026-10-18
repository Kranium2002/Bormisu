"""DIN 4023 petrography mapping (offline)."""
from app.bh3.din import classify_boreholes, classify_layer, printed_code, secondaries


def c(desc, litho=None, uscs=None, doc="", prev=None):
    return classify_layer({"description": desc, "lithology": litho, "soil_unit": uscs}, doc, prev)


def test_printed_code_wins():
    r = c("S, u  grey, medium dense", "Clay")
    assert r["din_code"] == "S, u" and r["din_source"] == "printed"
    assert printed_code("G, s, u'") == "G, s, u'" and printed_code("Kst") == "Kst" and printed_code("USCS: SM") is None


def test_english_adjectives():
    r = c("Silty fine SAND, grey, with some gravel", "Sand")
    assert r["din_code"] == "fS, u, g'" and r["din_source"] == "lithology" and r["din_color"] == "orange" and r["din_pattern"] == "Feinsand"
    assert secondaries("Sandy CLAY, slightly gravelly", "T") == ["s", "g'"]


def test_german_danish_spanish():
    assert c("Kies, sandig, schwach schluffig", "Gravel")["din_code"] == "G, s, u'"
    r = c("Arcilla, castaño oscuro", None, doc="SAM01.pdf")
    assert r["din_code"] == "T" and r["din_source"] in ("legend", "words") and r["din_color"] == "violett"
    r = c("SAND, leret, gruset", None, doc="EUR01.pdf")
    assert r["din_code"] == "S, t, g" and r["din_source"] in ("legend", "words")
    assert c("0 - 55 cm: KALK og KALKSTEN, sandet", None, doc="EUR01.pdf")["din_code"] == "Kst"


def test_uscs_fallback_and_none():
    r = c("brownish layer", "Unknown", "SM")
    assert r["din_code"] == "S, u" and r["din_source"] == "uscs"
    r = c("something unreadable", "Unknown", "UNKNOWN")
    assert r["din_code"] is None and r["needs_review"] is True and r["din_source"] == "none"
    r = c("", None)
    assert r["din_code"] is None and r["needs_review"] is False


def test_rock_and_topsoil():
    assert c("Highly weathered SANDSTONE, sandy", "Sandstone")["din_code"] == "Sst"
    assert c("Beige LIMESTONE, fractured", "Limestone")["din_code"] == "Kst"
    assert c("TERRENO VEGETAL.", "Topsoil")["din_code"] == "Mu"
    assert c("Fill: concrete rubble", "Fill")["din_code"] == "A"


def test_ditto_and_markers():
    prev = c("Firm. Reddish Brown SILT with some sand", "Silt", doc="ToughOne2.pdf")
    assert prev["din_code"] == "U, s'"
    r = c("Hard. DITTO", "Unknown", doc="ToughOne2.pdf", prev=prev)
    assert r["din_code"] == "U, s'" and r["din_source"] == "ditto"
    r = c("Ground Surface", None, doc="NAM02.pdf")
    assert r["din_code"] is None and r["din_source"] == "none" and r["needs_review"] is False
    assert c("Cota 856.93", "Unknown", doc="SAM02.docx")["din_source"] == "none"


def test_classify_boreholes_coverage():
    bhs = [{"source_file": "x/AUS01.pdf", "layers": [{"description": "Silty CLAY", "lithology": "Clay"}, {"description": "DITTO", "lithology": None}]}]
    rep = classify_boreholes(bhs)
    assert rep["layers"] == 2 and rep["coded"] == 2 and rep["by_source"] == {"lithology": 1, "ditto": 1}
    assert bhs[0]["layers"][1]["din_code"] == "T, u"


def test_fill_priority_fractions_and_mud():
    # ported from main's normalisation: made ground wins over the soil describing it, grain-size words narrow S / G
    assert c("FYLD: SAND, fint, siltet, gruset", "Sand", doc="EUR01.pdf")["din_code"] == "A, s, u, g"
    assert c("Fill: clayey GRAVEL with brick", "Gravel")["din_code"] == "A, g, t"
    assert c("SAND, fint, sort., siltet", "Sand")["din_code"] == "fS, u"
    assert c("Sand, fine, brownish-grey, saturated", "Sand")["din_code"] == "fS"
    assert c("SAND, coarse, poorly sorted, slightly gravelly", "Sand")["din_code"] == "gS, g'"
    assert c("fine to coarse SAND, grey", "Sand")["din_code"] == "S"
    assert c("Medium GRAVEL, sandy", "Gravel")["din_code"] == "mG, s"
    assert c("GYTTJA, silty, very sandy, plant remnants", "Peat")["din_code"] == "F, u, s"
    assert c("S, u  printed notation stays", "Sand")["din_code"] == "S, u"
