/**
 * The API data source against a fictional backend that answers with the backend's own contract
 * examples (<repo>/contracts/examples): pagination, the ValuePatch bodies, every Error code, health,
 * CRS candidates, the UploadAccepted answers of an upload (including a duplicate) and following a
 * document the backend deleted. fetch and XMLHttpRequest are mocked; nothing leaves the process.
 * Skips while the examples are not on this branch. The event examples are in liveEvents.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { K } from '../domain/keys';
import type { LiveEvent, ValuePatch } from '../domain/types';
import { useAppStore } from '../store/appStore';
import { readyStore } from '../store/testing';
import { EXAMPLES, EXAMPLES_MISSING, EXAMPLES_PRESENT, example, examplesOf, schemaFiles } from '../test/contract/examples';
import { contractErrors } from '../test/contract/schema';
import type { WireBorehole, WireBoreholeList, WireDocumentList, WireError, WireUploadAccepted, WireValuePatch } from './adapters';
import { createApiSource, MAX_BACKOFF_MS, SPT_N_ONLY } from './apiSource';
import { ApiError, SaveError } from './errors';
import { MockXhr } from './testing';

const BASE = '/api/v1';
/** BoreholeRecord.full.json (revision 4), the record the ValuePatch examples target. */
const FULL = 'bh_01M54CB4HGT2NXJXQZD6BE0FGK';
/** Document.done.json: the document UploadAccepted.duplicate.json names. */
const DONE_DOC = 'doc_01M54AV7B076NM6GKCF4BXQMCH';

