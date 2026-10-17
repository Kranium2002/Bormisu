import type {
  Borehole,
  CrsCandidate,
  CrsConfirmation,
  DocumentSummary,
  Health,
  PageContent,
  ValuePatch,
} from '../domain/types';

export interface LoadResult { boreholes: Borehole[]; documents: DocumentSummary[] }

export interface UploadOptions {
  /** Project label shared by files dropped together (typed by the user, else the dropped folder's name). */
  project: string | null;
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
  /** Uploads files; `onUpdate` fires for every status change of each new document. */
  upload(files: File[], onUpdate: (doc: DocumentSummary) => void, options?: UploadOptions): Promise<void>;
  /**
   * Follows a document that is still being worked on when the app loads (e.g. a reload during
   * extraction); `onUpdate` fires for every status change. One watcher per document at a time.
   */
  watch?(documentId: string, onUpdate: (doc: DocumentSummary) => void): void;
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
