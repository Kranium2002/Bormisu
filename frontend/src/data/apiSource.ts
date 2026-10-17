/**
 * DataSource over the FastAPI backend (contracts/openapi.yaml, base path /api/v1). Error answers
 * become ApiError (by `code`), an unreachable backend UnreachableError, failed saves SaveError.
 * This module never falls back to sample data.
 */
import { APP_NAME } from '../config';
import { parseNumber } from '../domain/format';
import { pageUsageText } from '../domain/pages';
import type { Borehole, DocumentStatus, DocumentSummary, ValuePatch } from '../domain/types';
import { MULTI_FIELD_SEPARATOR } from '../schema/targetFormat';
import {
  adaptBorehole,
  adaptCrsCandidates,
  adaptDocument,
  adaptHealth,
  documentLint,
  isTerminal,
  stepOf,
  toApiState,
  type AdaptedBorehole,
  type PatchTarget,
  type PatchValueType,
  type WireBorehole,
  type WireBoreholeList,
  type WireCrsCandidate,
  type WireCrsConfirm,
  type WireDocument,
  type WireDocumentList,
  type WireHealth,
  type WireUploadAccepted,
  type WireValuePatch,
} from './adapters';
import type { DataSource } from './DataSource';
import { ApiError, errorCode, errorText, isApiError, SaveError, UnreachableError, type FieldError } from './errors';

/** Polling interval while a document is being worked on (ms). */
export const POLL_MS = 2000;
/** Longest wait between polls after errors (ms); the wait doubles from POLL_MS up to this. */
export const MAX_BACKOFF_MS = 30_000;
const PAGE_IMAGE_WIDTH = 1400;
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

/** The backend's Error body, when the answer is one. */
async function readError(res: Response): Promise<{ code: string; detail: string; errors: FieldError[] } | null> {
  try {
    const body = (await res.json()) as { code?: unknown; detail?: unknown; errors?: unknown };
    if (typeof body.code !== 'string') return null;
    const errors = Array.isArray(body.errors)
      ? (body.errors as { loc?: (string | number)[]; msg?: string }[]).map((e) => ({ loc: e?.loc ?? [], msg: e?.msg ?? '' }))
      : [];
    return { code: body.code, detail: typeof body.detail === 'string' ? body.detail : '', errors };
  } catch {
    return null;
  }
}

/** A document the backend just accepted, before the first poll. */
function pendingDocument(id: string, name: string, status: DocumentStatus): DocumentSummary {
  return {
    id, name, project: '', status, pages: [], step: stepOf(status), progress: null, counts: null, completeness: null,
    reviewBoreholeUid: null, openClarifications: 0, duplicateOf: null, error: null,
  };
}

