/**
 * Data slice: picks the data source, asks its health, loads boreholes and documents, starts live
 * updates (events slice), caches pages.
 */
import { createDataSource } from '../data/createDataSource';
import type { DataSource } from '../data/DataSource';
import { errorText } from '../data/errors';
import { initialFocusKey } from '../domain/review';
import { defaultLayer, pageFor, pageKey, type SliceCreator } from './context';
import type { DataSlice } from './types';

let initRun = 0;
/** Created once per app; init() may run twice (React StrictMode) or again after an error. */
let sourcePromise: Promise<DataSource> | null = null;

export const createDataSlice: SliceCreator<DataSlice> = ({ set, get }) => ({
  source: null,
  health: null,
  loadState: 'loading',
  loadError: null,
  boreholes: [],
  documents: [],
  pages: {},

  async init() {
    const run = ++initRun;
    // Running again (StrictMode, RETRY after an error) ends the earlier live subscription first.
    get().stopLive();
    set({ loadState: 'loading', loadError: null });
    try {
      sourcePromise ??= createDataSource();
      const source = await sourcePromise;
      set({ source });
      // Health first, without waiting for it: a failed check never blocks loading (mode and limits stay unknown).
      source.health().then(
        (health) => {
          if (run === initRun) set({ health });
        },
        () => {
          if (run === initRun) set({ health: null });
        },
      );
      const { boreholes, documents } = await source.load();
      if (run !== initRun) return;
      const reviewUid = documents.find((d) => d.reviewBoreholeUid)?.reviewBoreholeUid ?? null;
      const rb = boreholes.find((b) => b.uid === reviewUid);
      const focusKey = rb ? initialFocusKey(rb) : null;
      const selected = rb ?? boreholes.find((b) => b.onMap) ?? boreholes[0];
      set({
        loadState: 'ready',
        boreholes,
        documents,
        reviewUid,
        focusKey,
        reviewPage: rb ? pageFor(rb, rb.values.find((v) => v.key === focusKey), rb.primaryPage) : null,
        selectedUid: selected?.uid ?? null,
        selectedLayer: defaultLayer(selected),
      });
      // Live updates from now on. The source itself follows the documents it loaded that are still
      // being worked on (e.g. after a reload during extraction), for the polling fallback.
      get().startLive();
    } catch (e) {
      if (!get().source) sourcePromise = null;
      // Load failures (backend unreachable, endpoint missing …) keep the error state with its message.
      if (run === initRun) set({ loadState: 'error', loadError: errorText(e) });
    }
  },

  async loadPage(documentId, page) {
    const key = pageKey(documentId, page);
    const { source, pages } = get();
    // Loading or loaded pages are cached; a failed load is tried again next time the page is shown.
    if (!source || (pages[key] && pages[key].status !== 'error')) return;
    set((s) => ({ pages: { ...s.pages, [key]: { status: 'loading' } } }));
    try {
      const content = await source.getPage(documentId, page);
      set((s) => ({ pages: { ...s.pages, [key]: { status: 'ready', content } } }));
    } catch (e) {
      set((s) => ({ pages: { ...s.pages, [key]: { status: 'error', error: errorText(e) } } }));
    }
  },
});
