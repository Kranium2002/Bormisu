/**
 * What every slice gets: zustand's set / get plus the helpers more than one slice needs (finding
 * and taking boreholes, the pending-save tracker, documents the server deleted, keeping the map
 * features in step). Created once per store in appStore.ts.
 *
 * The boreholes array is a cache of full records: the unplotted ones from the boot, the rest fetched
 * on demand (Review, Detail, exports). Every plotted borehole is known by its light map feature.
 */
import type { StoreApi } from 'zustand';
import type { DataSource } from '../data/DataSource';
import { errorText } from '../data/errors';
import { fromOtherDocument } from '../domain/review';
import type { Borehole, Clarification, DocumentSummary, ExtractedValue, MapFeature } from '../domain/types';
import { SaveTracker } from './saves';
import type { AppState } from './types';

export interface StoreContext {
  set: StoreApi<AppState>['setState'];
  get: StoreApi<AppState>['getState'];
  /** Review saves still waiting for the source, per borehole. */
  saves: SaveTracker;
  /** A cached full record by uid. */
  find(uid: string | null | undefined): Borehole | undefined;
  /** The map feature of a plotted borehole by uid. */
  feature(uid: string | null | undefined): MapFeature | undefined;
  /** The document of a borehole the store knows (its feature or its cached record), else null. */
  documentOf(uid: string): string | null;
  /** Replaces one borehole in place (optimistic changes and settled saves). */
  replaceBorehole(uid: string, fn: (b: Borehole) => Borehole): void;
  /**
   * Takes boreholes as the source holds them (a refetch). A borehole with pending saves keeps its
   * optimistic state; the record is collected for when its saves settle. A record older than the
   * one shown (lower revision) is ignored. With `documentId`, the records are that document's full
   * list: its other boreholes are dropped (unless a save of theirs is pending). Records of a
   * document the server deleted (a fetch that answered after document.deleted) are dropped.
   *
   * A record taken also keeps the NOT ON MAP list in step: an unplotted one joins it (and loses a
   * pin it had), a plotted one leaves it (its document's features are refetched when it has no pin
   * yet). The on-demand load state of a record that arrived is cleared.
   */
  takeBoreholes(records: Borehole[], documentId?: string): void;
  /**
   * Refetches the map features of one document (GET /map/boreholes.geojson?document_id=) and puts
   * them in place of that document's features. One request per document at a time; calls while it
   * runs lead to one more request at most. Failures are logged; the next trigger tries again.
   */
  refreshFeatures(documentId: string): void;
  /**
   * Fetches a borehole and takes it (takeBoreholes respects pending saves and drops older records).
   * `revision` null fetches whatever the store holds; otherwise only while the store holds an older
   * one (or none). One refetch per uid at a time; a burst while it runs leads to one more at most.
   */
  refetchBorehole(uid: string, revision: number | null): void;
  /** Fetches a document the store shows and applies it like document.updated (one at a time per document). */
  refetchDocument(documentId: string): void;
  /**
   * Live clarification events for the clarifications slice (set by it when the store is created):
   * a new question, and a resolved one (returns the question when the list held it).
   */
  clarificationEvents: {
    created(question: Clarification): void;
    resolved(id: string, status: 'answered' | 'skipped'): Clarification | undefined;
  };
  /** Marks a document the server deleted (document.deleted): late answers about it are ignored from now on. */
  markDeleted(documentId: string): void;
  /** True when the current source deleted this document. */
  isDeleted(documentId: string | null): boolean;
}

/** A slice creator: builds one part of AppState from the shared context. */
export type SliceCreator<T> = (ctx: StoreContext) => T;

