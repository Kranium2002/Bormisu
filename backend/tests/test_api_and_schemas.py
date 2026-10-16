import pytest
from fastapi.testclient import TestClient
from backend.api.main import app
from backend.models.schemas import (
    BoreholeDocumentResponse,
    BoreholeListResponse,
    GeodatabaseStatsResponse,
    DatasetFilesResponse
)

client = TestClient(app)

def test_health_check():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert "DIN 4023" in data["standards"]

def test_stats_endpoint():
    response = client.get("/api/v1/stats")
    assert response.status_code == 200
    # Validate against strict Pydantic model
    stats = GeodatabaseStatsResponse.model_validate(response.json())
    assert stats.total_boreholes >= 10
    assert stats.total_drilled_depth_m > 0
    assert "Spain" in stats.countries or "Norway" in stats.countries

def test_boreholes_list():
    response = client.get("/api/v1/boreholes")
    assert response.status_code == 200
    result = BoreholeListResponse.model_validate(response.json())
    assert result.count > 0
    assert len(result.boreholes) == result.count

def test_borehole_detail():
    # Fetch first borehole
    list_resp = client.get("/api/v1/boreholes")
    first_bh = list_resp.json()["boreholes"][0]
    bh_id = first_bh["metadata"]["borehole_id"]
    
    detail_resp = client.get(f"/api/v1/boreholes/{bh_id}")
    assert detail_resp.status_code == 200
    detail_data = detail_resp.json()
    assert detail_data["metadata"]["borehole_id"] == bh_id
    assert "stratigraphy" in detail_data
    assert "geotechnical_tests" in detail_data
    assert "tbm_engineering_assessment" in detail_data

def test_export_json():
    list_resp = client.get("/api/v1/boreholes")
    first_bh = list_resp.json()["boreholes"][0]
    bh_id = first_bh["metadata"]["borehole_id"]
    
    export_resp = client.get(f"/api/v1/export/{bh_id}/json")
    assert export_resp.status_code == 200
    assert export_resp.headers["content-type"] == "application/json"
    exported_json = export_resp.json()
    assert exported_json["metadata"]["borehole_id"] == bh_id

def test_export_excel():
    list_resp = client.get("/api/v1/boreholes")
    first_bh = list_resp.json()["boreholes"][0]
    bh_id = first_bh["metadata"]["borehole_id"]
    
    export_resp = client.get(f"/api/v1/export/{bh_id}/excel")
    assert export_resp.status_code == 200
    assert "spreadsheetml" in export_resp.headers["content-type"]
    assert len(export_resp.content) > 1000

def test_dataset_files_list():
    response = client.get("/api/v1/dataset/files")
    assert response.status_code == 200
    files_resp = DatasetFilesResponse.model_validate(response.json())
    assert files_resp.count > 0
    assert any(f.file_type == "PDF" for f in files_resp.files)
