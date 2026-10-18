import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import type { Alignment, AlignmentResult, BoreholeFilter, ResultSet } from '../domain/types';
import { EMPTY_FILTER } from '../store/mapDataSlice';
import { makeBorehole, makeLayer, makeValue } from '../test/fixtures';
import { areaM2, areaText, byId, groundLevel, isUnsure, orderedRecords, reportModel, selectionFacts, summaryRow, wgs84Text, type ReportSelection } from './reportModel';

const TODAY = new Date('2026-10-18T08:00:00Z');

const filter = (o: Partial<BoreholeFilter> = {}): BoreholeFilter => ({ ...EMPTY_FILTER, dinCodes: [], reviewStatus: [], ...o });

function resultSet(uids: string[], o: Partial<ResultSet> = {}): ResultSet {
  return { id: 'rs_TEST', count: uids.length, locatedCount: uids.length, unlocatedCount: 0, excludedUnreviewed: null, uids, bbox: null, area: null, definition: filter(), createdAt: '2026-10-18T08:00:00Z', ...o };
}

const A = makeBorehole({ uid: 'bh_A', id: 'BH-10', lat: 48.47123, lng: 7.94612 });
const B = makeBorehole({ uid: 'bh_B', id: 'BH-2', lat: 48.4701, lng: 7.9402 });

const alignment: Alignment = {
  id: 'aln_T', name: 'Trasse Nord', fileName: 'trasse.geojson', format: 'geojson', sourceCrs: 'EPSG:4326',
  parts: [[[7.94, 48.47], [7.95, 48.472]]], lengthM: 850, vertexCount: 2, partCount: 1, bbox: null, bufferM: 100, createdAt: '',
};
const lineResult = (hits: AlignmentResult['hits']): AlignmentResult => ({
  alignmentId: 'aln_T', bufferM: 100, includeUnreviewed: true, lengthM: 850, metricCrs: 'EPSG:32632', band: [], hits,
  excludedUnreviewed: 0, notOnMap: 2, resultSet: resultSet(hits.map((h) => h.uid)),
});
const hit = (uid: string, chainageM: number) => ({
  uid, id: uid, documentId: 'doc', project: null, depth: 6, reviewStatus: 'unreviewed' as const, crsStatus: 'stated', lat: 48.47, lng: 7.94, offsetM: 12.34, chainageM, side: 'left' as const,
});

describe('report rows', () => {
  it('WGS84 positions read with hemispheres and five decimals', () => {
    expect(wgs84Text(48.471234, 7.946121)).toBe('48.47123° N, 7.94612° E');
    expect(wgs84Text(-33.9, -70.65)).toBe('33.90000° S, 70.65000° W');
  });

  it('ground level is the stated value, never a default', () => {
    expect(groundLevel(A)).toBeNull();
    const withGl = makeBorehole({ values: [...A.values, makeValue({ key: K.elevation, value: '152.40', unit: 'm' })] });
    expect(groundLevel(withGl)).toBe(152.4);
    const illegible = makeBorehole({ values: [...A.values, makeValue({ key: K.elevation, value: '', state: 'illegible' })] });
    expect(groundLevel(illegible)).toBeNull();
  });

  it('a summary row marks what is not in the source, not reviewed or unsure', () => {
    const b = makeBorehole({
      lat: null,
      lng: null,
      onMap: false,
      unplottedReason: 'no_coordinates',
      values: [...A.values, makeValue({ key: K.elevation, value: '101.2', unit: 'm', confidence: 0.4 })],
    });
    const r = summaryRow('en', b, 3);
    expect(r.no).toBe(3);
    expect(r.wgs84.missing).toBe(true);
    expect(r.wgs84.text).toMatch(/^not on the map: /);
    expect(r.name).toMatchObject({ text: 'not in source', missing: true });
    expect(r.groundLevel.text).toContain('101.2 m');
    expect(r.groundLevel.unreviewed).toBe(true);
    expect(r.groundLevel.unsure).toBe(true);
    expect(r.finalDepth).toMatchObject({ text: '6.00 m', missing: false, unsure: false });
    expect(r.source).toEqual({ file: 'test_report.pdf', page: 1 });
    expect(r.line).toBeUndefined();
  });

  it('a line row carries chainage, offset and side', () => {
    const r = summaryRow('de', A, 1, { chainageM: 412.6, offsetM: 3.21, side: 'right' });
    expect(r.line).toEqual({ chainage: '413 m', offset: '3.2 m', side: 'Rechts' });
  });

  it('approved values are sure; low confidence, guesses and flags are not', () => {
    expect(isUnsure(makeValue({ key: 'x', confidence: 0.95 }))).toBe(false);
    expect(isUnsure(makeValue({ key: 'x', confidence: 0.5 }))).toBe(true);
    expect(isUnsure(makeValue({ key: 'x', confidence: 0.5, status: 'approved' }))).toBe(false);
    expect(isUnsure(makeValue({ key: 'x', status: 'flagged' }))).toBe(true);
    expect(isUnsure(makeValue({ key: 'x', value: '', state: 'not in source' }))).toBe(false);
  });
});

