/**
 * DataSource over the FastAPI backend (contracts/openapi.yaml, base path /api/v1). Error answers
 * become ApiError (by `code`), an unreachable backend UnreachableError, failed saves SaveError.
 * Uploads go through XMLHttpRequest for byte progress; live updates come from GET /events with a
 * polling fallback (./events). This module never falls back to sample data.
 */
import { APP_NAME } from '../config';
import { parseNumber } from '../domain/format';
import { pageUsageText } from '../domain/pages';
import type {
  Borehole,
  Clarification,
  DocumentStatus,
  DocumentSummary,
  LiveEvent,
  MapFeature,
  UploadProgress,
  UploadResult,
  ValuePatch,
} from '../domain/types';
import { MULTI_FIELD_SEPARATOR } from '../schema/targetFormat';
import {
  adaptBorehole,
  adaptClarification,
  adaptClarifications,
  adaptCrsCandidates,
  adaptDocument,
  adaptFeatures,
  adaptHealth,
  adaptLiveEvent,
  adaptPlaces,
  adaptResultSet,
  documentLint,
  isTerminal,
  stepOf,
  toApiState,
  toWireFilter,
  type AdaptedBorehole,
  type PatchTarget,
  type PatchValueType,
  type WireBorehole,
  type WireBoreholeList,
  type WireClarification,
  type WireClarificationAnswer,
  type WireCrsCandidate,
  type WireCrsConfirm,
  type WireDocument,
  type WireDocumentList,
  type WireFeatureCollection,
  type WireHealth,
  type WirePlace,
  type WireResultSet,
  type WireUploadAccepted,
  type WireValuePatch,
  adaptUser,
  type WireLogin,
  type WireRegister,
  type WireUserAnswer,
} from './adapters';
import type { DataSource, UploadHandle } from './DataSource';
import {
  ApiError, errorCode, errorText, isApiError, parseRetryAfter, SaveError, UnreachableError, UploadCancelledError, type FieldError,
} from './errors';
import { FollowedDocuments, openLiveFeed } from './events';

export { MAX_BACKOFF_MS, POLL_MS } from './events';

const PAGE_IMAGE_WIDTH = 1400;

/** Contract 1.2.2 `PageWord` (written out until the wire types are regenerated from 1.2.2). */
interface WirePageWord { t: string; b: number[] | null; conf?: number | null; source: 'text' | 'located' | 'ocr' }
/** Width of the page strip thumbnails (FRONTEND.md F6). */
const THUMBNAIL_WIDTH = 200;
/** Page size of the borehole list (the contract's maximum). */
const LIST_LIMIT = 5000;

/** Message shown when the backend can't be reached at all. */
export function unreachableMessage(base: string): string {
  return `Cannot reach the ${APP_NAME} backend at ${base}. Start the backend, or run npm run dev:sample for demo data.`;
}

/** A PATCH body without the revision check (that is added when the request is sent). */
export type PatchBody = Omit<WireValuePatch, 'if_revision'>;

/** An edited value as the backend field expects it: numbers as numbers, IDs, dates and text as typed. */
function serialise(text: string, type: PatchValueType): unknown {
  const t = text.trim();
  if (!t) return null;
  if (type === 'string') return text;
  if (type === 'boolean') {
    if (/^(yes|true|y)$/i.test(t)) return true;
    if (/^(no|false|n)$/i.test(t)) return false;
    return text;
  }
  return parseNumber(t) ?? text;
}

/** Why an SPT text that is no whole N can't be saved on a row whose layer has no tracked printed SPT text. */
export const SPT_N_ONLY = 'Enter N as a whole number. A refusal can only be corrected where the backend tracks the printed SPT text.';

/**
 * The edit of an SPT row on the integer N: a whole number ("9", "N = 9") is sent as N (blank clears
 * it); any other text (a refusal such as "50/12") goes to the layer's printed SPT text when the backend
 * tracks it, else it is refused here instead of being answered with a 422.
 */
