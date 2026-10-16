import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from backend.extractor.universal_pipeline import CACHE_DIR
from backend.extractor.excel_exporter import export_borehole_to_herrenknecht_excel
from backend.api.routes.boreholes import get_all_records

router = APIRouter(prefix="/export", tags=["Standardized Export"])


@router.get(
    "/{borehole_id}/excel",
    summary="Export to Herrenknecht BoreholeDataFormat.xlsx",
    description="Generates and downloads the official Excel spreadsheet matching DIN 4023 and Herrenknecht AG standards."
)
def export_excel(borehole_id: str):
    all_boreholes = get_all_records()
    matched = None
    for bh in all_boreholes:
        bid = bh.metadata.borehole_id.strip()
        if bid.lower() == borehole_id.lower() or borehole_id.lower() in bid.lower():
            matched = bh.model_dump()
            break

    if not matched:
        raise HTTPException(status_code=404, detail=f"Borehole '{borehole_id}' not found for export.")

    safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in borehole_id)
    out_file = CACHE_DIR / f"{safe_id}_BoreholeDataFormat.xlsx"
    export_borehole_to_herrenknecht_excel(matched, out_file)

    return FileResponse(
        path=out_file,
        filename=f"Herrenknecht_{safe_id}_BoreholeData.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


@router.get(
    "/{borehole_id}/json",
    summary="Export to Standardized Herrenknecht JSON",
    description="Download strictly formatted JSON adhering to the universal Herrenknecht geotechnical schema."
)
def export_json(borehole_id: str):
    all_boreholes = get_all_records()
    matched = None
    for bh in all_boreholes:
        bid = bh.metadata.borehole_id.strip()
        if bid.lower() == borehole_id.lower() or borehole_id.lower() in bid.lower():
            matched = bh.model_dump()
            break

    if not matched:
        raise HTTPException(status_code=404, detail=f"Borehole '{borehole_id}' not found for export.")

    safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in borehole_id)
    json_bytes = json.dumps(matched, indent=2, ensure_ascii=False).encode("utf-8")

    return Response(
        content=json_bytes,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename=Herrenknecht_{safe_id}_Standardized.json"}
    )
