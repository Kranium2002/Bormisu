/**
 * What every slice gets: zustand's set / get plus the helpers more than one slice needs (finding
 * and taking boreholes, the pending-save tracker). Created once per store in appStore.ts.
 */
import type { StoreApi } from 'zustand';
import type { Borehole, DocumentSummary, ExtractedValue } from '../domain/types';
import { SaveTracker } from './saves';
import type { AppState } from './types';

export interface StoreContext {
  set: StoreApi<AppState>['setState'];
  get: StoreApi<AppState>['getState'];
  /** Review saves still waiting for the source, per borehole. */
  saves: SaveTracker;
  /** A borehole by uid. */
  find(uid: string | null | undefined): Borehole | undefined;
  /** Replaces one borehole in place (optimistic changes and settled saves). */
  replaceBorehole(uid: string, fn: (b: Borehole) => Borehole): void;
  /**
   * Takes boreholes as the source holds them (a refetch). A borehole with pending saves keeps its
   * optimistic state; the record is collected for when its saves settle. A record older than the
   * one shown (lower revision) is ignored. With `documentId`, the records are that document's full
   * list: its other boreholes are dropped (unless a save of theirs is pending).
   */
  takeBoreholes(records: Borehole[], documentId?: string): void;
}

/** A slice creator: builds one part of AppState from the shared context. */
export type SliceCreator<T> = (ctx: StoreContext) => T;

export function createContext(set: StoreContext['set'], get: StoreContext['get']): StoreContext {
  const saves = new SaveTracker();
  const find = (uid: string | null | undefined) => get().boreholes.find((b) => b.uid === uid);

  const take = (current: Borehole, incoming: Borehole): Borehole => {
    if (saves.isPending(incoming.uid)) {
      saves.observe(incoming, saves.nextOrder());
      return current;
    }
    return incoming.revision >= current.revision ? incoming : current;
  };

  return {
    set,
    get,
    saves,
    find,
    replaceBorehole: (uid, fn) => set((s) => ({ boreholes: s.boreholes.map((b) => (b.uid === uid ? fn(b) : b)) })),
    takeBoreholes(records, documentId) {
      const incoming = new Map(records.map((r) => [r.uid, r]));
      const next: Borehole[] = [];
      for (const b of get().boreholes) {
        const r = incoming.get(b.uid);
        if (r) {
          next.push(take(b, r));
          incoming.delete(b.uid);
        } else if (documentId === undefined || b.documentId !== documentId || saves.isPending(b.uid)) {
          next.push(b);
        }
      }
      set({ boreholes: [...next, ...incoming.values()] });
    },
  };
}

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

/** Review page for a value, as in the prototype: jump to its page when it has a box or isn't on page 1. */
export function pageFor(v: ExtractedValue | undefined, current: number): number {
  return v?.page && (v.box || v.page !== 1) ? v.page : current;
}

/**
 * A document update with its Review target filled in: a status poll doesn't know which borehole
 * Review should open (the API's document object has none), so keep the one we had or take the
 * document's first borehole once extraction reached "needs review".
 */
export function withReviewTarget(doc: DocumentSummary, prev: DocumentSummary | undefined, boreholes: Borehole[]): DocumentSummary {
  if (doc.reviewBoreholeUid || doc.step < 2 || doc.error) return doc;
  const uid = prev?.reviewBoreholeUid ?? boreholes.find((b) => b.documentId === doc.id && isReviewable(b))?.uid ?? null;
  const project = doc.project || boreholes.find((b) => b.documentId === doc.id)?.project || '';
  return uid || project !== doc.project ? { ...doc, reviewBoreholeUid: uid, project } : doc;
}
