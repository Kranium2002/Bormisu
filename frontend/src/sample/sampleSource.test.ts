// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { K } from '../domain/keys';
import { boreholeStatus, cleanKeys } from '../domain/review';
import type { Borehole } from '../domain/types';
import { fmtN, hashS, mulberry32, wrapT } from './generate';
import { createSampleSource } from './sampleSource';

const load = () => createSampleSource().load();
const byId = (bs: Borehole[], id: string) => bs.find((b) => b.id === id) as Borehole;

describe('sample data', () => {
  it('has the prototype archive: 48 boreholes in 7 projects, 3 not on the map', async () => {
    const { boreholes, documents } = await load();
    expect(boreholes).toHaveLength(48);
    expect(new Set(boreholes.map((b) => b.project)).size).toBe(7);
    expect(boreholes.filter((b) => !b.onMap).map((b) => b.id)).toEqual(['BK-13', 'BK-14', 'SK-05']);
    expect(new Set(boreholes.map((b) => b.uid)).size).toBe(48);
    expect(documents.map((d) => d.id)).toEqual(['nb', 'eq', 'is']);
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
    expect(bk7.values).toHaveLength(30);
    expect(cleanKeys(bk7)).toHaveLength(16);
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
