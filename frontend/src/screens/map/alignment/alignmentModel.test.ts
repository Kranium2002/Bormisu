/** Planned line view model (fictional values): accepted files, the drawn line's GeoJSON file, the fields, the table's texts and order. */
import { describe, expect, it } from 'vitest';
import type { AlignmentHit } from '../../../domain/types';
import {
  ALIGNMENT_ACCEPT,
  chainageText,
  depthText,
  DRAWN_LINE_FILE,
  drawnLineFile,
  hitRows,
  isAlignmentFile,
  isCsv,
  lengthText,
  offsetText,
  parseBuffer,
  parseEpsg,
} from './alignmentModel';

const hit = (uid: string, chainageM: number, offsetM: number): AlignmentHit => ({
  uid,
  id: uid,
  documentId: 'doc_TEST',
  project: null,
  depth: null,
  reviewStatus: 'approved',
  crsStatus: 'confirmed',
  lat: 50,
  lng: 9,
  offsetM,
  chainageM,
  side: 'left',
});

describe('planned line files', () => {
  it('takes GeoJSON, JSON, KML, GPX and CSV by extension, in any case', () => {
    for (const name of ['line.geojson', 'LINE.JSON', 'route.kml', 'track.GPX', 'vertices.csv']) expect(isAlignmentFile(name), name).toBe(true);
    for (const name of ['line.kmz', 'report.pdf', 'geojson', 'line.geojson.txt']) expect(isAlignmentFile(name), name).toBe(false);
    expect(ALIGNMENT_ACCEPT).toBe('.geojson,.json,.kml,.gpx,.csv');
    expect(isCsv('a.CSV')).toBe(true);
    expect(isCsv('a.geojson')).toBe(false);
  });

  it('a drawn line becomes one GeoJSON Feature with a LineString of [lng, lat] in drawing order, as drawn-line.geojson', async () => {
    const file = drawnLineFile([
      [9.413691234567, 50.208008],
      [9.4188891, 50.2095182],
      [9.423806, 50.210895],
    ]);
    expect(file.name).toBe(DRAWN_LINE_FILE);
    expect(file.name).toBe('drawn-line.geojson');
    expect(file.type).toBe('application/geo+json');
    expect(JSON.parse(await file.text())).toEqual({
      type: 'Feature',
      properties: { name: 'Drawn line' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [9.4136912, 50.208008],
          [9.4188891, 50.2095182],
          [9.423806, 50.210895],
        ],
      },
    });
    const named = drawnLineFile(
      [
        [1, 2],
        [3, 4],
      ],
      'Trasse A',
    );
    expect(JSON.parse(await named.text()).properties).toEqual({ name: 'Trasse A' });
  });
});

describe('fields', () => {
  it('EPSG: blank is none, a code with or without "EPSG:", anything else invalid', () => {
    expect(parseEpsg('')).toBeNull();
    expect(parseEpsg('  ')).toBeNull();
    expect(parseEpsg('25832')).toBe(25832);
    expect(parseEpsg('epsg:25832')).toBe(25832);
    expect(parseEpsg('EPSG: 4326 ')).toBe(4326);
    expect(parseEpsg('UTM 32')).toBe('invalid');
    expect(parseEpsg('12')).toBe('invalid');
  });

  it('distance: above 0, at most 1000 m, decimal comma accepted', () => {
    expect(parseBuffer('100')).toBe(100);
    expect(parseBuffer('12,5')).toBe(12.5);
    expect(parseBuffer('1000')).toBe(1000);
    for (const bad of ['', '0', '-5', '1000.1', 'abc']) expect(parseBuffer(bad), bad).toBeNull();
  });
});

describe('table texts and order', () => {
  it('chainage to the metre, offset to the decimetre, length in km from 1000 m, a missing depth blank', () => {
    expect(chainageText(589.14)).toBe('589 m');
    expect(offsetText(39.84)).toBe('39.8 m');
    expect(lengthText(1432.4)).toBe('1.43 km');
    expect(lengthText(850.2)).toBe('850 m');
    expect(depthText(12)).toBe('12.00 m');
    expect(depthText(null)).toBe('');
  });

  it('rows by chainage, then offset', () => {
    const rows = hitRows([hit('b', 987, 72), hit('a', 589, 40), hit('c', 589, 12)]);
    expect(rows.map((h) => h.uid)).toEqual(['c', 'a', 'b']);
  });
});
