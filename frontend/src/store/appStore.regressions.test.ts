/** Regression tests for the store bugs from the codex logic review (finding ids in each test name). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartialSaveError, type DataSource } from '../data/DataSource';
import { K } from '../domain/keys';
import type { CrsCandidate, DocumentSummary } from '../domain/types';
import { makeBorehole, makeValue } from '../test/fixtures';

/** init() asks createDataSource once; it gets a proxy that forwards to the current fake source. */
let current: DataSource;
const proxy: DataSource = {
  kind: 'sample',
  load: () => current.load(),
  getPage: (d, p) => current.getPage(d, p),
  upload: (f, u) => current.upload(f, u),
  watch: (d, u) => current.watch?.(d, u),
  updateValue: (uid, k, p) => current.updateValue(uid, k, p),
  crsCandidates: (d) => current.crsCandidates(d),
  confirmCrs: (d, c) => current.confirmCrs(d, c),
};
vi.mock('../data/createDataSource', () => ({
  createDataSource: async () => proxy,
  dataSourceKind: () => 'sample',
  apiBase: () => '/api/v1',
}));
const { useAppStore } = await import('./appStore');

const doc: DocumentSummary = {
  id: 'doc', name: 'test_report.pdf', project: 'Test Project (fictional)', pageTypes: ['text', 'log'], step: 2,
  counts: null, completeness: null, reviewBoreholeUid: 'doc:TB-01',
};

function fakeSource(over: Partial<DataSource> = {}): DataSource {
  return {
    kind: 'sample',
    load: async () => ({ boreholes: [makeBorehole()], documents: [doc] }),
    getPage: async (documentId, page) => ({ documentId, page, type: 'log', usage: 'used', label: `page ${page}`, items: [] }),
    upload: async () => undefined,
    updateValue: async () => undefined,
    crsCandidates: async () => [],
    confirmCrs: async () => undefined,
    ...over,
  };
}

