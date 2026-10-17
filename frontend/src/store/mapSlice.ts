/**
 * Map slice: the selected borehole (Detail screen, or the pin selected on the map), the map's URL
 * state, header search and the map's fly-to signal. With a navigator, opening a borehole and search go
 * through the URL; the map view, the selected pin and the selected layer go into the query with
 * history replace (see panelSlice showRoute).
 */
import { unplottedText } from '../domain/format';
import { roundMapView } from '../routing/urlState';
import { defaultLayer, LEAVE_REVIEW, nextNonce, type SliceCreator } from './context';
import type { MapSlice } from './types';

const SEARCH_MISS_MS = 2500;
const SEARCH_NOT_ON_MAP_MS = 3500;

let searchTimer: ReturnType<typeof setTimeout> | undefined;

export const createMapSlice: SliceCreator<MapSlice> = ({ set, get, find }) => {
  const flashSearch = (message: string, ms: number) => {
    clearTimeout(searchTimer);
    set({ searchMessage: message });
    searchTimer = setTimeout(() => set({ searchMessage: '' }), ms);
  };

  /** True when the store shows the map through the router: a map that is going away reports nothing. */
  const mapRouted = () => get().route?.kind === 'map';

  return {
    selectedUid: null,
    selectedLayer: 1,
    mapView: null,
    resultSetId: null,
    query: '',
    searchMessage: '',
    mapFocus: null,

    openBorehole(uid) {
      const s = get();
      if (s.navigator) {
        s.showRoute({ kind: 'detail', uid, layer: null });
        return;
      }
      set({ ...LEAVE_REVIEW, selectedUid: uid, selectedLayer: defaultLayer(find(uid)), screen: 'detail', exportOpen: false, searchMessage: '' });
    },

    selectLayer(n) {
      const s = get();
      const route = s.route;
      if (s.navigator && route?.kind === 'detail' && route.uid === s.selectedUid) {
        s.showRoute({ ...route, layer: n });
        return;
      }
      set({ selectedLayer: n });
    },

    setMapView(view) {
      const s = get();
      const at = roundMapView(view);
      if (!s.navigator) set({ mapView: at });
      else if (mapRouted()) s.showRoute({ kind: 'map', at, sel: s.selectedUid, rs: s.resultSetId });
    },

    selectOnMap(uid) {
      const s = get();
      if (!s.navigator) set({ selectedUid: uid });
      else if (mapRouted()) s.showRoute({ kind: 'map', at: s.mapView, sel: uid, rs: s.resultSetId });
    },

    setQuery(q) {
      set({ query: q });
    },

    search() {
      const { query, boreholes, navigator } = get();
      const q = query.trim().toLowerCase();
      if (!q) return;
      const flat = (id: string) => id.toLowerCase().replace(/[-\s]/g, '');
      const flatQ = flat(q);
      const exact = boreholes.find((x) => x.id.toLowerCase() === q);
      // A query of only dashes or punctuation matches nothing (it would be a substring of every ID).
      const b = !/[\p{L}\p{N}]/u.test(q)
        ? undefined
        : (exact ??
          boreholes.find((x) => flat(x.id).includes(flatQ)) ??
          boreholes.find((x) => x.project.toLowerCase().includes(q)));
      if (!b) {
        flashSearch(`No results for “${query}”`, SEARCH_MISS_MS);
        return;
      }
      const s = get();
      if (!b.onMap) {
        if (navigator) s.showRoute({ kind: 'map', at: s.mapView, sel: null, rs: s.resultSetId });
        else set({ ...LEAVE_REVIEW, screen: 'map' });
        flashSearch(`${b.id}: ${unplottedText(b)}. Listed under Not on map.`, SEARCH_NOT_ON_MAP_MS);
        return;
      }
      clearTimeout(searchTimer);
      const projectSize = boreholes.filter((x) => x.project === b.project).length;
      const mapFocus = { uid: b.uid, zoom: projectSize > 1 && !exact ? 11 : 13, nonce: nextNonce() };
      if (navigator) {
        // The focused borehole goes into the map URL (sel); the map flies to it and opens its popup.
        set({ mapFocus, searchMessage: '' });
        s.showRoute({ kind: 'map', at: s.mapView, sel: b.uid, rs: s.resultSetId });
        return;
      }
      set({ ...LEAVE_REVIEW, screen: 'map', searchMessage: '', mapFocus });
    },
  };
};
