import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import { boreholeStatus, cleanKeys } from '../domain/review';
import {
  adaptBorehole,
  adaptCrsCandidates,
  adaptDocument,
  apiPageUsage,
  documentLint,
  patternFor,
  type ApiBoreholeRecord,
  type ApiTarget,
} from './adapters';
import { patchActions } from './apiSource';

/** The fictional record from the API contract (§5.1). */
const record: ApiBoreholeRecord = {
  uid: 'doc_7f3a:NM-121',
  document_id: 'doc_7f3a',
  source_file: 'nordlys_GI.pdf',
  crs_status: 'inferred',
  plotted: true,
  unplotted_reason: null,
  metadata: {
    borehole_id: 'NM-121',
    project_name: 'Nordlys Metro (fictional)',
    borehole_depth_m: 18,
    surface_elevation_mASL: 212.4,
    coordinates: { latitude: 59.9, longitude: 10.7, local_x: null, local_y: null, coordinate_system: null },
  },
  stratigraphy: [
    {
      depth_from_m: 0, depth_to_m: 2.1, original_description: 'relleno', english_lithology: 'fill',
      din4023_code: 'A', spt_n_value: 8, spt_raw: '3,4,5 = 8', spt_increments: [3, 4, 5],
    },
    {
      depth_from_m: 2.1, depth_to_m: 4.8, original_description: 'arcilla limosa con gravas', english_lithology: 'silty clay with gravel',
      din4023_code: 'Clay', spt_n_value: null, spt_raw: '50/30', spt_refusal: true, spt_increments: [50], spt_penetration_cm: 30, spt_depth_m: 4.5,
    },
  ],
  groundwater: [
    { type: 'strike', depth_m: 1.8, date: null },
    { type: 'rest', depth_m: 1.2, date: null },
  ],
  provenance: {
    'metadata.borehole_depth_m': {
      page: 7, box: [0.61, 0.82, 0.07, 0.02], raw: '18,00 m', method: 'ocr', confidence: 0.82,
      status: 'unreviewed', state: 'ok', ai_value: 18,
    },
  },
  lint: [{ path: 'metadata.borehole_depth_m', rule: 'log_bottom_vs_final_depth', severity: 'error', message: 'Log bottom 4.8 m ≠ final depth 18.0 m' }],
};

