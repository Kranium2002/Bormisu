import { describe, expect, it } from 'vitest';
import { GERMANY } from '../../geo/mapFocus';
import { makeBorehole, makeValue } from '../../test/fixtures';
import { COL } from '../../theme';
import {
  crsCell,
  depthText,
  GERMANY_BOUNDS,
  initialBounds,
  isPlotted,
  legendEntries,
  notOnMapReason,
  placeBoreholes,
  popupCrsWarning,
  resultsSummary,
  shortCrsName,
  statusByUid,
} from './mapModel';

const approved = (uid: string, project = 'Test Project (fictional)') => {
  const b = makeBorehole({ uid, id: uid, project });
  return { ...b, values: b.values.map((v) => ({ ...v, status: 'approved' as const })) };
};

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
  it('counts plotted boreholes per status in prototype order', () => {
    const bs = [
      approved('a'),
      approved('b'),
      makeBorehole({ uid: 'c' }),
      makeBorehole({ uid: 'd', crs: { name: 'DHDN / GK zone 3', code: 'EPSG:31467', status: 'inferred' } }),
      makeBorehole({ uid: 'e', onMap: false, lat: null, lng: null }),
    ];
    const entries = legendEntries(bs, statusByUid(bs));
    expect(entries.map((e) => [e.label, e.count])).toEqual([
      ['Reviewed', 2],
      ['Unreviewed', 1],
      ['Needs attention / CRS inferred', 1],
    ]);
    expect(entries.map((e) => e.color)).toEqual([COL.green, COL.grey, COL.amber]);
  });

  it('follows status changes: a flagged value makes the pin amber', () => {
    const b = makeBorehole();
    const flagged = { ...b, values: [...b.values, makeValue({ key: 'Notes', status: 'flagged', flag: 'check' })] };
    expect(legendEntries([flagged], statusByUid([flagged]))[2].count).toBe(1);
  });
});

describe('shortCrsName', () => {
  it('abbreviates Gauss-Krüger and UTM zones', () => {
    expect(shortCrsName('DHDN / GK zone 3')).toBe('DHDN / GK3');
    expect(shortCrsName('DHDN / 3-degree Gauss-Krüger zone 3')).toBe('DHDN / GK3');
    expect(shortCrsName('DHDN / 3-degree Gauss-Kruger zone 4')).toBe('DHDN / GK4');
    expect(shortCrsName('ETRS89 / UTM zone 32N')).toBe('ETRS89 / UTM32N');
    expect(shortCrsName('WGS 84')).toBe('WGS 84');
  });
});

describe('crsCell', () => {
  it('matches the prototype texts and colours', () => {
    expect(crsCell({ name: 'DHDN / GK zone 3', code: 'EPSG:31467', status: 'inferred' })).toMatchObject({
      text: 'inferred · DHDN / GK3',
      warn: true,
    });
    expect(crsCell({ name: 'DHDN / 3-degree Gauss-Krüger zone 3', code: 'EPSG:31467', status: 'confirmed' })).toMatchObject({
      text: 'confirmed · DHDN / GK3',
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
  it('uses the stated reason; CRS problems are amber', () => {
    expect(notOnMapReason(makeBorehole({ onMap: false, unplottedReason: 'No coordinates in source' }))).toEqual({
      text: 'No coordinates in source',
      warn: false,
    });
    expect(notOnMapReason(makeBorehole({ onMap: false, unplottedReason: 'CRS unknown (local site grid)' }))).toEqual({
      text: 'CRS unknown (local site grid)',
      warn: true,
    });
  });

  it('falls back when the source gives no reason', () => {
    expect(notOnMapReason(makeBorehole({ onMap: false, lat: null, lng: null })).text).toBe('No usable coordinates');
    expect(
      notOnMapReason(makeBorehole({ onMap: false, crs: { name: null, code: null, status: 'unknown' } })),
    ).toEqual({ text: 'CRS unknown', warn: true });
  });
});

describe('depthText', () => {
  it('formats metres and never shows a missing depth as 0', () => {
    expect(depthText(makeBorehole({ finalDepth: 17.5 }))).toBe('17.50 m');
    expect(depthText(makeBorehole({ finalDepth: 0 }))).toBe('–');
    expect(depthText(makeBorehole({ finalDepth: Number.NaN }))).toBe('–');
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
  it('shows Germany, as in the prototype, while every pin is inside it', () => {
    expect(initialBounds([makeBorehole({ lat: 48.8, lng: 9.2 })])).toBe(GERMANY_BOUNDS);
    expect(initialBounds([])).toBe(GERMANY_BOUNDS);
  });

  it('covers pins outside Germany, so none starts off-screen', () => {
    const bs = [makeBorehole({ uid: 'a', lat: 48.8, lng: 9.2 }), makeBorehole({ uid: 'b', lat: 59.9, lng: 10.7 })];
    expect(initialBounds(bs)).toEqual([
      [48.8, 9.2],
      [59.9, 10.7],
    ]);
  });
});

describe('placeBoreholes', () => {
  const stuttgart = makeBorehole({ uid: 's', id: 'S-1', lat: 48.78, lng: 9.18 });
  const paris = makeBorehole({ uid: 'p', id: 'P-1', lat: 48.8566, lng: 2.3522 });
  const noCoords = makeBorehole({ uid: 'n', id: 'N-1', onMap: false, lat: null, lng: null, unplottedReason: 'No coordinates in source' });
  const all = [paris, stuttgart, noCoords];

  it('with the Germany focus, lists boreholes outside it under NOT ON MAP with the reason', () => {
    const p = placeBoreholes(all, GERMANY);
    expect(p.plotted.map((b) => b.uid)).toEqual(['s']);
    expect(p.notOnMap.map((i) => [i.borehole.uid, i.reason])).toEqual([
      ['p', { text: 'Outside map focus (Germany)', warn: true }],
      ['n', { text: 'No coordinates in source', warn: false }],
    ]);
    expect(p.outsideFocus).toBe(1);
  });

  it('legend counts and NOT ON MAP add up to every borehole', () => {
    const p = placeBoreholes(all, GERMANY);
    const counted = legendEntries(p.plotted, statusByUid(all)).reduce((n, e) => n + e.count, 0);
    expect(counted + p.notOnMap.length).toBe(all.length);
  });

  it('without a focus region (world) plots every borehole with coordinates, as before', () => {
    const p = placeBoreholes(all, null);
    expect(p.plotted.map((b) => b.uid)).toEqual(['p', 's']);
    expect(p.notOnMap.map((i) => i.borehole.uid)).toEqual(['n']);
    expect(p.outsideFocus).toBe(0);
  });
});