function sptEdit(text: string, target: PatchTarget): PatchBody[] {
  const t = text.trim();
  const n = /^(?:n\s*=\s*)?(\d+)$/i.exec(t);
  if (!t || n) return target.paths.map((path) => ({ path, action: 'edit', value: n ? Number(n[1]) : null }));
  if (target.sptRaw) return [{ path: target.sptRaw, action: 'edit', value: text }];
  throw new Error(SPT_N_ONLY);
}

/** True when two texts of one value are the same, numbers compared as numbers ("12.50" = "12.5"). */
function sameText(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const x = parseNumber(a);
  return x != null && x === parseNumber(b);
}

/**
 * The edit bodies of one value: one per path. A two-field value ("X / Y") is split into its parts and
 * each part goes to its path. A part whose path has no provenance entry can't be saved: changing it
 * is refused rather than silently dropped. A read-only value (e.g. the CRS code) refuses every edit.
 */
function editBodies(text: string, target: PatchTarget): PatchBody[] {
  if (target.readOnly) throw new Error(target.readOnly);
  if (target.type === 'spt') return sptEdit(text, target);
  if (!target.pair) return target.paths.map((path) => ({ path, action: 'edit', value: serialise(text, target.type) }));
  const sep = MULTI_FIELD_SEPARATOR.trim();
  const both = `Enter both values separated by "${sep}", e.g. 512345 ${sep} 6123456`;
  const parts = text.split(sep).map((p) => p.trim());
  if (parts.length !== 2) throw new Error(both);
  const bodies: PatchBody[] = [];
  target.pair.forEach((path, i) => {
    if (target.paths.includes(path)) {
      if (!parts[i]) throw new Error(both);
      bodies.push({ path, action: 'edit', value: serialise(parts[i], target.type) });
    } else if (!sameText(parts[i], target.current?.[i] ?? '')) {
      throw new Error(`${i === 0 ? 'X' : 'Y'} can't be changed here: the backend record has no source entry for it (${path}).`);
    }
  });
  return bodies;
}

/**
 * The PATCH bodies for one review patch, in the order they must be sent: set_state, edit, then
 * approve / flag / reset. `status: 'unreviewed'` is the undo of an approval or a flag (`reset`).
 */
export function patchActions(patch: ValuePatch, target: PatchTarget): PatchBody[] {
  const each = (body: Omit<PatchBody, 'path'>): PatchBody[] => target.paths.map((path) => ({ path, ...body }));
  const out: PatchBody[] = [];
  // A patch only carries `state` when it changes (set, or back to ok), so it is always sent.
  if (patch.state) out.push(...each({ action: 'set_state', state: toApiState(patch.state) }));
  if (patch.value !== undefined) out.push(...editBodies(patch.value, target));
  if (patch.status === 'approved') out.push(...each({ action: 'approve' }));
  else if (patch.status === 'flagged') out.push(...each({ action: 'flag', reason: patch.flag ?? null }));
  else if (patch.status === 'unreviewed') out.push(...each({ action: 'reset' }));
  return out;
}

/** The backend's Error body, when the parsed answer is one. */
function errorBody(parsed: unknown): { code: string; detail: string; errors: FieldError[] } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as { code?: unknown; detail?: unknown; errors?: unknown };
  if (typeof body.code !== 'string') return null;
  const errors = Array.isArray(body.errors)
    ? (body.errors as { loc?: (string | number)[]; msg?: string }[]).map((e) => ({ loc: e?.loc ?? [], msg: e?.msg ?? '' }))
    : [];
  return { code: body.code, detail: typeof body.detail === 'string' ? body.detail : '', errors };
}

/** One HTTP answer, from fetch or XMLHttpRequest. */
interface Answer {
  status: number;
  contentType: string | null;
  /** The Retry-After header (a 429 or 503), when sent. */
  retryAfter?: string | null;
  /** The parsed JSON body; rejects when it is not JSON. */
  json(): Promise<unknown>;
}

/**
 * Sign-in requests whose 401 is an answer (wrong password, no session yet), not a session that ended:
 * they never call the session listener.
 */
const AUTH_ANSWER_PATHS = new Set(['/auth/login', '/auth/register', '/auth/me', '/auth/logout']);

/** True for the answer of a request that needs a session and has none (any more). */
export function endsSession(path: string, e: unknown): boolean {
  return isApiError(e, 'not_authenticated') && e.status === 401 && !AUTH_ANSWER_PATHS.has(path.split('?')[0]);
}

