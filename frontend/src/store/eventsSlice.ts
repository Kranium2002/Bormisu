/**
 * Events slice: live updates from the source (contracts/realtime-and-chat.md section 1). The source
 * delivers the event stream or, while it is down, documents its polling fallback fetched; this slice
 * keeps the transport status and applies each event as the contract's "Client action" says.
 *
 * Every handler is idempotent and treats events as hints to refetch, except document.updated, which
 * carries the whole document, and clarification.created, which carries the whole question. Refetches
 * of one borehole or document are coalesced (see context.ts). A cached full record is refetched;
 * a plotted borehole known only by its map feature gets its document's features refetched instead.
 */
import { errorText } from '../data/errors';
import type { Clarification, DocumentSummary, LiveEvent } from '../domain/types';
import { isProcessing, LEAVE_REVIEW, type SliceCreator } from './context';
import { withoutDocumentMapData } from './mapDataSlice';
import type { EventsSlice } from './types';

/** Toast when the document shown in Review or Detail was deleted on the server. */
export const deletedText = (name: string) => `${name} was deleted; its boreholes were removed.`;

export const createEventsSlice: SliceCreator<EventsSlice> = (ctx) => {
  const { set, get, find, feature, markDeleted, isDeleted, refetchBorehole, refetchDocument, refreshFeatures } = ctx;
  /** Ends the current subscription; null when none is open. */
  let unsubscribe: (() => void) | null = null;
  /** Bumped by every start and stop, so callbacks of an ended subscription are ignored. */
  let run = 0;
  /** What each clarification seen in this session concerns (clarification.resolved names only its id). */
  const clarifications = new Map<string, Pick<Clarification, 'documentId' | 'boreholeUids'>>();

  /**
   * Refetches what a clarification concerns, so the open-question badges and the pins' attention
   * stay right: its documents, its cached records and the features of its plotted boreholes.
   */
  function refreshClarification(target: Pick<Clarification, 'documentId' | 'boreholeUids'>): void {
    const documents = new Set([target.documentId]);
    const pinned = new Set<string>();
    if (get().features.some((f) => f.documentId === target.documentId)) pinned.add(target.documentId);
    for (const uid of target.boreholeUids) {
      const f = feature(uid);
      if (f?.documentId) {
        documents.add(f.documentId);
        pinned.add(f.documentId);
      }
      // Boreholes the store doesn't hold yet arrive with borehole.created.
      if (find(uid)) refetchBorehole(uid, null);
    }
    for (const id of documents) refetchDocument(id);
    for (const id of pinned) refreshFeatures(id);
  }

  /** Removes a deleted document, its boreholes, pins and cached pages; leaves Review or Detail when they show one of them. */
  function removeDocument(documentId: string): void {
    markDeleted(documentId);
    const s = get();
    const doc = s.documents.find((d) => d.id === documentId);
    const gone = new Set([
      ...s.boreholes.filter((b) => b.documentId === documentId).map((b) => b.uid),
      ...s.features.filter((f) => f.documentId === documentId).map((f) => f.uid),
    ]);
    if (!doc && !gone.size) return;
    const shown = (uid: string | null) => uid !== null && gone.has(uid);
    const leaveReview = s.screen === 'review' && shown(s.reviewUid);
    const leaveDetail = s.screen === 'detail' && shown(s.selectedUid);
    const panelGone = !!s.panel && (s.panel.documentId === documentId || (s.panel.kind === 'source' && shown(s.panel.uid ?? null)));
    const prefix = `${documentId}:`;
    set({
      documents: s.documents.filter((d) => d.id !== documentId),
      boreholes: s.boreholes.filter((b) => !gone.has(b.uid)),
      ...withoutDocumentMapData(s, documentId, gone),
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

  /**
   * A borehole was created or changed on the server (`plotted` null when the event doesn't say).
   * - Its full record is refetched when cached and older than the event, and fetched when the store
   *   knows nothing of it and it is not on the map (NOT ON MAP lists full records; the record then
   *   joins that list, or brings its document's pins when it turns out plotted).
   * - Its document's pins are refetched when it is, or may be, on the map and its pin is older.
   */
  function boreholeChanged(uid: string, revision: number, documentId: string | null, plotted: boolean | null): void {
    const record = find(uid);
    const pin = feature(uid);
    if (record) {
      if (record.revision < revision) refetchBorehole(uid, revision);
    } else if (!pin && plotted !== true) {
      refetchBorehole(uid, revision);
    }
    const doc = documentId ?? pin?.documentId ?? record?.documentId ?? null;
    const mayBePinned = plotted ?? (!!pin || !!record?.onMap);
    if (doc && mayBePinned && (pin?.revision ?? -1) < revision) refreshFeatures(doc);
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
        case 'borehole.created': {
          if (isDeleted(event.documentId)) return;
          boreholeChanged(event.uid, event.revision, event.documentId, event.plotted);
          return;
        }
        case 'borehole.updated':
          boreholeChanged(event.uid, event.revision, null, null);
          return;
        case 'clarification.created': {
          const c = event.clarification;
          const target = { documentId: c.documentId, boreholeUids: c.boreholeUids };
          clarifications.set(c.id, target);
          ctx.clarificationEvents.created(c);
          refreshClarification(target);
          return;
        }
        case 'clarification.resolved': {
          const listed = ctx.clarificationEvents.resolved(event.clarificationId, event.status);
          const target = listed ?? clarifications.get(event.clarificationId);
          if (event.status === 'answered') clarifications.delete(event.clarificationId);
          if (target) {
            refreshClarification(target);
            return;
          }
          // Asked before this page loaded and not in the list: refetch whatever shows open questions.
          const s = get();
          for (const d of s.documents) if (d.openClarifications > 0) refetchDocument(d.id);
          for (const b of s.boreholes) if (b.openClarifications > 0) refetchBorehole(b.uid, null);
          const pinned = new Set(s.features.filter((f) => f.openClarifications > 0 && f.documentId).map((f) => f.documentId as string));
          for (const id of pinned) refreshFeatures(id);
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
