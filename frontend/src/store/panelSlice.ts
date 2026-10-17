/** Panel slice: navigation (route, screen), the side panel, the export menu, the toast and Escape. */
import { dataSourceKind } from '../data/createDataSource';
import { errorText } from '../data/errors';
import { initialFocusKey, sourceDocumentId } from '../domain/review';
import type { Borehole } from '../domain/types';
import { csvBlob, openQuestionRows, tidyRows } from '../export/csv';
import { downloadBlob, exportPrefix } from '../export/download';
import { exportScope } from '../export/scope';
import { exportStandardXlsx } from '../export/standardXlsx';
import { formatMapView, routePath, sameScreen, type AppRoute } from '../routing/urlState';
import { defaultLayer, LEAVE_REVIEW, nextNonce, pageFor, type SliceCreator } from './context';
import { cancelKeyWrite, NO_SOURCE_REFERENCE } from './reviewSlice';
import type { AppState, PanelSlice } from './types';

const TOAST_MS = 3200;

/** Why a borehole without pages (e.g. read from a spreadsheet only) has no page to show. */
export const NO_SOURCE_PAGE = 'No source page for this borehole';

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** The layer the URL names when the borehole has it, else its default layer. */
const layerFor = (b: Borehole, n: number | null) => (n != null && b.layers.some((l) => l.n === n) ? n : defaultLayer(b));

/** The key the URL names when the borehole has that value, else null. */
const keyIn = (b: Borehole, key: string | null) => (key && b.values.some((v) => v.key === key) ? key : null);

/** Equal for the store: map views compare as the URL writes them, everything else by identity. */
function same<K extends keyof AppState>(key: K, a: AppState[K], b: AppState[K]): boolean {
  if (key === 'mapView') {
    const v = (x: unknown) => (x ? formatMapView(x as NonNullable<AppState['mapView']>) : null);
    return v(a) === v(b);
  }
  return Object.is(a, b);
}

/**
 * What showing `route` sets in the store `s` (applyRoute leaves out what already is so). `entering`:
 * the route is another screen than the one shown (or another borehole).
 */
function routePatch(s: AppState, route: AppRoute, entering: boolean): Partial<AppState> {
  const find = (uid: string) => s.boreholes.find((b) => b.uid === uid);
  switch (route.kind) {
    case 'map': {
      // The selected pin: a plotted borehole the map knows (or a cached record).
      const sel = route.sel && (s.features.some((f) => f.uid === route.sel) || find(route.sel)) ? route.sel : null;
      // A result set the URL no longer names (Back, a link) stops being shown; the route sync shows the one it names.
      const dropSet = s.resultSet && s.resultSet.id !== route.rs ? { resultSet: null, resultSetFeatures: null, resultSetError: null } : {};
      return { screen: 'map', mapView: route.at, selectedUid: sel, resultSetId: route.rs, ...dropSet };
    }
    case 'queue':
      return { screen: 'queue' };
    case 'reviewIndex':
      // The route redirects to the review target; without one it says there is nothing to review.
      return { screen: 'review' };
    case 'review': {
      const b = find(route.uid);
      // An unknown borehole shows "not found" and keeps the last review borehole as the REVIEW target.
      if (!b) return { screen: 'review' };
      const key = keyIn(b, route.key);
      if (s.reviewUid !== route.uid) {
        const focusKey = key ?? initialFocusKey(b);
        return {
          screen: 'review',
          reviewUid: route.uid,
          focusKey,
          editing: null,
          reviewPage: pageFor(b, b.values.find((v) => v.key === focusKey), b.primaryPage),
        };
      }
      if (!key || key === s.focusKey) return { screen: 'review' };
      // Back / forward to another value of the same borehole: focus it and scroll the list to it.
      return {
        screen: 'review',
        focusKey: key,
        reviewPage: pageFor(b, b.values.find((v) => v.key === key), s.reviewPage),
        listScroll: { key, nonce: nextNonce() },
        editing: s.editing && s.editing.key !== key ? null : s.editing,
      };
    }
    case 'detail': {
      const b = find(route.uid);
      // An unknown borehole shows "not found"; the selection stays as it was.
      if (!b) return { screen: 'detail' };
      const layer = layerFor(b, route.layer);
      return entering || s.selectedUid !== route.uid
        ? { screen: 'detail', selectedUid: route.uid, selectedLayer: layer }
        : { selectedLayer: layer };
    }
    case 'inbox':
    case 'notFound':
      return {};
  }
}

