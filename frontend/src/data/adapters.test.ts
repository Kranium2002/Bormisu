import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { K } from '../domain/keys';
import { pageUsageText } from '../domain/pages';
import { displayStatus } from '../domain/status';
import type { Borehole } from '../domain/types';
import { contractErrors } from '../test/contract/schema';
import { fixture } from '../test/contract/wire';
import {
  adaptBorehole,
  adaptCrsCandidates,
  adaptDocument,
  adaptHealth,
  documentLint,
  valueAt,
  type PatchTarget,
  type WireBorehole,
  type WireBoreholeList,
  type WireCrsCandidate,
  type WireDocumentList,
  type WireHealth,
} from './adapters';
import { buildStandardSheets } from '../export/standardXlsx';
import { patchActions } from './apiSource';

const hl01 = () => fixture<WireBorehole>('borehole');
const list1 = () => fixture<WireBoreholeList>('boreholes-page-1');
const kr01 = () => fixture<WireBoreholeList>('boreholes-page-2').boreholes[0];
const cases = () => fixture<WireBorehole[]>('boreholes-cases');
const caseOf = (id: string) => cases().find((r) => r.metadata.borehole_id === id) as WireBorehole;
const val = (b: Borehole, key: string) => b.values.find((v) => v.key === key);

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('adaptBorehole: identity, position and metadata', () => {
  it('maps the record as sent', () => {
    const { borehole: b } = adaptBorehole(hl01());
    expect(b).toMatchObject({
      uid: 'bh_01JFICT00000000000000HL01', id: 'HL-01', documentId: 'doc_01JFICT0000000000000000D1',
      sourceFile: 'harbourline_GI_report.pdf', project: 'Harbourline Tunnel (fictional)', revision: 4,
      reviewStatus: 'in_review', openClarifications: 0, lat: -36.8441, lng: 174.7682, onMap: true, unplottedReason: null,
      finalDepth: 15.5, logBottom: 15.5, rockHead: 9, pages: [4, 5], primaryPage: 4,
      crs: { name: 'NZTM2000', code: 'EPSG:2193', status: 'stated' },
    });
    expect(b.meta).toEqual({
      aliases: ['HL 01', 'BH1'], elevationDatum: 'NZVD2016', depthOrigin: 'ground', depthSource: 'printed',
      xRaw: '1757412.3 mE', yRaw: '5920530.8 mN', axisLabelsRaw: 'E, N', localX: 1757412.3, localY: 5920530.8,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('requires a uid: a record without one is an adapter error', () => {
    const rec = hl01() as Partial<WireBorehole>;
    delete rec.uid;
    expect(() => adaptBorehole(rec as WireBorehole)).toThrow(/without uid/);
  });

  it('turns the new metadata fields into values', () => {
    const { borehole: b } = adaptBorehole(hl01());
    const pick = (key: string) => {
      const v = val(b, key);
      return v && [v.field, v.value, v.unit];
    };
    expect(pick(K.boreholeName)).toEqual(['BoreholeName', 'North portal borehole 1', '']);
    expect(pick(K.locationName)).toEqual(['LocationName', 'Harbourline north portal (fictional)', '']);
    expect(pick(K.country)).toEqual(['Country', 'New Zealand', '']);
    expect(pick(K.projectId)).toEqual(['ProjectID', 'HL-2024-07', '']);
    expect(pick(K.client)).toEqual(['Client', 'Example Transport Agency (fictional)', '']);
    expect(pick(K.drillingDate)).toEqual(['DrillingDate', '12/03/2024', '']);
    expect(pick(K.startDate)).toEqual(['StartDate', '2024-03-12', '']);
    expect(pick(K.method)).toEqual(['DrillingMethod', 'Rotary core, HQ3', '']);
    expect(pick(K.finalDepth)).toEqual(['BoreholeDepth', '15.50', 'm']);
    expect(pick(K.boreholeLength)).toEqual(['BoreholeLength', '15.60', 'm']);
    expect(pick(K.inclination)).toEqual(['Inclination', '85', '°']);
    expect(pick(K.elevation)).toEqual(['Surface Elevation', '12.40', 'm NZVD2016']);
    expect(pick(K.elevationDatum)).toEqual(['ElevationDatum', 'NZVD2016', '']);
    expect(pick(K.depthOrigin)).toEqual(['DepthOrigin', 'ground', '']);
    expect(pick(K.casing)).toEqual(['Casing', 'HW casing to 3.0 m', '']);
    expect(pick(K.rockHead)).toEqual(['RockHead', '9.00', 'm']);
    expect(pick(K.notes)).toEqual(['Notes', 'Fictional record for frontend tests.', '']);
  });

  it('shows depths and levels with at least two decimals but never rounds away what the server sent', () => {
    const rec = hl01();
    rec.metadata.surface_elevation_mASL = 3.425;
    rec.metadata.borehole_depth_m = 15.125;
    rec.stratigraphy[0].depth_to_m = 1.205;
    rec.groundwater[0].depth_m = 2.105;
    const { borehole: b } = adaptBorehole(rec);
    expect(val(b, K.elevation)?.value).toBe('3.425');
    expect(val(b, K.finalDepth)?.value).toBe('15.125');
    expect(val(b, K.bottom(1))?.value).toBe('1.205');
    expect(val(b, K.gw(0))?.value).toBe('2.105');
    // Whole and one-decimal numbers keep the two-decimal display.
    expect(val(b, K.rockHead)?.value).toBe('9.00');
    expect(val(b, K.bottom(2))?.value).toBe('4.50');
    // The export reads the number from the value: it must be the server's number.
    const sheets = buildStandardSheets([{ ...b, values: b.values.map((v) => ({ ...v, status: 'approved' as const })) }], { includeUnreviewed: false });
    expect(JSON.stringify(sheets)).toContain('3.425');
    expect(JSON.stringify(sheets)).toContain('15.125');
  });

  it('takes the rock head only from rock_head_m, never from the lithology', () => {
    const rec = hl01();
    rec.rock_head_m = null;
    delete rec.provenance.rock_head_m;
    const { borehole: b } = adaptBorehole(rec);
    expect(b.rockHead).toBeNull();
    expect(val(b, K.rockHead)).toBeUndefined();
  });
});

describe('adaptBorehole: values and provenance', () => {
  it('maps review states: approved, flagged, unreviewed, edited, not in source, illegible', () => {
    const { borehole: b } = adaptBorehole(hl01());
    expect(val(b, K.boreholeId)).toMatchObject({ status: 'approved', state: 'ok', method: 'Read', confidence: 0.99, page: 4 });
    expect(val(b, K.lithology(2))).toMatchObject({ status: 'flagged', flag: 'Colour unclear on the scan' });
    expect(val(b, K.boreholeName)).toMatchObject({ status: 'unreviewed', state: 'ok' });
    expect(val(b, K.spt(2))).toMatchObject({ method: 'Edited', status: 'approved', value: 'N = 32', aiValue: '23' });
    expect(val(b, K.endDate)).toMatchObject({ value: '', state: 'not in source', status: 'approved', hasProvenance: true });
    expect(val(b, K.contractor)).toMatchObject({ value: '', state: 'illegible', method: 'OCR', confidence: null, raw: 'Dr?ll?ng Co' });
    expect(val(b, K.rockHead)).toMatchObject({ method: 'Derived', aiValue: '9.00', value: '9.00' });
  });

  it('maps methods exactly and keeps a null confidence null', () => {
    const { borehole: b } = adaptBorehole(hl01());
    expect(val(b, K.country)).toMatchObject({ method: 'Guessed', confidence: 0.6, page: null, box: null });
    expect(val(b, K.startDate)?.method).toBe('Derived');
    expect(val(b, K.finalDepth)).toMatchObject({ method: 'OCR', confidence: 0.93 });
    expect(val(b, K.depthOrigin)).toMatchObject({ method: 'Derived', confidence: null });
    expect(val(b, K.lithology(3))).toMatchObject({ method: 'OCR', confidence: null });
    expect(b.values.every((v) => v.confidence !== 0)).toBe(true);
    const mp = adaptBorehole(caseOf('MP-01')).borehole;
    expect(val(mp, K.finalDepth)).toMatchObject({ value: '8.00', method: 'OCR', confidence: null });
  });

  it('carries handwriting readings and spreadsheet cells', () => {
    const { borehole: b } = adaptBorehole(hl01());
    expect(val(b, K.casing)?.readings).toEqual([
      { reader: 'ocr', text: 'HW casing to 3.0 m', confidence: 0.71 },
      { reader: 'vision', text: 'HW casing to 8.0 m', confidence: 0.64 },
    ]);
    expect(val(b, K.test(0))).toMatchObject({ cell: 'Lab!D7', page: null, box: null, raw: '12.5' });
    const hl02 = adaptBorehole(list1().boreholes[1]).borehole;
    expect(val(hl02, K.boreholeId)?.readings?.map((r) => r.text)).toEqual(['HL-02', 'HL-07']);
  });

  it('has a row for every provenance key, and every patch target is a provenance key', () => {
    for (const rec of [hl01(), ...list1().boreholes, kr01(), ...cases()]) {
      const { borehole: b, targets } = adaptBorehole(rec);
      const targeted = Object.values(targets).flatMap((t) => t.paths).sort();
      expect(targeted, rec.uid).toEqual(Object.keys(rec.provenance).sort());
      for (const [key, t] of Object.entries(targets)) {
        expect(val(b, key)?.hasProvenance, `${rec.uid} ${key}`).toBe(true);
        expect(t.paths.every((p) => p in rec.provenance)).toBe(true);
      }
    }
  });

  it('gives a provenance key without a dedicated row a generic row', () => {
    const { borehole: b, targets } = adaptBorehole(hl01());
    expect(val(b, 'stratigraphy[0].uscs_group')).toMatchObject({ label: 'USCS group', value: 'GW', group: 'layer', layer: 1, raw: 'GW' });
    expect(targets['stratigraphy[0].uscs_group']).toEqual({ paths: ['stratigraphy[0].uscs_group'], type: 'string' });
    const tq = adaptBorehole(caseOf('TQ-01')).borehole;
    expect(val(tq, 'metadata.coordinates.latitude')).toMatchObject({ label: 'Latitude', value: '1.2834', method: 'Derived', status: 'approved' });
  });

  it('gives a null field without provenance no row', () => {
    const hl02 = adaptBorehole(list1().boreholes[1]).borehole;
    for (const key of [K.notes, K.rockHead, K.startDate, K.casing, K.spt(1), K.gw(0)]) expect(val(hl02, key)).toBeUndefined();
    expect(val(hl02, K.lithology(2))).toMatchObject({ value: '', state: 'illegible' });
  });

  it('warns once about a non-null value without provenance and makes it unpatchable', () => {
    const { borehole: b, targets } = adaptBorehole(caseOf('MP-01'));
    expect(val(b, K.notes)).toMatchObject({
      value: 'Note printed without a provenance entry (fictional)', hasProvenance: false, method: null, confidence: null,
      page: null, box: null, status: 'unreviewed', state: 'ok',
    });
    expect(targets[K.notes]).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Backend bug.*bh_01JFICT00000000000000MP01.*metadata\.notes/);
  });

  it('warns for no other fixture record', () => {
    for (const rec of [hl01(), ...list1().boreholes, kr01(), ...cases()]) adaptBorehole(rec);
    expect(warn.mock.calls.map((c) => String(c[0]).match(/borehole (\S+)/)?.[1])).toEqual(['bh_01JFICT00000000000000MP01']);
  });

  it('reads wire values at provenance paths', () => {
    const rec = hl01();
    expect(valueAt(rec, 'stratigraphy[1].spt_increments')).toEqual([8, 14, 18]);
    expect(valueAt(rec, 'metadata.coordinates.crs_code')).toBe('EPSG:2193');
    expect(valueAt(rec, 'test_results[2].value')).toBeNull();
    expect(valueAt(rec, 'stratigraphy[9].depth_to_m')).toBeUndefined();
  });
});

describe('adaptBorehole: coordinates and CRS', () => {
  it('uses the pair the provenance has: local X / Y, else longitude / latitude', () => {
    const { borehole: b, targets } = adaptBorehole(hl01());
    expect(val(b, K.xy)).toMatchObject({ value: '1757412.3 / 5920530.8', raw: '1757412.3 mE / 5920530.8 mN', status: 'approved', page: 4 });
    expect(val(b, K.xy)?.box?.x).toBeCloseTo(0.12);
    expect(val(b, K.xy)?.box?.w).toBeCloseTo(0.3);
    expect(targets[K.xy]).toEqual({
      paths: ['metadata.coordinates.local_x', 'metadata.coordinates.local_y'], type: 'number',
      pair: ['metadata.coordinates.local_x', 'metadata.coordinates.local_y'], current: ['1757412.3', '5920530.8'],
    });
    const kr = adaptBorehole(kr01());
    expect(val(kr.borehole, K.xy)?.value).toBe('10.7522 / 59.9139');
    expect(kr.targets[K.xy].paths).toEqual(['metadata.coordinates.longitude', 'metadata.coordinates.latitude']);
  });

  it('targets only the coordinate paths the provenance has', () => {
    const { borehole: b, targets } = adaptBorehole(caseOf('TQ-02'));
    expect(val(b, K.xy)).toMatchObject({ value: '', state: 'not in source', cell: 'Metadata!I3' });
    expect(targets[K.xy].paths).toEqual(['metadata.coordinates.local_x']);
    expect(val(b, K.crs)).toBeUndefined();
  });

  it('uses crs_status, plotted and the unplotted reason codes from the server', () => {
    const got = cases().map((r) => {
      const b = adaptBorehole(r).borehole;
      return [b.id, b.onMap, b.unplottedReason, b.crs.status, b.lat, b.lng];
    });
    expect(got).toEqual([
      ['TQ-01', true, null, 'confirmed', 1.2834, 103.8607],
      ['TQ-02', false, 'no_coordinates', 'unknown', null, null],
      ['SP-01', false, 'crs_unknown', 'unknown', null, null],
      ['SP-02', false, 'crs_unconfirmed', 'inferred', null, null],
      // Coordinates exactly as sent: no (0, 0) special case; the server says they are implausible.
      ['OS-01', false, 'implausible', 'stated', 0.0004, 0.0002],
      ['MP-01', true, null, 'stated', 40.7003, -74.0121],
    ]);
  });

  it('never invents a CRS: name and code are what the server sent', () => {
    const inferred = adaptBorehole(caseOf('SP-02')).borehole;
    expect(inferred.crs).toEqual({ name: null, code: null, status: 'inferred' });
    expect(val(inferred, K.crs)).toBeUndefined();
    expect(inferred.meta).toMatchObject({ xRaw: '7.395.120', yRaw: '333.410', axisLabelsRaw: 'N, E', localX: 333410, localY: 7395120 });
    const local = adaptBorehole(caseOf('SP-01')).borehole;
    expect(local.crs).toEqual({ name: 'Malha local da obra', code: null, status: 'unknown' });
    expect(val(local, K.crs)).toMatchObject({ value: 'Malha local da obra', kind: 'crs' });
    expect(val(local, K.elevation)?.unit).toBe('m COTA');
  });

  it('shows an approved spreadsheet record as approved', () => {
    const b = adaptBorehole(caseOf('TQ-01')).borehole;
    expect(b.reviewStatus).toBe('approved');
    expect(b.values.every((v) => v.status === 'approved')).toBe(true);
    expect(val(b, K.boreholeId)).toMatchObject({ cell: 'Metadata!A2', page: null, box: null, method: 'Read', confidence: 1 });
    expect(b.pages).toEqual([]);
    expect(displayStatus(b)).toBe('approved');
  });
});

describe('adaptBorehole: layers, SPT, groundwater, samples and tests', () => {
  it('keeps DIN codes exactly as sent, case included; unknown codes and null stay', () => {
    const { borehole: b } = adaptBorehole(hl01());
    expect(b.layers.map((l) => [l.din, l.dinNotation])).toEqual([['A', 'A'], ['mG', 'mG, s'], ['Mg', 'Mg'], ['Sst', 'Sst']]);
    expect(adaptBorehole(kr01()).borehole.layers[0].din).toBe('Zx');
    expect(adaptBorehole(list1().boreholes[1]).borehole.layers[1]).toMatchObject({ din: null, dinNotation: null, lithology: '', lithologyAsPrinted: '(smudged)' });
    expect(adaptBorehole(caseOf('MP-01')).borehole.layers[0].din).toBeNull();
    expect(val(b, K.lithology(2))).toMatchObject({ din: 'mG', kind: 'lithology', raw: 'Medium GRAVEL, sandy, dense, grey (alluvium)' });
  });

  it('maps the layer fields and their values', () => {
    const { borehole: b } = adaptBorehole(hl01());
    expect(b.layers[1]).toMatchObject({
      n: 2, from: 1.2, to: 4.5, lithology: 'Medium gravel, sandy, dense, grey', stratigraphicName: 'Alluvial terrace deposits',
      engineeringSoilUnit: 'Unit 2: alluvium', geologicAge: 'Pleistocene', colour: 'grey', consistency: 'dense', moisture: 'wet',
      weathering: null, isCore: false, method: 'Read', confidence: 0.95,
    });
    expect(b.layers[2]).toMatchObject({ method: 'OCR', confidence: null });
    expect(b.layers[3]).toMatchObject({ isCore: true, tcr: 88, rqd: 45, weathering: 'moderately weathered' });
    const fields = (n: number) => b.values.filter((v) => v.layer === n).map((v) => `${v.field}=${v.value}`);
    expect(fields(2)).toEqual([
      'DepthTo=4.50', 'Lithology/SoilName=Medium gravel, sandy, dense, grey', 'StratigraphicName=Alluvial terrace deposits',
      'EngineeringSoilUnit=Unit 2: alluvium', 'GeologicAge=Pleistocene', 'Colour=grey', 'Consistency=dense', 'Moisture=wet',
      'Core=no', 'SPT=N = 32',
    ]);
    expect(fields(4)).toEqual([
      'DepthTo=15.50', 'Lithology/SoilName=Sandstone, moderately weathered, weak', 'GeologicAge=Miocene',
      'Weathering=moderately weathered', 'Core=yes', 'SPT=N = 41', 'TotalCoreRecovery=88', 'RQD=45', 'UCS=12.5',
    ]);
    expect(val(b, K.ucs(4))).toMatchObject({ unit: 'MPa', group: 'layer', layer: 4 });
  });

  it('keeps SPT raw, N, refusal, increments and depth as sent; a missing depth is never invented', () => {
    const { borehole: b, targets } = adaptBorehole(hl01());
    expect(b.layers[1].spt).toEqual({ raw: '8, 14, 18 (N=32)', depth: 3, refusal: false, increments: [8, 14, 18], n: 32, incrementMm: 150 });
    expect(val(b, K.spt(2))?.label).toBe('SPT @ 3.00 m');
    expect(b.layers[2].spt).toEqual({ raw: '50 for 75 mm', depth: 6, refusal: true, increments: [50], blows: 50, penetrationCm: 7.5, incrementMm: 75 });
    expect(val(b, K.spt(3))).toMatchObject({ label: 'SPT @ 6.00 m', value: 'refusal · 50 blows / 7.5 cm', refusal: true, raw: '50 for 75 mm' });
    expect(targets[K.spt(3)]).toEqual({ paths: ['stratigraphy[2].spt_raw'], type: 'string' });
    expect(b.layers[3].spt?.depth).toBeNull();
    expect(val(b, K.spt(4))).toMatchObject({ label: 'SPT (depth not stated)', value: 'N = 41' });
    expect(targets[K.spt(4)]).toEqual({ paths: ['stratigraphy[3].spt_n_value'], type: 'spt' });
    const mp = adaptBorehole(caseOf('MP-01')).borehole;
    expect(val(mp, K.spt(2))?.label).toBe('SPT (depth not stated)');
  });

  it('keeps every groundwater reading; a reading without depth keeps its elevation', () => {
    const { borehole: b, targets } = adaptBorehole(hl01());
    expect(b.groundwater).toEqual([
      { type: 'strike', depth: 2.1, elevation: null, date: '2024-03-12', raw: 'Water struck at 2.10 m', key: K.gw(0) },
      { type: 'rest', depth: 1.6, elevation: null, date: '2024-03-13', raw: 'Standing level 1.60 m', key: K.gw(1) },
      { type: 'standpipe', depth: null, elevation: 10.75, date: '2024-04-01', raw: 'Piezometer RL 10.75', key: K.gw(2) },
      { type: 'other', depth: null, elevation: null, date: null, raw: 'Dry on completion of casing', key: K.gw(3) },
    ]);
    expect(b.values.filter((v) => v.group === 'groundwater').map((v) => [v.key, v.label, v.value, v.unit])).toEqual([
      [K.gw(0), 'GW strike', '2.10', 'm bgl'],
      [K.gw(1), 'GW rest level', '1.60', 'm bgl'],
      ['groundwater[2].elevation_m', 'GW standpipe elevation', '10.75', 'm'],
    ]);
    expect(Object.values(targets).flatMap((t) => t.paths).some((p) => p.includes('water_table'))).toBe(false);
  });

  it('turns samples and test results into values', () => {
    const { borehole: b } = adaptBorehole(hl01());
    expect(b.samples).toEqual([
      { name: 'U1', typeCode: 'U100', from: 2, to: 2.45, key: K.sampleName(0) },
      { name: 'C3', typeCode: 'core', from: 10, to: 10.3, key: K.sampleName(1) },
    ]);
    expect(b.values.filter((v) => v.group === 'sample').map((v) => [v.field, v.value, v.index])).toEqual([
      ['SampleName', 'U1', 0], ['SampleDepth', '2.00', 0], ['SampleDepthTo', '2.45', 0],
      ['SampleName', 'C3', 1], ['SampleDepth', '10.00', 1], ['SampleDepthTo', '10.30', 1],
    ]);
    expect(b.values.filter((v) => v.group === 'test').map((v) => [v.key, v.field, v.value, v.unit, v.index])).toEqual([
      [K.test(0), 'UCS', '12.5', 'MPa', 0],
      [K.test(1), 'Watercontent', '18.2', '%', 1],
      [K.test(2), 'LiquidLimit', '', '%', 2],
    ]);
    expect(val(b, K.test(2))?.note).toBe('qualifier as printed: NIL');
    expect(b.testResults[1]).toEqual({ name: 'Watercontent', value: 18.2, qualifier: null, unit: '%', sampleName: 'U1', depth: 2.2, key: K.test(1) });
  });

  it('orders values for review: borehole, groundwater, layers, samples, tests', () => {
    const { borehole: b } = adaptBorehole(hl01());
    const rank = { borehole: 0, groundwater: 1, layer: 2, sample: 3, test: 4 };
    const groups = b.values.map((v) => rank[v.group]);
    expect(groups).toEqual([...groups].sort((x, y) => x - y));
    const layers = b.values.filter((v) => v.group === 'layer').map((v) => v.layer as number);
    expect(layers).toEqual([...layers].sort((x, y) => x - y));
    expect(b.values[0].key).toBe(K.boreholeId);
  });
});

describe('adaptBorehole: lint', () => {
  it('lands every backend finding on a review row', () => {
    const { borehole: b } = adaptBorehole(hl01());
    expect(val(b, K.finalDepth)?.lint?.severity).toBe('warning');
    // A layer's start depth is the boundary with the layer above.
    expect(val(b, K.bottom(2))?.lint?.message).toBe('Boundary at 4.50 m printed twice');
    expect(val(b, K.bottom(4))?.lint).toEqual({ severity: 'error', message: 'Thickness 6.40 m differs from 15.50 - 9.00' });
    expect(val(b, 'groundwater[2].elevation_m')?.lint?.message).toBe('Standpipe reading gives an elevation only');
    expect(val(b, K.test(0))?.lint?.severity).toBe('error');
    expect(documentLint([b], 'doc_01JFICT0000000000000000D1')).toHaveLength(5);
    expect(displayStatus(b)).toBe('attention');
    expect(adaptBorehole(caseOf('TQ-02')).borehole.values.find((v) => v.key === K.xy)?.lint?.message).toBe('No coordinates in the source');
    expect(adaptBorehole(caseOf('OS-01')).borehole.values.find((v) => v.key === K.xy)?.lint?.severity).toBe('error');
  });

  it('adds an SPT increment lint when the increments do not add up', () => {
    const rec = hl01();
    rec.stratigraphy[1].spt_increments = [8, 14, 17];
    expect(val(adaptBorehole(rec).borehole, K.spt(2))?.lint?.message).toBe('Increments 14 + 17 = 31 ≠ N 32');
  });
});

describe('adaptDocument', () => {
  const docs = () => fixture<WireDocumentList>('documents').documents;

  it('maps a document in review: pages with roles, usage, OCR, handwriting and duplicates', () => {
    const d = adaptDocument(docs()[0]);
    expect(d).toMatchObject({
      id: 'doc_01JFICT0000000000000000D1', name: 'harbourline_GI_report.pdf', project: 'Harbourline Tunnel (fictional)',
      status: 'needs_review', step: 2, openClarifications: 1, duplicateOf: null, error: null,
      counts: { boreholes: 2, layers: 6, spt: 3, groundwater: 4 },
      progress: { pagesTotal: 9, pagesClassified: 9, pagesOcrTotal: 5, pagesOcrDone: 5, boreholesExtracted: 2 },
      completeness: { listed: 3, missing: ['HL-03'], unexpected: [], lint: [], expectedIds: ['HL-01', 'HL-02', 'HL-03'] },
      reviewBoreholeUid: null,
    });
    expect(d.pages).toHaveLength(9);
    expect(d.pages[3]).toEqual({
      n: 4, type: 'log', role: 'log_sheet', used: true, unusedReason: null, boreholeIds: ['HL-01'], sheetLabel: 'SHEET 1 OF 2',
      handwriting: 'annotations', language: 'en', ocr: 'done', duplicateOf: null, classified: true,
    });
    expect(d.pages.map((p) => p.ocr)).toEqual(['skipped', 'skipped', 'failed', 'done', 'done', 'done', 'done', 'skipped', 'pending']);
    expect(d.pages[7].duplicateOf).toEqual({ documentId: 'doc_01JFICT0000000000000000D1', n: 6 });
    expect(d.pages.map(pageUsageText)).toEqual([
      'unused: cover page', 'unused: no borehole data', 'unused: site plan without coordinates', 'used: log sheet',
      'used: log continuation', 'used: log sheet', 'used: lab results', 'unused: duplicate of page 6', 'unused: core photographs',
    ]);
  });

  it('shows unclassified pages of a document being extracted as placeholders, with progress', () => {
    const d = adaptDocument(docs()[1]);
    expect(d).toMatchObject({ status: 'extracting', step: 1, project: '', progress: { pagesClassified: 3, pagesOcrDone: 1 } });
    expect(d.pages.map((p) => p.classified)).toEqual([true, true, true, false, false, false]);
    expect(d.pages[1]).toMatchObject({ handwriting: 'partial', language: 'no' });
    expect(pageUsageText(d.pages[4])).toBe('not classified yet');
  });

  it('reports failures, duplicates and queued documents', () => {
    const [, , failed, dup, queued] = docs().map(adaptDocument);
    expect(failed).toMatchObject({ status: 'failed', step: 0, error: 'The file could not be read as an image.', pages: [] });
    expect(dup).toMatchObject({ duplicateOf: 'doc_01JFICT0000000000000000D1', openClarifications: 2, error: null });
    expect(queued).toMatchObject({ status: 'queued', step: 0, pages: [], progress: null, error: null });
  });
});

describe('adaptCrsCandidates', () => {
  it('maps label, code, note, score, verdict, swap_axes and points (lon → lng)', () => {
    const c = adaptCrsCandidates(fixture<WireCrsCandidate[]>('crs-candidates'));
    expect(c.map((x) => [x.code, x.name, x.verdict, x.score, x.swapAxes, x.points.length])).toEqual([
      ['EPSG:31983', 'SIRGAS 2000 / UTM zone 23S', 'match', 0.92, true, 1],
      ['EPSG:29193', 'SAD69 / UTM zone 23S', 'shifted', 0.64, true, 1],
      ['EPSG:31984', 'SIRGAS 2000 / UTM zone 24S', 'out_of_range', 0.08, false, 0],
      ['EPSG:32723', 'WGS 84 / UTM zone 23S', null, null, false, 1],
    ]);
    expect(c[0]).toMatchObject({ note: 'Printed order N, E: axes swapped', points: [{ uid: 'bh_01JFICT00000000000000LA02', lat: -23.5489, lng: -46.6388 }] });
    expect(c[2].note).toBeNull();
    expect(c[3].note).toBeNull();
  });
});

describe('adaptHealth', () => {
  it('maps live and demo health', () => {
    expect(adaptHealth(fixture<WireHealth>('health-live'))).toEqual({
      mode: 'live', status: 'ok', version: '1.0.0',
      providers: { ocr: true, classifier: true, extractor: true, chat: true, geocoder: true },
      upload: { maxMb: 200, extensions: ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.docx', '.xlsx', '.csv'] },
    });
    expect(adaptHealth(fixture<WireHealth>('health-demo'))).toMatchObject({ mode: 'demo', providers: { chat: false }, upload: { maxMb: 50 } });
  });
});

describe('patchActions', () => {
  const depth: PatchTarget = { paths: ['metadata.borehole_depth_m'], type: 'number' };
  const p = 'metadata.borehole_depth_m';

  it('sends set_state, then edit, then approve / flag / reset', () => {
    expect(patchActions({ status: 'approved' }, depth)).toEqual([{ path: p, action: 'approve' }]);
    expect(patchActions({ value: '18.5', method: 'Edited', status: 'approved', state: 'ok' }, depth)).toEqual([
      { path: p, action: 'set_state', state: 'ok' },
      { path: p, action: 'edit', value: 18.5 },
      { path: p, action: 'approve' },
    ]);
    expect(patchActions({ flag: 'datum unclear', status: 'flagged' }, depth)).toEqual([{ path: p, action: 'flag', reason: 'datum unclear' }]);
    expect(patchActions({ state: 'not in source', status: 'approved' }, depth)).toEqual([
      { path: p, action: 'set_state', state: 'not_in_source' },
      { path: p, action: 'approve' },
    ]);
  });

  it('undoes an approval or a flag with reset, and a state with set_state ok', () => {
    expect(patchActions({ status: 'unreviewed', flag: undefined }, depth)).toEqual([{ path: p, action: 'reset' }]);
    expect(patchActions({ state: 'ok', status: 'unreviewed' }, depth)).toEqual([
      { path: p, action: 'set_state', state: 'ok' },
      { path: p, action: 'reset' },
    ]);
  });

  it('sends numbers as numbers, ids and dates as typed, booleans as booleans, SPT N as a number', () => {
    expect(patchActions({ value: '0007' }, { paths: ['metadata.borehole_id'], type: 'string' })).toEqual([
      { path: 'metadata.borehole_id', action: 'edit', value: '0007' },
    ]);
    expect(patchActions({ value: '12/03/2024' }, { paths: ['metadata.drilling_date'], type: 'string' })[0].value).toBe('12/03/2024');
    expect(patchActions({ value: '18,5' }, depth)[0].value).toBe(18.5);
    expect(patchActions({ value: 'yes' }, { paths: ['stratigraphy[0].is_core'], type: 'boolean' })[0].value).toBe(true);
    expect(patchActions({ value: 'N = 9' }, { paths: ['stratigraphy[0].spt_n_value'], type: 'spt' })[0].value).toBe(9);
    expect(patchActions({ value: '' }, depth)[0].value).toBeNull();
  });

  it('splits an X / Y edit per path, also when only one coordinate is a provenance key and the other stays as it is', () => {
    const pair = ['metadata.coordinates.local_x', 'metadata.coordinates.local_y'] as const;
    expect(patchActions({ value: '512345 / 6123456', status: 'approved' }, { paths: [...pair], type: 'number', pair })).toEqual([
      { path: pair[0], action: 'edit', value: 512345 },
      { path: pair[1], action: 'edit', value: 6123456 },
      { path: pair[0], action: 'approve' },
      { path: pair[1], action: 'approve' },
    ]);
    expect(patchActions({ value: '512345.0 / 6123456' }, { paths: [pair[1]], type: 'number', pair, current: ['512345', ''] })).toEqual([
      { path: pair[1], action: 'edit', value: 6123456 },
    ]);
    expect(() => patchActions({ value: '512345' }, { paths: [...pair], type: 'number', pair })).toThrow(/both values/);
  });

  it('refuses an X / Y edit that changes the coordinate without a provenance entry instead of dropping it', () => {
    // TQ-02: only local_x has a provenance entry; local_y can't be saved.
    const { targets } = adaptBorehole(caseOf('TQ-02'));
    expect(() => patchActions({ value: '30512.4 / 29870.1' }, targets[K.xy])).toThrow(/Y can't be changed here.*metadata\.coordinates\.local_y/);
    // Y left as it is (empty) saves X alone.
    expect(patchActions({ value: '30512.4 /' }, targets[K.xy])).toEqual([{ path: 'metadata.coordinates.local_x', action: 'edit', value: 30512.4 }]);
  });

  it('builds bodies the contract accepts', () => {
    const bodies = [
      ...patchActions({ value: '18.5', status: 'approved', state: 'ok' }, depth),
      ...patchActions({ status: 'flagged', flag: 'x' }, depth),
      ...patchActions({ status: 'unreviewed' }, depth),
    ];
    for (const body of bodies) expect(contractErrors('ValuePatch', { ...body, if_revision: 3 })).toEqual([]);
  });
});
