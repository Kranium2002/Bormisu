import type {
  Borehole,
  CrsCandidate,
  CrsConfirmation,
  DocumentSummary,
  Health,
  LiveEvent,
  LiveStatus,
  PageContent,
  UploadProgress,
  UploadResult,
  ValuePatch,
} from '../domain/types';

export interface LoadResult { boreholes: Borehole[]; documents: DocumentSummary[] }

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

/**
 * Where the app gets and saves its data: the FastAPI backend (`api`) or fictional demo data
 * (`sample`). Errors are ApiError / UnreachableError / SaveError from ./errors.
 */
export interface DataSource {
  readonly kind: 'api' | 'sample';
  /** Mode, providers and upload limits. Called once at boot. */
  health(): Promise<Health>;
  /** All boreholes and documents. */
  load(): Promise<LoadResult>;
  /** One borehole at its latest revision (after a conflict, an event or a CRS confirmation). */
  getBorehole(uid: string): Promise<Borehole>;
  /** All boreholes of one document (after extraction, a CRS confirmation or approve-clean). */
  documentBoreholes(documentId: string): Promise<Borehole[]>;
  /** One document (fallback polling and refreshes). */
  getDocument(documentId: string): Promise<DocumentSummary>;
  /** One rendered page of a document (1-based). */
  getPage(documentId: string, page: number): Promise<PageContent>;
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
}
