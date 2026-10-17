/**
 * Regression tests for the store bugs from the logic review (finding ids c1–c24 in the test names),
 * rewritten for the contract's save semantics: the source answers every save with the borehole as it
 * holds it, and the newest answer wins once a borehole's saves have settled. Fictional data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { SaveError } from '../data/errors';
import { K } from '../domain/keys';
import { applyValuePatch } from '../domain/review';
import type { Borehole, CrsCandidate, DocumentSummary } from '../domain/types';
import { makeBorehole, makeDocument, makeValue } from '../test/fixtures';
import { CONFLICT_TEXT } from './reviewSlice';
import { fakeSource, makeHealth, readyStore, settle } from './testing';

/** init() asks createDataSource once; it gets a proxy that forwards to the current fake source. */
let current: DataSource;
const proxy = new Proxy({} as DataSource, {
  get: (_t, prop: keyof DataSource) => {
    const v = current[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
  },
});
vi.mock('../data/createDataSource', () => ({
  createDataSource: async () => proxy,
  dataSourceKind: () => 'sample',
  apiBase: () => '/api/v1',
}));
const { useAppStore } = await import('./appStore');

const UID = makeBorehole().uid;
const doc = makeDocument({ reviewBoreholeUid: UID });

const st = () => useAppStore.getState();
const bh = (uid = UID) => st().boreholes.find((b) => b.uid === uid);
const value = (key: string, uid = UID) => bh(uid)?.values.find((v) => v.key === key);

async function ready(over: Partial<DataSource> = {}, boreholes: Borehole[] = [makeBorehole()]) {
  current = fakeSource({ boreholes, documents: [doc] }, over);
  await readyStore(current, UID);
  return current;
}

function editFinalDepth(text: string) {
  st().startEdit(K.finalDepth, 'edit');
  st().setEditText(text);
  st().saveEdit();
}

/** A save the test answers by hand. */
interface Pending { patch: Parameters<DataSource['updateValue']>[2]; resolve(b: Borehole): void; reject(e: unknown): void }
function manualSaves() {
  const pending: Pending[] = [];
  const updateValue = vi.fn<DataSource['updateValue']>(
    (_uid, _key, patch) => new Promise<Borehole>((resolve, reject) => pending.push({ patch, resolve, reject })),
  );
  return { pending, updateValue };
}

/** The server's record after applying patches to the fixture, at a given revision. */
function record(revision: number, ...patches: [string, Parameters<DataSource['updateValue']>[2]][]): Borehole {
  return { ...patches.reduce((b, [key, p]) => applyValuePatch(b, key, p), makeBorehole()), revision };
}

describe('saves', () => {
  it('c1: an older save failing late does not undo a newer successful edit', async () => {
    const { pending, updateValue } = manualSaves();
    await ready({ updateValue });
    st().toggleApprove(K.finalDepth); // save 1
    editFinalDepth('6.50'); // save 2
    expect(updateValue).toHaveBeenCalledTimes(2);
    const edit = pending[1].patch;
    // The edit lands first (revision 2: the approval was refused before it), then the approval fails.
    pending[1].resolve(record(2, [K.finalDepth, edit]));
    await settle();
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', status: 'approved' });
    pending[0].reject(new SaveError('offline', record(1), null));
    await settle();
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited', status: 'approved' });
    expect(bh()?.revision).toBe(2);
    expect(bh()?.finalDepth).toBe(6.5);
    expect(st().toast?.text).toBe('Not saved: offline');
  });

  it('c1: saves reach the source in the order they were made', async () => {
    const { pending, updateValue } = manualSaves();
    await ready({ updateValue });
    st().toggleApprove(K.finalDepth);
    editFinalDepth('6.50');
    st().toggleFlag(K.boreholeId);
    st().setEditText('check');
    st().saveEdit();
    expect(updateValue.mock.calls.map(([, key, p]) => [key, p.value ?? p.status])).toEqual([
      [K.finalDepth, 'approved'],
      [K.finalDepth, '6.50'],
      [K.boreholeId, 'flagged'],
    ]);
    pending.forEach((p, i) => p.resolve(record(i + 2)));
    await settle();
  });

  it('c1: when every save fails without a record, the borehole goes back to what the source held', async () => {
    await ready({ updateValue: () => Promise.reject(new Error('offline')) });
    st().toggleApprove(K.finalDepth);
    editFinalDepth('6.50');
    await vi.waitFor(() => expect(value(K.finalDepth)).toMatchObject({ value: '6.00', method: 'Read', status: 'unreviewed' }));
    expect(bh()?.finalDepth).toBe(6);
    expect(bh()?.reviewStatus).toBe('unreviewed');
  });

  it('c3: a partly saved edit shows what the source holds', async () => {
    // The value was saved, the approval after it was not: the source reports that record.
    const partly = record(2, [K.finalDepth, { value: '6.50', method: 'Edited' }]);
    await ready({ updateValue: () => Promise.reject(new SaveError('approve failed', partly, null)) });
    editFinalDepth('6.50');
    await vi.waitFor(() => expect(value(K.finalDepth)?.status).toBe('unreviewed'));
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited' });
    expect(bh()?.finalDepth).toBe(6.5);
    expect(st().toast?.text).toBe('Not saved: approve failed');
  });

  it('c19: rolling back an edit of a missing final depth makes it unknown again', async () => {
    const missing = makeBorehole({ finalDepth: null });
    missing.values = missing.values.map((v) => (v.key === K.finalDepth ? { ...v, value: '', raw: '', state: 'not in source' as const } : v));
    await ready({ updateValue: () => Promise.reject(new Error('offline')) }, [missing]);
    editFinalDepth('7');
    expect(bh()?.finalDepth).toBe(7);
    await vi.waitFor(() => expect(value(K.finalDepth)?.value).toBe(''));
    expect(bh()?.finalDepth).toBeNull();
  });

  it('a revision conflict loads the latest version and says the change was not saved', async () => {
    const elsewhere = { ...record(5, [K.finalDepth, { value: '6.20', method: 'Edited', status: 'approved' }]) };
    await ready({ updateValue: () => Promise.reject(new SaveError('changed', elsewhere, 'revision_conflict')) });
    editFinalDepth('6.50');
    await vi.waitFor(() => expect(bh()?.revision).toBe(5));
    expect(value(K.finalDepth)).toMatchObject({ value: '6.20', status: 'approved' });
    expect(st().toast?.text).toBe(CONFLICT_TEXT);
  });

  it('a settling save never clobbers the optimistic state of saves still pending', async () => {
    const { pending, updateValue } = manualSaves();
    await ready({ updateValue });
    st().toggleApprove(K.finalDepth);
    st().toggleApprove(K.boreholeId);
    pending[0].resolve(record(2, [K.finalDepth, { status: 'approved' }]));
    await settle();
    // The first answer doesn't know the second approval yet; it waits until the borehole's saves are done.
    expect(value(K.boreholeId)?.status).toBe('approved');
    pending[1].resolve(record(3, [K.finalDepth, { status: 'approved' }], [K.boreholeId, { status: 'approved' }]));
    await settle();
    expect(bh()?.revision).toBe(3);
    expect([value(K.finalDepth)?.status, value(K.boreholeId)?.status]).toEqual(['approved', 'approved']);
  });

  it('an older answer never overwrites a newer one', async () => {
    const { pending, updateValue } = manualSaves();
    await ready({ updateValue });
    st().toggleApprove(K.finalDepth);
    editFinalDepth('6.50');
    // The answers arrive out of order: the newer record (revision 3) first.
    pending[1].resolve(record(3, [K.finalDepth, { status: 'approved', value: '6.50', method: 'Edited' }]));
    pending[0].resolve(record(2, [K.finalDepth, { status: 'approved' }]));
    await settle();
    expect(bh()?.revision).toBe(3);
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited' });
  });

  it('a refetch during pending saves is kept for when they settle, if it is newer', async () => {
    const { pending, updateValue } = manualSaves();
    const fake = await ready({ updateValue });
    st().toggleApprove(K.finalDepth);
    // Another action (e.g. approve-clean) reloads the document while the save is pending.
    const refetched = record(4, [K.finalDepth, { status: 'approved' }], [K.boreholeId, { status: 'approved' }]);
    fake.documentBoreholes = async () => [refetched];
    useAppStore.setState({ confirmCleanOpen: true, cleanCount: 1 });
    await st().approveClean();
    expect(value(K.boreholeId)?.status).toBe('unreviewed');
    pending[0].resolve(record(2, [K.finalDepth, { status: 'approved' }]));
    await settle();
    expect(bh()?.revision).toBe(4);
    expect(value(K.boreholeId)?.status).toBe('approved');
  });
});

describe('undo sends reset and set_state patches', () => {
  it('un-approve and un-flag send status unreviewed; a state toggled back sends ok + unreviewed', async () => {
    const updateValue = vi.fn<DataSource['updateValue']>(async () => record(2));
    await ready({ updateValue });
    st().toggleApprove(K.finalDepth);
    useAppStore.setState({ boreholes: [record(2, [K.finalDepth, { status: 'approved' }])] });
    st().toggleApprove(K.finalDepth);
    useAppStore.setState({ boreholes: [record(3, [K.finalDepth, { status: 'flagged', flag: 'x' }])] });
    st().toggleFlag(K.finalDepth);
    useAppStore.setState({ boreholes: [record(4, [K.finalDepth, { state: 'illegible', status: 'approved' }])] });
    st().setState(K.finalDepth, 'illegible');
    expect(updateValue.mock.calls.map(([, , p]) => p)).toEqual([
      { status: 'approved' },
      { status: 'unreviewed' },
      { status: 'unreviewed', flag: undefined },
      { state: 'ok', status: 'unreviewed' },
    ]);
    await settle();
  });
});

describe('init and health', () => {
  beforeEach(() => {
    useAppStore.setState({ source: null, health: null, loadState: 'loading', boreholes: [], documents: [] });
  });

  it('asks health first and keeps its answer (upload limits, providers)', async () => {
    const calls: string[] = [];
    const health = makeHealth({ mode: 'demo', providers: { ocr: false, classifier: false, extractor: false, chat: false, geocoder: true } });
    current = fakeSource({ boreholes: [makeBorehole()], documents: [doc] });
    const load = current.load;
    current.health = async () => (calls.push('health'), health);
    current.load = async () => (calls.push('load'), load());
    await st().init();
    await settle();
    expect(calls).toEqual(['health', 'load']);
    expect(st().health).toEqual(health);
    expect(st().health?.providers.chat).toBe(false);
    expect(st().loadState).toBe('ready');
  });

  it('a failed health check does not block loading', async () => {
    current = fakeSource({ boreholes: [makeBorehole()], documents: [doc] }, { health: () => Promise.reject(new Error('down')) });
    await st().init();
    await settle();
    expect(st()).toMatchObject({ loadState: 'ready', health: null });
    expect(st().boreholes).toHaveLength(1);
  });

  it('a failed load keeps the error state with its message', async () => {
    current = fakeSource({ boreholes: [], documents: [] }, { load: () => Promise.reject(new Error('Backend unreachable')) });
    await st().init();
    expect(st()).toMatchObject({ loadState: 'error', loadError: 'Backend unreachable' });
  });

  it('c15: documents still being extracted when the app loads keep updating', async () => {
    const extracting = makeDocument({ id: 'doc_TEST_EX', name: 'ex.pdf', status: 'extracting', step: 1, reviewBoreholeUid: null });
    const later = makeBorehole({ uid: 'bh_TEST_EX_31', id: 'TB-31', documentId: extracting.id });
    const watch = vi.fn<NonNullable<DataSource['watch']>>();
    current = fakeSource({ boreholes: [makeBorehole()], documents: [doc, extracting] }, { watch });
    await st().init();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0][0]).toBe(extracting.id);
    current.documentBoreholes = async () => [later];
    watch.mock.calls[0][1]({ ...extracting, project: '', status: 'needs_review', step: 2 });
    await vi.waitFor(() => expect(st().documents.find((d) => d.id === extracting.id)?.reviewBoreholeUid).toBe(later.uid));
    expect(st().documents.find((d) => d.id === extracting.id)?.project).toBe('Test Project (fictional)');
  });
});

