/**
 * The app store (zustand): all UI and data state plus every action. Review edits are optimistic:
 * the store updates first, then the data source; on failure the value rolls back and a toast explains.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { createDataSource, dataSourceKind } from '../data/createDataSource';
import { PartialSaveError, type BackendMode, type DataSource } from '../data/DataSource';
import {
  applyValuePatch,
  cleanKeys,
  confirmCrsOn,
  editPatch,
  flagPatch,
  initialFocusKey,
  patchOf,
  statePatch,
  UNFLAG_PATCH,
} from '../domain/review';
import type {
  Borehole,
  Box,
  CrsCandidate,
  DocumentSummary,
  ExtractedValue,
  FieldState,
  PageContent,
  Screen,
  ValuePatch,
} from '../domain/types';
import { csvBlob, openQuestionRows, tidyRows } from '../export/csv';
import { downloadBlob, exportPrefix } from '../export/download';
import { exportScope } from '../export/scope';
import { exportStandardXlsx } from '../export/standardXlsx';
import { currentPosition } from '../geo/geolocate';
import { initialMapFocus, parseMapFocus, WORLD, withFocusParam, type MapFocus } from '../geo/mapFocus';

/* ---------- state types ---------- */

export type LoadState = 'loading' | 'ready' | 'error';
export type ExportKind = 'xlsx' | 'csv' | 'questions';
export type EditMode = 'edit' | 'flag';

export interface EditingState { key: string; mode: EditMode; text: string }
export interface SourcePanel {
  kind: 'source';
  uid?: string;
  key?: string;
  documentId: string;
  page: number;
  box?: Box | null;
  /** Opened from a page cell (queue page strip), not from a value. */
  pageOnly?: boolean;
}
export interface CompletenessPanel { kind: 'completeness'; documentId: string }
export type PanelState = SourcePanel | CompletenessPanel | null;

/** A page in the cache: loading, loaded or failed. */
export type PageLoad =
  | { status: 'loading' }
  | { status: 'ready'; content: PageContent }
  | { status: 'error'; error: string };

/** Signal for the map to fly to a borehole (header search); `nonce` changes on every request. */
export interface FlyTarget { uid: string; zoom: number; nonce: number }
/**
 * The user's position for the map's NEAR YOU panel (MY LOCATION). In memory only: it is never sent to
 * the backend, saved, or put in the URL. `simulated` is the sample-mode demo position.
 */
export type MyLocation =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'error'; message: string }
  | { status: 'located'; lat: number; lng: number; accuracyM: number; simulated: boolean; nonce: number };
/** Signal for the review list to scroll a value into view. */
export interface ListScroll { key: string; nonce: number }
export interface Toast { text: string; id: number }

export interface AppState {
  source: DataSource | null;
  loadState: LoadState;
  loadError: string | null;
  /**
   * True when the backend sent boreholes but has no documents endpoint yet (DataSource.load):
   * the map and detail work, the queue says why it is empty.
   */
  documentsUnavailable: boolean;
  /** The backend's mode from `source.health()` after a load; null when unknown. `demo` shows a banner. */
  backendMode: BackendMode | null;

  screen: Screen;
  /** Always true in sample mode: the DEMO banner can't be dismissed. */
  sampleBannerVisible: boolean;
  toast: Toast | null;

  boreholes: Borehole[];
  documents: DocumentSummary[];
  /** Page cache keyed `${documentId}:${page}`. */
  pages: Record<string, PageLoad>;

  // detail
  selectedUid: string | null;
  selectedLayer: number;

  // review
  reviewUid: string | null;
  focusKey: string | null;
  reviewPage: number;
  editing: EditingState | null;
  confirmCleanOpen: boolean;
  listScroll: ListScroll | null;

  // overlays
  panel: PanelState;
  crsDialogOpen: boolean;
  /** True while openCrsDialog waits for the data source's candidates. */
  crsLoading: boolean;
  crsCandidates: CrsCandidate[];
  crsPick: number;

  // export
  exportOpen: boolean;
  includeUnreviewed: boolean;

