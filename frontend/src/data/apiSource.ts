/**
 * DataSource over the FastAPI backend (docs/design/api-contract.md). Missing endpoints throw
 * "Backend endpoint not available: …"; this module never falls back to sample data.
 */
import { parseNumber } from '../domain/format';
import type { DocumentSummary, ValuePatch } from '../domain/types';
import { MULTI_FIELD_SEPARATOR } from '../schema/targetFormat';
import {
  adaptBorehole,
  adaptCrsCandidates,
  adaptDocument,
  apiPageUsage,
  documentLint,
  isTerminal,
  toApiState,
  type ApiBoreholeRecord,
  type ApiCrsCandidate,
  type ApiDocument,
  type ApiTarget,
  type ApiValueType,
} from './adapters';
import { PartialSaveError, type DataSource } from './DataSource';

const POLL_MS = 2000;
const PAGE_IMAGE_WIDTH = 1400;

/** Message shown when the backend can't be reached at all. */
export function unreachableMessage(base: string): string {
  return `Cannot reach the Bormisu backend at ${base}. Start the backend, or run npm run dev:sample for demo data.`;
}

async function readDetail(res: Response): Promise<string | null> {
  if (!res.headers.get('content-type')?.includes('json')) return null;
  try {
    const body = (await res.json()) as { detail?: unknown; error?: unknown };
    const d = body.detail ?? body.error;
    if (d == null) return null;
    return typeof d === 'string' ? d : JSON.stringify(d);
  } catch {
    return null;
  }
}

/** An edited value as the backend field expects it: numbers as numbers, IDs and text as typed. */
function serialise(text: string, type: ApiValueType): string | number {
  if (type === 'string') return text;
  if (type === 'spt') {
    const n = /^(?:n\s*=\s*)?(\d+)$/i.exec(text.trim());
    return n ? Number(n[1]) : text;
  }
  return parseNumber(text) ?? text;
}

/** The edit bodies of one value: one per path, a two-field value ("X / Y") split into its parts. */
function editBodies(text: string, target: ApiTarget): Record<string, unknown>[] {
  if (target.paths.length === 1) return [{ path: target.paths[0], action: 'edit', value: serialise(text, target.type) }];
  const parts = text.split(MULTI_FIELD_SEPARATOR).map((p) => p.trim());
  if (parts.length !== target.paths.length || parts.some((p) => !p)) {
    throw new Error(`Enter both values separated by "${MULTI_FIELD_SEPARATOR.trim()}", e.g. 3513420 / 5405870`);
  }
  return target.paths.map((path, i) => ({ path, action: 'edit', value: serialise(parts[i], target.type) }));
}

/** One step of a review patch: the PATCH bodies to send, and the part of the patch they save. */
export interface PatchStep {
  bodies: Record<string, unknown>[];
  applied: ValuePatch;
}

/** The PATCH steps for one review patch, in the order they must be sent. */
export function patchActions(patch: ValuePatch, target: ApiTarget): PatchStep[] {
  const each = (body: Record<string, unknown>) => target.paths.map((path) => ({ path, ...body }));
  const out: PatchStep[] = [];
  // A patch only carries `state` when it changes (set, or reset to ok), so it is always sent.
  if (patch.state) out.push({ bodies: each({ action: 'set_state', state: toApiState(patch.state) }), applied: { state: patch.state } });
  if (patch.value !== undefined) {
    out.push({ bodies: editBodies(patch.value, target), applied: { value: patch.value, ...(patch.method ? { method: patch.method } : {}) } });
  }
  if (patch.status === 'flagged') {
    out.push({ bodies: each({ action: 'flag', reason: patch.flag ?? '' }), applied: { status: 'flagged', flag: patch.flag } });
  } else if (patch.status === 'approved') {
    out.push({ bodies: each({ action: 'approve' }), applied: { status: 'approved' } });
  } else if (patch.status === 'unreviewed') {
    throw new Error('Backend endpoint not available: undoing a review (PATCH …/values) is not supported yet');
  }
  return out;
}