describe('adaptBorehole', () => {
  const { borehole: b, targets } = adaptBorehole(record);
  const v = (key: string) => b.values.find((x) => x.key === key);

  it('maps identity, position, CRS and depths', () => {
    expect(b).toMatchObject({
      uid: 'doc_7f3a:NM-121', id: 'NM-121', documentId: 'doc_7f3a', sourceFile: 'nordlys_GI.pdf',
      project: 'Nordlys Metro (fictional)', lat: 59.9, lng: 10.7, onMap: true, finalDepth: 18, logBottom: 4.8,
      crs: { name: null, code: null, status: 'inferred' }, primaryPage: 7,
    });
  });

  it('carries provenance and lint onto the value', () => {
    expect(v(K.finalDepth)).toMatchObject({
      value: '18.00', raw: '18,00 m', page: 7, box: { x: 0.61, y: 0.82, w: 0.07, h: 0.02 }, method: 'OCR',
      confidence: 0.82, lint: { severity: 'error', message: 'Log bottom 4.8 m ≠ final depth 18.0 m' },
    });
    expect(targets[K.finalDepth]).toEqual({ paths: ['metadata.borehole_depth_m'], type: 'number' });
  });

  it('shows unknown values as "not in source", never a default', () => {
    expect(v(K.startDate)).toMatchObject({ value: '', state: 'not in source' });
    expect(v(K.crs)).toMatchObject({ value: '', state: 'not in source', kind: 'crs' });
  });

  it('orders values: borehole, groundwater, layers', () => {
    const groups = b.values.map((x) => x.group);
    expect(groups).toEqual([...groups].sort((x, y) => ['borehole', 'groundwater', 'layer'].indexOf(x) - ['borehole', 'groundwater', 'layer'].indexOf(y)));
    expect(b.values.map((x) => x.key).slice(-3)).toEqual([K.bottom(2), K.lithology(2), K.spt(2)]);
  });

  it('keeps SPT refusals as refusals and lints increments', () => {
    expect(v(K.spt(2))).toMatchObject({ value: 'refusal · 50 blows / 30 cm', raw: '50/30', refusal: true, label: 'SPT @ 4.50 m' });
    expect(b.layers[1].spt).toMatchObject({ refusal: true, blows: 50, penetrationCm: 30 });
    expect(b.layers[1].spt?.n).toBeUndefined();
    expect(v(K.spt(1))?.lint?.message).toBe('Increments 4 + 5 = 9 ≠ N 8');
  });

  it('maps layers, lithology and groundwater', () => {
    expect(b.layers.map((l) => [l.from, l.to, l.pattern, l.din])).toEqual([[0, 2.1, 'fill', 'A'], [2.1, 4.8, 'clay', 'Clay']]);
    expect(v(K.lithology(2))).toMatchObject({ value: 'silty clay with gravel', raw: 'arcilla limosa con gravas', din: 'Clay' });
    expect(b.groundwater).toEqual([
      { type: 'strike', depth: 1.8, key: K.gw(0) },
      { type: 'rest', depth: 1.2, key: K.gw(1) },
    ]);
  });

  it('builds a uid when the backend has none, and treats 0/0 as no coordinates', () => {
    const { borehole } = adaptBorehole({ metadata: { borehole_id: 'BH-1', coordinates: { latitude: 0, longitude: 0 } } });
    expect(borehole).toMatchObject({ uid: 'doc:BH-1', onMap: false, lat: null, unplottedReason: 'No coordinates in source' });
  });

  // int-02: two reports with an FX-1 each both got the uid "doc:FX-1" (INTEGRATION.md pitfall 2).
  it('tells the same borehole ID in two reports apart without a backend uid', () => {
    const a = adaptBorehole({ source_file: 'north_GI.pdf', metadata: { borehole_id: 'FX-1' } }).borehole;
    const b = adaptBorehole({ source_file: 'south_GI.pdf', metadata: { borehole_id: 'FX-1' } }).borehole;
    const c = adaptBorehole({ document_id: 'd9', source_file: 'south_GI.pdf', metadata: { borehole_id: 'FX-1' } }).borehole;
    expect([a.uid, b.uid, c.uid]).toEqual(['north_GI.pdf:FX-1', 'south_GI.pdf:FX-1', 'd9:FX-1']);
  });

  // int-04: an SPT without provenance counted as Read, so APPROVE ALL CLEAN approved an unchecked value.
  it('gives an SPT without provenance the method Guessed, so it is not clean', () => {
    const { borehole } = adaptBorehole({
      uid: 'd:TB-02', document_id: 'd', metadata: { borehole_id: 'TB-02' },
      stratigraphy: [{ depth_from_m: 0, depth_to_m: 3, spt_n_value: 12 }],
    });
    expect(borehole.values.find((x) => x.key === K.spt(1))).toMatchObject({ method: 'Guessed', value: 'N = 12' });
    expect(cleanKeys(borehole)).not.toContain(K.spt(1));
  });
});

// int-05: the backend's default "WGS84" showed as a stated CRS, even without coordinates.
describe('adaptBorehole CRS status without crs_status', () => {
  const crs = (rec: Partial<ApiBoreholeRecord>, coordinates: NonNullable<ApiBoreholeRecord['metadata']['coordinates']>) =>
    adaptBorehole({ metadata: { borehole_id: 'TB-03', coordinates }, ...rec }).borehole.crs.status;

  it('is stated when the coordinate system was read from the report', () => {
    const provenance = { 'metadata.coordinates.coordinate_system': { page: 2, raw: 'Gauß-Krüger Zone 3', method: 'read' } };
    expect(crs({ provenance }, { local_x: 3513420, local_y: 5405870, coordinate_system: 'EPSG:31467' })).toBe('stated');
  });

  it('is inferred when there are coordinates but the system has no source text', () => {
    expect(crs({}, { latitude: 48.79, longitude: 9.18, coordinate_system: 'WGS84' })).toBe('inferred');
    const provenance = { 'metadata.coordinates.coordinate_system': { page: 2, raw: '  ', method: 'guessed' } };
    expect(crs({ provenance }, { local_x: 3513420, local_y: 5405870, coordinate_system: 'WGS84' })).toBe('inferred');
  });

  it('is unknown without coordinates', () => {
    expect(crs({}, { coordinate_system: 'WGS84' })).toBe('unknown');
    expect(crs({}, { latitude: 0, longitude: 0 })).toBe('unknown');
  });

  it('keeps the backend status when there is one', () => {
    expect(crs({ crs_status: 'confirmed' }, { latitude: 48.79, longitude: 9.18, coordinate_system: 'WGS84' })).toBe('confirmed');
  });
});