describe('selection', () => {
  it('a line lists its hits by chainage; others by ID in natural order', () => {
    const line: ReportSelection = { kind: 'line', resultSet: null, alignment, result: lineResult([hit('bh_B', 100), hit('bh_A', 400)]) };
    expect(orderedRecords(line, [A, B]).map((b) => b.uid)).toEqual(['bh_B', 'bh_A']);
    const set: ReportSelection = { kind: 'set', resultSet: resultSet(['bh_A', 'bh_B']) };
    expect(orderedRecords(set, [A, B]).map((b) => b.id)).toEqual(['BH-2', 'BH-10']);
    expect([A, B].sort(byId).map((b) => b.id)).toEqual(['BH-2', 'BH-10']);
  });

  it('a line says its name, length, distance, scope and what it could not check', () => {
    const { subtitle, facts } = selectionFacts('en', { kind: 'line', resultSet: null, alignment, result: lineResult([hit('bh_A', 1)]) }, 1);
    expect(subtitle).toBe('Planned line: Trasse Nord');
    expect(facts).toEqual(
      expect.arrayContaining([
        { label: 'Length', text: '850 m' },
        { label: 'Distance either side', text: '100 m' },
        { label: 'Review scope', text: 'unreviewed included' },
        { label: 'Not checked', text: '2 boreholes without a map position' },
      ]),
    );
  });

  it('an area gives its shape and size; a rectangle of about 1 × 1 km', () => {
    const area = { type: 'bbox' as const, bbox: [7.9, 48.45, 7.9135, 48.459] as [number, number, number, number] };
    expect(areaM2(area) / 1e6).toBeGreaterThan(0.9);
    expect(areaM2(area) / 1e6).toBeLessThan(1.1);
    expect(areaM2({ type: 'circle', center: [8, 48], radiusM: 100 })).toBeCloseTo(31415.9, 0);
    expect(areaText(8400)).toBe('8,400 m²');
    expect(areaText(246_378_420_000)).toBe('246,378.42 km²');
    expect(areaText(1_500_000, 'de')).toBe('1,50 km²');
    const { subtitle } = selectionFacts('en', { kind: 'area', resultSet: resultSet(['bh_A'], { area }), area }, 1);
    expect(subtitle).toMatch(/^Area: Rectangle, 0\.\d\d km²|^Area: Rectangle, 1\.\d\d km²/);
  });

  it('a result set says its filters, or "All boreholes" when it filters nothing', () => {
    expect(selectionFacts('en', { kind: 'set', resultSet: resultSet([]) }, 0).subtitle).toBe('All boreholes');
    const searched = selectionFacts('en', { kind: 'set', resultSet: resultSet([], { definition: filter({ search: 'BK-1', dinCodes: ['S', 'G'] }) }) }, 0);
    expect(searched.subtitle).toBe('Selection: Search “BK-1” · DIN S, G');
  });
});

describe('reportModel', () => {
  it('numbers boreholes in report order and gives each its layers with stratigraphy', () => {
    const strat = makeBorehole({
      uid: 'bh_S',
      id: 'BH-1',
      layers: [makeLayer({ n: 1, from: 0, to: 3, din: 'S', stratigraphicName: 'Quaternary' })],
      values: [...A.values.filter((v) => !v.key.startsWith('layer[2]')), makeValue({ key: K.strat(1), value: 'Quartär', status: 'approved' })],
    });
    const m = reportModel('en', { kind: 'set', resultSet: resultSet(['bh_S', 'bh_A']) }, [strat, A], { today: TODAY });
    expect(m.title).toBe('BOREHOLE REPORT');
    expect(m.date).toBe('2026-10-18');
    expect(m.summary.map((r) => [r.no, r.id])).toEqual([
      [1, 'BH-1'],
      [2, 'BH-10'],
    ]);
    expect(m.boreholes[0].layers[0].strat).toMatchObject({ text: 'Quartär', missing: false, unreviewed: false });
    // A layer whose record states no stratigraphy reads "not in source".
    expect(m.boreholes[1].layers[0].strat).toMatchObject({ text: 'not in source', missing: true });
    expect(m.boreholes[1].header.find((h) => h.label === 'Final depth')?.cell.text).toBe('6.00 m');
    expect(m.hasLine).toBe(false);
  });
});
