/**
 * API mode against a fictional backend (fetch mocked, payloads from src/test/contract): error mapping
 * by code, pagination, review saves, documents, uploads and polling. Never falls back to sample data.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { K } from '../domain/keys';
import type { DocumentSummary } from '../domain/types';
import { contractErrors } from '../test/contract/schema';
import { fixture } from '../test/contract/wire';
import type { WireBorehole, WireBoreholeList, WireDocument, WireDocumentList, WireError } from './adapters';
import { createApiSource, MAX_BACKOFF_MS, POLL_MS, unreachableMessage } from './apiSource';
import { ApiError, SaveError, UnreachableError } from './errors';

const BASE = '/api/v1';
const D1 = 'doc_01JFICT0000000000000000D1';
const D2 = 'doc_01JFICT0000000000000000D2';
const D3 = 'doc_01JFICT0000000000000000D3';
const D5 = 'doc_01JFICT0000000000000000D5';
const D7 = 'doc_01JFICT0000000000000000D7';
const HL01 = 'bh_01JFICT00000000000000HL01';
const HL02 = 'bh_01JFICT00000000000000HL02';
const KR01 = 'bh_01JFICT00000000000000KR01';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (status: number, body: string, type = 'text/html') => new Response(body, { status, headers: { 'content-type': type } });
const errorBody = (code: string) => fixture<WireError[]>('errors').find((e) => e.code === code) as WireError;
const apiError = (status: number, code: string) => json(status, errorBody(code));

interface Call { method: string; url: string; body?: Record<string, unknown>; form?: FormData }
type Route = (call: Call) => Response | Promise<Response> | undefined;

/**
 * A fictional backend. `server.records` is its state; PATCH checks if_revision, applies the action's
 * review status and answers the full record at the next revision. `route` answers first when it
 * returns a Response (or throws, which is a network failure).
 */