export const createPanelSlice: SliceCreator<PanelSlice> = ({ set, get, find }) => ({
  screen: 'map',
  navigator: null,
  route: null,
  sampleBannerVisible: dataSourceKind() === 'sample',
  toast: null,
  panel: null,
  exportOpen: false,
  includeUnreviewed: false,

  setNavigator(navigator) {
    cancelKeyWrite();
    set({ navigator });
  },

  applyRoute(route) {
    const s = get();
    const entering = !sameScreen(s.route, route);
    if (entering) {
      cancelKeyWrite();
      // Leaving Review (or going to another borehole in it) drops its transient UI.
      if (s.crsDialogOpen && route.kind !== 'review') s.closeCrsDialog();
      if (s.confirmCleanOpen) s.cancelClean();
    }
    const now = get();
    const patch: Partial<AppState> = {
      ...(entering ? { exportOpen: false, confirmCleanOpen: false, searchMessage: '' } : {}),
      ...(entering && route.kind !== 'review' ? LEAVE_REVIEW : {}),
      ...routePatch(now, route, entering),
    };
    const changes: Partial<AppState> = {};
    for (const k of Object.keys(patch) as (keyof AppState)[]) {
      if (!same(k, now[k], patch[k] as never)) Object.assign(changes, { [k]: patch[k] });
    }
    if (!now.route || routePath(now.route) !== routePath(route)) changes.route = route;
    if (Object.keys(changes).length) set(changes);
  },

  showRoute(route) {
    const s = get();
    const replace = sameScreen(s.route, route);
    const unchanged = !!s.route && routePath(s.route) === routePath(route);
    s.applyRoute(route);
    if (!unchanged) s.navigator?.navigate(routePath(route), { replace });
  },

  go(screen) {
    const s = get();
    if (s.navigator) {
      if (screen === 'map') s.showRoute({ kind: 'map', at: s.mapView, sel: null, rs: s.resultSetId });
      else if (screen === 'queue') s.showRoute({ kind: 'queue' });
      else if (screen === 'review') s.openReview();
      else if (s.selectedUid) s.openBorehole(s.selectedUid);
      else s.showRoute({ kind: 'map', at: s.mapView, sel: null, rs: s.resultSetId });
      return;
    }
    if (screen === 'review' && !get().reviewUid) {
      get().openReview();
      return;
    }
    set({ screen, exportOpen: false, confirmCleanOpen: false, searchMessage: '', ...(screen === 'review' ? {} : LEAVE_REVIEW) });
  },

  showToast(text) {
    const id = nextNonce();
    clearTimeout(toastTimer);
    set({ toast: { text, id } });
    toastTimer = setTimeout(() => set((s) => (s.toast?.id === id ? { toast: null } : {})), TOAST_MS);
  },

  openSource(uid, key) {
    const b = find(uid);
    const v = b?.values.find((x) => x.key === key);
    // The value's own document when its source is elsewhere (e.g. a lab spreadsheet), else the borehole's.
    const documentId = b && (v ? sourceDocumentId(b, v) : b.documentId);
    if (!b || !documentId) {
      get().showToast('No source document for this borehole');
      return;
    }
    if (v && !v.hasProvenance) {
      get().showToast(NO_SOURCE_REFERENCE);
      return;
    }
    // A spreadsheet value points at a cell, not at a page.
    if (v?.cell) {
      set({ panel: { kind: 'source', uid, key, documentId, page: null, box: null, cell: v.cell } });
      return;
    }
    // Without a value the borehole's first page is shown; a borehole without pages has none to show.
    if (!v && b.primaryPage == null) {
      get().showToast(NO_SOURCE_PAGE);
      return;
    }
    // A value whose source entry names no page (guessed, derived) is on no page: none is made up for it.
    const page = v ? v.page : b.primaryPage;
    set({ panel: { kind: 'source', uid, key, documentId, page, box: v?.box ?? null } });
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

  toggleExport() {
    set((s) => ({ exportOpen: !s.exportOpen }));
  },

  toggleIncludeUnreviewed() {
    set((s) => ({ includeUnreviewed: !s.includeUnreviewed }));
  },

  async exportFile(kind) {
    const s = get();
    const selected = find(s.selectedUid);
    set({ exportOpen: false });
    if (!selected) return;
    // An export covers the whole document: its full records first (fetched once, then cached).
    try {
      if (selected.documentId) await s.ensureDocumentBoreholes(selected.documentId);
    } catch (e) {
      s.showToast(`Export failed: ${errorText(e)}`);
      return;
    }
    const b = find(selected.uid) ?? selected;
    const group = exportScope(get().boreholes, b);
    const doc = get().documents.find((d) => d.id === b.documentId) ?? null;
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

  escape() {
    const s = get();
    if (s.editing) set({ editing: null });
    else if (s.confirmCleanOpen) s.cancelClean();
    else if (s.exportOpen) set({ exportOpen: false });
    else if (s.crsDialogOpen) s.closeCrsDialog();
    else if (s.panel) set({ panel: null });
  },
});
