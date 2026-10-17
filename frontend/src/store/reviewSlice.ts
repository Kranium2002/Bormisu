/**
 * Review slice: focus, inline edit, saves, approve all clean and the CRS dialog.
 *
 * Saves are optimistic: the value changes at once, then the source saves it and answers with the
 * borehole as it now holds it. While saves of a borehole are pending the optimistic state stays;
 * when the last one settles, the newest record the source reported replaces the borehole (see
 * saves.ts). A failure explains itself in a toast.
 */
import { errorCode, errorText, SaveError } from '../data/errors';
import { applyValuePatch, editPatch, flagPatch, initialFocusKey, statePatch, UNFLAG_PATCH } from '../domain/review';
import type { Borehole, ValuePatch } from '../domain/types';
import { reviewTarget } from '../routing/navLinks';
import { nextNonce, pageFor, type SliceCreator } from './context';
import { signatureOf } from './authSlice';
import type { ReviewSlice } from './types';

/** The focused value goes into the URL once the focus has rested this long (holding J / K writes it once). */
export const KEY_WRITE_MS = 250;
let keyWriteTimer: ReturnType<typeof setTimeout> | undefined;

/** Drops a focus not yet written into the URL (the screen changed, or a new navigator came). */
export function cancelKeyWrite(): void {
  clearTimeout(keyWriteTimer);
  keyWriteTimer = undefined;
}

/** Why a value without a provenance entry can't be reviewed. */
export const NO_SOURCE_REFERENCE = 'No source reference from the backend';
/** Toast after a revision conflict: the store already shows the record the source refetched. */
export const CONFLICT_TEXT = 'This borehole was changed elsewhere. The latest version is loaded; your change was not saved.';

/** Toast text of a failed save. */
export function saveFailureText(e: unknown): string {
  return errorCode(e) === 'revision_conflict' ? CONFLICT_TEXT : `Not saved: ${errorText(e)}`;
}

const boreholes = (n: number) => `${n} borehole${n === 1 ? '' : 's'}`;

/** The nonce of the latest openCrsDialog call; -1 once the dialog is closed. */
let lastCrsRun = -1;
/** The latest "approve all clean" count request; answers of older ones are ignored. */
let cleanRun = 0;