function backend(route: Route = () => undefined) {
  const calls: Call[] = [];
  const records = new Map<string, WireBorehole>(
    [...fixture<WireBoreholeList>('boreholes-page-1').boreholes, ...fixture<WireBoreholeList>('boreholes-page-2').boreholes].map((r) => [r.uid, r]),
  );
  const documents = fixture<WireDocumentList>('documents').documents;
  const answer = async (call: Call): Promise<Response> => {
    const own = await route(call);
    if (own) return own;
    const path = call.url.slice(BASE.length);
    if (call.method === 'GET' && path === '/health') return json(200, fixture('health-live'));
    if (call.method === 'GET' && path === '/boreholes?limit=5000') return json(200, fixture('boreholes-page-1'));
    if (call.method === 'GET' && path === '/boreholes?limit=5000&cursor=cur_FICT_page2') return json(200, fixture('boreholes-page-2'));
    if (call.method === 'GET' && path === '/documents') return json(200, fixture('documents'));
    let m = /^\/boreholes\/([^/?]+)(\/values)?$/.exec(path);
    if (m) {
      const rec = records.get(decodeURIComponent(m[1]));
      if (!rec) return apiError(404, 'borehole_not_found');
      if (call.method === 'GET') return json(200, rec);
      const body = call.body ?? {};
      if (body.if_revision != null && body.if_revision !== rec.revision) return apiError(409, 'revision_conflict');
      const p = rec.provenance[String(body.path)];
      if (!p) return apiError(404, 'path_not_found');
      if (body.action === 'approve') p.status = 'approved';
      if (body.action === 'flag') Object.assign(p, { status: 'flagged', flag: body.reason });
      if (body.action === 'reset') Object.assign(p, { status: 'unreviewed', flag: null });
      if (body.action === 'edit') p.method = 'edited';
      if (body.action === 'set_state') p.state = body.state as typeof p.state;
      rec.revision += 1;
      return json(200, rec);
    }
    m = /^\/documents\/([^/?]+)(\/boreholes)?$/.exec(path);
    if (m && call.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const doc = documents.find((d) => d.document_id === id);
      if (!doc) return apiError(404, 'document_not_found');
      return json(200, m[2] ? [...records.values()].filter((r) => r.document_id === id) : doc);
    }
    return apiError(404, 'route_not_found');
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const form = init?.body instanceof FormData ? init.body : undefined;
    const call: Call = { method: init?.method ?? 'GET', url, body, form };
    calls.push(call);
    return answer(call);
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, records, documents };
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body);

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe('request errors', () => {
  it('reports an unreachable backend when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const loading = createApiSource(BASE).load();
    await expect(loading).rejects.toBeInstanceOf(UnreachableError);
    await expect(loading).rejects.toThrow(unreachableMessage(BASE));
  });

  it('reports an unreachable backend when a dev server answers with its HTML page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => text(200, '<!doctype html>')));
    await expect(createApiSource(BASE).health()).rejects.toBeInstanceOf(UnreachableError);
  });

  it('reports an unreachable backend on a proxy error without a JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => text(502, '<html>Bad Gateway</html>')));
    await expect(createApiSource(BASE).health()).rejects.toThrow(unreachableMessage(BASE));
  });

  it('turns a JSON error answer into an ApiError by code, with the detail as message', async () => {
    backend();
    const api = createApiSource(BASE);
    const failing = api.getDocument('doc_unknown');
    await expect(failing).rejects.toBeInstanceOf(ApiError);
    await failing.catch((e: ApiError) => {
      expect([e.status, e.code, e.detail, e.message]).toEqual([404, 'document_not_found', 'Document not found.', 'Document not found.']);
    });
  });

  it('keeps the field errors of a validation_error', async () => {
    backend(() => apiError(422, 'validation_error'));
    await createApiSource(BASE).retry(D3).catch((e: ApiError) => {
      expect(e.code).toBe('validation_error');
      expect(e.errors).toEqual([{ loc: ['body', 'path'], msg: 'Field required' }]);
    });
    expect.assertions(2);
  });

  it('a JSON 5xx is a backend answer, not an unreachable backend', async () => {
    backend(() => apiError(500, 'internal_error'));
    await expect(createApiSource(BASE).health()).rejects.toMatchObject({ name: 'ApiError', code: 'internal_error', status: 500 });
  });

  it('names the endpoint only for route_not_found', async () => {
    backend((c) => (c.url.includes('/boreholes') ? apiError(404, 'route_not_found') : undefined));
    await expect(createApiSource(BASE).load()).rejects.toThrow('Backend endpoint not available: GET /api/v1/boreholes?limit=5000');
  });

  it('gives other non-JSON answers a code from the status, never from the text', async () => {
    backend(() => text(404, 'Not Found', 'text/plain'));
    await expect(createApiSource(BASE).getDocument(D1)).rejects.toMatchObject({ code: 'http_404', status: 404 });
    backend(() => json(404, { detail: 'Not Found' }));
    await expect(createApiSource(BASE).getDocument(D1)).rejects.toMatchObject({ code: 'http_404', detail: expect.not.stringMatching(/Not Found/) });
  });
});

describe('health', () => {
  it('reads GET /api/v1/health', async () => {
    const { calls } = backend();
    await expect(createApiSource(BASE).health()).resolves.toMatchObject({ mode: 'live', upload: { maxMb: 200 } });
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/health']);
    backend((c) => (c.url.endsWith('/health') ? json(200, fixture('health-demo')) : undefined));
    await expect(createApiSource(BASE).health()).resolves.toMatchObject({ mode: 'demo', providers: { chat: false } });
  });
});

