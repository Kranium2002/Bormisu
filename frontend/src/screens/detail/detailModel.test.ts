import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import type { Borehole, Spt } from '../../domain/types';
import { exportScope } from '../../export/scope';
import { makeBorehole, makeLayer, makeMeta, makeValue } from '../../test/fixtures';
import {
  crsChip,
  excludedText,
  groundwaterRows,
  layerLint,
  layerRows,
  locationInfo,
  metadataRows,
  reviewedText,
  shown,
  unreviewedCount,
} from './detailModel';

const REFUSAL: Spt = { raw: '50/30', depth: 10.5, refusal: true, blows: 50, penetrationCm: 30 };
const BAD_N: Spt = { raw: '3,4,5 = 8', depth: 1.5, refusal: false, increments: [3, 4, 5], n: 8 };

/** TB-01 with a short log (ends 14.50, final depth 18.00) on two sheets, an SPT refusal and a lint. */
function shortLog(): Borehole {
  const b = makeBorehole({
    finalDepth: 18,
    logBottom: 14.5,
    rockHead: 11.2,
    layers: [
      makeLayer({ n: 1, from: 0, to: 8.2, spt: BAD_N }),
      makeLayer({ n: 2, from: 8.2, to: 14.5, spt: REFUSAL, lithologyAsPrinted: 'Gravel, sandy (as printed)', dinNotation: "G, s'", stratigraphicName: 'Fictional Formation' }),
    ],
  });
  b.values = [
    makeValue({ key: K.finalDepth, value: '18.00', unit: 'm', lint: { severity: 'error', message: 'Log bottom 14.50 m ≠ final depth 18.00 m' } }),
    makeValue({ key: K.rockHead, value: '11.20', unit: 'm', method: 'Derived', formula: 'top of first rock layer (layer 2)' }),
    makeValue({ key: K.elevation, value: '241.35', unit: 'm' }),
    makeValue({ key: K.xy, value: '512000 / 5540000' }),
    makeValue({ key: K.crs, value: 'Fictional grid', kind: 'crs' }),
    makeValue({ key: K.notes, value: '', state: 'not in source', page: 7 }),
    makeValue({ key: K.gw(0), group: 'groundwater', raw: 'GW 3,10', value: '3.10', unit: 'm bgl' }),
    makeValue({ key: K.lithology(1), group: 'layer', layer: 1, value: 'Silt', raw: 'Silt (as printed)', page: 7 }),
    makeValue({ key: K.spt(1), group: 'layer', layer: 1, raw: BAD_N.raw, value: 'N = 8', spt: BAD_N, lint: { severity: 'error', message: 'Increments 4 + 5 = 9 ≠ N 8' }, page: 7 }),
    makeValue({ key: K.lithology(2), group: 'layer', layer: 2, value: 'Gravel, sandy', raw: 'Gravel, sandy (as printed)', page: 8 }),
    makeValue({ key: K.spt(2), group: 'layer', layer: 2, raw: '50/30', value: 'refusal · 50 blows / 30 cm', spt: REFUSAL, refusal: true, page: 8 }),
    makeValue({ key: K.tcr(2), group: 'layer', layer: 2, value: '74', unit: '%', page: 8 }),
  ];
  return b;
}

const row = (b: Borehole, label: string) => metadataRows(b).find((r) => r.label === label);

describe('shown', () => {
  it('joins value and unit, and shows states in grey italics', () => {
    expect(shown(makeValue({ key: 'k', value: '18.00', unit: 'm' }))).toEqual({ text: '18.00 m', missing: false });
    expect(shown(makeValue({ key: 'k', value: '', state: 'not in source' }))).toEqual({ text: 'not in source', missing: true });
    expect(shown(makeValue({ key: 'k', value: '7', state: 'illegible' }))).toEqual({ text: 'illegible', missing: true });
    expect(shown(undefined)).toEqual({ text: 'not in source', missing: true });
  });
});

