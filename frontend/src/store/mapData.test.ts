/**
 * M2 map data in the store with fake sources (fictional data): the boot shape (documents, map
 * features, unplotted records), full records on demand with their load states (deep links, Review,
 * Detail, exports), header search over the features, keeping the features in step after each
 * trigger, result sets with their URL, and place search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { ApiError } from '../data/errors';
import { K } from '../domain/keys';
import type { Borehole, BoreholeFilter, Clarification, DocumentSummary, PlaceCandidate } from '../domain/types';
import type { AppNavigator } from '../routing/navigator';
import { parseLocation } from '../routing/urlState';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { fakeSource, featureOf, makeClarification, manualLive, readyStore, settle } from './testing';

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
vi.mock('../export/download', async (orig) => ({
  ...(await orig<typeof import('../export/download')>()),
  downloadBlob: vi.fn(),
}));
const { useAppStore } = await import('./appStore');
const { ensureRouteRecords } = await import('../routing/RouteSync');
const { downloadBlob } = await import('../export/download');
const { EMPTY_FILTER, NO_PLACE_FOUND, PLACE_SEARCH_UNAVAILABLE } = await import('./mapDataSlice');

const st = () => useAppStore.getState();
const bh = (uid: string) => st().boreholes.find((b) => b.uid === uid);

/* Fictional data: one document with two plotted boreholes and one off the map, and a second document. */
const DOC = 'doc_TEST0000000000000000000001';
const DOC2 = 'doc_TEST0000000000000000000002';
const A = makeBorehole({ uid: 'bh_TEST_A', id: 'TB-01', lat: 50, lng: 8 });
const B = makeBorehole({ uid: 'bh_TEST_B', id: 'TB-02', lat: 50.1, lng: 8.1, reviewStatus: 'approved' });
const OFF = makeBorehole({ uid: 'bh_TEST_OFF', id: 'TB-03', onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });
const OTHER = makeBorehole({ uid: 'bh_TEST_OTHER', id: 'XY-7', documentId: DOC2, project: 'Second Site (fictional)', sourceFile: 'second.pdf', lat: -36.8, lng: 174.7 });
const doc = makeDocument({ id: DOC, reviewBoreholeUid: null });
const doc2 = makeDocument({ id: DOC2, name: 'second.pdf', project: 'Second Site (fictional)', reviewBoreholeUid: null });

const data = () => ({ boreholes: [A, B, OFF, OTHER], documents: [doc, doc2] });

/** A fake source with spies on the reads the store makes. */
function spied(over: Partial<DataSource> = {}) {
  const fake = fakeSource(data(), over);
  const spies = {
    getBorehole: vi.fn(fake.getBorehole),
    documentBoreholes: vi.fn(fake.documentBoreholes),
    mapFeatures: vi.fn(fake.mapFeatures),
    unplotted: vi.fn(fake.unplotted),
  };
  Object.assign(fake, spies);
  return { fake, ...spies };
}

/** A ready store as right after the boot: features, NOT ON MAP records, no other full record. */
async function boot(over: Partial<DataSource> = {}) {
  const s = spied(over);
  current = s.fake;
  await readyStore(s.fake, null, { cache: 'boot' });
  return s;
}

interface Call { to: string; replace: boolean }
let calls: Call[] = [];
/** A navigator that records each call and reports the location back, as the router's sync does. */
function navigator(): AppNavigator {
  return {
    navigate(to, options) {
      calls.push({ to, replace: !!options?.replace });
      const url = new URL(to, 'http://localhost');
      st().applyRoute(parseLocation(url.pathname, url.search));
    },
  };
}
function withNavigator(path = '/map') {
  calls = [];
  st().setNavigator(navigator());
  const url = new URL(path, 'http://localhost');
  st().applyRoute(parseLocation(url.pathname, url.search));
}

afterEach(() => {
  st().setNavigator(null);
});

