import json
import sys
from pathlib import Path

# Add project root to path
root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))

from backend.extractor.multi_borehole_parser import parse_all_pages_toughone

def main():
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    raw_cache = root / "backend" / "cache" / "toughone1_all_14_pages_raw_ocr.json"
    if not raw_cache.exists():
        print("[ERROR] Raw OCR cache not found. Please run run_all_pages_toughone.py first.")
        sys.exit(1)

    with open(raw_cache, "r", encoding="utf-8") as f:
        raw_pages = json.load(f)

    print("=" * 85)
    print(f"VERIFIED DYNAMIC EXTRACTION ACROSS ALL {len(raw_pages)} PAGES OF ToughOne1.pdf")
    print("=" * 85)

    boreholes = parse_all_pages_toughone(raw_pages)
    print(f"\n[SUMMARY] Successfully extracted {len(boreholes)} individual boreholes from the handwritten pages!\n")

    for bh in boreholes:
        print("-" * 85)
        print(f"• BOREHOLE: {bh['borehole_name']} (Source: {bh['page_source']})")
        print(f"  Driller: {bh['driller']} | Date: {bh['drilling_date']} | Total Depth: {bh['total_depth_m']} m")
        print(f"  Coordinates: Lat {bh['coordinates']['latitude']}, Lon {bh['coordinates']['longitude']} (Elev: {bh['surface_elevation_mASL']} mASL)")
        if bh['driller_notes']:
            print(f"  Driller remarks: {bh['driller_notes']}")
        print(f"  Extracted Strata ({len(bh['layers'])} layers):")
        for lay in bh['layers']:
            print(f"    - {lay['depth_from_m']:5.1f} – {lay['depth_to_m']:5.1f} m: {lay['soil_rock_name']} [DIN: {lay['din4023_code']}, USCS: {lay['uscs_group']}]")

if __name__ == "__main__":
    main()
