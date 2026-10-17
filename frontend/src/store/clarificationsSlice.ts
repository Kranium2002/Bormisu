/**
 * Clarifications slice (FRONTEND.md F12): the unresolved questions (open and skipped) for the inbox,
 * the badge and the dialog, from GET /clarifications after the first load and from live events.
 *
 * Answering sends the reviewer's name. On success the question leaves the list and what it changed
 * is refetched: the affected cached records, the document and the map (a CRS answer can place a
 * whole file). A 422 comes back as field errors by field name; a question someone else answered
 * meanwhile (409 already_resolved) leaves the list with a note. Skipping keeps the question in the
 * list as skipped: it is still unresolved and can be answered later.
 */
import { ApiError, errorText, isApiError, type FieldError } from '../data/errors';
import type { Clarification, ClarificationKind, FormField } from '../domain/types';
import type { SliceCreator } from './context';
import type { AnswerResult, ClarificationsSlice } from './types';

/** Note when a question was answered elsewhere before this answer arrived. */
export const ALREADY_ANSWERED = 'This question was already answered elsewhere; it has left the list.';
/** Note when the server no longer knows the question. */
export const QUESTION_GONE = 'This question no longer exists; it has left the list.';
/** Lead of the toast after an answer placed boreholes ("Answer stored · 3 boreholes placed"). */
export const ANSWER_STORED = 'Answer stored';

/** Questions whose answer places boreholes on the map: a coordinate system, a position. */
const PLACING_KINDS = new Set<ClarificationKind | undefined>(['crs_confirm', 'locate_borehole']);

