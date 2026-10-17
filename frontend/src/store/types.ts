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

  /**
   * Opens Review on a borehole; without one, on the review target (the last reviewed borehole, else
   * the first document in review). With a navigator this is /review/:uid (or /review when there is
   * no target).
   */
  openReview(uid?: string): void;
  /**
   * Focuses a value of the review borehole (and its page). With a navigator the key also goes into
   * the URL (?key=, history replace) once the focus rests, so holding J / K writes it once.
   */
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

/**
 * The Map and Detail screens: selection, the map's URL state, header search and the map's fly-to
 * signal. (Routing types are imported inline so the shared import block above stays as it is.)
 */
export interface MapSlice {
  /** The borehole of the Detail screen (/boreholes/:uid), or the one selected on the map (?sel=). */
  selectedUid: string | null;
  /** The layer selected on the Detail screen (?layer=). */
  selectedLayer: number;
  /** The map view the URL holds (?at=); null lets the map fit the pins. Kept when leaving the map. */
  mapView: import('../routing/urlState').MapView | null;
  /** Result set id from the map URL (?rs=): reserved for area selection and filters (F10). */
  resultSetId: string | null;
  query: string;
  searchMessage: string;
  mapFocus: MapFocus | null;

  /** Opens the Detail screen of a borehole (/boreholes/:uid with a navigator). */
  openBorehole(uid: string): void;
  /** Selects a layer on the Detail screen (?layer=, history replace). */
  selectLayer(n: number): void;
  /** Pan or zoom ended on the map: the view goes into the map URL (?at=, history replace). */
  setMapView(view: import('../routing/urlState').MapView): void;
  /** A pin's popup opened (uid) or closed (null) on the map: the selection goes into ?sel= (history replace). */
  selectOnMap(uid: string | null): void;
  setQuery(q: string): void;
  /** Finds a borehole by ID or project: flies the map to it (/map?sel=<uid>) or says why it is not on the map. */
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
  /** Re-queues a failed document and follows it again; refused with the reason in demo mode. */
  retryDocument(documentId: string): Promise<void>;
}

/**
 * Navigation and overlays: screen, route, side panel, export menu, toast and Escape.
 *
 * In the app the URL is the source of navigation truth: a navigator (the router's, injected once in
 * main.tsx) changes it, and the route sync applies every location to the store (applyRoute: screen,
 * selectedUid, reviewUid and the query state). Without a navigator (unit tests) the navigation
 * actions set the screen directly.
 */
export interface PanelSlice {
  screen: Screen;
  /**
   * Changes the URL: the router's navigator in the app; null in unit tests, where the navigation
   * actions set the store directly.
   */
  navigator: import('../routing/navigator').AppNavigator | null;
  /** The route the store shows (set by applyRoute); null without a router. */
  route: import('../routing/urlState').AppRoute | null;
  /** Always true in sample mode: the SAMPLE DATA banner can't be dismissed. */
  sampleBannerVisible: boolean;
  toast: Toast | null;
  panel: PanelState;
  exportOpen: boolean;
  includeUnreviewed: boolean;

  setNavigator(navigator: import('../routing/navigator').AppNavigator | null): void;
  /**
   * Shows what a URL names: the screen, its borehole and the state in its query. The route sync calls
   * it for every location (deep link, reload, Back), so the store follows the URL one way. Leaving
   * Review drops its transient UI (edit, approve-clean confirmation, CRS dialog); the side panel and
   * the toast stay. Applying the route the store already shows changes nothing.
   */
  applyRoute(route: import('../routing/urlState').AppRoute): void;
  /**
   * Goes to a route through the navigator: shows it at once (so the next action sees it) and adds a
   * history entry, or replaces the current one when only the query changes. Without a navigator it
   * only shows it.
   */
  showRoute(route: import('../routing/urlState').AppRoute): void;
  /** Goes to a screen (with a navigator: its URL, see showRoute). */
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

export type AppState = DataSlice & ReviewSlice & MapSlice & UploadSlice & PanelSlice & SettingsSlice;
