/**
 * Data slice: picks the data source, asks its health, checks the session when the server has
 * sign-in (auth slice), loads the documents, the map features and the unplotted records, starts live
 * updates (events slice) and loads the questions (clarifications slice), caches pages. Full records
 * of plotted boreholes are fetched on demand (map data slice).
 */
import { createDataSource } from '../data/createDataSource';
import type { DataSource } from '../data/DataSource';
import { errorText } from '../data/errors';
import { initialFocusKey } from '../domain/review';
import type { Health } from '../domain/types';
import { pageFor, pageKey, withReviewTarget, type SliceCreator } from './context';
import { emptyFilter } from './mapDataSlice';
import type { AppState, DataSlice } from './types';

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
      // Any request that answers 401 not_authenticated ends the session (shown as the sign-in).
      source.setSessionListener(() => get().sessionEnded());
      // Health first: it says whether the server has sign-in. A failed check never blocks loading
      // (mode, limits and sign-in stay unknown; a 401 later still shows the sign-in).
      let health: Health | null = null;
      try {
        health = await source.health();
      } catch {
        health = null;
      }
      if (run !== initRun) return;
      set({ health });
      if (!health?.auth.enabled) {
        set({ authState: 'disabled', user: null });
      } else {
        const user = await source.currentUser();
        if (run !== initRun) return;
        if (!user) {
          // Nothing is loaded without a session: the sign-in shows on the same URL.
          set({ authState: 'signedOut', user: null });
          return;
        }
        set({ authState: 'signedIn', user });
      }
      await get().loadData();
    } catch (e) {
      if (!get().source) sourcePromise = null;
      // Load failures (backend unreachable, endpoint missing …) keep the error state with its message.
      if (run === initRun) set({ loadState: 'error', loadError: errorText(e) });
    }
  },

  async loadData() {
    const run = ++initRun;
    const source = get().source;
    if (!source) return;
    get().stopLive();
    set({ loadState: 'loading', loadError: null });
    try {
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
      if (run === initRun) set({ loadState: 'error', loadError: errorText(e) });
    }
  },

  resetData() {
    // Loads in flight answer into nothing; live updates and uploads end.
    initRun += 1;
    const s = get();
    s.stopLive();
    for (const status of ['queued', 'uploading'] as const) {
      for (const u of get().uploads) if (u.status === status) s.cancelUpload(u.id);
    }
    get().clearFinishedUploads();
    set(signedOutData());
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

/**
 * The store without loaded data: what sign-out and an ended session leave. The URL is not touched;
 * `route: null` lets the route sync apply it again once a user is signed in and the data is loaded.
 */
function signedOutData(): Partial<AppState> {
  return {
    // data
    loadState: 'loading',
    loadError: null,
    boreholes: [],
    documents: [],
    pages: {},
    // map data
    features: [],
    unplottedUids: [],
    filter: emptyFilter(),
    resultSet: null,
    resultSetFeatures: null,
    resultSetBusy: false,
    resultSetError: null,
    placeQuery: '',
    places: null,
    placeBusy: false,
    placeError: null,
    recordLoads: {},
    mapOutline: null,
    // map and detail selection
    selectedUid: null,
    selectedLayer: 1,
    resultSetId: null,
    query: '',
    searchMessage: '',
    mapFocus: null,
    // review
    reviewUid: null,
    focusKey: null,
    reviewPage: null,
    editing: null,
    confirmCleanOpen: false,
    cleanCount: null,
    cleanBusy: false,
    listScroll: null,
    crsDialogOpen: false,
    crsLoading: false,
    crsCandidates: [],
    crsPick: 0,
    // uploads (the queue itself is cleared by resetData)
    uploads: [],
    dropError: '',
    dragActive: false,
    uploadProject: '',
    // live updates and questions
    jobFailures: {},
    clarifications: [],
    clarificationsState: 'idle',
    activeClarificationId: null,
    // overlays
    route: null,
    panel: null,
    exportOpen: false,
    toast: null,
    chatOpen: false,
    chatAreaRequest: null,
    chatArea: null,
  };
}
