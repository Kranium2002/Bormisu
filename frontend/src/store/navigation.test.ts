/**
 * F4 router and URL state in the store (fictional data): with a navigator injected, the navigation
 * actions go through the URL and the route drives screen, selection and review borehole; state within
 * a screen (map view, selected pin, focused value, selected layer) goes into the query with history
 * replace. Without a navigator the actions set the store directly (the other store tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { K } from '../domain/keys';
import type { Borehole } from '../domain/types';
import type { AppNavigator } from '../routing/navigator';
import { parseLocation, type AppRoute } from '../routing/urlState';
import { makeBorehole, makeDocument, makeLayer, makeValue } from '../test/fixtures';
import { useAppStore } from './appStore';
import { fakeSource, readyStore } from './testing';

const UID = makeBorehole().uid;
const UID2 = 'bh_TEST0000000000000000000002';
const OFF_MAP = 'bh_TEST0000000000000000000003';

/** TB-01 has an SPT refusal in layer 2 (its default layer) and values on two pages. */
const tb01: Borehole = makeBorehole({
  layers: [
    makeLayer({ n: 1, from: 0, to: 2.5 }),
    makeLayer({ n: 2, from: 2.5, to: 6, spt: { raw: '50/10', refusal: true, depth: null } }),
    makeLayer({ n: 3, from: 6, to: 8 }),
  ],
  pages: [1, 2],
  values: [...makeBorehole().values, makeValue({ key: K.elevation, value: '101.20', page: 2, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } })],
});
const tb02 = makeBorehole({ uid: UID2, id: 'TB-02', lat: 51, lng: 9 });
const off = makeBorehole({ uid: OFF_MAP, id: 'TB-03', onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });
const doc = makeDocument({ reviewBoreholeUid: UID });

const st = () => useAppStore.getState();

interface Call { to: string; replace: boolean }
let calls: Call[];

/** A navigator that records each call and reports the location back, as the router's sync does. */
function recordingNavigator(sync = true): AppNavigator {
  return {
    navigate(to, options) {
      calls.push({ to, replace: !!options?.replace });
      if (sync) {
        const url = new URL(to, 'http://localhost');
        st().applyRoute(parseLocation(url.pathname, url.search));
      }
    },
  };
}

/** Ready store on the map route with a navigator. */
async function onRoute(route: AppRoute = { kind: 'map', at: null, sel: null, rs: null }) {
  await readyStore(fakeSource({ boreholes: [tb01, tb02, off], documents: [doc] }));
  calls = [];
  st().setNavigator(recordingNavigator());
  st().applyRoute(route);
}

afterEach(() => vi.useRealTimers());

describe('navigation actions go through the navigator', () => {
  beforeEach(() => onRoute());

  it('go: a new history entry per screen; the store follows the route', () => {
    st().go('queue');
    expect(calls).toEqual([{ to: '/queue', replace: false }]);
    expect(st()).toMatchObject({ screen: 'queue', route: { kind: 'queue' } });
    // The URL it already shows is not navigated to again.
    st().go('queue');
    expect(calls).toHaveLength(1);
  });

  it('a map view equal to the URL (as rounded) writes nothing', async () => {
    st().setMapView({ lat: 50.000001, lng: 8, zoom: 6 });
    st().setMapView({ lat: 50.000002, lng: 8, zoom: 6 });
    expect(calls).toEqual([{ to: '/map?at=50,8,6', replace: true }]);
  });

  it('go("map") returns to the last map view and result set, without reopening a popup', () => {
    st().applyRoute({ kind: 'map', at: { lat: 50.1, lng: 8.2, zoom: 9 }, sel: UID, rs: 'rs_A' });
    st().go('queue');
    st().go('map');
    expect(calls.at(-1)).toEqual({ to: '/map?at=50.1,8.2,9&rs=rs_A', replace: false });
    expect(st().selectedUid).toBeNull();
  });

  it('openBorehole: /boreholes/:uid; detail of that borehole with its default layer', () => {
    st().openBorehole(UID);
    expect(calls).toEqual([{ to: `/boreholes/${UID}`, replace: false }]);
    expect(st()).toMatchObject({ screen: 'detail', selectedUid: UID, selectedLayer: 2 });
  });

  it('openReview: /review/:uid; switching boreholes in Review adds an entry too', () => {
    st().openReview(UID2);
    expect(calls).toEqual([{ to: `/review/${UID2}`, replace: false }]);
    expect(st()).toMatchObject({ screen: 'review', reviewUid: UID2, focusKey: K.boreholeId });
    st().openReview(UID);
    expect(calls[1]).toEqual({ to: `/review/${UID}`, replace: false });
    expect(st().reviewUid).toBe(UID);
  });

  it('openReview without a borehole goes to the review target; back there it keeps the focused value', () => {
    st().go('review');
    // The first document in review; its first value to review needs no key in the URL.
    expect(calls.at(-1)).toEqual({ to: `/review/${UID}`, replace: false });
    expect(st().reviewUid).toBe(UID);
    vi.useFakeTimers();
    st().focusValue(K.elevation);
    st().go('queue');
    st().go('review');
    expect(calls.at(-1)).toEqual({ to: `/review/${UID}?key=${K.elevation}`, replace: false });
    expect(st()).toMatchObject({ reviewUid: UID, focusKey: K.elevation });
  });

  it('openReview with nothing to review goes to /review (the "nothing to review" state)', async () => {
    await readyStore(fakeSource({ boreholes: [], documents: [] }));
    calls = [];
    st().setNavigator(recordingNavigator());
    st().applyRoute({ kind: 'queue' });
    st().openReview();
    expect(calls).toEqual([{ to: '/review', replace: false }]);
  });

  it('search from another screen: /map?sel=<uid> and the fly-to signal', () => {
    st().go('queue');
    useAppStore.setState({ query: 'TB-02' });
    st().search();
    expect(calls.at(-1)).toEqual({ to: `/map?sel=${UID2}`, replace: false });
    expect(st()).toMatchObject({ screen: 'map', selectedUid: UID2, mapFocus: { uid: UID2, zoom: 13 } });
  });

  it('search on the map changes only the query: history replace', () => {
    useAppStore.setState({ query: 'TB-02' });
    st().search();
    expect(calls).toEqual([{ to: `/map?sel=${UID2}`, replace: true }]);
  });

  it('search for a borehole not on the map goes to the map and keeps its message', () => {
    st().go('queue');
    useAppStore.setState({ query: 'TB-03' });
    st().search();
    expect(calls.at(-1)).toEqual({ to: '/map', replace: false });
    expect(st().screen).toBe('map');
    expect(st().searchMessage).toBe('TB-03: No coordinates in source. Listed under Not on map.');
    expect(st().mapFocus).toBeNull();
  });

  it('one navigation per action, also when the router reports the location only later', async () => {
    await readyStore(fakeSource({ boreholes: [tb01, tb02, off], documents: [doc] }));
    calls = [];
    st().setNavigator(recordingNavigator(false));
    st().applyRoute({ kind: 'map', at: null, sel: null, rs: null });
    st().openReview(UID2);
    // The store shows the route at once, so a following action works on it.
    st().focusValue(K.finalDepth, true);
    expect(st()).toMatchObject({ screen: 'review', reviewUid: UID2, focusKey: K.finalDepth });
    expect(calls).toEqual([{ to: `/review/${UID2}`, replace: false }]);
  });
});

