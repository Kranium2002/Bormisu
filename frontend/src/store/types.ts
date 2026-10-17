/**
 * State and action types of the app store. The store is one zustand store made of slices
 * (data, review, map, upload, panel); each slice file builds its part from a shared StoreContext.
 */
import type { DataSource } from '../data/DataSource';
import type {
  Borehole,
  Box,
  CrsCandidate,
  DocumentSummary,
  FieldState,
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
  page: number;
  box?: Box | null;
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

/** Data source, load state and the data itself. */
export interface DataSlice {
  source: DataSource | null;
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
  confirmCleanOpen: boolean;
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
  askClean(): void;
  approveClean(): void;
  cancelClean(): void;
  openCrsDialog(): Promise<void>;
  pickCrs(i: number): void;
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

  addFiles(files: FileList | File[]): Promise<void>;
  setDragActive(active: boolean): void;
  /** A status update of a document (upload or watch): updates its card and loads its boreholes after extraction. */
  documentUpdated(update: DocumentSummary): void;
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

export type AppState = DataSlice & ReviewSlice & MapSlice & UploadSlice & PanelSlice;