  // header + queue
  query: string;
  searchMessage: string;
  flyTarget: FlyTarget | null;
  /** What the Map screen's map shows: `world` or an ISO country code (src/geo/mapFocus.ts). In sync with `?focus=`. */
  mapFocus: MapFocus;
  myLocation: MyLocation;
  nearYouOpen: boolean;
  dropError: string;
  dragActive: boolean;

  // actions
  init(): Promise<void>;
  go(screen: Screen): void;
  showToast(text: string): void;
  openBorehole(uid: string): void;
  selectLayer(n: number): void;
  openReview(uid?: string): void;
  focusValue(key: string, scrollList?: boolean): void;
  setReviewPage(n: number): void;
  startEdit(key: string, mode: EditMode): void;
  setEditText(text: string): void;
  saveEdit(): void;
  cancelEdit(): void;
  toggleApprove(key: string): void;
  toggleFlag(key: string): void;
  /** Sets "not in source" / "illegible" (and approves); the same state again resets it to ok + unreviewed. */
  setState(key: string, state: Exclude<FieldState, 'ok'>): void;
  askClean(): void;
  approveClean(): void;
  cancelClean(): void;
  openSource(uid: string, key: string): void;
  openPage(documentId: string, page: number): void;
  openCompleteness(documentId: string): void;
  closePanel(): void;
  openCrsDialog(): Promise<void>;
  pickCrs(i: number): void;
  confirmCrs(): Promise<void>;
  closeCrsDialog(): void;
  toggleExport(): void;
  toggleIncludeUnreviewed(): void;
  exportFile(kind: ExportKind): Promise<void>;
  setQuery(q: string): void;
  search(): void;
  /** Switches the map focus (`world` or an ISO country code) and updates `?focus=` in the URL, without a reload. */
  setMapFocus(focus: MapFocus): void;
  /** MY LOCATION: asks the browser for the position; opens NEAR YOU on success, else shows why not. */
  locateMe(): Promise<void>;
  /** Sample mode only: pretends to be at (lat, lng) and opens NEAR YOU. Ignored with the API source. */
  simulateLocation(lat: number, lng: number): void;
  closeNearYou(): void;
  /**
   * Shows the search popover's "Listed under Not on map" message for a borehole the map didn't
   * place after all (MapScreen calls it for a target flagged as on the map but without usable coordinates).
   */
  showNotOnMap(id: string, reason: string): void;
  addFiles(files: FileList | File[]): Promise<void>;
  setDragActive(active: boolean): void;
  /**
   * Escape closes, in order: confirm clean → editing → export menu → CRS dialog → side panel → NEAR YOU →
   * location message. The confirm goes first, so Escape on it keeps an unsaved inline edit.
   */
  escape(): void;
  /** Loads a page into the cache (used by usePage). */
  loadPage(documentId: string, page: number): Promise<void>;
}

/* ---------- helpers ---------- */

const TOAST_MS = 3200;
const SEARCH_MISS_MS = 2500;
const SEARCH_NOT_ON_MAP_MS = 3500;
const SUPPORTED_UPLOAD = /\.(pdf|docx|jpe?g|png)$/i;

let nonce = 0;
let initRun = 0;
/** The latest locateMe / simulateLocation call; an older answer is ignored. */
let locateRun = 0;
/** The accuracy shown for a simulated position. */
const SIMULATED_ACCURACY_M = 25;
/** The nonce of the latest openCrsDialog call; -1 once the dialog is closed. */
let lastCrsRun = -1;
/** Created once per app; init() may run twice (React StrictMode) or again after an error. */
let sourcePromise: Promise<DataSource> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** Pending saves of one value: the queue tail, the newest save's number, what the source holds, any failure. */
interface ValueSaves { tail: Promise<void>; latest: number; confirmed: ValuePatch; failed: boolean }
/** Keyed `${uid}\n${key}`; an entry lives while saves of that value are pending. */
const saves = new Map<string, ValueSaves>();

/** Leaving Review drops its transient UI, so Escape on another screen never acts on a hidden edit. */
const LEAVE_REVIEW = { editing: null, confirmCleanOpen: false } as const;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notOnMapMessage = (id: string, reason: string) => `${id}: ${reason}. Listed under Not on map.`;
const pageKey = (documentId: string, page: number) => `${documentId}:${page}`;

