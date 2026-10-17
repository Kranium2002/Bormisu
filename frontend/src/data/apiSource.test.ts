/** API mode must fail with a clear message when there is no (or the wrong) backend, and never fall back to sample data. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { K } from '../domain/keys';
import type { ApiBoreholeRecord, ApiDocument } from './adapters';
import { makeBorehole } from '../test/fixtures';
import { createApiSource, EndpointMissingError, uniqueUids, unreachableMessage } from './apiSource';
import { PartialSaveError } from './DataSource';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('apiSource without a working backend', () => {
  it('reports an unreachable backend when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow(unreachableMessage('/api/v1'));
  });

  it('reports an unreachable backend when the dev server answers with its HTML page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow(unreachableMessage('/api/v1'));
  });

  it('reports an unreachable backend on a proxy error without a JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow(unreachableMessage('/api/v1'));
  });

  it('names the missing endpoint when another server answers 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { detail: 'Not Found' })));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow(/^Backend endpoint not available: GET \/api\/v1\//);
  });

  it('passes a backend error detail through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { detail: 'database locked' })));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow('database locked');
  });

  // int-08: a route that exists for another method answers 405, which also means "not there yet".
  it('names the missing endpoint when the server answers 405', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(405, { detail: 'Method Not Allowed' })));
    const loading = createApiSource('/api/v1').load();
    await expect(loading).rejects.toBeInstanceOf(EndpointMissingError);
    await expect(loading).rejects.toThrow(/^Backend endpoint not available: GET \/api\/v1\/boreholes$/);
  });

  // int-09: FastAPI validation errors came through as a JSON dump.
  it('reads a validation error list as "field: message"', async () => {
    const detail = [
      { loc: ['body', 'value'], msg: 'Input should be a valid number', type: 'float_parsing' },
      { loc: ['body', 'action'], msg: "Input should be 'edit' or 'approve'", type: 'literal_error' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => json(422, { detail })));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow(
      "value: Input should be a valid number; action: Input should be 'edit' or 'approve'",
    );
  });

  it('keeps any other detail shape as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { detail: { code: 7 } })));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow('{"code":7}');
  });

  it('loads an empty backend as no boreholes and no documents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('/boreholes') ? json(200, { count: 0, boreholes: [] }) : json(200, []))),
    );
    await expect(createApiSource('/api/v1').load()).resolves.toEqual({ boreholes: [], documents: [] });
  });
});

/**
 * A fictional backend with one borehole in one document (or `records`); `patch` answers PATCH
 * requests, `documents: false` leaves out the documents endpoint.
 */
function backend(
  o: {
    status?: ApiDocument['status'];
    patch?: (body: Record<string, unknown>, url: string) => Response | Promise<Response>;
    records?: ApiBoreholeRecord[];
    documents?: false;
  } = {},
) {
  const record: ApiBoreholeRecord = {
    uid: 'd1:TB-01', document_id: 'd1',
    metadata: { borehole_id: 'TB-01', borehole_depth_m: 6 },
    stratigraphy: [{ depth_from_m: 0, depth_to_m: 6 }],
    lint: [{ path: 'stratigraphy[0].depth_to_m', severity: 'warning', message: 'Log bottom 6.0 m = final depth?' }],
  };
  const records = o.records ?? [record];
  const document: ApiDocument = {
    document_id: 'd1', file_name: 'test_report.pdf', status: o.status ?? 'needs_review',
    completeness: { expected_ids: ['TB-01'], found_ids: ['TB-01'], missing: [], unexpected: [] },
  };
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });
    if (method === 'PATCH') return (await o.patch?.(body ?? {}, url)) ?? json(200, record);
    if (url.endsWith('/boreholes')) return json(200, { count: records.length, boreholes: records });
    if (url.endsWith('/documents') && o.documents !== false) return json(200, [document]);
    if (url.endsWith('/documents/d1')) return json(200, { ...document, status: 'needs_review' });
    return json(404, { detail: 'Not Found' });
  });
  vi.stubGlobal('fetch', fetch);
  return { calls };
}

describe('apiSource and MY LOCATION', () => {
  it('has no simulated site, so the map offers no simulation in API mode', () => {
    expect(createApiSource('/api/v1').simulatedSite).toBeUndefined();
  });
});

