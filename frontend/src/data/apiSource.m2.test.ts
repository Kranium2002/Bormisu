/**
 * The M2 calls of the API source against a fictional backend (fetch mocked, payloads from
 * src/test/contract): the boot load without the full records, the map layer, the "Not on map" list,
 * result sets, place search and clarification questions, with every error code these calls answer.
 * Nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { K } from '../domain/keys';
import type { BoreholeFilter } from '../domain/types';
import { contractErrors } from '../test/contract/schema';
import { fixture } from '../test/contract/wire';
import type {
  WireBorehole,
  WireBoreholeList,
  WireClarification,
  WireDocument,
  WireDocumentList,
  WireError,
  WireFeatureCollection,
  WireResultSet,
} from './adapters';
import { createApiSource } from './apiSource';
import { ApiError, UnreachableError } from './errors';

const BASE = '/api/v1';
const D1 = 'doc_01JFICT0000000000000000D1';
const D2 = 'doc_01JFICT0000000000000000D2';
const D7 = 'doc_01JFICT0000000000000000D7';
const HL01 = 'bh_01JFICT00000000000000HL01';
const HL02 = 'bh_01JFICT00000000000000HL02';
const RS = 'rs_01JFICT000000000000000RS01';
const CRS_Q = 'cl_01JFICT00000000000000CRS1';
const ANSWERED_Q = 'cl_01JFICT00000000000000DU01';

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const errorBody = (code: string) => fixture<WireError[]>('errors').find((e) => e.code === code) as WireError;
const apiError = (status: number, code: string) => json(status, errorBody(code));

/** A filter with every field unset. */
const EMPTY: BoreholeFilter = {
  search: null, country: null, project: null, documentId: null, minDepth: null, maxDepth: null, dinCodes: [],
  lithologyMinDepth: null, hasSpt: null, hasGroundwater: null, reviewStatus: [], includeUnreviewed: false, area: null,
};

interface Call { method: string; url: string; body?: Record<string, unknown>; hasBody: boolean }
type Route = (call: Call) => Response | Promise<Response> | undefined;

/**
 * A fictional backend. Records: the borehole fixtures (plotted ones in boreholes-page-*, unplotted ones
 * in boreholes-cases). The map layer is map-features.json; the "Not on map" list is the unplotted
 * cases, two per page. Clarifications are clarifications.json, answered and skipped like the backend
 * does (required fields, already answered).
 */
