import shutil
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query
from pydantic import BaseModel, Field

from backend.extractor.universal_pipeline import UniversalBoreholePipeline, CACHE_DIR
from backend.models.schemas import BoreholeDocumentResponse

router = APIRouter(prefix="/extract", tags=["Extraction & Ingestion"])
pipeline = UniversalBoreholePipeline()

UPLOADS_DIR = Path(__file__).resolve().parent.parent.parent / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


class FileExtractionRequest(BaseModel):
    file_path: str = Field(..., description="File path or filename within the borehole dataset")
    force_refresh: bool = Field(default=False, description="Bypass local cache and re-extract with Mistral AI")
    max_pages: int = Field(default=25, description="Maximum pages to process for multi-page documents")


@router.post(
    "/file",
    response_model=BoreholeDocumentResponse,
    summary="Extract & Standardize Borehole Document (By Path)",
    description="Ingests any supported document (PDF, JPG, PNG, DOCX, XLSX, CSV, TXT) and returns standardized Herrenknecht JSON."
)
def extract_file(request: FileExtractionRequest) -> BoreholeDocumentResponse:
    try:
        raw_result = pipeline.extract_document(
            file_input=request.file_path,
            force_refresh=request.force_refresh,
            max_pages=request.max_pages
        )
        return BoreholeDocumentResponse.model_validate(raw_result)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Universal extraction failed: {str(e)}")


@router.post(
    "/upload",
    response_model=BoreholeDocumentResponse,
    summary="Upload & Standardize Borehole Document (Multipart)",
    description="Upload any raw drilling log, scan, core photo, Word doc, or spreadsheet. Always returns strictly valid Herrenknecht JSON."
)
async def extract_upload(
    file: UploadFile = File(..., description="Borehole document file (PDF, JPG, PNG, TIFF, DOCX, XLSX, CSV)"),
    force_refresh: bool = Form(False, description="Force re-extraction bypass cache")
) -> BoreholeDocumentResponse:
    try:
        dest_path = UPLOADS_DIR / file.filename
        with open(dest_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        raw_result = pipeline.extract_document(
            file_input=dest_path,
            force_refresh=force_refresh
        )
        return BoreholeDocumentResponse.model_validate(raw_result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"File upload extraction failed: {str(e)}")