/** Oldest first by creation time, as the server lists them (stable for equal times). */
export function oldestFirst(list: Clarification[]): Clarification[] {
  const time = (c: Clarification) => {
    const t = Date.parse(c.createdAt);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => time(a.c) - time(b.c) || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Field errors of a 422 by field name: each error's `loc` ends with the field (`[..., field]`, an
 * index may follow it). With the question's fields known, only their names count; errors about the
 * answer as a whole go into the message only. Several errors of one field are joined.
 */
export function fieldErrorsOf(errors: FieldError[], fields?: FormField[]): Record<string, string> {
  const names = fields?.length ? new Set(fields.map((f) => f.name)) : null;
  const out: Record<string, string> = {};
  for (const e of errors) {
    const field = [...(e.loc ?? [])].reverse().find((x): x is string => typeof x === 'string' && (!names || names.has(x)));
    if (!field || !e.msg) continue;
    out[field] = out[field] && out[field] !== e.msg ? `${out[field]}; ${e.msg}` : e.msg;
  }
  return out;
}

export const createClarificationsSlice: SliceCreator<ClarificationsSlice> = (ctx) => {
  const { set, get, find, refetchBorehole, refetchDocument } = ctx;
  let loadRun = 0;
  /** Questions that arrived through events while a list request ran: they stay when it answers. */
  const arrivedDuringLoad = new Set<string>();
  /** Questions resolved in this session, with the source that resolved them: a list fetched before never brings them back. */
  const resolved = new Map<string, unknown>();
  const isResolved = (id: string) => resolved.has(id) && resolved.get(id) === get().source;

  const question = (id: string) => get().clarifications.find((c) => c.id === id);

  /** Takes a question out of the list (and out of the dialog). */
  function remove(id: string): void {
    resolved.set(id, get().source);
    set((s) => ({
      clarifications: s.clarifications.filter((c) => c.id !== id),
      ...(s.activeClarificationId === id ? { activeClarificationId: null } : {}),
    }));
  }

  /** Puts the server's version of a question in place of the listed one (or adds it, oldest first). */
  function put(c: Clarification): void {
    set((s) => {
      const at = s.clarifications.findIndex((x) => x.id === c.id);
      if (at < 0) return { clarifications: oldestFirst([...s.clarifications, c]) };
      const clarifications = [...s.clarifications];
      clarifications[at] = c;
      return { clarifications };
    });
  }

  /**
   * After a question was resolved: its document(s) and cached records, so counts and badges are
   * right, and the map (an answer can place or move boreholes). Returns the map reload.
   */
  function refreshAfterAnswer(c: Pick<Clarification, 'documentId' | 'boreholeUids'> | undefined): Promise<void> {
    if (c) {
      const documents = new Set([c.documentId]);
      for (const uid of c.boreholeUids) {
        const doc = ctx.documentOf(uid);
        if (doc) documents.add(doc);
        if (find(uid)) refetchBorehole(uid, null);
      }
      for (const id of documents) refetchDocument(id);
    }
    return get().refreshMap();
  }

  ctx.clarificationEvents = {
    created(c) {
      if (isResolved(c.id) || c.status === 'answered') return;
      arrivedDuringLoad.add(c.id);
      put(c);
    },
    resolved(id, status) {
      const known = question(id);
      if (status === 'answered') {
        remove(id);
      } else if (known && known.status !== 'skipped') {
        put({ ...known, status: 'skipped' });
      }
      return known;
    },
  };

  return {
    clarifications: [],
    clarificationsState: 'idle',
    activeClarificationId: null,

    async loadClarifications() {
      const source = get().source;
      if (!source) return;
      const run = ++loadRun;
      arrivedDuringLoad.clear();
      set({ clarificationsState: 'loading' });
      try {
        // Unresolved means open or skipped: the list endpoint filters one status per call.
        const [open, skipped] = await Promise.all([source.clarifications({ status: 'open' }), source.clarifications({ status: 'skipped' })]);
        if (run !== loadRun || get().source !== source) return;
        const fetched = new Map([...open, ...skipped].map((c) => [c.id, c]));
        const live = get().clarifications.filter((c) => !fetched.has(c.id) && arrivedDuringLoad.has(c.id));
        set({
          clarifications: oldestFirst([...fetched.values(), ...live]).filter((c) => !isResolved(c.id)),
          clarificationsState: 'ready',
        });
      } catch (e) {
        if (run !== loadRun) return;
        console.warn(`Loading the questions failed (${errorText(e)}).`);
        set({ clarificationsState: 'error' });
      }
    },

    openClarification(id) {
      set({ activeClarificationId: id });
    },

    closeClarification() {
      set({ activeClarificationId: null });
    },

    async answerClarification(id, values): Promise<AnswerResult> {
      const { source, reviewerName } = get();
      const asked = question(id);
      if (!source) return { ok: false, message: 'Not connected to a data source.', fieldErrors: {} };
      try {
        const answered = await source.answerClarification(id, values, reviewerName);
        remove(id);
        const target = { documentId: answered.documentId, boreholeUids: [...new Set([...(asked?.boreholeUids ?? []), ...answered.boreholeUids])] };
        const map = refreshAfterAnswer(target);
        // A coordinate system or a position places boreholes: once the pins are reloaded, the map
        // flies to them (and, off the map, the toast offers SHOW ON MAP). This toast follows the
        // dialog's own "Answer stored".
        if (PLACING_KINDS.has(answered.kind ?? asked?.kind)) {
          void map.then(() => get().revealPlaced({ uids: target.boreholeUids }, ANSWER_STORED));
        }
        return { ok: true };
      } catch (e) {
        if (isApiError(e, 'already_resolved') || isApiError(e, 'clarification_not_found')) {
          const text = isApiError(e, 'already_resolved') ? ALREADY_ANSWERED : QUESTION_GONE;
          remove(id);
          void refreshAfterAnswer(asked);
          get().showToast(text);
          return { ok: false, message: text, fieldErrors: {} };
        }
        if (e instanceof ApiError && e.status === 422) {
          return { ok: false, message: e.detail, fieldErrors: fieldErrorsOf(e.errors, asked?.fields) };
        }
        return { ok: false, message: errorText(e), fieldErrors: {} };
      }
    },

    async skipClarification(id) {
      const source = get().source;
      if (!source) return;
      const asked = question(id);
      try {
        const skipped = await source.skipClarification(id);
        // Still unresolved: it stays in the list (and keeps its badge), as the server now has it.
        if (skipped.status === 'answered') remove(id);
        else if (!isResolved(id)) put(skipped);
        set((s) => (s.activeClarificationId === id ? { activeClarificationId: null } : {}));
      } catch (e) {
        if (isApiError(e, 'already_resolved') || isApiError(e, 'clarification_not_found')) {
          remove(id);
          void refreshAfterAnswer(asked);
          get().showToast(isApiError(e, 'already_resolved') ? ALREADY_ANSWERED : QUESTION_GONE);
          return;
        }
        get().showToast(`Not skipped: ${errorText(e)}`);
      }
    },
  };
};