describe('state within a screen goes into the query with history replace', () => {
  it('selectLayer: /boreholes/:uid?layer=n', async () => {
    await onRoute({ kind: 'detail', uid: UID, layer: null });
    st().selectLayer(3);
    expect(st().selectedLayer).toBe(3);
    expect(calls).toEqual([{ to: `/boreholes/${UID}?layer=3`, replace: true }]);
  });

  it('focusValue: /review/:uid?key=<key>, written once the focus rests (J/K repeat)', async () => {
    await onRoute({ kind: 'review', uid: UID, key: null });
    vi.useFakeTimers();
    st().focusValue(K.finalDepth);
    st().focusValue(K.elevation);
    expect(st().focusKey).toBe(K.elevation);
    expect(calls).toEqual([]);
    vi.runAllTimers();
    expect(calls).toEqual([{ to: `/review/${UID}?key=${K.elevation}`, replace: true }]);
  });

  it('a focus written after leaving Review is dropped, so it never takes the user back', async () => {
    await onRoute({ kind: 'review', uid: UID, key: null });
    vi.useFakeTimers();
    st().focusValue(K.finalDepth);
    st().go('queue');
    vi.runAllTimers();
    expect(calls).toEqual([{ to: '/queue', replace: false }]);
  });

  it('setMapView: /map?at=… (rounded), keeping sel and rs', async () => {
    await onRoute({ kind: 'map', at: null, sel: UID, rs: 'rs_A' });
    st().setMapView({ lat: 50.1234567, lng: 8.7654321, zoom: 10.25 });
    expect(calls).toEqual([{ to: `/map?at=50.12346,8.76543,10.25&sel=${UID}&rs=rs_A`, replace: true }]);
    expect(st().mapView).toEqual({ lat: 50.12346, lng: 8.76543, zoom: 10.25 });
  });

  it('selectOnMap: the open popup goes into sel, a closed one leaves it', async () => {
    await onRoute({ kind: 'map', at: { lat: 1, lng: 2, zoom: 3 }, sel: null, rs: null });
    st().selectOnMap(UID2);
    expect(st().selectedUid).toBe(UID2);
    st().selectOnMap(null);
    expect(calls).toEqual([
      { to: `/map?at=1,2,3&sel=${UID2}`, replace: true },
      { to: '/map?at=1,2,3', replace: true },
    ]);
  });

  it('a map that is going away (another screen already shows) changes nothing', async () => {
    await onRoute({ kind: 'map', at: { lat: 1, lng: 2, zoom: 3 }, sel: UID, rs: null });
    st().openBorehole(UID);
    calls = [];
    st().selectOnMap(null);
    st().setMapView({ lat: 0, lng: 0, zoom: 1 });
    expect(calls).toEqual([]);
    expect(st()).toMatchObject({ screen: 'detail', selectedUid: UID, mapView: { lat: 1, lng: 2, zoom: 3 } });
  });
});

