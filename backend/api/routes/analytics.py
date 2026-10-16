import os
import json
from pathlib import Path
from fastapi import APIRouter

from backend.extractor.universal_pipeline import CACHE_DIR
from backend.models.schemas import GeodatabaseStatsResponse, DatasetFilesResponse, DatasetFileInfo
from backend.api.routes.boreholes import get_all_records

router = APIRouter(tags=["Analytics & Dataset Explorer"])
DATASET_DIR = Path(os.getenv("DATASET_PATH", r"C:\Users\aravm\Downloads\HKBoreholeChallenge_Data_BFH2026"))


@router.get(
    "/stats",
    response_model=GeodatabaseStatsResponse,
    summary="Geodatabase Analytics & Distribution",
    description="Aggregate metrics across all indexed boreholes: total meters drilled, rock distribution, and geographic coverage."
)
def get_stats() -> GeodatabaseStatsResponse:
    boreholes = get_all_records()
    total_depth = sum((bh.metadata.borehole_depth_m or 0.0) for bh in boreholes)
    total_layers = sum(len(bh.stratigraphy) for bh in boreholes)
    
    countries = set()
    din_codes = {}
    
    for bh in boreholes:
        if bh.metadata.country:
            countries.add(bh.metadata.country)
        for layer in bh.stratigraphy:
            code = layer.din4023_code or "Unknown"
            din_codes[code] = din_codes.get(code, 0) + 1

    return GeodatabaseStatsResponse(
        total_boreholes=len(boreholes),
        total_drilled_depth_m=round(total_depth, 2),
        total_stratigraphic_layers=total_layers,
        countries_count=len(countries),
        countries=sorted(list(countries)),
        din4023_distribution=din_codes
    )


@router.get(
    "/dataset/files",
    response_model=DatasetFilesResponse,
    summary="List Heterogeneous Dataset Files",
    description="Scans the challenge repository for raw borehole files (PDF, JPG, PNG, DOCX, XLSX) and returns ingestion status."
)
def list_dataset_files() -> DatasetFilesResponse:
    files_list = []
    supported_exts = {".pdf", ".jpg", ".jpeg", ".png", ".docx", ".xlsx", ".csv"}
    
    if not DATASET_DIR.exists():
        return DatasetFilesResponse(count=0, files=[])

    search_dir = DATASET_DIR / "BoreholeData" if (DATASET_DIR / "BoreholeData").exists() else DATASET_DIR
    
    cached_files = {}
    for jf in CACHE_DIR.glob("universal_*.json"):
        try:
            with open(jf, "r", encoding="utf-8") as f:
                d = json.load(f)
                f_name = d.get("document_info", {}).get("file_name")
                if f_name:
                    cached_files[f_name] = {
                        "boreholes_count": len(d.get("boreholes", [])),
                        "language": d.get("document_info", {}).get("source_language", "Unknown"),
                        "confidence": d.get("document_info", {}).get("confidence_score", 0.0)
                    }
        except Exception:
            pass

    for p in search_dir.rglob("*"):
        if p.is_file() and p.suffix.lower() in supported_exts:
            rel = str(p.relative_to(DATASET_DIR)).replace("\\", "/")
            f_stat = p.stat()
            is_processed = p.name in cached_files
            cache_meta = cached_files.get(p.name, {})

            files_list.append(DatasetFileInfo(
                name=p.name,
                relative_path=rel,
                file_type=p.suffix.lower().replace(".", "").upper(),
                size_kb=round(f_stat.st_size / 1024, 1),
                is_processed=is_processed,
                boreholes_count=cache_meta.get("boreholes_count", 0),
                language=cache_meta.get("language", "-"),
                confidence=cache_meta.get("confidence", 0.0)
            ))

    sorted_files = sorted(files_list, key=lambda x: (not x.is_processed, x.name))
    return DatasetFilesResponse(count=len(sorted_files), files=sorted_files)
