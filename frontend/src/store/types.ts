/**
 * State and action types of the app store. The store is one zustand store made of slices
 * (data, review, map, upload, panel, settings); each slice file builds its part from a shared
 * StoreContext (context.ts).
 */
import type { DataSource } from '../data/DataSource';
import type {
  Borehole,
  Box,
  CrsCandidate,
  DocumentSummary,
  FieldState,
  Health,
  PageContent,
  Screen,
} from '../domain/types';

export type LoadState = 'loading' | 'ready' | 'error';
export type ExportKind = 'xlsx' | 'csv' | 'questions';
export type EditMode = 'edit' | 'flag';

export interface EditingState { key: string; mode: EditMode; text: string }
export interface SourcePanel {
  kind: 'source';
  uid?: string;
  key?: string;
  documentId: string;
  /** Page to show; null for a spreadsheet value, which has a cell instead. */
  page: number | null;
  box?: Box | null;
  /** Spreadsheet cell of the value, e.g. "Logdata!C5" (no page image then). */
  cell?: string;
  /** Opened from a page cell (queue page strip), not from a value. */
  pageOnly?: boolean;
}
export interface CompletenessPanel { kind: 'completeness'; documentId: string }
export type PanelState = SourcePanel | CompletenessPanel | null;

/** A page in the cache: loading, loaded or failed. */
export type PageLoad =
  | { status: 'loading' }
  | { status: 'ready'; content: PageContent }
  | { status: 'error'; error: string };

/** Signal for the map to fly to a borehole; `nonce` changes on every request. */
export interface MapFocus { uid: string; zoom: number; nonce: number }
/** Signal for the review list to scroll a value into view. */
export interface ListScroll { key: string; nonce: number }
export interface Toast { text: string; id: number }

/** Data source, server health, load state and the data itself. */
export interface DataSlice {
  source: DataSource | null;
  /** Mode, providers and upload limits from the source; null until known or when the check failed. */
  health: Health | null;
  loadState: LoadState;
  loadError: string | null;
  boreholes: Borehole[];
  documents: DocumentSummary[];
  /** Page cache keyed `${documentId}:${page}`. */
  pages: Record<string, PageLoad>;

  /**
   * Asks health, loads boreholes and documents, then subscribes to live updates. Running it again
   * (StrictMode, RETRY after an error) ends the earlier subscription first.
   */
  init(): Promise<void>;
  /** Loads a page into the cache (used by usePage). */
  loadPage(documentId: string, page: number): Promise<void>;
}

/** The Review screen: focus, inline edit, saves, approve all clean and the CRS dialog. */
export interface ReviewSlice {
  reviewUid: string | null;
  focusKey: string | null;
  /** Page of the review borehole's document shown in the scan pane; null when it has no page (e.g. a spreadsheet). */
  reviewPage: number | null;
  editing: EditingState | null;
  /** The "approve all clean" confirmation is open. */
  confirmCleanOpen: boolean;
  /** Clean values of the review document as the source counted them (dry run); null while counting. */
  cleanCount: number | null;
  /** True while approve-clean runs and the document's boreholes reload. */
  cleanBusy: boolean;
  listScroll: ListScroll | null;
  crsDialogOpen: boolean;
  /** True while openCrsDialog waits for the data source's candidates. */
  crsLoading: boolean;
  crsCandidates: CrsCandidate[];
  crsPick: number;

  openReview(uid?: string): void;
  focusValue(key: string, scrollList?: boolean): void;
  setReviewPage(n: number): void;
  /** Opens the inline edit or flag input; an edit of a read-only value is refused with its reason. */
  startEdit(key: string, mode: EditMode): void;
  setEditText(text: string): void;
  saveEdit(): void;
  cancelEdit(): void;
  toggleApprove(key: string): void;
  toggleFlag(key: string): void;
  /** Sets "not in source" / "illegible" (and approves); the same state again resets it to ok + unreviewed. */
  setState(key: string, state: Exclude<FieldState, 'ok'>): void;
  /** Opens the confirmation and asks the source how many clean values the document has; closes it when open. */
  askClean(): Promise<void>;
  /** Approves every clean value of the review document, then reloads that document's boreholes. */
  approveClean(): Promise<void>;
  cancelClean(): void;
  openCrsDialog(): Promise<void>;
  pickCrs(i: number): void;
  /** Confirms the picked CRS for the whole document, then reloads that document's boreholes. */
  confirmCrs(): Promise<void>;
  closeCrsDialog(): void;
}

