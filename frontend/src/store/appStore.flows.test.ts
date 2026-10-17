/**
 * Store flows with non-trivial transitions, against fake sources with fictional data: approve all
 * clean, edit vs flag, states, CRS confirmation, search, uploads, export, the reviewer's name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { K } from '../domain/keys';
import type { Borehole, CrsCandidate, CrsConfirmation, DocumentSummary } from '../domain/types';
import { makeBorehole, makeDocument, makeValue } from '../test/fixtures';
import { useAppStore } from './appStore';
import { readReviewerName, REVIEWER_NAME_KEY } from './settingsSlice';
import { fakeSource, manualLive, readyStore, settle } from './testing';

vi.mock('../export/download', async (orig) => ({
  ...(await orig<typeof import('../export/download')>()),
  downloadBlob: vi.fn(),
}));
const { downloadBlob } = await import('../export/download');

const UID = makeBorehole().uid;
const doc = makeDocument({ reviewBoreholeUid: UID });

const st = () => useAppStore.getState();
const bh = (uid = UID) => st().boreholes.find((b) => b.uid === uid);
const value = (key: string, uid = UID) => bh(uid)?.values.find((v) => v.key === key);

async function ready(over: Partial<DataSource> = {}, boreholes: Borehole[] = [makeBorehole()], reviewUid = UID) {
  const fake = fakeSource({ boreholes, documents: [doc] }, over);
  await readyStore(fake, reviewUid);
  return fake;
}

describe('approve all clean', () => {
  /** Two clean values (a, g); the others are not clean for one reason each. */
  const mixed = () =>
    makeBorehole({
      values: [
        makeValue({ key: 'a', value: '1' }),
        makeValue({ key: 'b', value: '2', method: 'OCR', confidence: 0.5 }),
        makeValue({ key: 'c', value: '3', lint: { severity: 'warning', message: 'odd' } }),
        makeValue({ key: 'd', value: '4', status: 'flagged', flag: 'look' }),
        makeValue({ key: 'e', value: '', state: 'illegible' }),
        makeValue({ key: 'f', value: '6', status: 'approved' }),
        makeValue({ key: 'g', value: '7' }),
      ],
    });

  it('asks the source for the count first (dry run), then approves and reloads the document', async () => {
    const approveClean = vi.fn<DataSource['approveClean']>();
    const fake = await ready({}, [mixed()]);
    approveClean.mockImplementation(fake.approveClean);
    fake.approveClean = approveClean;
    const documentBoreholes = vi.spyOn(fake, 'documentBoreholes');
    const asking = st().askClean();
    expect(st()).toMatchObject({ confirmCleanOpen: true, cleanCount: null });
    await asking;
    expect(approveClean).toHaveBeenCalledWith(doc.id, true);
    expect(st().cleanCount).toBe(2);
    // Nothing is approved by the dry run.
    expect(value('a')?.status).toBe('unreviewed');
    await st().approveClean();
    expect(approveClean).toHaveBeenLastCalledWith(doc.id, false);
    expect(documentBoreholes).toHaveBeenCalledWith(doc.id);
    const status = Object.fromEntries((bh()?.values ?? []).map((v) => [v.key, v.status]));
    expect(status).toEqual({ a: 'approved', b: 'unreviewed', c: 'unreviewed', d: 'flagged', e: 'unreviewed', f: 'approved', g: 'approved' });
    expect(st()).toMatchObject({ confirmCleanOpen: false, cleanBusy: false });
    expect(st().toast?.text).toBe('2 clean values approved');
  });

  it('with nothing clean, the confirmation says so and approves nothing', async () => {
    const approveClean = vi.fn<DataSource['approveClean']>(async () => 0);
    await ready({ approveClean }, [makeBorehole({ values: [makeValue({ key: 'a', method: 'Guessed' })] })]);
    await st().askClean();
    expect(st()).toMatchObject({ confirmCleanOpen: true, cleanCount: 0 });
    await st().approveClean();
    expect(approveClean).toHaveBeenCalledTimes(1);
  });

  it('a second click closes the confirmation, and a late count is ignored', async () => {
    let answer: (n: number) => void = () => undefined;
    await ready({ approveClean: () => new Promise((r) => (answer = r)) });
    const asking = st().askClean();
    await st().askClean();
    expect(st().confirmCleanOpen).toBe(false);
    answer(5);
    await asking;
    expect(st().cleanCount).toBeNull();
  });

  it('a failed count closes the confirmation and explains', async () => {
    await ready({ approveClean: () => Promise.reject(new Error('demo_mode')) });
    await st().askClean();
    expect(st().confirmCleanOpen).toBe(false);
    expect(st().toast?.text).toBe('Could not count the clean values: demo_mode');
  });
});

