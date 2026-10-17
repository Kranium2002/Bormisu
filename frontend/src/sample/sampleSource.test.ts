// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { K } from '../domain/keys';
import { boreholeStatus, cleanKeys } from '../domain/review';
import type { Borehole } from '../domain/types';
import { createCountryLocator } from '../geo/countryAssign';
import { COUNTRIES } from '../test/countries';
import { fmtN, GRIDS, hashS, mulberry32, wrapT } from './generate';
import { createSampleSource } from './sampleSource';

const load = () => createSampleSource().load();
const byId = (bs: Borehole[], id: string) => bs.find((b) => b.id === id) as Borehole;

describe('sample data', () => {
  it('has the prototype archive plus three projects abroad: 61 boreholes in 10 projects, 3 not on the map', async () => {
    const { boreholes, documents } = await load();
    expect(boreholes).toHaveLength(61);
    expect(new Set(boreholes.map((b) => b.project)).size).toBe(10);
    expect(boreholes.filter((b) => !b.onMap).map((b) => b.id)).toEqual(['BK-13', 'BK-14', 'SK-05']);
    expect(new Set(boreholes.map((b) => b.uid)).size).toBe(61);
    expect(documents.map((d) => d.id)).toEqual(['nb', 'eq', 'is']);
  });

  it('places every project in its country: 45 pins in Germany, 4 in Switzerland, 5 in Norway, 4 in Singapore', async () => {
    const { boreholes } = await load();
    const hits = createCountryLocator(COUNTRIES).assign(boreholes.filter((b) => b.onMap) as { uid: string; lat: number; lng: number }[]);
    const byCountry = new Map<string, string[]>();
    for (const b of boreholes.filter((x) => x.onMap)) {
      const hit = hits.get(b.uid);
      expect(hit?.countries, b.id).toHaveLength(1); // no sample borehole sits on a border
      const code = hit?.country ?? 'none';
      byCountry.set(code, [...(byCountry.get(code) ?? []), b.id.slice(0, 3)]);
    }
    expect(Object.fromEntries([...byCountry].map(([c, ids]) => [c, ids.length]))).toEqual({ DE: 45, CH: 4, NO: 5, SG: 4 });
    expect(new Set(byCountry.get('CH'))).toEqual(new Set(['LA-']));
    expect(new Set(byCountry.get('NO'))).toEqual(new Set(['AO-']));
    expect(new Set(byCountry.get('SG'))).toEqual(new Set(['KC-']));
  });

  it('the projects abroad state their national CRS and live in archive files', async () => {
    const { boreholes } = await load();
    expect(byId(boreholes, 'LA-01').crs).toEqual({ name: 'CH1903+ / LV95', code: 'EPSG:2056', status: 'stated' });
    expect(byId(boreholes, 'AO-01').crs).toEqual({ name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', status: 'stated' });
    expect(byId(boreholes, 'KC-01').crs).toEqual({ name: 'SVY21 / Singapore TM', code: 'EPSG:3414', status: 'stated' });
    expect(byId(boreholes, 'KC-01').sourceFile).toBe('kallang_cable_tunnel_bohrprofile.pdf');
    // Printed coordinates look like the grid's: LV95 eastings start with 2, SVY21 ones are 5 digits.
    expect(byId(boreholes, 'LA-01').values.find((v) => v.key === K.xy)?.value).toMatch(/^26\d{5} \/ 12\d{5}$/);
    expect(byId(boreholes, 'KC-01').values.find((v) => v.key === K.xy)?.value).toMatch(/^3\d{4} \/ 3\d{4}$/);
  });

  it('LV95 approximation reproduces swisstopo\'s worked example', () => {
    // WGS84 46°02'38.87" N, 8°43'49.79" E is E 2 699 999.76, N 1 099 999.97 (swisstopo, approximate formulas).
    const [e, n] = GRIDS.lv95.toXY(46 + 2 / 60 + 38.87 / 3600, 8 + 43 / 60 + 49.79 / 3600);
    expect(Math.abs(e - 2700000)).toBeLessThanOrEqual(1);
    expect(Math.abs(n - 1100000)).toBeLessThanOrEqual(1);
  });

  it('BK-07 is the review borehole of document nb, with the prototype lints', async () => {
    const { boreholes, documents } = await load();
    const bk7 = byId(boreholes, 'BK-07');
    expect(bk7.documentId).toBe('nb');
    expect(documents[0].reviewBoreholeUid).toBe(bk7.uid);
    expect([bk7.lat, bk7.lng, bk7.finalDepth, bk7.logBottom]).toEqual([48.7905, 9.1835, 18, 14.5]);
    const spt2 = bk7.values.find((v) => v.key === K.spt(2));
    expect(spt2?.lint?.message).toBe('Increments 4 + 5 = 9 ≠ N 8');
    const spt5 = bk7.values.find((v) => v.key === K.spt(5));
    expect(spt5?.value).toBe('refusal · 50 blows / 30 cm');
    expect(boreholeStatus(bk7)).toBe('attention');
    expect(bk7.values).toHaveLength(47); // 30 from the log + 17 lab values and sample depths
    expect(cleanKeys(bk7)).toHaveLength(33);
  });

  it('assigns CRS statuses: Neckarbogen inferred, SK-05 unknown, others stated', async () => {
    const { boreholes } = await load();
    for (const b of boreholes) {
      const expected = b.project === 'Stadtbahn Neckarbogen' ? 'inferred' : b.id === 'SK-05' ? 'unknown' : 'stated';
      expect(b.crs.status, b.id).toBe(expected);
    }
    expect(byId(boreholes, 'BK-01').crs.name).toBe('DHDN / GK zone 3');
    expect(byId(boreholes, 'EQ-01').crs.name).toBe('ETRS89 / UTM zone 32N');
  });

  it('applies the base codes: r reviewed, a attention, u unreviewed', async () => {
    const { boreholes } = await load();
    expect(boreholeStatus(byId(boreholes, 'EQ-01'))).toBe('reviewed');
    expect(boreholeStatus(byId(boreholes, 'MS-05'))).toBe('attention');
    expect(boreholeStatus(byId(boreholes, 'MS-03'))).toBe('unreviewed');
    expect(boreholeStatus(byId(boreholes, 'BK-01'))).toBe('attention');
    expect(['LA-01', 'LA-03', 'LA-04'].map((id) => boreholeStatus(byId(boreholes, id)))).toEqual(['reviewed', 'unreviewed', 'attention']);
  });

  it('is deterministic', async () => {
    expect(await load()).toEqual(await load());
  });

  it('every value page can be rendered and every box lies on the page', async () => {
    const src = createSampleSource();
    const { boreholes } = await src.load();
    for (const b of boreholes) {
      for (const v of b.values) {
        if (v.page == null) continue;
        const page = await src.getPage(b.documentId as string, v.page);
        expect(page.items?.length, `${b.uid} ${v.key}`).toBeGreaterThan(0);
        if (v.box) {
          expect(v.box.x + v.box.w).toBeLessThanOrEqual(1);
          expect(v.box.y + v.box.h).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('offers the Neckarbogen site, about 110 m from BK-07, as the simulated MY LOCATION', () => {
    expect(createSampleSource().simulatedSite).toEqual({ label: 'Neckarbogen site', lat: 48.7912, lng: 9.1846 });
  });

  it('labels the two BK-07 sheets', async () => {
    const page = await createSampleSource().getPage('nb', 8);
    expect(page.label).toBe('page 8 · sheet 2 of 2 · neckarbogen_BG_2019.pdf');
    expect(page.type).toBe('log');
  });
});

describe('sample source mutations', () => {
  afterEach(() => vi.useRealTimers());

  it('persists value updates in memory', async () => {
    const src = createSampleSource();
    await src.updateValue('nb:BK-07', K.finalDepth, { status: 'approved' });
    const { boreholes } = await src.load();
    expect(byId(boreholes, 'BK-07').values.find((v) => v.key === K.finalDepth)?.status).toBe('approved');
  });

  it('confirms the CRS for every borehole of the document', async () => {
    const src = createSampleSource();
    const cands = await src.crsCandidates('nb');
    expect(cands.map((c) => c.verdict)).toEqual(['match', 'shifted', 'out_of_range']);
    await expect(src.confirmCrs('nb', 'EPSG:25832')).rejects.toThrow();
    await src.confirmCrs('nb', 'EPSG:31467');
    const { boreholes } = await src.load();
    const nb = boreholes.filter((b) => b.documentId === 'nb');
    expect(nb).toHaveLength(13);
    expect(nb.every((b) => b.crs.status === 'confirmed')).toBe(true);
    expect(boreholeStatus(byId(boreholes, 'BK-01'))).toBe('reviewed');
  });

  it('simulates upload progress 0 → 1 → 2', async () => {
    vi.useFakeTimers();
    const src = createSampleSource();
    const steps: number[] = [];
    await src.upload([new File(['x'], 'report.pdf')], (d) => steps.push(d.step));
    vi.advanceTimersByTime(1800);
    vi.advanceTimersByTime(3400);
    expect(steps).toEqual([0, 1, 2]);
    const { documents } = await src.load();
    expect(documents[0]).toMatchObject({ name: 'report.pdf', simulated: true, step: 2 });
  });
});

describe('generator helpers', () => {
  it('match the prototype implementations', () => {
    expect(hashS('BK-07')).toBe([...'BK-07'].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7));
    const r = mulberry32(1);
    const first = r();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(mulberry32(1)()).toBe(first);
    expect(fmtN(3513420)).toBe('3 513 420');
    expect(wrapT('Sand, fein- bis mittelkörnig, mitteldicht', 30)).toEqual(['Sand, fein- bis mittelkörnig,', 'mitteldicht']);
  });
});
