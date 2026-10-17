// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/**
 * The sample source's queries with the backend's semantics, on tiny fictional boreholes: every filter
 * field, every area type, include_unreviewed and its excluded count, located / unlocated counts, the
 * bbox rule, map features and the gazetteer.
 */
import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import type { Borehole, BoreholeFilter } from '../domain/types';
import { makeBorehole, makeLayer, makeMeta, makeValue } from '../test/fixtures';
import { areaBbox, featuresOf, haversineM, inArea, inPolygon, matchesFilter, runResultSet, searchPlaces, toFeature } from './query';

const EMPTY: BoreholeFilter = {
  search: null, country: null, project: null, documentId: null, minDepth: null, maxDepth: null, dinCodes: [],
  lithologyMinDepth: null, hasSpt: null, hasGroundwater: null, reviewStatus: [], includeUnreviewed: true, area: null,
};
const f = (o: Partial<BoreholeFilter>): BoreholeFilter => ({ ...EMPTY, ...o });

/** Four fictional boreholes: A and B placed near (8, 50), C placed far east, D not placed. */
function fleet(): Borehole[] {
  const a = makeBorehole({
    uid: 'bh_FICT_A', id: 'FX-01', project: 'Fictional Quay', documentId: 'doc_FICT_1', reviewStatus: 'approved', lat: 50, lng: 8, finalDepth: 12,
    meta: makeMeta({ aliases: ['FX 1'] }),
    layers: [makeLayer({ n: 1, from: 0, to: 4, din: 'S' }), makeLayer({ n: 2, from: 4, to: 12, din: 'T', spt: { raw: '3,4,5 = 9', depth: 6, refusal: false, n: 9 } })],
    values: [makeValue({ key: K.boreholeId, value: 'FX-01' }), makeValue({ key: K.country, value: 'Example Land' }), makeValue({ key: K.locationName, value: 'North pier' })],
  });
  const b = makeBorehole({
    uid: 'bh_FICT_B', id: 'FX-02', project: 'Fictional Quay', documentId: 'doc_FICT_1', reviewStatus: 'in_review', lat: 50.01, lng: 8.01, finalDepth: 6,
    layers: [makeLayer({ n: 1, from: 0, to: 6, din: 'mG', spt: { raw: '50/10', depth: 3, refusal: true, blows: 50, penetrationCm: 10 } })],
    groundwater: [],
  });
  const c = makeBorehole({
    uid: 'bh_FICT_C', id: 'OT-01', project: 'Other Works', documentId: 'doc_FICT_2', reviewStatus: 'unreviewed', lat: -10, lng: 179.5, finalDepth: null,
    layers: [makeLayer({ n: 1, from: 0, to: 3, din: 'T' })],
  });
  const d = makeBorehole({
    uid: 'bh_FICT_0', id: 'FX-03', project: 'Fictional Quay', documentId: 'doc_FICT_1', reviewStatus: 'approved', lat: null, lng: null, onMap: false,
    unplottedReason: 'no_coordinates', finalDepth: 20, layers: [makeLayer({ n: 1, from: 0, to: 20, din: 'T' })],
  });
  return [a, b, c, d];
}

const ids = (bs: Borehole[], filter: BoreholeFilter) => bs.filter((b) => matchesFilter(b, filter)).map((b) => b.id);

