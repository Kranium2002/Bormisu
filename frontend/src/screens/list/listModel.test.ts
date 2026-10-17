/** LIST's model and the README_data fields on fictional boreholes: rows, cells, loading, grid and sort. */
import { describe, expect, it } from 'vitest';
import { countOf, crsName, fieldByKey, FIELDS, joined, NONE, range, valueText } from '../../domain/fields';
import { K } from '../../domain/keys';
import type { MapFeature } from '../../domain/types';
import { featureOf } from '../../store/testing';
import { makeBorehole, makeDocument, makeLayer, makeValue } from '../../test/fixtures';
import { allRows } from '../map/explore/resultsModel';
import { CELL_FAILED, CELL_LOADING, cellOf, gridOf, listRows, notOnMapText, recordsToLoad, sortKeyOf } from './listModel';

const DOC = makeDocument({ id: 'doc_TEST_A', name: 'alpha_report.pdf' });
const pin = (o: Parameters<typeof makeBorehole>[0]) => featureOf(makeBorehole({ documentId: DOC.id, ...o })) as MapFeature;
const field = (key: string) => fieldByKey.get(key)!;

describe('fields (README_data columns)', () => {
  it('every key is unique and grouped', () => {
    expect(new Set(FIELDS.map((f) => f.key)).size).toBe(FIELDS.length);
    expect(FIELDS.every((f) => f.group && f.label && f.min > 0)).toBe(true);
  });

  it('summaries: ranges, joined codes, counts; "–" for nothing in source', () => {
    expect(range([12, 28, 15], '%')).toBe('12–28 %');
    expect(range([3.1], 'm')).toBe('3.1 m');
    expect(range([null, undefined])).toBe(NONE);
    expect(joined(['T', 'U', 'T', '', null])).toBe('T · U');
    expect(countOf(2, 6)).toBe('2 of 6');
    expect(countOf(0, 0)).toBe(NONE);
  });

  it('borehole values by key with their unit; the CRS by name and code', () => {
    const b = makeBorehole({
      values: [makeValue({ key: K.client, value: 'Fictional Client' }), makeValue({ key: K.elevation, value: '35.7', unit: 'm' })],
    });
    expect(valueText(b, K.client)).toBe('Fictional Client');
    expect(valueText(b, K.elevation)).toBe('35.7 m');
    expect(valueText(b, K.country)).toBe(NONE);
    expect(crsName({ name: 'Fictional grid', code: 'EPSG:0001', status: 'stated' })).toBe('Fictional grid (EPSG:0001)');
    expect(crsName({ name: null, code: null, status: 'unknown' })).toBe(NONE);
  });

  it('layer columns summarise the layers', () => {
    const b = makeBorehole({
      layers: [makeLayer({ n: 1, from: 0, to: 2, din: 'T', rqd: 40 }), makeLayer({ n: 2, from: 2, to: 5.5, din: 'G', rqd: 80 })],
    });
    expect(field('layers.position').text(b).text).toBe('2');
    expect(field('layers.depth_to').text(b).text).toBe('0–5.5 m');
    expect(field('layers.din_code').text(b).text).toBe('T · G');
    expect(field('layers.rqd').text(b).text).toBe('40–80 %');
  });
});

describe('listModel', () => {
  const rows = allRows(
    [pin({ uid: 'bh_A', id: 'TB-01', project: 'Alpha Tunnel', finalDepth: 12.5 }), pin({ uid: 'bh_B', id: 'TB-02', project: 'Beta Line' })],
    [makeBorehole({ uid: 'bh_C', id: 'TB-03', documentId: null, onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' })],
    ['bh_C'],
    [DOC],
  );

  it('the header search narrows the rows by ID or project', () => {
    expect(listRows(rows, 'tb 02').map((r) => r.uid)).toEqual(['bh_B']);
    expect(listRows(rows, 'alpha').map((r) => r.uid)).toEqual(['bh_A']);
    expect(listRows(rows, '  ')).toHaveLength(3);
  });

  it('map-layer columns show at once; record columns load, or say they could not', () => {
    const [a] = rows;
    expect(cellOf(field('boreholes.borehole_depth'), a, undefined, undefined)).toMatchObject({ text: '12.50 m', state: 'ready' });
    expect(cellOf(field('boreholes.client'), a, undefined, 'loading')).toEqual({ text: CELL_LOADING, state: 'loading' });
    expect(cellOf(field('boreholes.client'), a, undefined, 'failed')).toEqual({ text: CELL_FAILED, state: 'failed' });
    expect(cellOf(field('boreholes.client'), a, makeBorehole({ uid: 'bh_A' }), undefined)).toMatchObject({ text: NONE, state: 'ready' });
    // A pin whose layer names no system: the CRS comes from the record, never "not in source" meanwhile.
    const unnamed = { ...a, crs: { name: null, code: null, status: 'inferred' as const } };
    expect(cellOf(field('boreholes.coordinate_system'), unnamed, undefined, 'loading').state).toBe('loading');
    expect(recordsToLoad([unnamed], [field('boreholes.coordinate_system')], new Set(), new Set()).documents).toEqual([DOC.id]);
  });

  it('asks for the records the shown rows need: once per document, single boreholes by uid', () => {
    const client = [field('boreholes.client')];
    expect(recordsToLoad(rows, [field('boreholes.borehole_depth')], new Set(), new Set())).toEqual({ documents: [], uids: [] });
    expect(recordsToLoad(rows, client, new Set(['bh_C']), new Set())).toEqual({ documents: [DOC.id], uids: [] });
    expect(recordsToLoad(rows, client, new Set(), new Set([`doc:${DOC.id}`]))).toEqual({ documents: [], uids: ['bh_C'] });
  });

  it('grid: equal shares never below the minimum; sort keys of the map-layer columns', () => {
    const g = gridOf([field('boreholes.borehole_depth')]);
    expect(g.template.split('minmax').length - 1).toBe(5);
    expect(g.minWidth).toBeGreaterThan(600);
    expect(sortKeyOf('boreholes.borehole_depth')).toBe('depth');
    expect(sortKeyOf('boreholes.client')).toBeNull();
  });

  it('counts the rows without a pin', () => {
    expect(notOnMapText(rows)).toBe('1 not on the map');
    expect(notOnMapText(rows.slice(0, 2))).toBe('');
  });
});
