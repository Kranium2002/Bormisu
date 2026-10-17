// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import dinCodes from '@din/din_codes.json';
import { ApiError, SaveError } from '../data/errors';
import { K } from '../domain/keys';
import { pageUsageText } from '../domain/pages';
import { cleanKeys, deriveReviewStatus, displayStatus } from '../domain/status';
import type { Borehole, BoreholeStatus, DocumentSummary } from '../domain/types';
import { fmtN, hashS, mulberry32, wrapT } from './generate';
import { createSampleSource } from './sampleSource';

const load = () => createSampleSource().load();
const byId = (bs: Borehole[], id: string) => bs.find((b) => b.id === id) as Borehole;
/** Pins per display status, as the map legend counts them. */
const legend = (bs: Borehole[]) => {
  const out: Record<BoreholeStatus, number> = { approved: 0, in_review: 0, unreviewed: 0, attention: 0 };
  for (const b of bs.filter((x) => x.onMap)) out[displayStatus(b)] += 1;
  return out;
};

describe('sample data', () => {
  it('has the prototype archive: 48 boreholes in 7 projects, 3 not on the map with reason codes', async () => {
    const { boreholes, documents } = await load();
    expect(boreholes).toHaveLength(48);
    expect(new Set(boreholes.map((b) => b.project)).size).toBe(7);
    expect(boreholes.filter((b) => !b.onMap).map((b) => [b.id, b.unplottedReason, b.lat])).toEqual([
      ['BK-13', 'no_coordinates', null], ['BK-14', 'no_coordinates', null], ['SK-05', 'crs_unknown', null],
    ]);
    expect(new Set(boreholes.map((b) => b.uid)).size).toBe(48);
    expect(documents.map((d) => [d.id, d.status, d.step])).toEqual([['nb', 'needs_review', 2], ['eq', 'done', 3], ['is', 'extracting', 1]]);
  });

  it('BK-07 is the review borehole of document nb, with the prototype lints and the SPT refusal on layer 5', async () => {
    const { boreholes, documents } = await load();
    const bk7 = byId(boreholes, 'BK-07');
    expect(bk7.uid).toBe('nb:BK-07');
    expect(documents[0].reviewBoreholeUid).toBe(bk7.uid);
    expect([bk7.lat, bk7.lng, bk7.finalDepth, bk7.logBottom]).toEqual([48.7905, 9.1835, 18, 14.5]);
    expect(bk7.values.find((v) => v.key === K.spt(2))?.lint?.message).toBe('Increments 4 + 5 = 9 ≠ N 8');
    expect(bk7.values.find((v) => v.key === K.spt(5))).toMatchObject({ value: 'refusal · 50 blows / 30 cm', label: 'SPT @ 10.50 m' });
    expect(bk7.layers[4].spt).toMatchObject({ refusal: true, depth: 10.5, blows: 50, penetrationCm: 30 });
    expect(displayStatus(bk7)).toBe('attention');
    expect(bk7.values).toHaveLength(30);
    expect(cleanKeys(bk7)).toHaveLength(16);
    expect(bk7.layers.map((l) => l.din)).toEqual(['Mu', 'A', 'T', 'U', 'G', 'Sst']);
    expect(bk7.layers[5]).toMatchObject({ dinNotation: 'Sst', stratigraphicName: 'Stubensandstein (Middle Keuper)', geologicAge: 'Triassic', isCore: true });
    expect(bk7.meta).toMatchObject({ xRaw: '3 513 420', yRaw: '5 405 870', axisLabelsRaw: 'Rechts, Hoch', elevationDatum: 'NN' });
    expect(bk7.pages).toEqual([7, 8]);
  });

  it('uses DIN keys of din_codes.json and plain-text stratigraphy, never pattern names or codes', async () => {
    const { boreholes } = await load();
    const keys = new Set(Object.keys(dinCodes));
    for (const b of boreholes) {
      for (const l of b.layers) {
        expect(keys.has(l.din as string), `${b.id} layer ${l.n}: ${l.din}`).toBe(true);
        expect(l.stratigraphicName, `${b.id} layer ${l.n}`).toMatch(/^[A-Z][a-z]/);
      }
    }
    expect(new Set(boreholes.flatMap((b) => b.layers.map((l) => l.din)))).toEqual(new Set(['Mu', 'A', 'T', 'U', 'G', 'Sst', 'S', 'Mg', 'Kst', 'Lö', 'Mst']));
  });

  it('assigns CRS statuses: Neckarbogen inferred, SK-05 unknown, others stated', async () => {
    const { boreholes } = await load();
    for (const b of boreholes) {
      const expected = b.project === 'Stadtbahn Neckarbogen' ? 'inferred' : b.id === 'SK-05' ? 'unknown' : 'stated';
      expect(b.crs.status, b.id).toBe(expected);
    }
    expect(byId(boreholes, 'BK-01').crs.name).toBe('DHDN / GK zone 3');
    expect(byId(boreholes, 'EQ-01').crs.name).toBe('ETRS89 / UTM zone 32N');
    expect(byId(boreholes, 'BK-13').meta).toMatchObject({ xRaw: null, localX: null });
  });

  it('every borehole is at revision 1 with a derived review status and provenance on every value', async () => {
    const { boreholes } = await load();
    for (const b of boreholes) {
      expect(b.revision).toBe(1);
      expect(b.reviewStatus, b.id).toBe(deriveReviewStatus(b.values));
      expect(b.values.every((v) => v.hasProvenance && v.method != null)).toBe(true);
      expect(b.pages.length).toBeGreaterThan(0);
    }
  });

  it('shows the map legend the e2e suite expects: 23 approved, 8 unreviewed, 14 attention', async () => {
    const { boreholes } = await load();
    expect(legend(boreholes)).toEqual({ approved: 23, in_review: 0, unreviewed: 8, attention: 14 });
    expect(displayStatus(byId(boreholes, 'EQ-01'))).toBe('approved');
    expect(displayStatus(byId(boreholes, 'MS-05'))).toBe('attention');
    expect(displayStatus(byId(boreholes, 'MS-03'))).toBe('unreviewed');
    expect(displayStatus(byId(boreholes, 'BK-01'))).toBe('attention');
  });

  it('has core samples and UCS tests for the sampled rock layers', async () => {
    const { boreholes } = await load();
    const tested = boreholes.filter((b) => b.testResults.length);
    expect(tested.length).toBeGreaterThan(0);
    for (const b of tested) {
      expect(b.project).toMatch(/Mainufer|Emscher/);
      expect(b.samples[0]).toMatchObject({ name: 'KP 1', typeCode: 'core' });
      expect(b.testResults[0]).toMatchObject({ name: 'UCS', unit: 'MPa', sampleName: 'KP 1' });
      expect(b.values.filter((v) => v.group === 'sample' || v.group === 'test').map((v) => v.field)).toEqual(['SampleName', 'SampleDepth', 'UCS']);
    }
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
        expect(page.usage, `${b.uid} ${v.key}`).toMatch(/^used: log/);
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
    expect(page.usage).toBe('used: log continuation');
  });

  it('describes the page maps with roles, usage and duplicates', async () => {
    const { documents } = await load();
    const [nb, eq, is] = documents;
    expect(nb.pages).toHaveLength(28);
    expect(nb.pages[6]).toMatchObject({ role: 'log_sheet', used: true, boreholeIds: ['BK 7'], sheetLabel: 'Blatt 1 von 2', language: 'de' });
    expect(nb.pages[8]).toMatchObject({ boreholeIds: ['BK 01'] });
    expect(nb.pages[27]).toMatchObject({ role: 'duplicate', used: false, duplicateOf: { documentId: 'nb', n: 24 } });
    expect(pageUsageText(nb.pages[27])).toBe('unused: duplicate of page 24');
    expect(pageUsageText(nb.pages[0])).toBe('unused: cover page');
    expect(nb.openClarifications).toBe(1);
    expect(eq.pages.filter((p) => p.role === 'log_sheet')).toHaveLength(9);
    expect(is.pages.filter((p) => !p.classified)).toHaveLength(19);
    expect(is.progress).toMatchObject({ pagesTotal: 40, pagesClassified: 21 });
    const page = await createSampleSource().getPage('is', 30);
    expect([page.type, page.usage]).toEqual(['unknown', 'not classified yet']);
  });

  it('reports health in sample mode', async () => {
    await expect(createSampleSource().health()).resolves.toEqual({
      mode: 'sample', status: 'ok', version: 'sample',
      providers: { ocr: false, classifier: false, extractor: false, chat: false, geocoder: false },
      upload: { maxMb: 200, extensions: ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.docx', '.xlsx', '.csv'] },
    });
  });

  it('serves single boreholes and documents, with API-style errors for unknown ids', async () => {
    const src = createSampleSource();
    await expect(src.getBorehole('nb:BK-07')).resolves.toMatchObject({ id: 'BK-07' });
    await expect(src.documentBoreholes('nb')).resolves.toHaveLength(13);
    await expect(src.getDocument('eq')).resolves.toMatchObject({ status: 'done' });
    await expect(src.getBorehole('nope')).rejects.toMatchObject({ name: 'ApiError', code: 'borehole_not_found' });
    await expect(src.getDocument('nope')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('sample source mutations', () => {
  afterEach(() => vi.useRealTimers());

  it('saves a value and answers the updated borehole at the next revision', async () => {
    const src = createSampleSource();
    const saved = await src.updateValue('nb:BK-07', K.finalDepth, { status: 'approved' });
    expect(saved).toMatchObject({ revision: 2, reviewStatus: 'in_review' });
    expect(saved.values.find((v) => v.key === K.finalDepth)?.status).toBe('approved');
    const undone = await src.updateValue('nb:BK-07', K.finalDepth, { status: 'unreviewed' });
    expect(undone).toMatchObject({ revision: 3, reviewStatus: 'unreviewed' });
    const { boreholes } = await src.load();
    expect(byId(boreholes, 'BK-07').revision).toBe(3);
    await expect(src.updateValue('nope', K.finalDepth, { status: 'approved' })).rejects.toBeInstanceOf(SaveError);
    await expect(src.updateValue('nb:BK-07', 'nope', { status: 'approved' })).rejects.toMatchObject({ code: 'path_not_found' });
  });

  it('approves every clean value of a document, with a dry run first', async () => {
    const src = createSampleSource();
    const count = await src.approveClean('nb', true);
    expect(count).toBeGreaterThanOrEqual(16);
    expect((await src.getBorehole('nb:BK-07')).revision).toBe(1);
    await expect(src.approveClean('nb', false)).resolves.toBe(count);
    await expect(src.approveClean('nb', true)).resolves.toBe(0);
    const bk7 = await src.getBorehole('nb:BK-07');
    expect(bk7.values.filter((v) => v.status === 'approved')).toHaveLength(16);
    expect(bk7.revision).toBe(2);
  });

  it('confirms the CRS for every borehole of the document with printed coordinates and answers the CRS question', async () => {
    const src = createSampleSource();
    const cands = await src.crsCandidates('nb');
    expect(cands.map((c) => [c.verdict, c.swapAxes])).toEqual([['match', false], ['shifted', false], ['out_of_range', false]]);
    await expect(src.confirmCrs('nb', { code: 'EPSG:25832', swapAxes: false, confirmedBy: null })).rejects.toMatchObject({ code: 'crs_invalid' });
    const before = (await src.load()).boreholes;
    // Like the backend: only boreholes with printed coordinates get the system (BK-13 and BK-14 have none).
    await expect(src.confirmCrs('nb', { code: 'EPSG:31467', swapAxes: false, confirmedBy: null })).resolves.toBe(11);
    const { boreholes, documents } = await src.load();
    const nb = boreholes.filter((b) => b.documentId === 'nb');
    const located = nb.filter((b) => b.meta.localX != null && b.meta.localY != null);
    expect(located).toHaveLength(11);
    expect(located.every((b) => b.crs.status === 'confirmed' && b.openClarifications === 0 && b.revision === 2)).toBe(true);
    for (const id of ['BK-13', 'BK-14']) expect(byId(boreholes, id), id).toEqual(byId(before, id));
    expect(displayStatus(byId(boreholes, 'BK-01'))).toBe('approved');
    expect(legend(boreholes).attention).toBe(4);
    expect(documents[0].openClarifications).toBe(0);
  });

  it('approving or resetting a flagged value clears its flag, as the backend does', async () => {
    const src = createSampleSource();
    const flagged = await src.updateValue('nb:BK-07', K.finalDepth, { status: 'flagged', flag: 'check the end note (fictional)' });
    expect(flagged.values.find((v) => v.key === K.finalDepth)).toMatchObject({ status: 'flagged', flag: 'check the end note (fictional)' });
    const approved = await src.updateValue('nb:BK-07', K.finalDepth, { status: 'approved' });
    expect(approved.values.find((v) => v.key === K.finalDepth)).toMatchObject({ status: 'approved' });
    expect(approved.values.find((v) => v.key === K.finalDepth)?.flag).toBeUndefined();
    await src.updateValue('nb:BK-07', K.finalDepth, { status: 'flagged', flag: 'again (fictional)' });
    const reset = await src.updateValue('nb:BK-07', K.finalDepth, { status: 'unreviewed' });
    expect(reset.values.find((v) => v.key === K.finalDepth)).toMatchObject({ status: 'unreviewed' });
    expect(reset.values.find((v) => v.key === K.finalDepth)?.flag).toBeUndefined();
  });

  it('simulates upload progress 0 → 1 → 2 with the dropped project', async () => {
    vi.useFakeTimers();
    const src = createSampleSource();
    const seen: DocumentSummary[] = [];
    await src.upload([new File(['x'], 'report.pdf')], (d) => seen.push(d), { project: 'Dropped folder (fictional)' });
    vi.advanceTimersByTime(1800);
    vi.advanceTimersByTime(3400);
    expect(seen.map((d) => [d.step, d.status])).toEqual([[0, 'classifying'], [1, 'extracting'], [2, 'needs_review']]);
    expect(seen.map((d) => d.pages.filter((p) => p.classified).length)).toEqual([2, 9, 18]);
    const { documents } = await src.load();
    expect(documents[0]).toMatchObject({ name: 'report.pdf', simulated: true, step: 2, project: 'Dropped folder (fictional)' });
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
