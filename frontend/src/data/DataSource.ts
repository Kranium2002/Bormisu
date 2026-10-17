import type {
  Alignment,
  AlignmentResult,
  Borehole,
  BoreholeFilter,
  Clarification,
  ClarificationStatus,
  CrsCandidate,
  CrsConfirmation,
  DocumentSummary,
  Health,
  LiveEvent,
  LiveStatus,
  MapFeature,
  PageContent,
  PageWord,
  PlaceCandidate,
  ResultSet,
  UploadProgress,
  UploadResult,
  Registration,
  User,
  ValuePatch,
} from '../domain/types';

/**
 * What the app loads at boot: the documents, the light map layer of every plotted borehole, and the
 * full records of the boreholes that are not on the map (few; the "Not on map" list). Full records
 * of plotted boreholes are fetched on demand (getBorehole, documentBoreholes).
 */
export interface LoadResult { documents: DocumentSummary[]; features: MapFeature[]; unplotted: Borehole[] }

export interface UploadOptions {
  /** Project label shared by files dropped together (typed by the user, else the dropped folder's name). */
  project: string | null;
  /** Byte progress while the file is sent. */
  onProgress?(progress: UploadProgress): void;
}

/** One running upload. */
export interface UploadHandle {
  /**
   * The server's answer: the new document, or the earlier one for bytes uploaded before. Rejects
   * with ApiError / UnreachableError, or with UploadCancelledError after cancel().
   */
  readonly done: Promise<UploadResult>;
  /** Aborts the transfer; no effect once the server has answered. */
  cancel(): void;
}

/** Optional form fields of a planned-line upload (contract 1.3.0 uploadAlignment). */
export interface AlignmentUploadOptions {
  /** Display name; default the line's name in the file, else the file name. */
  name?: string | null;
  /** Default search distance stored with the line (server default 100 m). */
  bufferM?: number | null;
  /** EPSG code of a CSV's x/y columns; positions are never guessed. */
  epsg?: number | null;
}

/** A query of the boreholes along a line: bufferM null uses the line's own. */
export interface AlignmentQueryOptions {
  bufferM: number | null;
  includeUnreviewed: boolean;
}

/**
 * Where the app gets and saves its data: the FastAPI backend (`api`) or fictional demo data
 * (`sample`). Errors are ApiError / UnreachableError / SaveError from ./errors.
 */