describe('apiSource review saves', () => {
  // Regression (c3): edit saved, approve failed → the store rolled everything back.
  it('reports a partly saved patch with the part the backend holds', async () => {
    const { calls } = backend({ patch: (b) => (b.action === 'approve' ? json(500, { detail: 'database locked' }) : json(200, {})) });
    const api = createApiSource('/api/v1');
    await api.load();
    const saving = api.updateValue('d1:TB-01', K.finalDepth, { value: '6.50', method: 'Edited', status: 'approved' });
    await expect(saving).rejects.toBeInstanceOf(PartialSaveError);
    await saving.catch((e: PartialSaveError) => {
      expect(e.message).toBe('database locked');
      expect(e.applied).toEqual({ value: '6.50', method: 'Edited' });
    });
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { path: 'metadata.borehole_depth_m', action: 'edit', value: 6.5 },
      { path: 'metadata.borehole_depth_m', action: 'approve' },
    ]);
  });

  it('a failure before anything was saved is a plain error', async () => {
    backend({ patch: () => json(500, { detail: 'database locked' }) });
    const api = createApiSource('/api/v1');
    await api.load();
    const saving = api.updateValue('d1:TB-01', K.finalDepth, { status: 'approved' });
    await expect(saving).rejects.toThrow('database locked');
    await expect(saving).rejects.not.toBeInstanceOf(PartialSaveError);
  });
});

describe('apiSource documents', () => {
  // Regression (c14): completeness.lint was always empty, so the panel said "No lint findings".
  it("fills the Completeness panel's lint list from the boreholes' findings", async () => {
    backend();
    const { documents } = await createApiSource('/api/v1').load();
    expect(documents[0].completeness?.lint).toEqual([{ severity: 'warning', boreholeId: 'TB-01', message: 'Log bottom 6.0 m = final depth?' }]);
  });

  // Regression (c15): a document still extracting at load time was never polled.
  it('watches a document once, however often it is asked to', async () => {
    const { calls } = backend({ status: 'extracting' });
    const api = createApiSource('/api/v1');
    const { documents } = await api.load();
    expect(documents[0].step).toBe(1);
    const onUpdate = vi.fn();
    api.watch?.('d1', onUpdate);
    api.watch?.('d1', onUpdate);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ id: 'd1', step: 2 });
    expect(onUpdate.mock.calls[0][0].uploaded).toBeUndefined();
    expect(calls.filter((c) => c.url.endsWith('/documents/d1'))).toHaveLength(1);
  });
});

// int-01: a backend with boreholes but no documents endpoint showed NO DATA instead of the map.
describe('apiSource without a documents endpoint', () => {
  it('loads the boreholes and says the documents are unavailable', async () => {
    backend({ documents: false });
    const loaded = await createApiSource('/api/v1').load();
    expect(loaded.boreholes.map((b) => b.uid)).toEqual(['d1:TB-01']);
    expect(loaded.documents).toEqual([]);
    expect(loaded.documentsUnavailable).toBe(true);
  });

  it('has no flag when the documents endpoint answers', async () => {
    backend();
    expect((await createApiSource('/api/v1').load()).documentsUnavailable).toBeUndefined();
  });

  it('still fails without a boreholes endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/documents') ? json(200, []) : json(404, { detail: 'Not Found' }))));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow('Backend endpoint not available: GET /api/v1/boreholes');
  });

  it('still fails when the backend is unreachable or the documents endpoint breaks', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(createApiSource('/api/v1').load()).rejects.toThrow(unreachableMessage('/api/v1'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('/boreholes') ? json(200, { count: 0, boreholes: [] }) : json(500, { detail: 'cache unreadable' }))),
    );
    await expect(createApiSource('/api/v1').load()).rejects.toThrow('cache unreadable');
  });
});

// int-02: two records with one uid gave React duplicate keys and shared their review targets.
describe('apiSource repeated uids', () => {
  const twin = (depth: number): ApiBoreholeRecord => ({ metadata: { borehole_id: 'FX-1', borehole_depth_m: depth } });

  it('appends #2, #3 to a uid that repeats, in data order', async () => {
    backend({ records: [twin(5), twin(6), twin(7)] });
    const { boreholes } = await createApiSource('/api/v1').load();
    expect(boreholes.map((b) => [b.uid, b.finalDepth])).toEqual([['doc:FX-1', 5], ['doc:FX-1#2', 6], ['doc:FX-1#3', 7]]);
  });

  it("refuses to save a renamed twin, which the backend can't tell apart", async () => {
    const { calls } = backend({ records: [twin(5), twin(6)] });
    const api = createApiSource('/api/v1');
    await api.load();
    await expect(api.updateValue('doc:FX-1#2', K.finalDepth, { status: 'approved' })).rejects.toThrow(
      'Two backend records share the uid doc:FX-1, so this save could change the other one. Give each record its own uid.',
    );
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  // F1: the suffix for the second "record" was "record#2", which the third record already had.
  describe('with a suffix the backend already uses', () => {
    const rec = (uid: string, depth: number): ApiBoreholeRecord => ({ uid, metadata: { borehole_id: 'FX-1', borehole_depth_m: depth } });
    const records = () => [rec('record', 5), rec('record', 6), rec('record#2', 7)];

    it('skips uids that are taken, so no two records share one', async () => {
      backend({ records: records() });
      const { boreholes } = await createApiSource('/api/v1').load();
      expect(boreholes.map((b) => [b.uid, b.finalDepth])).toEqual([['record', 5], ['record#3', 6], ['record#2', 7]]);
    });

    it("saves the backend's own record#2 and still refuses the renamed twin", async () => {
      const { calls } = backend({ records: records() });
      const api = createApiSource('/api/v1');
      await api.load();
      await api.updateValue('record#2', K.finalDepth, { status: 'approved' });
      expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.url)).toEqual(['/api/v1/boreholes/record%232/values']);
      await expect(api.updateValue('record#3', K.finalDepth, { status: 'approved' })).rejects.toThrow('Two backend records share the uid record');
    });
  });

  it('never repeats a uid, whatever the input', () => {
    const uids = ['a', 'a', 'a#2', 'a#3', 'a', 'a#2', 'b', 'a#2#2'];
    const out = uniqueUids(uids.map((uid) => makeBorehole({ uid }))).map((b) => b.uid);
    expect(new Set(out).size).toBe(uids.length);
    // The first record of each uid keeps it.
    expect(out.slice(0, 4)).toEqual(['a', 'a#4', 'a#2', 'a#3']);
  });
});