describe('filters (the backend semantics)', () => {
  const bs = fleet();

  it('an empty filter with include_unreviewed matches everything', () => {
    expect(ids(bs, EMPTY)).toEqual(['FX-01', 'FX-02', 'OT-01', 'FX-03']);
  });

  it('search finds the ID, a printed ID, the location and the project, ignoring case; blank is no search', () => {
    expect(ids(bs, f({ search: 'fx-0' }))).toEqual(['FX-01', 'FX-02', 'FX-03']);
    expect(ids(bs, f({ search: 'FX 1' }))).toEqual(['FX-01']);
    expect(ids(bs, f({ search: 'north PIER' }))).toEqual(['FX-01']);
    expect(ids(bs, f({ search: 'other' }))).toEqual(['OT-01']);
    expect(ids(bs, f({ search: '   ' }))).toHaveLength(4);
  });

  it('country matches the stated country only (unknown never matches); project ignores case', () => {
    expect(ids(bs, f({ country: ' example land ' }))).toEqual(['FX-01']);
    expect(ids(bs, f({ country: 'Nowhere' }))).toEqual([]);
    expect(ids(bs, f({ project: 'fictional quay' }))).toEqual(['FX-01', 'FX-02', 'FX-03']);
  });

  it('document and depth range (a depth not stated never matches a bound)', () => {
    expect(ids(bs, f({ documentId: 'doc_FICT_2' }))).toEqual(['OT-01']);
    expect(ids(bs, f({ minDepth: 6, maxDepth: 12 }))).toEqual(['FX-01', 'FX-02']);
    expect(ids(bs, f({ minDepth: 13 }))).toEqual(['FX-03']);
    expect(ids(bs, f({ maxDepth: 100 }))).not.toContain('OT-01');
  });

  it('DIN codes (case-sensitive) on any layer; with lithologyMinDepth the layer must reach below it', () => {
    expect(ids(bs, f({ dinCodes: ['T'] }))).toEqual(['FX-01', 'OT-01', 'FX-03']);
    expect(ids(bs, f({ dinCodes: ['mG'] }))).toEqual(['FX-02']);
    expect(ids(bs, f({ dinCodes: ['MG'] }))).toEqual([]);
    expect(ids(bs, f({ dinCodes: ['T'], lithologyMinDepth: 10 }))).toEqual(['FX-01', 'FX-03']);
    expect(ids(bs, f({ dinCodes: ['T'], lithologyMinDepth: 12 }))).toEqual(['FX-03']);
  });

  it('has SPT (an N value or a refusal) and has groundwater, both ways', () => {
    expect(ids(bs, f({ hasSpt: true }))).toEqual(['FX-01', 'FX-02']);
    expect(ids(bs, f({ hasSpt: false }))).toEqual(['OT-01', 'FX-03']);
    expect(ids(bs, f({ hasGroundwater: false }))).toEqual(['FX-02']);
    expect(ids(bs, f({ hasGroundwater: true }))).toEqual(['FX-01', 'OT-01', 'FX-03']);
  });

  it('review status, and include_unreviewed false keeps approved boreholes only', () => {
    expect(ids(bs, f({ reviewStatus: ['in_review', 'unreviewed'] }))).toEqual(['FX-02', 'OT-01']);
    expect(ids(bs, f({ includeUnreviewed: false }))).toEqual(['FX-01', 'FX-03']);
  });

  it('areas: bbox, polygon with a hole, circle by distance; a borehole without a position is never in an area', () => {
    expect(ids(bs, f({ area: { type: 'bbox', bbox: [7.9, 49.9, 8.005, 50.1] } }))).toEqual(['FX-01']);
    // A bbox across the antimeridian (min_lon > max_lon).
    expect(ids(bs, f({ area: { type: 'bbox', bbox: [179, -11, -179, -9] } }))).toEqual(['OT-01']);
    const ring = [[7.9, 49.9], [8.1, 49.9], [8.1, 50.1], [7.9, 50.1], [7.9, 49.9]];
    const hole = [[8.005, 50.005], [8.02, 50.005], [8.02, 50.02], [8.005, 50.02], [8.005, 50.005]];
    expect(ids(bs, f({ area: { type: 'polygon', polygon: { type: 'Polygon', coordinates: [ring] } } }))).toEqual(['FX-01', 'FX-02']);
    expect(ids(bs, f({ area: { type: 'polygon', polygon: { type: 'Polygon', coordinates: [ring, hole] } } }))).toEqual(['FX-01']);
    // FX-02 is about 1.33 km from FX-01.
    expect(ids(bs, f({ area: { type: 'circle', center: [8, 50], radiusM: 1000 } }))).toEqual(['FX-01']);
    expect(ids(bs, f({ area: { type: 'circle', center: [8, 50], radiusM: 1500 } }))).toEqual(['FX-01', 'FX-02']);
  });
});

describe('geometry', () => {
  it('haversine distance in m', () => {
    expect(haversineM([0, 0], [0, 1])).toBeCloseTo(111_195, -1);
    expect(haversineM([8, 50], [8, 50])).toBe(0);
  });

  it('point in polygon and areas', () => {
    const square = [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]];
    expect(inPolygon(1, 1, square)).toBe(true);
    expect(inPolygon(3, 1, square)).toBe(false);
    expect(inArea(1, 1, { type: 'bbox', bbox: [0, 0, 2, 2] })).toBe(true);
    expect(inArea(1, 3, { type: 'bbox', bbox: [0, 0, 2, 2] })).toBe(false);
  });

  it('the bbox of an area: as given, the polygon bounds, the circle sized like the backend', () => {
    expect(areaBbox({ type: 'bbox', bbox: [1, 2, 3, 4] })).toEqual([1, 2, 3, 4]);
    expect(areaBbox({ type: 'polygon', polygon: { type: 'Polygon', coordinates: [[[1, 5], [3, 2], [2, 7], [1, 5]]] } })).toEqual([1, 2, 3, 7]);
    const [minLon, minLat, maxLon, maxLat] = areaBbox({ type: 'circle', center: [0, 0], radiusM: 111_320 });
    expect([minLon, minLat, maxLon, maxLat].map((x) => Number(x.toFixed(6)))).toEqual([-1, -1, 1, 1]);
  });
});

