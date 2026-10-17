import { describe, expect, it } from 'vitest';
import type { Borehole, MapFeature } from '../../domain/types';
import { featureOf } from '../../store/testing';
import { makeBorehole, makeValue } from '../../test/fixtures';
import { COL, pinColor, statusChip } from '../../theme';
import {
  crsCell,
  depthText,
  featureRow,
  fitPadding,
  initialBounds,
  isPlotted,
  LEGEND_EXTENT,
  legendEntries,
  legendExtent,
  mapRows,
  notOnMapReason,
  popupCrsWarning,
  recordRow,
  resultsSummary,
  statusByUid,
  WORLD_BOUNDS,
} from './mapModel';

const approved = (uid: string, project = 'Test Project (fictional)') =>
  makeBorehole({ uid, id: uid, project, reviewStatus: 'approved' });

/** The map rows of fictional records as the store holds them: features of the plotted ones, records of the rest. */
function rowsOf(bs: Borehole[], cached: Borehole[] = []) {
  const features = bs.map(featureOf).filter((f): f is MapFeature => !!f);
  const off = bs.filter((b) => !isPlotted(b));
  return mapRows(features, [...off, ...cached], off.map((b) => b.uid));
}

describe('isPlotted', () => {
  it('needs onMap and both coordinates', () => {
    expect(isPlotted(makeBorehole())).toBe(true);
    expect(isPlotted(makeBorehole({ onMap: false }))).toBe(false);
    expect(isPlotted(makeBorehole({ lat: null }))).toBe(false);
    expect(isPlotted(makeBorehole({ lng: null }))).toBe(false);
    expect(isPlotted(makeBorehole({ lat: Number.NaN }))).toBe(false);
  });
});

describe('legendEntries', () => {
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
    const pin = featureOf(b)!;
    const approvedNow = { ...b, reviewStatus: 'approved' as const };
    expect(featureRow(pin, approvedNow).status).toBe('approved');
    // An older record than the pin does not: the pin is newer.
    expect(featureRow({ ...pin, revision: 2 }, approvedNow).status).toBe('unreviewed');
    // The server's attention wins over its review status on a pin without a record.
    expect(featureRow({ ...pin, reviewStatus: 'approved', attention: true }).status).toBe('attention');
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

describe('FE-MAP-1: fitting the pins keeps them out from under the REVIEW STATUS legend', () => {
  const legend = { width: 170, height: 150 };

  it('on a wide map, pads the left side by the legend’s width plus the margin', () => {
    expect(fitPadding({ width: 1100, height: 540 }, legend)).toEqual({ paddingTopLeft: [194, 24], paddingBottomRight: [24, 24] });
  });

  it('on a tall map, pads the bottom by the legend’s height plus the margin', () => {
    expect(fitPadding({ width: 400, height: 900 }, legend)).toEqual({ paddingTopLeft: [24, 24], paddingBottomRight: [24, 174] });
  });

  it('measures the legend from the map’s bottom-left corner', () => {
    const map = { left: 0, top: 88, right: 1140, bottom: 630 };
    expect(legendExtent(map, { left: 12, top: 485, right: 168, bottom: 606 })).toEqual({ width: 168, height: 145 });
  });

  it('falls back to the size the legend’s CSS gives it when it can’t be measured', () => {
    const map = { left: 0, top: 88, right: 1140, bottom: 630 };
    expect(legendExtent(map, null)).toEqual(LEGEND_EXTENT);
    expect(legendExtent(map, { left: 0, top: 0, right: 0, bottom: 0 })).toEqual(LEGEND_EXTENT);
    // left 12 + about 156 wide; bottom 24 + about 122 high (MapLegend.module.css).
    expect(LEGEND_EXTENT.width).toBeGreaterThanOrEqual(168);
    expect(LEGEND_EXTENT.height).toBeGreaterThanOrEqual(146);
  });
});

describe('status colours and chips', () => {
  it('approved green, unreviewed and in review grey with their own labels, attention amber', () => {
    expect([pinColor('approved'), pinColor('in_review'), pinColor('unreviewed'), pinColor('attention')]).toEqual([
      COL.green, COL.grey, COL.grey, COL.amber,
    ]);
    expect((['approved', 'in_review', 'unreviewed', 'attention'] as const).map((s) => statusChip(s).label)).toEqual([
      'Approved', 'In review', 'Unreviewed', 'Needs attention',
    ]);
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
    const pin = featureOf(makeBorehole({ crs: { name: 'Fictional grid', code: 'EPSG:0001', status: 'inferred' }, finalDepth: null }))!;
    const row = featureRow(pin);
    expect(row.crs).toEqual({ name: null, code: null, status: 'inferred' });
    expect(crsCell(row.crs).text).toBe('inferred');
    expect(depthText(row.depth)).toBe('–');
    expect(row.project).toBe('Test Project (fictional)');
    expect(featureRow({ ...pin, project: null }).project).toBe('');
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
