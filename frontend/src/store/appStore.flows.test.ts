/** Store flows with non-trivial transitions: approve all clean, edit vs flag, states, CRS confirmation, search, uploads, export. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { K } from '../domain/keys';
import { boreholeStatus } from '../domain/review';
import type { Borehole, CrsCandidate, DocumentSummary } from '../domain/types';
import { makeBorehole, makeValue } from '../test/fixtures';
import { useAppStore } from './appStore';

vi.mock('../export/download', async (orig) => ({
  ...(await orig<typeof import('../export/download')>()),
  downloadBlob: vi.fn(),
}));
const { downloadBlob } = await import('../export/download');

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

async function ready(source: DataSource = fakeSource(), reviewUid = 'doc:TB-01') {
  useAppStore.setState({
    source, boreholes: [], documents: [], pages: {}, panel: null, editing: null, toast: null,
    crsDialogOpen: false, crsLoading: false, crsCandidates: [], crsPick: 0, confirmCleanOpen: false,
    flyTarget: null, searchMessage: '', includeUnreviewed: false, exportOpen: false,
  });
  // Bypass init(), which would create the configured data source instead of the fake one.
  const { boreholes, documents } = await source.load();
  useAppStore.setState({ loadState: 'ready', boreholes, documents, reviewUid, selectedUid: reviewUid, focusKey: null, screen: 'map' });
}

const withBoreholes = (...boreholes: Borehole[]) =>
  fakeSource({ load: async () => ({ boreholes: structuredClone(boreholes), documents: [doc] }) });

/** TB-05: a borehole with an inferred CRS, as in a report that prints Gauss-Krüger coordinates without naming the CRS. */
const inferred = (): Borehole =>
  makeBorehole({
    uid: 'doc:TB-05', id: 'TB-05', crs: { name: 'DHDN / GK zone 3', code: 'EPSG:31467', status: 'inferred' },
    values: [
      makeValue({ key: K.boreholeId, value: 'TB-05', raw: 'TB 5' }),
      makeValue({ key: K.xy, value: '3513420 / 5405870', raw: 'R 3513420 H 5405870' }),
      makeValue({ key: K.crs, value: 'DHDN / GK zone 3', method: 'Guessed', kind: 'crs', box: { x: 0, y: 0, w: 0.1, h: 0.1 } }),
    ],
  });

