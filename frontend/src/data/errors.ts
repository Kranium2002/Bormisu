/**
 * Errors of the data layer. Every backend error answer is `{detail, code, errors?}` (contract
 * `Error`): the UI branches on `code` and shows `detail`; it never parses `detail`.
 */
import type { Borehole } from '../domain/types';

/** One field error of a `validation_error` or `answer_invalid` answer. */
export interface FieldError { loc: (string | number)[]; msg: string }

/** A JSON error answer of the backend. `message` is what the UI shows. */
export class ApiError extends Error {
  readonly status: number;
  /** Stable machine code, e.g. `demo_mode`, `revision_conflict`, `route_not_found`. */
  readonly code: string;
  readonly detail: string;
  readonly errors: FieldError[];
  /** Seconds to wait before trying again (the Retry-After header of a 429), when the server said. */
  retryAfter: number | null = null;

  constructor(status: number, code: string, detail: string, errors: FieldError[] = [], message: string = detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.errors = errors;
  }
}

/** The wait of a Retry-After header in seconds (a number of seconds or an HTTP date), else null. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The backend can't be reached: a network failure, a non-JSON 5xx (a proxy error page) or an HTML
 * answer where JSON was expected (a dev server or static host with no backend behind it).
 */
export class UnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreachableError';
  }
}

/**
 * A review save that failed. `current` is the borehole as the source holds it after the failure, when
 * known: on `revision_conflict` the record refetched from the server, after a multi-request save the
 * answer of the last request that succeeded (so a partly saved value shows what was saved).
 */
export class SaveError extends Error {
  readonly current: Borehole | null;
  /** The ApiError code, when the failure was a backend answer. */
  readonly code: string | null;

  constructor(message: string, current: Borehole | null, code: string | null) {
    super(message);
    this.name = 'SaveError';
    this.current = current;
    this.code = code;
  }
}

/** An upload the user cancelled before the server answered. */
export class UploadCancelledError extends Error {
  constructor(fileName: string) {
    super(`Upload of ${fileName} cancelled`);
    this.name = 'UploadCancelledError';
  }
}

/** True for an ApiError, optionally with the given code. */
export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

/** The backend error code of any thrown value (ApiError or SaveError), else null. */
export function errorCode(e: unknown): string | null {
  if (e instanceof ApiError) return e.code;
  if (e instanceof SaveError) return e.code;
  return null;
}

/** Text to show for any thrown value. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
