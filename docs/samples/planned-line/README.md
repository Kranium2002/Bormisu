# Planned line samples (fictional)

**Everything here is fictional.** The line "Fictional tunnel alignment T1 (sample)" is invented to run past the fictional demo seed (`python -m app.seed`), near its boreholes KB-1, KB-2 and KB-3. It is not taken from a real project or a challenge report.

The same five-vertex line (about 1.43 km, heading east) in every accepted format:

| File | Format | Notes |
|---|---|---|
| `planned-line.geojson` | GeoJSON FeatureCollection, one LineString | WGS84 lon/lat |
| `planned-line.kml` | KML Placemark with a LineString | WGS84 lon/lat |
| `planned-line.gpx` | GPX route (`rte`/`rtept`) | WGS84 |
| `planned-line.csv` | CSV with `lon,lat` columns | WGS84; no EPSG needed |
| `planned-line-utm32.csv` | CSV with `x;y` columns, semicolons, decimal comma | ETRS89 / UTM zone 32N: upload with EPSG `25832`. Without it the upload is refused (`epsg_required`), because positions are never guessed |

## What to expect after a fresh seed

| Borehole | Review status | Offset | Side | Chainage |
|---|---|---|---|---|
| KB-1 | in_review | 39.8 m | left | 589 m |
| KB-2 | unreviewed | 134.8 m | left | 790 m |
| KB-3 | unreviewed | 72.7 m | right | 987 m |

- Buffer 100 m, **Include unreviewed off** (the default): no hits. 2 unreviewed boreholes inside the band are hidden (KB-1, KB-3).
- Buffer 100 m, **Include unreviewed on**: KB-1, then KB-3. KB-2 is just outside.
- Buffer 150 m, **Include unreviewed on**: KB-1, KB-2, KB-3, in chainage order.

## API

```
curl -F file=@planned-line.geojson http://localhost:8080/api/v1/alignments
curl -F file=@planned-line-utm32.csv -F epsg=25832 http://localhost:8080/api/v1/alignments
curl -X POST -H 'Content-Type: application/json' -d '{"buffer_m": 100, "include_unreviewed": true}' \
  http://localhost:8080/api/v1/alignments/<alignment_id>/query
```

See `contracts/openapi.yaml` (1.3.0, tag `alignments`) for the full shapes.
