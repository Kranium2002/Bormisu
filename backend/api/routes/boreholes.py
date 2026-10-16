import json
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query

from backend.extractor.universal_pipeline import CACHE_DIR
from backend.models.schemas import BoreholeListResponse, BoreholeRecord

router = APIRouter(prefix="/boreholes", tags=["Borehole Geodatabase"])


def get_all_records() -> List[BoreholeRecord]:
    """Scan cache directory for all standardized Herrenknecht JSON files."""
    records = []
    for json_file in CACHE_DIR.glob("universal_*.json"):
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                doc_name = data.get("document_info", {}).get("file_name", json_file.stem)
                for bh in data.get("boreholes", []):
                    bh_dict = dict(bh)
                    bh_dict["source_file"] = doc_name
                    records.append(BoreholeRecord.model_validate(bh_dict))
        except Exception as e:
            print(f"[WARN] Failed to deserialize {json_file.name}: {e}")
    return records


@router.get(
    "",
    response_model=BoreholeListResponse,
    summary="List & Filter Boreholes",
    description="Retrieve all indexed boreholes with geotechnical parameters, DIN 4023 classifications, and geospatial coordinates."
)
def list_boreholes(
    country: Optional[str] = Query(None, description="Filter by country (e.g. Norway, Spain, Brazil, Kuwait)"),
    min_depth_m: Optional[float] = Query(None, ge=0.0, description="Minimum drilled depth in meters"),
    max_depth_m: Optional[float] = Query(None, ge=0.0, description="Maximum drilled depth in meters"),
    rock_type: Optional[str] = Query(None, description="Filter by DIN 4023 lithology (e.g. Granite, Sand, Clay, Limestone)"),
    search: Optional[str] = Query(None, description="Free text search across borehole ID, project name, or location")
) -> BoreholeListResponse:
    all_boreholes = get_all_records()
    matched = []

    for bh in all_boreholes:
        meta = bh.metadata
        
        # Country filter
        if country and meta.country and country.lower() not in meta.country.lower():
            continue
            
        # Depth filter
        depth = meta.borehole_depth_m or 0.0
        if min_depth_m is not None and depth < min_depth_m:
            continue
        if max_depth_m is not None and depth > max_depth_m:
            continue
            
        # Rock type filter
        if rock_type:
            rt_low = rock_type.lower()
            found_rock = any(
                rt_low in (layer.din4023_code or "").lower() or
                rt_low in layer.english_lithology.lower()
                for layer in bh.stratigraphy
            )
            if not found_rock:
                continue

        # Free text search
        if search:
            s_low = search.lower()
            text_corpus = f"{meta.borehole_id} {meta.borehole_name or ''} {meta.location_name or ''} {meta.project_name or ''}".lower()
            if s_low not in text_corpus:
                continue

        matched.append(bh)

    return BoreholeListResponse(count=len(matched), boreholes=matched)


@router.get(
    "/{borehole_id}",
    response_model=BoreholeRecord,
    summary="Get Borehole Detail",
    description="Fetch complete borehole profile including metadata, DIN 4023 stratigraphy, geotechnical test results, and Herrenknecht TBM assessment."
)
def get_borehole(borehole_id: str) -> BoreholeRecord:
    all_boreholes = get_all_records()
    for bh in all_boreholes:
        bid = bh.metadata.borehole_id.strip()
        if bid.lower() == borehole_id.lower() or borehole_id.lower() in bid.lower():
            return bh

    raise HTTPException(status_code=404, detail=f"Borehole with identifier '{borehole_id}' not found.")
