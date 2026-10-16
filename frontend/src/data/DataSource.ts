import type { Borehole, CrsCandidate, DocumentSummary, PageContent, ValuePatch } from '../domain/types';

/** Where the app gets and saves its data: the FastAPI backend (`api`) or fictional demo data (`sample`). */
export interface DataSource {
  readonly kind: 'api' | 'sample';
  /** All boreholes and documents. */
  load(): Promise<{ boreholes: Borehole[]; documents: DocumentSummary[] }>;
  /** One rendered page of a document (1-based). */
  getPage(documentId: string, page: number): Promise<PageContent>;
  /** Uploads files; `onUpdate` fires for every status change of each new document. */
  upload(files: File[], onUpdate: (doc: DocumentSummary) => void): Promise<void>;
  /**
   * Follows a document that is still being worked on when the app loads (e.g. a reload during
   * extraction); `onUpdate` fires for every status change. One watcher per document at a time.
   */
  watch?(documentId: string, onUpdate: (doc: DocumentSummary) => void): void;
  /**
   * Saves a review action on one value. If only part of it was saved, it throws a PartialSaveError
   * that says which part, so the caller rolls back only the rest.
   */
  updateValue(uid: string, key: string, patch: ValuePatch): Promise<void>;
  /** CRS candidates for a document whose CRS isn't stated. */
  crsCandidates(documentId: string): Promise<CrsCandidate[]>;
  /** Confirms one CRS for every borehole of a document. */
  confirmCrs(documentId: string, code: string): Promise<void>;
}

/** A review action the source saved only partly: `applied` is the part it holds now. */
export class PartialSaveError extends Error {
  readonly applied: ValuePatch;

  constructor(message: string, applied: ValuePatch) {
    super(message);
    this.name = 'PartialSaveError';
    this.applied = applied;
  }
}