describe('boot', () => {
  beforeEach(() => {
    useAppStore.setState({ source: null, health: null, loadState: 'loading', boreholes: [], documents: [], features: [], unplottedUids: [] });
  });

  it('loads documents, the map features and the unplotted records; health first, then live updates, then the questions', async () => {
    const order: string[] = [];
    const live = manualLive();
    const questions: Clarification[] = [makeClarification({ id: 'cl_TEST_1', documentId: DOC })];
    const fake = fakeSource({ ...data(), clarifications: questions });
    const { health, load, clarifications } = fake;
    Object.assign(fake, {
      health: () => (order.push('health'), health()),
      load: () => (order.push('load'), load()),
      subscribe: (...a: Parameters<DataSource['subscribe']>) => (order.push('subscribe'), live.subscribe(...a)),
      clarifications: (o: Parameters<DataSource['clarifications']>[0]) => (order.push(`clarifications:${o?.status}`), clarifications(o)),
    });
    const getBorehole = vi.spyOn(fake, 'getBorehole');
    const documentBoreholes = vi.spyOn(fake, 'documentBoreholes');
    current = fake;
    await st().init();
    await settle();
    expect(order).toEqual(['health', 'load', 'subscribe', 'clarifications:open', 'clarifications:skipped']);
    expect(st().features.map((f) => f.uid)).toEqual([A.uid, B.uid, OTHER.uid]);
    // The cache of full records holds only the NOT ON MAP boreholes; nothing else was fetched.
    expect(st().boreholes.map((b) => b.uid)).toEqual([OFF.uid]);
    expect(st().unplottedUids).toEqual([OFF.uid]);
    expect(getBorehole).not.toHaveBeenCalled();
    expect(documentBoreholes).not.toHaveBeenCalled();
    // Each document's review target is its first pin (no record needed for the card's OPEN REVIEW).
    expect(st().documents.map((d) => d.reviewBoreholeUid)).toEqual([A.uid, OTHER.uid]);
    expect(st().clarifications.map((c) => c.id)).toEqual(['cl_TEST_1']);
    expect(st().clarificationsState).toBe('ready');
  });

  it('a document whose boreholes are all off the map points Review at its first one that Review can show', async () => {
    const off2 = makeBorehole({ uid: 'bh_TEST_OFF2', id: 'TB-04', documentId: DOC2, onMap: false, lat: null, lng: null, values: [] });
    const off3 = makeBorehole({ uid: 'bh_TEST_OFF3', id: 'TB-05', documentId: DOC2, onMap: false, lat: null, lng: null });
    current = fakeSource({ boreholes: [A, off2, off3], documents: [doc, doc2] });
    await st().init();
    expect(st().documents.find((d) => d.id === DOC2)?.reviewBoreholeUid).toBe(off3.uid);
  });

  it('a failing question list never blocks the app', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    current = fakeSource(data(), { clarifications: () => Promise.reject(new Error('down')) });
    await st().init();
    await settle();
    expect(st()).toMatchObject({ loadState: 'ready', clarificationsState: 'error' });
    warn.mockRestore();
  });
});