describe('document updates', () => {
  it('c2 + c14: the reload after an upload keeps other boreholes’ local edits and takes the new document’s checks', async () => {
    const upDoc: DocumentSummary = makeDocument({ id: 'doc_TEST_UP', name: 'up.pdf', status: 'queued', step: 0, reviewBoreholeUid: null, uploaded: true });
    const extracted = makeBorehole({ uid: 'bh_TEST_UP_21', id: 'TB-21', documentId: upDoc.id });
    const lint = [{ severity: 'warning' as const, boreholeId: 'TB-21', message: 'Gap between layers' }];
    let push: (d: DocumentSummary) => void = () => undefined;
    let answer: (b: Borehole[]) => void = () => undefined;
    const fake = await ready({ upload: async (_f, onUpdate) => void (push = onUpdate) });
    fake.documentBoreholes = () => new Promise((r) => (answer = r));
    fake.getDocument = async () => ({ ...upDoc, step: 2, completeness: { listed: 1, idPrefix: '', missing: [], unexpected: [], lint } });
    await st().addFiles([new File(['x'], 'up.pdf')]);
    push(upDoc);
    push({ ...upDoc, status: 'needs_review', step: 2 });
    // The reviewer saves an edit of another document's borehole while the reload is on its way.
    editFinalDepth('6.50');
    answer([extracted]);
    await vi.waitFor(() => expect(bh(extracted.uid)).toBeDefined());
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited' });
    expect(st().documents.find((d) => d.id === upDoc.id)).toMatchObject({ reviewBoreholeUid: extracted.uid, completeness: { lint } });
  });

  it('retry re-queues a failed document and follows it again', async () => {
    const failed = makeDocument({ id: 'doc_TEST_F', name: 'bad.pdf', status: 'failed', step: 1, error: 'OCR timeout' });
    const watch = vi.fn<NonNullable<DataSource['watch']>>();
    const retry = vi.fn<DataSource['retry']>(async () => undefined);
    current = fakeSource({ boreholes: [makeBorehole()], documents: [doc, failed] }, { retry, watch });
    current.getDocument = async () => ({ ...failed, status: 'queued', step: 0, error: null });
    await readyStore(current, UID);
    await st().retryDocument(failed.id);
    expect(retry).toHaveBeenCalledWith(failed.id);
    expect(st().documents.find((d) => d.id === failed.id)).toMatchObject({ status: 'queued', error: null });
    expect(watch.mock.calls[0][0]).toBe(failed.id);
  });

  it('a refused retry explains itself', async () => {
    await ready({ retry: () => Promise.reject(new Error('not failed')) });
    await st().retryDocument(doc.id);
    expect(st().toast?.text).toBe('Retry failed: not failed');
  });
});

