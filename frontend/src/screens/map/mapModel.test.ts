import { describe, expect, it } from 'vitest';
import { K } from '../../domain/keys';
import type { Borehole, MapFeature } from '../../domain/types';
import { emptyFilter } from '../../store/mapDataSlice';
import { featureOf } from '../../store/testing';
import { makeBorehole, makeValue } from '../../test/fixtures';
import { COL, pinColor, statusChip } from '../../theme';
import { DEPTH_CLASSES, DEPTH_NOT_STATED, type DepthClass } from './depthClasses';
import {
  areaFromDrawn,
  bboxArea,
  bboxBounds,
  circleArea,
  clusterSize,
  clusterView,
  colourClassOf,
  countLabel,
  crsCell,
  depthClassOf,
  depthText,
  DIMMED_OPACITY,
  emphasisOf,
  featureRow,
  fitPadding,
  initialBounds,
  isPlotted,
  isPointBbox,
  LEGEND_EXTENT,
  legendEntries,
  legendExtent,
  legendRows,
  mapRows,
  notOnMapReason,
  onlyArea,
  PIN_RADIUS,
  pinStyle,
  polygonArea,
  POPUP_LOADING,
  POPUP_LOAD_FAILED,
  POPUP_MISSING,
  POPUP_NO_DEPTH,
  POPUP_NO_DEPTH_PAGE,
  POPUP_NO_DEPTH_SOURCE,
  POPUP_NOT_REVIEWABLE,
  popupCrs,
  popupCrsWarning,
  popupDepthText,
  popupView,
  recordRow,
  resultsSummary,
  ringGradient,
  STATUS_PAINT,
  statusByUid,
  WORLD_BOUNDS,
  wrapLng,
  type PinRow,
} from './mapModel';

const approved = (uid: string, project = 'Test Project (fictional)') =>
  makeBorehole({ uid, id: uid, project, reviewStatus: 'approved' });

/** The map rows of fictional records as the store holds them: features of the plotted ones, records of the rest. */
function rowsOf(bs: Borehole[], cached: Borehole[] = []) {
  const features = bs.map(featureOf).filter((f): f is MapFeature => !!f);
  const off = bs.filter((b) => !isPlotted(b));
  return mapRows(features, [...off, ...cached], off.map((b) => b.uid));
}

/** A pin row of the map (fictional). */
const pin = (uid: string, o: Partial<PinRow> = {}): PinRow => ({
  uid,
  id: uid,
  project: 'Test Project (fictional)',
  depth: 6,
  status: 'unreviewed',
  crs: { name: null, code: null, status: 'stated' },
  pin: { lat: 50, lng: 8 },
  ...o,
});

describe('isPlotted', () => {
  it('needs onMap and both coordinates', () => {
    expect(isPlotted(makeBorehole())).toBe(true);
    expect(isPlotted(makeBorehole({ onMap: false }))).toBe(false);
    expect(isPlotted(makeBorehole({ lat: null }))).toBe(false);
    expect(isPlotted(makeBorehole({ lng: null }))).toBe(false);
    expect(isPlotted(makeBorehole({ lat: Number.NaN }))).toBe(false);
  });
});