function backend(route: Route = () => undefined) {
  const calls: Call[] = [];
  const records = new Map<string, WireBorehole>(
    [
      ...fixture<WireBoreholeList>('boreholes-page-1').boreholes,
      ...fixture<WireBoreholeList>('boreholes-page-2').boreholes,
      ...fixture<WireBorehole[]>('boreholes-cases'),
    ].map((r) => [r.uid, r]),
  );
  const unplotted = [...records.values()].filter((r) => !r.plotted);
  const questions = new Map(fixture<WireClarification[]>('clarifications').map((c) => [c.clarification_id, c]));
  const documents = fixture<WireDocumentList>('documents').documents;
  const features = fixture<WireFeatureCollection>('map-features');
  const answer = async (call: Call): Promise<Response> => {
    const own = await route(call);
    if (own) return own;
    const url = new URL(call.url, 'http://fictional.test');
    const path = url.pathname.slice(BASE.length);
    const q = url.searchParams;
    if (call.method === 'GET' && path === '/documents') return json(200, { documents });
    if (call.method === 'GET' && path === '/map/boreholes.geojson') {
      const doc = q.get('document_id');
      return json(200, { ...features, features: features.features.filter((f) => !doc || f.properties.document_id === doc) }, 'application/geo+json');
    }
    if (call.method === 'GET' && path === '/boreholes' && q.get('plotted') === 'false') {
      const second = q.get('cursor') === 'cur_FICT_unplotted2';
      return json(200, {
        count: unplotted.length, boreholes: second ? unplotted.slice(2) : unplotted.slice(0, 2), next_cursor: second ? null : 'cur_FICT_unplotted2',
      });
    }
    let m = /^\/boreholes\/([^/]+)$/.exec(path);
    if (m && call.method === 'GET') {
      const rec = records.get(decodeURIComponent(m[1]));
      return rec ? json(200, rec) : apiError(404, 'borehole_not_found');
    }
    m = /^\/boreholes\/([^/]+)\/values$/.exec(path);
    if (m && call.method === 'PATCH') {
      const rec = records.get(decodeURIComponent(m[1])) as WireBorehole;
      if (call.body?.if_revision !== rec.revision) return apiError(409, 'revision_conflict');
      rec.revision += 1;
      return json(200, rec);
    }
    if (call.method === 'POST' && path === '/result-sets') return json(201, fixture('result-set'));
    m = /^\/result-sets\/([^/]+)(\/geojson)?$/.exec(path);
    if (m && call.method === 'GET') {
      if (decodeURIComponent(m[1]) !== RS) return apiError(404, 'result_set_not_found');
      if (!m[2]) return json(200, fixture('result-set'));
      return json(200, { ...features, features: features.features.filter((f) => [HL01, HL02].includes(f.properties.uid)) }, 'application/geo+json');
    }
    if (call.method === 'GET' && path === '/geocode') return json(200, /harbour/i.test(q.get('q') ?? '') ? fixture('places') : []);
    if (call.method === 'GET' && path === '/clarifications') {
      const status = q.get('status') ?? 'open';
      const doc = q.get('document_id');
      return json(200, [...questions.values()].filter((c) => c.status === status && (!doc || c.document_id === doc)));
    }
    m = /^\/clarifications\/([^/]+)\/(answer|skip)$/.exec(path);
    if (m && call.method === 'POST') {
      const c = questions.get(decodeURIComponent(m[1]));
      if (!c) return apiError(404, 'clarification_not_found');
      if (c.status === 'answered') return apiError(409, 'already_resolved');
      if (m[2] === 'skip') {
        c.status = 'skipped';
        return json(200, c);
      }
      const values = (call.body?.values ?? {}) as Record<string, unknown>;
      const missing = c.fields.filter((f) => f.required && (values[f.name] == null || values[f.name] === ''));
      if (missing.length) {
        return json(422, {
          detail: "The answer does not match the question's fields.", code: 'answer_invalid',
          errors: missing.map((f) => ({ loc: ['body', 'values', f.name], msg: `${f.label} is required.` })),
        });
      }
      Object.assign(c, { status: 'answered', answer: values, answered_by: call.body?.answered_by ?? null, resolved_at: '2026-10-17T10:00:00Z' });
      return json(200, c);
    }
    return apiError(404, 'route_not_found');
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: Call = { method: init?.method ?? 'GET', url, body, hasBody: init?.body != null };
    calls.push(call);
    return answer(call);
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, records, questions, documents };
}

const urls = (calls: Call[]) => calls.map((c) => `${c.method} ${c.url}`);

let info: MockInstance<typeof console.info>;
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  info.mockRestore();
  warn.mockRestore();
});