// int-06: APPROVE ALL CLEAN sent every PATCH of one borehole at once; the backend lost updates.
describe('apiSource save order', () => {
  /** A backend whose PATCH answers take a moment; it records the most requests open at once, per URL and overall. */
  function slowBackend(records?: ApiBoreholeRecord[], fail?: string) {
    const open = new Map<string, number>();
    const peak = new Map<string, number>();
    const bump = (k: string, d: number) => {
      open.set(k, (open.get(k) ?? 0) + d);
      peak.set(k, Math.max(peak.get(k) ?? 0, open.get(k) ?? 0));
    };
    const { calls } = backend({
      records,
      patch: async (body, url) => {
        bump(url, 1);
        bump('all', 1);
        await new Promise((r) => setTimeout(r, 5));
        bump(url, -1);
        bump('all', -1);
        return body.path === fail ? json(500, { detail: 'database locked' }) : json(200, {});
      },
    });
    return { calls, peak };
  }

  it('never overlaps two saves of one borehole, and keeps their order', async () => {
    const { calls, peak } = slowBackend();
    const api = createApiSource('/api/v1');
    await api.load();
    await Promise.all([
      api.updateValue('d1:TB-01', K.finalDepth, { status: 'approved' }),
      api.updateValue('d1:TB-01', K.bottom(1), { status: 'approved' }),
    ]);
    expect(peak.get('/api/v1/boreholes/d1%3ATB-01/values')).toBe(1);
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body?.path)).toEqual(['metadata.borehole_depth_m', 'stratigraphy[0].depth_to_m']);
  });

  it('sends the next save of a borehole after a failed one', async () => {
    slowBackend(undefined, 'metadata.borehole_depth_m');
    const api = createApiSource('/api/v1');
    await api.load();
    const first = api.updateValue('d1:TB-01', K.finalDepth, { status: 'approved' });
    const second = api.updateValue('d1:TB-01', K.bottom(1), { status: 'approved' });
    await expect(first).rejects.toThrow('database locked');
    await expect(second).resolves.toBeUndefined();
  });

  it('saves different boreholes in parallel', async () => {
    const rec = (id: string): ApiBoreholeRecord => ({ uid: `d1:${id}`, document_id: 'd1', metadata: { borehole_id: id, borehole_depth_m: 4 } });
    const { peak } = slowBackend([rec('TB-01'), rec('TB-02')]);
    const api = createApiSource('/api/v1');
    await api.load();
    await Promise.all([
      api.updateValue('d1:TB-01', K.finalDepth, { status: 'approved' }),
      api.updateValue('d1:TB-02', K.finalDepth, { status: 'approved' }),
    ]);
    expect(peak.get('all')).toBe(2);
  });
});

// int-12: the backend's mode (live / demo), from /api/health next to the versioned API.
describe('apiSource health', () => {
  it('reads the mode from /api/health', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { status: 'healthy', mode: 'demo' }));
    vi.stubGlobal('fetch', fetch);
    await expect(createApiSource('/api/v1').health?.()).resolves.toEqual({ mode: 'demo' });
    expect(fetch.mock.calls[0][0]).toBe('/api/health');
  });

  it('is null without a health endpoint or without a known mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { detail: 'Not Found' })));
    await expect(createApiSource('/api/v1').health?.()).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'healthy' })));
    await expect(createApiSource('/api/v1').health?.()).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { status: 'healthy', mode: 'turbo' })));
    await expect(createApiSource('/api/v1').health?.()).resolves.toBeNull();
  });

  it('fails when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(createApiSource('/api/v1').health?.()).rejects.toThrow(unreachableMessage('/api/v1'));
  });
});
