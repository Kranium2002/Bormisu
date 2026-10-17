/** Data slice: picks the data source, asks its health, loads boreholes and documents, caches pages. */
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
        reviewPage: rb ? pageFor(rb.values.find((v) => v.key === focusKey), rb.primaryPage) : 1,
        selectedUid: selected?.uid ?? null,
        selectedLayer: defaultLayer(selected),
      });
      // Documents the backend is still working on (e.g. after a reload during extraction) keep updating.
      for (const d of documents) {
        if (d.step < 2 && !d.error) source.watch?.(d.id, (update) => get().documentUpdated(update));
      }
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