describe('full records on demand', () => {
  it('ensureBorehole fetches a pin’s record once, tracks loading, and then serves it from the cache', async () => {
    const { getBorehole } = await boot();
    const first = st().ensureBorehole(A.uid);
    const second = st().ensureBorehole(A.uid);
    // Loading is known at once, before any answer (no "not found" flash).
    expect(st().recordLoads[A.uid]).toBe('loading');
    expect(await first).toMatchObject({ uid: A.uid, id: 'TB-01' });
    expect(await second).toMatchObject({ uid: A.uid });
    expect(getBorehole).toHaveBeenCalledTimes(1);
    expect(st().recordLoads).toEqual({});
    expect(await st().ensureBorehole(A.uid)).toBe(bh(A.uid));
    expect(getBorehole).toHaveBeenCalledTimes(1);
  });

  it('a cached (unplotted) record needs no request', async () => {
    const { getBorehole } = await boot();
    expect(await st().ensureBorehole(OFF.uid)).toMatchObject({ uid: OFF.uid });
    expect(getBorehole).not.toHaveBeenCalled();
  });

  it('a uid the server does not have (404 borehole_not_found) is "missing"; any other failure is "error" and tried again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake } = await boot();
    expect(await st().ensureBorehole('bh_TEST_NOPE')).toBeNull();
    expect(st().recordLoads).toEqual({ bh_TEST_NOPE: 'missing' });
    fake.getBorehole = () => Promise.reject(new ApiError(503, 'internal_error', 'Try later.'));
    expect(await st().ensureBorehole(A.uid)).toBeNull();
    expect(st().recordLoads[A.uid]).toBe('error');
    fake.getBorehole = async (uid) => structuredClone(fake.held.get(uid)!);
    expect(await st().ensureBorehole(A.uid)).toMatchObject({ uid: A.uid });
    expect(st().recordLoads[A.uid]).toBeUndefined();
    warn.mockRestore();
  });

  it('ensureDocumentBoreholes loads a document once (one request at a time), then serves the cache', async () => {
    const { documentBoreholes } = await boot();
    const [a, b] = await Promise.all([st().ensureDocumentBoreholes(DOC), st().ensureDocumentBoreholes(DOC)]);
    expect(a.map((x) => x.uid).sort()).toEqual([A.uid, B.uid, OFF.uid].sort());
    expect(b).toHaveLength(3);
    expect(documentBoreholes).toHaveBeenCalledTimes(1);
    await st().ensureDocumentBoreholes(DOC);
    expect(documentBoreholes).toHaveBeenCalledTimes(1);
    // The other document's records are not loaded.
    expect(bh(OTHER.uid)).toBeUndefined();
  });

  it('a new pin of a loaded document makes the next ensure load the document again', async () => {
    const { fake, documentBoreholes } = await boot();
    await st().ensureDocumentBoreholes(DOC);
    const C = makeBorehole({ uid: 'bh_TEST_C', id: 'TB-06', lat: 50.2, lng: 8.2 });
    fake.held.set(C.uid, C);
    useAppStore.setState({ features: [...st().features, featureOf(C)!] });
    await st().ensureDocumentBoreholes(DOC);
    expect(documentBoreholes).toHaveBeenCalledTimes(2);
    expect(bh(C.uid)).toBeDefined();
  });

  it('a record asked for while its document loads comes with that load (one request)', async () => {
    const { getBorehole, documentBoreholes } = await boot();
    const docLoad = st().ensureDocumentBoreholes(DOC);
    const record = st().ensureBorehole(B.uid);
    expect(st().recordLoads[B.uid]).toBe('loading');
    await docLoad;
    expect(await record).toMatchObject({ uid: B.uid });
    expect(getBorehole).not.toHaveBeenCalled();
    expect(documentBoreholes).toHaveBeenCalledTimes(1);
  });

  it('a document load keeps the optimistic state of a pending save (takeBoreholes rules)', async () => {
    let answerSave: (b: Borehole) => void = () => undefined;
    const { fake } = await boot({ updateValue: () => new Promise((r) => (answerSave = r)) });
    await st().ensureBorehole(A.uid);
    useAppStore.setState({ reviewUid: A.uid });
    st().toggleApprove(K.finalDepth);
    await st().ensureDocumentBoreholes(DOC);
    expect(bh(A.uid)?.values.find((v) => v.key === K.finalDepth)?.status).toBe('approved');
    answerSave({ ...fake.held.get(A.uid)!, revision: 2, values: bh(A.uid)!.values });
    await vi.waitFor(() => expect(bh(A.uid)?.revision).toBe(2));
  });
});

