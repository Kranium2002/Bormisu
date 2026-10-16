import sys
import os
import json
from pathlib import Path

# Add project root to sys.path
root_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root_dir))

from backend.extractor.universal_pipeline import UniversalBoreholePipeline
from backend.extractor.excel_exporter import export_borehole_to_herrenknecht_excel

def main():
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    # Pick default test file or from CLI args
    target_file = sys.argv[1] if len(sys.argv) > 1 else "ToughOne1.pdf"
    force_refresh = "--force" in sys.argv
    max_pages = 14
    for arg in sys.argv:
        if arg.startswith("--pages="):
            max_pages = int(arg.split("=")[1])

    print("=" * 80)
    print(" BORMISU — UNIVERSAL GEOTECHNICAL EXTRACTION PIPELINE")
    print(f" Target File: {target_file} | Force Refresh: {force_refresh} | Max Pages: {max_pages}")
    print("=" * 80)

    try:
        pipeline = UniversalBoreholePipeline()
        result_json = pipeline.extract_document(target_file, force_refresh=force_refresh, max_pages=max_pages)

        # Output JSON File Path
        stem = Path(target_file).stem
        out_json_path = root_dir / "backend" / "cache" / f"{stem}_standardized_herrenknecht.json"
        with open(out_json_path, "w", encoding="utf-8") as f:
            json.dump(result_json, f, indent=2, ensure_ascii=False)

        print("\n" + "=" * 80)
        print(" UNIVERSAL EXTRACTION SUCCESSFUL — ALWAYS VALID JSON OUTPUT")
        print("=" * 80)
        print(f"JSON Output File: {out_json_path}")
        
        doc_info = result_json.get("document_info", {})
        boreholes = result_json.get("boreholes", [])
        print(f"Document Info: {doc_info}")
        print(f"Total Boreholes Extracted: {len(boreholes)}\n")

        for idx, bh in enumerate(boreholes):
            meta = bh.get("metadata", {})
            layers = bh.get("stratigraphy", [])
            tbm = bh.get("tbm_engineering_assessment", {})
            
            print(f"[{idx+1}/{len(boreholes)}] BOREHOLE: {meta.get('borehole_name') or meta.get('borehole_id')} ({meta.get('location_name', 'N/A')}, {meta.get('country', 'N/A')})")
            print(f"    • Depth: {meta.get('borehole_depth_m')}m | Elevation: {meta.get('surface_elevation_mASL')} mASL | Date: {meta.get('drilling_date')}")
            print(f"    • Driller: {meta.get('driller_name', 'N/A')} | Contractor: {meta.get('drilling_contractor', 'N/A')}")
            print(f"    • Coordinates: {meta.get('coordinates', {})}")
            if meta.get("notes"):
                print(f"    • Notes: {meta.get('notes')}")
            
            print(f"    • Stratigraphy ({len(layers)} layers):")
            for lay in layers:
                depth_s = f"{lay.get('depth_from_m', 0):.1f}–{lay.get('depth_to_m', 0):.1f}m"
                print(f"      - {depth_s:<14} | DIN: {lay.get('din4023_code', '-'):<10} | USCS: {lay.get('uscs_group', '-'):<5} | {lay.get('english_lithology') or lay.get('original_description')}")
            
            print(f"    • TBM Risk: Cutter Wear={tbm.get('cutter_abrasivity_risk')} | Stability={tbm.get('face_stability_risk')} | Ingress={tbm.get('water_ingress_risk')}")
            print()

        # Also generate Excel export for the first borehole
        if boreholes:
            out_excel = root_dir / "backend" / "cache" / f"{stem}_BoreholeDataFormat.xlsx"
            primary_bh = {
                "metadata": boreholes[0].get("metadata", {}),
                "stratigraphy_layers": boreholes[0].get("stratigraphy", []),
                "test_results": boreholes[0].get("geotechnical_tests", {})
            }
            export_borehole_to_herrenknecht_excel(primary_bh, out_excel)
            print(f"[EXCEL EXPORT] Generated: {out_excel}")

    except Exception as e:
        print(f"\n[ERROR] Pipeline failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
