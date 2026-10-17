/**
 * State and action types of the app store. The store is one zustand store made of slices
 * (data, review, map, map data, upload, panel, settings, events, clarifications); each slice file builds its part from a shared
 * StoreContext (context.ts).
 */
import type { DataSource } from '../data/DataSource';
import type {
  Area,
  Borehole,
  BoreholeFilter,
  Box,
  Clarification,
  CrsCandidate,
  DocumentSummary,
  FieldState,
  Health,
  MapFeature,
  PageContent,
  PlaceCandidate,
  ResultSet,
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
  /** Opens the map on a document's pins (the queue card's "N on the map · SHOW"). */
  showDocumentOnMap(documentId: string): void;
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

/** Outcome of answering a clarification: field errors from a 422 are keyed by field name. */
export type AnswerResult = { ok: true } | { ok: false; message: string; fieldErrors: Record<string, string> };

/**
 * The map's data: light features of every plotted borehole (pins, clusters, legend, results table,
 * search), the active result set (filters, area selection, chat), place search, and full records
 * fetched on demand into the boreholes cache (Review, Detail, exports).
 */
export interface MapDataSlice {
  features: MapFeature[];
  /** Uids of the boreholes that are not on the map (their full records are in boreholes). */
  unplottedUids: string[];
  /** The filter panel's state; applyFilter runs it. */
  filter: BoreholeFilter;
  /** The active result set and its plotted members, or null. */
  resultSet: ResultSet | null;
  resultSetFeatures: MapFeature[] | null;
  /** A result set or filter request in flight, and the last error to show. */
  resultSetBusy: boolean;
  resultSetError: string | null;
  /** Place search: the last query, its candidates (null before a search), busy flag and error. */
  placeQuery: string;
  places: PlaceCandidate[] | null;
  placeBusy: boolean;
  placeError: string | null;
  /**
   * Fetch state of full records requested on demand, by uid: absent when cached or never asked.
   * Route screens show LOADING while 'loading' and BOREHOLE NOT FOUND only for 'missing'.
   */
  recordLoads: Record<string, 'loading' | 'missing' | 'error'>;
  /** A bbox to fly to and outline dashed (a place, a fit_bounds), or null; nonce changes per request. */
  mapOutline: { bbox: [number, number, number, number]; outline: boolean; nonce: number } | null;

  /** Fetches one full record unless cached; resolves null when the server has no such borehole. */
  ensureBorehole(uid: string): Promise<Borehole | null>;
  /** Fetches the full records of a document unless all are cached (Review, Detail, exports). */
  ensureDocumentBoreholes(documentId: string): Promise<Borehole[]>;
  /** Reloads the map layer and the unplotted list (after a CRS confirmation, an answered question …). */
  refreshMap(): Promise<void>;
  setFilter(patch: Partial<BoreholeFilter>): void;
  /** Runs the filter panel's filter (plus the current area) as a result set; its id goes in the URL. */
  applyFilter(): Promise<void>;
  /** Selects by an area drawn on the map (rectangle, polygon, circle), with the panel's filter. */
  selectArea(area: Area): Promise<void>;
  /** Shows a stored result set (URL rs=, chat show_result_set); fit flies the map to its bbox. */
  showResultSet(id: string, options?: { fit?: boolean }): Promise<void>;
  /** "Reset": clears the result set, the area and the filter panel. */
  clearResultSet(): void;
  /** Place search on submit: one candidate flies there, several are listed, none says so. */
  searchPlace(query: string): Promise<void>;
  /** Flies to a listed place candidate (and outlines it when it holds no uploaded borehole). */
  choosePlace(index: number): void;
}

/** Clarification questions: the inbox, the badge and the dialog (FRONTEND.md F12). */
export interface ClarificationsSlice {
  /** Unresolved questions (open or skipped), oldest first, from GET /clarifications and live events. */
  clarifications: Clarification[];
  clarificationsState: 'idle' | 'loading' | 'ready' | 'error';
  /** The question shown in the dialog, or null. */
  activeClarificationId: string | null;

  loadClarifications(): Promise<void>;
  /** Opens the dialog (from the inbox, a document card, Review or the chat). */
  openClarification(id: string): void;
  closeClarification(): void;
  /**
   * Sends the answer with the reviewer's name. On success the question leaves the list and the
   * affected records, the document and the map are refreshed (a CRS answer can plot a whole file).
   */
  answerClarification(id: string, values: Record<string, unknown>): Promise<AnswerResult>;
  /** Leaves the question for later (it stays in the inbox as skipped and keeps its badge). */
  skipClarification(id: string): Promise<void>;
}

/**
 * Sign-in (contract 1.3.0). With health.auth.enabled the app loads nothing until a user is signed
 * in; a 401 not_authenticated at any time ends the session and shows the sign-in on the same route.
 */
export interface AuthSlice {
  /** unknown until checked; disabled when the server has no sign-in; signedOut / signedIn otherwise. */
  authState: 'unknown' | 'disabled' | 'signedOut' | 'signedIn';
  user: import('../domain/types').User | null;
  /** A sign-in, registration, sign-out or password change in flight. */
  authBusy: boolean;
  /** The last error to show above the form (detail of the ApiError, or why the backend is unreachable). */
  authError: string | null;
  /** Field errors of the last 422 answer, by field name. */
  authFieldErrors: Record<string, string>;

  signIn(email: string, password: string): Promise<boolean>;
  register(registration: import('../domain/types').Registration): Promise<boolean>;
  /** Signs out, stops live updates and forgets every loaded record. */
  signOut(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<boolean>;
  /** The session ended (any 401 not_authenticated): stop live updates, keep the route, show the sign-in. */
  sessionEnded(): void;
}

/**
 * The chat drawer's state and the store actions the chat's commands need (FRONTEND.md F14, F15). The
 * conversation itself lives in the AI SDK chat (src/chat/session.ts, rendered through useChat).
 */
export interface ChatSlice {
  chatOpen: boolean;
  /** The include-unreviewed toggle next to the input (context.include_unreviewed). */
  chatIncludeUnreviewed: boolean;
  /** "This map area": the visible map goes with the next messages as context.map_view (on the map only). */
  chatUseView: boolean;
  /** A request_area command: the map is in draw mode with this hint until an area is drawn or cancelled. */
  chatAreaRequest: { prompt: string } | null;
  /** The area drawn for the chat; it goes with the next message as context.map_view, then clears. */
  chatArea: Area | null;
  /** The server answered 409 chat_unavailable: the drawer shows the chat as not configured. */
  chatUnavailable: boolean;

  openChat(): void;
  closeChat(): void;
  toggleChat(): void;
  setChatIncludeUnreviewed(on: boolean): void;
  setChatUseView(on: boolean): void;
  /** Puts the map into draw mode with the prompt as a hint (request_area); the next drawn shape becomes chatArea. */
  requestChatArea(prompt: string): void;
  /** The area drawn for the chat (ends the request), or null to forget it. */
  setChatArea(area: Area | null): void;
  /** Ends a request_area without an area (the hint's CANCEL). */
  cancelChatAreaRequest(): void;
  setChatUnavailable(on: boolean): void;
  /** fit_bounds: the map flies to the bbox (on the map screen) and outlines it dashed when asked. */
  fitChatBounds(bbox: [number, number, number, number], outline: boolean): void;
  /** focus_borehole: the map with the borehole selected (its popup opens); Detail when it has no pin. */
  focusChatBorehole(uid: string): void;
  /** open_detail: the Detail screen of a borehole, at a layer when given. */
  openChatDetail(uid: string, layer: number | null): void;
  /** The Source panel at a page of a document with a box highlighted (a citation, open_evidence). */
  showChatEvidence(documentId: string, page: number | null, box: Box | null): void;
  /** Adds a question the chat sent (data-clarification) to the list unless it is there or resolved. */
  addChatClarification(question: Clarification): void;
}

export type AppState = DataSlice & ReviewSlice & MapSlice & MapDataSlice & UploadSlice & PanelSlice & SettingsSlice & EventsSlice & ClarificationsSlice & AuthSlice & ChatSlice;