/**
 * The body of a successful answer, or the error of any other: a JSON error body is an ApiError by
 * its code (route_not_found names the endpoint); a non-JSON 5xx, or HTML where JSON was expected, is
 * an unreachable backend; nginx's own HTML 413 page is too_large; any other answer is `http_<status>`.
 */
async function bodyOf<T>(base: string, method: string, path: string, res: Answer): Promise<T> {
  try {
    return await answerOf<T>(base, method, path, res);
  } catch (e) {
    if (e instanceof ApiError) e.retryAfter = parseRetryAfter(res.retryAfter);
    throw e;
  }
}

async function answerOf<T>(base: string, method: string, path: string, res: Answer): Promise<T> {
  const json = res.contentType?.includes('json') ?? false;
  if (res.status >= 200 && res.status < 300) {
    if (res.status === 204) return undefined as T;
    // A dev server or static host answers unknown paths with index.html: there is no backend behind it.
    if (!json) throw new UnreachableError(unreachableMessage(base));
    try {
      return (await res.json()) as T;
    } catch {
      throw new UnreachableError(unreachableMessage(base));
    }
  }
  const err = json ? errorBody(await res.json().catch(() => null)) : null;
  if (err?.code === 'route_not_found') {
    throw new ApiError(res.status, err.code, err.detail, err.errors, `Backend endpoint not available: ${method} ${base}${path}`);
  }
  if (err) throw new ApiError(res.status, err.code, err.detail, err.errors);
  if (!json && res.status >= 500) throw new UnreachableError(unreachableMessage(base));
  // nginx answers an oversized upload with its own HTML page.
  if (res.status === 413) throw new ApiError(413, 'too_large', 'The file is larger than the server accepts.');
  throw new ApiError(res.status, `http_${res.status}`, `${method} ${base}${path} failed (HTTP ${res.status})`);
}

/** A document the backend just accepted, before its first update. */
function pendingDocument(id: string, name: string, status: DocumentStatus): DocumentSummary {
  return {
    id, name, project: '', status, pages: [], step: stepOf(status), progress: null, counts: null, completeness: null,
    reviewBoreholeUid: null, openClarifications: 0, duplicateOf: null, error: null,
  };
}