export function createContext(set: StoreContext['set'], get: StoreContext['get']): StoreContext {
  const saves = new SaveTracker();
  /** Deleted documents with the source that reported them (a new source, e.g. in tests, starts clean). */
  const deleted = new Map<string, unknown>();
  const isDeleted = (documentId: string | null) =>
    documentId !== null && deleted.has(documentId) && deleted.get(documentId) === get().source;
  const find = (uid: string | null | undefined) => get().boreholes.find((b) => b.uid === uid);
  const feature = (uid: string | null | undefined) => (uid ? get().features.find((f) => f.uid === uid) : undefined);

  /** The record to show: a pending save keeps the optimistic one (the record waits for it), an older record is ignored. */
  const take = (current: Borehole, incoming: Borehole): Borehole => {
    if (saves.isPending(incoming.uid)) {
      saves.observe(incoming, saves.nextOrder());
      return current;
    }
    return incoming.revision >= current.revision ? incoming : current;
  };

  /** Feature refetches in flight, per document, with the source asked. */
  const featureFetches = new Map<string, { source: DataSource; again: boolean }>();

  function refreshFeatures(documentId: string): void {
    const source = get().source;
    if (!source || isDeleted(documentId)) return;
    const running = featureFetches.get(documentId);
    if (running && running.source === source) {
      running.again = true;
      return;
    }
    const entry = { source, again: true };
    featureFetches.set(documentId, entry);
    void (async () => {
      while (entry.again) {
        entry.again = false;
        try {
          const fresh = await source.mapFeatures(documentId);
          if (get().source !== source || isDeleted(documentId)) break;
          set((s) => ({ features: replaceDocumentFeatures(s.features, documentId, fresh) }));
        } catch (e) {
          console.warn(`Map: refreshing the pins of document ${documentId} failed (${errorText(e)}).`);
        }
      }
      if (featureFetches.get(documentId) === entry) featureFetches.delete(documentId);
    })();
  }

  /** A borehole refetch in flight: what was asked for while it ran. */
  interface Refetch {
    source: DataSource;
    /** Another request arrived while the fetch ran. */
    again: boolean;
    /** Highest revision asked for. */
    want: number;
    /** Asked for the record whatever its revision (e.g. a clarification changed it). */
    force: boolean;
  }
  const boreholeFetches = new Map<string, Refetch>();
  const documentFetches = new Map<string, { source: DataSource; again: boolean }>();

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
          ctx.takeBoreholes([record]);
        } catch (e) {
          // The next event for this borehole tries again.
          console.warn(`Live update: fetching borehole ${uid} failed (${errorText(e)}).`);
        }
      }
      if (boreholeFetches.get(uid) === entry) boreholeFetches.delete(uid);
    })();
  }

  function refetchDocument(documentId: string): void {
    const source = get().source;
    if (!source || !get().documents.some((d) => d.id === documentId)) return;
    const running = documentFetches.get(documentId);
    if (running && running.source === source) {
      running.again = true;
      return;
    }
    const entry = { source, again: true };
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

  const ctx: StoreContext = {
    set,
    get,
    saves,
    find,
    feature,
    documentOf: (uid) => feature(uid)?.documentId ?? find(uid)?.documentId ?? null,
    markDeleted: (documentId) => void deleted.set(documentId, get().source),
    isDeleted,
    replaceBorehole: (uid, fn) => set((s) => ({ boreholes: s.boreholes.map((b) => (b.uid === uid ? fn(b) : b)) })),
    refreshFeatures,
    refetchBorehole,
    refetchDocument,
    clarificationEvents: { created: () => undefined, resolved: () => undefined },
    takeBoreholes(records, documentId) {
      if (documentId !== undefined && isDeleted(documentId)) return;
      const incoming = new Map(records.filter((r) => !isDeleted(r.documentId)).map((r) => [r.uid, r]));
      const arrived = [...incoming.keys()];
      const s = get();
      const next: Borehole[] = [];
      for (const b of s.boreholes) {
        const r = incoming.get(b.uid);
        if (r) {
          next.push(take(b, r));
          incoming.delete(b.uid);
        } else if (documentId === undefined || b.documentId !== documentId || saves.isPending(b.uid)) {
          next.push(b);
        }
      }
      const boreholes = [...next, ...incoming.values()];
      // Membership of the NOT ON MAP list follows the records shown.
      const shown = new Map(boreholes.map((b) => [b.uid, b]));
      const unplotted = new Set(s.unplottedUids);
      const pinned = new Set(s.features.map((f) => f.uid));
      const unpinned = new Set<string>();
      const needPins = new Set<string>();
      for (const uid of arrived) {
        const b = shown.get(uid);
        if (!b) continue;
        if (plotted(b)) {
          unplotted.delete(uid);
          if (b.documentId && !pinned.has(uid)) needPins.add(b.documentId);
        } else {
          unplotted.add(uid);
          unpinned.add(uid);
        }
      }
      set({
        boreholes,
        ...(sameMembers(s.unplottedUids, unplotted) ? {} : { unplottedUids: [...unplotted] }),
        ...(arrived.some((uid) => s.recordLoads[uid]) ? { recordLoads: withoutKeys(s.recordLoads, arrived) } : {}),
        ...([...unpinned].some((uid) => pinned.has(uid)) ? { features: s.features.filter((f) => !unpinned.has(f.uid)) } : {}),
      });
      for (const id of needPins) refreshFeatures(id);
    },
  };
  return ctx;
}

