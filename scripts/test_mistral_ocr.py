import sys
import os
import json
from pathlib import Path

# Add project root to sys.path
root_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root_dir))

from backend.extractor.mistral_ocr_pipeline import MistralOCRExtractor

def main():
    # Pick default test file or from CLI args
    target_file = sys.argv[1] if len(sys.argv) > 1 else "AF01.PDF"
    
    print("=" * 70)
    print(" BORMISU - MISTRAL OCR 2503 EXTRACTION TEST")
    print(f" Target File: {target_file}")
    print("=" * 70)
    
    extractor = MistralOCRExtractor()
    
    if not extractor.openrouter_key and not extractor.mistral_key:
        print("\n[!] WARNING: No API key found in .env!")
        print("Please set your OPENROUTER_API_KEY in .env before running:")
        print("OPENROUTER_API_KEY=sk-or-v1-...\n")
        sys.exit(1)
        
    try:
        result = extractor.process_document(target_file, force_refresh=True)
        
        print("\n" + "=" * 70)
        print(" EXTRACTION SUCCESSFUL!")
        print("=" * 70)
        print(f"Engine: {result.get('extractor_engine')}")
        
        # Metadata
        meta = result.get("metadata", {})
        print("\n[METADATA]")
        print(f"  • Borehole ID:   {meta.get('borehole_id', 'N/A')}")
        print(f"  • Project Name:  {meta.get('project_name', 'N/A')}")
        print(f"  • Location:      {meta.get('location_name', 'N/A')} ({meta.get('country', 'N/A')})")
        print(f"  • Coordinates:   {meta.get('coordinates', {})}")
        print(f"  • Total Depth:   {meta.get('total_depth_m', 'N/A')} m")
        print(f"  • Surface Elev:  {meta.get('surface_elevation_mASL', 'N/A')} mASL")
        
        # Stratigraphy
        layers = result.get("stratigraphy_layers", [])
        print(f"\n[STRATIGRAPHY LAYERS ({len(layers)} detected)]")
        print(f"{'Depth (m)':<15} | {'USCS':<6} | {'Lithology / Description':<35} | {'RQD':<6} | {'UCS (MPa)':<10}")
        print("-" * 80)
        for layer in layers:
            depth_str = f"{layer.get('depth_from_m', 0):.2f} - {layer.get('depth_to_m', 0):.2f}m"
            uscs = layer.get('uscs_group') or '-'
            desc = (layer.get('soil_rock_name') or '-')[:33]
            rqd = f"{layer.get('rqd_percent')}%" if layer.get('rqd_percent') is not None else '-'
            ucs = f"{layer.get('ucs_mpa')}" if layer.get('ucs_mpa') is not None else '-'
            print(f"{depth_str:<15} | {uscs:<6} | {desc:<35} | {rqd:<6} | {ucs:<10}")

        # Test results
        tests = result.get("test_results", {})
        if tests:
            print("\n[GEOMECHANICAL PARAMETERS]")
            for k, v in tests.items():
                if v is not None:
                    print(f"  • {k}: {v}")

        # OCR Markdown preview
        md = result.get("raw_markdown_ocr", "")
        if md:
            print("\n[RAW MISTRAL OCR MARKDOWN PREVIEW (first 400 chars)]")
            print("-" * 50)
            print(md[:400] + ("..." if len(md) > 400 else ""))
            print("-" * 50)
            
    except Exception as e:
        print(f"\n[ERROR] Extraction failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