describe('edit vs flag', () => {
  beforeEach(() => ready());
  afterEach(() => settle());

  it('an unchanged edit approves without marking the value Edited', () => {
    st().startEdit(K.finalDepth, 'edit');
    st().saveEdit();
    expect(value(K.finalDepth)).toMatchObject({ value: '6.00', method: 'Read', status: 'approved' });
  });

  it('a flag keeps the value and method and records the reason', () => {
    st().startEdit(K.finalDepth, 'flag');
    expect(st().editing).toEqual({ key: K.finalDepth, mode: 'flag', text: '' });
    st().setEditText('  ');
    st().saveEdit();
    expect(value(K.finalDepth)).toMatchObject({ value: '6.00', method: 'Read', status: 'flagged', flag: 'needs a second look' });
  });

  it('toggleFlag on a flagged value removes the flag without opening the input', () => {
    st().startEdit(K.finalDepth, 'flag');
    st().setEditText('boundary looks off');
    st().saveEdit();
    st().toggleFlag(K.finalDepth);
    expect(st().editing).toBeNull();
    expect(value(K.finalDepth)).toMatchObject({ status: 'unreviewed', flag: undefined });
  });

  it('editing clears a state set earlier', () => {
    st().setState(K.finalDepth, 'illegible');
    st().startEdit(K.finalDepth, 'edit');
    st().saveEdit();
    expect(value(K.finalDepth)).toMatchObject({ state: 'ok', status: 'approved', method: 'Read' });
  });

  it('focusing another value drops an unsaved edit', () => {
    st().startEdit(K.finalDepth, 'edit');
    st().focusValue(K.finalDepth);
    expect(st().editing?.key).toBe(K.finalDepth);
    st().focusValue(K.boreholeId);
    expect(st().editing).toBeNull();
    expect(value(K.finalDepth)?.status).toBe('unreviewed');
  });

  it('a state button toggles: set + approve, then reset to ok + unreviewed', () => {
    st().setState(K.finalDepth, 'not in source');
    expect(value(K.finalDepth)).toMatchObject({ state: 'not in source', status: 'approved' });
    expect(st().focusKey).toBe(K.finalDepth);
    st().setState(K.finalDepth, 'not in source');
    expect(value(K.finalDepth)).toMatchObject({ state: 'ok', status: 'unreviewed' });
    st().setState(K.finalDepth, 'illegible');
    st().setState(K.finalDepth, 'not in source');
    expect(value(K.finalDepth)).toMatchObject({ state: 'not in source', status: 'approved' });
  });
});