/** One error for the files of an upload the server refused, naming each file; code and status of the first. */
function uploadError(failures: { file: File; error: ApiError }[]): ApiError {
  const first = failures[0].error;
  const text = failures.map(({ file, error }) => `${file.name}: ${errorText(error)}`).join(' · ');
  return new ApiError(first.status, first.code, first.detail, first.errors, text);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Creates the API data source for a base path such as "/api/v1". */
export function createApiSource(base: string): DataSource {
  const enc = encodeURIComponent;
  /** Latest wire document per id (page usage, page labels). */
  const docs = new Map<string, WireDocument>();
  /** Latest adapted record per uid: the borehole, its patch targets and its revision. */
  const records = new Map<string, AdaptedBorehole>();
  /** One promise chain per uid, so saves of a borehole run one after the other. */
  const saving = new Map<string, Promise<unknown>>();
  /** Documents being followed right now: one poll loop per document. */
  const following = new Set<string>();
  /** Values without a provenance entry already reported (`<uid> <path>`). */
  const reported = new Set<string>();

  async function request<T>(method: string, path: string, body?: FormData | object): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json' } };
    if (body instanceof FormData) init.body = body;
    else if (body) {
      init.body = JSON.stringify(body);
      init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    }
    let res: Response;
    try {
      res = await fetch(base + path, init);
    } catch {
      throw new UnreachableError(unreachableMessage(base));
    }
    const json = res.headers.get('content-type')?.includes('json') ?? false;
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      // A dev server or static host answers unknown paths with index.html: there is no backend behind it.
      if (!json) throw new UnreachableError(unreachableMessage(base));
      try {
        return (await res.json()) as T;
      } catch {
        throw new UnreachableError(unreachableMessage(base));
      }
    }
    const err = json ? await readError(res) : null;
    if (err?.code === 'route_not_found') {
      throw new ApiError(res.status, err.code, err.detail, err.errors, `Backend endpoint not available: ${method} ${base}${path}`);
    }
    if (err) throw new ApiError(res.status, err.code, err.detail, err.errors);
    if (!json && res.status >= 500) throw new UnreachableError(unreachableMessage(base));
    // nginx answers an oversized upload with its own HTML page.
    if (res.status === 413) throw new ApiError(413, 'too_large', 'The file is larger than the server accepts.');
    throw new ApiError(res.status, `http_${res.status}`, `${method} ${base}${path} failed (HTTP ${res.status})`);
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

  /** Boreholes the source knows for a document, in list order. */
  const boreholesOf = (documentId: string): Borehole[] =>
    [...records.values()].map((r) => r.borehole).filter((b) => b.documentId === documentId);

  /** A document with what its boreholes add: project fallback, review borehole and lint list. */
  function summarise(d: WireDocument): DocumentSummary {
    docs.set(d.document_id, d);
    const doc = adaptDocument(d);
    const own = boreholesOf(d.document_id);
    const first = own[0];
    return {
      ...doc,
      project: doc.project || first?.project || '',
      // The document object has no lint list: the panel lists its boreholes' findings.
      completeness: doc.completeness && { ...doc.completeness, lint: documentLint(own, d.document_id) },
      reviewBoreholeUid: d.status === 'needs_review' || d.status === 'done' ? (first?.uid ?? null) : null,
    };
  }

  async function fetchDocument(id: string): Promise<WireDocument> {
    const d = await request<WireDocument>('GET', `/documents/${enc(id)}`);
    docs.set(id, d);
    return d;
  }

  /**
   * Polls a document every POLL_MS until the backend is done with it. A failed poll is not a failed
   * document: the card keeps its last state, the wait doubles up to MAX_BACKOFF_MS, and polling goes
   * on. One console warning marks the start of each error streak. A document the backend no longer
   * has (deleted meanwhile) is not followed any further.
   */
  async function poll(first: DocumentSummary, onUpdate: (doc: DocumentSummary) => void): Promise<void> {
    let errors = 0;
    for (;;) {
      try {
        const d = await fetchDocument(first.id);
        const doc = summarise(d);
        onUpdate({
          ...doc,
          ...(first.uploaded ? { uploaded: true } : {}),
          ...(first.uploadedAgain ? { uploadedAgain: true } : {}),
          duplicateOf: doc.duplicateOf ?? first.duplicateOf,
        });
        if (isTerminal(d.status)) return;
        errors = 0;
      } catch (e) {
        if (isApiError(e, 'document_not_found')) {
          console.warn(`Document ${first.id} no longer exists on the backend; stopped following it.`);
          return;
        }
        if (errors === 0) console.warn(`Following document ${first.id} failed (${errorText(e)}); retrying with backoff.`);
        errors += 1;
      }
      await sleep(errors ? Math.min(POLL_MS * 2 ** (errors - 1), MAX_BACKOFF_MS) : POLL_MS);
    }
  }

  /** Follows a document until the backend is done with it; a second call for it is ignored. */
  function follow(first: DocumentSummary, onUpdate: (doc: DocumentSummary) => void): void {
    if (following.has(first.id)) return;
    following.add(first.id);
    void poll(first, onUpdate).finally(() => following.delete(first.id));
  }

  /** Every borehole, following next_cursor until the list ends. */
  async function listBoreholes(): Promise<WireBorehole[]> {
    const out: WireBorehole[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const query: string = `?limit=${LIST_LIMIT}${cursor ? `&cursor=${enc(cursor)}` : ''}`;
      const page: WireBoreholeList = await request<WireBoreholeList>('GET', `/boreholes${query}`);
      out.push(...page.boreholes);
      if (cursor) seen.add(cursor);
      cursor = page.next_cursor ?? null;
    } while (cursor && !seen.has(cursor));
    return out;
  }

  /** One review save, run after the previous save of the same borehole has settled. */
  async function save(uid: string, key: string, patch: ValuePatch): Promise<Borehole> {
    const known = records.get(uid);
    if (!known) throw new SaveError(`Unknown borehole ${uid}`, null, null);
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
      return adaptHealth(await request<WireHealth>('GET', '/health'));
    },

    async load() {
      const [list, docList] = await Promise.all([listBoreholes(), request<WireDocumentList>('GET', '/documents')]);
      const adapted = list.map(remember);
      reportUnsourced(adapted);
      const boreholes = adapted.map((a) => a.borehole);
      const documents = docList.documents.map(summarise);
      return { boreholes, documents };
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

    async upload(files, onUpdate, options) {
      const refused: { file: File; error: ApiError }[] = [];
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        if (options?.project != null) form.append('project', options.project);
        let res: WireUploadAccepted;
        try {
          res = await request<WireUploadAccepted>('POST', '/documents', form);
        } catch (e) {
          // Demo mode refuses every file and an unreachable backend takes none: stop. Otherwise the
          // server refused this file only (type, size): send the others and name it at the end.
          if (!isApiError(e) || e.code === 'demo_mode') throw e;
          refused.push({ file, error: e });
          continue;
        }
        // A 200 answer for bytes uploaded before names the earlier document, usually as its own id
        // (document_id = duplicate_of): then this is that document, not a new one and not a duplicate
        // of itself, and its card keeps what the source knows of it.
        const earlier = res.duplicate_of != null ? docs.get(res.document_id) : undefined;
        const base = earlier ? summarise(earlier) : { ...pendingDocument(res.document_id, file.name, res.status), project: options?.project ?? '' };
        const other = res.duplicate_of != null && res.duplicate_of !== res.document_id ? res.duplicate_of : null;
        const again = res.duplicate_of != null && res.duplicate_of === res.document_id;
        const first: DocumentSummary = {
          ...base, uploaded: true, ...(again ? { uploadedAgain: true } : {}), duplicateOf: other ?? base.duplicateOf,
        };
        onUpdate(first);
        follow(first, onUpdate);
      }
      if (refused.length) throw uploadError(refused);
    },

    watch(documentId, onUpdate) {
      const d = docs.get(documentId);
      follow(d ? summarise(d) : pendingDocument(documentId, documentId, 'queued'), onUpdate);
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
    },

    async crsCandidates(documentId) {
      return adaptCrsCandidates(await request<WireCrsCandidate[]>('GET', `/documents/${enc(documentId)}/crs-candidates`));
    },

    async confirmCrs(documentId, { code, swapAxes, confirmedBy }) {
      const body: WireCrsConfirm = { crs: code, swap_axes: swapAxes, confirmed_by: confirmedBy, note: null };
      const res = await request<{ updated: number }>('POST', `/documents/${enc(documentId)}/crs`, body);
      return res.updated;
    },
  };
}