/** Creates the API data source for a base path such as "/api/v1". */
export function createApiSource(base: string): DataSource {
  const docs = new Map<string, ApiDocument>();
  const valueTargets = new Map<string, Record<string, ApiTarget>>();
  /** Documents being polled right now: one poll per document. */
  const polling = new Set<string>();
  const enc = encodeURIComponent;

  async function request<T>(method: string, path: string, body?: FormData | object): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json' } };
    if (body instanceof FormData) init.body = body;
    else if (body) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    }
    let res: Response;
    try {
      res = await fetch(base + path, init);
    } catch {
      throw new Error(unreachableMessage(base));
    }
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      // A dev server or static host answers unknown paths with index.html: there is no backend behind it.
      if (!res.headers.get('content-type')?.includes('json')) throw new Error(unreachableMessage(base));
      return (await res.json()) as T;
    }
    const detail = await readDetail(res);
    if (res.status === 404 && (detail === null || detail === 'Not Found')) {
      throw new Error(`Backend endpoint not available: ${method} ${base}${path}`);
    }
    if (res.status === 409 && detail === 'demo_mode') {
      throw new Error('Live extraction needs an API key: the backend runs in demo mode.');
    }
    if (res.status >= 500 && detail === null) throw new Error(unreachableMessage(base));
    throw new Error(detail ?? `${method} ${base}${path} failed (HTTP ${res.status})`);
  }

  async function getDocument(id: string): Promise<ApiDocument> {
    const d = await request<ApiDocument>('GET', `/documents/${enc(id)}`);
    docs.set(id, d);
    return d;
  }

  async function poll(first: DocumentSummary, onUpdate: (doc: DocumentSummary) => void): Promise<void> {
    let last = first;
    for (;;) {
      try {
        const d = await getDocument(first.id);
        last = { ...adaptDocument(d), ...(first.uploaded ? { uploaded: true } : {}) };
        onUpdate(last);
        if (isTerminal(d.status)) return;
      } catch (e) {
        onUpdate({ ...last, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  /** Polls a document every 2 s until the backend is done with it; a second call for it is ignored. */
  function follow(first: DocumentSummary, onUpdate: (doc: DocumentSummary) => void): void {
    if (polling.has(first.id)) return;
    polling.add(first.id);
    void poll(first, onUpdate).finally(() => polling.delete(first.id));
  }

  return {
    kind: 'api',

    async load() {
      const [list, docList] = await Promise.all([
        request<{ count: number; boreholes: ApiBoreholeRecord[] }>('GET', '/boreholes'),
        request<ApiDocument[] | { documents: ApiDocument[] }>('GET', '/documents'),
      ]);
      const boreholes = list.boreholes.map((rec) => {
        const { borehole, targets } = adaptBorehole(rec);
        valueTargets.set(borehole.uid, targets);
        return borehole;
      });
      const apiDocs = Array.isArray(docList) ? docList : docList.documents;
      const documents = apiDocs.map((d): DocumentSummary => {
        docs.set(d.document_id, d);
        const first = boreholes.find((b) => b.documentId === d.document_id);
        const doc = adaptDocument(d);
        return {
          ...doc,
          // The document object has no lint list: the panel lists its boreholes' findings.
          completeness: doc.completeness && { ...doc.completeness, lint: documentLint(boreholes, d.document_id) },
          project: first?.project ?? '',
          reviewBoreholeUid: d.status === 'needs_review' || d.status === 'done' ? first?.uid ?? null : null,
        };
      });
      return { boreholes, documents };
    },

    async getPage(documentId, page) {
      const d = docs.get(documentId) ?? (await getDocument(documentId));
      const type = adaptDocument(d).pageTypes[page - 1] ?? 'unknown';
      return {
        documentId,
        page,
        type,
        usage: apiPageUsage(d, page),
        label: `page ${page} · ${d.file_name}`,
        imageUrl: `${base}/documents/${enc(documentId)}/pages/${page}.png?w=${PAGE_IMAGE_WIDTH}`,
      };
    },

    async upload(files, onUpdate) {
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        const res = await request<{ document_id: string }>('POST', '/documents', form);
        const first: DocumentSummary = {
          id: res.document_id, name: file.name, project: '', pageTypes: [], step: 0,
          counts: null, completeness: null, reviewBoreholeUid: null, uploaded: true,
        };
        onUpdate(first);
        follow(first, onUpdate);
      }
    },

    watch(documentId, onUpdate) {
      const d = docs.get(documentId);
      const first: DocumentSummary = d
        ? adaptDocument(d)
        : { id: documentId, name: documentId, project: '', pageTypes: [], step: 0, counts: null, completeness: null, reviewBoreholeUid: null };
      follow(first, onUpdate);
    },

    async updateValue(uid, key, patch) {
      const target = valueTargets.get(uid)?.[key];
      if (!target) throw new Error(`Unknown value "${key}" of borehole ${uid}`);
      // The contract has one action per request, so a patch can be saved in part (e.g. edited, not approved).
      const applied: ValuePatch = {};
      for (const step of patchActions(patch, target)) {
        try {
          for (const body of step.bodies) await request('PATCH', `/boreholes/${enc(uid)}/values`, body);
        } catch (e) {
          if (Object.keys(applied).length === 0) throw e;
          throw new PartialSaveError(e instanceof Error ? e.message : String(e), applied);
        }
        Object.assign(applied, step.applied);
      }
    },

    async crsCandidates(documentId) {
      return adaptCrsCandidates(await request<ApiCrsCandidate[]>('GET', `/documents/${enc(documentId)}/crs-candidates`));
    },

    async confirmCrs(documentId, code) {
      await request('POST', `/documents/${enc(documentId)}/crs`, { crs: code, confirmed_by: 'Bormisu reviewer', note: '' });
    },
  };
}