describe('CRS confirmation', () => {
  const TB05 = 'bh_TEST0000000000000000000005';
  /** A fictional borehole whose report prints coordinates without naming the CRS. */
  const inferred = (): Borehole =>
    makeBorehole({
      uid: TB05, id: 'TB-05', crs: { name: 'Fictional grid B', code: 'EPSG:0002', status: 'inferred' },
      onMap: false, lat: null, lng: null, unplottedReason: 'crs_unconfirmed',
      values: [
        makeValue({ key: K.boreholeId, value: 'TB-05', raw: 'TB 5' }),
        makeValue({ key: K.xy, value: '512000 / 5540000', raw: '512 000 / 5 540 000' }),
        makeValue({ key: K.crs, value: 'Fictional grid B', method: 'Guessed', kind: 'crs', box: { x: 0, y: 0, w: 0.1, h: 0.1 } }),
      ],
    });

  const CANDIDATES: CrsCandidate[] = [
    { name: 'Fictional grid A', code: 'EPSG:0001', note: 'shifted 2 km', score: 0.4, verdict: 'shifted', swapAxes: false, points: [{ uid: TB05, lat: 1.1, lng: 2.1 }] },
    { name: 'Fictional grid B', code: 'EPSG:0002', note: 'pins on site', score: 0.9, verdict: 'match', swapAxes: true, points: [{ uid: TB05, lat: 1.8, lng: 2.2 }] },
    { name: 'Fictional grid C', code: 'EPSG:0003', note: 'out of range', score: null, verdict: 'out_of_range', swapAxes: false, points: [] },
  ];

  async function openFor(over: Partial<DataSource> = {}) {
    return ready({ crsCandidates: async () => structuredClone(CANDIDATES), ...over }, [inferred(), makeBorehole()], TB05);
  }

  it('loads candidates, preselects the current CRS and reports loading', async () => {
    await openFor();
    const opening = st().openCrsDialog();
    expect(st()).toMatchObject({ crsDialogOpen: true, crsLoading: true, crsCandidates: [] });
    await opening;
    expect(st()).toMatchObject({ crsLoading: false, crsPick: 1 });
    expect(st().crsCandidates).toHaveLength(3);
  });

  it('sends the code, the swap-axes flag and your name, then reloads the document’s boreholes', async () => {
    const confirmCrs = vi.fn<DataSource['confirmCrs']>(async () => 2);
    const fake = await openFor({ confirmCrs });
    const placed: Borehole = { ...inferred(), revision: 2, crs: { name: 'Fictional grid B', code: 'EPSG:0002', status: 'confirmed' }, onMap: true, lat: 1.8, lng: 2.2, unplottedReason: null };
    const documentBoreholes = vi.fn<DataSource['documentBoreholes']>(async () => [placed, { ...makeBorehole(), revision: 2 }]);
    fake.documentBoreholes = documentBoreholes;
    st().setReviewerName('  A. Reviewer ');
    await st().openCrsDialog();
    await st().confirmCrs();
    expect(confirmCrs).toHaveBeenCalledWith(doc.id, { code: 'EPSG:0002', swapAxes: true, confirmedBy: 'A. Reviewer' } satisfies CrsConfirmation);
    expect(documentBoreholes).toHaveBeenCalledWith(doc.id);
    expect(st().crsDialogOpen).toBe(false);
    // The pins come from the server's records, not from the candidate's points.
    expect(bh(TB05)).toMatchObject({ crs: { status: 'confirmed' }, onMap: true, lat: 1.8, lng: 2.2, revision: 2 });
    expect(st().toast?.text).toBe('CRS confirmed for 2 boreholes in this report: Fictional grid B');
    st().setReviewerName('');
  });

  it('sends no name when none is set', async () => {
    const confirmCrs = vi.fn<DataSource['confirmCrs']>(async () => 1);
    await openFor({ confirmCrs });
    st().setReviewerName('');
    await st().openCrsDialog();
    st().pickCrs(0);
    await st().confirmCrs();
    expect(confirmCrs).toHaveBeenCalledWith(doc.id, { code: 'EPSG:0001', swapAxes: false, confirmedBy: null });
  });

  it('an out-of-range candidate cannot be confirmed', async () => {
    const confirmCrs = vi.fn<DataSource['confirmCrs']>(async () => 1);
    await openFor({ confirmCrs });
    await st().openCrsDialog();
    st().pickCrs(2);
    await st().confirmCrs();
    expect(confirmCrs).not.toHaveBeenCalled();
    expect(st().crsDialogOpen).toBe(true);
  });

  it('keeps the dialog open and toasts when the backend refuses', async () => {
    await openFor({ confirmCrs: () => Promise.reject(new Error('demo_mode')) });
    await st().openCrsDialog();
    await st().confirmCrs();
    expect(st().crsDialogOpen).toBe(true);
    expect(bh(TB05)?.crs.status).toBe('inferred');
    expect(st().toast?.text).toBe('Not saved: demo_mode');
  });

  it('ignores candidates that arrive after the dialog was closed', async () => {
    let resolve: (c: CrsCandidate[]) => void = () => undefined;
    await openFor({ crsCandidates: () => new Promise((r) => (resolve = r)) });
    const opening = st().openCrsDialog();
    st().escape();
    expect(st()).toMatchObject({ crsDialogOpen: false, crsLoading: false });
    resolve(structuredClone(CANDIDATES));
    await opening;
    expect(st().crsCandidates).toEqual([]);
  });
});

describe('search ranking', () => {
  const TB11 = 'bh_TEST0000000000000000000011';
  beforeEach(() => ready({}, [makeBorehole(), makeBorehole({ uid: TB11, id: 'TB-11' })]));

  it('matches IDs without the dash and zooms out for a partial match in a multi-borehole project', () => {
    useAppStore.setState({ query: 'tb1' });
    st().search();
    expect(st().mapFocus).toMatchObject({ uid: TB11, zoom: 11 });
  });

  it('falls back to the project name', () => {
    useAppStore.setState({ query: 'test project' });
    st().search();
    expect(st().mapFocus?.uid).toBe(UID);
  });

  it('ignores an empty query', () => {
    useAppStore.setState({ query: '   ' });
    st().search();
    expect(st().mapFocus).toBeNull();
    expect(st().searchMessage).toBe('');
  });
});

