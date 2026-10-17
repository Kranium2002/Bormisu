/** F4: the app's URLs, built and read in one place (fictional uids and keys). */
import { describe, expect, it } from 'vitest';
import {
  boreholePath,
  formatMapView,
  inboxPath,
  mapPath,
  parseLocation,
  parseMapView,
  reviewPath,
  routePath,
  sameScreen,
  type AppRoute,
} from './urlState';

const UID = 'bh_01TESTFICTIONAL0000000001';

describe('parseLocation', () => {
  it('reads the map with its view, selection and result set', () => {
    expect(parseLocation('/map', '?at=48.12345,9.5,11.25&sel=' + UID + '&rs=rs_1')).toEqual({
      kind: 'map',
      at: { lat: 48.12345, lng: 9.5, zoom: 11.25 },
      sel: UID,
      rs: 'rs_1',
    });
    expect(parseLocation('/map', '')).toEqual({ kind: 'map', at: null, sel: null, rs: null });
    // An encoded comma reads the same as a literal one.
    expect(parseLocation('/map', '?at=1%2C2%2C3')).toMatchObject({ at: { lat: 1, lng: 2, zoom: 3 } });
  });

  it('reads the queue, review and borehole routes with their query state', () => {
    expect(parseLocation('/queue', '')).toEqual({ kind: 'queue' });
    expect(parseLocation('/review', '')).toEqual({ kind: 'reviewIndex' });
    expect(parseLocation(`/review/${UID}`, '?key=layer%5B2%5D.spt')).toEqual({ kind: 'review', uid: UID, key: 'layer[2].spt' });
    expect(parseLocation(`/review/${UID}`, '')).toEqual({ kind: 'review', uid: UID, key: null });
    expect(parseLocation(`/boreholes/${UID}`, '?layer=3')).toEqual({ kind: 'detail', uid: UID, layer: 3 });
    expect(parseLocation(`/boreholes/${UID}`, '')).toEqual({ kind: 'detail', uid: UID, layer: null });
  });

  it('decodes uids (a sample uid has a colon) and tolerates a trailing slash', () => {
    expect(parseLocation('/boreholes/nb%3ABK-07', '')).toMatchObject({ kind: 'detail', uid: 'nb:BK-07' });
    expect(parseLocation('/boreholes/nb:BK-07/', '')).toMatchObject({ kind: 'detail', uid: 'nb:BK-07' });
    expect(parseLocation('/map/', '')).toMatchObject({ kind: 'map' });
  });

  it('ignores query values that are not valid instead of guessing', () => {
    expect(parseLocation(`/boreholes/${UID}`, '?layer=0')).toMatchObject({ layer: null });
    expect(parseLocation(`/boreholes/${UID}`, '?layer=2.5')).toMatchObject({ layer: null });
    expect(parseLocation(`/boreholes/${UID}`, '?layer=abc')).toMatchObject({ layer: null });
    expect(parseLocation(`/review/${UID}`, '?key=')).toMatchObject({ key: null });
    expect(parseLocation('/map', '?sel=&rs=')).toMatchObject({ sel: null, rs: null });
  });

  it('anything else is not found, with the path it was asked for', () => {
    for (const path of ['/inbox/cl_1', '/inboxes', '/boreholes', '/boreholes/a/b', '/review/a/b', '/mapx', '/map/extra', '/boreholes/%E0%A4%A']) {
      expect(parseLocation(path, ''), path).toEqual({ kind: 'notFound', path });
    }
  });

  it('F12: reads the inbox with the question whose dialog is open', () => {
    expect(parseLocation('/inbox', '')).toEqual({ kind: 'inbox', q: null });
    expect(parseLocation('/inbox/', '?q=cl_01TESTFICTIONAL')).toEqual({ kind: 'inbox', q: 'cl_01TESTFICTIONAL' });
    expect(parseLocation('/inbox', '?q=cl%3A1%202')).toEqual({ kind: 'inbox', q: 'cl:1 2' });
    // An empty q is no question.
    expect(parseLocation('/inbox', '?q=')).toEqual({ kind: 'inbox', q: null });
  });

  it('the root shows the map (the router redirects it to /map once the data is loaded)', () => {
    expect(parseLocation('/', '')).toEqual({ kind: 'map', at: null, sel: null, rs: null });
    expect(parseLocation('', '')).toEqual({ kind: 'map', at: null, sel: null, rs: null });
  });
});