/** The backend's mode from its optional health check. No check, no answer or an error = unknown (null). */
async function backendModeOf(source: DataSource): Promise<BackendMode | null> {
  try {
    return (await source.health?.())?.mode ?? null;
  } catch {
    return null;
  }
}

/** The layer the detail screen selects first: the first SPT refusal (the demo's "R"), else layer 1. */
function defaultLayer(b: Borehole | undefined): number {
  return b?.layers.find((l) => l.spt?.refusal)?.n ?? 1;
}

/** True if the Review screen can show this borehole: it has a source document and located values. */
export function isReviewable(b: Borehole | undefined): boolean {
  return !!b?.documentId && b.values.some((v) => v.page != null);
}

/** Review page for a value, as in the prototype: jump to its page when it has a box or isn't on page 1. */
function pageFor(v: ExtractedValue | undefined, current: number): number {
  return v?.page && (v.box || v.page !== 1) ? v.page : current;
}

/**
 * A document update with its Review target filled in: a status poll doesn't know which borehole
 * Review should open (the API's document object has none), so keep the one we had or take the
 * document's first borehole once extraction reached "needs review".
 */
function withReviewTarget(doc: DocumentSummary, prev: DocumentSummary | undefined, boreholes: Borehole[]): DocumentSummary {
  if (doc.reviewBoreholeUid || doc.step < 2 || doc.error) return doc;
  const uid = prev?.reviewBoreholeUid ?? boreholes.find((b) => b.documentId === doc.id && isReviewable(b))?.uid ?? null;
  const project = doc.project || boreholes.find((b) => b.documentId === doc.id)?.project || '';
  return uid || project !== doc.project ? { ...doc, reviewBoreholeUid: uid, project } : doc;
}

/* ---------- store ---------- */