/** HTTP status of each error code (contracts/openapi.yaml responses). */
const STATUS: Record<string, number> = {
  validation_error: 422, route_not_found: 404, document_not_found: 404, page_not_found: 404, borehole_not_found: 404,
  path_not_found: 404, result_set_not_found: 404, clarification_not_found: 404, demo_mode: 409, too_large: 413,
  unsupported_type: 415, not_failed: 409, revision_conflict: 409, unparseable_value: 422, crs_invalid: 422,
  already_resolved: 409, answer_invalid: 422, chat_unavailable: 409, geocoder_unavailable: 503, rate_limited: 429,
  internal_error: 500,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (code: string) => json(STATUS[code], example<WireError>(`Error.${code}.json`));

interface Call { method: string; url: string; body?: Record<string, unknown>; form?: FormData }
type Route = (call: Call) => Response | Promise<Response> | undefined;

/** Writes a wire value at a provenance path (the backend's `edit`). */
function setAt(rec: WireBorehole, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = rec as unknown as Record<string, unknown>;
  parts.forEach((part, i) => {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(part) as RegExpExecArray;
    const last = i === parts.length - 1;
    if (m[2] === undefined) {
      if (last) cur[m[1]] = value;
      else cur = cur[m[1]] as Record<string, unknown>;
    } else {
      const list = cur[m[1]] as Record<string, unknown>[];
      if (last) (list as unknown[])[Number(m[2])] = value;
      else cur = list[Number(m[2])];
    }
  });
}

/**
 * A fictional backend made of the contract examples. Records: every BoreholeRecord example. The list:
 * BoreholeList.json, then (cursor "fictional-cursor-page-2") the remaining records. PATCH behaves like
 * the backend's review service: if_revision check, path check, the action, the next revision.
 */
function examplesBackend(route: Route = () => undefined) {
  const calls: Call[] = [];
  const records = new Map(examplesOf<WireBorehole>('BoreholeRecord').map(([, r]) => [r.uid, r]));
  const documents = example<WireDocumentList>('DocumentList.json').documents;
  const page1 = example<WireBoreholeList>('BoreholeList.json');
  const answer = async (call: Call): Promise<Response> => {
    const own = await route(call);
    if (own) return own;
    const path = call.url.slice(BASE.length);
    if (call.method === 'GET' && path === '/health') return json(200, example('Health.live.json'));
    if (call.method === 'GET' && path === '/documents') return json(200, { documents });
    if (call.method === 'GET' && path === '/boreholes?limit=5000') {
      return json(200, { ...page1, boreholes: page1.boreholes.map((b) => records.get(b.uid) ?? b) });
    }
    if (call.method === 'GET' && path === `/boreholes?limit=5000&cursor=${page1.next_cursor}`) {
      const rest = [...records.values()].filter((r) => !page1.boreholes.some((b) => b.uid === r.uid));
      return json(200, { count: page1.count, boreholes: rest, next_cursor: null });
    }
    let m = /^\/boreholes\/([^/?]+)(\/values)?$/.exec(path);
    if (m) {
      const rec = records.get(decodeURIComponent(m[1]));
      if (!rec) return apiError('borehole_not_found');
      if (call.method === 'GET') return json(200, rec);
      const body = (call.body ?? {}) as WireValuePatch;
      if (body.if_revision != null && body.if_revision !== rec.revision) return apiError('revision_conflict');
      const p = rec.provenance[body.path];
      if (!p) return apiError('path_not_found');
      if (body.action === 'approve') Object.assign(p, { status: 'approved', flag: null });
      if (body.action === 'flag') Object.assign(p, { status: 'flagged', flag: body.reason ?? null });
      if (body.action === 'reset') Object.assign(p, { status: 'unreviewed', flag: null });
      if (body.action === 'set_state') p.state = body.state as typeof p.state;
      if (body.action === 'edit') {
        setAt(rec, body.path, body.value);
        Object.assign(p, { method: 'edited', ...(body.value != null ? { state: 'ok' } : {}) });
      }
      rec.revision += 1;
      const statuses = Object.values(rec.provenance).map((x) => x.status);
      rec.review_status = statuses.every((s) => s === 'unreviewed') ? 'unreviewed' : statuses.every((s) => s === 'approved') ? 'approved' : 'in_review';
      return json(200, rec);
    }
    m = /^\/documents\/([^/?]+)(\/boreholes)?$/.exec(path);
    if (m && call.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const doc = documents.find((d) => d.document_id === id);
      if (!doc) return apiError('document_not_found');
      return json(200, m[2] ? [...records.values()].filter((r) => r.document_id === id) : doc);
    }
    return apiError('route_not_found');
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
const pdf = (name: string) => new File(['%PDF-1.7 fictional'], name, { type: 'application/pdf' });

let warn: MockInstance<typeof console.warn>;
/** The source's one-line summary of values without a provenance entry (examples before 1.1.0 have many). */
let info: MockInstance<typeof console.info>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  warn.mockRestore();
  info.mockRestore();
});

describe.skipIf(!EXAMPLES_PRESENT)(`API source on the backend examples${EXAMPLES_PRESENT ? '' : ` — skipped: ${EXAMPLES_MISSING}`}`, () => {
  describe('load', () => {
    it('follows next_cursor to the end and adapts every record and every document', async () => {
      const { calls } = examplesBackend();
      const { boreholes, documents } = await createApiSource(BASE).load();
      expect(calls.map((c) => c.url).sort()).toEqual([
        '/api/v1/boreholes?limit=5000', '/api/v1/boreholes?limit=5000&cursor=fictional-cursor-page-2', '/api/v1/documents',
      ]);
      const list = example<WireBoreholeList>('BoreholeList.json');
      expect(boreholes).toHaveLength(list.count);
      expect(new Set(boreholes.map((b) => b.uid)).size).toBe(list.count);
      expect(boreholes.slice(0, 2).map((b) => b.uid)).toEqual(list.boreholes.map((b) => b.uid));
      const wire = example<WireDocumentList>('DocumentList.json').documents;
      expect(documents.map((d) => [d.id, d.status, d.pages.length])).toEqual(wire.map((d) => [d.document_id, d.status, d.page_count ?? 0]));
      // A document in review opens its first borehole.
      const review = documents.find((d) => d.id === 'doc_01M54BPP80DBVM60TJD6V5NPM0');
      expect(review?.reviewBoreholeUid).toBe(boreholes.find((b) => b.documentId === review?.id)?.uid);
      // Sparse provenance is allowed: at most one summary line for the load, no warning per value.
      expect(warn).not.toHaveBeenCalled();
      expect(info.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe('review saves: the ValuePatch examples are what review actions send', () => {
    /** [example file, value key, the review action as a patch (built when the test runs, from the example)]. */
    const cases = (): [string, string, () => ValuePatch][] => [
      ['ValuePatch.approve.json', K.spt(2), () => ({ status: 'approved' })],
      ['ValuePatch.edit.json', K.bottom(3), () => ({ value: '9.80', method: 'Edited' })],
      ['ValuePatch.flag.json', 'stratigraphy[3].spt_refusal', () => ({ status: 'flagged', flag: example<WireValuePatch>('ValuePatch.flag.json').reason ?? undefined })],
      ['ValuePatch.reset.json', K.contractor, () => ({ status: 'unreviewed', flag: undefined })],
      ['ValuePatch.set_state.json', K.colour(4), () => ({ state: 'not in source' })],
    ];

    /** ValuePatch examples of contract features this frontend does not send yet, with the reason. */
    const NOT_SENT: Record<string, string> = {
      'ValuePatch.approve_confirmed_by.json': 'confirmed_by on a PATCH is contract 1.1.0; this frontend builds against 1.0.0',
    };

    it('covers every ValuePatch example', () => {
      const covered = [...cases().map(([file]) => file), ...Object.keys(NOT_SENT).filter((f) => f in EXAMPLES)];
      expect(covered.sort()).toEqual(schemaFiles().filter((f) => f.startsWith('ValuePatch.')));
    });

    it.each(cases())('%s (value %s)', async (file, key, build) => {
      const patch = build();
      const { calls } = examplesBackend();
      const api = createApiSource(BASE);
      await api.load();
      const saved = await api.updateValue(FULL, key, patch);
      expect(patches(calls)).toEqual([example<WireValuePatch>(file)]);
      expect(contractErrors('ValuePatch', patches(calls)[0])).toEqual([]);
      // The answer replaces the borehole: next revision, the value as the server holds it now.
      expect(saved.revision).toBe(5);
      const v = saved.values.find((x) => x.key === key);
      if (patch.status) expect(v?.status).toBe(patch.status);
      if (patch.state) expect(v?.state).toBe(patch.state);
      if (patch.value) expect(v).toMatchObject({ value: '9.80', method: 'Edited', aiValue: '9.50' });
    });

    it('two saves of one borehole fired at once run in order, each with the revision of the answer before', async () => {
      const { calls } = examplesBackend();
      const api = createApiSource(BASE);
      await api.load();
      const [a, b] = await Promise.all([
        api.updateValue(FULL, K.xy, { status: 'flagged', flag: 'check the easting' }),
        api.updateValue(FULL, K.bottom(3), { value: '9.8', method: 'Edited', status: 'approved' }),
      ]);
      expect(patches(calls)).toEqual([
        { path: 'metadata.coordinates.local_x', action: 'flag', reason: 'check the easting', if_revision: 4 },
        { path: 'metadata.coordinates.local_y', action: 'flag', reason: 'check the easting', if_revision: 5 },
        { path: 'stratigraphy[2].depth_to_m', action: 'edit', value: 9.8, if_revision: 6 },
        { path: 'stratigraphy[2].depth_to_m', action: 'approve', if_revision: 7 },
      ]);
      expect([a.revision, b.revision]).toEqual([6, 8]);
      expect(b.values.find((v) => v.key === K.xy)).toMatchObject({ status: 'flagged', flag: 'check the easting' });
      expect(b.layers[2].to).toBe(9.8);
    });

    it('a conflict refetches the record; the SaveError carries it, and the next save uses its revision', async () => {
      const { calls, records } = examplesBackend();
      const api = createApiSource(BASE);
      await api.load();
      (records.get(FULL) as WireBorehole).revision = 9;
      const failed = await api.updateValue(FULL, K.finalDepth, { status: 'unreviewed' }).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(SaveError);
      expect(failed).toMatchObject({ code: 'revision_conflict', message: example<WireError>('Error.revision_conflict.json').detail, current: { uid: FULL, revision: 9 } });
      await api.updateValue(FULL, K.finalDepth, { status: 'unreviewed' });
      expect(patches(calls).map((p) => p?.if_revision)).toEqual([4, 9]);
    });

    it('refuses a value without a provenance entry without sending anything', async () => {
      const { calls, records } = examplesBackend();
      // FHL-BH01's client as a backend with sparse provenance sends it: printed, without an entry.
      delete (records.get(FULL) as WireBorehole).provenance['metadata.client'];
      const api = createApiSource(BASE);
      await api.load();
      // One summary for the whole load, never a warning per value.
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0][0])).toMatch(/values? in \d+ boreholes? (has|have) no provenance entry/);
      expect(warn).not.toHaveBeenCalled();
      const failed = await api.updateValue(FULL, K.client, { status: 'approved' }).catch((e: unknown) => e);
      expect(failed).toMatchObject({ name: 'SaveError', current: { uid: FULL, revision: 4 } });
      expect(patches(calls)).toEqual([]);
    });

    it('DV-15: a text that is no whole N goes to spt_raw where the backend tracks it, else it is refused unsent', async () => {
      const { calls, records } = examplesBackend();
      const prov = (records.get(FULL) as WireBorehole).provenance;
      expect(Object.keys(prov)).toContain('stratigraphy[1].spt_n_value');
      // An example without the printed SPT text tracked: refused before sending.
      const raw = prov['stratigraphy[1].spt_raw'];
      delete prov['stratigraphy[1].spt_raw'];
      const api = createApiSource(BASE);
      await api.load();
      const refused = await api.updateValue(FULL, K.spt(2), { value: '50/12', method: 'Edited' }).catch((e: unknown) => e);
      expect(refused).toMatchObject({ name: 'SaveError', message: SPT_N_ONLY });
      expect(patches(calls)).toEqual([]);
      // With it tracked: the text goes there.
      prov['stratigraphy[1].spt_raw'] = raw ?? { ...prov['stratigraphy[1].spt_n_value'], method: 'read' };
      await api.getBorehole(FULL);
      const saved = await api.updateValue(FULL, K.spt(2), { value: '50/12', method: 'Edited' });
      expect(patches(calls)).toEqual([{ path: 'stratigraphy[1].spt_raw', action: 'edit', value: '50/12', if_revision: 4 }]);
      expect(contractErrors('ValuePatch', patches(calls)[0])).toEqual([]);
      expect(saved.layers[1].spt?.raw).toBe('50/12');
      await api.updateValue(FULL, K.spt(2), { value: 'N = 21', method: 'Edited' });
      expect(patches(calls).at(-1)).toEqual({ path: 'stratigraphy[1].spt_n_value', action: 'edit', value: 21, if_revision: 5 });
    });

    it('uiv-B7: the CRS code row of the approved example can be approved but not edited', async () => {
      const APPROVED = 'bh_01M54B3F0GBNJ9N3650KGFT5AE';
      const { calls } = examplesBackend();
      const api = createApiSource(BASE);
      await api.load();
      const failed = await api.updateValue(APPROVED, K.crs, { value: 'EPSG:4326', method: 'Edited' }).catch((e: unknown) => e);
      expect(failed).toMatchObject({ name: 'SaveError', message: 'Set the coordinate system with CHOOSE CRS…' });
      expect(patches(calls)).toEqual([]);
      await api.updateValue(APPROVED, K.crs, { status: 'unreviewed' });
      expect(patches(calls)).toEqual([{ path: 'metadata.coordinates.crs_code', action: 'reset', if_revision: 6 }]);
    });
  });

  describe('review through the store over the API source', () => {
    const shown = () => useAppStore.getState().boreholes.find((b) => b.uid === FULL);
    const value = (key: string) => shown()?.values.find((v) => v.key === key);

    it('two approvals clicked at once on one borehole go out in order; the store ends at the last answer', async () => {
      const { calls } = examplesBackend();
      await readyStore(createApiSource(BASE), FULL);
      useAppStore.getState().toggleApprove(K.locationName);
      useAppStore.getState().toggleApprove(K.endDate);
      await vi.waitFor(() => expect(shown()?.revision).toBe(6));
      expect(patches(calls)).toEqual([
        { path: 'metadata.location_name', action: 'approve', if_revision: 4 },
        { path: 'metadata.end_date', action: 'approve', if_revision: 5 },
      ]);
      expect([value(K.locationName)?.status, value(K.endDate)?.status]).toEqual(['approved', 'approved']);
      expect(useAppStore.getState().toast).toBeNull();
    });

    it('undo of an approval is reset; "not in source" sets the state and toggles back with set_state ok and reset', async () => {
      const { calls } = examplesBackend();
      await readyStore(createApiSource(BASE), FULL);
      useAppStore.getState().toggleApprove(K.boreholeId);
      await vi.waitFor(() => expect(shown()?.revision).toBe(5));
      useAppStore.getState().setState(K.colour(4), 'not in source');
      await vi.waitFor(() => expect(shown()?.revision).toBe(7));
      expect(value(K.colour(4))).toMatchObject({ state: 'not in source', status: 'approved' });
      useAppStore.getState().setState(K.colour(4), 'not in source');
      await vi.waitFor(() => expect(shown()?.revision).toBe(9));
      expect(patches(calls)).toEqual([
        { path: 'metadata.borehole_id', action: 'reset', if_revision: 4 },
        { path: 'stratigraphy[3].colour', action: 'set_state', state: 'not_in_source', if_revision: 5 },
        { path: 'stratigraphy[3].colour', action: 'approve', if_revision: 6 },
        { path: 'stratigraphy[3].colour', action: 'set_state', state: 'ok', if_revision: 7 },
        { path: 'stratigraphy[3].colour', action: 'reset', if_revision: 8 },
      ]);
      expect(value(K.boreholeId)?.status).toBe('unreviewed');
      expect(value(K.colour(4))).toMatchObject({ state: 'ok', status: 'unreviewed' });
    });

    it('approve all clean: dry-run count, then the approval, then the document boreholes are reloaded', async () => {
      const DOC = 'doc_01M54BPP80DBVM60TJD6V5NPM0';
      let approved = 0;
      const { calls, records } = examplesBackend((c) => {
        const m = /\/documents\/([^/]+)\/approve-clean\?dry_run=(true|false)$/.exec(c.url);
        if (!m || c.method !== 'POST') return undefined;
        // The backend's rule: unreviewed, state ok, no flag, no lint, read or OCR >= 0.9.
        let count = 0;
        for (const r of [...records.values()].filter((x) => x.document_id === m[1])) {
          const linted = new Set(r.lint.map((l) => l.path));
          const clean = Object.entries(r.provenance).filter(([path, p]) =>
            p.status === 'unreviewed' && p.state === 'ok' && !p.flag && !linted.has(path) && (p.method === 'read' || (p.method === 'ocr' && (p.confidence ?? 0) >= 0.9)));
          count += clean.length;
          if (m[2] === 'false' && clean.length) {
            for (const [, p] of clean) p.status = 'approved';
            r.revision += 1;
          }
        }
        if (m[2] === 'false') approved = count;
        return json(200, { count });
      });
      await readyStore(createApiSource(BASE), FULL);
      await useAppStore.getState().askClean();
      const counted = useAppStore.getState().cleanCount;
      expect(counted).toBeGreaterThan(0);
      await useAppStore.getState().approveClean();
      expect(approved).toBe(counted);
      expect(calls.map((c) => `${c.method} ${c.url}`).slice(-3)).toEqual([
        `POST ${BASE}/documents/${DOC}/approve-clean?dry_run=true`,
        `POST ${BASE}/documents/${DOC}/approve-clean?dry_run=false`,
        `GET ${BASE}/documents/${DOC}/boreholes`,
      ]);
      expect(patches(calls)).toEqual([]);
      expect(shown()?.revision).toBe(5);
      expect(value(K.locationName)?.status).toBe('approved');
      expect(useAppStore.getState().toast?.text).toBe(`${counted} clean value${counted === 1 ? '' : 's'} approved`);
    });

    it('confirming the swapped reading of a CRS sends swap_axes and reloads the document boreholes', async () => {
      const DOC = 'doc_01M54CCNC0Q4F0EZR24EA9NNGS';
      const B12 = 'bh_01M54CX9K86N0N3D5HSA8R6AQ7';
      const { calls } = examplesBackend((c) => {
        if (c.url.endsWith(`/documents/${DOC}/crs-candidates`)) return json(200, example('CrsCandidate.list.json'));
        if (c.url.endsWith(`/documents/${DOC}/crs`)) return json(200, { updated: 1 });
        return undefined;
      });
      await readyStore(createApiSource(BASE), B12);
      useAppStore.setState({ reviewerName: 'A. Reviewer (fictional)' });
      await useAppStore.getState().openCrsDialog();
      useAppStore.getState().pickCrs(1);
      await useAppStore.getState().confirmCrs();
      const post = calls.find((c) => c.url.endsWith('/crs'));
      expect(post?.body).toEqual({ crs: 'EPSG:27700', swap_axes: true, confirmed_by: 'A. Reviewer (fictional)', note: null });
      expect(contractErrors('CrsConfirmRequest', post?.body)).toEqual([]);
      expect(calls.at(-1)).toMatchObject({ method: 'GET', url: `${BASE}/documents/${DOC}/boreholes` });
      expect(useAppStore.getState().toast?.text).toBe('CRS confirmed for 1 borehole in this report: OSGB36 / British National Grid (axes swapped)');
    });

    it('an inline edit sends the typed number, then the approval; the layer follows the server', async () => {
      const { calls } = examplesBackend();
      await readyStore(createApiSource(BASE), FULL);
      const s = useAppStore.getState();
      s.startEdit(K.bottom(3), 'edit');
      useAppStore.getState().setEditText('9,80');
      useAppStore.getState().saveEdit();
      await vi.waitFor(() => expect(shown()?.revision).toBe(6));
      expect(patches(calls)).toEqual([
        { path: 'stratigraphy[2].depth_to_m', action: 'edit', value: 9.8, if_revision: 4 },
        { path: 'stratigraphy[2].depth_to_m', action: 'approve', if_revision: 5 },
      ]);
      expect(value(K.bottom(3))).toMatchObject({ value: '9.80', aiValue: '9.50', method: 'Edited', status: 'approved' });
      expect(shown()?.layers[2].to).toBe(9.8);
    });
  });

  describe('errors: every Error.<code>.json through the request', () => {
    const codes = schemaFiles().filter((f) => f.startsWith('Error.')).map((f) => f.split('.')[1]);

    it('has a status for every code', () => {
      expect(codes.filter((c) => !(c in STATUS))).toEqual([]);
    });

    it.each(codes)('%s becomes an ApiError with that code and the detail as message', async (code) => {
      const body = example<WireError>(`Error.${code}.json`);
      vi.stubGlobal('fetch', vi.fn(async () => json(STATUS[code], body)));
      const e = await createApiSource(BASE).getDocument('doc_FICT').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({ code, status: STATUS[code], detail: body.detail, errors: body.errors ?? [] });
      expect((e as ApiError).message).toBe(
        code === 'route_not_found' ? 'Backend endpoint not available: GET /api/v1/documents/doc_FICT' : body.detail,
      );
    });

    it('a 204 answer resolves without a body', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
      await expect(createApiSource(BASE).retry('doc_FICT')).resolves.toBeUndefined();
    });
  });

  describe('health, CRS candidates and retry', () => {
    it.each(examplesOf<unknown>('Health'))('%s through GET /api/v1/health', async (_, h) => {
      vi.stubGlobal('fetch', vi.fn(async () => json(200, h)));
      const health = await createApiSource(BASE).health();
      const wire = h as { mode: string; providers: object; upload: { max_mb: number; extensions: string[] } };
      expect(health).toMatchObject({ mode: wire.mode, providers: wire.providers, upload: { maxMb: wire.upload.max_mb, extensions: wire.upload.extensions } });
    });

    it('CrsCandidate.list keeps both readings of EPSG:27700 (axes as printed and swapped)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(200, example('CrsCandidate.list.json'))));
      const list = await createApiSource(BASE).crsCandidates('doc_01M54CCNC0Q4F0EZR24EA9NNGS');
      expect(list.map((c) => [c.code, c.swapAxes, c.verdict])).toEqual([
        ['EPSG:27700', false, 'match'], ['EPSG:27700', true, 'shifted'], ['EPSG:25830', false, 'out_of_range'],
      ]);
    });

    it('UploadAccepted.retried answers a retry', async () => {
      const { calls } = examplesBackend((c) => (c.url.endsWith('/retry') ? json(202, example('UploadAccepted.retried.json')) : undefined));
      await expect(createApiSource(BASE).retry('doc_01M54CVA401HDG3EBKKP6FGY4K')).resolves.toBeUndefined();
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/v1/documents/doc_01M54CVA401HDG3EBKKP6FGY4K/retry']);
    });
  });

  describe('uploads (XMLHttpRequest)', () => {
    beforeEach(() => {
      MockXhr.reset();
      vi.stubGlobal('XMLHttpRequest', MockXhr);
    });

    it('UploadAccepted.queued: a new document named after the file, not a duplicate', async () => {
      const accepted = example<WireUploadAccepted>('UploadAccepted.queued.json');
      const handle = createApiSource(BASE).upload(pdf('fictional-new-log.pdf'), { project: 'Fictional Harbour Link' });
      expect(MockXhr.last.form.get('project')).toBe('Fictional Harbour Link');
      MockXhr.last.respondJson(202, accepted);
      const { document, duplicate } = await handle.done;
      expect(duplicate).toBe(false);
      expect(document).toMatchObject({
        id: accepted.document_id, name: 'fictional-new-log.pdf', status: accepted.status, uploaded: true, duplicateOf: null, project: 'Fictional Harbour Link',
      });
      expect(document.uploadedAgain).toBeUndefined();
    });

    it('UploadAccepted.duplicate: the answer is the earlier document as loaded, never "a duplicate of itself"', async () => {
      const accepted = example<WireUploadAccepted>('UploadAccepted.duplicate.json');
      expect(accepted.duplicate_of).toBe(accepted.document_id);
      examplesBackend();
      const api = createApiSource(BASE);
      await api.load();
      const handle = api.upload(pdf('copy-of-fictional-vector-log.pdf'), { project: null });
      MockXhr.last.respondJson(200, accepted);
      const { document, duplicate } = await handle.done;
      expect(duplicate).toBe(true);
      expect(document.id).toBe(DONE_DOC);
      expect(document.duplicateOf, 'a document is never a duplicate of itself').not.toBe(document.id);
      // The earlier document as the source knows it: its name, pages and counts are not blanked.
      expect(document).toMatchObject({ name: 'fictional-vector-log.pdf', status: 'done', counts: { boreholes: 1 }, uploadedAgain: true });
      expect(document.pages).toHaveLength(2);
    });

    it('UploadAccepted.duplicate before the document was loaded: the earlier document is fetched once', async () => {
      const accepted = example<WireUploadAccepted>('UploadAccepted.duplicate.json');
      const { calls } = examplesBackend();
      const handle = createApiSource(BASE).upload(pdf('copy-of-fictional-vector-log.pdf'), { project: null });
      MockXhr.last.respondJson(200, accepted);
      await expect(handle.done).resolves.toMatchObject({
        duplicate: true, document: { id: DONE_DOC, name: 'fictional-vector-log.pdf', status: 'done', duplicateOf: null, uploadedAgain: true },
      });
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET /api/v1/documents/${DONE_DOC}`]);
    });

    it.each(['demo_mode', 'too_large', 'unsupported_type', 'validation_error'])('Error.%s.json answers the upload as an ApiError with that code', async (code) => {
      const body = example<WireError>(`Error.${code}.json`);
      const handle = createApiSource(BASE).upload(pdf('a.pdf'), { project: null });
      MockXhr.last.respondJson(STATUS[code], body);
      const e = await handle.done.catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({ code, status: STATUS[code], detail: body.detail, message: body.detail, errors: body.errors ?? [] });
    });
  });

  describe('following a document (polling fallback, no EventSource)', () => {
    it('a document the backend no longer has (deleted meanwhile) becomes document.deleted and is no longer followed', async () => {
      vi.useFakeTimers();
      const gone = 'doc_01M54JJDG0JCBXQ9XZPN88864Y';
      const { calls } = examplesBackend((c) => (c.url.endsWith(`/documents/${gone}`) ? apiError('document_not_found') : undefined));
      const api = createApiSource(BASE);
      api.follow(gone);
      const events: LiveEvent[] = [];
      const unsubscribe = api.subscribe((e) => events.push(e), () => undefined);
      await vi.advanceTimersByTimeAsync(20 * MAX_BACKOFF_MS);
      expect(calls).toHaveLength(1);
      expect(events).toEqual([{ type: 'document.deleted', documentId: gone }]);
      expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/doc_01M54JJDG0JCBXQ9XZPN88864Y.*no longer/);
      unsubscribe();
    });

    it('a document deleted meanwhile can be followed again once it exists (a later follow is not ignored)', async () => {
      vi.useFakeTimers();
      let gone = true;
      const { calls } = examplesBackend((c) => (gone && c.url.endsWith(`/documents/${DONE_DOC}`) ? apiError('document_not_found') : undefined));
      const api = createApiSource(BASE);
      const events: LiveEvent[] = [];
      const unsubscribe = api.subscribe((e) => events.push(e), () => undefined);
      api.follow(DONE_DOC);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      gone = false;
      api.follow(DONE_DOC);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
      expect(events.map((e) => e.type)).toEqual(['document.deleted', 'document.updated']);
      expect(events[1]).toMatchObject({ document: { id: DONE_DOC, status: 'done' } });
      // Done: a terminal status, so it is no longer followed.
      await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF_MS);
      expect(calls).toHaveLength(2);
      unsubscribe();
    });
  });
});
