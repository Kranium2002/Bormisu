/** Upload slice: the drop zone, uploads, retries and status updates of documents the backend works on. */
import { errorCode, errorText } from '../data/errors';
import { withReviewTarget, type SliceCreator } from './context';
import type { UploadSlice } from './types';
import { checkUploads, DEMO_UPLOAD_REASON, uploadBlockedReason } from './uploads';

export const createUploadSlice: SliceCreator<UploadSlice> = ({ set, get, takeBoreholes }) => ({
  dropError: '',
  dragActive: false,

  async addFiles(files) {
    const { source, health } = get();
    set({ dragActive: false });
    const blocked = uploadBlockedReason(health);
    if (blocked) {
      set({ dropError: blocked });
      return;
    }
    const { accepted, error } = checkUploads(Array.from(files), health?.upload ?? null);
    set({ dropError: error });
    if (!accepted.length || !source) return;
    try {
      await source.upload(accepted, (update) => get().documentUpdated(update));
    } catch (e) {
      set({ dropError: errorCode(e) === 'demo_mode' ? DEMO_UPLOAD_REASON : errorText(e) });
    }
  },

  setDragActive(active) {
    if (get().dragActive !== active) set({ dragActive: active });
  },

  /**
   * Once extraction has produced boreholes, that document's boreholes and checks are loaded and the
   * card points at the first one. Other documents' boreholes are left alone (they may have newer local edits).
   */
  documentUpdated(update) {
    const source = get().source;
    const prev = get().documents.find((d) => d.id === update.id);
    const doc = withReviewTarget({ ...update, project: update.project || prev?.project || '' }, prev, get().boreholes);
    set((s) => ({
      documents: prev ? s.documents.map((d) => (d.id === doc.id ? doc : d)) : [doc, ...s.documents],
    }));
    if (!source || (prev?.step ?? 0) >= 2 || doc.step < 2 || doc.error) return;
    Promise.all([source.documentBoreholes(doc.id), source.getDocument(doc.id).catch(() => null)]).then(
      ([fresh, checked]) => {
        takeBoreholes(fresh, doc.id);
        set((s) => ({
          documents: s.documents.map((d) =>
            d.id === doc.id
              ? withReviewTarget({ ...d, completeness: checked?.completeness ?? d.completeness }, undefined, s.boreholes)
              : d,
          ),
        }));
      },
      (e) => get().showToast(errorText(e)),
    );
  },

  async retryDocument(documentId) {
    const source = get().source;
    if (!source) return;
    try {
      await source.retry(documentId);
    } catch (e) {
      get().showToast(`Retry failed: ${errorText(e)}`);
      return;
    }
    // Show the re-queued state at once, then follow the document again.
    try {
      get().documentUpdated(await source.getDocument(documentId));
    } catch {
      // The watcher below brings the next state.
    }
    source.watch?.(documentId, (update) => get().documentUpdated(update));
  },
});
