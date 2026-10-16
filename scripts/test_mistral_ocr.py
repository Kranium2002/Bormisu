import sys
import os
import json
from pathlib import Path

# Add project root to sys.path
root_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root_dir))

from backend.extractor.mistral_ocr_pipeline import MistralOCRExtractor
from backend.extractor.excel_exporter import export_borehole_to_herrenknecht_excel

def main():
    # Ensure stdout handles UTF-8 on Windows
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    # Pick default test file or from CLI args
    target_file = sys.argv[1] if len(sys.argv) > 1 else "ToughOne1.pdf"
    force_refresh = "--force" in sys.argv
    
    print("=" * 70)
    print(" BORMISU - MISTRAL OCR 2503 EXTRACTION & STANDARDIZATION")
    print(f" Target File: {target_file} {'(FORCED REFRESH)' if force_refresh else '(CACHE ENABLED)'}")
    print("=" * 70)
    
    extractor = MistralOCRExtractor()
    
    if not extractor.openrouter_key and not extractor.mistral_key:
        print("\n[!] WARNING: No API key found in .env!")
        print("Please set your MISTRAL_API_KEY in .env before running.")
        sys.exit(1)
        
    try:
        result = extractor.process_document(target_file, force_refresh=force_refresh)
        
        print("\n" + "=" * 70)
        print(" EXTRACTION SUCCESSFUL!")
        print("=" * 70)
        print(f"Engine: {result.get('extractor_engine')}")
        
        # Metadata
        meta = result.get("metadata", {})
        print("\n[HERRENKNECHT METADATA]")
        print(f"  • Borehole ID:   {meta.get('borehole_id', 'N/A')}")
        print(f"  • Borehole Name: {meta.get('borehole_name', 'N/A')}")
        print(f"  • Project Name:  {meta.get('project_name', 'N/A')}")
        print(f"  • Location:      {meta.get('location_name', 'N/A')} ({meta.get('country', 'N/A')})")
        print(f"  • Coordinates:   {meta.get('coordinates', {})}")
        print(f"  • Total Depth:   {meta.get('total_depth_m', 'N/A')} m")
        print(f"  • Surface Elev:  {meta.get('surface_elevation_mASL', 'N/A')} mASL")
        
        # Stratigraphy
        layers = result.get("stratigraphy_layers", [])
        print(f"\n[STRATIGRAPHY & DIN 4023 PROFILES ({len(layers)} layers)]")
        print(f"{'Depth (m)':<17} | {'DIN Code':<10} | {'USCS':<6} | {'Lithology / Description':<38} | {'UCS':<8}")
        print("-" * 90)
        for layer in layers:
            depth_str = f"{layer.get('depth_from_m', 0):.2f} – {layer.get('depth_to_m', 0):.2f}m"
            din = layer.get('din4023_code') or '-'
            uscs = layer.get('uscs_group') or '-'
            desc = (layer.get('soil_rock_name') or '-')[:36]
            ucs = f"{layer.get('ucs_mpa')} MPa" if layer.get('ucs_mpa') is not None else '-'
            print(f"{depth_str:<17} | {din:<10} | {uscs:<6} | {desc:<38} | {ucs:<8}")

        # Test results
        tests = result.get("test_results", {})
        if tests:
            print("\n[GEOTECHNICAL & TBM PARAMETERS]")
            for k, v in tests.items():
                if v is not None:
                    print(f"  • {k}: {v}")

        # Export to Herrenknecht official Excel specification
        stem = Path(target_file).stem
        out_excel = root_dir / "backend" / "cache" / f"{stem}_BoreholeDataFormat.xlsx"
        export_borehole_to_herrenknecht_excel(result, out_excel)
        print(f"\n[EXCEL EXPORT] Successfully generated Herrenknecht standard format:")
        print(f"  -> {out_excel}")

        # OCR Markdown preview
        md = result.get("raw_markdown_ocr", "")
        if md:
            print("\n[RAW MISTRAL OCR MARKDOWN PREVIEW (first 350 chars)]")
            print("-" * 50)
            print(md[:350].replace('\u2610', '[ ]') + ("..." if len(md) > 350 else ""))
            print("-" * 50)
            
    except Exception as e:
        print(f"\n[ERROR] Extraction failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