export interface DataSource {
  readonly kind: 'api' | 'sample';
  /** Mode, providers and upload limits. Called once at boot. */
  health(): Promise<Health>;
  /** Documents, map features and the unplotted boreholes (see LoadResult). */
  load(): Promise<LoadResult>;
  /** Map features of plotted boreholes (GET /map/boreholes.geojson), optionally of one document. */
  mapFeatures(documentId?: string): Promise<MapFeature[]>;
  /** Full records of the boreholes that are not on the map (GET /boreholes?plotted=false). */
  unplotted(): Promise<Borehole[]>;
  /** Runs a filter (search panel, area selection) and stores it as a result set (POST /result-sets). */
  createResultSet(filter: BoreholeFilter): Promise<ResultSet>;
  /** A stored result set by id (URL rs=, chat). */
  getResultSet(id: string): Promise<ResultSet>;
  /** Map features of a result set's plotted members (GET /result-sets/{id}/geojson). */
  resultSetFeatures(id: string): Promise<MapFeature[]>;
  /**
   * Uploads a planned line (POST /alignments, multipart): GeoJSON, KML, GPX or CSV. Throws ApiError
   * alignment_invalid / epsg_required / crs_invalid / too_large / unsupported_type with a readable detail.
   */
  uploadAlignment(file: File, options?: AlignmentUploadOptions): Promise<Alignment>;
  /** The planned lines uploaded so far, newest first (GET /alignments). */
  listAlignments(): Promise<Alignment[]>;
  /** One planned line (GET /alignments/{id}); 404 alignment_not_found. */
  getAlignment(id: string): Promise<Alignment>;
  /** Deletes a planned line (DELETE /alignments/{id}); 404 alignment_not_found. */
  deleteAlignment(id: string): Promise<void>;
  /** The boreholes within the search distance of a line, by chainage, stored as a result set (POST /alignments/{id}/query). */
  queryAlignment(id: string, options: AlignmentQueryOptions): Promise<AlignmentResult>;
  /** Place search on submit (GET /geocode): uploaded places first, then the geocoder; may be empty. */
  geocode(query: string): Promise<PlaceCandidate[]>;
  /** Clarification questions, oldest first (default: status open). */
  clarifications(options?: { status?: ClarificationStatus; documentId?: string }): Promise<Clarification[]>;
  /** Answers a question; 422 answer_invalid / validation_error carry field errors (ApiError.errors). */
  answerClarification(id: string, values: Record<string, unknown>, answeredBy: string | null): Promise<Clarification>;
  /** Leaves a question for later; it can still be answered. */
  skipClarification(id: string): Promise<Clarification>;
  /** One borehole at its latest revision (after a conflict, an event or a CRS confirmation). */
  getBorehole(uid: string): Promise<Borehole>;
  /** All boreholes of one document (after extraction, a CRS confirmation or approve-clean). */
  documentBoreholes(documentId: string): Promise<Borehole[]>;
  /** One document (fallback polling and refreshes). */
  getDocument(documentId: string): Promise<DocumentSummary>;
  /** One rendered page of a document (1-based). */
  getPage(documentId: string, page: number): Promise<PageContent>;
  /**
   * The words on a page (contract 1.2.2 GET /documents/{id}/pages/{n}/words), [] when it has none yet or
   * the server doesn't offer them. Optional: sources without words leave the verification view plain.
   */
  getPageWords?(documentId: string, page: number): Promise<PageWord[]>;
  /** URL of a small page image for the page strip (width 200), or null when the source has no page images. */
  thumbnailUrl(documentId: string, page: number): string | null;
  /** Uploads one file with byte progress (the store runs two at a time). */
  upload(file: File, options: UploadOptions): UploadHandle;
  /**
   * Live updates. API: EventSource on GET /events, which reconnects by itself and resends
   * Last-Event-ID; after three failures within a minute the source polls the documents it follows
   * (2 s, backing off to 30 s, never giving up after one error) and keeps trying the stream, which
   * takes over again once it works. `onEvent` gets each update, `onStatus` each change of transport.
   * Returns the unsubscribe function. One subscription per app.
   */
  subscribe(onEvent: (event: LiveEvent) => void, onStatus: (status: LiveStatus) => void): () => void;
  /**
   * Marks a document as being processed (after an upload or a retry, or one still running at load),
   * so the polling fallback follows it until it reaches a terminal status.
   */
  follow(documentId: string): void;
  /**
   * Saves one review action on one value and resolves with the borehole as the source now holds it
   * (in API mode the record of the last PATCH answer). Saves of one borehole are applied in call
   * order. Throws SaveError, whose `current` says what the source holds after the failure.
   */
  updateValue(uid: string, key: string, patch: ValuePatch): Promise<Borehole>;
  /** Approves every clean value of a document; with `dryRun` it only counts them. Resolves with the count. */
  approveClean(documentId: string, dryRun: boolean): Promise<number>;
  /** Re-queues a failed document. */
  retry(documentId: string): Promise<void>;
  /** CRS candidates for a document whose CRS isn't stated, best first. */
  crsCandidates(documentId: string): Promise<CrsCandidate[]>;
  /** Confirms one CRS for every borehole of a document; resolves with the number of boreholes updated. */
  confirmCrs(documentId: string, confirmation: CrsConfirmation): Promise<number>;
  /** The signed-in user (GET /auth/me), or null without a session. */
  currentUser(): Promise<User | null>;
  /** Signs in (POST /auth/login); throws ApiError invalid_credentials / rate_limited / validation_error. */
  signIn(email: string, password: string): Promise<User>;
  /** Creates an account and signs it in (POST /auth/register); throws email_taken / validation_error / rate_limited. */
  register(registration: Registration): Promise<User>;
  /** Signs out (POST /auth/logout); idempotent. */
  signOut(): Promise<void>;
  /** Called whenever a request answers 401 not_authenticated (the session ended); null removes it. */
  setSessionListener(listener: (() => void) | null): void;
}
