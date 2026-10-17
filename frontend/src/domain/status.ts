/**
 * Borehole status and the "clean value" rule, mirrored from the backend so the UI can show the right
 * state in the moment between a click and the server's answer. The server's values win as soon as
 * they arrive (review_status on records, attention on map features, approve-clean counts).
 */
import type { Borehole, BoreholeReviewStatus, BoreholeStatus, ExtractedValue } from './types';

/** OCR values at or above this confidence count as clean (backend setting CLEAN_CONFIDENCE, default 0.9). */
export const CLEAN_CONFIDENCE = 0.9;

/**
 * Review status as the backend computes it, over the values that have a provenance entry:
 * approved = every one approved; unreviewed = none reviewed yet; in_review = anything in between
 * (a flagged value counts as reviewed but keeps the borehole in review).
 */
export function deriveReviewStatus(values: ExtractedValue[]): BoreholeReviewStatus {
  const reviewable = values.filter((v) => v.hasProvenance);
  if (reviewable.length === 0 || reviewable.every((v) => v.status === 'unreviewed')) return 'unreviewed';
  if (reviewable.every((v) => v.status === 'approved')) return 'approved';
  return 'in_review';
}

/**
 * True when a value is flagged, a lint error exists or a clarification is open (backend `attention`).
 * Lints the client adds on its own don't count, so chips and pins agree with the server's map layer.
 */
export function hasAttention(b: Borehole): boolean {
  return (
    b.openClarifications > 0 ||
    b.values.some((v) => v.status === 'flagged' || (v.lint?.severity === 'error' && !v.lint.client))
  );
}

/** What chips and pins show: attention wins over the review status. */
export function displayStatus(b: Borehole): BoreholeStatus {
  return hasAttention(b) ? 'attention' : b.reviewStatus;
}

/**
 * A value is clean when it is unreviewed, its state is ok, it has no flag and no lint, it has a
 * provenance entry, and it was read from a text layer or OCRed with confidence >= CLEAN_CONFIDENCE.
 */
export function isClean(v: ExtractedValue): boolean {
  if (!v.hasProvenance || v.status !== 'unreviewed' || v.state !== 'ok' || v.flag || v.lint) return false;
  return v.method === 'Read' || (v.method === 'OCR' && v.confidence != null && v.confidence >= CLEAN_CONFIDENCE);
}

/** Keys of a borehole's clean values. */
export function cleanKeys(b: Borehole): string[] {
  return b.values.filter(isClean).map((v) => v.key);
}