describe('load: documents, the map layer and the unplotted records', () => {
  it('asks for the documents, the light map layer and the "Not on map" list (following next_cursor), never for every record', async () => {
    const { calls } = backend();
    const { documents, features, unplotted } = await createApiSource(BASE).load();
    expect(urls(calls).sort()).toEqual([
      'GET /api/v1/boreholes?plotted=false&limit=5000',
      'GET /api/v1/boreholes?plotted=false&limit=5000&cursor=cur_FICT_unplotted2',
      'GET /api/v1/documents',
      'GET /api/v1/map/boreholes.geojson',
    ]);
    expect(features.map((f) => f.id)).toEqual(['HL-01', 'HL-02', 'KR-01', 'TQ-01', 'MP-01']);
    expect(unplotted.map((b) => [b.id, b.onMap, b.unplottedReason, b.lat, b.lng])).toEqual([
      ['TQ-02', false, 'no_coordinates', null, null],
      ['SP-01', false, 'crs_unknown', null, null],
      ['SP-02', false, 'crs_unconfirmed', null, null],
      ['OS-01', false, 'implausible', 0.0004, 0.0002],
    ]);
    expect(documents.map((d) => d.id)).toEqual(fixture<WireDocumentList>('documents').documents.map((d) => d.document_id));
  });

  it("keeps each document's project and opens Review on its first borehole, from the features or the unplotted list", async () => {
    const lagoa: WireDocument = { ...fixture<WireDocument>('document'), document_id: D7, file_name: 'lagoa_azul_logs.pdf', project: null };
    backend((c) => (c.url === `${BASE}/documents` ? json(200, { documents: [...fixture<WireDocumentList>('documents').documents, lagoa] }) : undefined));
    const { documents } = await createApiSource(BASE).load();
    const byId = new Map(documents.map((d) => [d.id, d]));
    expect(byId.get(D1)).toMatchObject({ project: 'Harbourline Tunnel (fictional)', reviewBoreholeUid: HL01 });
    // Still extracting: no review borehole yet; no project of its own, so its borehole's.
    expect(byId.get(D2)).toMatchObject({ project: 'Kestrel Ridge Bypass (fictional)', reviewBoreholeUid: null });
    // Only unplotted boreholes: the first of them, with its project.
    expect(byId.get(D7)).toMatchObject({ project: 'Lagoa Azul Metro (fictional)', reviewBoreholeUid: 'bh_01JFICT00000000000000LA01' });
  });

  it('an empty backend is no documents, no features, nothing unplotted', async () => {
    backend((c) => {
      if (c.url.includes('/map/')) return json(200, { type: 'FeatureCollection', features: [] }, 'application/geo+json');
      if (c.url.includes('/boreholes')) return json(200, { count: 0, boreholes: [], next_cursor: null });
      return json(200, { documents: [] });
    });
    await expect(createApiSource(BASE).load()).resolves.toEqual({ documents: [], features: [], unplotted: [] });
  });

  it('stops paging the unplotted list when the server repeats a cursor', async () => {
    const { calls } = backend((c) => (c.url.includes('plotted=false') ? json(200, { count: 1, boreholes: [], next_cursor: 'same' }) : undefined));
    await createApiSource(BASE).load();
    expect(calls.filter((c) => c.url.includes('plotted=false'))).toHaveLength(2);
  });

  it('names the endpoint when the map layer is missing (route_not_found)', async () => {
    backend((c) => (c.url.includes('/map/') ? apiError(404, 'route_not_found') : undefined));
    await expect(createApiSource(BASE).load()).rejects.toThrow('Backend endpoint not available: GET /api/v1/map/boreholes.geojson');
  });

  it('reports values without a provenance entry of the unplotted records in one console.info', async () => {
    const { records } = backend();
    delete (records.get('bh_01JFICT00000000000000TQ02') as WireBorehole).provenance['metadata.borehole_id'];
    await createApiSource(BASE).load();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/^1 value in 1 borehole has no provenance entry/);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('map layer and "Not on map" list', () => {
  it('mapFeatures() reads the whole layer; with a document only that document', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await expect(api.mapFeatures()).resolves.toHaveLength(5);
    const own = await api.mapFeatures(D1);
    expect(own.map((f) => f.uid)).toEqual([HL01, HL02]);
    expect(urls(calls)).toEqual(['GET /api/v1/map/boreholes.geojson', `GET /api/v1/map/boreholes.geojson?document_id=${D1}`]);
  });

  it('leaves features it cannot represent out, with one console.info', async () => {
    backend((c) => {
      if (!c.url.includes('/map/')) return undefined;
      const fc = fixture<WireFeatureCollection>('map-features');
      fc.features[1].properties.review_status = 'reviewed';
      return json(200, fc, 'application/geo+json');
    });
    const features = await createApiSource(BASE).mapFeatures();
    expect(features.map((f) => f.id)).toEqual(['HL-01', 'KR-01', 'TQ-01', 'MP-01']);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('unplotted() follows next_cursor and caches the records, so a save needs no extra fetch', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    const list = await api.unplotted();
    expect(list.map((b) => b.id)).toEqual(['TQ-02', 'SP-01', 'SP-02', 'OS-01']);
    await api.updateValue('bh_01JFICT00000000000000TQ02', K.boreholeId, { status: 'approved' });
    expect(urls(calls).filter((u) => u.startsWith('GET /api/v1/boreholes/'))).toEqual([]);
  });

  it('a save of a record not fetched yet fetches it first (records are loaded on demand)', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    const saved = await api.updateValue(HL01, K.boreholeId, { status: 'approved' });
    expect(urls(calls)).toEqual([`GET /api/v1/boreholes/${HL01}`, `PATCH /api/v1/boreholes/${HL01}/values`]);
    expect(calls[1].body).toMatchObject({ path: 'metadata.borehole_id', action: 'approve', if_revision: 4 });
    expect(saved.revision).toBe(5);
    await expect(api.updateValue('bh_unknown', K.boreholeId, { status: 'approved' })).rejects.toMatchObject({
      name: 'SaveError', code: 'borehole_not_found', current: null,
    });
  });
});

describe('result sets', () => {
  it('createResultSet POSTs the filter as the contract has it (201) and resolves the stored set', async () => {
    const { calls } = backend();
    const filter: BoreholeFilter = { ...EMPTY, minDepth: 5, includeUnreviewed: true, area: { type: 'bbox', bbox: [174.7, -36.9, 174.8, -36.8] } };
    const rs = await createApiSource(BASE).createResultSet(filter);
    expect(urls(calls)).toEqual(['POST /api/v1/result-sets']);
    expect(calls[0].body).toEqual({ min_depth_m: 5, include_unreviewed: true, area: { type: 'bbox', bbox: [174.7, -36.9, 174.8, -36.8] } });
    expect(contractErrors('BoreholeFilter', calls[0].body)).toEqual([]);
    expect(rs).toMatchObject({ id: RS, count: 3, locatedCount: 2, unlocatedCount: 1, excludedUnreviewed: 0, definition: { minDepth: 5 } });
  });

  it('an invalid filter is a validation_error with its field errors', async () => {
    backend((c) => (c.url.endsWith('/result-sets') ? apiError(422, 'validation_error') : undefined));
    const e = await createApiSource(BASE).createResultSet(EMPTY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: 'validation_error', errors: [{ loc: ['body', 'path'], msg: 'Field required' }] });
  });

  it('getResultSet reads a stored set; an unknown or expired id is result_set_not_found', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    await expect(api.getResultSet(RS)).resolves.toMatchObject({ id: RS, uids: [HL01, HL02, 'bh_01JFICT00000000000000TQ02'] });
    const e = await api.getResultSet('rs_gone').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 404, code: 'result_set_not_found', message: 'Result set not found or expired.' });
    expect(urls(calls)).toEqual([`GET /api/v1/result-sets/${RS}`, 'GET /api/v1/result-sets/rs_gone']);
  });

  it('resultSetFeatures reads the plotted members as features', async () => {
    const { calls } = backend();
    const features = await createApiSource(BASE).resultSetFeatures(RS);
    expect(features.map((f) => f.uid)).toEqual([HL01, HL02]);
    expect(urls(calls)).toEqual([`GET /api/v1/result-sets/${RS}/geojson`]);
  });
});