/** True when the server placed the borehole on the map and both coordinates are known. */
export function plotted(b: Borehole): boolean {
  return b.onMap && b.lat != null && b.lng != null && Number.isFinite(b.lat) && Number.isFinite(b.lng);
}

/**
 * The features with those of one document replaced by `fresh`: in the place of its first feature
 * (so the RESULTS order stays), or at the end when it had none.
 */
export function replaceDocumentFeatures(features: MapFeature[], documentId: string, fresh: MapFeature[]): MapFeature[] {
  const freshUids = new Set(fresh.map((f) => f.uid));
  const keep = (f: MapFeature) => f.documentId !== documentId && !freshUids.has(f.uid);
  const at = features.findIndex((f) => f.documentId === documentId);
  const others = features.filter(keep);
  if (at < 0) return [...others, ...fresh];
  const before = features.slice(0, at).filter(keep).length;
  return [...others.slice(0, before), ...fresh, ...others.slice(before)];
}

/** A copy of `record` without `keys`. */
export function withoutKeys<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const next = { ...record };
  for (const k of keys) delete next[k];
  return next;
}

const sameMembers = (list: string[], set: Set<string>) => list.length === set.size && list.every((x) => set.has(x));

let nonce = 0;
/** A number that changes on every call: signals (map focus, list scroll), toasts and stale-answer checks. */
export const nextNonce = () => ++nonce;

/** Leaving Review drops its transient UI, so Escape on another screen never acts on a hidden edit. */
export const LEAVE_REVIEW = { editing: null, confirmCleanOpen: false } as const;

export const pageKey = (documentId: string, page: number) => `${documentId}:${page}`;

/** The layer the detail screen selects first: the first SPT refusal (the demo's "R"), else layer 1. */
export function defaultLayer(b: Borehole | undefined): number {
  return b?.layers.find((l) => l.spt?.refusal)?.n ?? 1;
}

/** True if the Review screen can show this borehole: it has a source document and located values. */
export function isReviewable(b: Borehole | undefined): boolean {
  return !!b?.documentId && b.values.some((v) => v.page != null || v.cell != null);
}

/**
 * Review page for a value, as in the prototype: jump to its page when it has a box or isn't on page 1.
 * A value whose source is in another document keeps the page: its page numbers are that document's.
 * `current` is null for a borehole without pages, which then shows no page.
 */
export function pageFor(b: Borehole, v: ExtractedValue | undefined, current: number | null): number | null {
  if (!v || fromOtherDocument(b, v)) return current;
  return v.page && (v.box || v.page !== 1) ? v.page : current;
}

/** What the store knows about boreholes, for finding a document's review target. */
export type KnownBoreholes = Pick<AppState, 'boreholes' | 'features' | 'unplottedUids'>;

/**
 * A document update with its Review target filled in: a status poll doesn't know which borehole
 * Review should open (the API's document object has none), so keep the one we had or take the
 * document's first borehole once extraction reached "needs review": its first map feature, else its
 * first unplotted record that Review can show, else a cached record that Review can show. The
 * project, when the document has none, comes from those boreholes too.
 */
export function withReviewTarget(doc: DocumentSummary, prev: DocumentSummary | undefined, known: KnownBoreholes): DocumentSummary {
  if (doc.reviewBoreholeUid || doc.step < 2 || doc.error) return doc;
  const unplotted = new Set(known.unplottedUids);
  const own = known.boreholes.filter((b) => b.documentId === doc.id);
  const pinned = known.features.filter((f) => f.documentId === doc.id);
  const uid =
    prev?.reviewBoreholeUid ??
    pinned[0]?.uid ??
    own.find((b) => unplotted.has(b.uid) && isReviewable(b))?.uid ??
    own.find(isReviewable)?.uid ??
    null;
  const project = doc.project || pinned.find((f) => f.project)?.project || own.find((b) => b.project)?.project || '';
  return uid || project !== doc.project ? { ...doc, reviewBoreholeUid: uid, project } : doc;
}

/** True while the backend still works on a document (queued, classifying, extracting; not failed). */
export function isProcessing(doc: Pick<DocumentSummary, 'step' | 'error' | 'status'>): boolean {
  return doc.step < 2 && !doc.error && doc.status !== 'failed';
}
