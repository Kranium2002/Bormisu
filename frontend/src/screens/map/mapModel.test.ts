import { describe, expect, it } from 'vitest';
import { createCountryLocator } from '../../geo/countryAssign';
import { COUNTRIES, country } from '../../test/countries';
import { makeBorehole, makeValue } from '../../test/fixtures';
import { COL } from '../../theme';
import {
  countryCounts,
  crsCell,
  depthText,
  focusName,
  focusOptions,
  isPlotted,
  legendEntries,
  nearYouModel,
  notOnMapReason,
  outsideSummary,
  placeBoreholes,
  popupCrsWarning,
  resultsSummary,
  searchStep,
  shortCrsName,
  statusByUid,
  type PlottedBorehole,
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

/** Fictional boreholes in several countries, one offshore and one without coordinates. */
const bh = (uid: string, lat: number | null, lng: number | null, project = 'Test Project (fictional)') =>
  makeBorehole({ uid, id: uid.toUpperCase(), project, lat, lng, onMap: lat != null });
const ALL = [
  bh('s1', 48.78, 9.18), // Stuttgart
  bh('s2', 48.79, 9.2), // Stuttgart
  bh('z1', 47.39, 8.48, 'Other Project (fictional)'), // Zürich
  bh('o1', 59.93, 10.8, 'Third Project (fictional)'), // Oslo
  bh('k1', 48.5735, 7.815), // Kehl: Germany, within 2 km of France
  bh('sea', 55.0, 4.0), // North Sea: no country
  bh('n1', null, null), // no coordinates, its project is in Germany (and France, via Kehl)
  bh('n2', null, null, 'Lost Project (fictional)'), // no coordinates, its project has no pin at all
];
const pinsOf = (bs: typeof ALL) => bs.filter(isPlotted) as PlottedBorehole[];
const HITS = createCountryLocator(COUNTRIES).assign(pinsOf(ALL));
const ids = (bs: { uid: string }[]) => bs.map((b) => b.uid);

describe('placeBoreholes', () => {
  it('World: every borehole with coordinates is a pin; RESULTS lists everything', () => {
    const p = placeBoreholes(ALL, 'world', HITS);
    expect(ids(p.plotted)).toEqual(['s1', 's2', 'z1', 'o1', 'k1', 'sea']);
    expect(p.outside).toEqual([]);
    expect(p.unplaced.map((i) => [i.borehole.uid, i.reason.text])).toEqual([
      ['n1', 'No usable coordinates'],
      ['n2', 'No usable coordinates'],
    ]);
    expect(ids(p.results)).toEqual(ids(ALL));
  });

  it('a country: only its boreholes are pins; the others are outside; NOT ON MAP keeps every unplaced one', () => {
    const p = placeBoreholes(ALL, 'DE', HITS);
    expect(ids(p.plotted)).toEqual(['s1', 's2', 'k1']);
    expect(ids(p.outside)).toEqual(['z1', 'o1', 'sea']);
    expect(ids(p.unplaced.map((i) => i.borehole))).toEqual(['n1', 'n2']);
  });

  it('RESULTS of a country: its pins, plus unplaced boreholes of its projects or of projects without any pin', () => {
    expect(ids(placeBoreholes(ALL, 'DE', HITS).results)).toEqual(['s1', 's2', 'k1', 'n1', 'n2']);
    expect(ids(placeBoreholes(ALL, 'CH', HITS).results)).toEqual(['z1', 'n2']);
    expect(ids(placeBoreholes(ALL, 'NO', HITS).results)).toEqual(['o1', 'n2']);
  });

  it('a borehole within 2 km of a border is a pin in both country views', () => {
    expect(ids(placeBoreholes(ALL, 'FR', HITS).plotted)).toEqual(['k1']);
  });

  it('legend counts and NOT ON MAP (unplaced + outside) add up to every borehole', () => {
    for (const focus of ['world', 'DE', 'CH', 'NO']) {
      const p = placeBoreholes(ALL, focus, HITS);
      const counted = legendEntries(p.plotted, statusByUid(ALL)).reduce((n, e) => n + e.count, 0);
      expect(counted + p.unplaced.length + p.outside.length, focus).toBe(ALL.length);
    }
  });

  it('a country focus without outlines (still loading) has no pins', () => {
    const p = placeBoreholes(ALL, 'DE', null);
    expect(p.plotted).toEqual([]);
    expect(p.outside).toHaveLength(6);
  });
});

describe('countryCounts / focusOptions', () => {
  it('counts pins per country view', () => {
    expect(Object.fromEntries(countryCounts(HITS))).toEqual({ DE: 3, CH: 1, NO: 1, FR: 1 });
  });

  it('World first, then countries with pins by count and name, labelled "name · count"', () => {
    expect(focusOptions('world', 6, COUNTRIES, HITS)).toEqual([
      { value: 'world', label: 'World · 6' },
      { value: 'DE', label: 'Germany · 3' },
      { value: 'FR', label: 'France · 1' },
      { value: 'NO', label: 'Norway · 1' },
      { value: 'CH', label: 'Switzerland · 1' },
    ]);
  });

  it('always offers the current focus, also without pins or before the outlines are loaded', () => {
    expect(focusOptions('AT', 6, COUNTRIES, HITS).at(-1)).toEqual({ value: 'AT', label: 'Austria · 0' });
    expect(focusOptions('DE', 6, null, null)).toEqual([
      { value: 'world', label: 'World · 6' },
      { value: 'DE', label: 'DE' },
    ]);
  });

  it('focusName', () => {
    expect(focusName('world', null)).toBe('World');
    expect(focusName('DE', country('DE'))).toBe('Germany');
    expect(focusName('DE', null)).toBe('DE');
  });
});

describe('outsideSummary', () => {
  it('one line with the count and where they are, "no country" last', () => {
    const p = placeBoreholes(ALL, 'DE', HITS);
    expect(outsideSummary(p.outside, HITS, 'Germany', COUNTRIES)).toEqual({
      count: 3,
      text: '3 boreholes outside Germany',
      detail: 'Norway 1 · Switzerland 1 · no country 1',
    });
    expect(outsideSummary([], HITS, 'Germany', COUNTRIES)).toBeNull();
    expect(outsideSummary(p.outside.slice(0, 1), HITS, 'Germany', COUNTRIES)?.text).toBe('1 borehole outside Germany');
  });
});

describe('searchStep', () => {
  const de = placeBoreholes(ALL, 'DE', HITS);
  const find = (uid: string) => ALL.find((b) => b.uid === uid)!;

  it('flies to a pin of the current focus', () => {
    expect(searchStep(find('s1'), de, HITS)).toEqual({ kind: 'fly' });
  });

  it('switches to the borehole\'s country, or to World when it lies in none', () => {
    expect(searchStep(find('o1'), de, HITS)).toEqual({ kind: 'switch', focus: 'NO' });
    expect(searchStep(find('sea'), de, HITS)).toEqual({ kind: 'switch', focus: 'world' });
  });

  it('explains a borehole without usable coordinates and waits for the outlines', () => {
    const odd = makeBorehole({ uid: 'x', onMap: true, lat: null, lng: null });
    expect(searchStep(odd, de, HITS)).toEqual({ kind: 'missing', reason: 'No usable coordinates' });
    expect(searchStep(find('o1'), placeBoreholes(ALL, 'DE', null), null)).toEqual({ kind: 'wait' });
  });
});

describe('nearYouModel', () => {
  const pins = pinsOf(ALL);

  it('lists the five nearest pins with distance and direction, and the accuracy', () => {
    const m = nearYouModel({ lat: 48.781, lng: 9.181, accuracyM: 18 }, pins);
    expect(m.accuracy).toBe('Accuracy ±18 m');
    expect(m.rows.map((r) => r.item.uid)).toEqual(['s1', 's2', 'k1', 'z1', 'sea']);
    expect(m.rows[0]).toMatchObject({ distance: '133 m', direction: 'SW' }); // 111 m south, 73 m west
    expect(m.rows[3].distance).toMatch(/^\d+\.\d km$/);
    expect(m.farMessage).toBeNull();
  });

  it('says so when even the nearest borehole is more than 2 km away', () => {
    const m = nearYouModel({ lat: 48.137, lng: 11.575, accuracyM: 1500 }, pins); // Munich
    expect(m.accuracy).toBe('Accuracy ±1.5 km');
    expect(m.farMessage).toMatch(/^No borehole within 2 km of you\. Nearest: S2 at \d+\.\d km\.$/);
  });

  it('has no rows without pins', () => {
    expect(nearYouModel({ lat: 0, lng: 0, accuracyM: 5 }, [])).toEqual({ accuracy: 'Accuracy ±5 m', rows: [], farMessage: null });
  });
});