const st = () => useAppStore.getState();
const bh = (uid = 'doc:TB-01') => st().boreholes.find((b) => b.uid === uid);
const value = (key: string, uid = 'doc:TB-01') => bh(uid)?.values.find((v) => v.key === key);
/** Lets every queued promise reaction run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function ready(source: DataSource = fakeSource()) {
  current = source;
  useAppStore.setState({
    source, boreholes: [], documents: [], pages: {}, panel: null, editing: null, toast: null, screen: 'map',
    crsDialogOpen: false, crsLoading: false, crsCandidates: [], crsPick: 0, confirmCleanOpen: false, exportOpen: false,
    searchMessage: '', mapFocus: null, query: '',
  });
  const { boreholes, documents } = await source.load();
  useAppStore.setState({ loadState: 'ready', boreholes, documents, reviewUid: 'doc:TB-01', selectedUid: 'doc:TB-01', focusKey: null });
}

function editFinalDepth(text: string) {
  st().startEdit(K.finalDepth, 'edit');
  st().setEditText(text);
  st().saveEdit();
}

describe('optimistic saves', () => {
  it('c1: an older save failing late does not undo a newer successful edit', async () => {
    let failApprove: (e: Error) => void = () => undefined;
    const updateValue = vi.fn<DataSource['updateValue']>((_uid, _key, patch) =>
      patch.value === undefined ? new Promise((_, reject) => (failApprove = reject)) : Promise.resolve(),
    );
    await ready(fakeSource({ updateValue }));
    st().toggleApprove(K.finalDepth); // pending
    editFinalDepth('6.50'); // saved after the approval settles
    await settle();
    expect(updateValue).toHaveBeenCalledTimes(1);
    failApprove(new Error('offline'));
    await vi.waitFor(() => expect(updateValue).toHaveBeenCalledTimes(2));
    await settle();
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited', status: 'approved' });
    expect(bh()?.finalDepth).toBe(6.5);
    expect(st().toast?.text).toBe('Not saved: offline');
  });

  it('c1: saves of one value reach the source in order', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const updateValue = vi.fn<DataSource['updateValue']>(async (_uid, _key, patch) => {
      order.push(patch.value ?? patch.status ?? '?');
      if (order.length === 1) await new Promise<void>((r) => (releaseFirst = r));
    });
    await ready(fakeSource({ updateValue }));
    st().toggleApprove(K.finalDepth);
    editFinalDepth('6.50');
    await settle();
    expect(order).toEqual(['approved']);
    releaseFirst();
    await vi.waitFor(() => expect(order).toEqual(['approved', '6.50']));
  });

  it('c1: when every save of a value fails, the value goes back to what the source holds', async () => {
    await ready(fakeSource({ updateValue: () => Promise.reject(new Error('offline')) }));
    st().toggleApprove(K.finalDepth);
    editFinalDepth('6.50');
    await vi.waitFor(() => expect(value(K.finalDepth)).toMatchObject({ value: '6.00', method: 'Read', status: 'unreviewed' }));
    expect(bh()?.finalDepth).toBe(6);
  });

  it('c3: a partly saved edit keeps the part the source saved', async () => {
    const updateValue = vi.fn<DataSource['updateValue']>(async () => {
      throw new PartialSaveError('approve failed', { value: '6.50', method: 'Edited' });
    });
    await ready(fakeSource({ updateValue }));
    editFinalDepth('6.50');
    await vi.waitFor(() => expect(value(K.finalDepth)?.status).toBe('unreviewed'));
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited' });
    expect(bh()?.finalDepth).toBe(6.5);
    expect(st().toast?.text).toBe('Not saved: approve failed');
  });

  it('c19: rolling back an edit of a missing final depth makes it unknown again', async () => {
    const missing = makeBorehole({ finalDepth: null });
    missing.values = missing.values.map((v) => (v.key === K.finalDepth ? { ...v, value: '', raw: '', state: 'not in source' as const } : v));
    await ready(
      fakeSource({
        load: async () => ({ boreholes: [structuredClone(missing)], documents: [doc] }),
        updateValue: () => Promise.reject(new Error('offline')),
      }),
    );
    editFinalDepth('7');
    expect(bh()?.finalDepth).toBe(7);
    await vi.waitFor(() => expect(value(K.finalDepth)?.value).toBe(''));
    expect(bh()?.finalDepth).toBeNull();
  });
});

describe('document updates', () => {
  it('c2 + c14: the reload after an upload keeps newer local edits and takes the new document’s checks', async () => {
    const extracted = makeBorehole({ uid: 'up:TB-21', id: 'TB-21', documentId: 'up' });
    const lint = [{ severity: 'warning' as const, boreholeId: 'TB-21', message: 'Gap between layers' }];
    const upDoc: DocumentSummary = { ...doc, id: 'up', name: 'up.pdf', step: 0, reviewBoreholeUid: null, uploaded: true };
    let push: (d: DocumentSummary) => void = () => undefined;
    let answerLoad: (r: Awaited<ReturnType<DataSource['load']>>) => void = () => undefined;
    await ready(fakeSource({ upload: async (_f, onUpdate) => void (push = onUpdate) }));
    current.load = () => new Promise((r) => (answerLoad = r));
    await st().addFiles([new File(['x'], 'up.pdf')]);
    push(upDoc);
    push({ ...upDoc, step: 2, completeness: { listed: 1, idPrefix: '', missing: [], unexpected: [], lint: [] } });
    // The reviewer saves an edit while the reload is on its way; the reload answers with older data.
    editFinalDepth('6.50');
    answerLoad({
      boreholes: [makeBorehole(), extracted],
      documents: [doc, { ...upDoc, step: 2, completeness: { listed: 1, idPrefix: '', missing: [], unexpected: [], lint } }],
    });
    await vi.waitFor(() => expect(bh('up:TB-21')).toBeDefined());
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited' });
    expect(st().documents.find((d) => d.id === 'up')).toMatchObject({ reviewBoreholeUid: 'up:TB-21', completeness: { lint } });
  });

  it('c15: documents still being extracted when the app loads keep updating', async () => {
    const extracting: DocumentSummary = { ...doc, id: 'ex', name: 'ex.pdf', step: 1, reviewBoreholeUid: null };
    const later = makeBorehole({ uid: 'ex:TB-31', id: 'TB-31', documentId: 'ex' });
    const watch = vi.fn<NonNullable<DataSource['watch']>>();
    current = fakeSource({ load: async () => ({ boreholes: [makeBorehole()], documents: [doc, extracting] }), watch });
    await st().init();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0][0]).toBe('ex');
    current.load = async () => ({ boreholes: [makeBorehole(), later], documents: [doc, { ...extracting, step: 2 }] });
    watch.mock.calls[0][1]({ ...extracting, project: '', step: 2 });
    await vi.waitFor(() => expect(st().documents.find((d) => d.id === 'ex')?.reviewBoreholeUid).toBe('ex:TB-31'));
    expect(st().documents.find((d) => d.id === 'ex')?.project).toBe('Test Project (fictional)');
  });
});

describe('pages', () => {
  it('c20: a page that failed to load is tried again', async () => {
    const getPage = vi
      .fn<DataSource['getPage']>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockImplementation(async (documentId, page) => ({ documentId, page, type: 'log', usage: 'used', label: 'p', items: [] }));
    await ready(fakeSource({ getPage }));
    await st().loadPage('doc', 2);
    expect(st().pages['doc:2']).toEqual({ status: 'error', error: 'timeout' });
    await st().loadPage('doc', 2);
    expect(st().pages['doc:2']?.status).toBe('ready');
    await st().loadPage('doc', 2);
    expect(getPage).toHaveBeenCalledTimes(2);
  });
});

describe('navigation', () => {
  beforeEach(() => ready());

  it('c21: leaving Review drops a hidden edit, so Escape closes the export menu', () => {
    useAppStore.setState({ screen: 'review' });
    st().startEdit(K.finalDepth, 'edit');
    st().openBorehole('doc:TB-01');
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
    expect(st().mapFocus?.uid).toBe('doc:TB-01');
  });
});

describe('CRS dialog', () => {
  it('c23: a late confirmation does not close a dialog opened meanwhile', async () => {
    const candidates: CrsCandidate[] = [
      { name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', note: '', verdict: 'match', points: [{ uid: 'doc:TB-01', lat: 48, lng: 9 }] },
    ];
    let answer: () => void = () => undefined;
    const b = makeBorehole({ crs: { name: 'guess', code: null, status: 'inferred' } });
    b.values = [...b.values, makeValue({ key: K.crs, value: 'guess', method: 'Guessed', kind: 'crs' })];
    await ready(
      fakeSource({
        load: async () => ({ boreholes: [b], documents: [doc] }),
        crsCandidates: async () => structuredClone(candidates),
        confirmCrs: () => new Promise<void>((r) => (answer = r)),
      }),
    );
    await st().openCrsDialog();
    const confirming = st().confirmCrs();
    st().closeCrsDialog();
    await st().openCrsDialog();
    answer();
    await confirming;
    expect(st().crsDialogOpen).toBe(true);
    expect(bh()?.crs.status).toBe('confirmed');
  });
});