describe('routes with on-demand records (RouteSync)', () => {
  /** What RouteSync does for a location: apply it, ask for its records, apply it again once they are there. */
  async function visit(path: string) {
    const url = new URL(path, 'http://localhost');
    const route = parseLocation(url.pathname, url.search);
    st().applyRoute(route);
    if (route.kind === 'review' || route.kind === 'detail') ensureRouteRecords(route.kind, route.uid);
    await vi.waitFor(() => expect(Object.values(st().recordLoads)).not.toContain('loading'));
    await settle();
    st().applyRoute(route);
  }

  it('a deep link to a pin’s Detail shows LOADING, then the borehole', async () => {
    await boot();
    withNavigator();
    const url = new URL(`/boreholes/${B.uid}`, 'http://localhost');
    st().applyRoute(parseLocation(url.pathname, url.search));
    ensureRouteRecords('detail', B.uid);
    expect(st().recordLoads[B.uid]).toBe('loading');
    await visit(`/boreholes/${B.uid}`);
    expect(st()).toMatchObject({ screen: 'detail', selectedUid: B.uid });
  });

  it('a deep link to a missing uid ends as "missing" (BOREHOLE NOT FOUND), never as loading forever', async () => {
    await boot();
    withNavigator();
    await visit('/review/bh_TEST_DOES_NOT_EXIST');
    expect(st().recordLoads).toEqual({ bh_TEST_DOES_NOT_EXIST: 'missing' });
    expect(st().screen).toBe('review');
    expect(st().reviewUid).not.toBe('bh_TEST_DOES_NOT_EXIST');
  });

  it('Review loads the record and its document’s records (for the CRS dialog, approve-clean and the switcher)', async () => {
    const { getBorehole, documentBoreholes } = await boot();
    withNavigator();
    await visit(`/review/${A.uid}`);
    expect(st()).toMatchObject({ screen: 'review', reviewUid: A.uid, focusKey: K.boreholeId });
    expect(bh(B.uid)).toBeDefined();
    expect(documentBoreholes).toHaveBeenCalledWith(DOC);
    // The pin named the document, so the record came with the document's records.
    expect(getBorehole).not.toHaveBeenCalled();
  });

  it('openReview / openBorehole and the queue card’s OPEN REVIEW work without the record cached', async () => {
    await boot();
    withNavigator('/queue');
    st().openReview(st().documents[0].reviewBoreholeUid!);
    expect(calls.at(-1)).toEqual({ to: `/review/${A.uid}`, replace: false });
    await visit(`/review/${A.uid}`);
    expect(st()).toMatchObject({ screen: 'review', reviewUid: A.uid });
    st().openBorehole(OTHER.uid);
    expect(calls.at(-1)).toEqual({ to: `/boreholes/${OTHER.uid}`, replace: false });
    await visit(`/boreholes/${OTHER.uid}`);
    expect(st()).toMatchObject({ screen: 'detail', selectedUid: OTHER.uid });
  });

  it('REVIEW (no borehole named) goes to a document’s target known only by its pin', async () => {
    await boot();
    withNavigator('/queue');
    st().go('review');
    expect(calls.at(-1)).toEqual({ to: `/review/${A.uid}`, replace: false });
  });

  it('without a navigator, openReview loads the record and focuses its first value once it is there', async () => {
    await boot();
    st().openReview(B.uid);
    expect(st()).toMatchObject({ screen: 'review', reviewUid: B.uid, focusKey: null });
    await vi.waitFor(() => expect(st().focusKey).toBe(K.boreholeId));
    expect(bh(A.uid)).toBeDefined();
  });

  it('a selected pin in the map URL is kept although its record is not loaded', async () => {
    await boot();
    withNavigator(`/map?sel=${B.uid}`);
    expect(st().selectedUid).toBe(B.uid);
  });
});

describe('exports load the document’s records first', () => {
  beforeEach(() => vi.mocked(downloadBlob).mockClear());

  it('exports exactly the rows a fully cached store exports', async () => {
    // Reference: every record cached (as before on-demand loading).
    const ref = fakeSource(data());
    await readyStore(ref, A.uid);
    await st().exportFile('csv');
    const expected = await vi.mocked(downloadBlob).mock.calls[0][0].text();

    const { documentBoreholes } = await boot();
    await st().ensureBorehole(A.uid);
    useAppStore.setState({ selectedUid: A.uid });
    await st().exportFile('csv');
    expect(documentBoreholes).toHaveBeenCalledWith(DOC);
    const [blob, name] = vi.mocked(downloadBlob).mock.calls[1];
    expect(name).toBe('test_tidy.csv');
    expect(await blob.text()).toBe(expected);
    expect(st().toast?.text).toMatch(/^Tidy CSV: \d+ values · approved only$/);
  });

  it('a failed load explains itself and downloads nothing', async () => {
    await boot({ documentBoreholes: () => Promise.reject(new Error('offline')) });
    await st().ensureBorehole(A.uid);
    useAppStore.setState({ selectedUid: A.uid });
    await st().exportFile('xlsx');
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(st().toast?.text).toBe('Export failed: offline');
  });
});

describe('header search over the map features', () => {
  beforeEach(() => boot());

  it('finds a pin by its exact ID first and flies to it, without its full record', () => {
    useAppStore.setState({ query: 'tb-02' });
    st().search();
    expect(st().mapFocus).toMatchObject({ uid: B.uid, zoom: 13 });
    expect(bh(B.uid)).toBeUndefined();
  });

  it('prefers the exact ID over a partial match', () => {
    const tb021 = featureOf(makeBorehole({ uid: 'bh_TEST_021', id: 'TB-021' }))!;
    useAppStore.setState({ features: [tb021, ...st().features], query: 'TB-02' });
    st().search();
    expect(st().mapFocus?.uid).toBe(B.uid);
  });

  it('explains a borehole that is not on the map with its reason', () => {
    useAppStore.setState({ query: 'TB-03' });
    st().search();
    expect(st().searchMessage).toBe('TB-03: No coordinates in source. Shown in LIST.');
    expect(st().mapFocus).toBeNull();
  });

  it('falls back to the project name and zooms out for a project with several boreholes', () => {
    useAppStore.setState({ query: 'second site' });
    st().search();
    expect(st().mapFocus).toMatchObject({ uid: OTHER.uid, zoom: 13 });
    useAppStore.setState({ query: 'tb0' });
    st().search();
    expect(st().mapFocus).toMatchObject({ uid: A.uid, zoom: 11 });
  });
});