describe('patternFor', () => {
  it('maps DIN codes and English names to hatchings', () => {
    expect(patternFor('Sandstone', '')).toBe('sst');
    expect(patternFor('G, s', 'gravel, sandy')).toBe('gravel');
    expect(patternFor('', 'Topsoil')).toBe('topsoil');
    expect(patternFor('', 'boulder clay (till)')).toBe('marl');
    expect(patternFor('', 'silty clay with gravel')).toBe('clay');
    expect(patternFor('', 'Sand, gravelly')).toBe('sand');
    expect(patternFor('Clay', 'gravel')).toBe('clay');
    expect(patternFor('', 'granite')).toBe('sand');
  });
});

describe('adaptDocument', () => {
  it('maps status, pages and completeness', () => {
    const d = adaptDocument({
      document_id: 'doc_7f3a', file_name: 'nordlys_GI.pdf', status: 'needs_review', page_count: 3,
      found: { boreholes: 1, layers: 2, spt: 2, groundwater: 2 },
      pages: [{ n: 1, type: 'text', used: false, unused_reason: 'cover page' }, { n: 3, type: 'log', used: true }],
      completeness: { expected_ids: ['NM-121', 'NM-122'], found_ids: ['NM-121'], missing: ['NM-122'], unexpected: [] },
    });
    expect(d.step).toBe(2);
    expect(d.pageTypes).toEqual(['text', 'unknown', 'log']);
    expect(d.completeness).toMatchObject({ listed: 2, missing: ['NM-122'], expectedIds: ['NM-121', 'NM-122'] });
    expect(d.error).toBeNull();
  });

  it('reports failures', () => {
    const d = adaptDocument({ document_id: 'x', file_name: 'x.pdf', status: 'failed', error: 'OCR crashed' });
    expect(d.error).toBe('OCR crashed');
  });

  it('describes page usage', () => {
    const d = { document_id: 'x', file_name: 'x.pdf', status: 'done' as const, pages: [{ n: 1, type: 'photo', used: false, unused_reason: null }] };
    expect(apiPageUsage(d, 1)).toBe('unused: photo');
    expect(apiPageUsage(d, 2)).toBe('not classified yet');
  });
});

describe('adaptCrsCandidates', () => {
  it('maps lon to lng and marks candidates without points as out of range', () => {
    const c = adaptCrsCandidates([
      { crs: 'EPSG:25832', label: 'ETRS89 / UTM 32N', points: [{ uid: 'a', lat: 1, lon: 2 }] },
      { crs: 'EPSG:4326', label: 'WGS 84', points: [] },
    ]);
    expect(c[0]).toMatchObject({ code: 'EPSG:25832', verdict: 'match', points: [{ uid: 'a', lat: 1, lng: 2 }] });
    expect(c[1].verdict).toBe('out_of_range');
  });
});