/** The Map and Detail screens: selection, header search and the map's fly-to signal. */
export interface MapSlice {
  selectedUid: string | null;
  selectedLayer: number;
  query: string;
  searchMessage: string;
  mapFocus: MapFocus | null;

  openBorehole(uid: string): void;
  selectLayer(n: number): void;
  setQuery(q: string): void;
  search(): void;
}

/** The upload queue (F6) and documents the backend is still working on. */
export interface UploadSlice {
  dropError: string;
  dragActive: boolean;
  /** The "Project (optional)" label next to the drop zone, sent with the files dropped next. */
  uploadProject: string;
  /** The upload queue, in the order the files were added. */
  uploads: import('./uploads').UploadItem[];

  /**
   * Queues the files the server accepts (type and size from health) and explains the rest in
   * dropError; refused with the reason in demo mode. Files added together send one project: the
   * typed label, else `folder` (the dropped folder's name), else the folder picker's folder, else none.
   * At most two uploads run at a time.
   */
  addFiles(files: FileList | File[], options?: { folder?: string | null }): void;
  setDragActive(active: boolean): void;
  setUploadProject(label: string): void;
  /** Cancels a queued or running upload. */
  cancelUpload(id: string): void;
  /** Removes a finished (done, failed or cancelled) upload from the list. */
  removeUpload(id: string): void;
  /** Removes every finished upload from the list. */
  clearFinishedUploads(): void;
  /** Queues a failed upload again with the same file and project; refused in demo mode. */
  retryUpload(id: string): void;
  /**
   * A document as the source now reports it (upload answer, live event, refetch): replaces or adds
   * its card, and loads its boreholes once it reaches needs_review or done without them.
   */
  documentUpdated(update: DocumentSummary): void;
  /** Re-queues a failed document and asks the source to follow it; refused with the reason in demo mode. */
  retryDocument(documentId: string): Promise<void>;
}

/** Live updates from the source (event stream or its polling fallback), contracts/realtime-and-chat.md section 1. */
export interface EventsSlice {
  /** How updates arrive: connecting, live (stream), polling (fallback) or offline (retrying). */
  liveStatus: import('../domain/types').LiveStatus;
  /** The failure the server reported per document (job.failed), until the document runs again. */
  jobFailures: Record<string, { stage: string; detail: string; retryable: boolean }>;

  /** Subscribes to the source's live updates (init does, after load); ends an earlier subscription first. */
  startLive(): void;
  /** Ends the subscription (app teardown, or before init runs again). */
  stopLive(): void;
  /** Applies one update. Idempotent; events for ids the store doesn't hold are ignored where that is safe. */
  applyLiveEvent(event: import('../domain/types').LiveEvent): void;
}

/** Navigation and overlays: screen, side panel, export menu, toast and Escape. */
export interface PanelSlice {
  screen: Screen;
  /** Always true in sample mode: the SAMPLE DATA banner can't be dismissed. */
  sampleBannerVisible: boolean;
  toast: Toast | null;
  panel: PanelState;
  exportOpen: boolean;
  includeUnreviewed: boolean;

  go(screen: Screen): void;
  showToast(text: string): void;
  /**
   * Opens a value's source in the side panel: in the value's own document when it names one, else
   * in the borehole's. Without a value, the borehole's first page (a toast when it has none).
   */
  openSource(uid: string, key: string): void;
  openPage(documentId: string, page: number): void;
  openCompleteness(documentId: string): void;
  closePanel(): void;
  toggleExport(): void;
  toggleIncludeUnreviewed(): void;
  exportFile(kind: ExportKind): Promise<void>;
  /** Escape closes, in order: editing → confirm clean → export menu → CRS dialog → side panel. */
  escape(): void;
}

/** Reviewer settings kept in this browser. */
export interface SettingsSlice {
  /** "Your name", sent as confirmed_by / answered_by; null when not set. */
  reviewerName: string | null;
  /** Sets the name (trimmed; empty clears it) and keeps it in localStorage. */
  setReviewerName(name: string): void;
}

export type AppState = DataSlice & ReviewSlice & MapSlice & UploadSlice & PanelSlice & SettingsSlice & EventsSlice;
