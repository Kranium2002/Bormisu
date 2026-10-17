/**
 * Planned lines (contract 1.3.0): a tunnel, pipeline or drilling line uploaded as a file (or drawn on
 * the map), shown with its search band and the boreholes along it in chainage order.
 *
 * - Upload stores the line and shows it at once: the map flies to the band, the hits become the active
 *   result set (presentResultSet), so pins highlight and LIST and the chat see the same selection as
 *   for a filter. The band is drawn by the map's planned-line layer, not as a selected area (the set's
 *   echoed area is left out), so the area tools stay free.
 * - The search distance and "Include unreviewed" ask again (POST /alignments/{id}/query); an answer
 *   of an older question is ignored. Include unreviewed is off by default: approved boreholes only,
 *   as the contract's filters.
 * - Earlier lines are listed on demand and can be shown again or deleted.
 */
import { ApiError, errorCode, errorText } from '../data/errors';
import type { Alignment, ResultSet } from '../domain/types';
import { positionsBbox } from '../data/adapters';
import { nextNonce, type SliceCreator } from './context';
import type { AlignmentError, AlignmentSlice } from './types';

export const DEFAULT_BUFFER_M = 100;
export const MAX_BUFFER_M = 1000;

/** The error of a failed request as the panel shows it: the server's detail and its code. */
const failure = (e: unknown): AlignmentError => ({ code: errorCode(e), text: e instanceof ApiError ? e.detail || e.message : errorText(e) });

export const createAlignmentSlice: SliceCreator<AlignmentSlice> = ({ set, get }) => {
  /** Bumped by every query, open, upload and clear: answers of an older one are ignored. */
  let run = 0;

  /** True when the active result set is the shown line's hits. */
  const lineSetShown = () => {
    const s = get();
    return !!s.resultSet && !!s.alignmentResult && s.resultSet.id === s.alignmentResult.resultSet.id;
  };

  /** Asks for the boreholes along the shown line; `fit` flies the map to its band. */
  async function query(fit: boolean): Promise<void> {
    const { source, alignment, alignmentBufferM, alignmentIncludeUnreviewed } = get();
    if (!source || !alignment) return;
    const mine = ++run;
    set({ alignmentBusy: 'query', alignmentError: null });
    try {
      const result = await source.queryAlignment(alignment.id, { bufferM: alignmentBufferM, includeUnreviewed: alignmentIncludeUnreviewed });
      if (mine !== run || get().source !== source) return;
      set({ alignmentResult: result, alignmentBusy: null });
      const bbox = positionsBbox(result.band.flat(2)) ?? alignment.bbox;
      if (fit && bbox) set({ mapOutline: { bbox, outline: false, nonce: nextNonce() } });
      // The band is the line's own drawing, not a selected area: the set goes without its echo.
      const rs: ResultSet = { ...result.resultSet, area: null };
      await get().presentResultSet(rs, { fit: false });
    } catch (e) {
      if (mine === run) set({ alignmentBusy: null, alignmentError: failure(e) });
    }
  }

  /** Shows a line (its result comes with the query). */
  function show(alignment: Alignment): Promise<void> {
    const same = get().alignment?.id === alignment.id;
    set({ alignment, ...(same ? {} : { alignmentResult: null }), alignmentError: null });
    return query(true);
  }

  return {
    alignments: null,
    alignment: null,
    alignmentResult: null,
    alignmentBufferM: DEFAULT_BUFFER_M,
    alignmentIncludeUnreviewed: false,
    alignmentBusy: null,
    alignmentError: null,
    alignmentDrawing: false,

    async listAlignments() {
      const source = get().source;
      if (!source) return;
      try {
        const alignments = await source.listAlignments();
        if (get().source === source) set({ alignments });
      } catch (e) {
        console.warn(`Planned lines: listing the earlier lines failed (${errorText(e)}).`);
      }
    },

    async uploadAlignment(file, options = {}) {
      const source = get().source;
      if (!source) return false;
      const mine = ++run;
      set({ alignmentBusy: 'upload', alignmentError: null });
      try {
        const alignment = await source.uploadAlignment(file, { ...options, bufferM: get().alignmentBufferM });
        if (mine !== run || get().source !== source) return true;
        set((s) => ({ alignments: [alignment, ...(s.alignments ?? []).filter((a) => a.id !== alignment.id)] }));
        await show(alignment);
        return true;
      } catch (e) {
        if (mine === run) set({ alignmentBusy: null, alignmentError: failure(e) });
        return false;
      }
    },

    async openAlignment(id) {
      const source = get().source;
      if (!source) return;
      const known = get().alignments?.find((a) => a.id === id);
      const mine = ++run;
      try {
        const alignment = known ?? (await source.getAlignment(id));
        if (mine !== run || get().source !== source) return;
        set({ alignmentBufferM: alignment.bufferM });
        await show(alignment);
      } catch (e) {
        if (mine === run) set({ alignmentBusy: null, alignmentError: failure(e) });
      }
    },

    async setAlignmentBuffer(m) {
      if (!(Number.isFinite(m) && m > 0 && m <= MAX_BUFFER_M)) return;
      if (m === get().alignmentBufferM && get().alignmentResult) return;
      set({ alignmentBufferM: m });
      await query(false);
    },

    async setAlignmentIncludeUnreviewed(on) {
      set({ alignmentIncludeUnreviewed: on });
      await query(false);
    },

    async deleteAlignment(id) {
      const source = get().source;
      if (!source) return;
      set({ alignmentBusy: 'delete', alignmentError: null });
      try {
        await source.deleteAlignment(id);
        if (get().source !== source) return;
        set((s) => ({ alignments: (s.alignments ?? []).filter((a) => a.id !== id), alignmentBusy: null }));
        if (get().alignment?.id === id) get().clearAlignment();
      } catch (e) {
        set({ alignmentBusy: null, alignmentError: failure(e) });
      }
    },

    clearAlignment() {
      run += 1;
      if (lineSetShown()) get().clearResultSet();
      set({ alignment: null, alignmentResult: null, alignmentBusy: null, alignmentError: null });
    },

    setAlignmentDrawing(on) {
      if (get().alignmentDrawing !== on) set({ alignmentDrawing: on });
    },
  };
};