describe('keeping the features in step', () => {
  it('approve-clean reloads the document’s pins', async () => {
    const { mapFeatures } = await boot();
    await st().ensureDocumentBoreholes(DOC);
    expect(st().features.find((f) => f.uid === A.uid)?.reviewStatus).toBe('unreviewed');
    useAppStore.setState({ reviewUid: A.uid, confirmCleanOpen: true, cleanCount: 1 });
    await st().approveClean();
    await vi.waitFor(() => expect(mapFeatures).toHaveBeenCalledWith(DOC));
    // Every value of the fictional borehole is clean: the pin turns approved.
    await vi.waitFor(() => expect(st().features.find((f) => f.uid === A.uid)?.reviewStatus).toBe('approved'));
  });

  it('a CRS confirmation reloads the whole map layer and the NOT ON MAP list', async () => {
    const placed = { ...OFF, revision: 2, onMap: true, lat: 50.3, lng: 8.3, unplottedReason: null, crs: { ...OFF.crs, status: 'confirmed' as const } };
    const { fake, mapFeatures, unplotted } = await boot({
      crsCandidates: async () => [{ name: 'Fictional grid', code: 'EPSG:0001', note: null, score: 1, verdict: 'match', swapAxes: false, points: [] }],
    });
    fake.confirmCrs = async () => {
      fake.held.set(OFF.uid, placed);
      return 1;
    };
    useAppStore.setState({ reviewUid: OFF.uid });
    await st().openCrsDialog();
    await st().confirmCrs();
    await vi.waitFor(() => expect(st().unplottedUids).toEqual([]));
    expect(mapFeatures).toHaveBeenCalledWith();
    expect(unplotted).toHaveBeenCalled();
    expect(st().features.find((f) => f.uid === OFF.uid)).toMatchObject({ lat: 50.3, lng: 8.3 });
    expect(bh(OFF.uid)?.onMap).toBe(true);
  });

  it('refreshMap replaces the features and the NOT ON MAP list; calls while it runs lead to one more reload', async () => {
    const { fake, mapFeatures } = await boot();
    fake.held.delete(OFF.uid);
    const first = st().refreshMap();
    const second = st().refreshMap();
    await Promise.all([first, second]);
    expect(mapFeatures).toHaveBeenCalledTimes(2);
    expect(st().unplottedUids).toEqual([]);
  });
});

