"""
Multi-Borehole Universal Parser for Herrenknecht AG (Bormisu)
=============================================================
Parses any document type (PDF, Images, DOCX, XLSX/CSV, TXT) in any language,
identifies single or multi-borehole records, and outputs strictly valid JSON
adhering to Herrenknecht's official BoreholeDataFormat.xlsx standard.
"""

import sys
import json
from pathlib import Path
from typing import Dict, Any, List, Optional
from backend.extractor.universal_pipeline import UniversalBoreholePipeline

def parse_document_to_json(file_path: str or Path, output_json_path: Optional[str or Path] = None) -> Dict[str, Any]:
    """
    Universal entry point to extract any file into standardized Herrenknecht JSON.
    """
    pipeline = UniversalBoreholePipeline()
    result = pipeline.extract_document(file_path)
    
    if output_json_path:
        out_p = Path(output_json_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        with open(out_p, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"[SAVED] JSON saved to {out_p}")
        
    return result

def batch_parse_directory(directory_path: str or Path, max_files: int = 10) -> List[Dict[str, Any]]:
    """
    Batch process any directory containing heterogeneous borehole logs.
    """
    pipeline = UniversalBoreholePipeline()
    dir_p = Path(directory_path)
    supported_exts = {".pdf", ".jpg", ".jpeg", ".png", ".docx", ".xlsx", ".csv"}
    
    results = []
    files_processed = 0
    
    for f in dir_p.rglob("*"):
        if f.suffix.lower() in supported_exts and files_processed < max_files:
            try:
                print(f"[BATCH] Processing {f.name}...")
                data = pipeline.extract_document(f)
                results.append(data)
                files_processed += 1
            except Exception as e:
                print(f"[BATCH ERROR] Failed on {f.name}: {e}")
                
    return results

if __name__ == "__main__":
    if len(sys.argv) > 1:
        target = sys.argv[1]
        out = sys.argv[2] if len(sys.argv) > 2 else None
        res = parse_document_to_json(target, out)
        print(json.dumps(res, indent=2, ensure_ascii=False))
    else:
        print("Usage: python -m backend.extractor.multi_borehole_parser <file_path> [output_json_path]")
