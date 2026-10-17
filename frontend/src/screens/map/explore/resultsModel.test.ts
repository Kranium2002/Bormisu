/** RESULTS table model (fictional boreholes): rows with and without a result set, sorting, pages, the CRS column and the summaries. */
import { describe, expect, it } from 'vitest';
import type { MapFeature, ResultSet } from '../../../domain/types';
import { featureOf } from '../../../store/testing';
import { makeBorehole, makeDocument } from '../../../test/fixtures';
import {
  allRows,
  crsColumn,
  depthCell,
  nextSort,
  PAGE_SIZE,
  pageCount,
  pageOf,
  pageOfUid,
  resultSetRows,
  resultSetSummary,
  sortRows,
  type ResultRow,
} from './resultsModel';

const DOC = makeDocument({ id: 'doc_TEST_A', name: 'alpha_report.pdf' });
const DOC2 = makeDocument({ id: 'doc_TEST_B', name: 'beta_report.pdf' });

const A = makeBorehole({ uid: 'bh_A', id: 'TB-10', documentId: DOC.id, finalDepth: 12, project: 'Bravo (fictional)' });
const B = makeBorehole({ uid: 'bh_B', id: 'TB-2', documentId: DOC.id, finalDepth: null, project: 'Alpha (fictional)', reviewStatus: 'approved' });
const C = makeBorehole({ uid: 'bh_C', id: 'TB-1', documentId: DOC2.id, finalDepth: 3.5, project: '', reviewStatus: 'in_review' });
const OFF = makeBorehole({
  uid: 'bh_OFF', id: 'TB-9', documentId: DOC2.id, onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates',
  crs: { name: null, code: null, status: 'unknown' },
});
const feat = (b: typeof A): MapFeature => featureOf(b)!;

describe('rows', () => {
  it('lists every pin (from the light features) and every unplotted record, each with its document name', () => {
    const rows = allRows([feat(A), feat(B)], [OFF], [OFF.uid], [DOC, DOC2]);
    expect(rows.map((r) => [r.id, r.onMap, r.document])).toEqual([
      ['TB-10', true, 'alpha_report.pdf'],
      ['TB-2', true, 'alpha_report.pdf'],
      ['TB-9', false, 'beta_report.pdf'],
    ]);
    // A pin without its full record only knows the CRS status, not its name.
    expect(rows[0].crs).toEqual({ name: null, code: null, status: 'stated' });
  });

  it('a cached full record (as new as the pin) gives the CRS name and the status', () => {
    const cached = { ...A, crs: { name: null, code: 'EPSG:2193', status: 'confirmed' as const } };
    const rows = allRows([feat(cached)], [cached], [], [DOC]);
    expect(rows[0].crs).toEqual({ name: null, code: 'EPSG:2193', status: 'confirmed' });
  });

  it('a document the app does not know falls back to the record’s file name, else stays blank', () => {
    const rows = allRows([feat(A)], [OFF], [OFF.uid], []);
    expect(rows.map((r) => r.document)).toEqual(['', OFF.sourceFile]);
  });

  it('with a result set: its members in the set’s order, pins from the set’s features, unplotted members from the records', () => {
    const rs: ResultSet = {
      id: 'rs_TEST', count: 3, locatedCount: 2, unlocatedCount: 1, excludedUnreviewed: 0,
      uids: [C.uid, OFF.uid, A.uid, 'bh_UNKNOWN'], bbox: null, area: null, definition: null as never, createdAt: '2026-10-17T08:00:00Z',
    };
    const rows = resultSetRows(rs, [feat(A), feat(C)], [feat(A), feat(B), feat(C)], [OFF], [DOC, DOC2]);
    // A member the app knows nothing about is left out (the summary keeps the server's counts).
    expect(rows.map((r) => r.uid)).toEqual([C.uid, OFF.uid, A.uid]);
    expect(rows.map((r) => r.onMap)).toEqual([true, false, true]);
  });
});

