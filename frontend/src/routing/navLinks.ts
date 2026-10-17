/**
 * Targets of the header links and of the store's navigation actions, from store state (pure).
 */
import type { Borehole, DocumentSummary, MapFeature } from '../domain/types';
import { mapPath, reviewPath, type MapView } from './urlState';

interface ReviewState {
  reviewUid: string | null;
  focusKey: string | null;
  /** Cached full records. */
  boreholes: Pick<Borehole, 'uid'>[];
  /** Plotted boreholes the map knows (their records load on demand). */
  features?: Pick<MapFeature, 'uid'>[];
  /** Boreholes listed under NOT ON MAP. */
  unplottedUids?: string[];
  documents: Pick<DocumentSummary, 'reviewBoreholeUid'>[];
}

/**
 * The borehole Review opens without one being named: the last reviewed borehole, else the first
 * document's review borehole; only boreholes the store knows (a cached record, a pin or a NOT ON MAP
 * entry: Review loads the record itself). Null when there is none.
 */
export function reviewTarget(s: Omit<ReviewState, 'focusKey'>): string | null {
  const known = (uid: string | null): uid is string =>
    !!uid &&
    (s.boreholes.some((b) => b.uid === uid) || !!s.features?.some((f) => f.uid === uid) || !!s.unplottedUids?.includes(uid));
  if (known(s.reviewUid)) return s.reviewUid;
  return s.documents.map((d) => d.reviewBoreholeUid).find(known) ?? null;
}

/** URL of the REVIEW link (with the focused value when it is the last reviewed borehole), or null. */
export function reviewHref(s: ReviewState): string | null {
  const uid = reviewTarget(s);
  return uid ? reviewPath(uid, uid === s.reviewUid ? s.focusKey : null) : null;
}

/** Why the REVIEW link is off (shown as its tooltip). */
export function reviewOffReason(loadState: 'loading' | 'ready' | 'error'): string {
  if (loadState === 'loading') return 'Loading boreholes and documents…';
  if (loadState === 'error') return 'Nothing is loaded';
  return 'No report is ready for review yet. Upload one under UPLOAD & QUEUE.';
}

/** URL of the MAP link: back to the last view and result set, without reopening a popup. */
export function mapHref(s: { mapView: MapView | null; resultSetId: string | null }): string {
  return mapPath({ at: s.mapView, sel: null, rs: s.resultSetId });
}