describe('load', () => {
  it('follows next_cursor and loads every document', async () => {
    const { calls } = backend();
    const { boreholes, documents } = await createApiSource(BASE).load();
    expect(calls.map((c) => c.url).sort()).toEqual([
      '/api/v1/boreholes?limit=5000', '/api/v1/boreholes?limit=5000&cursor=cur_FICT_page2', '/api/v1/documents',
    ]);
    expect(boreholes.map((b) => b.uid)).toEqual([HL01, HL02, KR01]);
    expect(documents.map((d) => d.status)).toEqual(['needs_review', 'extracting', 'failed', 'needs_review', 'queued']);
  });

  it("fills a document's project, review borehole and lint list from its boreholes", async () => {
    backend();
    const { documents } = await createApiSource(BASE).load();
    const [d1, d2, d3] = documents;
    expect(d1).toMatchObject({ project: 'Harbourline Tunnel (fictional)', reviewBoreholeUid: HL01 });
    expect(d1.completeness?.lint).toHaveLength(5);
    expect(d1.completeness?.lint[0]).toMatchObject({ boreholeId: 'HL-01' });
    // The document has no project: it falls back to its first borehole's.
    expect(d2).toMatchObject({ project: 'Kestrel Ridge Bypass (fictional)', reviewBoreholeUid: null });
    expect(d3).toMatchObject({ project: '', error: 'The file could not be read as an image.' });
  });

  it('stops paging when the server repeats a cursor', async () => {
    const { calls } = backend((c) =>
      c.url.includes('/boreholes?') ? json(200, { count: 1, boreholes: [], next_cursor: 'same' }) : undefined,
    );
    await createApiSource(BASE).load();
    expect(calls.filter((c) => c.url.includes('/boreholes?'))).toHaveLength(2);
  });

  it('loads an empty backend as no boreholes and no documents', async () => {
    backend((c) =>
      c.url.includes('/boreholes') ? json(200, { count: 0, boreholes: [], next_cursor: null }) : json(200, { documents: [] }),
    );
    await expect(createApiSource(BASE).load()).resolves.toEqual({ boreholes: [], documents: [] });
  });

  it('fails on a record without uid', async () => {
    backend((c) => {
      if (!c.url.includes('/boreholes?')) return undefined;
      const page = fixture<WireBoreholeList>('boreholes-page-2');
      delete (page.boreholes[0] as Partial<WireBorehole>).uid;
      return json(200, page);
    });
    await expect(createApiSource(BASE).load()).rejects.toThrow(/without uid/);
  });
});

