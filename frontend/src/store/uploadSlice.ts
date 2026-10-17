/** Upload slice: the drop zone, uploads and status updates of documents the backend works on. */
import { errorText, withReviewTarget, type SliceCreator } from './context';
import type { UploadSlice } from './types';

const SUPPORTED_UPLOAD = /\.(pdf|docx|jpe?g|png)$/i;

export const createUploadSlice: SliceCreator<UploadSlice> = ({ set, get }) => ({
  dropError: '',
  dragActive: false,

  async addFiles(files) {
    const list = Array.from(files);
    const bad = list.filter((f) => !SUPPORTED_UPLOAD.test(f.name));
    const good = list.filter((f) => SUPPORTED_UPLOAD.test(f.name));
    set({ dropError: bad.length ? `File type not supported: ${bad.map((f) => f.name).join(', ')}` : '', dragActive: false });
    const { source } = get();
    if (!good.length || !source) return;
    try {
      await source.upload(good, (update) => get().documentUpdated(update));
    } catch (e) {
      set({ dropError: errorText(e) });
    }
  },

  setDragActive(active) {
    if (get().dragActive !== active) set({ dragActive: active });
  },

  /**
   * Once extraction has produced boreholes, they are loaded and the card points at the first one.
   * Only that document's boreholes are taken from the reload: the others may have newer local edits.
   */
  documentUpdated(update) {
    const source = get().source;
    const prev = get().documents.find((d) => d.id === update.id);
    const doc = withReviewTarget({ ...update, project: update.project || prev?.project || '' }, prev, get().boreholes);
    set((s) => ({
      documents: prev ? s.documents.map((d) => (d.id === doc.id ? doc : d)) : [doc, ...s.documents],
    }));
    if (!source || (prev?.step ?? 0) >= 2 || doc.step < 2 || doc.error) return;
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
  },
});
