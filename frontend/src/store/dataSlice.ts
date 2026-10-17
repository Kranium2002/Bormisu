/**
 * Data slice: picks the data source, asks its health, loads the documents, the map features and the
 * unplotted records, starts live updates (events slice) and loads the questions (clarifications
 * slice), caches pages. Full records of plotted boreholes are fetched on demand (map data slice).
 */
import { createDataSource } from '../data/createDataSource';
import type { DataSource } from '../data/DataSource';
import { errorText } from '../data/errors';
import { initialFocusKey } from '../domain/review';
import { pageFor, pageKey, withReviewTarget, type SliceCreator } from './context';
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
      const { documents, features, unplotted } = await source.load();
      if (run !== initRun) return;
      // The boreholes cache starts with the unplotted records (the NOT ON MAP list); every plotted
      // borehole is a map feature until Review, Detail or an export needs its full record.
      const known = { boreholes: unplotted, features, unplottedUids: unplotted.map((b) => b.uid) };
      const docs = documents.map((d) => withReviewTarget(d, undefined, known));
      // Review starts on the first document's target when its record is at hand; else its route loads it.
      const target = docs.find((d) => d.reviewBoreholeUid)?.reviewBoreholeUid;
      const rb = unplotted.find((b) => b.uid === target);
      const focusKey = rb ? initialFocusKey(rb) : null;
      set({
        loadState: 'ready',
        ...known,
        recordLoads: {},
        documents: docs,
        reviewUid: rb?.uid ?? null,
        focusKey,
        reviewPage: rb ? pageFor(rb, rb.values.find((v) => v.key === focusKey), rb.primaryPage) : null,
        selectedUid: null,
        selectedLayer: 1,
      });
      // Live updates from now on. The source itself follows the documents it loaded that are still
      // being worked on (e.g. after a reload during extraction), for the polling fallback.
      get().startLive();
      // The questions for the inbox and the badge; a failure never blocks the app.
      void get().loadClarifications();
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