describe('single resources', () => {
  it('gets a borehole, the boreholes of a document and a document', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await expect(api.getBorehole(KR01)).resolves.toMatchObject({ uid: KR01, revision: 2 });
    await expect(api.documentBoreholes(D1)).resolves.toHaveLength(2);
    await expect(api.getDocument(D2)).resolves.toMatchObject({ id: D2, status: 'extracting', project: 'Kestrel Ridge Bypass (fictional)' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/v1/boreholes/${KR01}`, `GET /api/v1/documents/${D1}/boreholes`, `GET /api/v1/documents/${D2}`,
    ]);
  });

  it("forgets a document's boreholes that its borehole list no longer has", async () => {
    const { records } = backend();
    const api = createApiSource(BASE);
    await api.load();
    // The backend merged HL-01 away (e.g. after a borehole-boundary answer): the document lists HL-02 only.
    records.delete(HL01);
    await expect(api.documentBoreholes(D1)).resolves.toMatchObject([{ uid: HL02 }]);
    const doc = await api.getDocument(D1);
    expect(doc.reviewBoreholeUid).toBe(HL02);
    expect(doc.completeness?.lint.every((l) => l.boreholeId === 'HL-02')).toBe(true);
  });

  it('serves page images at 1400 px with the usage the backend reported', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await expect(api.getPage(D1, 8)).resolves.toEqual({
      documentId: D1, page: 8, type: 'log', usage: 'unused: duplicate of page 6', label: 'page 8 · harbourline_GI_report.pdf',
      imageUrl: `/api/v1/documents/${D1}/pages/8.png?w=1400`,
    });
    await expect(api.getPage(D1, 4)).resolves.toMatchObject({ usage: 'used: log sheet' });
    expect(calls).toHaveLength(1);
    await expect(api.getPage(D2, 5)).resolves.toMatchObject({ type: 'unknown', usage: 'not classified yet' });
  });
});

describe('review saves', () => {
  it('serialises saves of one borehole so every PATCH carries the latest revision, and resolves with the answer', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await api.load();
    const first = api.updateValue(HL01, K.finalDepth, { value: '15.6', method: 'Edited', status: 'approved' });
    const second = api.updateValue(HL01, K.boreholeName, { status: 'flagged', flag: 'check spelling' });
    const third = api.updateValue(HL01, K.notes, { state: 'not in source', status: 'approved' });
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(patches(calls)).toEqual([
      { path: 'metadata.borehole_depth_m', action: 'edit', value: 15.6, if_revision: 4 },
      { path: 'metadata.borehole_depth_m', action: 'approve', if_revision: 5 },
      { path: 'metadata.borehole_name', action: 'flag', reason: 'check spelling', if_revision: 6 },
      { path: 'metadata.notes', action: 'set_state', state: 'not_in_source', if_revision: 7 },
      { path: 'metadata.notes', action: 'approve', if_revision: 8 },
    ]);
    for (const body of patches(calls)) expect(contractErrors('ValuePatch', body)).toEqual([]);
    expect([a.revision, b.revision, c.revision]).toEqual([6, 7, 9]);
    expect(b.values.find((v) => v.key === K.boreholeName)).toMatchObject({ status: 'flagged', flag: 'check spelling' });
    expect(c.values.find((v) => v.key === K.notes)).toMatchObject({ state: 'not in source', status: 'approved' });
  });

  it('keeps saves of different boreholes independent', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await api.load();
    await Promise.all([api.updateValue(HL01, K.boreholeId, { status: 'unreviewed' }), api.updateValue(HL02, K.boreholeId, { status: 'approved' })]);
    expect(patches(calls)).toEqual([
      { path: 'metadata.borehole_id', action: 'reset', if_revision: 4 },
      { path: 'metadata.borehole_id', action: 'approve', if_revision: 1 },
    ]);
  });

  it('on revision_conflict refetches the record and fails with it as current', async () => {
    const { calls, records } = backend();
    const api = createApiSource(BASE);
    await api.load();
    (records.get(HL01) as WireBorehole).revision = 11; // someone else saved meanwhile
    const saving = api.updateValue(HL01, K.finalDepth, { status: 'approved' });
    await expect(saving).rejects.toBeInstanceOf(SaveError);
    await saving.catch((e: SaveError) => {
      expect(e.code).toBe('revision_conflict');
      expect(e.message).toBe('The record changed since you loaded it.');
      expect(e.current?.revision).toBe(11);
    });
    expect(calls.slice(-2).map((c) => `${c.method} ${c.url}`)).toEqual([`PATCH /api/v1/boreholes/${HL01}/values`, `GET /api/v1/boreholes/${HL01}`]);
    // The next save sends the revision of the refetched record.
    await expect(api.updateValue(HL01, K.finalDepth, { status: 'approved' })).resolves.toMatchObject({ revision: 12 });
    expect(patches(calls).at(-1)).toMatchObject({ if_revision: 11 });
  });

  it('a partly saved value fails with the record of the last successful answer', async () => {
    backend((c) => (c.method === 'PATCH' && c.body?.action === 'approve' ? apiError(500, 'internal_error') : undefined));
    const api = createApiSource(BASE);
    await api.load();
    const saving = api.updateValue(HL01, K.finalDepth, { value: '15.6', method: 'Edited', status: 'approved' });
    await saving.catch((e: SaveError) => {
      expect(e).toBeInstanceOf(SaveError);
      expect([e.code, e.message, e.current?.revision]).toEqual(['internal_error', 'Something went wrong on the server.', 5]);
      expect(e.current?.values.find((v) => v.key === K.finalDepth)?.method).toBe('Edited');
    });
    expect.assertions(3);
  });

  it('a failure before anything was saved has the cached record as current', async () => {
    backend((c) => {
      if (c.method === 'PATCH') throw new TypeError('Failed to fetch');
      return undefined;
    });
    const api = createApiSource(BASE);
    await api.load();
    await api.updateValue(HL01, K.finalDepth, { status: 'approved' }).catch((e: SaveError) => {
      expect([e.code, e.current?.revision, e.message]).toEqual([null, 4, unreachableMessage(BASE)]);
    });
    expect.assertions(1);
  });

  it('refuses values without a provenance entry without sending anything', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await api.load();
    await expect(api.updateValue(HL02, K.notes, { status: 'approved' })).rejects.toMatchObject({ name: 'SaveError', current: { uid: HL02 } });
    await expect(api.updateValue('bh_unknown', K.notes, { status: 'approved' })).rejects.toMatchObject({ name: 'SaveError', current: null });
    expect(patches(calls)).toEqual([]);
  });

  it('DV-15: refuses an SPT text that is no whole N before sending, where the backend tracks no printed SPT text', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await api.load();
    const failed = await api.updateValue(HL01, K.spt(4), { value: '50/12', method: 'Edited', status: 'approved' }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(SaveError);
    expect(failed).toMatchObject({
      message: 'Enter N as a whole number. A refusal can only be corrected where the backend tracks the printed SPT text.',
      current: { uid: HL01, revision: 4 },
    });
    expect(patches(calls)).toEqual([]);
    await api.updateValue(HL01, K.spt(4), { value: 'N = 9', method: 'Edited' });
    expect(patches(calls)).toEqual([{ path: 'stratigraphy[3].spt_n_value', action: 'edit', value: 9, if_revision: 4 }]);
  });

  it('a failed save does not block the next one', async () => {
    let fail = true;
    backend((c) => {
      if (c.method === 'PATCH' && fail) {
        fail = false;
        return apiError(422, 'unparseable_value');
      }
      return undefined;
    });
    const api = createApiSource(BASE);
    await api.load();
    const bad = api.updateValue(HL01, K.finalDepth, { value: 'abc', method: 'Edited' });
    const good = api.updateValue(HL01, K.finalDepth, { status: 'approved' });
    await expect(bad).rejects.toMatchObject({ code: 'unparseable_value' });
    await expect(good).resolves.toMatchObject({ revision: 5 });
  });
});

describe('values without a provenance entry (the contract allows sparse provenance)', () => {
  it('logs at most one console.info summary per load or refetch batch, never a warning per value', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { records } = backend((c) =>
      c.url.endsWith('/boreholes?limit=5000')
        ? json(200, { ...fixture<WireBoreholeList>('boreholes-page-1'), boreholes: [records.get(HL01), records.get(HL02)] })
        : undefined,
    );
    for (const uid of [HL01, HL02]) {
      const rec = records.get(uid) as WireBorehole;
      delete rec.provenance['metadata.project_name'];
      delete rec.provenance['metadata.borehole_depth_m'];
    }
    const api = createApiSource(BASE);
    const { boreholes } = await api.load();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const summary = String(info.mock.calls[0][0]);
    expect(summary).toMatch(/^4 values in 2 boreholes have no provenance entry/);
    expect(summary).toContain(`${HL01} metadata.project_name`);
    // Still shown, read-only.
    expect(boreholes[0].values.find((v) => v.key === K.finalDepth)).toMatchObject({ value: '15.50', hasProvenance: false, method: null });
    // A refetch of the same values adds no second summary; a batch with a new one adds one.
    await api.documentBoreholes(D1);
    expect(info).toHaveBeenCalledTimes(1);
    delete (records.get(HL02) as WireBorehole).provenance['metadata.coordinates.coordinate_system'];
    await api.documentBoreholes(D1);
    await api.getBorehole(HL02);
    expect(info).toHaveBeenCalledTimes(2);
    expect(String(info.mock.calls[1][0])).toMatch(/^1 value in 1 borehole has no provenance entry.*metadata\.coordinates\.coordinate_system/);
    expect(warn).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('logs nothing when every value has an entry', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    backend();
    await createApiSource(BASE).load();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

describe('document actions', () => {
  it('approves clean values with a dry run first', async () => {
    const { calls } = backend((c) => (c.url.includes('/approve-clean') ? json(200, fixture('approve-clean-dry-run')) : undefined));
    const api = createApiSource(BASE);
    await expect(api.approveClean(D1, true)).resolves.toBe(7);
    await expect(api.approveClean(D1, false)).resolves.toBe(7);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /api/v1/documents/${D1}/approve-clean?dry_run=true`,
      `POST /api/v1/documents/${D1}/approve-clean?dry_run=false`,
    ]);
  });

  it('retries a failed document', async () => {
    const { calls } = backend((c) => (c.url.endsWith('/retry') ? json(202, fixture('retry-accepted')) : undefined));
    await expect(createApiSource(BASE).retry(D3)).resolves.toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /api/v1/documents/${D3}/retry`]);
  });

  it('confirms a CRS with swap_axes and the optional reviewer name', async () => {
    const { calls } = backend((c) => (c.url.endsWith('/crs') ? json(200, fixture('crs-confirmed')) : undefined));
    const api = createApiSource(BASE);
    await expect(api.confirmCrs(D7, { code: 'EPSG:31983', swapAxes: true, confirmedBy: null })).resolves.toBe(2);
    await api.confirmCrs(D7, { code: 'EPSG:31983', swapAxes: false, confirmedBy: 'A. Reviewer' });
    expect(calls.map((c) => c.body)).toEqual([
      { crs: 'EPSG:31983', swap_axes: true, confirmed_by: null, note: null },
      { crs: 'EPSG:31983', swap_axes: false, confirmed_by: 'A. Reviewer', note: null },
    ]);
    expect(calls[0].url).toBe(`/api/v1/documents/${D7}/crs`);
    for (const c of calls) expect(contractErrors('CrsConfirmRequest', c.body)).toEqual([]);
  });

  it('lists CRS candidates', async () => {
    backend((c) => (c.url.endsWith('/crs-candidates') ? json(200, fixture('crs-candidates')) : undefined));
    const list = await createApiSource(BASE).crsCandidates(D7);
    expect(list.map((c) => [c.code, c.verdict, c.swapAxes])).toEqual([
      ['EPSG:31983', 'match', true], ['EPSG:29193', 'shifted', true], ['EPSG:31984', 'out_of_range', false], ['EPSG:32723', null, false],
    ]);
  });
});

describe('uploads', () => {
  const file = () => new File(['%PDF-1.4 fictional'], 'tamarind_quay_logs.pdf', { type: 'application/pdf' });

  it('sends the project with the file, reports the new document and follows it', async () => {
    const { calls } = backend((c) => {
      if (c.method === 'POST' && c.url.endsWith('/documents')) return json(202, fixture('upload-accepted'));
      if (c.url.endsWith(`/documents/${D5}`)) return json(200, { ...fixture<WireDocumentList>('documents').documents[4], status: 'done' });
      return undefined;
    });
    const updates: DocumentSummary[] = [];
    await createApiSource(BASE).upload([file()], (d) => updates.push(d), { project: 'Tamarind Quay Outfall (fictional)' });
    const form = calls[0].form as FormData;
    expect((form.get('file') as File).name).toBe('tamarind_quay_logs.pdf');
    expect(form.get('project')).toBe('Tamarind Quay Outfall (fictional)');
    expect(updates[0]).toMatchObject({ id: D5, name: 'tamarind_quay_logs.pdf', status: 'queued', step: 0, uploaded: true, duplicateOf: null, error: null });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toMatchObject({ id: D5, status: 'done', step: 3, uploaded: true });
  });

  it('omits the project when there is none', async () => {
    const { calls } = backend((c) => (c.method === 'POST' ? json(202, fixture('upload-accepted')) : undefined));
    await createApiSource(BASE).upload([file()], () => undefined, { project: null });
    expect((calls[0].form as FormData).has('project')).toBe(false);
  });

  it('reports a duplicate upload as the earlier document itself (never a duplicate of itself) and follows it', async () => {
    backend((c) => (c.method === 'POST' ? json(200, fixture('upload-duplicate')) : undefined));
    const updates: DocumentSummary[] = [];
    await createApiSource(BASE).upload([file()], (d) => updates.push(d), { project: null });
    expect(updates[0]).toMatchObject({ id: D1, duplicateOf: null, status: 'needs_review', uploaded: true });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toMatchObject({ id: D1, duplicateOf: null, uploaded: true, status: 'needs_review', name: 'harbourline_GI_report.pdf' });
  });

  it('keeps a duplicate answer that names another document', async () => {
    backend((c) => {
      if (c.method === 'POST') return json(200, { document_id: D5, status: 'queued', duplicate_of: D1 });
      if (c.url.endsWith(`/documents/${D5}`)) return json(200, { ...fixture<WireDocumentList>('documents').documents[4], status: 'done' });
      return undefined;
    });
    const updates: DocumentSummary[] = [];
    await createApiSource(BASE).upload([file()], (d) => updates.push(d), { project: null });
    expect(updates[0]).toMatchObject({ id: D5, duplicateOf: D1 });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toMatchObject({ id: D5, duplicateOf: D1, status: 'done' });
  });

  it('rejects in demo mode with code demo_mode', async () => {
    backend((c) => (c.method === 'POST' ? apiError(409, 'demo_mode') : undefined));
    await expect(createApiSource(BASE).upload([file()], () => undefined)).rejects.toMatchObject({ name: 'ApiError', code: 'demo_mode', status: 409 });
  });

  it("maps nginx's HTML 413 answer to too_large", async () => {
    backend(() => text(413, '<html><body>413 Request Entity Too Large</body></html>'));
    await expect(createApiSource(BASE).upload([file()], () => undefined)).rejects.toMatchObject({ name: 'ApiError', code: 'too_large', status: 413 });
  });
});

describe('following documents', () => {
  it('watches a document once, however often it is asked to', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await api.load();
    const onUpdate = vi.fn();
    api.watch?.(D1, onUpdate);
    api.watch?.(D1, onUpdate);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ id: D1, step: 2, reviewBoreholeUid: HL01 });
    expect(onUpdate.mock.calls[0][0].uploaded).toBeUndefined();
    expect(calls.filter((c) => c.url.endsWith(`/documents/${D1}`))).toHaveLength(1);
  });

  it('backs off after errors and keeps polling until the document is done; errors never fail the document', async () => {
    vi.useFakeTimers();
    const extracting = fixture<WireDocumentList>('documents').documents[1];
    let polls = 0;
    backend((c) => {
      if (!c.url.endsWith(`/documents/${D2}`)) return undefined;
      polls += 1;
      if (polls === 1) return json(200, extracting);
      if (polls <= 4) throw new TypeError('Failed to fetch');
      return json(200, { ...extracting, status: 'needs_review' } satisfies WireDocument);
    });
    const onUpdate = vi.fn();
    createApiSource(BASE).watch?.(D2, onUpdate);
    await vi.advanceTimersByTimeAsync(0);
    expect([polls, onUpdate.mock.calls.length]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(POLL_MS); // t = 2 s: fails
    await vi.advanceTimersByTimeAsync(POLL_MS); // t = 4 s: fails again after 2 s
    expect(polls).toBe(3);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS - 1);
    expect(polls).toBe(3);
    await vi.advanceTimersByTimeAsync(1); // t = 8 s: third failure, next wait 8 s
    expect(polls).toBe(4);
    await vi.advanceTimersByTimeAsync(4 * POLL_MS); // t = 16 s: answers again
    expect(polls).toBe(5);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls.map((c) => [c[0].status, c[0].error])).toEqual([['extracting', null], ['needs_review', null]]);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF_MS);
    expect(polls).toBe(5); // done: no more polls
  });

  it('never stops for good while the backend stays away; the wait is capped at 30 s', async () => {
    vi.useFakeTimers();
    let polls = 0;
    backend((c) => {
      if (!c.url.includes('/documents/')) return undefined;
      polls += 1;
      throw new TypeError('Failed to fetch');
    });
    const onUpdate = vi.fn();
    createApiSource(BASE).watch?.(D2, onUpdate);
    // Waits after each failure: 2, 4, 8, 16, 30, 30 s.
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000 + 30_000 + 30_000 - 1);
    expect(polls).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(7);
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(polls).toBe(8);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