describe('place search (GET /geocode, on submit only)', () => {
  it('sends the typed query, encoded and trimmed, and keeps the server order (uploaded places first)', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    const places = await api.geocode('  Harbour & Quay  ');
    expect(urls(calls)).toEqual([`GET /api/v1/geocode?q=${encodeURIComponent('Harbour & Quay')}`]);
    expect(places.map((p) => [p.source, p.boreholeCount])).toEqual([['uploaded', 2], ['geocoder', 2], ['geocoder', 0], ['geocoder', null]]);
    expect(places[0]).toMatchObject({ lat: -36.8446, lng: 174.7691 });
  });

  it('an unknown place is an empty list', async () => {
    backend();
    await expect(createApiSource(BASE).geocode('Nowhere at all')).resolves.toEqual([]);
  });

  it('503 geocoder_unavailable is an ApiError with that code, not an unreachable backend', async () => {
    backend((c) => (c.url.includes('/geocode') ? apiError(503, 'geocoder_unavailable') : undefined));
    const e = await createApiSource(BASE).geocode('Harbourville').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).not.toBeInstanceOf(UnreachableError);
    expect(e).toMatchObject({ status: 503, code: 'geocoder_unavailable', message: 'Place search is unavailable right now. Try again later.' });
  });
});

describe('clarifications', () => {
  it('lists the open questions by default, oldest first, as the server sends them', async () => {
    const { calls } = backend();
    const list = await createApiSource(BASE).clarifications();
    expect(urls(calls)).toEqual(['GET /api/v1/clarifications']);
    expect(list.map((c) => [c.kind, c.status])).toEqual([
      ['crs_confirm', 'open'], ['choose_reading', 'open'], ['locate_borehole', 'open'], ['borehole_boundary', 'open'], ['datum_convention', 'open'],
    ]);
  });

  it('asks for a status and a document when given', async () => {
    const { calls } = backend();
    const list = await createApiSource(BASE).clarifications({ status: 'skipped', documentId: D1 });
    expect(urls(calls)).toEqual([`GET /api/v1/clarifications?status=skipped&document_id=${D1}`]);
    expect(list.map((c) => [c.kind, c.status])).toEqual([['unit_ambiguous', 'skipped']]);
  });

  it('answers with {values, answered_by} and resolves the answered question', async () => {
    const { calls } = backend();
    const values = { crs: 'EPSG:31983', swap_axes: false };
    const answered = await createApiSource(BASE).answerClarification(CRS_Q, values, 'A. Reviewer (fictional)');
    expect(urls(calls)).toEqual([`POST /api/v1/clarifications/${CRS_Q}/answer`]);
    expect(calls[0].body).toEqual({ values, answered_by: 'A. Reviewer (fictional)' });
    expect(contractErrors('ClarificationAnswer', calls[0].body)).toEqual([]);
    expect(answered).toMatchObject({ id: CRS_Q, status: 'answered', answer: values, answeredBy: 'A. Reviewer (fictional)', resolvedAt: '2026-10-17T10:00:00Z' });
  });

  it('sends answered_by null without a reviewer name', async () => {
    const { calls } = backend();
    await createApiSource(BASE).answerClarification(CRS_Q, { crs: 'EPSG:29193' }, null);
    expect(calls[0].body).toEqual({ values: { crs: 'EPSG:29193' }, answered_by: null });
  });

  it('422 answer_invalid keeps its field errors', async () => {
    backend();
    const e = await createApiSource(BASE).answerClarification(CRS_Q, { swap_axes: true }, null).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({
      status: 422, code: 'answer_invalid', detail: "The answer does not match the question's fields.",
      errors: [{ loc: ['body', 'values', 'crs'], msg: 'Coordinate system is required.' }],
    });
  });

  it('422 validation_error keeps its field errors too', async () => {
    backend((c) => (c.url.endsWith('/answer') ? apiError(422, 'validation_error') : undefined));
    const e = await createApiSource(BASE).answerClarification(CRS_Q, {}, null).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'validation_error', errors: [{ loc: ['body', 'path'], msg: 'Field required' }] });
  });

  it('409 already_resolved and 404 clarification_not_found are ApiErrors with those codes', async () => {
    backend();
    const api = createApiSource(BASE);
    await expect(api.answerClarification(ANSWERED_Q, { same_log: false }, null)).rejects.toMatchObject({
      name: 'ApiError', status: 409, code: 'already_resolved',
    });
    await expect(api.skipClarification(ANSWERED_Q)).rejects.toMatchObject({ status: 409, code: 'already_resolved' });
    await expect(api.answerClarification('cl_unknown', {}, null)).rejects.toMatchObject({ status: 404, code: 'clarification_not_found' });
  });

  it('skip POSTs without a body and resolves the skipped question, which can still be answered', async () => {
    const { calls } = backend();
    const api = createApiSource(BASE);
    const skipped = await api.skipClarification(CRS_Q);
    expect(urls(calls)).toEqual([`POST /api/v1/clarifications/${CRS_Q}/skip`]);
    expect(calls[0].hasBody).toBe(false);
    expect(skipped).toMatchObject({ id: CRS_Q, status: 'skipped' });
    await expect(api.answerClarification(CRS_Q, { crs: 'EPSG:31983' }, null)).resolves.toMatchObject({ status: 'answered' });
  });

  it('leaves questions it cannot show out of a list, with one console.info', async () => {
    backend((c) => {
      if (!c.url.includes('/clarifications')) return undefined;
      const list = fixture<WireClarification[]>('clarifications').filter((x) => x.status === 'open');
      (list[0] as { kind: string }).kind = 'mystery';
      return json(200, list);
    });
    const list = await createApiSource(BASE).clarifications();
    expect(list).toHaveLength(4);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('an answer the client cannot show fails instead of resolving with an invented question', async () => {
    backend((c) => (c.url.endsWith('/skip') ? json(200, { ...fixture<WireClarification[]>('clarifications')[0], kind: 'mystery' }) : undefined));
    await expect(createApiSource(BASE).skipClarification(CRS_Q)).rejects.toThrow(/can't show/);
  });
});

describe('result set and clarification bodies are contract-valid', () => {
  it('the fixtures the fake backend answers with validate', () => {
    expect(contractErrors('ResultSet', fixture<WireResultSet>('result-set'))).toEqual([]);
    expect(contractErrors('array:Clarification', fixture('clarifications'))).toEqual([]);
  });
});