describe('metadataRows', () => {
  it('always lists the core rows; other fields only when the source has them', () => {
    expect(metadataRows(shortLog()).map((r) => r.label)).toEqual([
      'Final depth', 'Rock head', 'Surface elevation', 'X / Y', 'CRS', 'Remarks',
    ]);
  });

  it('shows the new fields with a value or a provenance entry, in order, never as 0', () => {
    const b = shortLog();
    b.values = [
      ...b.values,
      makeValue({ key: K.boreholeName, value: 'North well (fictional)' }),
      makeValue({ key: K.locationName, value: 'Test site' }),
      makeValue({ key: K.country, value: '', state: 'not in source' }),
      makeValue({ key: K.projectId, value: 'P-001' }),
      makeValue({ key: K.client, value: '', hasProvenance: false }),
      makeValue({ key: K.contractor, value: 'Test Drilling Ltd (fictional)' }),
      makeValue({ key: K.drillingDate, value: '2019-03-04' }),
      makeValue({ key: K.startDate, value: '2019-03-04' }),
      makeValue({ key: K.endDate, value: '2019-03-06' }),
      makeValue({ key: K.method, value: 'Rotary core' }),
      makeValue({ key: K.boreholeLength, value: '18.40', unit: 'm' }),
      makeValue({ key: K.inclination, value: '', hasProvenance: true }),
      makeValue({ key: K.casing, value: '0.00–3.00 m' }),
    ];
    expect(metadataRows(b).map((r) => [r.label, r.shown.text])).toEqual([
      ['Borehole name', 'North well (fictional)'],
      ['Location', 'Test site'],
      ['Country', 'not in source'],
      ['Project ID', 'P-001'],
      ['Contractor', 'Test Drilling Ltd (fictional)'],
      ['Final depth', '18.00 m'],
      ['Borehole length', '18.40 m'],
      ['Inclination', 'not in source'],
      ['Rock head', '11.20 m'],
      ['Surface elevation', '241.35 m'],
      ['X / Y', '512000 / 5540000'],
      ['CRS', 'Fictional grid'],
      ['Drilling date', '2019-03-04'],
      ['Start date', '2019-03-04'],
      ['End date', '2019-03-06'],
      ['Drilling method', 'Rotary core'],
      ['Casing', '0.00–3.00 m'],
      ['Remarks', 'not in source'],
    ]);
  });

  it('shows the elevation with its datum, or says the datum is not stated', () => {
    const b = shortLog();
    expect(row(b, 'Surface elevation')?.chips.map((c) => c.label)).toEqual(['DATUM NOT STATED']);
    b.values = [...b.values, makeValue({ key: K.elevationDatum, value: 'Fictional datum' })];
    expect(row(b, 'Surface elevation')).toMatchObject({ shown: { text: '241.35 m · datum Fictional datum' }, chips: [] });
    const fromMeta = { ...shortLog(), meta: makeMeta({ elevationDatum: 'MSL' }) };
    expect(row(fromMeta, 'Surface elevation')?.shown.text).toBe('241.35 m · datum MSL');
  });

  it('shows the depth origin from the metadata without a source icon', () => {
    const b = { ...shortLog(), meta: makeMeta({ depthOrigin: 'seabed' }) };
    expect(row(b, 'Depth origin')).toMatchObject({ shown: { text: 'seabed', missing: false }, source: 'none', key: null });
  });

  it('puts the coordinates as printed under X / Y', () => {
    const b = { ...shortLog(), meta: makeMeta({ xRaw: '512 000', yRaw: '5 540 000', axisLabelsRaw: 'E / N' }) };
    expect(row(b, 'X / Y')?.sub).toBe('as printed: 512 000 / 5 540 000 (E / N)');
    expect(row(shortLog(), 'X / Y')?.sub).toBeUndefined();
  });

  it('shows LINT on an unapproved lint, and drops it once approved', () => {
    const b = shortLog();
    expect(row(b, 'Final depth')?.chips.map((c) => c.label)).toEqual(['LINT']);
    b.values = b.values.map((v) => (v.key === K.finalDepth ? { ...v, status: 'approved' } : v));
    expect(row(b, 'Final depth')?.chips).toEqual([]);
  });

  it('marks the CRS by its status', () => {
    expect(row(shortLog(), 'CRS')?.chips.map((c) => c.label)).toEqual(['STATED']);
  });

  it('says "not in source" for a rock head the source does not state, with nothing to point at (uiv-2)', () => {
    const rock = row(makeBorehole(), 'Rock head');
    expect(rock?.shown).toEqual({ text: 'not in source', missing: true });
    expect(rock?.key).toBeNull();
    expect(rock?.method).toBeNull();
    expect(rock?.source).toBe('none');
  });

  it('fades the source icon for values that are not in the source; no icon without provenance', () => {
    const remarks = row(shortLog(), 'Remarks');
    expect(remarks?.shown).toEqual({ text: 'not in source', missing: true });
    expect(remarks?.source).toBe('dim');
    expect(row(shortLog(), 'Final depth')?.source).toBe('open');
    const b = shortLog();
    b.values = b.values.map((v) => (v.key === K.finalDepth ? { ...v, hasProvenance: false, method: null, page: null } : v));
    expect(row(b, 'Final depth')).toMatchObject({ source: 'none', method: null });
  });

  it('shows a flag as a chip', () => {
    const b = shortLog();
    b.values = b.values.map((v) => (v.key === K.crs ? { ...v, status: 'flagged', flag: 'check zone' } : v));
    expect(row(b, 'CRS')?.chips.map((c) => c.label)).toEqual(['STATED', 'FLAGGED']);
  });
});