describe('patchActions', () => {
  const depth: ApiTarget = { paths: ['metadata.borehole_depth_m'], type: 'number' };
  const p = 'metadata.borehole_depth_m';
  const bodies = (...a: Parameters<typeof patchActions>) => patchActions(...a).flatMap((s) => s.bodies);

  it('translates review patches into PATCH bodies', () => {
    expect(bodies({ status: 'approved' }, depth)).toEqual([{ path: p, action: 'approve' }]);
    expect(bodies({ value: '18.5', method: 'Edited', status: 'approved' }, depth)).toEqual([
      { path: p, action: 'edit', value: 18.5 },
      { path: p, action: 'approve' },
    ]);
    expect(bodies({ value: '18.5', method: 'Edited', status: 'approved', state: 'ok' }, depth)).toEqual([
      { path: p, action: 'set_state', state: 'ok' },
      { path: p, action: 'edit', value: 18.5 },
      { path: p, action: 'approve' },
    ]);
    expect(bodies({ flag: 'datum unclear', status: 'flagged' }, depth)).toEqual([{ path: p, action: 'flag', reason: 'datum unclear' }]);
    expect(bodies({ state: 'not in source', status: 'approved' }, depth)).toEqual([
      { path: p, action: 'set_state', state: 'not_in_source' },
      { path: p, action: 'approve' },
    ]);
  });

  it('says which part of the patch each step saves', () => {
    expect(patchActions({ value: '18.5', method: 'Edited', status: 'approved' }, depth).map((s) => s.applied)).toEqual([
      { value: '18.5', method: 'Edited' },
      { status: 'approved' },
    ]);
  });

  // int-07: undo is sent as a reset (INTEGRATION.md §3 item 7), after any state change.
  it('sends un-approve, un-flag and clearing a state as a reset', () => {
    expect(patchActions({ status: 'unreviewed' }, depth)).toEqual([{ bodies: [{ path: p, action: 'reset' }], applied: { status: 'unreviewed' } }]);
    expect(patchActions({ status: 'unreviewed', flag: undefined }, depth).map((s) => s.applied)).toEqual([{ status: 'unreviewed', flag: undefined }]);
    expect(bodies({ state: 'ok', status: 'unreviewed' }, depth)).toEqual([
      { path: p, action: 'set_state', state: 'ok' },
      { path: p, action: 'reset' },
    ]);
  });

  // Regression (c7): an alphanumeric ID "0007" was sent as the number 7.
  it('keeps text fields as typed, leading zeros included', () => {
    const id: ApiTarget = { paths: ['metadata.borehole_id'], type: 'string' };
    expect(bodies({ value: '0007', method: 'Edited', status: 'approved' }, id)[0]).toEqual({ path: 'metadata.borehole_id', action: 'edit', value: '0007' });
    const date: ApiTarget = { paths: ['metadata.drilling_date'], type: 'string' };
    expect(bodies({ value: '2019', method: 'Edited' }, date)[0]).toMatchObject({ value: '2019' });
  });

  it('sends an SPT N as a number', () => {
    const spt: ApiTarget = { paths: ['stratigraphy[0].spt_n_value'], type: 'spt' };
    expect(bodies({ value: 'N = 9', method: 'Edited' }, spt)[0]).toMatchObject({ value: 9 });
  });

  // Regression (c8): an X / Y edit went to the object path "metadata.coordinates" as one string.
  it('splits an X / Y edit into one typed update per coordinate', () => {
    const xy: ApiTarget = { paths: ['metadata.coordinates.local_x', 'metadata.coordinates.local_y'], type: 'number' };
    expect(bodies({ value: '3513421 / 5405870', method: 'Edited', status: 'approved' }, xy)).toEqual([
      { path: 'metadata.coordinates.local_x', action: 'edit', value: 3513421 },
      { path: 'metadata.coordinates.local_y', action: 'edit', value: 5405870 },
      { path: 'metadata.coordinates.local_x', action: 'approve' },
      { path: 'metadata.coordinates.local_y', action: 'approve' },
    ]);
    expect(() => patchActions({ value: '3513421', method: 'Edited' }, xy)).toThrow(/both values/);
  });
});