export const useAppStore = create<AppState>()((set, get) => {
  const find = (uid: string | null | undefined) => get().boreholes.find((b) => b.uid === uid);
  const reviewValue = (key: string) => find(get().reviewUid)?.values.find((v) => v.key === key);
  const replaceBorehole = (uid: string, fn: (b: Borehole) => Borehole) =>
    set((s) => ({ boreholes: s.boreholes.map((b) => (b.uid === uid ? fn(b) : b)) }));

  /**
   * Saves one value patch after the earlier saves of the same value, so the source applies them in
   * order. `confirmed` follows what the source holds. When the newest save of a value settles after a
   * failure in its chain, the value is set back to `confirmed`: an older failure never undoes a newer
   * successful edit, and a partly saved patch rolls back only the part that wasn't saved.
   */
  function saveValue(source: DataSource, uid: string, before: ExtractedValue, patch: ValuePatch): Promise<void> {
    const id = `${uid}\n${before.key}`;
    const q = saves.get(id) ?? { tail: Promise.resolve(), latest: 0, confirmed: patchOf(before), failed: false };
    saves.set(id, q);
    const seq = ++q.latest;
    const run = q.tail.then(() => source.updateValue(uid, before.key, patch));
    q.tail = run
      .then(
        () => {
          q.confirmed = { ...q.confirmed, ...patch };
        },
        (e: unknown) => {
          if (e instanceof PartialSaveError) q.confirmed = { ...q.confirmed, ...e.applied };
          q.failed = true;
        },
      )
      .then(() => {
        if (seq !== q.latest) return;
        saves.delete(id);
        if (q.failed) replaceBorehole(uid, (b) => applyValuePatch(b, before.key, q.confirmed));
      });
    return run;
  }

  /** Optimistically patches several values of one borehole; failed saves roll back (see saveValue). */
  async function patchValues(uid: string, keys: string[], patch: ValuePatch): Promise<void> {
    const source = get().source;
    const before = find(uid);
    if (!source || !before) return;
    const targets = before.values.filter((v) => keys.includes(v.key));
    replaceBorehole(uid, (b) => keys.reduce((acc, k) => applyValuePatch(acc, k, patch), b));
    const results = await Promise.allSettled(targets.map((v) => saveValue(source, uid, v, patch)));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) get().showToast(`Not saved: ${errorText(failure.reason)}`);
  }

  const patchReview = (key: string, patch: ValuePatch) => {
    const uid = get().reviewUid;
    if (uid) void patchValues(uid, [key], patch);
  };

  /**
   * A status update of a document (upload or a document the backend still works on). Once
   * extraction has produced boreholes, they are loaded and the card points at the first one. Only
   * that document's boreholes are taken from the reload: the others may have newer local edits.
   */
  function documentUpdated(source: DataSource, update: DocumentSummary): void {
    const prev = get().documents.find((d) => d.id === update.id);
    const doc = withReviewTarget({ ...update, project: update.project || prev?.project || '' }, prev, get().boreholes);
    set((s) => ({
      documents: prev ? s.documents.map((d) => (d.id === doc.id ? doc : d)) : [doc, ...s.documents],
    }));
    if ((prev?.step ?? 0) >= 2 || doc.step < 2 || doc.error) return;
    source.load().then(
      (loaded) =>
        set((s) => {
          const fresh = loaded.boreholes.filter((b) => b.documentId === doc.id);
          const boreholes = [...s.boreholes.filter((b) => b.documentId !== doc.id), ...fresh];
          const checked = loaded.documents.find((d) => d.id === doc.id)?.completeness;
          return {
            boreholes,
            documents: s.documents.map((d) =>
              d.id === doc.id ? withReviewTarget({ ...d, completeness: checked ?? d.completeness }, undefined, boreholes) : d,
            ),
          };
        }),
      (e) => get().showToast(errorText(e)),
    );
  }

  const flashSearch = (message: string, ms: number) => {
    clearTimeout(searchTimer);
    set({ searchMessage: message });
    searchTimer = setTimeout(() => set({ searchMessage: '' }), ms);
  };

  return {
    source: null,
    loadState: 'loading',
    loadError: null,
    documentsUnavailable: false,
    backendMode: null,
    screen: 'map',
    sampleBannerVisible: dataSourceKind() === 'sample',
    toast: null,
    boreholes: [],
    documents: [],
    pages: {},
    selectedUid: null,
    selectedLayer: 1,
    reviewUid: null,
    focusKey: null,
    reviewPage: 1,
    editing: null,
    confirmCleanOpen: false,
    listScroll: null,
    panel: null,
    crsDialogOpen: false,
    crsLoading: false,
    crsCandidates: [],
    crsPick: 0,
    exportOpen: false,
    includeUnreviewed: false,
    query: '',
    searchMessage: '',
    flyTarget: null,
    myLocation: { status: 'idle' },
    nearYouOpen: false,
    mapFocus: initialMapFocus(typeof window === 'undefined' ? '' : window.location.search, import.meta.env.VITE_MAP_FOCUS),
    dropError: '',
    dragActive: false,

    async init() {
      const run = ++initRun;
      set({ loadState: 'loading', loadError: null, documentsUnavailable: false });
      try {
        sourcePromise ??= createDataSource();
        const source = await sourcePromise;
        set({ source });
        const result = await source.load();
        if (run !== initRun) return;
        const { boreholes, documents } = result;
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
          documentsUnavailable: result.documentsUnavailable ?? false,
        });
        // Once per load: a backend without an extraction key says so (banner).
        void backendModeOf(source).then((mode) => {
          if (run === initRun) set({ backendMode: mode });
        });
        // Documents the backend is still working on (e.g. after a reload during extraction) keep updating.
        for (const d of documents) {
          if (d.step < 2 && !d.error) source.watch?.(d.id, (update) => documentUpdated(source, update));
        }
      } catch (e) {
        if (!get().source) sourcePromise = null;
        if (run === initRun) set({ loadState: 'error', loadError: errorText(e) });
      }
    },

    go(screen) {
      if (screen === 'review' && !get().reviewUid) {
        get().openReview();
        return;
      }
      set({ screen, exportOpen: false, confirmCleanOpen: false, searchMessage: '', ...(screen === 'review' ? {} : LEAVE_REVIEW) });
    },

    showToast(text) {
      const id = ++nonce;
      clearTimeout(toastTimer);
      set({ toast: { text, id } });
      toastTimer = setTimeout(() => set((s) => (s.toast?.id === id ? { toast: null } : {})), TOAST_MS);
    },

    openBorehole(uid) {
      set({ ...LEAVE_REVIEW, selectedUid: uid, selectedLayer: defaultLayer(find(uid)), screen: 'detail', exportOpen: false, searchMessage: '' });
    },

    selectLayer(n) {
      set({ selectedLayer: n });
    },

    openReview(uid) {
      const s = get();
      const target = uid ?? s.reviewUid ?? s.documents.find((d) => d.reviewBoreholeUid)?.reviewBoreholeUid ?? null;
      const base = { screen: 'review' as const, confirmCleanOpen: false, exportOpen: false, searchMessage: '' };
      if (!target || target === s.reviewUid) {
        set(base);
        return;
      }
      const b = find(target);
      const focusKey = b ? initialFocusKey(b) : null;
      set({
        ...base,
        reviewUid: target,
        focusKey,
        editing: null,
        reviewPage: b ? pageFor(b.values.find((v) => v.key === focusKey), b.primaryPage) : 1,
      });
    },

    focusValue(key, scrollList) {
      const v = reviewValue(key);
      set((s) => ({
        focusKey: key,
        reviewPage: pageFor(v, s.reviewPage),
        listScroll: scrollList ? { key, nonce: ++nonce } : s.listScroll,
        // Moving to another value drops an unsaved inline edit, so only one row is ever in edit mode.
        editing: s.editing && s.editing.key !== key ? null : s.editing,
      }));
    },

    setReviewPage(n) {
      set({ reviewPage: n });
    },

    startEdit(key, mode) {
      get().focusValue(key);
      set({ editing: { key, mode, text: mode === 'edit' ? reviewValue(key)?.value ?? '' : '' } });
    },

    setEditText(text) {
      set((s) => (s.editing ? { editing: { ...s.editing, text } } : {}));
    },

    saveEdit() {
      const e = get().editing;
      const v = e && reviewValue(e.key);
      set({ editing: null });
      if (!e || !v) return;
      patchReview(e.key, e.mode === 'edit' ? editPatch(v, e.text) : flagPatch(e.text));
    },

    cancelEdit() {
      set({ editing: null });
    },

    toggleApprove(key) {
      const v = reviewValue(key);
      if (!v) return;
      patchReview(key, { status: v.status === 'approved' ? 'unreviewed' : 'approved' });
      get().focusValue(key);
    },

    toggleFlag(key) {
      const v = reviewValue(key);
      if (!v) return;
      get().focusValue(key);
      if (v.status === 'flagged') patchReview(key, UNFLAG_PATCH);
      else get().startEdit(key, 'flag');
    },

    setState(key, state) {
      const v = reviewValue(key);
      if (!v) return;
      get().focusValue(key);
      patchReview(key, statePatch(v, state));
    },

    askClean() {
      const b = find(get().reviewUid);
      if (b && cleanKeys(b).length) set((s) => ({ confirmCleanOpen: !s.confirmCleanOpen }));
    },

    approveClean() {
      const b = find(get().reviewUid);
      set({ confirmCleanOpen: false });
      if (!b) return;
      const keys = cleanKeys(b);
      void patchValues(b.uid, keys, { status: 'approved' });
      get().showToast(`${keys.length} clean values approved`);
    },

    cancelClean() {
      set({ confirmCleanOpen: false });
    },

    openSource(uid, key) {
      const b = find(uid);
      if (!b?.documentId) {
        get().showToast('No source document for this borehole');
        return;
      }
      const v = b.values.find((x) => x.key === key);
      set({ panel: { kind: 'source', uid, key, documentId: b.documentId, page: v?.page ?? b.primaryPage, box: v?.box ?? null } });
    },

    openPage(documentId, page) {
      set({ panel: { kind: 'source', documentId, page, box: null, pageOnly: true } });
    },

    openCompleteness(documentId) {
      set({ panel: { kind: 'completeness', documentId } });
    },

    closePanel() {
      set({ panel: null });
    },

    async openCrsDialog() {
      const { source } = get();
      const documentId = find(get().reviewUid)?.documentId;
      if (!source || !documentId) return;
      const run = ++nonce;
      lastCrsRun = run;
      set({ crsDialogOpen: true, crsLoading: true, crsCandidates: [], crsPick: 0, editing: null, confirmCleanOpen: false });
      try {
        const crsCandidates = await source.crsCandidates(documentId);
        // Ignore a late answer for a dialog that was closed or reopened meanwhile.
        if (run !== lastCrsRun) return;
        const current = find(get().reviewUid)?.crs.code;
        const pick = Math.max(0, crsCandidates.findIndex((c) => c.code === current));
        set({ crsCandidates, crsPick: pick, crsLoading: false });
      } catch (e) {
        if (run !== lastCrsRun) return;
        set({ crsDialogOpen: false, crsLoading: false });
        get().showToast(errorText(e));
      }
    },

    pickCrs(i) {
      set({ crsPick: i });
    },

    async confirmCrs() {
      const { source, crsCandidates, crsPick } = get();
      const c = crsCandidates[crsPick];
      const documentId = find(get().reviewUid)?.documentId;
      if (!source || !c || !documentId || c.verdict === 'out_of_range') return;
      const run = lastCrsRun;
      try {
        await source.confirmCrs(documentId, c.code);
        set((s) => ({
          // The answer closes only the dialog it came from, not one opened meanwhile.
          ...(run === lastCrsRun ? { crsDialogOpen: false, crsLoading: false } : {}),
          boreholes: s.boreholes.map((b) => (b.documentId === documentId ? confirmCrsOn(b, c) : b)),
        }));
        get().showToast(`CRS confirmed for all boreholes in this report: ${c.code}`);
      } catch (e) {
        get().showToast(`Not saved: ${errorText(e)}`);
      }
    },

    closeCrsDialog() {
      lastCrsRun = -1;
      set({ crsDialogOpen: false, crsLoading: false });
    },

    toggleExport() {
      set((s) => ({ exportOpen: !s.exportOpen }));
    },

    toggleIncludeUnreviewed() {
      set((s) => ({ includeUnreviewed: !s.includeUnreviewed }));
    },

    async exportFile(kind) {
      const s = get();
      const b = find(s.selectedUid);
      set({ exportOpen: false });
      if (!b) return;
      const group = exportScope(s.boreholes, b);
      const doc = s.documents.find((d) => d.id === b.documentId) ?? null;
      const o = { includeUnreviewed: s.includeUnreviewed };
      const draft = o.includeUnreviewed ? '_DRAFT' : '';
      const prefix = exportPrefix(doc?.name ?? b.sourceFile);
      try {
        if (kind === 'xlsx') {
          const name = `${prefix}_target-format${draft}.xlsx`;
          downloadBlob(await exportStandardXlsx(group, o), name);
          s.showToast(`${name}: Metadata, Logdata, Test Results + Provenance sheet${draft ? ' · stamped DRAFT' : ''}`);
        } else if (kind === 'csv') {
          const rows = tidyRows(group, o);
          downloadBlob(csvBlob(rows), `${prefix}_tidy${draft}.csv`);
          s.showToast(`Tidy CSV: ${rows.length - 1} values${draft ? ' · DRAFT' : ' · approved only'}`);
        } else {
          const rows = openQuestionRows(group, doc, o);
          downloadBlob(csvBlob(rows), `${prefix}_open-questions${draft}.csv`);
          s.showToast(`Open questions: ${rows.length - 1} items for the client`);
        }
      } catch (e) {
        s.showToast(`Export failed: ${errorText(e)}`);
      }
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
        // Drop an earlier result's target, so the map doesn't keep pointing at that borehole.
        set({ ...LEAVE_REVIEW, screen: 'map', flyTarget: null });
        flashSearch(notOnMapMessage(b.id, b.unplottedReason ?? 'No usable coordinates'), SEARCH_NOT_ON_MAP_MS);
        return;
      }
      clearTimeout(searchTimer);
      const projectSize = boreholes.filter((x) => x.project === b.project).length;
      set({
        ...LEAVE_REVIEW,
        screen: 'map',
        searchMessage: '',
        flyTarget: { uid: b.uid, zoom: projectSize > 1 && !exact ? 11 : 13, nonce: ++nonce },
      });
    },

    setMapFocus(focus) {
      const next = parseMapFocus(focus) ?? WORLD;
      if (get().mapFocus !== next) set({ mapFocus: next });
      if (typeof window !== 'undefined') {
        window.history.replaceState(window.history.state, '', withFocusParam(window.location.href, next));
      }
    },

    async locateMe() {
      const run = ++locateRun;
      set({ myLocation: { status: 'locating' } });
      try {
        const fix = await currentPosition({
          isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
          geolocation: typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
        });
        if (run !== locateRun) return;
        set({ myLocation: { status: 'located', ...fix, simulated: false, nonce: ++nonce }, nearYouOpen: true });
      } catch (e) {
        if (run === locateRun) set({ myLocation: { status: 'error', message: errorText(e) } });
      }
    },

    simulateLocation(lat, lng) {
      if (get().source?.kind !== 'sample') return;
      locateRun++;
      set({
        myLocation: { status: 'located', lat, lng, accuracyM: SIMULATED_ACCURACY_M, simulated: true, nonce: ++nonce },
        nearYouOpen: true,
      });
    },

    closeNearYou() {
      set({ nearYouOpen: false });
    },

    showNotOnMap(id, reason) {
      flashSearch(notOnMapMessage(id, reason), SEARCH_NOT_ON_MAP_MS);
    },

    async addFiles(files) {
      const list = Array.from(files);
      const bad = list.filter((f) => !SUPPORTED_UPLOAD.test(f.name));
      const good = list.filter((f) => SUPPORTED_UPLOAD.test(f.name));
      set({ dropError: bad.length ? `File type not supported: ${bad.map((f) => f.name).join(', ')}` : '', dragActive: false });
      const { source } = get();
      if (!good.length || !source) return;
      try {
        await source.upload(good, (update) => documentUpdated(source, update));
      } catch (e) {
        set({ dropError: errorText(e) });
      }
    },

    setDragActive(active) {
      if (get().dragActive !== active) set({ dragActive: active });
    },

    escape() {
      const s = get();
      if (s.confirmCleanOpen) set({ confirmCleanOpen: false });
      else if (s.editing) set({ editing: null });
      else if (s.exportOpen) set({ exportOpen: false });
      else if (s.crsDialogOpen) s.closeCrsDialog();
      else if (s.panel) set({ panel: null });
      else if (s.nearYouOpen) set({ nearYouOpen: false });
      else if (s.myLocation.status === 'error') set({ myLocation: { status: 'idle' } });
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
  };
});

