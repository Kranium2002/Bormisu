/** API mode must fail with a clear message when there is no (or the wrong) backend, and never fall back to sample data. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { K } from '../domain/keys';
import type { ApiBoreholeRecord, ApiDocument } from './adapters';
import { createApiSource, unreachableMessage } from './apiSource';
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

  it('loads an empty backend as no boreholes and no documents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('/boreholes') ? json(200, { count: 0, boreholes: [] }) : json(200, []))),
    );
    await expect(createApiSource('/api/v1').load()).resolves.toEqual({ boreholes: [], documents: [] });
  });
});

/** A fictional backend with one borehole in one document; `patch` answers PATCH requests. */
function backend(o: { status?: ApiDocument['status']; patch?: (body: Record<string, unknown>) => Response } = {}) {
  const record: ApiBoreholeRecord = {
    uid: 'd1:TB-01', document_id: 'd1',
    metadata: { borehole_id: 'TB-01', borehole_depth_m: 6 },
    stratigraphy: [{ depth_from_m: 0, depth_to_m: 6 }],
    lint: [{ path: 'stratigraphy[0].depth_to_m', severity: 'warning', message: 'Log bottom 6.0 m = final depth?' }],
  };
  const document: ApiDocument = {
    document_id: 'd1', file_name: 'test_report.pdf', status: o.status ?? 'needs_review',
    completeness: { expected_ids: ['TB-01'], found_ids: ['TB-01'], missing: [], unexpected: [] },
  };
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });
    if (method === 'PATCH') return o.patch?.(body ?? {}) ?? json(200, record);
    if (url.endsWith('/boreholes')) return json(200, { count: 1, boreholes: [record] });
    if (url.endsWith('/documents')) return json(200, [document]);
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
