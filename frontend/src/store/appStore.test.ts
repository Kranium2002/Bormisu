import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { K } from '../domain/keys';
import type { Borehole, DocumentSummary } from '../domain/types';
import { makeBorehole, makeValue } from '../test/fixtures';
import { useAppStore } from './appStore';

const doc: DocumentSummary = {
  id: 'doc', name: 'test_report.pdf', project: 'Test Project (fictional)', pageTypes: ['text', 'log'], step: 2,
  counts: null, completeness: null, reviewBoreholeUid: 'doc:TB-01',
};

function fakeSource(over: Partial<DataSource> = {}): DataSource {
  const other: Borehole = makeBorehole({ uid: 'doc:TB-02', id: 'TB-02', onMap: false, lat: null, lng: null, unplottedReason: 'No coordinates in source' });
  return {
    kind: 'sample',
    load: async () => ({ boreholes: [makeBorehole(), other], documents: [doc] }),
    getPage: async (documentId, page) => ({ documentId, page, type: 'log', usage: 'used', label: `page ${page}`, items: [] }),
    upload: async () => undefined,
    updateValue: async () => undefined,
    crsCandidates: async () => [],
    confirmCrs: async () => undefined,
    ...over,
  };
}

const st = () => useAppStore.getState();
const value = (key: string) => st().boreholes.find((b) => b.uid === 'doc:TB-01')?.values.find((v) => v.key === key);

async function ready(source: DataSource = fakeSource()) {
  useAppStore.setState({ source, boreholes: [], documents: [], pages: {}, panel: null, editing: null, toast: null });
  // Bypass init(), which would create the configured data source instead of the fake one.
  const { boreholes, documents } = await source.load();
  useAppStore.setState({ loadState: 'ready', boreholes, documents, reviewUid: 'doc:TB-01', focusKey: null, screen: 'map' });
}

