"""Planned lines against PostGIS with fictional boreholes; every response is checked against the contract."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from geoalchemy2 import WKTElement
from pyproj import Geod, Transformer

from app.db.models import Borehole, Document
from app.db.session import get_sessionmaker
from tests.contract_utils import validate_response

pytestmark = pytest.mark.db

GEOD = Geod(ellps="WGS84")
DOC_ID = "doc_01JFAKE00000000000000ALNE"
# A fictional straight line heading east along 50°N, about 1.43 km long.
START, END = (9.40, 50.20), (9.42, 50.20)
LINE_GEOJSON = {
    "type": "Feature",
    "properties": {"name": "Fictional test tunnel"},
    "geometry": {"type": "LineString", "coordinates": [list(START), list(END)]},
}


def _at(lon: float, azimuth: float, metres: float) -> tuple[float, float]:
    """A point `metres` from the line point at `lon` (azimuth 0 = north = left of an eastward line)."""
    out_lon, out_lat, _ = GEOD.fwd(lon, START[1], azimuth, metres)
    return out_lon, out_lat


# label -> (position or None, review status)
BOREHOLES: dict[str, tuple[tuple[float, float] | None, str]] = {
    "AL-50N": (_at(9.405, 0, 50), "approved"),  # included, left
    "AL-150S": (_at(9.410, 180, 150), "approved"),  # outside 100 m
    "AL-30S": (_at(9.415, 180, 30), "approved"),  # included, right
    "AL-20N-U": (_at(9.402, 0, 20), "unreviewed"),  # only with include_unreviewed
    "AL-WEST": (_at(9.40, 270, 60), "approved"),  # behind the start: chainage 0
    "AL-FAR": ((9.80, 50.50), "approved"),  # far away
    "AL-NOPOS": (None, "approved"),  # not on the map
    "AL-NOPOS-U": (None, "in_review"),  # not on the map, unreviewed
}


async def call(client: httpx.AsyncClient, method: str, path: str, *, expect: int, **kwargs: Any) -> Any:
    response = await client.request(method, path, **kwargs)
    assert response.status_code == expect, response.text
    body = response.json() if response.content else None
    validate_response(method, path.split("?")[0], response.status_code, body)
    return body


async def _seed() -> dict[str, str]:
    """Fictional boreholes around the line; returns label -> uid."""
    uids: dict[str, str] = {}
    async with get_sessionmaker()() as session:
        session.add(
            Document(
                id=DOC_ID,
                file_name="fictional-alignment-logs.pdf",
                sha256="e" * 64,
                mime_type="application/pdf",
                size_bytes=10,
                storage_key="originals/" + "e" * 64 + ".pdf",
                status="done",
            )
        )
        await session.flush()
        for i, (label, (position, status)) in enumerate(BOREHOLES.items()):
            uid = f"bh_01JFAKE0000000000000ALN{i:03d}"
            uids[label] = uid
            session.add(
                Borehole(
                    uid=uid,
                    document_id=DOC_ID,
                    group_key=label,
                    label_raw=label,
                    label_canonical=label.lower(),
                    review_status=status,
                    crs_status="confirmed" if position else "unknown",
                    plotted=position is not None,
                    unplotted_reason=None if position else "no_coordinates",
                    geom=WKTElement(f"POINT({position[0]!r} {position[1]!r})", srid=4326)
                    if position
                    else None,
                    borehole_depth_m=10.0 + i,
                    project_name="Fictional Alignment Site",
                    record={"metadata": {"borehole_id": label}},
                )
            )
        await session.commit()
    return uids


async def _upload(client: httpx.AsyncClient, **form: str) -> dict[str, Any]:
    files = {"file": ("tunnel.geojson", json.dumps(LINE_GEOJSON).encode(), "application/geo+json")}
    body: dict[str, Any] = await call(
        client, "POST", "/api/v1/alignments", expect=201, files=files, data=form
    )
    return body


async def test_boreholes_along_the_line(client: httpx.AsyncClient) -> None:
    uids = await _seed()
    alignment = await _upload(client)
    assert alignment["name"] == "Fictional test tunnel" and alignment["format"] == "geojson"
    assert alignment["geometry"] == {"type": "LineString", "coordinates": [list(START), list(END)]}
    assert alignment["length_m"] == pytest.approx(GEOD.inv(*START, *END)[2], abs=0.1)
    assert alignment["buffer_m"] == 100 and alignment["bbox"] == [9.40, 50.20, 9.42, 50.20]

    path = f"/api/v1/alignments/{alignment['alignment_id']}/query"
    result = await call(client, "POST", path, expect=200, json={})
    hits = result["hits"]
    # ~50 m in, ~150 m out; only approved by default; sorted by chainage.
    assert [h["borehole_id"] for h in hits] == ["AL-WEST", "AL-50N", "AL-30S"]
    by_label = {h["borehole_id"]: h for h in hits}
    assert by_label["AL-50N"]["offset_m"] == pytest.approx(50, abs=0.2)
    assert by_label["AL-30S"]["offset_m"] == pytest.approx(30, abs=0.2)
    assert by_label["AL-WEST"]["offset_m"] == pytest.approx(60, abs=0.2)
    assert (by_label["AL-50N"]["side"], by_label["AL-30S"]["side"]) == ("left", "right")
    assert by_label["AL-WEST"]["chainage_m"] == 0
    assert by_label["AL-50N"]["chainage_m"] == pytest.approx(GEOD.inv(*START, 9.405, 50.2)[2], abs=1.0)
    assert by_label["AL-30S"]["chainage_m"] == pytest.approx(GEOD.inv(*START, 9.415, 50.2)[2], abs=1.0)
    assert by_label["AL-50N"]["review_status"] == "approved" and by_label["AL-50N"]["uid"] == uids["AL-50N"]
    assert result["excluded_unreviewed"] == 1 and result["not_on_map"] == 1
    assert result["metric_crs"] == "EPSG:32632" and result["buffer_m"] == 100
    assert result["buffer_polygon"]["type"] == "Polygon"

    # The hits are a result set like any other selection (map highlight, chat context).
    rs = result["result_set"]
    assert rs["uids"] == [h["uid"] for h in hits] and rs["count"] == rs["located_count"] == 3
    assert rs["excluded_unreviewed"] == 1 and rs["definition"]["include_unreviewed"] is False
    assert rs["area"]["type"] == "polygon"
    stored = await call(client, "GET", f"/api/v1/result-sets/{rs['result_set_id']}", expect=200)
    assert stored["uids"] == rs["uids"]
    response = await client.get(f"/api/v1/result-sets/{rs['result_set_id']}/geojson")
    assert sorted(f["id"] for f in response.json()["features"]) == sorted(rs["uids"])

    # Include unreviewed: the unreviewed borehole 20 m off the line joins; the out-of-map count grows.
    result = await call(client, "POST", path, expect=200, json={"include_unreviewed": True})
    assert [h["borehole_id"] for h in result["hits"]] == ["AL-WEST", "AL-20N-U", "AL-50N", "AL-30S"]
    assert result["excluded_unreviewed"] == 0 and result["not_on_map"] == 2
    assert result["result_set"]["definition"]["include_unreviewed"] is True

    # A wider buffer reaches the borehole 150 m away.
    result = await call(client, "POST", path, expect=200, json={"buffer_m": 160})
    assert [h["borehole_id"] for h in result["hits"]] == ["AL-WEST", "AL-50N", "AL-150S", "AL-30S"]
    assert result["buffer_m"] == 160


async def test_buffer_given_at_upload_is_the_default(client: httpx.AsyncClient) -> None:
    await _seed()
    alignment = await _upload(client, buffer_m="40", name="  Short buffer  ")
    assert alignment["buffer_m"] == 40 and alignment["name"] == "Short buffer"
    result = await call(client, "POST", f"/api/v1/alignments/{alignment['alignment_id']}/query", expect=200)
    assert [h["borehole_id"] for h in result["hits"]] == ["AL-30S"]
    assert result["buffer_m"] == 40


async def test_empty_band_echoes_its_bbox(client: httpx.AsyncClient) -> None:
    alignment = await _upload(client)
    result = await call(client, "POST", f"/api/v1/alignments/{alignment['alignment_id']}/query", expect=200)
    assert result["hits"] == [] and result["result_set"]["count"] == 0
    min_lon, min_lat, max_lon, max_lat = result["result_set"]["bbox"]
    assert min_lon < START[0] and max_lon > END[0] and min_lat < START[1] < max_lat


async def test_projected_csv_upload_and_list_get_delete(client: httpx.AsyncClient) -> None:
    to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
    rows = [to_utm.transform(*START), to_utm.transform(*END)]
    csv = "x;y\n" + "".join(f"{x:.2f};{y:.2f}\n".replace(".", ",") for x, y in rows)
    files = {"file": ("line-utm.csv", csv.encode(), "text/csv")}
    refused = await call(client, "POST", "/api/v1/alignments", expect=422, files=files)
    assert refused["code"] == "epsg_required"
    first = await call(
        client, "POST", "/api/v1/alignments", expect=201, files=files, data={"epsg": "EPSG:25832"}
    )
    assert first["source_crs"] == "EPSG:25832" and first["name"] == "line-utm" and first["format"] == "csv"
    for (lon, lat), (elon, elat) in zip(first["geometry"]["coordinates"], [START, END], strict=True):
        assert lon == pytest.approx(elon, abs=1e-6) and lat == pytest.approx(elat, abs=1e-6)
    second = await _upload(client)

    listing = await call(client, "GET", "/api/v1/alignments", expect=200)
    assert [a["alignment_id"] for a in listing["alignments"]] == [
        second["alignment_id"],
        first["alignment_id"],
    ]
    one = await call(client, "GET", f"/api/v1/alignments/{first['alignment_id']}", expect=200)
    assert one == first
    await call(client, "DELETE", f"/api/v1/alignments/{first['alignment_id']}", expect=204)
    missing = await call(client, "GET", f"/api/v1/alignments/{first['alignment_id']}", expect=404)
    assert missing["code"] == "alignment_not_found"
    await call(client, "DELETE", f"/api/v1/alignments/{first['alignment_id']}", expect=404)
    gone = await call(client, "POST", f"/api/v1/alignments/{first['alignment_id']}/query", expect=404)
    assert gone["code"] == "alignment_not_found"


@pytest.mark.parametrize(
    ("name", "content", "form", "status", "code"),
    [
        (
            "area.geojson",
            json.dumps({"type": "Polygon", "coordinates": [[[9, 50], [9.1, 50], [9.1, 50.1], [9, 50]]]}),
            {},
            422,
            "alignment_invalid",
        ),
        (
            "one.geojson",
            json.dumps({"type": "LineString", "coordinates": [[9, 50]]}),
            {},
            422,
            "alignment_invalid",
        ),
        ("broken.kml", "<kml><Document><LineString>", {}, 422, "alignment_invalid"),
        ("line.kmz", "PK", {}, 415, "unsupported_type"),
        ("line.csv", "lon,lat\n9.4,50.2\n9.41,50.2\n", {"buffer_m": "0"}, 422, "validation_error"),
        ("line.csv", "lon,lat\n9.4,50.2\n9.41,50.2\n", {"buffer_m": "5000"}, 422, "validation_error"),
        ("line.csv", "lon,lat\n9.4,50.2\n9.41,50.2\n", {"epsg": "utm"}, 422, "validation_error"),
        ("line.csv", "x,y\n1,2\n3,4\n", {"epsg": "999999"}, 422, "crs_invalid"),
    ],
)
async def test_upload_errors(
    client: httpx.AsyncClient, name: str, content: str, form: dict[str, str], status: int, code: str
) -> None:
    files = {"file": (name, content.encode(), "application/octet-stream")}
    body = await call(client, "POST", "/api/v1/alignments", expect=status, files=files, data=form)
    assert body["code"] == code and body["detail"]


async def test_upload_without_file_and_bad_query(client: httpx.AsyncClient) -> None:
    body = await call(client, "POST", "/api/v1/alignments", expect=422, data={"name": "x"})
    assert body["code"] == "validation_error"
    alignment = await _upload(client)
    path = f"/api/v1/alignments/{alignment['alignment_id']}/query"
    for bad in ({"buffer_m": 0}, {"buffer_m": 1001}, {"buffer_m": "far"}):
        assert (await call(client, "POST", path, expect=422, json=bad))["code"] == "validation_error"
