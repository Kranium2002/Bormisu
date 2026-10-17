/**
 * Review slice: focus, inline edit, optimistic saves, approve all clean and the CRS dialog.
 * Review edits are optimistic: the store updates first, then the data source; on failure the value
 * rolls back and a toast explains.
 */
import { PartialSaveError, type DataSource } from '../data/DataSource';
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
import type { ExtractedValue, ValuePatch } from '../domain/types';
import { errorText, nextNonce, pageFor, type SliceCreator } from './context';
import type { ReviewSlice } from './types';

/** The nonce of the latest openCrsDialog call; -1 once the dialog is closed. */
let lastCrsRun = -1;

/** Pending saves of one value: the queue tail, the newest save's number, what the source holds, any failure. */
interface ValueSaves { tail: Promise<void>; latest: number; confirmed: ValuePatch; failed: boolean }
/** Keyed `${uid}\n${key}`; an entry lives while saves of that value are pending. */
const saves = new Map<string, ValueSaves>();

export const createReviewSlice: SliceCreator<ReviewSlice> = ({ set, get, find, replaceBorehole }) => {
  const reviewValue = (key: string) => find(get().reviewUid)?.values.find((v) => v.key === key);

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
    const run = q.tail.then(() => source.updateValue(uid, before.key, patch)).then(() => undefined);
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

  return {
    reviewUid: null,
    focusKey: null,
    reviewPage: 1,
    editing: null,
    confirmCleanOpen: false,
    listScroll: null,
    crsDialogOpen: false,
    crsLoading: false,
    crsCandidates: [],
    crsPick: 0,

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
        listScroll: scrollList ? { key, nonce: nextNonce() } : s.listScroll,
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

    async openCrsDialog() {
      const { source } = get();
      const documentId = find(get().reviewUid)?.documentId;
      if (!source || !documentId) return;
      const run = nextNonce();
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
        await source.confirmCrs(documentId, c.code as never);
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
  };
};