describe('result sets', () => {
  const filterOf = (calls: [BoreholeFilter][]) => calls.map(([f]) => f);

  it('applyFilter runs the panel’s filter with the area, shows the set and its pins, and puts its id in the URL', async () => {
    const { fake } = await boot();
    const createResultSet = vi.fn(fake.createResultSet);
    fake.createResultSet = createResultSet;
    withNavigator('/map?at=50,8,9');
    st().setFilter({ search: 'TB', minDepth: 2 });
    st().setFilter({ hasSpt: null });
    const running = st().applyFilter();
    expect(st().resultSetBusy).toBe(true);
    await running;
    expect(filterOf(createResultSet.mock.calls)).toEqual([{ ...EMPTY_FILTER, search: 'TB', minDepth: 2 }]);
    const rs = st().resultSet!;
    expect(rs.uids).toEqual([A.uid, B.uid, OFF.uid]);
    expect(st().resultSetFeatures?.map((f) => f.uid)).toEqual([A.uid, B.uid]);
    expect(st()).toMatchObject({ resultSetBusy: false, resultSetError: null, resultSetId: rs.id });
    expect(calls.at(-1)).toEqual({ to: `/map?at=50,8,9&rs=${rs.id}`, replace: true });
    // The map flies to the set.
    expect(st().mapOutline).toMatchObject({ bbox: rs.bbox, outline: false });
  });

  it('selectArea sends the drawn area with the panel’s filter', async () => {
    const { fake } = await boot();
    const createResultSet = vi.fn(fake.createResultSet);
    fake.createResultSet = createResultSet;
    st().setFilter({ includeUnreviewed: false });
    await st().selectArea({ type: 'bbox', bbox: [7.9, 49.9, 8.05, 50.05] });
    expect(createResultSet.mock.calls[0][0]).toMatchObject({ includeUnreviewed: false, area: { type: 'bbox', bbox: [7.9, 49.9, 8.05, 50.05] } });
    expect(st().filter.area).toEqual({ type: 'bbox', bbox: [7.9, 49.9, 8.05, 50.05] });
    // Only approved boreholes inside the box: none.
    expect(st().resultSet).toMatchObject({ count: 0, bbox: [7.9, 49.9, 8.05, 50.05] });
  });

  it('a 422 shows the server’s detail and keeps the set shown before', async () => {
    await boot();
    await st().applyFilter();
    const before = st().resultSet;
    useAppStore.setState({ source: Object.assign(st().source!, { createResultSet: () => Promise.reject(new ApiError(422, 'validation_error', 'min_depth_m must not exceed max_depth_m.')) }) });
    await st().applyFilter();
    expect(st()).toMatchObject({ resultSetBusy: false, resultSetError: 'min_depth_m must not exceed max_depth_m.' });
    expect(st().resultSet).toBe(before);
  });

  it('a reload with ?rs= restores the set (showResultSet), fitted when the URL has no view', async () => {
    const { fake } = await boot();
    const made = await fake.createResultSet({ ...EMPTY_FILTER, project: 'Second Site (fictional)' });
    withNavigator(`/map?rs=${made.id}`);
    expect(st().resultSetId).toBe(made.id);
    await st().showResultSet(made.id, { fit: true });
    expect(st().resultSet?.id).toBe(made.id);
    expect(st().resultSetFeatures?.map((f) => f.uid)).toEqual([OTHER.uid]);
    expect(st().mapOutline?.bbox).toEqual(made.bbox);
    // The URL already named it: no navigation.
    expect(calls).toEqual([]);
  });

  it('showResultSet from another screen goes to the map with the set; asking again is the same request', async () => {
    const { fake } = await boot();
    const made = await fake.createResultSet({ ...EMPTY_FILTER });
    const getResultSet = vi.fn(fake.getResultSet);
    fake.getResultSet = getResultSet;
    withNavigator('/queue');
    const a = st().showResultSet(made.id);
    const b = st().showResultSet(made.id);
    expect(calls).toEqual([{ to: `/map?rs=${made.id}`, replace: false }]);
    await Promise.all([a, b]);
    expect(getResultSet).toHaveBeenCalledTimes(1);
    expect(st().resultSet?.id).toBe(made.id);
    // No fit asked: the map keeps its view.
    expect(st().mapOutline).toBeNull();
  });

  it('an unknown or expired id shows the server’s detail', async () => {
    await boot();
    await st().showResultSet('rs_TEST_GONE');
    expect(st()).toMatchObject({ resultSet: null, resultSetBusy: false, resultSetError: 'Result set rs_TEST_GONE not found.' });
  });

  it('an answer for a set the URL no longer names (Back) is ignored; Back drops the set shown', async () => {
    const { fake } = await boot();
    const made = await fake.createResultSet({ ...EMPTY_FILTER });
    let answer: (v: Awaited<ReturnType<DataSource['getResultSet']>>) => void = () => undefined;
    const real = fake.getResultSet;
    fake.getResultSet = () => new Promise((r) => (answer = r));
    withNavigator('/map');
    const showing = st().showResultSet(made.id);
    st().applyRoute({ kind: 'map', at: null, sel: null, rs: null });
    answer(await real(made.id));
    await showing;
    expect(st().resultSet).toBeNull();
    expect(st().resultSetBusy).toBe(false);
    // A set that is shown goes when the URL stops naming it.
    fake.getResultSet = real;
    await st().showResultSet(made.id);
    expect(st().resultSet?.id).toBe(made.id);
    st().applyRoute({ kind: 'map', at: null, sel: null, rs: null });
    expect(st()).toMatchObject({ resultSet: null, resultSetFeatures: null, resultSetId: null });
  });

  it('clearResultSet ("Reset") clears the set, the area and the panel, and takes rs out of the URL', async () => {
    await boot();
    withNavigator('/map?at=50,8,9');
    await st().selectArea({ type: 'circle', center: [8, 50], radiusM: 500 });
    st().setFilter({ project: 'Test Project (fictional)' });
    st().clearResultSet();
    expect(st()).toMatchObject({ resultSet: null, resultSetFeatures: null, resultSetError: null, resultSetId: null });
    expect(st().filter).toEqual(EMPTY_FILTER);
    expect(calls.at(-1)).toEqual({ to: '/map?at=50,8,9', replace: true });
  });

  it('the reset filter has nothing set and includes unreviewed boreholes', () => {
    expect(EMPTY_FILTER).toEqual({
      search: null, country: null, project: null, documentId: null, minDepth: null, maxDepth: null, dinCodes: [],
      lithologyMinDepth: null, hasSpt: null, hasGroundwater: null, reviewStatus: [], includeUnreviewed: true, area: null,
    });
  });
});

