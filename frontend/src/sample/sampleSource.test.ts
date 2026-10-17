// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import dinCodes from '@din/din_codes.json';
import type { DataSource } from '../data/DataSource';
import { ApiError, SaveError, UploadCancelledError } from '../data/errors';
import { K } from '../domain/keys';
import { pageUsageText } from '../domain/pages';
import { cleanKeys, deriveReviewStatus, displayStatus } from '../domain/status';
import type { Borehole, BoreholeStatus, DocumentSummary, LiveEvent, LiveStatus, MapFeature, UploadProgress, UploadResult } from '../domain/types';
import { fmtN, hashS, mulberry32, wrapT } from './generate';
import { createSampleSource, SAMPLE_UPLOAD_MS } from './sampleSource';

/**
 * Everything a source holds, as the old full load had it: the documents, the map features, and every
 * full record in prototype order (the placed ones fetched by uid, like the app does on demand).
 */
async function snapshot(src: DataSource = createSampleSource()): Promise<{ boreholes: Borehole[]; documents: DocumentSummary[]; features: MapFeature[] }> {
  const { documents, features, unplotted } = await src.load();
  const placed = await Promise.all(features.map((f) => src.getBorehole(f.uid)));
  const order = new Map([...placed, ...unplotted].map((b) => [b.uid, b]));
  const all = [...order.values()].sort((a, b) => PROTOTYPE_ORDER.indexOf(a.id) - PROTOTYPE_ORDER.indexOf(b.id));
  return { boreholes: all, documents, features };
}
const load = () => snapshot();
/** Borehole IDs in prototype order (projects in order, then their list). */
const PROTOTYPE_ORDER = [
  ...['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '13', '14'].map((n) => `BK-${n}`),
  ...Array.from({ length: 9 }, (_, i) => `EQ-0${i + 1}`), ...Array.from({ length: 7 }, (_, i) => `MS-0${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `EM-0${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `SK-0${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `RB-0${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `CL-0${i + 1}`),
];
const byId = (bs: Borehole[], id: string) => bs.find((b) => b.id === id) as Borehole;
/** Pins per display status, as the map legend counts them (from the light map features). */
const legend = (features: MapFeature[]) => {
  const out: Record<BoreholeStatus, number> = { approved: 0, in_review: 0, unreviewed: 0, attention: 0 };
  for (const f of features) out[f.attention ? 'attention' : f.reviewStatus] += 1;
  return out;
};

describe('sample data', () => {
  it('loads documents, 45 map features and the 3 unplotted records, never every full record', async () => {
    const { documents, features, unplotted } = await createSampleSource().load();
    expect(documents).toHaveLength(3);
    expect(features).toHaveLength(45);
    expect(new Set(features.map((f) => f.uid)).size).toBe(45);
    expect(unplotted.map((b) => [b.id, b.onMap, b.unplottedReason, b.lat, b.lng])).toEqual([
      ['BK-13', false, 'no_coordinates', null, null], ['BK-14', false, 'no_coordinates', null, null], ['SK-05', false, 'crs_unknown', null, null],
    ]);
    // A feature is light: no layers, no values.
    expect(Object.keys(features[0]).sort()).toEqual(
      ['attention', 'crsStatus', 'depth', 'documentId', 'id', 'lat', 'lng', 'openClarifications', 'project', 'reviewStatus', 'revision', 'uid'],
    );
  });

  it('every feature matches its full record: position, depth, statuses, revision, attention and open questions', async () => {
    const { boreholes, features } = await load();
    for (const f of features) {
      const b = boreholes.find((x) => x.uid === f.uid) as Borehole;
      expect(f, b.id).toEqual({
        uid: b.uid, id: b.id, project: b.project, documentId: b.documentId, lat: b.lat, lng: b.lng, depth: b.finalDepth,
        reviewStatus: b.reviewStatus, crsStatus: b.crs.status, revision: b.revision, attention: displayStatus(b) === 'attention',
        openClarifications: b.openClarifications,
      });
    }
  });

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
    // A check of the client: shown, but never counted as attention (uiv-B6).
    expect(bk7.values.find((v) => v.key === K.spt(2))?.lint).toEqual({ severity: 'error', message: 'Increments 4 + 5 = 9 ≠ N 8', client: true });
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
      expect(b.primaryPage, b.id).toBe(b.pages[0]);
    }
  });

  it('gives the surface elevation the unit m and the datum as printed in the note, as the API adapter does (uiv-B3)', async () => {
    const { boreholes } = await load();
    for (const b of boreholes) {
      const v = b.values.find((x) => x.key === K.elevation);
      expect([v?.unit, v?.note], b.id).toEqual(['m', 'datum: NN (as printed, unconfirmed)']);
      expect(b.meta.elevationDatum, b.id).toBe('NN');
    }
  });

  it('shows the map legend the e2e suite expects: 23 approved, 8 unreviewed, 14 attention', async () => {
    const { boreholes, features } = await load();
    expect(legend(features)).toEqual({ approved: 23, in_review: 0, unreviewed: 8, attention: 14 });
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
    const { boreholes } = await snapshot(src);
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
      auth: { enabled: false, registration: 'closed' },
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
    const { boreholes, features } = await snapshot(src);
    expect(byId(boreholes, 'BK-07').revision).toBe(3);
    expect(features.find((f) => f.id === 'BK-07')?.revision).toBe(3);
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
    const before = (await snapshot(src)).boreholes;
    const events: LiveEvent[] = [];
    src.subscribe((e) => events.push(e), () => undefined);
    // Like the backend: only boreholes with printed coordinates get the system (BK-13 and BK-14 have none).
    await expect(src.confirmCrs('nb', { code: 'EPSG:31467', swapAxes: false, confirmedBy: 'A. Reviewer (fictional)' })).resolves.toBe(11);
    const { boreholes, documents, features } = await snapshot(src);
    const nb = boreholes.filter((b) => b.documentId === 'nb');
    const located = nb.filter((b) => b.meta.localX != null && b.meta.localY != null);
    expect(located).toHaveLength(11);
    expect(located.every((b) => b.crs.status === 'confirmed' && b.openClarifications === 0 && b.revision === 2)).toBe(true);
    // BK-13 and BK-14 keep their (unknown) position and CRS; the report's question no longer counts against them.
    for (const id of ['BK-13', 'BK-14']) {
      expect(byId(boreholes, id), id).toEqual({ ...byId(before, id), openClarifications: 0, revision: 2 });
    }
    expect(displayStatus(byId(boreholes, 'BK-01'))).toBe('approved');
    expect(legend(features).attention).toBe(4);
    expect(documents[0].openClarifications).toBe(0);
    // The report's CRS question is answered with the confirmation.
    await expect(src.clarifications({ status: 'answered' })).resolves.toMatchObject([
      { id: 'cl_sample_nb_crs', answer: { crs: 'EPSG:31467', swap_axes: false }, answeredBy: 'A. Reviewer (fictional)' },
    ]);
    expect(events.filter((e) => e.type === 'clarification.resolved')).toEqual([{ type: 'clarification.resolved', clarificationId: 'cl_sample_nb_crs', status: 'answered' }]);
    expect(events.filter((e) => e.type === 'borehole.updated')).toHaveLength(13);
    expect(events.filter((e) => e.type === 'document.updated').map((e) => e.type === 'document.updated' && e.document.openClarifications)).toEqual([0]);
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

  const pdf = (name = 'report.pdf') => new File(['%PDF-1.4 fictional sample upload'], name, { type: 'application/pdf' });

  it('simulates byte progress over about a second, then the server accepts a simulated document with the dropped project', async () => {
    vi.useFakeTimers();
    const src = createSampleSource();
    const progress: UploadProgress[] = [];
    const file = pdf();
    const handle = src.upload(file, { project: 'Dropped folder (fictional)', onProgress: (p) => progress.push(p) });
    let result: UploadResult | undefined;
    void handle.done.then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(SAMPLE_UPLOAD_MS - 1);
    expect(result).toBeUndefined();
    expect(progress.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.every((p) => p.total === file.size)).toBe(true);
    expect(progress.map((p) => p.loaded)).toEqual([...progress.map((p) => p.loaded)].sort((a, b) => a - b));
    expect(progress.at(-1)).toEqual({ loaded: file.size, total: file.size });
    expect(result).toMatchObject({
      duplicate: false,
      document: { name: 'report.pdf', status: 'classifying', step: 0, project: 'Dropped folder (fictional)', uploaded: true, simulated: true },
    });
    const { documents } = await src.load();
    expect(documents[0]).toMatchObject({ id: result?.document.id, name: 'report.pdf' });
    expect(documents).toHaveLength(4);
  });

  it('subscribe is live at once and brings the simulated steps 1.8 s and 5.2 s after the upload was accepted', async () => {
    vi.useFakeTimers();
    const src = createSampleSource();
    const events: LiveEvent[] = [];
    const statuses: LiveStatus[] = [];
    const unsubscribe = src.subscribe((e) => events.push(e), (s) => statuses.push(s));
    expect(statuses).toEqual(['live']);
    const handle = src.upload(pdf(), { project: null });
    await vi.advanceTimersByTimeAsync(SAMPLE_UPLOAD_MS);
    const { document } = await handle.done;
    expect(document.pages.filter((p) => p.classified)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1800 - 1);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(3400);
    const docs = events.map((e) => (e.type === 'document.updated' ? e.document : null));
    expect(docs.map((d) => [d?.id, d?.step, d?.status])).toEqual([[document.id, 1, 'extracting'], [document.id, 2, 'needs_review']]);
    expect(docs.map((d) => d?.pages.filter((p) => p.classified).length)).toEqual([9, 18]);
    expect(docs[1]).toMatchObject({ simulated: true, uploaded: true, project: '' });
    expect((await src.getDocument(document.id)).status).toBe('needs_review');
    unsubscribe();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(2);
  });

  it('cancel() before the end rejects with UploadCancelledError and adds no document; after the end it does nothing', async () => {
    vi.useFakeTimers();
    const src = createSampleSource();
    const onProgress = vi.fn();
    const handle = src.upload(pdf(), { project: null, onProgress });
    await vi.advanceTimersByTimeAsync(SAMPLE_UPLOAD_MS / 2);
    const ticks = onProgress.mock.calls.length;
    handle.cancel();
    await expect(handle.done).rejects.toBeInstanceOf(UploadCancelledError);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onProgress).toHaveBeenCalledTimes(ticks);
    expect((await src.load()).documents).toHaveLength(3);
    const finished = src.upload(pdf('second.pdf'), { project: null });
    await vi.advanceTimersByTimeAsync(SAMPLE_UPLOAD_MS);
    finished.cancel();
    await expect(finished.done).resolves.toMatchObject({ document: { name: 'second.pdf' } });
    expect(vi.getTimerCount()).toBe(2); // the two simulated steps of second.pdf
  });

  it('has no page images and nothing to follow', () => {
    const src = createSampleSource();
    expect(src.thumbnailUrl('nb', 1)).toBeNull();
    expect(() => src.follow('nb')).not.toThrow();
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
