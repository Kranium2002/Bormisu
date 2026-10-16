"""
Bormisu — Herrenknecht Global Borehole Intelligence API
=======================================================
Enterprise backend for automated borehole data extraction, DIN 4023 standardization,
and geotechnical engineering analysis for Herrenknecht AG.
"""

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from backend.api.routes import extract, boreholes, export, analytics

app = FastAPI(
    title="Herrenknecht Borehole Intelligence API (Bormisu)",
    description=(
        "Production RESTful API for universal geotechnical log ingestion (PDF, JPG, PNG, DOCX, XLSX), "
        "Mistral OCR 2503 layout parsing, DIN 4023 standardization, and TBM tunneling risk assessment."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global Exception Handlers ensuring valid JSON responses
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": "Validation Error",
            "detail": exc.errors(),
            "body": str(exc.body) if hasattr(exc, "body") else None
        }
    )

@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "Internal Server Error",
            "detail": str(exc)
        }
    )

# Include v1 Routers
app.include_router(extract.router, prefix="/api/v1")
app.include_router(boreholes.router, prefix="/api/v1")
app.include_router(export.router, prefix="/api/v1")
app.include_router(analytics.router, prefix="/api/v1")

# Aliases for unversioned convenience
app.include_router(extract.router, prefix="/api")
app.include_router(boreholes.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(analytics.router, prefix="/api")


@app.get("/api/health", tags=["System"])
def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "Herrenknecht Borehole Intelligence API",
        "version": "1.0.0",
        "standards": ["DIN 4023", "ISO 14688", "Herrenknecht BoreholeDataFormat.xlsx"]
    }