describe('place search', () => {
  const place = (o: Partial<PlaceCandidate>): PlaceCandidate => ({
    label: 'Fictional Town', lat: 50, lng: 8, bbox: [7.9, 49.9, 8.2, 50.2], source: 'geocoder', kind: 'city', boreholeCount: null, ...o,
  });

  it('ignores a blank query and never calls the geocoder for it', async () => {
    const geocode = vi.fn<DataSource['geocode']>(async () => []);
    await boot({ geocode });
    await st().searchPlace('   ');
    expect(geocode).not.toHaveBeenCalled();
    expect(st().places).toBeNull();
  });

  it('one candidate flies there; a place with pins inside is not outlined', async () => {
    const geocode = vi.fn<DataSource['geocode']>(async () => [place({ boreholeCount: null })]);
    await boot({ geocode });
    const running = st().searchPlace('  Fictional Town ');
    expect(st()).toMatchObject({ placeBusy: true, placeQuery: 'Fictional Town' });
    await running;
    expect(geocode).toHaveBeenCalledWith('Fictional Town');
    expect(st()).toMatchObject({ placeBusy: false, placeError: null, mapOutline: { bbox: [7.9, 49.9, 8.2, 50.2], outline: false } });
    expect(st().places).toHaveLength(1);
  });

  it('a place with no uploaded borehole is outlined dashed: count 0 or unknown, and no pin inside', async () => {
    let answer = [place({ boreholeCount: 0, bbox: [100, -10, 101, -9] })];
    await boot({ geocode: async () => answer });
    await st().searchPlace('Empty Town');
    expect(st().mapOutline).toMatchObject({ bbox: [100, -10, 101, -9], outline: true });
    const n1 = st().mapOutline!.nonce;
    answer = [place({ boreholeCount: null, bbox: [100, -10, 101, -9] })];
    await st().searchPlace('Empty Place');
    expect(st().mapOutline).toMatchObject({ outline: true });
    expect(st().mapOutline!.nonce).not.toBe(n1);
    // Pins inside the box (e.g. uploaded after the server counted): they show, no outline.
    answer = [place({ boreholeCount: 0, bbox: [7.9, 49.9, 8.2, 50.2] })];
    await st().searchPlace('Fictional Town');
    expect(st().mapOutline).toMatchObject({ outline: false });
    // The server counts boreholes inside: never outlined.
    answer = [place({ boreholeCount: 4, bbox: [100, -10, 101, -9] })];
    await st().searchPlace('Busy Town');
    expect(st().mapOutline).toMatchObject({ outline: false });
  });

  it('several candidates are listed in the server’s order (uploaded first); choosePlace flies to one', async () => {
    const list = [place({ label: 'Site Office (uploaded)', source: 'uploaded', boreholeCount: 3 }), place({ label: 'Fictional Town', bbox: [100, -10, 101, -9], boreholeCount: 0 })];
    await boot({ geocode: async () => list });
    await st().searchPlace('Fictional');
    expect(st().places?.map((p) => p.label)).toEqual(['Site Office (uploaded)', 'Fictional Town']);
    expect(st().mapOutline).toBeNull();
    st().choosePlace(1);
    expect(st().mapOutline).toMatchObject({ bbox: [100, -10, 101, -9], outline: true });
    const n = st().mapOutline!.nonce;
    st().choosePlace(1);
    expect(st().mapOutline!.nonce).not.toBe(n);
    st().choosePlace(7);
    expect(st().mapOutline!.bbox).toEqual([100, -10, 101, -9]);
  });

  it('a place without a box flies to its point and is not outlined', async () => {
    await boot({ geocode: async () => [place({ bbox: null, lat: 51.5, lng: 7.5 })] });
    await st().searchPlace('Point');
    expect(st().mapOutline).toMatchObject({ bbox: [7.5, 51.5, 7.5, 51.5], outline: false });
  });

  it('none says "No place found"; a 503 says "Place search unavailable"', async () => {
    const { fake } = await boot({ geocode: async () => [] });
    await st().searchPlace('Nowhere');
    expect(st()).toMatchObject({ places: [], placeError: NO_PLACE_FOUND, placeBusy: false });
    fake.geocode = () => Promise.reject(new ApiError(503, 'geocoder_unavailable', 'The geocoder is unavailable.'));
    await st().searchPlace('Anywhere');
    expect(st()).toMatchObject({ places: null, placeError: PLACE_SEARCH_UNAVAILABLE, placeBusy: false });
  });

  it('an older answer is ignored when a newer search was sent', async () => {
    const answers: ((p: PlaceCandidate[]) => void)[] = [];
    await boot({ geocode: () => new Promise((r) => answers.push(r)) });
    const first = st().searchPlace('First');
    const second = st().searchPlace('Second');
    answers[1]([place({ label: 'Second' })]);
    answers[0]([place({ label: 'First' }), place({ label: 'Other' })]);
    await Promise.all([first, second]);
    expect(st().places?.map((p) => p.label)).toEqual(['Second']);
  });
});

