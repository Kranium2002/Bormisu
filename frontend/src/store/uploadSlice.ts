/**
 * Upload slice: the drop zone, the upload queue (F6: two uploads at a time, byte progress, cancel,
 * retry, one project per drop), retries of failed documents and document updates from any path
 * (upload answers, live events, refetches).
 */
import type { DataSource, UploadHandle } from '../data/DataSource';
import { errorCode, errorText, UploadCancelledError } from '../data/errors';
import type { DocumentSummary, UploadResult } from '../domain/types';
import { isProcessing, nextNonce, withReviewTarget, type SliceCreator } from './context';
import type { UploadSlice } from './types';
import {
  checkUploads,
  DEMO_UPLOAD_REASON,
  isFinishedUpload,
  MAX_PARALLEL_UPLOADS,
  pickedFolder,
  retryBlockedReason,
  uploadBlockedReason,
  uploadProject,
  type UploadItem,
} from './uploads';

/** Shown when a queued file can't be read any more (e.g. the store was reset meanwhile). */
const FILE_GONE = 'The file is no longer available; add it again.';

/** A copy of `record` without `key`. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/** Upload flags a card keeps when an update (event, poll) doesn't say: they describe this browser's upload. */
function carriedFlags(update: DocumentSummary, prev: DocumentSummary | undefined): Partial<DocumentSummary> {
  return {
    ...(prev?.uploaded && update.uploaded === undefined ? { uploaded: true } : {}),
    ...(prev?.uploadedAgain && update.uploadedAgain === undefined ? { uploadedAgain: true } : {}),
    ...(prev?.simulated && update.simulated === undefined ? { simulated: true } : {}),
  };
}