const CANDIDATES: CrsCandidate[] = [
  { name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', note: 'shifted 2 km', verdict: 'shifted', points: [{ uid: 'doc:TB-05', lat: 48.1, lng: 9.1 }] },
  { name: 'DHDN / 3-degree Gauss-Krüger zone 3', code: 'EPSG:31467', note: 'pins on site', verdict: 'match', points: [{ uid: 'doc:TB-05', lat: 48.8, lng: 9.2 }] },
  { name: 'WGS 84', code: 'EPSG:4326', note: 'out of range', verdict: 'out_of_range', points: [] },
];

describe('approve all clean', () => {
  it('approves only unreviewed Read values without lint, flag or state, and counts them', async () => {
    const b = makeBorehole({
      values: [
        makeValue({ key: 'a', value: '1' }),
        makeValue({ key: 'b', value: '2', method: 'OCR' }),
        makeValue({ key: 'c', value: '3', lint: { severity: 'warning', message: 'odd' } }),
        makeValue({ key: 'd', value: '4', status: 'flagged', flag: 'look' }),
        makeValue({ key: 'e', value: '', state: 'illegible' }),
        makeValue({ key: 'f', value: '6', status: 'approved' }),
        makeValue({ key: 'g', value: '7' }),
      ],
    });
    await ready(withBoreholes(b));
    st().askClean();
    expect(st().confirmCleanOpen).toBe(true);
    st().approveClean();
    const status = Object.fromEntries((bh()?.values ?? []).map((v) => [v.key, v.status]));
    expect(status).toEqual({ a: 'approved', b: 'unreviewed', c: 'unreviewed', d: 'flagged', e: 'unreviewed', f: 'approved', g: 'approved' });
    expect(st().toast?.text).toBe('2 clean values approved');
  });

  it('does not open the confirmation when nothing is clean', async () => {
    await ready(withBoreholes(makeBorehole({ values: [makeValue({ key: 'a', method: 'Guessed' })] })));
    st().askClean();
    expect(st().confirmCleanOpen).toBe(false);
  });
});

describe('edit vs flag', () => {
  beforeEach(() => ready());

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
  async function openFor(over: Partial<DataSource> = {}) {
    await ready(
      fakeSource({
        load: async () => ({ boreholes: [inferred(), makeBorehole()], documents: [doc] }),
        crsCandidates: async () => structuredClone(CANDIDATES),
        ...over,
      }),
      'doc:TB-05',
    );
  }

  it('loads candidates, preselects the current CRS and reports loading', async () => {
    await openFor();
    const opening = st().openCrsDialog();
    expect(st()).toMatchObject({ crsDialogOpen: true, crsLoading: true, crsCandidates: [] });
    await opening;
    expect(st()).toMatchObject({ crsLoading: false, crsPick: 1 });
    expect(st().crsCandidates).toHaveLength(3);
  });

  it('confirming turns every borehole of the document from inferred to confirmed', async () => {
    const confirmCrs = vi.fn<DataSource['confirmCrs']>(async () => undefined);
    await openFor({ confirmCrs });
    await st().openCrsDialog();
    expect(boreholeStatus(bh('doc:TB-05')!)).toBe('attention');
    await st().confirmCrs();
    expect(confirmCrs).toHaveBeenCalledWith('doc', 'EPSG:31467');
    expect(st().crsDialogOpen).toBe(false);
    expect(bh('doc:TB-05')).toMatchObject({ crs: { status: 'confirmed', code: 'EPSG:31467' }, lat: 48.8, lng: 9.2 });
    expect(value(K.crs, 'doc:TB-05')).toMatchObject({ status: 'approved', method: 'Guessed', value: 'DHDN / 3-degree Gauss-Krüger zone 3' });
    expect(boreholeStatus(bh('doc:TB-05')!)).toBe('unreviewed');
    // The other borehole of the same document is confirmed too.
    expect(bh('doc:TB-01')?.crs.status).toBe('confirmed');
    expect(st().toast?.text).toBe('CRS confirmed for all boreholes in this report: EPSG:31467');
  });

  it('a shifted candidate marks the CRS value Edited; out of range cannot be confirmed', async () => {
    const confirmCrs = vi.fn<DataSource['confirmCrs']>(async () => undefined);
    await openFor({ confirmCrs });
    await st().openCrsDialog();
    st().pickCrs(2);
    await st().confirmCrs();
    expect(confirmCrs).not.toHaveBeenCalled();
    expect(st().crsDialogOpen).toBe(true);
    st().pickCrs(0);
    await st().confirmCrs();
    expect(value(K.crs, 'doc:TB-05')?.method).toBe('Edited');
  });

  it('keeps the dialog open and toasts when the backend refuses', async () => {
    await openFor({ confirmCrs: () => Promise.reject(new Error('demo_mode')) });
    await st().openCrsDialog();
    await st().confirmCrs();
    expect(st().crsDialogOpen).toBe(true);
    expect(bh('doc:TB-05')?.crs.status).toBe('inferred');
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
  beforeEach(() => ready(withBoreholes(makeBorehole(), makeBorehole({ uid: 'doc:TB-11', id: 'TB-11' }))));

  it('matches IDs without the dash and zooms out for a partial match in a multi-borehole project', () => {
    useAppStore.setState({ query: 'tb1' });
    st().search();
    expect(st().flyTarget).toMatchObject({ uid: 'doc:TB-11', zoom: 11 });
  });

  it('falls back to the project name', () => {
    useAppStore.setState({ query: 'test project' });
    st().search();
    expect(st().flyTarget?.uid).toBe('doc:TB-01');
  });

  it('ignores an empty query', () => {
    useAppStore.setState({ query: '   ' });
    st().search();
    expect(st().flyTarget).toBeNull();
    expect(st().searchMessage).toBe('');
  });
});

describe('upload review target', () => {
  it('points a freshly extracted document at its first borehole and keeps it on later polls', async () => {
    const extracted = makeBorehole({ uid: 'up:TB-21', id: 'TB-21', documentId: 'up', project: 'Uploaded Project' });
    const base: DocumentSummary = { ...doc, id: 'up', name: 'up.pdf', project: '', step: 0, reviewBoreholeUid: null, uploaded: true };
    let push: (d: DocumentSummary) => void = () => undefined;
    const load = vi.fn(async () => ({ boreholes: [makeBorehole(), extracted], documents: [doc] }));
    await ready(
      fakeSource({
        upload: async (_files, onUpdate) => {
          push = onUpdate;
          onUpdate(base);
        },
      }),
    );
    useAppStore.setState((s) => ({ source: s.source && { ...s.source, load } }));
    await st().addFiles([new File(['x'], 'up.pdf')]);
    expect(st().documents[0]).toMatchObject({ id: 'up', reviewBoreholeUid: null });
    push({ ...base, step: 2 });
    await vi.waitFor(() => expect(st().documents.find((d) => d.id === 'up')?.reviewBoreholeUid).toBe('up:TB-21'));
    expect(st().documents.find((d) => d.id === 'up')?.project).toBe('Uploaded Project');
    expect(st().boreholes.map((b) => b.uid)).toContain('up:TB-21');
    push({ ...base, step: 3 });
    expect(st().documents.find((d) => d.id === 'up')?.reviewBoreholeUid).toBe('up:TB-21');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failed extraction gets no review target', async () => {
    let push: (d: DocumentSummary) => void = () => undefined;
    await ready(fakeSource({ upload: async (_f, onUpdate) => void (push = onUpdate) }));
    await st().addFiles([new File(['x'], 'bad.pdf')]);
    push({ ...doc, id: 'bad', step: 2, reviewBoreholeUid: null, error: 'parse failed' });
    expect(st().documents.find((d) => d.id === 'bad')?.reviewBoreholeUid).toBeNull();
  });
});

describe('export', () => {
  beforeEach(() => vi.mocked(downloadBlob).mockClear());

  it('exports every borehole of the document, approved values only unless drafts are included', async () => {
    const other = makeBorehole({ uid: 'x:TB-09', id: 'TB-09', documentId: 'x' });
    const second = makeBorehole({ uid: 'doc:TB-02', id: 'TB-02' });
    await ready(withBoreholes(makeBorehole(), second, other));
    st().toggleApprove(K.finalDepth);
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