describe('documents', () => {
  it('a document deleted while its records load leaves nothing behind', async () => {
    let answer: (b: Borehole[]) => void = () => undefined;
    const live = manualLive();
    const { fake } = await boot({ subscribe: live.subscribe });
    fake.documentBoreholes = () => new Promise((r) => (answer = r));
    st().startLive();
    const loading = st().ensureDocumentBoreholes(DOC);
    live.emit({ type: 'document.deleted', documentId: DOC });
    answer([structuredClone(A), structuredClone(B)]);
    await loading;
    expect(st().boreholes.filter((b) => b.documentId === DOC)).toEqual([]);
    expect(st().features.filter((f) => f.documentId === DOC)).toEqual([]);
    expect(st().unplottedUids).toEqual([]);
  });

  it('a document that reaches review again reloads only the records already fetched on demand', async () => {
    const live = manualLive();
    const { fake, documentBoreholes, mapFeatures } = await boot({ subscribe: live.subscribe });
    st().startLive();
    await st().ensureDocumentBoreholes(DOC);
    expect(documentBoreholes).toHaveBeenCalledTimes(1);
    // A retry ran the document again; the server's records changed.
    fake.held.set(A.uid, { ...A, revision: 5 });
    live.emit({ type: 'document.updated', document: { ...doc, status: 'queued', step: 0 } });
    live.emit({ type: 'document.updated', document: { ...doc, status: 'needs_review', step: 2 } });
    await vi.waitFor(() => expect(bh(A.uid)?.revision).toBe(5));
    expect(documentBoreholes).toHaveBeenCalledTimes(2);
    // The other document's records were never fetched: only its pins are reloaded.
    live.emit({ type: 'document.updated', document: { ...doc2, status: 'queued', step: 0 } });
    live.emit({ type: 'document.updated', document: { ...doc2, status: 'needs_review', step: 2 } });
    await vi.waitFor(() => expect(mapFeatures).toHaveBeenCalledWith(DOC2));
    await settle();
    expect(documentBoreholes).toHaveBeenCalledTimes(2);
    expect(bh(OTHER.uid)).toBeUndefined();
  });

  it('withReviewTarget fills the project from the pins when the document has none', async () => {
    await boot();
    const update: DocumentSummary = { ...doc2, project: '', reviewBoreholeUid: null };
    st().documentUpdated(update);
    expect(st().documents.find((d) => d.id === DOC2)).toMatchObject({ reviewBoreholeUid: OTHER.uid, project: 'Second Site (fictional)' });
  });
});

describe('the NOT ON MAP list follows the records shown', () => {
  it('a record fetched for a pin that turns out unplotted moves to NOT ON MAP', async () => {
    const { fake } = await boot();
    fake.held.set(B.uid, { ...B, revision: 2, onMap: false, lat: null, lng: null, unplottedReason: 'implausible' });
    await st().ensureBorehole(B.uid);
    expect(st().unplottedUids).toContain(B.uid);
    expect(st().features.map((f) => f.uid)).not.toContain(B.uid);
  });
});
