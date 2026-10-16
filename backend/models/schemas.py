"""
Herrenknecht Borehole Standardization Schemas (Pydantic V2)
===========================================================
Defines the official, industry-standard schema matching:
- Herrenknecht BoreholeDataFormat.xlsx
- DIN 4023 (Subsurface exploration & borehole log drawing)
- ISO 14688 / USCS (Unified Soil Classification System)
"""

from typing import List, Optional, Dict, Any, Literal
from pydantic import BaseModel, Field, ConfigDict, field_validator
from datetime import datetime


class DocumentInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    file_name: str = Field(..., description="Original filename of the ingested document")
    source_language: str = Field(default="English", description="Detected language of the source document")
    confidence_score: float = Field(default=0.90, ge=0.0, le=1.0, description="Extraction confidence score (0.0 to 1.0)")
    total_boreholes_found: int = Field(default=1, ge=0, description="Number of distinct boreholes extracted from this file")
    processed_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat() + "Z", description="ISO UTC timestamp")


class CoordinatesModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    latitude: Optional[float] = Field(default=None, description="WGS84 Latitude in decimal degrees")
    longitude: Optional[float] = Field(default=None, description="WGS84 Longitude in decimal degrees")
    local_x: Optional[float] = Field(default=None, description="Easting or local survey grid coordinate X")
    local_y: Optional[float] = Field(default=None, description="Northing or local survey grid coordinate Y")
    coordinate_system: Optional[str] = Field(default="WGS84", description="Spatial reference system (e.g. WGS84, UTM, Local Grid)")


class BoreholeMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    borehole_id: str = Field(..., description="Unique borehole identifier (e.g. BH-01, S-1, 502)")
    borehole_name: Optional[str] = Field(default=None, description="Drilling label or name")
    location_name: Optional[str] = Field(default=None, description="Geographic locality or site location")
    country: Optional[str] = Field(default=None, description="Country of drilling")
    project_id: Optional[str] = Field(default=None, description="Contract or project code")
    project_name: Optional[str] = Field(default=None, description="Tunnel or infrastructure project name")
    client: Optional[str] = Field(default=None, description="Client or project owner organization")
    drilling_contractor: Optional[str] = Field(default=None, description="Drilling company or contractor")
    driller_name: Optional[str] = Field(default=None, description="Name of the drilling operator")
    drilling_date: Optional[str] = Field(default=None, description="Date of drilling campaign (YYYY-MM-DD or date range)")
    surface_elevation_mASL: Optional[float] = Field(default=None, description="Ground surface elevation in meters above sea level")
    coordinates: CoordinatesModel = Field(default_factory=CoordinatesModel, description="Geospatial coordinates")
    borehole_depth_m: Optional[float] = Field(default=None, ge=0.0, description="Total drilled depth in meters")
    casing_info: Optional[str] = Field(default=None, description="Casing diameter and installed depth")
    notes: Optional[str] = Field(default=None, description="Technical drilling remarks, groundwater observations")


class StratigraphicLayer(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    depth_from_m: float = Field(..., ge=0.0, description="Top boundary of the layer in meters below surface")
    depth_to_m: float = Field(..., ge=0.0, description="Bottom boundary of the layer in meters below surface")
    thickness_m: float = Field(..., ge=0.0, description="Layer thickness in meters (depth_to - depth_from)")
    original_description: str = Field(default="", description="Original lithology description in source language")
    english_lithology: str = Field(..., description="Standardized English geological soil/rock description")
    din4023_code: str = Field(
        default="Sand",
        description="Standard DIN 4023 hatching symbol code (Topsoil, Fill, Clay, Silt, Sand, Gravel, Clay/Till, Sandstone, Limestone, Granite, Gneiss, Chalk, Peat)"
    )
    uscs_group: str = Field(default="SP", description="Unified Soil Classification System symbol (e.g. CL, CH, ML, SP, GW, ROCK, FILL)")
    consistency_density: Optional[str] = Field(default=None, description="Relative density or consistency (e.g. Loose, Medium Dense, Stiff)")
    rqd_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0, description="Rock Quality Designation percentage")
    core_recovery_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0, description="Core recovery percentage (TCR)")
    spt_n_value: Optional[int] = Field(default=None, ge=0, description="Standard Penetration Test N-value (blows / 30cm)")
    water_table_m: Optional[float] = Field(default=None, ge=0.0, description="Observed groundwater level in meters below ground")
    ucs_mpa: Optional[float] = Field(default=None, ge=0.0, description="Unconfined Compressive Strength in MPa")

    @field_validator("thickness_m", mode="before")
    @classmethod
    def validate_thickness(cls, v, info):
        if v is not None and float(v) > 0:
            return float(v)
        # Fallback calculate thickness from depth_to - depth_from
        data = info.data
        d_from = data.get("depth_from_m", 0.0)
        d_to = data.get("depth_to_m", d_from)
        return max(0.0, round(float(d_to) - float(d_from), 2))