describe('legendEntries (status counts of the drawn pins)', () => {
  it('counts plotted boreholes per server status, attention first winning', () => {
    const bs = [
      approved('a'),
      approved('b'),
      makeBorehole({ uid: 'c' }),
      makeBorehole({ uid: 'd', reviewStatus: 'in_review' }),
      makeBorehole({ uid: 'e', openClarifications: 1, reviewStatus: 'approved' }),
      makeBorehole({ uid: 'f', onMap: false, lat: null, lng: null }),
    ];
    const entries = legendEntries(rowsOf(bs).rows);
    expect(entries.map((e) => [e.label, e.count])).toEqual([
      ['Approved', 2],
      ['In review', 1],
      ['Unreviewed', 1],
      ['Needs attention', 1],
    ]);
    expect(entries.map((e) => e.color)).toEqual([COL.green, COL.grey, COL.grey, COL.amber]);
  });

  it('follows status changes: a flagged value makes the pin amber', () => {
    const b = makeBorehole();
    const flagged = { ...b, values: [...b.values, makeValue({ key: 'Notes', status: 'flagged', flag: 'check' })] };
    expect(legendEntries(rowsOf([flagged]).rows)[3].count).toBe(1);
  });

  it('a cached record as new as the pin gives its status (e.g. an approval the map layer has not seen yet)', () => {
    const b = makeBorehole();
    const f = featureOf(b)!;
    const approvedNow = { ...b, reviewStatus: 'approved' as const };
    expect(featureRow(f, approvedNow).status).toBe('approved');
    // An older record than the pin does not: the pin is newer.
    expect(featureRow({ ...f, revision: 2 }, approvedNow).status).toBe('unreviewed');
    // The server's attention wins over its review status on a pin without a record.
    expect(featureRow({ ...f, reviewStatus: 'approved', attention: true }).status).toBe('attention');
  });

  it('an inferred CRS alone is not attention: the server opens a question for it', () => {
    const b = makeBorehole({ crs: { name: 'Fictional grid', code: null, status: 'inferred' } });
    expect(statusByUid([b]).get(b.uid)).toBe('unreviewed');
  });

  it('a lint error the app added itself is not attention; a backend lint error is', () => {
    const b = makeBorehole();
    const own = { ...b, values: [...b.values, makeValue({ key: 'spt', lint: { severity: 'error', message: 'Increments 4 + 5 = 9 ≠ N 8', client: true } })] };
    const server = { ...b, values: [...b.values, makeValue({ key: 'spt', lint: { severity: 'error', message: 'Refusal with N' } })] };
    expect(statusByUid([own]).get(b.uid)).toBe('unreviewed');
    expect(statusByUid([server]).get(b.uid)).toBe('attention');
  });
});

describe('F9: pin colours by status', () => {
  it('approved green, unreviewed grey, in review grey with a dark ring, attention amber', () => {
    expect(STATUS_PAINT.approved).toEqual({ fill: COL.green, stroke: '#FFFFFF' });
    expect(STATUS_PAINT.unreviewed).toEqual({ fill: COL.grey, stroke: '#FFFFFF' });
    expect(STATUS_PAINT.in_review).toEqual({ fill: COL.grey, stroke: COL.muted });
    expect(STATUS_PAINT.attention).toEqual({ fill: COL.amber, stroke: '#FFFFFF' });
    // In review must read apart from unreviewed.
    expect(STATUS_PAINT.in_review).not.toEqual(STATUS_PAINT.unreviewed);
    expect([pinColor('approved'), pinColor('in_review'), pinColor('unreviewed'), pinColor('attention')]).toEqual([COL.green, COL.grey, COL.grey, COL.amber]);
    expect((['approved', 'in_review', 'unreviewed', 'attention'] as const).map((s) => statusChip(s).label)).toEqual([
      'Approved', 'In review', 'Unreviewed', 'Needs attention',
    ]);
  });

  it('attention wins: a feature with attention is amber whatever its review status (displayStatus)', () => {
    const f = { ...featureOf(makeBorehole({ reviewStatus: 'approved' }))!, attention: true };
    expect(colourClassOf(featureRow(f), 'status').paint.fill).toBe(COL.amber);
  });
});