describe('crsChip', () => {
  it('maps every CRS status to a chip', () => {
    const at = (status: Borehole['crs']['status']) => crsChip(makeBorehole({ crs: { name: 'x', code: null, status } })).label;
    expect([at('inferred'), at('confirmed'), at('stated'), at('unknown')]).toEqual(['INFERRED', 'CONFIRMED', 'STATED', 'UNKNOWN']);
  });
});

describe('reviewedText', () => {
  it('counts approved values, or says all are reviewed', () => {
    const b = makeBorehole();
    expect(reviewedText(b)).toBe(`0 of ${b.values.length} values reviewed`);
    b.values = b.values.map((v) => ({ ...v, status: 'approved' }));
    expect(reviewedText(b)).toBe('all values reviewed');
  });

  it('says what is still open when every value is approved', () => {
    const b = makeBorehole({ crs: { name: 'Fictional grid', code: 'EPSG:0001', status: 'inferred' } });
    b.values = b.values.map((v) => ({ ...v, status: 'approved' }));
    expect(reviewedText(b)).toBe('all values reviewed · CRS inferred, not stated');
    expect(reviewedText({ ...b, openClarifications: 2 })).toBe('all values reviewed · 2 open questions');
  });
});

describe('locationInfo', () => {
  it('names the CRS the position comes from with the backend label', () => {
    expect(locationInfo(makeBorehole({ lat: 48.7905, lng: 9.1835 }))).toEqual({
      text: '48.7905, 9.1835 · from ETRS89 / UTM zone 32N (stated)',
      tone: 'muted',
    });
    const inferred = makeBorehole({ crs: { name: 'Fictional grid', code: 'EPSG:0001', status: 'inferred' } });
    expect(locationInfo(inferred).tone).toBe('amber');
    expect(locationInfo(inferred).text).toContain('from inferred CRS Fictional grid, confirm in review');
  });

  it('explains a borehole that is not on the map with the reason label', () => {
    const b = makeBorehole({ lat: null, lng: null, onMap: false, unplottedReason: 'no_coordinates' });
    expect(locationInfo(b)).toEqual({ text: 'No coordinates in source: not on the map', tone: 'red' });
    const crs = makeBorehole({ lat: null, lng: null, onMap: false, unplottedReason: 'crs_unconfirmed' });
    expect(locationInfo(crs)).toEqual({ text: 'Coordinate system needs confirmation: not on the map', tone: 'amber' });
  });
});

describe('layerRows', () => {
  it('shows a refusal as printed with an R, never as N = 50', () => {
    const rows = layerRows(shortLog());
    expect(rows[1].spt).toMatchObject({ text: '50/30', refusal: true, key: K.spt(2), lint: false });
    expect(rows[1].spt?.title).toContain('Not N = 50');
    expect(rows[1].spt?.title).toContain('SPT at 10.50 m');
    expect(rows.map((r) => r.spt?.text)).not.toContain('N = 50');
  });

  it('says "depth not stated" for a test without a depth', () => {
    const b = shortLog();
    b.values = b.values.map((v) => (v.key === K.spt(2) && v.spt ? { ...v, spt: { ...v.spt, depth: null } } : v));
    const title = layerRows(b)[1].spt?.title ?? '';
    expect(title).toContain('SPT depth not stated.');
    expect(title).not.toMatch(/\d+\.\d\d m/);
  });

  it('marks an SPT whose increments do not add up', () => {
    expect(layerRows(shortLog())[0].spt).toMatchObject({ text: 'N = 8', refusal: false, lint: true });
  });

  it('fills range, English lithology, printed text, DIN notation, stratigraphy, TCR / RQD and the source key', () => {
    const r = layerRows(shortLog())[1];
    expect(r.range).toBe('8.20–14.50');
    expect(r.lithology).toEqual({ text: 'Gravel, sandy', missing: false });
    expect(r.printed).toBe('As printed: Gravel, sandy (as printed)');
    expect(r.din).toBe("G, s'");
    expect(r.strat).toBe('Fictional Formation');
    expect(r.tcr).toBe('74');
    expect(r.rqd).toBe('–');
    expect(r.sourceKey).toBe(K.lithology(2));
  });

  it('falls back to the DIN code, and a dash without stratigraphy', () => {
    const r = layerRows(makeBorehole())[1];
    expect(r.din).toBe('T');
    expect(r.strat).toBe('–');
    const noNotation = makeBorehole({ layers: [makeLayer({ n: 1, from: 0, to: 1, din: 'S', dinNotation: null })] });
    expect(layerRows(noNotation)[0].din).toBe('S');
    const none = makeBorehole({ layers: [makeLayer({ n: 1, from: 0, to: 1, din: null, dinNotation: null })] });
    expect(layerRows(none)[0].din).toBe('–');
  });

  it('has no SPT cell for a layer without a test', () => {
    expect(layerRows(makeBorehole())[0].spt).toBeNull();
  });
});