export const createReviewSlice: SliceCreator<ReviewSlice> = ({ set, get, find, replaceBorehole, takeBoreholes, refreshFeatures, saves }) => {
  const reviewValue = (key: string) => find(get().reviewUid)?.values.find((v) => v.key === key);

  /** The value when it can be reviewed; otherwise explains why not and returns undefined. */
  const reviewable = (key: string) => {
    const v = reviewValue(key);
    if (v && !v.hasProvenance) {
      get().showToast(NO_SOURCE_REFERENCE);
      return undefined;
    }
    return v;
  };

  /** Applies a patch to a value of the review borehole at once and saves it (see the file comment). */
  function save(key: string, patch: ValuePatch): void {
    const source = get().source;
    const b = find(get().reviewUid);
    if (!source || !b) return;
    const order = saves.begin(b);
    replaceBorehole(b.uid, (x) => applyValuePatch(x, key, patch));
    let request: Promise<Borehole>;
    try {
      request = source.updateValue(b.uid, key, patch);
    } catch (e) {
      request = Promise.reject(e);
    }
    void request
      .then(
        (record) => saves.observe(record, order),
        (e: unknown) => {
          if (e instanceof SaveError && e.current) saves.observe(e.current, order);
          get().showToast(saveFailureText(e));
        },
      )
      .finally(() => {
        const shown = saves.end(b.uid);
        if (shown) replaceBorehole(b.uid, () => shown);
      });
  }

  return {
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

    openReview(uid) {
      const s = get();
      if (s.navigator) {
        const to = uid ?? reviewTarget(s);
        // Back on the last reviewed borehole, its focused value goes along.
        s.showRoute(to ? { kind: 'review', uid: to, key: to === s.reviewUid ? s.focusKey : null } : { kind: 'reviewIndex' });
        return;
      }
      const target = uid ?? s.reviewUid ?? s.documents.find((d) => d.reviewBoreholeUid)?.reviewBoreholeUid ?? null;
      const base = { screen: 'review' as const, confirmCleanOpen: false, exportOpen: false, searchMessage: '' };
      if (!target || (target === s.reviewUid && find(target))) {
        set(base);
        return;
      }
      /** Review on the target's first value to check (its page too), once its record is at hand. */
      const focusOn = (b: Borehole | undefined) => {
        const focusKey = b ? initialFocusKey(b) : null;
        return { focusKey, reviewPage: b ? pageFor(b, b.values.find((v) => v.key === focusKey), b.primaryPage) : null };
      };
      const b = find(target);
      set({ ...base, reviewUid: target, editing: null, ...focusOn(b) });
      if (b) return;
      // Not cached yet (a plotted borehole known by its pin): its record and its document's come on demand.
      void get()
        .ensureBorehole(target)
        .then((record) => {
          if (record && get().reviewUid === target && get().focusKey === null) set(focusOn(record));
          if (record?.documentId) return get().ensureDocumentBoreholes(record.documentId);
        })
        .catch((e: unknown) => console.warn(`Loading the boreholes of the review document failed (${errorText(e)}).`));
    },

    focusValue(key, scrollList) {
      const b = find(get().reviewUid);
      const v = b?.values.find((x) => x.key === key);
      set((s) => ({
        focusKey: key,
        reviewPage: b ? pageFor(b, v, s.reviewPage) : s.reviewPage,
        listScroll: scrollList ? { key, nonce: nextNonce() } : s.listScroll,
        // Moving to another value drops an unsaved inline edit, so only one row is ever in edit mode.
        editing: s.editing && s.editing.key !== key ? null : s.editing,
      }));
      if (!get().navigator) return;
      cancelKeyWrite();
      keyWriteTimer = setTimeout(() => {
        keyWriteTimer = undefined;
        const now = get();
        const route = now.route;
        // Only while the same borehole is still shown in Review: a late write never navigates back.
        if (route?.kind !== 'review' || route.uid !== now.reviewUid || route.key === now.focusKey) return;
        now.showRoute({ ...route, key: now.focusKey });
      }, KEY_WRITE_MS);
    },

    setReviewPage(n) {
      set({ reviewPage: n });
    },

    startEdit(key, mode) {
      get().focusValue(key);
      const v = reviewable(key);
      if (!v) return;
      // A value the backend sets elsewhere (e.g. the CRS through its dialog) can't be edited; approve and flag still work.
      if (mode === 'edit' && v.readOnlyReason) {
        get().showToast(v.readOnlyReason);
        return;
      }
      set({ editing: { key, mode, text: mode === 'edit' ? v.value : '' } });
    },

    setEditText(text) {
      set((s) => (s.editing ? { editing: { ...s.editing, text } } : {}));
    },

    saveEdit() {
      const e = get().editing;
      const v = e && reviewValue(e.key);
      set({ editing: null });
      if (!e || !v?.hasProvenance) return;
      // The value became read-only while the edit was open (a newer record): the edit is not sent.
      if (e.mode === 'edit' && v.readOnlyReason) {
        get().showToast(v.readOnlyReason);
        return;
      }
      save(e.key, e.mode === 'edit' ? editPatch(v, e.text) : flagPatch(e.text));
    },

    cancelEdit() {
      set({ editing: null });
    },

    toggleApprove(key) {
      const v = reviewable(key);
      if (!v) return;
      // Undo of an approval is status "unreviewed" (the API's reset action).
      save(key, { status: v.status === 'approved' ? 'unreviewed' : 'approved' });
      get().focusValue(key);
    },

    toggleFlag(key) {
      const v = reviewable(key);
      if (!v) return;
      get().focusValue(key);
      if (v.status === 'flagged') save(key, UNFLAG_PATCH);
      else get().startEdit(key, 'flag');
    },

    setState(key, state) {
      const v = reviewable(key);
      if (!v) return;
      get().focusValue(key);
      save(key, statePatch(v, state));
    },

    async askClean() {
      const s = get();
      if (s.confirmCleanOpen) {
        s.cancelClean();
        return;
      }
      const documentId = find(s.reviewUid)?.documentId;
      if (!s.source || !documentId) return;
      const run = ++cleanRun;
      set({ confirmCleanOpen: true, cleanCount: null, editing: null });
      try {
        const count = await s.source.approveClean(documentId, true);
        if (run === cleanRun) set({ cleanCount: count });
      } catch (e) {
        if (run !== cleanRun) return;
        set({ confirmCleanOpen: false });
        get().showToast(`Could not count the clean values: ${errorText(e)}`);
      }
    },

    async approveClean() {
      const s = get();
      const documentId = find(s.reviewUid)?.documentId;
      if (!s.source || !documentId || !s.confirmCleanOpen || !s.cleanCount) return;
      cleanRun += 1;
      set({ confirmCleanOpen: false, cleanBusy: true });
      try {
        const count = await s.source.approveClean(documentId, false);
        const approved = `${count} clean value${count === 1 ? '' : 's'} approved`;
        try {
          takeBoreholes(await s.source.documentBoreholes(documentId), documentId);
          // The pins of the document show the new review states.
          refreshFeatures(documentId);
          get().showToast(approved);
        } catch (e) {
          get().showToast(`${approved}. Reloading the boreholes failed: ${errorText(e)}`);
        }
      } catch (e) {
        get().showToast(`Not saved: ${errorText(e)}`);
      } finally {
        set({ cleanBusy: false });
      }
    },

    cancelClean() {
      cleanRun += 1;
      set({ confirmCleanOpen: false });
    },

    async openCrsDialog() {
      const { source } = get();
      const documentId = find(get().reviewUid)?.documentId;
      if (!source || !documentId) return;
      const run = nextNonce();
      lastCrsRun = run;
      cleanRun += 1;
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
      const reviewerName = signatureOf(get());
      const c = crsCandidates[crsPick];
      const documentId = find(get().reviewUid)?.documentId;
      if (!source || !c || !documentId || c.verdict === 'out_of_range') return;
      const run = lastCrsRun;
      let updated: number;
      try {
        updated = await source.confirmCrs(documentId, { code: c.code, swapAxes: c.swapAxes, confirmedBy: reviewerName });
      } catch (e) {
        get().showToast(`Not saved: ${errorText(e)}`);
        return;
      }
      // The answer closes only the dialog it came from, not one opened meanwhile.
      if (run === lastCrsRun) set({ crsDialogOpen: false, crsLoading: false });
      // The server placed the boreholes; reload them, the pins and the NOT ON MAP list instead of moving pins here.
      void get().refreshMap();
      try {
        takeBoreholes(await source.documentBoreholes(documentId), documentId);
        get().showToast(`CRS confirmed for ${boreholes(updated)} in this report: ${c.name}`);
      } catch (e) {
        get().showToast(`CRS confirmed (${c.name}). Reloading the boreholes failed: ${errorText(e)}`);
      }
    },

    closeCrsDialog() {
      lastCrsRun = -1;
      set({ crsDialogOpen: false, crsLoading: false });
    },
  };
};