describe('review actions', () => {
  beforeEach(() => ready());

  it('approves optimistically and toggles back', () => {
    st().toggleApprove(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('approved');
    expect(st().focusKey).toBe(K.finalDepth);
    st().toggleApprove(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('unreviewed');
  });

  it('rolls back and toasts when saving fails', async () => {
    await ready(fakeSource({ updateValue: () => Promise.reject(new Error('offline')) }));
    st().toggleApprove(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('approved');
    await vi.waitFor(() => expect(value(K.finalDepth)?.status).toBe('unreviewed'));
    expect(st().toast?.text).toBe('Not saved: offline');
  });

  it('saves an edit as Edited + approved and keeps the AI value', () => {
    st().startEdit(K.finalDepth, 'edit');
    expect(st().editing).toEqual({ key: K.finalDepth, mode: 'edit', text: '6.00' });
    st().setEditText('6.50');
    st().saveEdit();
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited', status: 'approved', aiValue: '6.00' });
    expect(st().boreholes[0].finalDepth).toBe(6.5);
    expect(st().editing).toBeNull();
  });

  it('flags with a reason and unflags', () => {
    st().toggleFlag(K.finalDepth);
    expect(st().editing?.mode).toBe('flag');
    st().setEditText('odd');
    st().saveEdit();
    expect(value(K.finalDepth)).toMatchObject({ status: 'flagged', flag: 'odd' });
    st().toggleFlag(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('unreviewed');
    expect(value(K.finalDepth)?.flag).toBeUndefined();
  });

  it('sets a field state and approves it', () => {
    st().setState(K.boreholeId, 'illegible');
    expect(value(K.boreholeId)).toMatchObject({ state: 'illegible', status: 'approved' });
  });

  it('approves all clean values after asking', () => {
    st().askClean();
    expect(st().confirmCleanOpen).toBe(true);
    st().approveClean();
    expect(st().confirmCleanOpen).toBe(false);
    expect(st().boreholes[0].values.every((v) => v.status === 'approved')).toBe(true);
    expect(st().toast?.text).toBe('7 clean values approved');
  });
});

describe('escape', () => {
  beforeEach(() => ready());

  it('closes one layer per press: editing, confirm, export, CRS dialog, panel', () => {
    useAppStore.setState({
      editing: { key: 'x', mode: 'edit', text: '' }, confirmCleanOpen: true, exportOpen: true, crsDialogOpen: true,
      panel: { kind: 'completeness', documentId: 'doc' },
    });
    const open = () => [!!st().editing, st().confirmCleanOpen, st().exportOpen, st().crsDialogOpen, !!st().panel];
    expect(open()).toEqual([true, true, true, true, true]);
    for (let i = 0; i < 5; i++) st().escape();
    expect(open()).toEqual([false, false, false, false, false]);
    useAppStore.setState({ exportOpen: true, panel: { kind: 'completeness', documentId: 'doc' } });
    st().escape();
    expect(open()).toEqual([false, false, false, false, true]);
  });
});

describe('search', () => {
  beforeEach(() => ready());

  it('flies to an exact ID on the map', () => {
    useAppStore.setState({ screen: 'queue', query: 'tb-01' });
    st().search();
    expect(st().screen).toBe('map');
    expect(st().mapFocus).toMatchObject({ uid: 'doc:TB-01', zoom: 13 });
  });

  it('explains boreholes that are not on the map', () => {
    useAppStore.setState({ query: 'TB-02' });
    st().search();
    expect(st().searchMessage).toBe('TB-02: No coordinates in source. Listed under Not on map.');
  });

  it('reports no results', () => {
    useAppStore.setState({ query: 'zzz' });
    st().search();
    expect(st().searchMessage).toBe('No results for “zzz”');
  });
});

describe('navigation and panels', () => {
  beforeEach(() => ready());

  it('opens a borehole on the detail screen and a value in the source panel', () => {
    st().openBorehole('doc:TB-01');
    expect(st().screen).toBe('detail');
    expect(st().selectedUid).toBe('doc:TB-01');
    st().openSource('doc:TB-01', K.finalDepth);
    expect(st().panel).toEqual({ kind: 'source', uid: 'doc:TB-01', key: K.finalDepth, documentId: 'doc', page: 1, box: null });
  });

  it('opens review on the CRS when it is inferred', () => {
    const b = makeBorehole({
      uid: 'doc:TB-09', crs: { name: 'X', code: null, status: 'inferred' },
      values: [makeValue({ key: K.boreholeId, page: 1 }), makeValue({ key: K.crs, page: 2, box: { x: 0, y: 0, w: 0.1, h: 0.1 } })],
    });
    useAppStore.setState({ boreholes: [...st().boreholes, b] });
    st().openReview('doc:TB-09');
    expect(st()).toMatchObject({ screen: 'review', reviewUid: 'doc:TB-09', focusKey: K.crs, reviewPage: 2 });
  });

  it('loads pages into the cache once', async () => {
    const getPage = vi.fn(fakeSource().getPage);
    await ready(fakeSource({ getPage }));
    await st().loadPage('doc', 2);
    await st().loadPage('doc', 2);
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(st().pages['doc:2']?.status).toBe('ready');
  });
});

describe('uploads', () => {
  beforeEach(() => ready());

  it('rejects unsupported files and passes the rest to the source', async () => {
    const upload = vi.fn<DataSource['upload']>(async (_files, onUpdate) => {
      onUpdate({ ...doc, id: 'new', name: 'a.pdf', step: 0, uploaded: true });
    });
    await ready(fakeSource({ upload }));
    await st().addFiles([new File(['x'], 'a.pdf'), new File(['x'], 'notes.txt')]);
    expect(st().dropError).toBe('File type not supported: notes.txt');
    expect(upload.mock.calls[0][0].map((f) => f.name)).toEqual(['a.pdf']);
    expect(st().documents.map((d) => d.id)).toEqual(['new', 'doc']);
  });
});
