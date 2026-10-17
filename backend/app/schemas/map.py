"""Filters, result sets, GeoJSON and place search."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import Field, field_validator

from app.schemas.common import ApiModel, ReviewStatus


class AreaBbox(ApiModel):
    type: Literal["bbox"]
    bbox: list[float] = Field(min_length=4, max_length=4)

    @field_validator("bbox")
    @classmethod
    def _valid_bbox(cls, value: list[float]) -> list[float]:
        min_lon, min_lat, max_lon, max_lat = value
        if not (
            -180 <= min_lon <= 180
            and -180 <= max_lon <= 180
            and -90 <= min_lat <= 90
            and -90 <= max_lat <= 90
        ):
            raise ValueError("bbox is outside WGS84 bounds")
        if min_lat > max_lat:
            raise ValueError("bbox min_lat is greater than max_lat")
        return value


class AreaPolygon(ApiModel):
    type: Literal["polygon"]
    polygon: dict[str, Any]

    @field_validator("polygon")
    @classmethod
    def _valid_polygon(cls, value: dict[str, Any]) -> dict[str, Any]:
        if value.get("type") != "Polygon" or not isinstance(value.get("coordinates"), list):
            raise ValueError("polygon must be a GeoJSON Polygon")
        rings = value["coordinates"]
        if not rings or not all(isinstance(r, list) and len(r) >= 4 for r in rings):
            raise ValueError("polygon rings need at least four positions")
        for ring in rings:
            for pos in ring:
                if not (isinstance(pos, list) and len(pos) >= 2):
                    raise ValueError("polygon positions must be [lon, lat]")
                lon, lat = pos[0], pos[1]
                if not (isinstance(lon, int | float) and isinstance(lat, int | float)):
                    raise ValueError("polygon positions must be numbers")
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise ValueError("polygon is outside WGS84 bounds")
        return value


class AreaCircle(ApiModel):
    type: Literal["circle"]
    center: list[float] = Field(min_length=2, max_length=2)
    radius_m: float = Field(gt=0)

    @field_validator("center")
    @classmethod
    def _valid_center(cls, value: list[float]) -> list[float]:
        lon, lat = value
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError("center is outside WGS84 bounds")
        return value


Area = Annotated[AreaBbox | AreaPolygon | AreaCircle, Field(discriminator="type")]


class BoreholeFilter(ApiModel):
    search: str | None = None
    country: str | None = None
    project: str | None = None
    document_id: str | None = None
    min_depth_m: float | None = None
    max_depth_m: float | None = None
    din4023_codes: list[str] = Field(default_factory=list)
    lithology_min_depth_m: float | None = None
    has_spt: bool | None = None
    has_groundwater: bool | None = None
    review_status: list[ReviewStatus] = Field(default_factory=list)
    include_unreviewed: bool = False
    area: Area | None = None


class ResultSetOut(ApiModel):
    result_set_id: str
    count: int
    located_count: int
    unlocated_count: int
    excluded_unreviewed: int = 0
    uids: list[str]
    bbox: list[float] | None
    area: Any = None
    definition: BoreholeFilter
    created_at: datetime


class PointGeometry(ApiModel):
    type: Literal["Point"] = "Point"
    coordinates: list[float]


class FeatureProperties(ApiModel):
    uid: str
    borehole_id: str
    project_name: str | None = None
    document_id: str
    borehole_depth_m: float | None = None
    review_status: str
    crs_status: str
    revision: int
    attention: bool
    open_clarifications: int


class Feature(ApiModel):
    type: Literal["Feature"] = "Feature"
    id: str
    geometry: PointGeometry
    properties: FeatureProperties


class FeatureCollection(ApiModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[Feature]


class PlaceCandidate(ApiModel):
    label: str
    lat: float
    lon: float
    bbox: list[float] | None = None
    source: Literal["uploaded", "geocoder"]
    kind: str | None = None
    borehole_count: int | None = None