export const createUploadSlice: SliceCreator<UploadSlice> = ({ set, get, takeBoreholes, isDeleted }) => {
  /** The files of the queue by item id (kept until the upload succeeds, so a failed one can be retried). */
  const files = new Map<string, File>();
  /** Running uploads by item id. */
  const handles = new Map<string, UploadHandle>();
  /** Documents whose boreholes are being loaded, with the source asked: one load per document at a time. */
  const loadingBoreholes = new Map<string, DataSource>();

  const item = (id: string) => get().uploads.find((i) => i.id === id);
  const patch = (id: string, change: Partial<UploadItem>) =>
    set((s) => ({ uploads: s.uploads.map((i) => (i.id === id ? { ...i, ...change } : i)) }));
  const failure = (e: unknown) => (errorCode(e) === 'demo_mode' ? DEMO_UPLOAD_REASON : errorText(e));

  /**
   * The server answered: the item points at the document, whose card is added or updated (a
   * duplicate adds none). A new document's answer carries little more than its status; when a live
   * event brought the document first, that newer state stays and only the upload flag is added.
   */
  function answered(id: string, { document, duplicate }: UploadResult): void {
    const it = item(id);
    files.delete(id);
    if (it) patch(id, { status: 'done', documentId: document.id, duplicate, error: null, loaded: it.total });
    const shown = get().documents.some((d) => d.id === document.id);
    if (shown && !duplicate) {
      set((s) => ({ documents: s.documents.map((d) => (d.id === document.id ? { ...d, uploaded: true } : d)) }));
    } else {
      get().documentUpdated(document);
    }
    if (isProcessing(document)) get().source?.follow(document.id);
  }

  function failed(id: string, e: unknown): void {
    const it = item(id);
    if (!it) return;
    // A cancelled upload stays cancelled (the source rejects it with UploadCancelledError).
    if (it.status === 'cancelled' || e instanceof UploadCancelledError) {
      files.delete(id);
      if (it.status !== 'cancelled') patch(id, { status: 'cancelled' });
      return;
    }
    patch(id, { status: 'failed', error: failure(e) });
  }

  /** Sends one queued file. */
  function start(it: UploadItem): void {
    const source = get().source;
    const file = files.get(it.id);
    if (!source || !file) {
      patch(it.id, { status: 'failed', error: FILE_GONE });
      return;
    }
    patch(it.id, { status: 'uploading', loaded: 0, total: file.size, error: null });
    let handle: UploadHandle;
    let done: Promise<void>;
    try {
      handle = source.upload(file, {
        project: it.project,
        onProgress: ({ loaded, total }) => {
          if (item(it.id)?.status === 'uploading') patch(it.id, { loaded, total });
        },
      });
      done = handle.done.then(
        (result) => answered(it.id, result),
        (e: unknown) => failed(it.id, e),
      );
    } catch (e) {
      // The source refused the file at once (e.g. it could not be read): this item fails, the queue goes on.
      failed(it.id, e);
      return;
    }
    handles.set(it.id, handle);
    void done.finally(() => {
      handles.delete(it.id);
      pump();
    });
  }

  /** Starts queued uploads, oldest first, while fewer than MAX_PARALLEL_UPLOADS run. */
  function pump(): void {
    for (;;) {
      const { uploads, source } = get();
      if (!source || uploads.filter((i) => i.status === 'uploading').length >= MAX_PARALLEL_UPLOADS) return;
      const next = uploads.find((i) => i.status === 'queued');
      if (!next) return;
      start(next);
    }
  }

  /** Loads a document's boreholes after extraction and points its card at one of them (F7). */
  function loadBoreholes(doc: DocumentSummary, source: DataSource): void {
    if (loadingBoreholes.get(doc.id) === source) return;
    loadingBoreholes.set(doc.id, source);
    Promise.all([source.documentBoreholes(doc.id), source.getDocument(doc.id).catch(() => null)])
      .then(
        ([fresh, checked]) => {
          if (get().source !== source || isDeleted(doc.id)) return;
          takeBoreholes(fresh, doc.id);
          // The document as the source checks it now that its boreholes are known (completeness, lint).
          set((s) => ({
            documents: s.documents.map((d) =>
              d.id === doc.id
                ? withReviewTarget({ ...d, completeness: checked?.completeness ?? d.completeness }, undefined, s.boreholes)
                : d,
            ),
          }));
        },
        (e: unknown) => get().showToast(errorText(e)),
      )
      .finally(() => {
        if (loadingBoreholes.get(doc.id) === source) loadingBoreholes.delete(doc.id);
      });
  }

  return {
    dropError: '',
    dragActive: false,
    uploadProject: '',
    uploads: [],

    addFiles(input, options) {
      const { source, health } = get();
      set({ dragActive: false });
      const blocked = uploadBlockedReason(health);
      if (blocked) {
        set({ dropError: blocked });
        return;
      }
      const all = Array.from(input);
      const { accepted, error } = checkUploads(all, health?.upload ?? null);
      set({ dropError: error });
      if (!accepted.length || !source) return;
      // Files added together send one project.
      const project = uploadProject(get().uploadProject, options?.folder ?? pickedFolder(all));
      const added = accepted.map((file): UploadItem => {
        const id = `upload-${nextNonce()}`;
        files.set(id, file);
        return {
          id, name: file.name, size: file.size, project, status: 'queued', loaded: 0, total: file.size,
          documentId: null, error: null, duplicate: false,
        };
      });
      set((s) => ({ uploads: [...s.uploads, ...added] }));
      pump();
    },

    setDragActive(active) {
      if (get().dragActive !== active) set({ dragActive: active });
    },

    setUploadProject(label) {
      set({ uploadProject: label });
    },

    cancelUpload(id) {
      const it = item(id);
      if (it?.status === 'queued') {
        files.delete(id);
        patch(id, { status: 'cancelled' });
      } else if (it?.status === 'uploading') {
        patch(id, { status: 'cancelled' });
        handles.get(id)?.cancel();
        pump();
      }
    },

    removeUpload(id) {
      const it = item(id);
      if (!it || !isFinishedUpload(it)) return;
      files.delete(id);
      set((s) => ({ uploads: s.uploads.filter((i) => i.id !== id) }));
    },

    clearFinishedUploads() {
      for (const it of get().uploads) if (isFinishedUpload(it)) files.delete(it.id);
      set((s) => ({ uploads: s.uploads.filter((i) => !isFinishedUpload(i)) }));
    },

    retryUpload(id) {
      const it = item(id);
      if (it?.status !== 'failed') return;
      const blocked = uploadBlockedReason(get().health);
      if (blocked) {
        set({ dropError: blocked });
        return;
      }
      patch(id, { status: 'queued', error: null, loaded: 0 });
      pump();
    },

    /**
     * Replaces or adds the document's card (keeping its review target, project and upload flags).
     * Once it reaches needs_review or done, its boreholes are loaded when it just got there or none
     * are loaded yet, so the card's OPEN REVIEW, the map and Review work without a reload. Other
     * documents' boreholes are left alone (they may have newer local edits).
     */
    documentUpdated(update) {
      if (isDeleted(update.id)) return;
      const source = get().source;
      const prev = get().documents.find((d) => d.id === update.id);
      const doc = withReviewTarget(
        { ...update, ...carriedFlags(update, prev), project: update.project || prev?.project || '' },
        prev,
        get().boreholes,
      );
      const runsAgain = doc.status !== 'failed' && !doc.error;
      set((s) => ({
        documents: prev ? s.documents.map((d) => (d.id === doc.id ? doc : d)) : [doc, ...s.documents],
        ...(runsAgain && s.jobFailures[doc.id] ? { jobFailures: without(s.jobFailures, doc.id) } : {}),
      }));
      if (!source || doc.step < 2 || doc.error) return;
      const reached = !prev || prev.step < 2;
      const loaded = get().boreholes.some((b) => b.documentId === doc.id);
      if (reached || !loaded) loadBoreholes(doc, source);
    },

    async retryDocument(documentId) {
      const { source, health } = get();
      if (!source) return;
      const blocked = retryBlockedReason(health);
      if (blocked) {
        get().showToast(blocked);
        return;
      }
      try {
        await source.retry(documentId);
      } catch (e) {
        get().showToast(`Retry failed: ${errorText(e)}`);
        return;
      }
      set((s) => ({ jobFailures: without(s.jobFailures, documentId) }));
      // Show the re-queued state at once; live updates (or the polling fallback) bring the rest.
      try {
        get().documentUpdated(await source.getDocument(documentId));
      } catch {
        // The next live update brings the state.
      }
      source.follow(documentId);
    },
  };
};
