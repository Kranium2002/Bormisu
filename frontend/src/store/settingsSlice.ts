/**
 * Settings slice: the optional "Your name", kept in this browser's localStorage and sent with
 * confirmations (confirmed_by, later answered_by). Storage can be missing or blocked (private
 * windows, tests), so every access is guarded and the app works without it.
 */
import type { SliceCreator } from './context';
import type { SettingsSlice } from './types';

export const REVIEWER_NAME_KEY = 'bormisu.reviewerName';

/** The stored name, or null when none is set or storage can't be read. */
export function readReviewerName(): string | null {
  try {
    return globalThis.localStorage?.getItem(REVIEWER_NAME_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/** Stores the name, or removes it for null. Storage failures are ignored: the name still works for this session. */
function writeReviewerName(name: string | null): void {
  try {
    if (name) globalThis.localStorage?.setItem(REVIEWER_NAME_KEY, name);
    else globalThis.localStorage?.removeItem(REVIEWER_NAME_KEY);
  } catch {
    // Blocked storage: keep the name in memory only.
  }
}

export const createSettingsSlice: SliceCreator<SettingsSlice> = ({ set }) => ({
  reviewerName: readReviewerName(),

  setReviewerName(name) {
    const reviewerName = name.trim() || null;
    writeReviewerName(reviewerName);
    set({ reviewerName });
  },
});
