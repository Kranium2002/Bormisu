/** Map slice: the selected borehole of the Detail screen, header search and the map's fly-to signal. */
import { unplottedText } from '../domain/format';
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

  return {
    selectedUid: null,
    selectedLayer: 1,
    query: '',
    searchMessage: '',
    mapFocus: null,

    openBorehole(uid) {
      set({ ...LEAVE_REVIEW, selectedUid: uid, selectedLayer: defaultLayer(find(uid)), screen: 'detail', exportOpen: false, searchMessage: '' });
    },

    selectLayer(n) {
      set({ selectedLayer: n });
    },

    setQuery(q) {
      set({ query: q });
    },

    search() {
      const { query, boreholes } = get();
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
      if (!b.onMap) {
        set({ ...LEAVE_REVIEW, screen: 'map' });
        flashSearch(`${b.id}: ${unplottedText(b)}. Listed under Not on map.`, SEARCH_NOT_ON_MAP_MS);
        return;
      }
      clearTimeout(searchTimer);
      const projectSize = boreholes.filter((x) => x.project === b.project).length;
      set({
        ...LEAVE_REVIEW,
        screen: 'map',
        searchMessage: '',
        mapFocus: { uid: b.uid, zoom: projectSize > 1 && !exact ? 11 : 13, nonce: nextNonce() },
      });
    },
  };
};
