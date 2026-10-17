/**
 * Events slice: live updates from the source (contracts/realtime-and-chat.md section 1). The source
 * delivers the event stream or, while it is down, documents its polling fallback fetched; this slice
 * keeps the transport status and applies each event as the contract's "Client action" says.
 *
 * Every handler is idempotent and treats events as hints to refetch, except document.updated, which
 * carries the whole document. Refetches of one borehole are coalesced: one runs at a time, and a
 * burst of events while it runs leads to one more refetch at most.
 */
import type { DataSource } from '../data/DataSource';
import { errorText } from '../data/errors';
import type { DocumentSummary, LiveEvent } from '../domain/types';
import { isProcessing, LEAVE_REVIEW, type SliceCreator } from './context';
import type { EventsSlice } from './types';

/** Toast when the document shown in Review or Detail was deleted on the server. */
export const deletedText = (name: string) => `${name} was deleted; its boreholes were removed.`;

/** A borehole refetch in flight: what was asked for while it ran. */
interface Refetch {
  source: DataSource;
  /** Another event arrived while the fetch ran. */
  again: boolean;
  /** Highest revision an event named. */
  want: number;
  /** An event asked for the record whatever its revision (e.g. a clarification changed it). */
  force: boolean;
}

/** A document refetch in flight. */
interface DocumentRefetch {
  source: DataSource;
  again: boolean;
}

