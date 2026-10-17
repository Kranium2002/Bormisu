/**
 * The planned-line calls of the API source (contract 1.3.0) against a fictional backend (fetch mocked,
 * payloads from contracts/examples): the multipart upload and its fields, the list, one line, the
 * query body, delete, and the error answers as ApiError by code. Nothing leaves the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLES_MISSING, EXAMPLES_PRESENT, example } from '../test/contract/examples';
import type { WireAlignment, WireAlignmentList, WireAlignmentResult, WireError } from './adapters';
import { createApiSource } from './apiSource';
import { ApiError } from './errors';

const BASE = '/api/v1';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const title = EXAMPLES_PRESENT ? 'API source: planned lines' : `API source: planned lines (skipped: ${EXAMPLES_MISSING})`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(!EXAMPLES_PRESENT)(title, () => {
  it('uploads the file as multipart with name, buffer_m and epsg, and adapts the stored line', async () => {
    const line = example<WireAlignment>('Alignment.json');
    const fetch = vi.fn(async () => json(201, line));
    vi.stubGlobal('fetch', fetch);
    const file = new File(['x;y\n1;2\n3;4\n'], 'line.csv', { type: 'text/csv' });
    const a = await createApiSource(BASE).uploadAlignment(file, { name: '  Trasse A ', bufferM: 150, epsg: 25832 });
    expect(a.id).toBe(line.alignment_id);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/alignments`);
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('line.csv');
    expect(form.get('name')).toBe('Trasse A');
    expect(form.get('buffer_m')).toBe('150');
    expect(form.get('epsg')).toBe('25832');
  });

  it('sends no optional field it was not given', async () => {
    const fetch = vi.fn(async () => json(201, example<WireAlignment>('Alignment.json')));
    vi.stubGlobal('fetch', fetch);
    await createApiSource(BASE).uploadAlignment(new File(['{}'], 'line.geojson'));
    const form = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect([...form.keys()]).toEqual(['file']);
  });

  it.each([
    [422, 'alignment_invalid'],
    [422, 'epsg_required'],
    [404, 'alignment_not_found'],
  ])('an answer %i %s becomes an ApiError with the detail', async (status, code) => {
    const body = example<WireError>(`Error.${code}.json`);
    vi.stubGlobal('fetch', vi.fn(async () => json(status, body)));
    const e = await createApiSource(BASE)
      .uploadAlignment(new File(['{}'], 'line.geojson'))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status, code, detail: body.detail });
  });

  it('lists, gets, queries and deletes', async () => {
    const list = example<WireAlignmentList>('AlignmentList.json');
    const line = example<WireAlignment>('Alignment.json');
    const result = example<WireAlignmentResult>('AlignmentResult.json');
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/alignments') && (init?.method ?? 'GET') === 'GET') return json(200, list);
      if (url.endsWith('/query')) return json(200, result);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json(200, line);
    });
    vi.stubGlobal('fetch', fetch);
    const source = createApiSource(BASE);
    expect((await source.listAlignments()).map((a) => a.id)).toEqual(list.alignments.map((a) => a.alignment_id));
    expect((await source.getAlignment(line.alignment_id)).name).toBe(line.name);
    const r = await source.queryAlignment(line.alignment_id, { bufferM: 150, includeUnreviewed: true });
    expect(r.hits.map((h) => h.uid)).toEqual(result.hits.map((h) => h.uid));
    const query = fetch.mock.calls.find(([url]) => String(url).endsWith('/query')) as unknown as [string, RequestInit];
    expect(query[0]).toBe(`${BASE}/alignments/${line.alignment_id}/query`);
    expect(query[1].method).toBe('POST');
    expect(JSON.parse(String(query[1].body))).toEqual({ buffer_m: 150, include_unreviewed: true });
    await expect(source.deleteAlignment(line.alignment_id)).resolves.toBeUndefined();
    const del = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE') as unknown as [string, RequestInit];
    expect(del[0]).toBe(`${BASE}/alignments/${line.alignment_id}`);
  });
});
