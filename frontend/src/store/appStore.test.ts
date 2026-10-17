import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { K } from '../domain/keys';
import type { Borehole, DocumentSummary } from '../domain/types';
import { makeBorehole, makeValue } from '../test/fixtures';
import { useAppStore } from './appStore';

/**
 * init() gets its source from createDataSource once and keeps it. The mock hands it a proxy that
 * forwards to `initSource.current`, so each test can swap the fake source behind it.
 */
const initSource = vi.hoisted(() => ({ current: null as DataSource | null }));
vi.mock('../data/createDataSource', async (orig) => ({
  ...(await orig<typeof import('../data/createDataSource')>()),
  createDataSource: async () =>
    new Proxy({} as DataSource, { get: (_target, prop) => (initSource.current ? Reflect.get(initSource.current, prop) : undefined) }),
}));

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

  it('closes one layer per press: confirm, editing, export, CRS dialog, panel', () => {
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
    expect(st().flyTarget).toMatchObject({ uid: 'doc:TB-01', zoom: 13 });
  });

  it('explains boreholes that are not on the map', () => {
    useAppStore.setState({ query: 'TB-02' });
    st().search();
    expect(st().searchMessage).toBe('TB-02: No coordinates in source. Shown in LIST as not on map.');
  });

  it('reports no results', () => {
    useAppStore.setState({ query: 'zzz' });
    st().search();
    expect(st().searchMessage).toBe('No results for “zzz”');
  });

  it('showNotOnMap explains a search target the map could not place after all', () => {
    st().showNotOnMap('TB-09', 'No usable coordinates');
    expect(st().searchMessage).toBe('TB-09: No usable coordinates. Shown in LIST as not on map.');
  });
});

describe('my location', () => {
  beforeEach(() => ready());
  afterEach(() => vi.unstubAllGlobals());

  const stubGeo = (getCurrentPosition: Geolocation['getCurrentPosition'], isSecureContext = true) => {
    vi.stubGlobal('window', { isSecureContext });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
  };

  it('locateMe: locating, then the fix (in memory only) and NEAR YOU open', async () => {
    let answer: PositionCallback | undefined;
    stubGeo((ok) => {
      answer = ok;
    });
    useAppStore.setState({ myLocation: { status: 'idle' }, nearYouOpen: false });
    const done = st().locateMe();
    expect(st().myLocation).toEqual({ status: 'locating' });
    answer?.({ coords: { latitude: 48.79, longitude: 9.18, accuracy: 14 } } as GeolocationPosition);
    await done;
    expect(st().myLocation).toMatchObject({ status: 'located', lat: 48.79, lng: 9.18, accuracyM: 14, simulated: false });
    expect(st().nearYouOpen).toBe(true);
  });

  it('locateMe: a denied permission and an insecure page show their messages', async () => {
    stubGeo((_, err) => err?.({ code: 1 } as GeolocationPositionError));
    await st().locateMe();
    expect(st().myLocation).toEqual({
      status: 'error',
      message: 'Location permission denied. Allow it in the browser to see boreholes near you.',
    });
    stubGeo(() => undefined, false);
    await st().locateMe();
    expect(st().myLocation).toEqual({ status: 'error', message: 'Location needs HTTPS (or localhost).' });
  });

  it('simulateLocation works with the sample source only', async () => {
    useAppStore.setState({ myLocation: { status: 'idle' }, nearYouOpen: false });
    st().simulateLocation(48.7912, 9.1846);
    expect(st().myLocation).toMatchObject({ status: 'located', lat: 48.7912, lng: 9.1846, accuracyM: 25, simulated: true });

    await ready(fakeSource({ kind: 'api' }));
    useAppStore.setState({ myLocation: { status: 'idle' }, nearYouOpen: false });
    st().simulateLocation(48.7912, 9.1846);
    expect(st().myLocation).toEqual({ status: 'idle' });
    expect(st().nearYouOpen).toBe(false);
  });

  it('Escape closes NEAR YOU, then the location message', () => {
    useAppStore.setState({ nearYouOpen: true, myLocation: { status: 'error', message: 'x' } });
    st().escape();
    expect(st().nearYouOpen).toBe(false);
    st().escape();
    expect(st().myLocation).toEqual({ status: 'idle' });
  });
});

describe('map focus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts on world when neither ?focus= nor VITE_MAP_FOCUS is set', () => {
    expect(st().mapFocus).toBe('world');
  });

  it('setMapFocus normalises the value and keeps ?focus= in sync without a reload', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'http://localhost:5173/?other=1#x', search: '?other=1' },
      history: { state: { keep: true }, replaceState },
    });
    st().setMapFocus('de');
    expect(st().mapFocus).toBe('DE');
    expect(replaceState).toHaveBeenLastCalledWith({ keep: true }, '', '/?other=1&focus=DE#x');
    st().setMapFocus('nonsense');
    expect(st().mapFocus).toBe('world');
    expect(replaceState).toHaveBeenLastCalledWith({ keep: true }, '', '/?other=1&focus=world#x');
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

describe('init', () => {
  it('int-01: takes documentsUnavailable from load and resets it on retry', async () => {
    initSource.current = fakeSource({ load: async () => ({ boreholes: [makeBorehole()], documents: [], documentsUnavailable: true }) });
    await st().init();
    expect(st()).toMatchObject({ loadState: 'ready', documentsUnavailable: true, documents: [] });

    initSource.current = fakeSource({ load: () => Promise.reject(new Error('Backend endpoint not available: GET /api/v1/boreholes')) });
    const retry = st().init();
    expect(st()).toMatchObject({ loadState: 'loading', documentsUnavailable: false });
    await retry;
    expect(st()).toMatchObject({ loadState: 'error', documentsUnavailable: false });

    initSource.current = fakeSource();
    await st().init();
    expect(st()).toMatchObject({ loadState: 'ready', documentsUnavailable: false });
    expect(st().documents.map((d) => d.id)).toEqual(['doc']);
  });

  it('int-12: asks the backend health once per load and keeps its mode', async () => {
    const health = vi.fn<NonNullable<DataSource['health']>>(async () => ({ mode: 'demo' }));
    initSource.current = fakeSource({ health });
    await st().init();
    await vi.waitFor(() => expect(st().backendMode).toBe('demo'));
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('int-12: no health check, no answer or a failing one leaves the mode unknown', async () => {
    useAppStore.setState({ backendMode: null });
    initSource.current = fakeSource();
    await st().init();
    expect(st().backendMode).toBeNull();

    initSource.current = fakeSource({ health: async () => null });
    await st().init();
    await Promise.resolve();
    expect(st().backendMode).toBeNull();

    initSource.current = fakeSource({ health: () => Promise.reject(new Error('Cannot reach the Bormisu backend')) });
    await st().init();
    await new Promise((r) => setTimeout(r, 0));
    expect(st()).toMatchObject({ loadState: 'ready', backendMode: null, toast: null });
  });
});
