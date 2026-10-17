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

  init(): Promise<void>;
  /** Loads a page into the cache (used by usePage). */
  loadPage(documentId: string, page: number): Promise<void>;
}

/** The Review screen: focus, inline edit, saves, approve all clean and the CRS dialog. */
export interface ReviewSlice {
  reviewUid: string | null;
  focusKey: string | null;
  reviewPage: number;
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

/** Uploads and documents the backend is still working on. */
export interface UploadSlice {
  dropError: string;
  dragActive: boolean;

  /** Uploads the files the server accepts (type and size from health); explains the rest in dropError. */
  addFiles(files: FileList | File[]): Promise<void>;
  setDragActive(active: boolean): void;
  /** A status update of a document (upload or watch): updates its card and loads its boreholes after extraction. */
  documentUpdated(update: DocumentSummary): void;
  /** Re-queues a failed document and follows it again. */
  retryDocument(documentId: string): Promise<void>;
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

export type AppState = DataSlice & ReviewSlice & MapSlice & UploadSlice & PanelSlice & SettingsSlice;