describe('adaptBorehole regressions', () => {
  const base = (over: Partial<ApiBoreholeRecord> = {}, md: Partial<ApiBoreholeRecord['metadata']> = {}): ApiBoreholeRecord => ({
    uid: 'd:TB-01', document_id: 'd', metadata: { borehole_id: 'TB-01', ...md }, ...over,
  });

  // c8: provenance of local coordinates is keyed by the scalar paths, not "metadata.coordinates".
  it('takes X / Y provenance from the local_x / local_y paths and targets both', () => {
    const { borehole, targets } = adaptBorehole(
      base(
        {
          provenance: {
            'metadata.coordinates.local_x': { page: 3, box: [0.1, 0.2, 0.1, 0.02], raw: 'R 3513420', method: 'read', status: 'approved' },
            'metadata.coordinates.local_y': { page: 3, box: [0.3, 0.2, 0.1, 0.02], raw: 'H 5405870', method: 'read', status: 'approved' },
          },
        },
        { coordinates: { local_x: 3513420, local_y: 5405870 } },
      ),
    );
    const xy = borehole.values.find((v) => v.key === K.xy);
    expect(xy).toMatchObject({ value: '3513420 / 5405870', raw: 'R 3513420 / H 5405870', page: 3, method: 'Read', status: 'approved' });
    expect(xy?.box?.x).toBeCloseTo(0.1);
    expect(xy?.box?.w).toBeCloseTo(0.3);
    expect(targets[K.xy].paths).toEqual(['metadata.coordinates.local_x', 'metadata.coordinates.local_y']);
  });

  it('puts the easting first for geographic coordinates (X = longitude)', () => {
    const { borehole, targets } = adaptBorehole(base({}, { coordinates: { latitude: 59.9, longitude: 10.7 } }));
    expect(borehole.values.find((v) => v.key === K.xy)?.value).toBe('10.7 / 59.9');
    expect(targets[K.xy].paths).toEqual(['metadata.coordinates.longitude', 'metadata.coordinates.latitude']);
  });

  // c10: every reading is kept, including several rest levels and a standpipe.
  it('keeps every groundwater reading, keyed by its index', () => {
    const { borehole, targets } = adaptBorehole(
      base({
        groundwater: [
          { type: 'rest', depth_m: 1.2, date: '2019-03-01' },
          { type: 'rest', depth_m: 1.4, date: '2019-03-08' },
          { type: 'standpipe', depth_m: 2.0, date: null },
        ],
      }),
    );
    expect(borehole.groundwater).toEqual([
      { type: 'rest', depth: 1.2, key: K.gw(0) },
      { type: 'rest', depth: 1.4, key: K.gw(1) },
      { type: 'standpipe', depth: 2, key: K.gw(2) },
    ]);
    expect(borehole.values.filter((v) => v.group === 'groundwater').map((v) => v.label)).toEqual([
      'GW rest level (2019-03-01)', 'GW rest level (2019-03-08)', 'GW standpipe',
    ]);
    expect(targets[K.gw(1)].paths).toEqual(['groundwater[1].depth_m']);
  });

  // c11: the legacy water table keeps its own path for provenance and edits.
  it('gives the legacy water_table_m reading its own path', () => {
    const { borehole, targets } = adaptBorehole(
      base({
        geotechnical_tests: { water_table_m: 3.1 },
        provenance: { 'geotechnical_tests.water_table_m': { page: 5, raw: 'GW 3,10', method: 'ocr' } },
      }),
    );
    expect(targets[K.gw(0)].paths).toEqual(['geotechnical_tests.water_table_m']);
    expect(borehole.values.find((v) => v.key === K.gw(0))).toMatchObject({ raw: 'GW 3,10', page: 5, value: '3.10' });
  });

  // c12: a missing final depth stays unknown; the log bottom only bounds the drawing.
  it('keeps an unknown final depth unknown', () => {
    const { borehole } = adaptBorehole(base({ stratigraphy: [{ depth_from_m: 0, depth_to_m: 6 }] }));
    expect(borehole.finalDepth).toBeNull();
    expect(borehole.logBottom).toBe(6);
    expect(borehole.values.find((v) => v.key === K.finalDepth)).toMatchObject({ value: '', state: 'not in source' });
  });

  // c13: findings on paths without a review row land on the nearest row instead of disappearing.
  it('keeps lint findings on fields without a review row', () => {
    const { borehole } = adaptBorehole(
      base({
        stratigraphy: [
          { depth_from_m: 0, depth_to_m: 2 },
          { depth_from_m: 2.4, depth_to_m: 5 },
        ],
        lint: [
          { path: 'stratigraphy[1].depth_from_m', severity: 'warning', message: 'Gap between layers at 2.00–2.40 m' },
          { path: 'stratigraphy[1].thickness_m', severity: 'warning', message: 'Thickness ≠ to − from' },
          { path: 'tbm_engineering_assessment.risk', severity: 'error', message: 'Risk not computed' },
          { path: 'metadata.borehole_id', severity: 'warning', message: 'ID printed twice' },
        ],
      }),
    );
    const lint = (key: string) => borehole.values.find((v) => v.key === key)?.lint;
    expect(lint(K.bottom(1))).toEqual({ severity: 'warning', message: 'Gap between layers at 2.00–2.40 m' });
    expect(lint(K.bottom(2))).toEqual({ severity: 'warning', message: 'Thickness ≠ to − from' });
    expect(lint(K.boreholeId)).toEqual({ severity: 'error', message: 'Risk not computed · ID printed twice' });
    expect(boreholeStatus(borehole)).toBe('attention');
  });
});

// c14: the Completeness panel's LINT list was always empty in API mode.
describe('documentLint', () => {
  it("lists every linted value of a document's boreholes", () => {
    const { borehole } = adaptBorehole(record);
    expect(documentLint([borehole], 'doc_7f3a')).toEqual([
      { severity: 'error', boreholeId: 'NM-121', message: 'Log bottom 4.8 m ≠ final depth 18.0 m' },
      { severity: 'error', boreholeId: 'NM-121', message: 'Increments 4 + 5 = 9 ≠ N 8' },
    ]);
    expect(documentLint([borehole], 'other')).toEqual([]);
  });
});