describe('F9: depth classes', () => {
  it('puts a stated depth into the class with min < depth ≤ max', () => {
    expect(depthClassOf(0.4).label).toBe('0–10 m');
    expect(depthClassOf(10).label).toBe('0–10 m');
    expect(depthClassOf(10.01).label).toBe('>10–20 m');
    expect(depthClassOf(50).label).toBe('>20–50 m');
    expect(depthClassOf(100).label).toBe('>50–100 m');
    expect(depthClassOf(1250).label).toBe('>100 m');
    expect(depthClassOf(18).paint.fill).toBe(DEPTH_CLASSES[1].colour);
  });

  it('an unknown depth is its own grey "depth not stated" class, never a class it is not', () => {
    for (const d of [null, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = depthClassOf(d);
      expect(c.key).toBe('depth-none');
      expect(c.label).toBe(DEPTH_NOT_STATED.label);
      expect(c.paint.fill).toBe(DEPTH_NOT_STATED.colour);
    }
  });

  it('a stated depth outside a gappy config is "Other depth", not "not stated" and not a neighbour', () => {
    const gappy: DepthClass[] = [
      { label: '0–5 m', min: 0, max: 5, colour: '#111111' },
      { label: '>10 m', min: 10, max: null, colour: '#222222' },
    ];
    expect(depthClassOf(7, gappy).key).toBe('depth-other');
    expect(depthClassOf(null, gappy).key).toBe('depth-none');
  });

  it('the shipped classes cover every depth above 0 without gaps or overlaps, end open, colours distinct', () => {
    expect(DEPTH_CLASSES[0].min).toBe(0);
    for (let i = 1; i < DEPTH_CLASSES.length; i++) expect(DEPTH_CLASSES[i].min).toBe(DEPTH_CLASSES[i - 1].max);
    expect(DEPTH_CLASSES[DEPTH_CLASSES.length - 1].max).toBeNull();
    const colours = [...DEPTH_CLASSES.map((c) => c.colour), DEPTH_NOT_STATED.colour];
    expect(new Set(colours).size).toBe(colours.length);
    // Not the status meanings: no depth class is "approved green" or "attention amber".
    expect(DEPTH_CLASSES.map((c) => c.colour)).not.toContain(COL.green);
    expect(DEPTH_CLASSES.map((c) => c.colour)).not.toContain(COL.amber);
  });
});

describe('F9: legend rows and counts', () => {
  const rows = [
    pin('a', { status: 'approved', depth: 4 }),
    pin('b', { status: 'approved', depth: 15 }),
    pin('c', { status: 'in_review', depth: null }),
    pin('d', { status: 'attention', depth: 120 }),
    // Not on the map: never counted.
    { ...pin('e', { depth: 4 }), pin: null },
  ];

  it('status mode: four rows in legend order with the drawn pins counted', () => {
    expect(legendRows(rows, 'status').map((r) => [r.key, r.label, r.count])).toEqual([
      ['approved', 'Approved', 2],
      ['in_review', 'In review', 1],
      ['unreviewed', 'Unreviewed', 0],
      ['attention', 'Needs attention', 1],
    ]);
  });

  it('depth mode: one row per configured class plus "Depth not stated"; the unknown depth is counted there', () => {
    const depth = legendRows(rows, 'depth');
    expect(depth.map((r) => r.label)).toEqual([...DEPTH_CLASSES.map((c) => c.label), 'Depth not stated']);
    expect(depth.map((r) => r.count)).toEqual([1, 1, 0, 0, 1, 1]);
    expect(depth.reduce((a, r) => a + r.count, 0)).toBe(4);
  });

  it('with a result set active, counts its highlighted members only', () => {
    const members = new Set(['a', 'c', 'e']);
    expect(legendRows(rows, 'status', members).map((r) => r.count)).toEqual([1, 1, 0, 0]);
    expect(legendRows(rows, 'depth', members).find((r) => r.key === 'depth-none')?.count).toBe(1);
  });
});

describe('F10: result-set highlight', () => {
  it('members are highlighted, the other pins dimmed but still drawn; without a set every pin is normal', () => {
    const members = new Set(['a']);
    expect(emphasisOf('a', members)).toBe('member');
    expect(emphasisOf('b', members)).toBe('dimmed');
    expect(emphasisOf('b', null)).toBe('normal');
    const paint = STATUS_PAINT.approved;
    expect(pinStyle(paint, 'normal')).toEqual({ radius: PIN_RADIUS.normal, color: '#FFFFFF', weight: 2, opacity: 1, fillColor: COL.green, fillOpacity: 1 });
    expect(pinStyle(paint, 'member').radius).toBe(PIN_RADIUS.member);
    const dimmed = pinStyle(paint, 'dimmed');
    expect([dimmed.fillOpacity, dimmed.opacity]).toEqual([DIMMED_OPACITY.fill, DIMMED_OPACITY.stroke]);
    expect(dimmed.fillOpacity).toBeGreaterThan(0);
    expect(pinStyle(paint, 'normal', true).radius).toBe(PIN_RADIUS.highlight);
  });
});

describe('F9: clusters', () => {
  it('prints the count short: 999, 1k, 1.2k, 25k', () => {
    expect([8, 999, 1000, 1234, 9999, 25_000, 250_400].map(countLabel)).toEqual(['8', '999', '1k', '1.2k', '9.9k', '25k', '250k']);
  });

  it('grows with the count', () => {
    expect([1, 9, 10, 99, 100, 999, 1000, 5000].map(clusterSize)).toEqual([32, 32, 38, 38, 44, 44, 50, 50]);
  });

  it('shows the status mix as ring segments in legend order', () => {
    const v = clusterView([pin('a', { status: 'approved' }), pin('b', { status: 'approved' }), pin('c', { status: 'attention' }), pin('d')], 'status');
    expect(v.label).toBe('4');
    expect(v.ring).toBe(`conic-gradient(${COL.green} 0% 50%, ${COL.grey} 50% 75%, ${COL.amber} 75% 100%)`);
    expect(v.text).toBe('4 boreholes: 2 Approved, 1 Unreviewed, 1 Needs attention');
    expect(v.dimmed).toBe(false);
  });

  it('switches to the depth-class mix in depth mode, unknown depths in the grey class', () => {
    const v = clusterView([pin('a', { depth: 3 }), pin('b', { depth: null })], 'depth');
    expect(v.ring).toBe(`conic-gradient(${DEPTH_CLASSES[0].colour} 0% 50%, ${DEPTH_NOT_STATED.colour} 50% 100%)`);
    expect(v.text).toBe('2 boreholes: 1 0–10 m, 1 Depth not stated');
  });

  it('with a result set active: dimmed without members, counts its members otherwise', () => {
    const rows = [pin('a'), pin('b'), pin('c')];
    expect(clusterView(rows, 'status', new Set(['x']))).toMatchObject({ dimmed: true, members: 0 });
    const v = clusterView(rows, 'status', new Set(['a', 'c']));
    expect(v).toMatchObject({ dimmed: false, members: 2, total: 3 });
    expect(v.text).toBe('3 boreholes: 3 Unreviewed; 2 in the selection');
  });

  it('an empty ring is plain grey (no division by zero)', () => {
    expect(ringGradient([])).toBe(`conic-gradient(${COL.grey} 0% 100%)`);
  });
});

/** Leaflet-shaped layers as the draw tools hand them over (only the methods areaFromDrawn calls). */
const ll = (lat: number, lng: number) => ({ lat, lng });
const rectangle = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => ({
  getBounds: () => ({ getSouthWest: () => ll(Math.min(a.lat, b.lat), Math.min(a.lng, b.lng)), getNorthEast: () => ll(Math.max(a.lat, b.lat), Math.max(a.lng, b.lng)) }),
});

describe('F10: drawn shapes as the contract Area', () => {
  it('a rectangle is a bbox [min_lon, min_lat, max_lon, max_lat]', () => {
    expect(areaFromDrawn('Rectangle', rectangle(ll(-36.9, 174.7), ll(-36.8, 174.9)))).toEqual({ type: 'bbox', bbox: [174.7, -36.9, 174.9, -36.8] });
  });

  it('a polygon is a closed GeoJSON Polygon in [lon, lat]', () => {
    const corners = [ll(10, 20), ll(10, 21), ll(11, 21)];
    expect(areaFromDrawn('Polygon', { getLatLngs: () => [corners] })).toEqual({
      type: 'polygon',
      polygon: { type: 'Polygon', coordinates: [[[20, 10], [21, 10], [21, 11], [20, 10]]] },
    });
    // A flat ring (Leaflet polyline shape) and an already closed ring give the same polygon.
    expect(areaFromDrawn('Polygon', { getLatLngs: () => [...corners, ll(10, 20)] })).toEqual(areaFromDrawn('Polygon', { getLatLngs: () => [corners] }));
  });

  it('a circle is its centre [lon, lat] and radius in metres', () => {
    expect(areaFromDrawn('Circle', { getLatLng: () => ll(-33.45, -70.66), getRadius: () => 1500.123 })).toEqual({ type: 'circle', center: [-70.66, -33.45], radiusM: 1500.12 });
  });

  it('unusable shapes give no area: no size, too few corners, no radius, an unknown tool', () => {
    expect(bboxArea(ll(5, 5), ll(5, 9))).toBeNull();
    expect(polygonArea([ll(1, 1), ll(2, 2), ll(1, 1)])).toBeNull();
    expect(circleArea(ll(1, 1), 0)).toBeNull();
    expect(areaFromDrawn('Line', { getLatLngs: () => [ll(1, 1), ll(2, 2)] })).toBeNull();
  });

  it('a shape drawn on a world copy east or west of the main one comes back to [-180, 180]', () => {
    expect(wrapLng(190)).toBe(-170);
    expect(wrapLng(-190)).toBe(170);
    expect(bboxArea(ll(40, 370), ll(41, 372))).toEqual({ type: 'bbox', bbox: [10, 40, 12, 41] });
    expect(circleArea(ll(1, -350), 10)).toEqual({ type: 'circle', center: [10, 1], radiusM: 10 });
    const poly = polygonArea([ll(0, 361), ll(0, 362), ll(1, 362)]);
    expect(poly?.type === 'polygon' && poly.polygon.coordinates[0].map(([lon]) => lon)).toEqual([1, 2, 2, 1]);
  });

  it('a rectangle across the antimeridian keeps min_lon > max_lon (a crossing box); wider than the world is the world', () => {
    expect(bboxArea(ll(-40, 170), ll(-30, 190))).toEqual({ type: 'bbox', bbox: [170, -40, -170, -30] });
    expect(bboxArea(ll(-40, -200), ll(-30, 200))).toEqual({ type: 'bbox', bbox: [-180, -40, 180, -30] });
    expect(bboxArea(ll(-40, 170), ll(-30, 180))).toEqual({ type: 'bbox', bbox: [170, -40, 180, -30] });
  });

  it('never makes up 0,0: every coordinate comes from the drawn shape', () => {
    const area = areaFromDrawn('Rectangle', rectangle(ll(48.1, 11.5), ll(48.2, 11.7)));
    expect(area?.type === 'bbox' && area.bbox.some((x) => x === 0)).toBe(false);
  });
});

describe('bboxBounds', () => {
  it('turns [min_lon, min_lat, max_lon, max_lat] into [[south, west], [north, east]]', () => {
    expect(bboxBounds([9.4, 50.2, 9.44, 50.22])).toEqual([[50.2, 9.4], [50.22, 9.44]]);
  });

  it('a box across the antimeridian continues east past 180 instead of spanning the world', () => {
    expect(bboxBounds([170, -40, -170, -30])).toEqual([[-40, 170], [-30, 190]]);
  });

  it('knows a box of no size (a point place)', () => {
    expect(isPointBbox([5, 6, 5, 6])).toBe(true);
    expect(isPointBbox([5, 6, 5.1, 6])).toBe(false);
  });
});

describe('onlyArea', () => {
  it('is true for the reset filter with or without an area, false once anything else is set', () => {
    expect(onlyArea(emptyFilter())).toBe(true);
    expect(onlyArea({ ...emptyFilter(), area: { type: 'bbox', bbox: [1, 2, 3, 4] } })).toBe(true);
    expect(onlyArea({ ...emptyFilter(), minDepth: 10 })).toBe(false);
    expect(onlyArea({ ...emptyFilter(), includeUnreviewed: false })).toBe(false);
    expect(onlyArea({ ...emptyFilter(), dinCodes: ['S'] })).toBe(false);
  });
});

describe('F9: pin popup', () => {
  const row = (b: Borehole) => featureRow(featureOf(b)!);

  it('shows ID, project, depth or "depth not stated", status and the CRS warning', () => {
    const b = makeBorehole({ id: 'TB-07', finalDepth: 18, crs: { name: 'x', code: null, status: 'inferred' } });
    const v = popupView(row(b), b, undefined);
    expect(v).toMatchObject({ id: 'TB-07', project: 'Test Project (fictional)', depth: 'Final depth 18.00 m', status: 'unreviewed' });
    expect(popupView(row(b), undefined, 'loading').crsWarning).toBe('CRS inferred, not stated');
    expect(popupDepthText(null)).toBe('Depth not stated');
    expect(popupDepthText(0)).toBe('Depth not stated');
  });

  it('REVIEW and SOURCE wait for the full record, and say why when it is missing', () => {
    const b = makeBorehole();
    expect(popupView(row(b), undefined, undefined).review).toEqual({ enabled: false, reason: POPUP_LOADING });
    expect(popupView(row(b), undefined, 'loading').source).toEqual({ enabled: false, reason: POPUP_LOADING });
    expect(popupView(row(b), undefined, 'missing').review.reason).toBe(POPUP_MISSING);
    expect(popupView(row(b), undefined, 'error').source.reason).toBe(POPUP_LOAD_FAILED);
  });

  it('with the record: REVIEW and SOURCE on when the final depth has a source page', () => {
    const b = makeBorehole();
    const v = popupView(row(b), b, undefined);
    expect(v.review).toEqual({ enabled: true, reason: null });
    expect(v.source).toEqual({ enabled: true, reason: null });
  });

  it('REVIEW off when Review cannot show the borehole (no located value, no document)', () => {
    const b = makeBorehole();
    const unlocated = { ...b, values: b.values.map((x) => ({ ...x, page: null, box: null })) };
    expect(popupView(row(b), unlocated, undefined).review).toEqual({ enabled: false, reason: POPUP_NOT_REVIEWABLE });
    expect(popupView(row(b), { ...b, documentId: null }, undefined).review.enabled).toBe(false);
  });

  it('SOURCE off with the reason: no final depth, no source reference, on no page or cell', () => {
    const b = makeBorehole();
    const without = (f: (v: Borehole['values'][number]) => Borehole['values'][number] | null) => ({
      ...b,
      values: b.values.map((x) => (x.key === K.finalDepth ? f(x) : x)).filter((x): x is Borehole['values'][number] => !!x),
    });
    expect(popupView(row(b), without(() => null), undefined).source.reason).toBe(POPUP_NO_DEPTH);
    expect(popupView(row(b), without((x) => ({ ...x, hasProvenance: false })), undefined).source.reason).toBe(POPUP_NO_DEPTH_SOURCE);
    expect(popupView(row(b), without((x) => ({ ...x, page: null, box: null })), undefined).source.reason).toBe(POPUP_NO_DEPTH_PAGE);
    // A spreadsheet value has a cell instead of a page: its source opens.
    expect(popupView(row(b), without((x) => ({ ...x, page: null, box: null, cell: 'Logdata!C5' })), undefined).source.enabled).toBe(true);
  });
});

describe('FE-MAP-1: fitting keeps pins out from under the legend', () => {
  const legend = { width: 170, height: 150 };

  it('on a wide map, pads the left side by the legend’s width plus the margin', () => {
    expect(fitPadding({ width: 1100, height: 540 }, legend)).toEqual({ paddingTopLeft: [194, 24], paddingBottomRight: [24, 24] });
  });

  it('on a tall map, pads the bottom by the legend’s height plus the margin', () => {
    expect(fitPadding({ width: 400, height: 900 }, legend)).toEqual({ paddingTopLeft: [24, 24], paddingBottomRight: [24, 174] });
  });

  it('a result-set fit uses 48 px padding, plus the legend', () => {
    expect(fitPadding({ width: 1100, height: 540 }, legend, 48)).toEqual({ paddingTopLeft: [218, 48], paddingBottomRight: [48, 48] });
  });

  it('measures the legend from the map’s bottom-left corner', () => {
    const map = { left: 0, top: 88, right: 1140, bottom: 630 };
    expect(legendExtent(map, { left: 12, top: 485, right: 168, bottom: 606 })).toEqual({ width: 168, height: 145 });
  });

  it('falls back to the size the legend’s CSS gives it when it can’t be measured', () => {
    const map = { left: 0, top: 88, right: 1140, bottom: 630 };
    expect(legendExtent(map, null)).toEqual(LEGEND_EXTENT);
    expect(legendExtent(map, { left: 0, top: 0, right: 0, bottom: 0 })).toEqual(LEGEND_EXTENT);
    // left 12 + 212 wide; bottom 24 + about 148 high (MapLegend.module.css).
    expect(LEGEND_EXTENT.width).toBeGreaterThanOrEqual(224);
    expect(LEGEND_EXTENT.height).toBeGreaterThanOrEqual(172);
  });
});

describe('crsCell', () => {
  it('uses the backend label without shortening it', () => {
    expect(crsCell({ name: 'Fictional grid zone 3', code: 'EPSG:0003', status: 'inferred' })).toMatchObject({
      text: 'inferred · Fictional grid zone 3',
      warn: true,
    });
    expect(crsCell({ name: 'Fictional grid zone 3', code: 'EPSG:0003', status: 'confirmed' })).toMatchObject({
      text: 'confirmed · Fictional grid zone 3',
      warn: false,
    });
    expect(crsCell({ name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', status: 'stated' })).toMatchObject({
      text: 'stated',
      warn: false,
      title: 'Stated in the source: ETRS89 / UTM zone 32N (EPSG:25832)',
    });
    expect(crsCell({ name: null, code: null, status: 'unknown' })).toMatchObject({ text: 'unknown', warn: true });
  });
});

describe('1.2.0: the CRS a map feature names (crs_code, crs_label)', () => {
  const pin = (o: Partial<MapFeature>): MapFeature => ({ ...featureOf(makeBorehole())!, ...o });

  it('a pin without its record names the server’s label, else the code, else only the status', () => {
    const labelled = featureRow(pin({ crsStatus: 'confirmed', crsCode: 'EPSG:0001', crsLabel: 'Fictional grid A' }));
    expect(labelled.crs).toEqual({ name: null, code: 'EPSG:0001', label: 'Fictional grid A', status: 'confirmed' });
    expect(crsCell(labelled.crs)).toMatchObject({ text: 'confirmed · Fictional grid A', title: expect.stringContaining('Fictional grid A (EPSG:0001)') });
    const coded = featureRow(pin({ crsStatus: 'stated', crsCode: 'EPSG:0002', crsLabel: null }));
    expect(popupCrs(coded.crs)).toEqual({ text: 'CRS: EPSG:0002', warn: false });
    // An older server (1.1.0) sends neither: the status only, nothing made up.
    const bare = featureRow(pin({ crsStatus: 'stated', crsCode: undefined, crsLabel: undefined }));
    expect(bare.crs).toEqual({ name: null, code: null, label: null, status: 'stated' });
    expect(popupCrs(bare.crs)).toEqual({ text: 'CRS stated', warn: false });
  });

  it('the popup’s CRS line: the label for a stated or confirmed system, amber for an inferred or unknown one', () => {
    expect(popupCrs({ name: 'As printed', code: 'EPSG:0001', label: 'Fictional grid A', status: 'confirmed' })).toEqual({
      text: 'CRS confirmed: Fictional grid A', warn: false,
    });
    expect(popupCrs({ name: 'As printed', code: null, status: 'stated' })).toEqual({ text: 'CRS: As printed', warn: false });
    expect(popupCrs({ name: 'x', code: null, status: 'inferred' })).toEqual({ text: 'CRS inferred, not stated: x', warn: true });
    expect(popupCrs({ name: null, code: null, status: 'inferred' })).toEqual({ text: 'CRS inferred, not stated', warn: true });
    expect(popupCrs({ name: null, code: null, status: 'unknown' })).toEqual({ text: 'CRS unknown', warn: true });
    expect(popupCrs({ name: null, code: null, status: 'confirmed' })).toEqual({ text: 'CRS confirmed', warn: false });
  });

  it('the popup view carries the CRS line of the row', () => {
    const b = makeBorehole();
    const v = popupView(featureRow(pin({ crsStatus: 'confirmed', crsCode: 'EPSG:0001', crsLabel: 'Fictional grid A' })), b, undefined);
    expect(v.crs).toEqual({ text: 'CRS confirmed: Fictional grid A', warn: false });
  });
});

describe('popupCrsWarning', () => {
  it('warns only for inferred or unknown CRS', () => {
    expect(popupCrsWarning({ name: 'x', code: null, status: 'inferred' })).toBe('CRS inferred, not stated');
    expect(popupCrsWarning({ name: null, code: null, status: 'unknown' })).toBe('CRS unknown');
    expect(popupCrsWarning({ name: 'x', code: null, status: 'stated' })).toBeNull();
    expect(popupCrsWarning({ name: 'x', code: null, status: 'confirmed' })).toBeNull();
  });
});

describe('notOnMapReason', () => {
  it('labels the reason code; CRS problems and implausible coordinates are amber', () => {
    expect(notOnMapReason(makeBorehole({ onMap: false, unplottedReason: 'no_coordinates' }))).toEqual({
      text: 'No coordinates in source',
      warn: false,
    });
    expect(notOnMapReason(makeBorehole({ onMap: false, unplottedReason: 'crs_unknown' }))).toEqual({
      text: 'Coordinate system unknown',
      warn: true,
    });
    expect(notOnMapReason(makeBorehole({ onMap: false, unplottedReason: 'implausible' })).warn).toBe(true);
  });

  it('makes no reason up when the backend gives none', () => {
    expect(notOnMapReason(makeBorehole({ onMap: false, lat: null, lng: null }))).toEqual({ text: 'Not placed on the map', warn: false });
  });
});

describe('depthText', () => {
  it('formats metres and never shows a missing depth as 0', () => {
    expect(depthText(17.5)).toBe('17.50 m');
    expect(depthText(0)).toBe('–');
    expect(depthText(null)).toBe('–');
    expect(depthText(Number.NaN)).toBe('–');
  });
});

describe('mapRows', () => {
  it('lists every pin and every NOT ON MAP record once, the pins first', () => {
    const off = makeBorehole({ uid: 'off', id: 'TB-09', onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });
    const { rows, pins, notOnMap } = rowsOf([makeBorehole({ uid: 'a', id: 'TB-01' }), off, makeBorehole({ uid: 'b', id: 'TB-02' })]);
    expect(rows.map((r) => r.id)).toEqual(['TB-01', 'TB-02', 'TB-09']);
    expect(pins.map((p) => p.uid)).toEqual(['a', 'b']);
    expect(notOnMap.map((b) => b.uid)).toEqual(['off']);
    expect(rows[2]).toEqual(recordRow(off));
    expect(rows[2].pin).toBeNull();
  });

  it('a pin without its full record shows the feature: CRS status only, its depth, no label made up', () => {
    const f = featureOf(makeBorehole({ crs: { name: 'Fictional grid', code: 'EPSG:0001', status: 'inferred' }, finalDepth: null }))!;
    const row = featureRow(f);
    expect(row.crs).toEqual({ name: null, code: null, label: null, status: 'inferred' });
    expect(crsCell(row.crs).text).toBe('inferred');
    expect(depthText(row.depth)).toBe('–');
    expect(row.project).toBe('Test Project (fictional)');
    expect(featureRow({ ...f, project: null }).project).toBe('');
  });

  it('an unplotted uid whose record is not cached is left out (nothing is made up for it)', () => {
    expect(mapRows([], [], ['bh_unknown']).rows).toEqual([]);
  });
});

describe('resultsSummary', () => {
  it('counts boreholes and distinct projects', () => {
    const bs = [approved('a', 'P1'), approved('b', 'P1'), approved('c', 'P2')];
    // No hard-coded country: API projects can be anywhere.
    expect(resultsSummary(bs)).toBe('3 boreholes · 2 projects');
    expect(resultsSummary([approved('a')])).toBe('1 borehole · 1 project');
    expect(resultsSummary([])).toBe('0 boreholes · 0 projects');
  });
});

describe('initialBounds', () => {
  it('covers every pin, so none starts off-screen', () => {
    const bs = [makeBorehole({ uid: 'a', lat: 48.8, lng: 9.2 }), makeBorehole({ uid: 'b', lat: -36.8, lng: 174.7 })];
    expect(initialBounds(rowsOf(bs).rows)).toEqual([
      [-36.8, 9.2],
      [48.8, 174.7],
    ]);
  });

  it('handles thousands of pins (no spread of a huge argument list)', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => pin(`p${i}`, { pin: { lat: (i % 170) - 85, lng: (i % 360) - 180 } }));
    expect(initialBounds(many)).toEqual([
      [-85, -180],
      [84, 179],
    ]);
  });
});

describe('uiv-5: the first map view hard-codes no country', () => {
  it('starts on the whole world when nothing is plotted yet (the empty start)', () => {
    expect(WORLD_BOUNDS).toEqual([
      [-60, -180],
      [75, 180],
    ]);
    expect(initialBounds([])).toEqual(WORLD_BOUNDS);
  });

  it('fits the pins wherever they are', () => {
    expect(initialBounds(rowsOf([makeBorehole({ lat: 48.8, lng: 9.2 })]).rows)).toEqual([
      [48.8, 9.2],
      [48.8, 9.2],
    ]);
  });
});

describe('uiv-1: a CRS without a printed name shows the server’s code', () => {
  it('confirmed and stated cells name the EPSG code instead of "No coordinate system"', () => {
    expect(crsCell({ name: null, code: 'EPSG:2193', status: 'confirmed' })).toEqual({
      text: 'confirmed · EPSG:2193',
      warn: false,
      title: 'Confirmed by a reviewer: EPSG:2193',
    });
    expect(crsCell({ name: null, code: 'EPSG:4326', status: 'stated' }).title).toBe('Stated in the source: EPSG:4326');
  });
});