describe('upload review target', () => {
  const UP = 'bh_TEST_UP_000000000000000021';
  const base: DocumentSummary = makeDocument({ id: 'doc_TEST_UP', name: 'up.pdf', project: '', status: 'queued', step: 0, reviewBoreholeUid: null, uploaded: true });

  /** Uploads answer with `answer`; later states arrive as live events (`push`). */
  async function readyUploads(answer: DocumentSummary, over: Partial<DataSource> = {}) {
    const live = manualLive();
    const fake = await ready({
      upload: () => ({ done: Promise.resolve({ document: answer, duplicate: false }), cancel: () => undefined }),
      subscribe: live.subscribe,
      ...over,
    });
    st().startLive();
    const push = (d: DocumentSummary) => live.emit({ type: 'document.updated', document: d });
    return { fake, push };
  }

  it('points a freshly extracted document at its first borehole and keeps it on later updates', async () => {
    const extracted = makeBorehole({ uid: UP, id: 'TB-21', documentId: base.id, project: 'Uploaded Project (fictional)' });
    const documentBoreholes = vi.fn<DataSource['documentBoreholes']>(async () => [extracted]);
    const { fake, push } = await readyUploads(base, { documentBoreholes, getDocument: async () => base });
    expect(fake.kind).toBe('sample');
    st().addFiles([new File(['x'], 'up.pdf')]);
    await settle();
    expect(st().documents[0]).toMatchObject({ id: base.id, reviewBoreholeUid: null });
    push({ ...base, status: 'needs_review', step: 2 });
    await vi.waitFor(() => expect(st().documents.find((d) => d.id === base.id)?.reviewBoreholeUid).toBe(UP));
    expect(st().documents.find((d) => d.id === base.id)?.project).toBe('Uploaded Project (fictional)');
    expect(st().boreholes.map((b) => b.uid)).toContain(UP);
    push({ ...base, status: 'done', step: 3 });
    expect(st().documents.find((d) => d.id === base.id)?.reviewBoreholeUid).toBe(UP);
    expect(documentBoreholes).toHaveBeenCalledTimes(1);
  });

  it('a failed extraction gets no review target', async () => {
    const { push } = await readyUploads({ ...base, id: 'doc_TEST_BAD' });
    st().addFiles([new File(['x'], 'bad.pdf')]);
    await settle();
    push({ ...base, id: 'doc_TEST_BAD', status: 'failed', step: 2, error: 'parse failed' });
    expect(st().documents.find((d) => d.id === 'doc_TEST_BAD')?.reviewBoreholeUid).toBeNull();
  });
});

describe('export', () => {
  beforeEach(() => vi.mocked(downloadBlob).mockClear());

  it('exports every borehole of the document, approved values only unless drafts are included', async () => {
    const other = makeBorehole({ uid: 'bh_TEST_OTHER_00000000000009', id: 'TB-09', documentId: 'doc_TEST_OTHER' });
    const second = makeBorehole({ uid: 'bh_TEST0000000000000000000002', id: 'TB-02' });
    await ready({}, [makeBorehole(), second, other]);
    st().toggleApprove(K.finalDepth);
    await settle();
    await st().exportFile('csv');
    const [blob, name] = vi.mocked(downloadBlob).mock.calls[0];
    expect(name).toBe('test_tidy.csv');
    const text = await blob.text();
    expect(text).toContain('TB-01');
    expect(text).not.toContain('TB-09');
    expect(st().toast?.text).toBe('Tidy CSV: 1 values · approved only');

    st().toggleIncludeUnreviewed();
    await st().exportFile('csv');
    const [draftBlob, draftName] = vi.mocked(downloadBlob).mock.calls[1];
    expect(draftName).toBe('test_tidy_DRAFT.csv');
    const draft = await draftBlob.text();
    expect(draft).toContain('TB-02');
    expect(draft).not.toContain('TB-09');
  });
});

describe('reviewer name', () => {
  /** A tiny in-memory localStorage. */
  function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k) => m.get(k) ?? null,
      key: (i) => [...m.keys()][i] ?? null,
      removeItem: (k) => void m.delete(k),
      setItem: (k, v) => void m.set(k, String(v)),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ reviewerName: null });
  });

  it('is kept in localStorage, trimmed, and cleared with an empty name', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    st().setReviewerName('  A. Reviewer  ');
    expect(st().reviewerName).toBe('A. Reviewer');
    expect(storage.getItem(REVIEWER_NAME_KEY)).toBe('A. Reviewer');
    expect(readReviewerName()).toBe('A. Reviewer');
    st().setReviewerName('   ');
    expect(st().reviewerName).toBeNull();
    expect(storage.getItem(REVIEWER_NAME_KEY)).toBeNull();
  });

  it('works without storage: blocked access is ignored and the name stays for the session', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readReviewerName()).toBeNull();
    st().setReviewerName('A. Reviewer');
    expect(st().reviewerName).toBe('A. Reviewer');
  });
});