describe('map view (at)', () => {
  it('rounds to about a metre and two zoom decimals, without trailing zeros', () => {
    expect(formatMapView({ lat: 48.123456789, lng: -9.5, zoom: 11.256 })).toBe('48.12346,-9.5,11.26');
    expect(formatMapView({ lat: -0.000001, lng: 0, zoom: 2 })).toBe('0,0,2');
  });

  it('parses three finite numbers with a latitude on the globe and a usable zoom', () => {
    expect(parseMapView('-36.85,174.76,12')).toEqual({ lat: -36.85, lng: 174.76, zoom: 12 });
    for (const bad of ['', '1,2', '1,2,3,4', 'a,2,3', '1,,3', '91,0,3', '-91,0,3', '1,2,-1', '1,2,31', '1,Infinity,3', ' , ,']) {
      expect(parseMapView(bad), bad).toBeNull();
    }
  });

  it('round-trips', () => {
    const v = { lat: 51.50735, lng: -0.12776, zoom: 9.5 };
    expect(parseMapView(formatMapView(v))).toEqual(v);
  });
});

describe('paths', () => {
  it('builds the map URL with only the parts that are set', () => {
    expect(mapPath({ at: null, sel: null, rs: null })).toBe('/map');
    expect(mapPath({ at: { lat: 1.5, lng: 2, zoom: 3 }, sel: UID, rs: 'rs 1' })).toBe(`/map?at=1.5,2,3&sel=${UID}&rs=rs%201`);
    expect(mapPath({ at: null, sel: 'nb:BK-07', rs: null })).toBe('/map?sel=nb%3ABK-07');
  });

  it('builds review and borehole URLs; the query part is optional', () => {
    expect(reviewPath(UID)).toBe(`/review/${UID}`);
    expect(reviewPath(UID, 'layer[2].spt')).toBe(`/review/${UID}?key=layer%5B2%5D.spt`);
    expect(boreholePath('nb:BK-07')).toBe('/boreholes/nb%3ABK-07');
    expect(boreholePath(UID, 4)).toBe(`/boreholes/${UID}?layer=4`);
  });

  it('F12: builds the inbox URL, with the open question when given', () => {
    expect(inboxPath()).toBe('/inbox');
    expect(inboxPath(null)).toBe('/inbox');
    expect(inboxPath('cl_01TESTFICTIONAL')).toBe('/inbox?q=cl_01TESTFICTIONAL');
    expect(inboxPath('cl:1 2')).toBe('/inbox?q=cl%3A1%202');
  });

  it('every route reads back as itself', () => {
    const routes: AppRoute[] = [
      { kind: 'map', at: { lat: 10, lng: 20, zoom: 5 }, sel: 'nb:BK-07', rs: 'r' },
      { kind: 'map', at: null, sel: null, rs: null },
      { kind: 'queue' },
      { kind: 'reviewIndex' },
      { kind: 'review', uid: 'nb:BK-07', key: 'GW[0]' },
      { kind: 'detail', uid: UID, layer: 2 },
      { kind: 'inbox', q: null },
      { kind: 'inbox', q: 'cl_01TESTFICTIONAL' },
    ];
    for (const r of routes) {
      const url = new URL(routePath(r), 'http://localhost');
      expect(parseLocation(url.pathname, url.search), routePath(r)).toEqual(r);
    }
  });
});

describe('sameScreen', () => {
  it('is the same screen when kind and borehole match; query state does not count', () => {
    expect(sameScreen({ kind: 'map', at: null, sel: null, rs: null }, { kind: 'map', at: { lat: 1, lng: 2, zoom: 3 }, sel: UID, rs: null })).toBe(true);
    expect(sameScreen({ kind: 'review', uid: UID, key: null }, { kind: 'review', uid: UID, key: 'BoreholeDepth' })).toBe(true);
    expect(sameScreen({ kind: 'review', uid: UID, key: null }, { kind: 'review', uid: 'other', key: null })).toBe(false);
    expect(sameScreen({ kind: 'detail', uid: UID, layer: 1 }, { kind: 'review', uid: UID, key: null })).toBe(false);
    expect(sameScreen(null, { kind: 'queue' })).toBe(false);
    // Opening or closing a question's dialog stays on the inbox (history replace).
    expect(sameScreen({ kind: 'inbox', q: null }, { kind: 'inbox', q: 'cl_1' })).toBe(true);
    expect(sameScreen({ kind: 'inbox', q: null }, { kind: 'queue' })).toBe(false);
  });
});