describe('pages', () => {
  it('c20: a page that failed to load is tried again', async () => {
    const getPage = vi
      .fn<DataSource['getPage']>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockImplementation(async (documentId, page) => ({ documentId, page, type: 'log', usage: 'used', label: 'p', items: [] }));
    await ready({ getPage });
    await st().loadPage(doc.id, 2);
    expect(st().pages[`${doc.id}:2`]).toEqual({ status: 'error', error: 'timeout' });
    await st().loadPage(doc.id, 2);
    expect(st().pages[`${doc.id}:2`]?.status).toBe('ready');
    await st().loadPage(doc.id, 2);
    expect(getPage).toHaveBeenCalledTimes(2);
  });
});

describe('navigation', () => {
  beforeEach(() => ready());

  it('c21: leaving Review drops a hidden edit, so Escape closes the export menu', () => {
    useAppStore.setState({ screen: 'review' });
    st().startEdit(K.finalDepth, 'edit');
    st().openBorehole(UID);
    expect(st().editing).toBeNull();
    st().toggleExport();
    st().escape();
    expect(st().exportOpen).toBe(false);
  });

  it('c21: going to another screen drops the edit; staying on Review keeps it', () => {
    useAppStore.setState({ screen: 'review' });
    st().startEdit(K.finalDepth, 'edit');
    st().go('review');
    expect(st().editing?.key).toBe(K.finalDepth);
    st().go('queue');
    expect(st().editing).toBeNull();
  });

  it('c24: a query of only dashes finds nothing', () => {
    for (const q of ['-', '--', ' - ']) {
      useAppStore.setState({ query: q, mapFocus: null });
      st().search();
      expect(st().mapFocus).toBeNull();
      expect(st().searchMessage).toBe(`No results for “${q}”`);
    }
    useAppStore.setState({ query: 'tb 01' });
    st().search();
    expect(st().mapFocus?.uid).toBe(UID);
  });
});

describe('CRS dialog', () => {
  it('c23: a late confirmation does not close a dialog opened meanwhile', async () => {
    const candidates: CrsCandidate[] = [
      { name: 'Fictional grid A', code: 'EPSG:0001', note: null, score: null, verdict: 'match', swapAxes: false, points: [{ uid: UID, lat: 1, lng: 2 }] },
    ];
    let answer: (n: number) => void = () => undefined;
    const b = makeBorehole({ crs: { name: 'guess', code: null, status: 'inferred' } });
    b.values = [...b.values, makeValue({ key: K.crs, value: 'guess', method: 'Guessed', kind: 'crs' })];
    await ready({ crsCandidates: async () => structuredClone(candidates), confirmCrs: () => new Promise<number>((r) => (answer = r)) }, [b]);
    await st().openCrsDialog();
    const confirming = st().confirmCrs();
    st().closeCrsDialog();
    await st().openCrsDialog();
    answer(1);
    await confirming;
    expect(st().crsDialogOpen).toBe(true);
  });
});