/** Creates the API data source for a base path such as "/api/v1". */
export function createApiSource(base: string): DataSource {
  const enc = encodeURIComponent;
  /** Latest wire document per id (page usage, page labels). */
  const docs = new Map<string, WireDocument>();
  /** Latest adapted record per uid: the borehole, its patch targets and its revision. */
  const records = new Map<string, AdaptedBorehole>();
  /** One promise chain per uid, so saves of a borehole run one after the other. */
  const saving = new Map<string, Promise<unknown>>();
  /** Documents still being processed: the polling fallback fetches them. */
  const followed = new FollowedDocuments();
  /** Values without a provenance entry already reported (`<uid> <path>`). */
  const reported = new Set<string>();
  /**
   * The light map layer as last read (load, mapFeatures), by uid in the server's order: the source
   * names a document's first borehole from it without fetching full records.
   */
  const features = new Map<string, MapFeature>();

  /** Called once per burst of 401 not_authenticated answers (the session ended); see setSessionListener. */
  let sessionListener: (() => void) | null = null;
  /** The listener was called (or the user signed out) and no sign-in happened since: further 401s stay quiet. */
  let sessionLost = false;
  /** health.auth.enabled as last read: a failing event stream then checks the session. */
  let authEnabled = false;
  /** The session check after a stream error, while it runs. */
  let probing: Promise<void> | null = null;
  /**
   * Counts the sessions this source has seen start: a 401 of a request sent before the latest
   * sign-in is about the session that ended before it and is not reported again.
   */
  let generation = 0;

  /** Reports an ended session once per burst. */
  function sessionEnded(): void {
    if (sessionLost) return;
    sessionLost = true;
    sessionListener?.();
  }

  /** A signed-in user (sign-in, registration, /auth/me): the next 401 is a new ended session. */
  function sessionStarted(): void {
    sessionLost = false;
    generation += 1;
  }

  /** Passes a request's failure on, reporting an ended session first (`sentIn`: the generation when it was sent). */
  function failed(path: string, e: unknown, sentIn: number): never {
    if (sentIn === generation && endsSession(path, e)) sessionEnded();
    throw e;
  }

  /**
   * An EventSource never sees status codes: when the stream fails while sign-in is on, one
   * GET /auth/me tells whether the session ended (its 401 is reported like any other).
   */
  function checkSession(): void {
    if (!authEnabled || sessionLost || probing) return;
    probing = request<WireUserAnswer>('GET', '/auth/me')
      .then(
        () => undefined,
        (e: unknown) => {
          if (isApiError(e, 'not_authenticated')) sessionEnded();
        },
      )
      .finally(() => {
        probing = null;
      });
  }

  async function request<T>(method: string, path: string, body?: object): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json' } };
    if (body) {
      init.body = JSON.stringify(body);
      init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    }
    const sentIn = generation;
    let res: Response;
    try {
      res = await fetch(base + path, init);
    } catch {
      throw new UnreachableError(unreachableMessage(base));
    }
    const answer: Answer = {
      status: res.status,
      contentType: res.headers.get('content-type'),
      retryAfter: res.headers.get('retry-after'),
      json: () => res.json(),
    };
    return bodyOf<T>(base, method, path, answer).catch((e: unknown) => failed(path, e, sentIn));
  }

  /** Adapts a record and keeps it unless the source already holds a newer revision. */
  function remember(rec: WireBorehole): AdaptedBorehole {
    const adapted = adaptBorehole(rec);
    const known = records.get(adapted.borehole.uid);
    if (!known || known.borehole.revision <= adapted.borehole.revision) records.set(adapted.borehole.uid, adapted);
    return adapted;
  }

  /**
   * One console.info for a load or refetch batch: how many values the batch shows without a provenance
   * entry (read-only), with a few examples. The contract allows sparse provenance, so this is no
   * warning; values reported before are not counted again.
   */
  function reportUnsourced(batch: AdaptedBorehole[]): void {
    let boreholes = 0;
    const fresh: string[] = [];
    for (const a of batch) {
      const own = a.unsourced.map((path) => `${a.borehole.uid} ${path}`).filter((x) => !reported.has(x));
      for (const x of own) reported.add(x);
      if (own.length) boreholes += 1;
      fresh.push(...own);
    }
    if (!fresh.length) return;
    const values = fresh.length === 1 ? '1 value' : `${fresh.length} values`;
    const holes = boreholes === 1 ? '1 borehole' : `${boreholes} boreholes`;
    const more = fresh.length > 3 ? ', …' : '';
    console.info(
      `${values} in ${holes} ${fresh.length === 1 ? 'has' : 'have'} no provenance entry (the contract allows sparse provenance): ` +
        `shown read-only. E.g. ${fresh.slice(0, 3).join(', ')}${more}`,
    );
  }

  /** Full records the source holds for a document, in the order they arrived. */
  const boreholesOf = (documentId: string): Borehole[] =>
    [...records.values()].map((r) => r.borehole).filter((b) => b.documentId === documentId);

  /**
   * The boreholes the source knows of a document, without fetching: its map features in the server's
   * order, then the full records it holds that are not on the map layer (the "Not on map" list, records
   * fetched on demand).
   */
  function knownOf(documentId: string): { uid: string; project: string | null }[] {
    const own: { uid: string; project: string | null }[] = [...features.values()].filter((f) => f.documentId === documentId);
    for (const b of boreholesOf(documentId)) if (!features.has(b.uid)) own.push({ uid: b.uid, project: b.project || null });
    return own;
  }

  /** A document with what its boreholes add: project fallback, review borehole and lint list. */
  function summarise(d: WireDocument): DocumentSummary {
    docs.set(d.document_id, d);
    const doc = adaptDocument(d);
    const known = knownOf(d.document_id);
    return {
      ...doc,
      project: doc.project || known.find((b) => b.project)?.project || '',
      // The document object has no lint list: the panel lists the findings of the records the source holds.
      completeness: doc.completeness && { ...doc.completeness, lint: documentLint(boreholesOf(d.document_id), d.document_id) },
      reviewBoreholeUid: d.status === 'needs_review' || d.status === 'done' ? (known[0]?.uid ?? null) : null,
    };
  }

  /** The map layer (all, or one document's), replacing what the source knew of it. */
  async function readFeatures(documentId?: string): Promise<MapFeature[]> {
    const query = documentId ? `?document_id=${enc(documentId)}` : '';
    const list = adaptFeatures(await request<WireFeatureCollection>('GET', `/map/boreholes.geojson${query}`));
    if (documentId) {
      for (const [uid, f] of features) if (f.documentId === documentId) features.delete(uid);
    } else {
      features.clear();
    }
    for (const f of list) features.set(f.uid, f);
    return list;
  }

  /** The full records of the "Not on map" list, kept in the record cache (one provenance summary per call). */
  async function readUnplotted(): Promise<Borehole[]> {
    const adapted = (await listBoreholes('plotted=false')).map(remember);
    reportUnsourced(adapted);
    return adapted.map((a) => a.borehole);
  }

  /** A question from a single answer; one this client can't show is an error, never an invented question. */
  function oneClarification(w: WireClarification): Clarification {
    const c = adaptClarification(w);
    if (!c) throw new Error(`The server answered with a question this client can't show (${String(w?.clarification_id ?? '?')}).`);
    return c;
  }

  async function fetchDocument(id: string): Promise<WireDocument> {
    const d = await request<WireDocument>('GET', `/documents/${enc(id)}`);
    docs.set(id, d);
    return d;
  }

  /** Forgets a document the backend no longer has, with its boreholes and their map features. */
  function forgetDocument(id: string): void {
    docs.delete(id);
    for (const [uid, r] of records) if (r.borehole.documentId === id) records.delete(uid);
    for (const [uid, f] of features) if (f.documentId === id) features.delete(uid);
  }

  /**
   * The current state of a followed document for the live feed: document.updated, or
   * document.deleted when the backend no longer has it (deleted meanwhile). Other failures reject.
   */
  async function refetch(id: string): Promise<LiveEvent> {
    try {
      return { type: 'document.updated', document: summarise(await fetchDocument(id)) };
    } catch (e) {
      if (!isApiError(e, 'document_not_found')) throw e;
      forgetDocument(id);
      console.warn(`Document ${id} no longer exists on the backend; stopped following it.`);
      return { type: 'document.deleted', documentId: id };
    }
  }

  /** One event's data as a LiveEvent; a document.updated keeps the source's document cache current. */
  function adaptEvent(type: string, data: unknown): LiveEvent | null {
    const event = adaptLiveEvent(type, data, summarise);
    if (event?.type === 'document.deleted') forgetDocument(event.documentId);
    return event;
  }

  /**
   * The server's answer to one upload. A new document (202) is a pending summary named after the
   * file, with the typed project. Bytes uploaded before (200 with duplicate_of) give the earlier
   * document, marked as uploaded again: as the source knows it, else fetched once (nothing is
   * reprocessed, so no update would ever bring it), else a summary named after the file. Usually the
   * answer's document_id is that earlier document itself: a document is never "a duplicate of itself".
   */
  async function uploadResult(file: File, project: string | null, status: number, res: WireUploadAccepted): Promise<UploadResult> {
    const other = res.duplicate_of != null && res.duplicate_of !== res.document_id ? res.duplicate_of : null;
    if (status !== 200 || res.duplicate_of == null) {
      const pending = { ...pendingDocument(res.document_id, file.name, res.status), project: project ?? '' };
      return { document: { ...pending, uploaded: true, duplicateOf: other }, duplicate: false };
    }
    const known = docs.get(res.document_id) ?? (await fetchDocument(res.document_id).catch(() => undefined));
    const earlier = known ? summarise(known) : pendingDocument(res.document_id, file.name, res.status);
    const own = earlier.duplicateOf === earlier.id ? null : earlier.duplicateOf;
    return { document: { ...earlier, uploaded: true, uploadedAgain: true, duplicateOf: other ?? own }, duplicate: true };
  }

  /**
   * Sends one file with XMLHttpRequest (fetch has no upload progress). The answer is mapped like
   * every other request; cancel() aborts the transfer until the server has answered.
   */
  function sendFile(file: File, project: string | null, onProgress?: (p: UploadProgress) => void): UploadHandle {
    const sentIn = generation;
    let answered = false;
    let settle!: { resolve: (r: UploadResult) => void; reject: (e: unknown) => void };
    const done = new Promise<UploadResult>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const fail = (e: unknown) => {
      if (answered) return;
      answered = true;
      settle.reject(e);
    };
    const xhr = new XMLHttpRequest();
    const progress = (e: ProgressEvent) => {
      if (answered || !onProgress) return;
      const total = e.lengthComputable && e.total > 0 ? e.total : file.size;
      onProgress({ loaded: Math.min(e.loaded, total), total });
    };
    xhr.upload.onprogress = progress;
    xhr.upload.onload = progress;
    xhr.onload = () => {
      if (answered) return;
      answered = true;
      const res: Answer = {
        status: xhr.status,
        contentType: xhr.getResponseHeader('content-type'),
        retryAfter: xhr.getResponseHeader('retry-after'),
        json: async () => JSON.parse(xhr.responseText) as unknown,
      };
      bodyOf<WireUploadAccepted>(base, 'POST', '/documents', res)
        .catch((e: unknown) => failed('/documents', e, sentIn))
        .then((accepted) => uploadResult(file, project, xhr.status, accepted))
        .then((result) => {
          // The source follows what it accepted while the backend works on it.
          if (!isTerminal(result.document.status)) followed.add(result.document.id);
          settle.resolve(result);
        }, settle.reject);
    };
    xhr.onerror = () => fail(new UnreachableError(unreachableMessage(base)));
    xhr.ontimeout = () => fail(new UnreachableError(unreachableMessage(base)));
    xhr.onabort = () => fail(new UploadCancelledError(file.name));
    const form = new FormData();
    form.append('file', file);
    if (project != null) form.append('project', project);
    try {
      xhr.open('POST', `${base}/documents`);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.send(form);
    } catch {
      fail(new UnreachableError(unreachableMessage(base)));
    }
    return {
      done,
      cancel() {
        if (answered) return;
        xhr.abort();
        fail(new UploadCancelledError(file.name));
      },
    };
  }

  /** Every borehole of a filtered list (e.g. "plotted=false"), following next_cursor until the list ends. */
  async function listBoreholes(filter: string): Promise<WireBorehole[]> {
    const out: WireBorehole[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const query: string = `?${filter}&limit=${LIST_LIMIT}${cursor ? `&cursor=${enc(cursor)}` : ''}`;
      const page: WireBoreholeList = await request<WireBoreholeList>('GET', `/boreholes${query}`);
      out.push(...page.boreholes);
      if (cursor) seen.add(cursor);
      cursor = page.next_cursor ?? null;
    } while (cursor && !seen.has(cursor));
    return out;
  }

  /** The record a save starts from: the cached one, else fetched now (full records are loaded on demand). */
  async function recordFor(uid: string): Promise<AdaptedBorehole> {
    const cached = records.get(uid);
    if (cached) return cached;
    try {
      const adapted = remember(await request<WireBorehole>('GET', `/boreholes/${enc(uid)}`));
      reportUnsourced([adapted]);
      return adapted;
    } catch (e) {
      throw new SaveError(errorText(e), null, errorCode(e));
    }
  }

  /** One review save, run after the previous save of the same borehole has settled. */
  async function save(uid: string, key: string, patch: ValuePatch): Promise<Borehole> {
    const known = await recordFor(uid);
    const target = known.targets[key];
    if (!target) {
      throw new SaveError(`This value has no source entry in the backend record, so it can't be saved (${key}).`, known.borehole, null);
    }
    let bodies: PatchBody[];
    try {
      bodies = patchActions(patch, target);
    } catch (e) {
      throw new SaveError(errorText(e), known.borehole, null);
    }
    let last: Borehole | null = null;
    for (const body of bodies) {
      const revision = (records.get(uid) ?? known).borehole.revision;
      try {
        const rec = await request<WireBorehole>('PATCH', `/boreholes/${enc(uid)}/values`, { ...body, if_revision: revision });
        last = remember(rec).borehole;
      } catch (e) {
        if (isApiError(e, 'revision_conflict')) {
          let current: Borehole | null;
          try {
            current = remember(await request<WireBorehole>('GET', `/boreholes/${enc(uid)}`)).borehole;
          } catch {
            current = last ?? records.get(uid)?.borehole ?? null;
          }
          throw new SaveError(errorText(e), current, 'revision_conflict');
        }
        throw new SaveError(errorText(e), last ?? (records.get(uid) ?? known).borehole, errorCode(e));
      }
    }
    return last ?? (records.get(uid) ?? known).borehole;
  }

  return {
    kind: 'api',

    async health() {
      const health = adaptHealth(await request<WireHealth>('GET', '/health'));
      authEnabled = health.auth.enabled;
      return health;
    },

    async load() {
      // The light map layer and the few unplotted records; full records of plotted boreholes come on demand.
      const [docList, mapped, unplotted] = await Promise.all([
        request<WireDocumentList>('GET', '/documents'),
        readFeatures(),
        readUnplotted(),
      ]);
      const documents = docList.documents.map(summarise);
      // Documents still being processed (e.g. after a reload during extraction) keep updating.
      for (const d of docList.documents) {
        if (isTerminal(d.status)) followed.delete(d.document_id);
        else followed.add(d.document_id);
      }
      return { documents, features: mapped, unplotted };
    },

    mapFeatures(documentId) {
      return readFeatures(documentId);
    },

    unplotted() {
      return readUnplotted();
    },

    async createResultSet(filter) {
      return adaptResultSet(await request<WireResultSet>('POST', '/result-sets', toWireFilter(filter)));
    },

    async getResultSet(id) {
      return adaptResultSet(await request<WireResultSet>('GET', `/result-sets/${enc(id)}`));
    },

    async resultSetFeatures(id) {
      return adaptFeatures(await request<WireFeatureCollection>('GET', `/result-sets/${enc(id)}/geojson`));
    },

    async geocode(query) {
      return adaptPlaces(await request<WirePlace[]>('GET', `/geocode?q=${enc(query.trim())}`));
    },

    async clarifications(options = {}) {
      const params = [
        ...(options.status ? [`status=${enc(options.status)}`] : []),
        ...(options.documentId ? [`document_id=${enc(options.documentId)}`] : []),
      ];
      const query = params.length ? `?${params.join('&')}` : '';
      return adaptClarifications(await request<WireClarification[]>('GET', `/clarifications${query}`));
    },

    async answerClarification(id, values, answeredBy) {
      // The generated type of a free-form object is an empty record; the values go as the form holds them.
      const body: WireClarificationAnswer = { values: values as WireClarificationAnswer['values'], answered_by: answeredBy };
      return oneClarification(await request<WireClarification>('POST', `/clarifications/${enc(id)}/answer`, body));
    },

    async skipClarification(id) {
      return oneClarification(await request<WireClarification>('POST', `/clarifications/${enc(id)}/skip`));
    },

    async getBorehole(uid) {
      const adapted = remember(await request<WireBorehole>('GET', `/boreholes/${enc(uid)}`));
      reportUnsourced([adapted]);
      return adapted.borehole;
    },

    async documentBoreholes(documentId) {
      const list = await request<WireBorehole[]>('GET', `/documents/${enc(documentId)}/boreholes`);
      const adapted = list.map(remember);
      reportUnsourced(adapted);
      const boreholes = adapted.map((a) => a.borehole);
      // The answer is the document's full list: a borehole it no longer has (merged or removed) is gone.
      const listed = new Set(boreholes.map((b) => b.uid));
      for (const [uid, r] of records) if (r.borehole.documentId === documentId && !listed.has(uid)) records.delete(uid);
      for (const [uid, f] of features) if (f.documentId === documentId && !listed.has(uid)) features.delete(uid);
      return boreholes;
    },

    async getDocument(documentId) {
      return summarise(await fetchDocument(documentId));
    },

    async getPage(documentId, page) {
      const d = docs.get(documentId) ?? (await fetchDocument(documentId));
      const p = adaptDocument(d).pages[page - 1];
      return {
        documentId,
        page,
        type: p?.type ?? 'unknown',
        usage: pageUsageText(p),
        label: `page ${page} · ${d.file_name}`,
        imageUrl: `${base}/documents/${enc(documentId)}/pages/${page}.png?w=${PAGE_IMAGE_WIDTH}`,
      };
    },

    async getPageWords(documentId, page) {
      try {
        const words = await request<WirePageWord[]>('GET', `/documents/${enc(documentId)}/pages/${page}/words`);
        return words.flatMap((w) => {
          const [x, y, wd, h] = w.b ?? [];
          if (![x, y, wd, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return [];
          return [{ text: w.t, box: { x, y, w: wd, h }, conf: w.conf ?? null, source: w.source }];
        });
      } catch (e) {
        // A backend before 1.2.2 has no words endpoint: the view stays without them.
        if (e instanceof ApiError && e.status === 404) return [];
        throw e;
      }
    },

    thumbnailUrl(documentId, page) {
      return `${base}/documents/${enc(documentId)}/pages/${enc(String(page))}.png?w=${THUMBNAIL_WIDTH}`;
    },

    upload(file, { project, onProgress }) {
      return sendFile(file, project, onProgress);
    },

    subscribe(onEvent, onStatus) {
      return openLiveFeed(
        {
          url: `${base}/events`,
          followed,
          adapt: adaptEvent,
          refetch,
          streamFailed: checkSession,
          // After the session ended the stream would only fail again: it waits for the next subscription.
          canReconnect: () => !sessionLost,
        },
        onEvent,
        onStatus,
      );
    },

    follow(documentId) {
      followed.add(documentId);
    },

    updateValue(uid, key, patch) {
      // Saves of one borehole run in call order, so each PATCH carries the latest known revision.
      const previous = saving.get(uid) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(() => save(uid, key, patch));
      saving.set(uid, run);
      const done = () => {
        if (saving.get(uid) === run) saving.delete(uid);
      };
      run.then(done, done);
      return run;
    },

    async approveClean(documentId, dryRun) {
      const res = await request<{ count: number }>('POST', `/documents/${enc(documentId)}/approve-clean?dry_run=${dryRun}`);
      return res.count;
    },

    async retry(documentId) {
      await request<WireUploadAccepted>('POST', `/documents/${enc(documentId)}/retry`);
      followed.add(documentId);
    },

    async crsCandidates(documentId) {
      return adaptCrsCandidates(await request<WireCrsCandidate[]>('GET', `/documents/${enc(documentId)}/crs-candidates`));
    },

    async confirmCrs(documentId, { code, swapAxes, confirmedBy }) {
      const body: WireCrsConfirm = { crs: code, swap_axes: swapAxes, confirmed_by: confirmedBy, note: null };
      const res = await request<{ updated: number }>('POST', `/documents/${enc(documentId)}/crs`, body);
      return res.updated;
    },

    /* Sign-in (contract 1.3.0). The session is an HttpOnly cookie: no token ever reaches this code. */

    async currentUser() {
      try {
        const user = adaptUser((await request<WireUserAnswer>('GET', '/auth/me')).user);
        sessionStarted();
        return user;
      } catch (e) {
        if (isApiError(e) && e.status === 401) return null;
        throw e;
      }
    },

    async signIn(email, password) {
      const body: WireLogin = { email: email.trim(), password };
      const user = adaptUser((await request<WireUserAnswer>('POST', '/auth/login', body)).user);
      sessionStarted();
      return user;
    },

    async register({ email, password, displayName }) {
      const body: WireRegister = { email: email.trim(), password };
      const name = displayName?.trim();
      if (name) body.display_name = name;
      const user = adaptUser((await request<WireUserAnswer>('POST', '/auth/register', body)).user);
      sessionStarted();
      return user;
    },

    async signOut() {
      // Idempotent on the server; this side is signed out either way (later 401s stay quiet).
      sessionLost = true;
      await request<void>('POST', '/auth/logout');
    },

    setSessionListener(listener) {
      sessionListener = listener;
    },
  };
}