describe('applyRoute: the URL drives the store (deep links, reload, Back)', () => {
  beforeEach(() => onRoute());

  it('/review/:uid?key=… opens that borehole on that value and its page', () => {
    st().applyRoute({ kind: 'review', uid: UID, key: K.elevation });
    expect(st()).toMatchObject({ screen: 'review', reviewUid: UID, focusKey: K.elevation, reviewPage: 2 });
  });

  it('an unknown key falls back to the first value to review', () => {
    st().applyRoute({ kind: 'review', uid: UID2, key: 'no-such-key' });
    expect(st()).toMatchObject({ reviewUid: UID2, focusKey: K.boreholeId });
  });

  it('Back to another value of the same borehole focuses it and scrolls the list to it', () => {
    st().applyRoute({ kind: 'review', uid: UID, key: K.finalDepth });
    st().applyRoute({ kind: 'review', uid: UID, key: K.elevation });
    expect(st()).toMatchObject({ focusKey: K.elevation, reviewPage: 2, listScroll: { key: K.elevation } });
  });

  it('an unknown uid keeps the last review borehole (the REVIEW link still has a target)', () => {
    st().applyRoute({ kind: 'review', uid: UID, key: null });
    st().applyRoute({ kind: 'review', uid: 'bh_NOPE', key: null });
    expect(st()).toMatchObject({ reviewUid: UID, route: { kind: 'review', uid: 'bh_NOPE' } });
    st().applyRoute({ kind: 'detail', uid: 'bh_NOPE', layer: null });
    expect(st().selectedUid).not.toBe('bh_NOPE');
  });

  it('/boreholes/:uid?layer=n restores the layer; a layer the borehole lacks gives the default', () => {
    st().applyRoute({ kind: 'detail', uid: UID, layer: 3 });
    expect(st()).toMatchObject({ screen: 'detail', selectedUid: UID, selectedLayer: 3 });
    st().applyRoute({ kind: 'detail', uid: UID, layer: 9 });
    expect(st().selectedLayer).toBe(2);
  });

  it('/map?at&sel&rs: view, selected pin and result set', () => {
    st().applyRoute({ kind: 'map', at: { lat: 50, lng: 8, zoom: 12 }, sel: UID2, rs: 'rs_B' });
    expect(st()).toMatchObject({ screen: 'map', mapView: { lat: 50, lng: 8, zoom: 12 }, selectedUid: UID2, resultSetId: 'rs_B' });
    // A uid that is not loaded selects nothing.
    st().applyRoute({ kind: 'map', at: null, sel: 'bh_NOPE', rs: null });
    expect(st().selectedUid).toBeNull();
  });

  it('leaving Review drops its transient UI: edit, approve-clean confirmation, CRS dialog', () => {
    st().applyRoute({ kind: 'review', uid: UID, key: null });
    st().startEdit(K.finalDepth, 'edit');
    useAppStore.setState({ confirmCleanOpen: true, crsDialogOpen: true, exportOpen: true });
    st().applyRoute({ kind: 'map', at: null, sel: null, rs: null });
    expect(st()).toMatchObject({ editing: null, confirmCleanOpen: false, crsDialogOpen: false, exportOpen: false });
  });

  it('the same route again changes nothing (an open edit stays)', () => {
    st().applyRoute({ kind: 'review', uid: UID, key: K.finalDepth });
    st().startEdit(K.finalDepth, 'edit');
    const before = st();
    st().applyRoute({ kind: 'review', uid: UID, key: K.finalDepth });
    expect(st()).toBe(before);
  });

  it('a page that does not exist leaves Review too', () => {
    st().applyRoute({ kind: 'review', uid: UID, key: null });
    st().startEdit(K.finalDepth, 'edit');
    st().applyRoute({ kind: 'notFound', path: '/nope' });
    expect(st()).toMatchObject({ editing: null, route: { kind: 'notFound', path: '/nope' } });
  });

  it('the side panel and a toast stay across routes', () => {
    st().openSource(UID, K.finalDepth);
    st().showToast('Saved');
    st().applyRoute({ kind: 'queue' });
    expect(st().panel).toMatchObject({ kind: 'source', uid: UID });
    expect(st().toast?.text).toBe('Saved');
  });
});

describe('without a navigator (unit tests of other slices)', () => {
  it('the actions set the screen directly and leave route and URL state alone', async () => {
    await readyStore(fakeSource({ boreholes: [tb01, tb02, off], documents: [doc] }));
    st().openBorehole(UID);
    expect(st()).toMatchObject({ screen: 'detail', selectedUid: UID, route: null });
    st().selectLayer(3);
    st().setMapView({ lat: 1, lng: 2, zoom: 3 });
    expect(st()).toMatchObject({ selectedLayer: 3, mapView: { lat: 1, lng: 2, zoom: 3 } });
  });
});