describe('layerLint', () => {
  it('suggests the next sheet when the log ends above the final depth', () => {
    expect(layerLint(shortLog())).toEqual({
      text: 'Log bottom 14.50 m ≠ final depth 18.00 m. Possibly a missing sheet 3.',
      severity: 'error',
    });
  });

  it('is null without an open lint on the final depth', () => {
    expect(layerLint(makeBorehole())).toBeNull();
  });

  it('DV-11-UI: counts only the sheets of the borehole’s own document', () => {
    const b = shortLog();
    b.values = [...b.values, makeValue({ key: K.tcr(1), group: 'layer', layer: 1, value: '80', page: 3, documentId: 'doc_FICTIONAL_LAB_0000000000001' })];
    expect(layerLint(b)?.text).toBe('Log bottom 14.50 m ≠ final depth 18.00 m. Possibly a missing sheet 3.');
  });
});

describe('groundwaterRows', () => {
  it('shows type, depth and the raw text', () => {
    expect(groundwaterRows(shortLog())).toEqual([
      { key: K.gw(0), type: 'Strike', depth: { text: '3.10 m bgl', missing: false }, raw: '“GW 3,10”', method: 'Read', confidence: 0.9, hasSource: true },
    ]);
  });

  it('never makes up a depth for a reading without one', () => {
    const b = makeBorehole({ groundwater: [{ type: 'other', depth: null, elevation: null, date: null, raw: 'dry', key: 'GW[7]' }] });
    expect(groundwaterRows(b)[0]).toMatchObject({ depth: { text: 'depth not stated', missing: true }, raw: '“dry”', hasSource: false });
  });
});

describe('export menu counts', () => {
  it('counts the unapproved values of every borehole in the same document', () => {
    const a = makeBorehole();
    const b = makeBorehole({ uid: 'bh_TEST0000000000000000000002', id: 'TB-02', values: a.values.map((v) => ({ ...v, status: 'approved' })) });
    const other = makeBorehole({ uid: 'bh_TEST0000000000000000000003', id: 'TB-03', documentId: 'doc_OTHER' });
    const scope = exportScope([a, b, other], a);
    expect(scope.map((x) => x.id)).toEqual(['TB-01', 'TB-02']);
    expect(unreviewedCount(scope)).toBe(a.values.length);
  });

  it('words the include switch', () => {
    expect(excludedText(30, false)).toBe('30 unreviewed values excluded');
    expect(excludedText(30, true)).toBe('30 unreviewed values included · file stamped DRAFT');
    expect(excludedText(0, false)).toBe('All values reviewed: nothing left out');
    expect(excludedText(272, false, 13)).toBe('272 unreviewed values in 13 boreholes excluded');
    expect(excludedText(1, true, 2)).toBe('1 unreviewed value in 2 boreholes included · file stamped DRAFT');
  });
});

describe('lint texts', () => {
  const own = (b: Borehole, key: string) =>
    b.values.map((v) => (v.key === key && v.lint ? { ...v, lint: { ...v.lint, client: true } } : v));

  it('the SPT hover names its lint; a lint the app added itself says so', () => {
    const b = shortLog();
    expect(layerRows(b)[0].spt?.title).toContain('Increments 4 + 5 = 9 ≠ N 8.');
    b.values = own(b, K.spt(1));
    expect(layerRows(b)[0].spt?.title).toContain('Increments 4 + 5 = 9 ≠ N 8 (checked by the app, not the backend).');
  });

  it('a LINT chip of the app’s own check says so', () => {
    const b = shortLog();
    b.values = own(b, K.finalDepth);
    expect(row(b, 'Final depth')?.chips).toEqual([
      { label: 'LINT', tone: 'red', title: 'Log bottom 14.50 m ≠ final depth 18.00 m (checked by the app, not the backend)' },
    ]);
  });

  it('an approved borehole whose only lint is the app’s own does not "need attention"', () => {
    const b = shortLog();
    b.values = own({ ...b, values: own(b, K.finalDepth) }, K.spt(1)).map((v) => ({ ...v, status: 'approved' as const }));
    expect(reviewedText(b)).toBe('all values reviewed');
  });
});
