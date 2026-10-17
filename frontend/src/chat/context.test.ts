/**
 * The chat request's context (contract ChatContext, FRONTEND.md F14), built from the store when a
 * message is sent: selection, active result set, filters in the wire shape, map_view only for an
 * area drawn for the chat or "This map area", units, language and include unreviewed. Fictional data.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { toWireFilter } from '../data/adapters';
import { emptyFilter } from '../store/mapDataSlice';
import { useAppStore } from '../store/appStore';
import { fakeSource, readyStore } from '../store/testing';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { areaBbox, buildChatContext, filterIsEmpty, viewOffReason, visibleBbox, type ContextState } from './context';
import { contextNow } from './session';

const base = (o: Partial<ContextState> = {}): ContextState => ({
  screen: 'map',
  selectedUid: null,
  reviewUid: null,
  resultSet: null,
  resultSetId: null,
  filter: emptyFilter(),
  mapView: null,
  chatArea: null,
  chatUseView: false,
  chatIncludeUnreviewed: false,
  ...o,
});

const ENV = { language: 'de-DE', mapSize: { width: 800, height: 600 } };

describe('buildChatContext', () => {
  it('sends nothing the user did not set: no selection, set, filters or map view; units m; the browser language', () => {
    expect(buildChatContext(base(), ENV)).toEqual({
      selected_uids: [],
      active_result_set_id: null,
      filters: null,
      map_view: null,
      units: 'm',
      ui_language: 'de-DE',
      include_unreviewed: false,
    });
  });

  it('carries the selected borehole (the one in Review on that screen) and the active result set', () => {
    expect(buildChatContext(base({ selectedUid: 'bh_TEST_1', resultSetId: 'rs_TEST_1' }), ENV)).toMatchObject({
      selected_uids: ['bh_TEST_1'],
      active_result_set_id: 'rs_TEST_1',
    });
    expect(buildChatContext(base({ screen: 'review', selectedUid: 'bh_TEST_1', reviewUid: 'bh_TEST_2' }), ENV).selected_uids).toEqual(['bh_TEST_2']);
  });

  it('carries the filter panel in the contract’s shape once something is set', () => {
    const filter = { ...emptyFilter(), minDepth: 15, dinCodes: ['S'] };
    const ctx = buildChatContext(base({ filter }), ENV);
    expect(ctx.filters).toEqual(toWireFilter(filter));
    expect(ctx.filters).toMatchObject({ min_depth_m: 15 });
    expect(filterIsEmpty(emptyFilter())).toBe(true);
    expect(filterIsEmpty({ ...emptyFilter(), includeUnreviewed: false })).toBe(true);
    expect(filterIsEmpty({ ...emptyFilter(), project: 'Fictional' })).toBe(false);
  });

  it('include_unreviewed follows the drawer’s toggle; no language when the browser names none', () => {
    const ctx = buildChatContext(base({ chatIncludeUnreviewed: true }), { language: null, mapSize: null });
    expect(ctx.include_unreviewed).toBe(true);
    expect(ctx.ui_language).toBeNull();
  });

  it('map_view is the area drawn for the chat (request_area), with the map’s zoom', () => {
    const ctx = buildChatContext(base({ chatArea: { type: 'bbox', bbox: [8.1, 50.2, 8.3, 50.4] }, mapView: { lat: 50.3, lng: 8.2, zoom: 11 } }), ENV);
    expect(ctx.map_view).toEqual({ bbox: [8.1, 50.2, 8.3, 50.4], zoom: 11 });
  });

  it('map_view is the visible map only with "This map area" on, on the map screen', () => {
    const mapView = { lat: 0, lng: 0, zoom: 2 };
    expect(buildChatContext(base({ mapView }), ENV).map_view).toBeNull();
    const on = buildChatContext(base({ mapView, chatUseView: true }), ENV).map_view;
    expect(on?.zoom).toBe(2);
    // 800 px of a 1024 px world wide: 281.25° of longitude, centred on 0.
    expect(on?.bbox[0]).toBeCloseTo(-140.625, 4);
    expect(on?.bbox[2]).toBeCloseTo(140.625, 4);
    expect(on!.bbox[1]).toBeLessThan(0);
    expect(on!.bbox[3]).toBeGreaterThan(0);
    expect(buildChatContext(base({ mapView, chatUseView: true, screen: 'queue' }), ENV).map_view).toBeNull();
    expect(buildChatContext(base({ mapView, chatUseView: true }), { ...ENV, mapSize: null }).map_view).toBeNull();
  });
});

describe('geometry helpers', () => {
  it('areaBbox of a bbox, a polygon and a circle', () => {
    expect(areaBbox({ type: 'bbox', bbox: [1, 2, 3, 4] })).toEqual([1, 2, 3, 4]);
    expect(areaBbox({ type: 'polygon', polygon: { type: 'Polygon', coordinates: [[[1, 2], [5, 2], [3, 6], [1, 2]]] } })).toEqual([1, 2, 5, 6]);
    const c = areaBbox({ type: 'circle', center: [0, 0], radiusM: 111_320 });
    expect(c[0]).toBeCloseTo(-1, 1);
    expect(c[3]).toBeCloseTo(1, 1);
  });

  it('visibleBbox stays inside the world', () => {
    const b = visibleBbox({ lat: 80, lng: 170, zoom: 1 }, { width: 2000, height: 2000 });
    expect(b[0]).toBeGreaterThanOrEqual(-180);
    expect(b[2]).toBeLessThanOrEqual(180);
    expect(b[1]).toBeGreaterThanOrEqual(-90);
    expect(b[3]).toBeLessThanOrEqual(90);
  });

  it('"This map area" is off away from the map, with the reason', () => {
    expect(viewOffReason({ screen: 'queue', mapView: null }, false)).toBe('Open the map to ask about the area it shows');
    expect(viewOffReason({ screen: 'map', mapView: null }, true)).toBe('The map has no view yet');
    expect(viewOffReason({ screen: 'map', mapView: { lat: 1, lng: 2, zoom: 3 } }, true)).toBeNull();
  });
});

describe('contextNow (the context of a message sent now)', () => {
  beforeEach(async () => {
    await readyStore(fakeSource({ boreholes: [makeBorehole()], documents: [makeDocument()] }), makeBorehole().uid);
  });

  it('reads the store, and an area drawn for the chat goes with this message only', () => {
    useAppStore.setState({ chatIncludeUnreviewed: true });
    useAppStore.getState().requestChatArea('Draw it');
    useAppStore.getState().setChatArea({ type: 'bbox', bbox: [8, 50, 9, 51] });
    const first = contextNow();
    expect(first.selected_uids).toEqual([makeBorehole().uid]);
    expect(first.include_unreviewed).toBe(true);
    expect(first.map_view?.bbox).toEqual([8, 50, 9, 51]);
    expect(useAppStore.getState().chatArea).toBeNull();
    expect(contextNow().map_view).toBeNull();
  });
});
