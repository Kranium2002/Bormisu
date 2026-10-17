/** Panel slice: navigation, the side panel, the export menu, the toast and Escape. */
import { dataSourceKind } from '../data/createDataSource';
import { errorText } from '../data/errors';
import { csvBlob, openQuestionRows, tidyRows } from '../export/csv';
import { downloadBlob, exportPrefix } from '../export/download';
import { exportScope } from '../export/scope';
import { exportStandardXlsx } from '../export/standardXlsx';
import { LEAVE_REVIEW, nextNonce, type SliceCreator } from './context';
import { NO_SOURCE_REFERENCE } from './reviewSlice';
import type { PanelSlice } from './types';

const TOAST_MS = 3200;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const createPanelSlice: SliceCreator<PanelSlice> = ({ set, get, find }) => ({
  screen: 'map',
  sampleBannerVisible: dataSourceKind() === 'sample',
  toast: null,
  panel: null,
  exportOpen: false,
  includeUnreviewed: false,

  go(screen) {
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
    if (!b?.documentId) {
      get().showToast('No source document for this borehole');
      return;
    }
    const v = b.values.find((x) => x.key === key);
    if (v && !v.hasProvenance) {
      get().showToast(NO_SOURCE_REFERENCE);
      return;
    }
    // A spreadsheet value points at a cell, not at a page.
    if (v?.cell) {
      set({ panel: { kind: 'source', uid, key, documentId: b.documentId, page: null, box: null, cell: v.cell } });
      return;
    }
    // A value whose source entry names no page (guessed, derived) is on no page: none is made up for it.
    const page = v ? v.page : b.primaryPage;
    set({ panel: { kind: 'source', uid, key, documentId: b.documentId, page, box: v?.box ?? null } });
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

  escape() {
    const s = get();
    if (s.editing) set({ editing: null });
    else if (s.confirmCleanOpen) s.cancelClean();
    else if (s.exportOpen) set({ exportOpen: false });
    else if (s.crsDialogOpen) s.closeCrsDialog();
    else if (s.panel) set({ panel: null });
  },
});