describe('sorting', () => {
  const rows = allRows([feat(A), feat(B), feat(C)], [OFF], [OFF.uid], [DOC, DOC2]);
  const ids = (list: ResultRow[]) => list.map((r) => r.id);

  it('keeps the server’s order without a sort', () => {
    expect(ids(sortRows(rows, null))).toEqual(['TB-10', 'TB-2', 'TB-1', 'TB-9']);
  });

  it('sorts IDs naturally (TB-2 before TB-10), both ways', () => {
    expect(ids(sortRows(rows, { key: 'id', dir: 'asc' }))).toEqual(['TB-1', 'TB-2', 'TB-9', 'TB-10']);
    expect(ids(sortRows(rows, { key: 'id', dir: 'desc' }))).toEqual(['TB-10', 'TB-9', 'TB-2', 'TB-1']);
  });

  it('a depth that is not stated sorts last in both directions, never as 0', () => {
    expect(ids(sortRows(rows, { key: 'depth', dir: 'asc' }))).toEqual(['TB-1', 'TB-9', 'TB-10', 'TB-2']);
    expect(ids(sortRows(rows, { key: 'depth', dir: 'desc' }))).toEqual(['TB-10', 'TB-9', 'TB-1', 'TB-2']);
  });

  it('a blank project sorts last; status puts attention and unreviewed first; ties keep the server’s order', () => {
    expect(ids(sortRows(rows, { key: 'project', dir: 'asc' }))).toEqual(['TB-2', 'TB-10', 'TB-9', 'TB-1']);
    expect(sortRows(rows, { key: 'status', dir: 'asc' }).map((r) => r.status)).toEqual(['unreviewed', 'unreviewed', 'in_review', 'approved']);
    expect(ids(sortRows(rows, { key: 'document', dir: 'desc' }))).toEqual(['TB-1', 'TB-9', 'TB-10', 'TB-2']);
  });

  it('a header click sorts ascending, the same header again flips the direction', () => {
    expect(nextSort(null, 'depth')).toEqual({ key: 'depth', dir: 'asc' });
    expect(nextSort({ key: 'depth', dir: 'asc' }, 'depth')).toEqual({ key: 'depth', dir: 'desc' });
    expect(nextSort({ key: 'depth', dir: 'desc' }, 'depth')).toEqual({ key: 'depth', dir: 'asc' });
    expect(nextSort({ key: 'depth', dir: 'desc' }, 'id')).toEqual({ key: 'id', dir: 'asc' });
  });
});

describe('pages', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ uid: `bh_${i}` }));

  it('100 rows per page; 5,000 rows are 50 pages; a page past the end shows the last one', () => {
    expect(PAGE_SIZE).toBe(100);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(100)).toBe(1);
    expect(pageCount(101)).toBe(2);
    expect(pageCount(many.length)).toBe(50);
    expect(pageOf(many, 0).map((r) => r.uid).slice(0, 2)).toEqual(['bh_0', 'bh_1']);
    expect(pageOf(many, 49)).toHaveLength(100);
    expect(pageOf(many, 99)[0].uid).toBe('bh_4900');
  });

  it('finds the page of a selected borehole', () => {
    expect(pageOfUid(many, 'bh_0')).toBe(0);
    expect(pageOfUid(many, 'bh_250')).toBe(2);
    expect(pageOfUid(many, 'bh_MISSING')).toBeNull();
    expect(pageOfUid(many, null)).toBeNull();
  });
});

describe('CRS column', () => {
  it('names the system after the status when the record is cached: the printed name, else the code', () => {
    expect(crsColumn({ name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', status: 'stated' })).toMatchObject({
      text: 'stated · ETRS89 / UTM zone 32N', warn: false, title: 'Coordinate system stated in the source: ETRS89 / UTM zone 32N (EPSG:25832)',
    });
    expect(crsColumn({ name: null, code: 'EPSG:2193', status: 'confirmed' })).toMatchObject({
      text: 'confirmed · EPSG:2193', warn: false, title: 'Coordinate system confirmed by a reviewer: EPSG:2193',
    });
  });

  it('a pin without its record shows only the status, and its title never claims there is no system', () => {
    for (const status of ['stated', 'confirmed'] as const) {
      const c = crsColumn({ name: null, code: null, status });
      expect(c.text).toBe(status);
      expect(c.title).not.toMatch(/No coordinate system/i);
      expect(c.warn).toBe(false);
    }
    expect(crsColumn({ name: null, code: null, status: 'inferred' })).toEqual({ text: 'inferred', warn: true, title: 'Coordinate system inferred, not stated in the source' });
    expect(crsColumn({ name: null, code: null, status: 'unknown' })).toEqual({ text: 'unknown', warn: true, title: 'Coordinate system unknown' });
  });

  it('every text starts with the server’s status word', () => {
    for (const status of ['stated', 'inferred', 'confirmed', 'unknown'] as const) {
      expect(crsColumn({ name: 'Local grid (fictional)', code: null, status }).text.startsWith(status)).toBe(true);
    }
  });
});

describe('depth and summaries', () => {
  it('a depth is metres, an unknown depth says "not stated" (never 0)', () => {
    expect(depthCell(18)).toEqual({ text: '18.00 m', stated: true });
    expect(depthCell(null)).toEqual({ text: 'not stated', stated: false });
    expect(depthCell(0)).toEqual({ text: 'not stated', stated: false });
  });

  it('the result-set line: count, on the map, not located and unreviewed left out (when the server counted them)', () => {
    const rs = { count: 7, locatedCount: 6, unlocatedCount: 1, excludedUnreviewed: 0 };
    expect(resultSetSummary(rs)).toBe('7 boreholes · 6 on the map · 1 not located · 0 unreviewed left out');
    expect(resultSetSummary({ count: 1, locatedCount: 1, unlocatedCount: 0, excludedUnreviewed: null })).toBe('1 borehole · 1 on the map · 0 not located');
  });
});
