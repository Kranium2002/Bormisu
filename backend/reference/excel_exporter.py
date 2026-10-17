import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from pathlib import Path
from typing import Dict, Any, List, Optional

def export_borehole_to_herrenknecht_excel(data: Dict[str, Any], output_path: str or Path) -> Path:
    """
    Export a standardized borehole record into Herrenknecht's official BoreholeDataFormat.xlsx layout.
    Accepts standardized JSON matching the universal schema.
    """
    # If a full document JSON was passed with multiple boreholes, take the first or active borehole
    if "boreholes" in data and isinstance(data["boreholes"], list) and len(data["boreholes"]) > 0:
        borehole = data["boreholes"][0]
        doc_info = data.get("document_info", {})
    else:
        borehole = data
        doc_info = {}

    meta = borehole.get("metadata", {})
    stratigraphy = borehole.get("stratigraphy", borehole.get("stratigraphy_layers", []))
    geotech = borehole.get("geotechnical_tests", borehole.get("test_results", {}))
    tbm = borehole.get("tbm_engineering_assessment", {})

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "BoreholeData"

    # Styling definitions matching Herrenknecht & DIN standards
    header_fill = PatternFill(start_color="FF6B00", end_color="FF6B00", fill_type="solid") # Herrenknecht Orange
    section_fill = PatternFill(start_color="1E293B", end_color="1E293B", fill_type="solid") # Dark Slate
    sub_fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
    
    font_title = Font(name="Segoe UI", size=13, bold=True, color="FFFFFF")
    font_section = Font(name="Segoe UI", size=10, bold=True, color="FFFFFF")
    font_bold = Font(name="Segoe UI", size=9, bold=True)
    font_regular = Font(name="Segoe UI", size=9)
    
    thin_border = Border(
        left=Side(style='thin', color='CBD5E1'),
        right=Side(style='thin', color='CBD5E1'),
        top=Side(style='thin', color='CBD5E1'),
        bottom=Side(style='thin', color='CBD5E1')
    )

    # Title Block
    ws.merge_cells("A1:G1")
    borehole_title = meta.get("borehole_id") or meta.get("borehole_name") or "Borehole Record"
    ws["A1"] = f"Herrenknecht AG — Standardized Borehole Record ({borehole_title})"
    ws["A1"].font = font_title
    ws["A1"].fill = header_fill
    ws["A1"].alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[1].height = 28

    # Header row
    headers = ["Field Name", "Value", "Unit", "Format", "Standard / Notes", "TBM Relevance"]
    ws.append([]) # Row 2
    ws.append(headers) # Row 3
    for col_idx in range(1, len(headers) + 1):
        cell = ws.cell(row=3, column=col_idx)
        cell.font = font_bold
        cell.fill = sub_fill
        cell.border = thin_border
    ws.row_dimensions[3].height = 20

    # Section 1: Metadata
    ws.append(["1. METADATA", "", "", "", "DIN 4023", "Site Logistics & Alignment"])
    sec_row = ws.max_row
    ws.merge_cells(f"A{sec_row}:F{sec_row}")
    ws[f"A{sec_row}"].fill = section_fill
    ws[f"A{sec_row}"].font = font_section

    coords = meta.get("coordinates", {}) if isinstance(meta.get("coordinates"), dict) else {}
    lat_or_x = coords.get("latitude") if coords.get("latitude") is not None else coords.get("local_x")
    lon_or_y = coords.get("longitude") if coords.get("longitude") is not None else coords.get("local_y")
    coord_sys = coords.get("coordinate_system") or "WGS84"

    meta_rows = [
        ("BoreholeID", meta.get("borehole_id") or "-", "-", "alphanumeric", "Unique borehole identifier", "TBM Alignment Chainage"),
        ("BoreholeName", meta.get("borehole_name") or "-", "-", "alphanumeric", "Name on drilling log", "Identification"),
        ("LocationName", meta.get("location_name") or "-", "-", "alphanumeric", "Site locality", "Geographic Context"),
        ("Country", meta.get("country") or "-", "-", "alphanumeric", "Country of origin", "Regional geology"),
        ("ProjectName", meta.get("project_name") or "-", "-", "alphanumeric", "Project / Tunnel alignment", "Contractual reference"),
        ("Client", meta.get("client") or "-", "-", "alphanumeric", "Project owner / client", "Documentation"),
        ("DrillingContractor", meta.get("drilling_contractor") or "-", "-", "alphanumeric", "Company drilling the borehole", "Contractor record"),
        ("Surface Elevation", meta.get("surface_elevation_mASL") if meta.get("surface_elevation_mASL") is not None else "-", "mASL", "numeric", "Level above mean sea level", "Overburden & depth"),
        ("X / Latitude", lat_or_x if lat_or_x is not None else "-", "° / m", "numeric", "Latitude / Easting", "GIS spatial position"),
        ("Y / Longitude", lon_or_y if lon_or_y is not None else "-", "° / m", "numeric", "Longitude / Northing", "GIS spatial position"),
        ("CoordinateSystem", coord_sys, "-", "alphanumeric", "Spatial reference system", "Spatial reference"),
        ("BoreholeDepth", meta.get("borehole_depth_m") if meta.get("borehole_depth_m") is not None else "-", "m", "numeric", "Total drilled depth", "Excavation horizon"),
        ("DrillingDate", meta.get("drilling_date") or "-", "Date", "date", "Drilling campaign date", "Groundwater baseline"),
        ("Notes", meta.get("notes") or "Extracted and standardized via Universal Mistral OCR Pipeline", "-", "alphanumeric", "Technical remarks", "Operational cautions")
    ]

    for item in meta_rows:
        ws.append(list(item))
        row = ws.max_row
        for c in range(1, 7):
            ws.cell(row=row, column=c).font = font_regular
            ws.cell(row=row, column=c).border = thin_border

    # Section 2: Stratigraphy (Logdata)
    ws.append(["2. STRATIGRAPHIC LOGDATA (Layers & Horizons)", "", "", "", "ISO 14688 / DIN 4023", "Cutterhead Face Stability & Wear"])
    sec_row = ws.max_row
    ws.merge_cells(f"A{sec_row}:F{sec_row}")
    ws[f"A{sec_row}"].fill = section_fill
    ws[f"A{sec_row}"].font = font_section

    strat_cols = ["Depth Interval (m)", "Lithology / Description", "DIN 4023 Code", "USCS", "SPT (N)", "TBM Face & Wear Risk"]
    ws.append(strat_cols)
    header_row = ws.max_row
    for c in range(1, 7):
        ws.cell(row=header_row, column=c).font = font_bold
        ws.cell(row=header_row, column=c).fill = sub_fill
        ws.cell(row=header_row, column=c).border = thin_border

    if stratigraphy:
        for lay in stratigraphy:
            d_from = lay.get('depth_from_m', 0.0)
            d_to = lay.get('depth_to_m', 0.0)
            depth_str = f"{d_from:.2f} – {d_to:.2f} m"
            litho = lay.get("english_lithology") or lay.get("original_description") or lay.get("soil_rock_name", "-")
            din = lay.get("din4023_code", "-")
            uscs = lay.get("uscs_group", "-")
            spt = lay.get("spt_n_value") if lay.get("spt_n_value") is not None else "-"
            
            # Dynamic TBM risk evaluation
            l_low = str(litho).lower()
            if any(k in l_low for k in ["granite", "gneiss", "basalt", "quartz", "rock", "fjell"]):
                tbm_risk = "High cutter wear (Hard rock disc wear)"
            elif any(k in l_low for k in ["clay", "argil", "leire", "silt"]):
                tbm_risk = "Clogging / EPB conditioning required"
            elif any(k in l_low for k in ["sand", "gravel", "grus", "sorra"]):
                tbm_risk = "Abrasive / Face instability risk"
            else:
                tbm_risk = "Standard excavation profile"

            ws.append([depth_str, litho, din, uscs, spt, tbm_risk])
            row = ws.max_row
            for c in range(1, 7):
                ws.cell(row=row, column=c).font = font_regular
                ws.cell(row=row, column=c).border = thin_border
    else:
        ws.append(["0.00 – 0.00 m", "No stratigraphic layers recorded", "-", "-", "-", "-"])
        row = ws.max_row
        for c in range(1, 7):
            ws.cell(row=row, column=c).font = font_regular
            ws.cell(row=row, column=c).border = thin_border

    # Section 3: Geotechnical Parameters
    ws.append(["3. GEOTECHNICAL & GEOMECHANICAL TEST RESULTS", "", "", "", "Laboratory & In-Situ Standards", "Cutterhead Tool Life & Thrust"])
    sec_row = ws.max_row
    ws.merge_cells(f"A{sec_row}:F{sec_row}")
    ws[f"A{sec_row}"].fill = section_fill
    ws[f"A{sec_row}"].font = font_section

    test_rows = [
        ("UCS (Unconfined Compressive Strength)", geotech.get("max_ucs_mpa") or "-", "MPa", "numeric", "Rock intact strength", "Cutterhead thrust & penetration"),
        ("CAI (Cerchar Abrasivity Index)", geotech.get("cai_cerchar_abrasivity") or geotech.get("cai_cerchar") or "-", "-", "numeric", "Cerchar needle test", "Disc cutter wear rate"),
        ("RQD (Rock Quality Designation)", geotech.get("rqd_pct") or geotech.get("rqd_percent") or "-", "%", "numeric", "Core fracturing index", "Overbreak & face stability"),
        ("Water Content", geotech.get("water_content_pct") or "-", "%", "numeric", "Soil moisture ratio", "Muck consistency"),
        ("Bulk Density", geotech.get("density_kn_m3") or "-", "kN/m³", "numeric", "Unit weight", "Earth pressure balance"),
        ("Groundwater Level", geotech.get("water_table_m") or "-", "m", "numeric", "Water table below surface", "Hydrostatic face pressure"),
        ("Recommended TBM Mode", tbm.get("recommended_tbm_mode") or "-", "-", "alphanumeric", "Herrenknecht Machine Type", "Shield & cutterhead configuration")
    ]

    for item in test_rows:
        ws.append(list(item))
        row = ws.max_row
        for c in range(1, 7):
            ws.cell(row=row, column=c).font = font_regular
            ws.cell(row=row, column=c).border = thin_border

    # Column widths
    ws.column_dimensions['A'].width = 30
    ws.column_dimensions['B'].width = 42
    ws.column_dimensions['C'].width = 14
    ws.column_dimensions['D'].width = 16
    ws.column_dimensions['E'].width = 30
    ws.column_dimensions['F'].width = 36

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    return out
