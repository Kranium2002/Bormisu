/**
 * The app store (zustand): one store combined from slices, plus the selectors screens use.
 * - dataSlice: data source, health, boot load, page cache
 * - reviewSlice: Review screen, saves, approve all clean, CRS dialog
 * - mapSlice: Detail selection, header search, map focus
 * - mapDataSlice: map features, NOT ON MAP, full records on demand, filters, result sets, places
 * - uploadSlice: drop zone, upload queue, retries, document updates
 * - panelSlice: navigation, side panel, export menu, toast, Escape
 * - settingsSlice: the reviewer's name
 * - eventsSlice: live updates (transport status, event handlers, job failures)
 * - clarificationsSlice: the questions (inbox, badge, dialog), answers and skips
 * - authSlice: sign-in, registration, sign-out, password change, ended sessions
 * - chatSlice: the chat drawer's state
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { Borehole, DocumentSummary, ExtractedValue, Health } from '../domain/types';
import { createAuthSlice } from './authSlice';
import { createChatSlice } from './chatSlice';
import { createClarificationsSlice } from './clarificationsSlice';
import { createContext, isReviewable, pageKey } from './context';
import { createDataSlice } from './dataSlice';
import { createEventsSlice } from './eventsSlice';
import { createMapDataSlice } from './mapDataSlice';
import { createMapSlice } from './mapSlice';
import { createPanelSlice } from './panelSlice';
import { createReviewSlice } from './reviewSlice';
import { createSettingsSlice } from './settingsSlice';
import type { AppState, PageLoad } from './types';
import { createUploadSlice } from './uploadSlice';

export type {
  AnswerResult,
  AppState,
  CompletenessPanel,
  EditingState,
  EditMode,
  ExportKind,
  ListScroll,
  LoadState,
  MapFocus,
  PageLoad,
  PanelState,
  SourcePanel,
  Toast,
} from './types';
export { isReviewable } from './context';

export const useAppStore = create<AppState>()((set, get) => {
  const ctx = createContext(set, get);
  return {
    ...createDataSlice(ctx),
    ...createReviewSlice(ctx),
    ...createMapSlice(ctx),
    ...createMapDataSlice(ctx),
    ...createUploadSlice(ctx),
    ...createPanelSlice(ctx),
    ...createSettingsSlice(ctx),
    ...createEventsSlice(ctx),
    ...createClarificationsSlice(ctx),
    ...createAuthSlice(ctx),
    ...createChatSlice(ctx),
  };
});

/* ---------- selectors ---------- */

/** A borehole by uid. */
export function useBorehole(uid: string | null | undefined): Borehole | undefined {
  return useAppStore((s) => (uid ? s.boreholes.find((b) => b.uid === uid) : undefined));
}

/** One value of a borehole. */
export function useValue(uid: string | null | undefined, key: string | null | undefined): ExtractedValue | undefined {
  return useAppStore((s) => (uid && key ? s.boreholes.find((b) => b.uid === uid)?.values.find((v) => v.key === key) : undefined));
}

/** A document by id. */
export function useDocument(id: string | null | undefined): DocumentSummary | undefined {
  return useAppStore((s) => (id ? s.documents.find((d) => d.id === id) : undefined));
}

/** The borehole shown on the Review screen. */
export function useReviewBorehole(): Borehole | undefined {
  return useAppStore((s) => s.boreholes.find((b) => b.uid === s.reviewUid));
}

/** The borehole shown on the Detail screen. */
export function useSelectedBorehole(): Borehole | undefined {
  return useAppStore((s) => s.boreholes.find((b) => b.uid === s.selectedUid));
}

/** True if the Review screen can show this borehole. */
export function useIsReviewable(uid: string | null | undefined): boolean {
  return useAppStore((s) => isReviewable(s.boreholes.find((b) => b.uid === uid)));
}

/** Server mode, providers (e.g. `chat` for the coming chat drawer) and upload limits; null while unknown. */
export function useHealth(): Health | null {
  return useAppStore((s) => s.health);
}

/**
 * The name stored with confirmations and answers: the signed-in user's (the server records it from
 * the session), else the optional "Your name" of this browser; null when there is none.
 */
export function useSignedName(): string | null {
  return useAppStore((s) => (s.authState === 'signedIn' ? (s.user?.displayName ?? s.user?.email ?? null) : s.reviewerName));
}

const LOADING: PageLoad = { status: 'loading' };
const NO_PAGE: PageLoad = { status: 'error', error: 'No source page for this value' };

/** A rendered page; loads it into the cache on first use. */
export function usePage(documentId: string | null | undefined, page: number | null | undefined): PageLoad {
  const key = documentId && page ? pageKey(documentId, page) : null;
  const entry = useAppStore((s) => (key ? s.pages[key] : undefined));
  const loadPage = useAppStore((s) => s.loadPage);
  const ready = useAppStore((s) => s.source !== null);
  useEffect(() => {
    if (documentId && page && ready) void loadPage(documentId, page);
  }, [documentId, page, ready, loadPage]);
  if (!key) return NO_PAGE;
  return entry ?? LOADING;
}