describe('result sets', () => {
  const bs = fleet();

  it('counts located and unlocated members, orders them by uid and takes the bbox of the located ones', () => {
    const rs = runResultSet(bs, f({ project: 'Fictional Quay' }), 'rs_1', '2026-10-17T00:00:00Z');
    expect(rs).toMatchObject({
      id: 'rs_1', count: 3, locatedCount: 2, unlocatedCount: 1, excludedUnreviewed: 0,
      uids: ['bh_FICT_0', 'bh_FICT_A', 'bh_FICT_B'], bbox: [8, 50, 8.01, 50.01], area: null, createdAt: '2026-10-17T00:00:00Z',
    });
    expect(rs.definition).toEqual(f({ project: 'Fictional Quay' }));
  });

  it('include_unreviewed false leaves the unapproved matches out and counts them', () => {
    const rs = runResultSet(bs, f({ project: 'Fictional Quay', includeUnreviewed: false }), 'rs_2', 'now');
    expect(rs).toMatchObject({ count: 2, excludedUnreviewed: 1, uids: ['bh_FICT_0', 'bh_FICT_A'], locatedCount: 1, unlocatedCount: 1, bbox: [8, 50, 8, 50] });
  });

  it('without a located member the bbox is the area, echoed with the set; without either it is null', () => {
    const area = { type: 'circle' as const, center: [100, 0] as [number, number], radiusM: 500 };
    const rs = runResultSet(bs, f({ area }), 'rs_3', 'now');
    expect(rs).toMatchObject({ count: 0, uids: [], area });
    expect(rs.bbox).toEqual(areaBbox(area));
    expect(runResultSet(bs, f({ search: 'nothing like it' }), 'rs_4', 'now').bbox).toBeNull();
    expect(runResultSet(bs, f({ search: 'FX-03' }), 'rs_5', 'now')).toMatchObject({ count: 1, locatedCount: 0, unlocatedCount: 1, bbox: null });
  });

  it('keeps a snapshot: later changes to the filter object do not change the stored set', () => {
    const filter = f({ dinCodes: ['T'] });
    const rs = runResultSet(bs, filter, 'rs_6', 'now');
    filter.dinCodes.push('S');
    expect(rs.definition.dinCodes).toEqual(['T']);
  });
});

describe('map features', () => {
  it('carry what a pin needs, only for placed boreholes; attention follows the borehole', () => {
    const bs = fleet();
    const flagged = { ...bs[1], values: bs[1].values.map((v, i) => (i === 0 ? { ...v, status: 'flagged' as const } : v)) };
    expect(featuresOf([bs[0], flagged, bs[3]]).map((x) => [x.id, x.attention])).toEqual([['FX-01', false], ['FX-02', true]]);
    expect(toFeature(bs[2])).toEqual({
      uid: 'bh_FICT_C', id: 'OT-01', project: 'Other Works', documentId: 'doc_FICT_2', lat: -10, lng: 179.5, depth: null,
      reviewStatus: 'unreviewed', crsStatus: 'stated', revision: 1, attention: false, openClarifications: 0,
    });
  });
});

describe('gazetteer', () => {
  it('lists uploaded project sites first, with their borehole counts', () => {
    const places = searchPlaces(fleet(), 'quay');
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ label: 'Fictional Quay project site (uploaded)', source: 'uploaded', kind: 'project_site', boreholeCount: 2 });
  });

  it('finds fictional towns ignoring case and accents; one holds no borehole; an unknown place is []', () => {
    expect(searchPlaces(fleet(), 'MAINAU-SUD').map((p) => [p.label, p.source])).toEqual([['Mainau-Süd (fictional town)', 'geocoder']]);
    expect(searchPlaces(fleet(), 'lindenfurt')).toMatchObject([{ boreholeCount: 0, source: 'geocoder' }]);
    expect(searchPlaces(fleet(), 'Atlantis')).toEqual([]);
  });
});