export const createEventsSlice: SliceCreator<EventsSlice> = ({ set, get, find, takeBoreholes, markDeleted, isDeleted }) => {
  /** Ends the current subscription; null when none is open. */
  let unsubscribe: (() => void) | null = null;
  /** Bumped by every start and stop, so callbacks of an ended subscription are ignored. */
  let run = 0;
  const boreholeFetches = new Map<string, Refetch>();
  const documentFetches = new Map<string, DocumentRefetch>();
  /** What each clarification seen in this session concerns (clarification.resolved names only its id). */
  const clarifications = new Map<string, { documentId: string; boreholeUids: string[] }>();

  /**
   * Fetches a borehole and takes it (takeBoreholes respects pending saves and drops older records).
   * `revision` null fetches whatever the store holds; otherwise only while the store holds an older one.
   */
  function refetchBorehole(uid: string, revision: number | null): void {
    const source = get().source;
    if (!source) return;
    const running = boreholeFetches.get(uid);
    if (running && running.source === source) {
      running.again = true;
      if (revision === null) running.force = true;
      else running.want = Math.max(running.want, revision);
      return;
    }
    const entry: Refetch = { source, again: true, want: revision ?? -1, force: revision === null };
    boreholeFetches.set(uid, entry);
    void (async () => {
      while (entry.again) {
        entry.again = false;
        if (!entry.force && (find(uid)?.revision ?? -1) >= entry.want) continue;
        entry.force = false;
        try {
          const record = await source.getBorehole(uid);
          if (get().source !== source) break;
          takeBoreholes([record]);
        } catch (e) {
          // The next event for this borehole tries again.
          console.warn(`Live update: fetching borehole ${uid} failed (${errorText(e)}).`);
        }
      }
      if (boreholeFetches.get(uid) === entry) boreholeFetches.delete(uid);
    })();
  }

  /** Fetches a document the store shows and applies it like document.updated. */
  function refetchDocument(documentId: string): void {
    const source = get().source;
    if (!source || !get().documents.some((d) => d.id === documentId)) return;
    const running = documentFetches.get(documentId);
    if (running && running.source === source) {
      running.again = true;
      return;
    }
    const entry: DocumentRefetch = { source, again: true };
    documentFetches.set(documentId, entry);
    void (async () => {
      while (entry.again) {
        entry.again = false;
        try {
          const doc = await source.getDocument(documentId);
          if (get().source !== source) break;
          get().documentUpdated(doc);
        } catch (e) {
          console.warn(`Live update: fetching document ${documentId} failed (${errorText(e)}).`);
        }
      }
      if (documentFetches.get(documentId) === entry) documentFetches.delete(documentId);
    })();
  }

  /** Refetches what a clarification concerns, so the open-question badges stay right (the inbox is M2). */
  function refreshClarification(target: { documentId: string; boreholeUids: string[] }): void {
    refetchDocument(target.documentId);
    // Boreholes the store doesn't hold yet arrive with borehole.created.
    for (const uid of target.boreholeUids) if (find(uid)) refetchBorehole(uid, null);
  }

  /** Removes a deleted document, its boreholes and cached pages; leaves Review or Detail when they show one of them. */
  function removeDocument(documentId: string): void {
    markDeleted(documentId);
    const s = get();
    const doc = s.documents.find((d) => d.id === documentId);
    const gone = new Set(s.boreholes.filter((b) => b.documentId === documentId).map((b) => b.uid));
    if (!doc && !gone.size) return;
    const shown = (uid: string | null) => uid !== null && gone.has(uid);
    const leaveReview = s.screen === 'review' && shown(s.reviewUid);
    const leaveDetail = s.screen === 'detail' && shown(s.selectedUid);
    const panelGone = !!s.panel && (s.panel.documentId === documentId || (s.panel.kind === 'source' && shown(s.panel.uid ?? null)));
    const prefix = `${documentId}:`;
    set({
      documents: s.documents.filter((d) => d.id !== documentId),
      boreholes: s.boreholes.filter((b) => !gone.has(b.uid)),
      pages: Object.fromEntries(Object.entries(s.pages).filter(([key]) => !key.startsWith(prefix))),
      jobFailures: Object.fromEntries(Object.entries(s.jobFailures).filter(([id]) => id !== documentId)),
      ...(shown(s.reviewUid) ? { ...LEAVE_REVIEW, reviewUid: null, focusKey: null, reviewPage: null } : {}),
      ...(shown(s.selectedUid) ? { selectedUid: null } : {}),
      ...(panelGone ? { panel: null } : {}),
    });
    if (leaveReview || leaveDetail) {
      get().go(leaveReview ? 'queue' : 'map');
      get().showToast(deletedText(doc?.name ?? 'The document'));
    }
  }

  function documentEvent(document: DocumentSummary): void {
    const known = get().documents.some((d) => d.id === document.id);
    get().documentUpdated(document);
    // A document first seen through an event (e.g. uploaded in another tab) is followed by the polling fallback too.
    if (!known && isProcessing(document) && !isDeleted(document.id)) get().source?.follow(document.id);
  }

  return {
    liveStatus: 'connecting',
    jobFailures: {},

    startLive() {
      get().stopLive();
      const source = get().source;
      if (!source) return;
      const mine = run;
      set({ liveStatus: 'connecting' });
      try {
        unsubscribe = source.subscribe(
          (event) => {
            if (mine === run) get().applyLiveEvent(event);
          },
          (status) => {
            if (mine === run) set({ liveStatus: status });
          },
        );
      } catch (e) {
        console.warn(`Live updates unavailable (${errorText(e)}).`);
        set({ liveStatus: 'offline' });
      }
    },

    stopLive() {
      run += 1;
      const end = unsubscribe;
      unsubscribe = null;
      end?.();
    },

    applyLiveEvent(event: LiveEvent) {
      switch (event.type) {
        case 'document.updated':
          documentEvent(event.document);
          return;
        case 'document.deleted':
          removeDocument(event.documentId);
          return;
        case 'borehole.created':
        case 'borehole.updated': {
          if (event.type === 'borehole.created' && isDeleted(event.documentId)) return;
          // Only when the store holds an older revision, or none.
          if ((find(event.uid)?.revision ?? -1) >= event.revision) return;
          refetchBorehole(event.uid, event.revision);
          return;
        }
        case 'clarification.created': {
          const target = { documentId: event.documentId, boreholeUids: event.boreholeUids };
          clarifications.set(event.clarificationId, target);
          refreshClarification(target);
          return;
        }
        case 'clarification.resolved': {
          const target = clarifications.get(event.clarificationId);
          clarifications.delete(event.clarificationId);
          if (target) {
            refreshClarification(target);
            return;
          }
          // Asked before this page loaded: refetch whatever shows open questions.
          const s = get();
          for (const d of s.documents) if (d.openClarifications > 0) refetchDocument(d.id);
          for (const b of s.boreholes) if (b.openClarifications > 0) refetchBorehole(b.uid, null);
          return;
        }
        case 'job.failed': {
          const { documentId, stage, detail, retryable } = event;
          const known = get().jobFailures[documentId];
          if (known && known.stage === stage && known.detail === detail && known.retryable === retryable) return;
          set((s) => ({ jobFailures: { ...s.jobFailures, [documentId]: { stage, detail, retryable } } }));
          return;
        }
      }
    },
  };
};