class GeotechnicalTests(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    water_content_pct: Optional[float] = Field(default=None, description="Natural moisture content in percent")
    density_kn_m3: Optional[float] = Field(default=None, description="Unit bulk weight in kN/m³")
    max_ucs_mpa: Optional[float] = Field(default=None, description="Maximum Unconfined Compressive Strength in MPa")
    cai_cerchar_abrasivity: Optional[float] = Field(default=None, description="Cerchar Abrasivity Index (CAI)")
    rqd_pct: Optional[float] = Field(default=None, description="Average Rock Quality Designation (RQD %)")
    friction_angle_deg: Optional[float] = Field(default=None, description="Internal friction angle in degrees")
    cohesion_kpa: Optional[float] = Field(default=None, description="Cohesion in kPa")
    water_table_m: Optional[float] = Field(default=None, description="Stabilized groundwater level in meters")


class TBMEngineeringAssessment(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    cutter_abrasivity_risk: Literal["Low", "Moderate", "High", "Extreme"] = Field(
        default="Moderate",
        description="Disc cutter wear and abrasivity hazard rating"
    )
    face_stability_risk: Literal["Stable", "Overbreak Risk", "Chimney Collapse Hazard"] = Field(
        default="Stable",
        description="Tunnel face stability and ground support requirement"
    )
    water_ingress_risk: Literal["Dry / Minor", "Moderate Inflow", "High Permeability / Severe Ingress Risk"] = Field(
        default="Dry / Minor",
        description="Groundwater inflow hazard for TBM excavation"
    )
    recommended_tbm_mode: Literal[
        "Earth Pressure Balance (EPB)",
        "Slurry TBM (Mixshield)",
        "Open Gripper / Hard Rock Shield"
    ] = Field(
        default="Earth Pressure Balance (EPB)",
        description="Recommended Herrenknecht TBM technology"
    )


class BoreholeRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    source_file: Optional[str] = Field(default=None, description="Source filename")
    metadata: BoreholeMetadata = Field(..., description="Borehole header metadata")
    stratigraphy: List[StratigraphicLayer] = Field(default_factory=list, description="Stratigraphic horizon sequence")
    geotechnical_tests: GeotechnicalTests = Field(default_factory=GeotechnicalTests, description="Laboratory and in-situ test results")
    tbm_engineering_assessment: TBMEngineeringAssessment = Field(default_factory=TBMEngineeringAssessment, description="Herrenknecht TBM risk assessment")


class BoreholeDocumentResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    document_info: DocumentInfo = Field(..., description="Document provenance and extraction metadata")
    boreholes: List[BoreholeRecord] = Field(..., description="List of standardized borehole records")


class BoreholeListResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    count: int = Field(..., description="Total count of matching boreholes")
    boreholes: List[BoreholeRecord] = Field(..., description="Array of borehole records")


class DatasetFileInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    name: str = Field(..., description="File name")
    relative_path: str = Field(..., description="Relative path in dataset")
    file_type: str = Field(..., description="File extension category (PDF, JPG, PNG, DOCX, XLSX)")
    size_kb: float = Field(..., description="File size in kilobytes")
    is_processed: bool = Field(..., description="Whether this file is already cached/extracted")
    boreholes_count: int = Field(default=0, description="Number of extracted boreholes")
    language: str = Field(default="-", description="Detected source language")
    confidence: float = Field(default=0.0, description="Extraction confidence score")


class DatasetFilesResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    count: int = Field(..., description="Total files found")
    files: List[DatasetFileInfo] = Field(..., description="List of dataset files")


class GeodatabaseStatsResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    total_boreholes: int = Field(..., description="Total number of boreholes indexed")
    total_drilled_depth_m: float = Field(..., description="Cumulative meters of drilling indexed")
    total_stratigraphic_layers: int = Field(..., description="Total strata horizons categorized")
    countries_count: int = Field(..., description="Number of distinct countries")
    countries: List[str] = Field(..., description="List of countries in geodatabase")
    din4023_distribution: Dict[str, int] = Field(..., description="Distribution of DIN 4023 soil/rock types")
