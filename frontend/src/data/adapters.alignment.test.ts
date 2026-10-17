/**
 * Planned lines (contract 1.3.0) over the backend's examples (fictional): Alignment, AlignmentList and
 * AlignmentResult adapt without losing what the server sent; the query body is the contract's.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES_MISSING, EXAMPLES_PRESENT, example } from '../test/contract/examples';
import { contractErrors } from '../test/contract/schema';
import {
  adaptAlignment,
  adaptAlignmentResult,
  adaptAlignments,
  lineParts,
  polygonsOf,
  toWireAlignmentQuery,
  type WireAlignment,
  type WireAlignmentList,
  type WireAlignmentResult,
} from './adapters';

const title = EXAMPLES_PRESENT ? 'planned line examples' : `planned line examples (skipped: ${EXAMPLES_MISSING})`;

describe.skipIf(!EXAMPLES_PRESENT)(title, () => {
  it('Alignment.json keeps the line, its length, its counts and its source system', () => {
    const w = example<WireAlignment>('Alignment.json');
    const a = adaptAlignment(w);
    expect(a).toMatchObject({
      id: w.alignment_id,
      name: w.name,
      fileName: w.file_name,
      format: 'geojson',
      sourceCrs: 'EPSG:4326',
      lengthM: w.length_m,
      vertexCount: w.vertex_count,
      partCount: 1,
      bufferM: w.buffer_m,
      createdAt: w.created_at,
    });
    expect(a.parts).toEqual([(w.geometry.coordinates as number[][]).map((p) => [p[0], p[1]])]);
    expect(a.bbox).toEqual(w.bbox);
  });

  it('AlignmentList.json adapts every line, newest first as sent', () => {
    const w = example<WireAlignmentList>('AlignmentList.json');
    const list = adaptAlignments(w);
    expect(list.map((a) => a.id)).toEqual(w.alignments.map((a) => a.alignment_id));
    expect(list.find((a) => a.format === 'csv')?.sourceCrs).toBe('EPSG:27700');
  });

  it('AlignmentResult.json: hits by chainage with position, offset and side; the band; the counts; the result set', () => {
    const w = example<WireAlignmentResult>('AlignmentResult.json');
    const r = adaptAlignmentResult(w);
    expect(r.hits).toHaveLength(w.hits.length);
    const [h] = r.hits;
    const [wh] = w.hits;
    expect(h).toEqual({
      uid: wh.uid,
      id: wh.borehole_id,
      documentId: wh.document_id,
      project: wh.project_name ?? null,
      depth: wh.borehole_depth_m ?? null,
      reviewStatus: wh.review_status,
      crsStatus: wh.crs_status,
      lng: wh.position[0],
      lat: wh.position[1],
      offsetM: wh.offset_m,
      chainageM: wh.chainage_m,
      side: wh.side,
    });
    expect(r).toMatchObject({
      alignmentId: w.alignment_id,
      bufferM: w.buffer_m,
      includeUnreviewed: w.include_unreviewed,
      lengthM: w.length_m,
      metricCrs: w.metric_crs,
      excludedUnreviewed: w.excluded_unreviewed,
      notOnMap: w.not_on_map,
    });
    expect(r.notOnMap).toBeGreaterThan(0);
    expect(r.band).toHaveLength(1);
    expect(r.band[0][0].length).toBe((w.buffer_polygon.coordinates[0] as unknown[]).length);
    expect(r.resultSet.id).toBe(w.result_set.result_set_id);
    expect(r.resultSet.uids).toEqual(r.hits.map((x) => x.uid));
  });
});

describe('planned line wire helpers', () => {
  it('a MultiLineString keeps its parts; a part without two positions is left out', () => {
    expect(
      lineParts({
        type: 'MultiLineString',
        coordinates: [
          [
            [1, 2],
            [3, 4],
          ],
          [[5, 6]],
          [
            [7, 8],
            [9, 10, 99],
          ],
        ],
      }),
    ).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
      [
        [7, 8],
        [9, 10],
      ],
    ]);
    expect(
      lineParts({
        type: 'LineString',
        coordinates: [
          [1, 2],
          ['x', 3],
          [5, 6],
        ],
      }),
    ).toEqual([
      [
        [1, 2],
        [5, 6],
      ],
    ]);
    expect(lineParts(null)).toEqual([]);
  });

  it('a MultiPolygon band keeps its polygons and rings', () => {
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    expect(polygonsOf({ type: 'MultiPolygon', coordinates: [[ring], [ring, ring]] })).toHaveLength(2);
    expect(polygonsOf({ type: 'Polygon', coordinates: [ring] })).toEqual([[ring]]);
    expect(polygonsOf({ type: 'Point', coordinates: [1, 2] })).toEqual([]);
  });

  it('the query body is an AlignmentQuery; no distance leaves it to the line', () => {
    const body = toWireAlignmentQuery({ bufferM: 150, includeUnreviewed: true });
    expect(body).toEqual({ buffer_m: 150, include_unreviewed: true });
    expect(contractErrors('AlignmentQuery', body)).toEqual([]);
    expect(toWireAlignmentQuery({ bufferM: null, includeUnreviewed: false })).toEqual({ include_unreviewed: false });
  });
});