/* ---------- selectors ---------- */

/** A borehole by uid. */
export function useBorehole(uid: string | null | undefined): Borehole | undefined {
  return useAppStore((s) => (uid ? s.boreholes.find((b) => b.uid === uid) : undefined));
}

/** One value of a borehole. */
export function useValue(uid: string | null | undefined, key: string | null | undefined): ExtractedValue | undefined {
  return useAppStore((s) => (uid && key ? s.boreholes.find((b) => b.uid === uid)?.values.find((v) => v.key === key) : undefined));
}

/** A document by id. */
export function useDocument(id: string | null | undefined): DocumentSummary | undefined {
  return useAppStore((s) => (id ? s.documents.find((d) => d.id === id) : undefined));
}

/** The borehole shown on the Review screen. */
export function useReviewBorehole(): Borehole | undefined {
  return useAppStore((s) => s.boreholes.find((b) => b.uid === s.reviewUid));
}

/** The borehole shown on the Detail screen. */
export function useSelectedBorehole(): Borehole | undefined {
  return useAppStore((s) => s.boreholes.find((b) => b.uid === s.selectedUid));
}

/** True if the Review screen can show this borehole. */
export function useIsReviewable(uid: string | null | undefined): boolean {
  return useAppStore((s) => isReviewable(s.boreholes.find((b) => b.uid === uid)));
}

const LOADING: PageLoad = { status: 'loading' };
const NO_PAGE: PageLoad = { status: 'error', error: 'No source page for this value' };

/** A rendered page; loads it into the cache on first use. */
export function usePage(documentId: string | null | undefined, page: number | null | undefined): PageLoad {
  const key = documentId && page ? pageKey(documentId, page) : null;
  const entry = useAppStore((s) => (key ? s.pages[key] : undefined));
  const loadPage = useAppStore((s) => s.loadPage);
  const ready = useAppStore((s) => s.source !== null);
  useEffect(() => {
    if (documentId && page && ready) void loadPage(documentId, page);
  }, [documentId, page, ready, loadPage]);
  if (!key) return NO_PAGE;
  return entry ?? LOADING;
}
