"""Offline tests for the generic sanity rules in reconcile.py."""

from __future__ import annotations

from app.bh3.reconcile import clean_name, reconcile_log, reconcile_spt


def _L(top, bottom, desc):
    return {"top": top, "bottom": bottom, "description": desc, "partial_top": False, "partial_bottom": False}


def _merged(layers, spt=(), **kw):
    m = {
        "borehole_name": None,
        "sheet_no": None,
        "sheet_total": None,
        "depth_unit": "m",
        "visible_depth_top": None,
        "visible_depth_bottom": None,
        "layers": layers,
        "spt": list(spt),
        "core_runs": [],
        "samples": [],
        "groundwater": [],
        "terminal_note": None,
        "total_depth": None,
    }
    m.update(kw)
    return m


def test_clean_name_rejects_footers_and_contractors():
    assert clean_name("Mud Bay Drilling Co. Ltd. 118mm Hole Mud Rotary", "BH06-1") == "BH06-1"
    assert clean_name("LOG 3 - NO PIEZOMETER HEADING 05-1411-152C (BH07-1 TO BH07-4).GPJ", None) in (
        "05-1411-152",
        "BH07-1",
    )
    assert clean_name("BORING NO. T01 Damnhusaeen") == "T01"
    assert clean_name("S-3") == "S-3" and clean_name(None, "") is None


def test_remarks_and_labels_are_not_strata():
    m = _merged(
        [
            _L(0.0, 1.0, "MADE GROUND: gravel"),
            _L(1.0, 1.7, "...recovered as a non-intact matrix"),
            _L(1.7, 3.85, "CR3, 3.85-5.35, 60mins"),
            _L(3.85, 5.0, "5.01m: to 5.2m:...tuffaceous SILT"),
            _L(5.0, 6.0, "SANDSTONE, weak"),
        ]
    )
    pr = reconcile_log(m, "x.pdf", 1)
    assert [L.description[:10] for L in pr.layers] == ["MADE GROUN", "SANDSTONE,"]
    assert pr.layers[0].bottom == 5.0 and "recovered" in pr.layers[0].description
    assert any("label" in n for n in pr.notes) and any("remark" in n for n in pr.notes)


def test_elevation_scale_converted_with_ground_level():
    m = _merged([_L(64.0, 63.0, "SAND"), _L(63.0, 62.0, "SILT"), _L(62.0, 60.0, "CLAY")])
    pr = reconcile_log(m, "x.pdf", 1, header={"Surface Elevation": "70.0"})
    assert [(L.top, L.bottom) for L in pr.layers] == [(6.0, 7.0), (7.0, 8.0), (8.0, 10.0)]
    assert any("elevation scale" in i for i in pr.issues)


def test_spt_n_recomputed_from_increments_and_empty_markers_dropped():
    m = _merged(
        [_L(0, 5, "SAND")],
        spt=[
            {"depth": 1.5, "depth_to": 1.95, "n_value": "10", "blows": "10,16,20"},
            {"depth": 3.0, "depth_to": None, "n_value": None, "blows": None},
            {"depth": 4.5, "depth_to": None, "n_value": "12", "blows": "3,5,7"},
        ],
    )
    pr = reconcile_log(m, "x.pdf", 1)
    vals = {p.depth: p.value for p in pr.points if p.kind == "SPT"}
    assert vals == {1.5: 36.0, 4.5: 12.0}


def test_header_depth_sanity():
    m = _merged([_L(0, 2, "SAND")])
    pr = reconcile_log(
        m,
        "x.pdf",
        1,
        header={
            "BoreholeDepth": "102030",
            "Groundwaterlevel": "1.8",
            "BoreholeName": "BORING NO. T01 Damhusåen",
        },
    )
    assert "BoreholeDepth" not in pr.header_fields and pr.header_fields["Groundwaterlevel"] == 1.8
    assert pr.borehole_name == "T01" and pr.total_depth is None


def test_spt_sheet_digit_pairs_and_empty_rows():
    rows = [
        {
            "depth_from": round(0.3 * i, 1),
            "depth_to": round(0.3 * i + 0.3, 1),
            "blows": [8, 4],
            "n_value": None,
            "remark": None,
        }
        for i in range(5)
    ]
    rows[2]["blows"] = [5, 7]
    rows += [{"depth_from": 3.0, "depth_to": 3.3, "blows": [], "n_value": None, "remark": None}]  # empty row
    pr = reconcile_spt(
        {"borehole_name": "MP-1", "depth_unit": "m", "rows": rows, "total_depth": None}, "x.pdf", 4
    )
    vals = [p.value for p in pr.points]
    assert vals == [84.0, 84.0, 57.0, 84.0, 84.0] and any("digit pairs" in i for i in pr.issues)


def test_carry_open_strata_across_sheets():
    from app.bh3.assemble import _carry_across_sheets
    from app.bh3.models import Layer, Provenance
    from app.bh3.reconcile import PageResult

    p1 = PageResult("x.pdf", 1, "vlm", page_type="log")
    p2 = PageResult("x.pdf", 2, "vlm", page_type="log")

    def pv(pg):
        return Provenance("x.pdf", pg, method="vlm")

    p1.layers = [Layer(0.0, 8.0, "SAND, brown", pv(1)), Layer(8.0, float("nan"), "Silty CLAY, grey", pv(1))]
    p1.stats["last_partial"] = True
    p2.layers = [Layer(10.0, 13.5, "Silty CLAY, grey (continued)", pv(2)), Layer(13.5, 20.0, "GRAVEL", pv(2))]
    p2.stats["first_partial"] = True
    issues = []
    layers = _carry_across_sheets([p1, p2], issues)
    assert [(L.top, L.bottom) for L in layers] == [(0.0, 8.0), (8.0, 13.5), (13.5, 20.0)]
    assert any("continues" in i for i in issues)
    # different text: the open stratum is closed at the page break instead of merged
    p2.layers = [Layer(10.0, 13.5, "GRAVEL, coarse", pv(2))]
    p1.layers[1].bottom = float("nan")
    layers = _carry_across_sheets([p1, p2], [])
    assert [(L.top, L.bottom) for L in layers] == [(0.0, 8.0), (8.0, 10.0), (10.0, 13.5)]
