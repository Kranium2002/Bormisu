/**
 * Live updates of the API source (contracts/realtime-and-chat.md section 1): the named events of
 * GET /events mapped through the adapters, and the transport around them: EventSource, the polling
 * fallback after three stream failures within a minute, backoff, recovery, a closed stream recreated,
 * 'offline', unsubscribe. EventSource and fetch are mocked, timers are fake; nothing leaves the process.
 * The event data comes from the fictional fixtures (src/test/contract/event-*.json) and, when present,
 * from the backend's examples (contracts/examples/events/*.json).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { LiveEvent, LiveStatus } from '../domain/types';
import { EXAMPLES_MISSING, EXAMPLES_PRESENT, eventFiles, eventTypeOf, example } from '../test/contract/examples';
import { FIXTURES, fixture } from '../test/contract/wire';
import {
  adaptDocument,
  adaptLiveEvent,
  LIVE_EVENT_TYPES,
  type WireClarification,
  type WireDocument,
  type WireDocumentList,
  type WireError,
} from './adapters';
import { createApiSource, MAX_BACKOFF_MS, POLL_MS } from './apiSource';
import { OFFLINE_MS, STREAM_ERROR_LIMIT, STREAM_ERROR_WINDOW_MS, STREAM_RETRY_MS } from './events';
import { MockEventSource } from './testing';

const BASE = '/api/v1';
const D1 = 'doc_01JFICT0000000000000000D1';
const D2 = 'doc_01JFICT0000000000000000D2';
const D5 = 'doc_01JFICT0000000000000000D5';
const HL01 = 'bh_01JFICT00000000000000HL01';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string) =>
  json(status, fixture<WireError[]>('errors').find((e) => e.code === code));

/** The fictional fixture of one event type (src/test/contract/event-<type>.json). */
const eventFixture = <T>(type: string): T => {
  const name = Object.keys(FIXTURES).find((n) => FIXTURES[n].schema === `event:${type}`);
  if (!name) throw new Error(`No event fixture for ${type}`);
  return fixture<T>(name);
};

type Route = (method: string, url: string) => Response | Promise<Response> | undefined;

/**
 * A fictional backend for fetch: the document list, the borehole pages and GET /documents/{id} from
 * the fixtures (`documents` is its state). `route` answers first (throwing is a network failure).
 */
function server(route: Route = () => undefined) {
  const calls: string[] = [];
  const documents = new Map(fixture<WireDocumentList>('documents').documents.map((d) => [d.document_id, d]));
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const own = await route(method, url);
    if (own) return own;
    const path = url.slice(BASE.length);
    if (path === '/boreholes?limit=5000') return json(200, fixture('boreholes-page-1'));
    if (path === '/boreholes?limit=5000&cursor=cur_FICT_page2') return json(200, fixture('boreholes-page-2'));
    if (path === '/documents') return json(200, { documents: [...documents.values()] });
    const m = /^\/documents\/([^/?]+)$/.exec(path);
    if (m && method === 'GET') {
      const d = documents.get(decodeURIComponent(m[1]));
      return d ? json(200, d) : apiError(404, 'document_not_found');
    }
    return apiError(404, 'route_not_found');
  });
  vi.stubGlobal('fetch', fetch);
  /** GET /documents/{id} calls so far. */
  const gets = (id: string) => calls.filter((c) => c === `GET ${BASE}/documents/${id}`).length;
  return { calls, documents, gets };
}

/** A subscription that records what it gets. */
function listen(api: ReturnType<typeof createApiSource>) {
  const events: LiveEvent[] = [];
  const statuses: LiveStatus[] = [];
  const unsubscribe = api.subscribe((e) => events.push(e), (s) => statuses.push(s));
  return { events, statuses, unsubscribe };
}

let info: MockInstance<typeof console.info>;
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  MockEventSource.reset();
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  info.mockRestore();
  warn.mockRestore();
});

describe('event data → LiveEvent (adapters)', () => {
  it('maps each event of the fictional fixtures', () => {
    const doc = eventFixture<WireDocument>('document.updated');
    expect(adaptLiveEvent('document.updated', doc)).toEqual({ type: 'document.updated', document: adaptDocument(doc) });
    expect(adaptLiveEvent('document.deleted', eventFixture('document.deleted'))).toEqual({
      type: 'document.deleted', documentId: 'doc_01JFICT0000000000000000D4',
    });
    expect(adaptLiveEvent('borehole.created', eventFixture('borehole.created'))).toEqual({
      type: 'borehole.created', uid: 'bh_01JFICT00000000000000KR02', documentId: D2, revision: 1, plotted: false,
    });
    expect(adaptLiveEvent('borehole.updated', eventFixture('borehole.updated'))).toEqual({ type: 'borehole.updated', uid: HL01, revision: 5 });
    expect(adaptLiveEvent('clarification.created', eventFixture('clarification.created'))).toEqual({
      type: 'clarification.created', clarificationId: 'cl_01JFICT00000000000000CL01', documentId: D1, boreholeUids: [HL01],
    });
    expect(adaptLiveEvent('clarification.resolved', eventFixture('clarification.resolved'))).toEqual({
      type: 'clarification.resolved', clarificationId: 'cl_01JFICT00000000000000CL01', status: 'skipped',
    });
    expect(adaptLiveEvent('job.failed', eventFixture('job.failed'))).toEqual({
      type: 'job.failed', documentId: 'doc_01JFICT0000000000000000D3', stage: 'classify', detail: 'The file could not be read as an image.', retryable: true,
    });
  });

  it('a clarification without borehole_uids has none (the field is optional)', () => {
    const c = eventFixture<WireClarification>('clarification.created');
    delete c.borehole_uids;
    expect(adaptLiveEvent('clarification.created', c)).toMatchObject({ boreholeUids: [] });
  });

  it('is null for an unknown type or data without the fields the contract requires', () => {
    expect(adaptLiveEvent('message', { document_id: D1 })).toBeNull();
    expect(adaptLiveEvent('document.renamed', { document_id: D1 })).toBeNull();
    expect(adaptLiveEvent('document.updated', { document_id: D1 })).toBeNull();
    expect(adaptLiveEvent('document.updated', { ...eventFixture<WireDocument>('document.updated'), status: 'paused' })).toBeNull();
    expect(adaptLiveEvent('document.deleted', {})).toBeNull();
    expect(adaptLiveEvent('borehole.created', { uid: 'bh_x', document_id: D1, revision: '1', plotted: false })).toBeNull();
    expect(adaptLiveEvent('borehole.updated', { uid: 'bh_x' })).toBeNull();
    expect(adaptLiveEvent('clarification.created', { document_id: D1 })).toBeNull();
    expect(adaptLiveEvent('clarification.resolved', { clarification_id: 'cl_x', status: 'open' })).toBeNull();
    expect(adaptLiveEvent('job.failed', { document_id: D1, stage: 'ocr', detail: 'x' })).toBeNull();
    for (const data of [null, 'text', 42, [], undefined]) expect(adaptLiveEvent('document.deleted', data)).toBeNull();
  });

  describe.skipIf(!EXAMPLES_PRESENT)(`on the backend examples${EXAMPLES_PRESENT ? '' : ` — skipped: ${EXAMPLES_MISSING}`}`, () => {
    it('has an example for every event type the source listens for', () => {
      expect(eventFiles().map(eventTypeOf).sort()).toEqual([...LIVE_EVENT_TYPES].sort());
    });

    it.each(eventFiles())('%s maps to a LiveEvent of its type, with the fields of its data', (file) => {
      const type = eventTypeOf(file) as string;
      const data = example<Record<string, unknown>>(file);
      const event = adaptLiveEvent(type, data);
      expect(event?.type).toBe(type);
      const expected: Record<string, unknown> = {
        'document.updated': { document: adaptDocument(data as unknown as WireDocument) },
        'document.deleted': { documentId: data.document_id },
        'borehole.created': { uid: data.uid, documentId: data.document_id, revision: data.revision, plotted: data.plotted },
        'borehole.updated': { uid: data.uid, revision: data.revision },
        'clarification.created': { clarificationId: data.clarification_id, documentId: data.document_id, boreholeUids: data.borehole_uids ?? [] },
        'clarification.resolved': { clarificationId: data.clarification_id, status: data.status },
        'job.failed': { documentId: data.document_id, stage: data.stage, detail: data.detail, retryable: data.retryable },
      };
      expect(event).toEqual({ type, ...(expected[type] as object) });
    });

    it('each example arrives through the stream as that LiveEvent', () => {
      server();
      vi.stubGlobal('EventSource', MockEventSource);
      const { events, unsubscribe } = listen(createApiSource(BASE));
      const es = MockEventSource.last;
      es.open();
      for (const file of eventFiles()) es.emit(eventTypeOf(file) as string, example(file));
      expect(events.map((e) => e.type)).toEqual(eventFiles().map(eventTypeOf));
      expect(info).not.toHaveBeenCalled();
      unsubscribe();
    });
  });
});

describe('the event stream', () => {
  beforeEach(() => vi.stubGlobal('EventSource', MockEventSource));

  it('opens one EventSource on <base>/events with one listener per named event type; connecting until open, then live', () => {
    server();
    const { statuses, unsubscribe } = listen(createApiSource(BASE));
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.last;
    expect(es.url).toBe('/api/v1/events');
    expect(es.listenedTypes).toEqual([...LIVE_EVENT_TYPES].sort());
    expect(statuses).toEqual(['connecting']);
    es.open();
    expect(statuses).toEqual(['connecting', 'live']);
    unsubscribe();
  });

  it('maps every named event through the adapters; document.updated is the summary the loads produce', async () => {
    const { documents: wire } = server();
    const api = createApiSource(BASE);
    const { documents } = await api.load();
    const { events, unsubscribe } = listen(api);
    const es = MockEventSource.last;
    es.open();
    es.emit('document.updated', wire.get(D1), '1842');
    for (const type of LIVE_EVENT_TYPES.filter((t) => t !== 'document.updated')) es.emit(type, eventFixture(type));
    expect(events[0]).toEqual({ type: 'document.updated', document: documents[0] });
    expect(events[0]).toMatchObject({ document: { reviewBoreholeUid: HL01, project: 'Harbourline Tunnel (fictional)' } });
    expect(events.slice(1)).toEqual(
      LIVE_EVENT_TYPES.filter((t) => t !== 'document.updated').map((type) => adaptLiveEvent(type, eventFixture(type))),
    );
    expect(events.find((e) => e.type === 'clarification.created')).toEqual({
      type: 'clarification.created', clarificationId: 'cl_01JFICT00000000000000CL01', documentId: D1, boreholeUids: [HL01],
    });
    unsubscribe();
  });

  it('ignores unknown event types and unparseable data with one console.info each, and never throws', () => {
    server();
    const { events, unsubscribe } = listen(createApiSource(BASE));
    const es = MockEventSource.last;
    es.open();
    expect(() => {
      es.emit('message', { document_id: D1 }); // no event name: no known type
      es.emit('borehole.updated', '{"uid":'); // not JSON
      es.emit('borehole.updated', { uid: HL01 }); // no revision
    }).not.toThrow();
    expect(events).toEqual([]);
    expect(info).toHaveBeenCalledTimes(3);
    expect(info.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/unknown type "message"/),
      expect.stringMatching(/"borehole\.updated" event.*not JSON/),
      expect.stringMatching(/"borehole\.updated" event.*unexpected data/),
    ]);
    es.emit('borehole.updated', { uid: HL01, revision: 6 });
    expect(events).toEqual([{ type: 'borehole.updated', uid: HL01, revision: 6 }]);
    unsubscribe();
  });

  it('an error in the event handler is logged and does not stop the stream', () => {
    server();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: LiveEvent[] = [];
    const unsubscribe = createApiSource(BASE).subscribe((e) => {
      seen.push(e);
      throw new Error('handler failed (fictional)');
    }, () => undefined);
    const es = MockEventSource.last;
    es.open();
    expect(() => es.emit('borehole.updated', { uid: HL01, revision: 6 })).not.toThrow();
    es.emit('borehole.updated', { uid: HL01, revision: 7 });
    expect(seen).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
    unsubscribe();
  });

  it('refetches every followed document once when a new stream opens (it has no Last-Event-ID to replay from), not on its own reconnects', async () => {
    vi.useFakeTimers();
    const { gets } = server();
    const api = createApiSource(BASE);
    api.follow(D2);
    api.follow(D5);
    const { events, unsubscribe } = listen(api);
    const es = MockEventSource.last;
    es.open();
    await vi.advanceTimersByTimeAsync(0);
    expect([gets(D2), gets(D5)]).toEqual([1, 1]);
    expect(events.map((e) => e.type === 'document.updated' && e.document.id)).toEqual([D2, D5]);
    // The browser reconnects by itself and resends Last-Event-ID: the server replays, nothing is refetched.
    es.error();
    es.open();
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect([gets(D2), gets(D5)]).toEqual([1, 1]);
    unsubscribe();
  });

  it('a document.updated with a terminal status and a document.deleted unfollow the document', async () => {
    vi.useFakeTimers();
    const { gets } = server();
    const api = createApiSource(BASE);
    api.follow(D2);
    api.follow(D5);
    const { unsubscribe } = listen(api);
    const es = MockEventSource.last;
    es.open();
    await vi.advanceTimersByTimeAsync(0);
    es.emit('document.updated', { ...eventFixture<WireDocument>('document.updated'), status: 'needs_review' });
    es.emit('document.deleted', { document_id: D5 });
    for (let i = 0; i < STREAM_ERROR_LIMIT; i += 1) es.error();
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect([gets(D2), gets(D5)]).toEqual([1, 1]);
    unsubscribe();
  });

  it('delivers nothing after unsubscribe', () => {
    server();
    const { events, statuses, unsubscribe } = listen(createApiSource(BASE));
    const es = MockEventSource.last;
    unsubscribe();
    expect(es.closed).toBe(true);
    es.open();
    es.emit('borehole.updated', { uid: HL01, revision: 6 });
    es.error();
    expect(events).toEqual([]);
    expect(statuses).toEqual(['connecting']);
  });
});

describe('polling fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', MockEventSource);
  });

  it('switches to polling on the third stream failure within a minute, not before', async () => {
    const { gets } = server();
    const api = createApiSource(BASE);
    api.follow(D2);
    const { statuses, unsubscribe } = listen(api);
    const es = MockEventSource.last;
    es.error(); // t = 0
    await vi.advanceTimersByTimeAsync(30_000);
    es.error(); // t = 30 s
    await vi.advanceTimersByTimeAsync(20_000);
    es.open(); // t = 50 s: the browser's reconnect works for a while (and refetches D2 once)
    await vi.advanceTimersByTimeAsync(20_000);
    es.error(); // t = 70 s: the failure at 0 is out of the window, two count
    expect(statuses).toEqual(['connecting', 'live', 'connecting']);
    expect(gets(D2)).toBe(1);
    await vi.advanceTimersByTimeAsync(STREAM_ERROR_WINDOW_MS - 40_000 - 1);
    expect(gets(D2)).toBe(1);
    es.error(); // t = 90 s - 1 ms: three within a minute
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'polling']);
    await vi.advanceTimersByTimeAsync(0);
    expect(gets(D2)).toBe(2);
    unsubscribe();
  });

  it('polls every followed document every 2 s and emits document.updated for each answer', async () => {
    const { gets, documents } = server();
    const api = createApiSource(BASE);
    api.follow(D2);
    api.follow(D5);
    const { events, unsubscribe } = listen(api);
    for (let i = 0; i < STREAM_ERROR_LIMIT; i += 1) MockEventSource.last.error();
    await vi.advanceTimersByTimeAsync(0);
    expect([gets(D2), gets(D5)]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect([gets(D2), gets(D5)]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect([gets(D2), gets(D5)]).toEqual([2, 2]);
    (documents.get(D2) as WireDocument).status = 'classifying';
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect([gets(D2), gets(D5)]).toEqual([3, 3]);
    expect(events.map((e) => e.type)).toEqual(Array(6).fill('document.updated'));
    expect(events.at(-2)).toMatchObject({ document: { id: D2, status: 'classifying' } });
    unsubscribe();
  });

  it('a document followed while polling is polled at once', async () => {
    const { gets } = server();
    const api = createApiSource(BASE);
    const { unsubscribe } = listen(api);
    for (let i = 0; i < STREAM_ERROR_LIMIT; i += 1) MockEventSource.last.error();
    await vi.advanceTimersByTimeAsync(5_000);
    api.follow(D5);
    await vi.advanceTimersByTimeAsync(0);
    expect(gets(D5)).toBe(1);
    unsubscribe();
  });

  it('backs off after errors and keeps polling until the document is done; errors never fail the document', async () => {
    const extracting = fixture<WireDocumentList>('documents').documents[1];
    let polls = 0;
    server((_, url) => {
      if (!url.endsWith(`/documents/${D2}`)) return undefined;
      polls += 1;
      if (polls === 1) return json(200, extracting);
      if (polls <= 4) throw new TypeError('Failed to fetch');
      return json(200, { ...extracting, status: 'needs_review' } satisfies WireDocument);
    });
    const api = createApiSource(BASE);
    api.follow(D2);
    const { events, unsubscribe } = listen(api);
    for (let i = 0; i < STREAM_ERROR_LIMIT; i += 1) MockEventSource.last.error();
    await vi.advanceTimersByTimeAsync(0);
    expect([polls, events.length]).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(POLL_MS); // t = 2 s: fails
    await vi.advanceTimersByTimeAsync(POLL_MS); // t = 4 s: fails again after 2 s
    expect(polls).toBe(3);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS - 1);
    expect(polls).toBe(3);
    await vi.advanceTimersByTimeAsync(1); // t = 8 s: third failure, next wait 8 s
    expect(polls).toBe(4);
    await vi.advanceTimersByTimeAsync(4 * POLL_MS); // t = 16 s: answers again
    expect(polls).toBe(5);
    expect(events.map((e) => e.type === 'document.updated' && [e.document.status, e.document.error])).toEqual([
      ['extracting', null], ['needs_review', null],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF_MS);
    expect(polls).toBe(5); // a terminal status: no longer followed
    unsubscribe();
  });

  it('never stops for good while the backend stays away; the wait is capped at 30 s', async () => {
    let polls = 0;
    server((_, url) => {
      if (!url.includes('/documents/')) return undefined;
      polls += 1;
      throw new TypeError('Failed to fetch');
    });
    const api = createApiSource(BASE);
    api.follow(D2);
    const { events, unsubscribe } = listen(api);
    for (let i = 0; i < STREAM_ERROR_LIMIT; i += 1) MockEventSource.last.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    // Waits after each failure: 2, 4, 8, 16, 30, 30 s.
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000 + 30_000 + 30_000 - 1);
    expect(polls).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(7);
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(polls).toBe(8);
    expect(events).toEqual([]);
    unsubscribe();
  });

  it('a document the backend no longer has is emitted as document.deleted and no longer followed', async () => {
    const { gets, documents } = server();
    documents.delete(D2);
    const api = createApiSource(BASE);
    api.follow(D2);
    api.follow(D5);
    const { events, unsubscribe } = listen(api);
    for (let i = 0; i < STREAM_ERROR_LIMIT; i += 1) MockEventSource.last.error();
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(gets(D2)).toBe(1);
    expect(gets(D5)).toBe(11);
    expect(events.filter((e) => e.type === 'document.deleted')).toEqual([{ type: 'document.deleted', documentId: D2 }]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(new RegExp(`${D2}.*no longer`));
    // Followed again later (e.g. it exists again after a retry): polled again.
    documents.set(D2, fixture<WireDocumentList>('documents').documents[1]);
    api.follow(D2);
    await vi.advanceTimersByTimeAsync(0);
    expect(gets(D2)).toBe(2);
    unsubscribe();
  });

  it('when the stream opens again, polling stops and the status is live', async () => {
    const { gets } = server();
    const api = createApiSource(BASE);
    api.follow(D2);
    const { statuses, unsubscribe } = listen(api);
    const es = MockEventSource.last;
    es.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(gets(D2)).toBe(1); // the first open refetches what the source follows
    for (let i = 0; i < STREAM_ERROR_LIMIT; i += 1) es.error();
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(gets(D2)).toBe(5);
    es.open(); // the browser's own reconnect worked: the server replays from Last-Event-ID
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'polling', 'live']);
    await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF_MS);
    expect(gets(D2)).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it('without EventSource it polls from the start', async () => {
    vi.unstubAllGlobals();
    const { gets } = server();
    const api = createApiSource(BASE);
    api.follow(D2);
    const { statuses, unsubscribe } = listen(api);
    expect(statuses).toEqual(['polling']);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(gets(D2)).toBe(2);
    expect(MockEventSource.instances).toHaveLength(0);
    unsubscribe();
  });
});

describe('a closed stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', MockEventSource);
  });

  it('is recreated after a delay, and every followed document is refetched once when the new one opens', async () => {
    const { gets } = server();
    const api = createApiSource(BASE);
    api.follow(D2);
    api.follow(D5);
    const { events, statuses, unsubscribe } = listen(api);
    const first = MockEventSource.last;
    first.open();
    await vi.advanceTimersByTimeAsync(0);
    expect([gets(D2), gets(D5)]).toEqual([1, 1]);
    first.error(true); // e.g. 502 from the proxy while the API restarts: the browser gives up
    expect(statuses).toEqual(['connecting', 'live', 'connecting']);
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS - 1);
    expect(MockEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockEventSource.instances).toHaveLength(2);
    const second = MockEventSource.last;
    expect(second.url).toBe('/api/v1/events');
    expect(second.listenedTypes).toEqual([...LIVE_EVENT_TYPES].sort());
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('live');
    expect([gets(D2), gets(D5)]).toEqual([2, 2]);
    expect(events.filter((e) => e.type === 'document.updated')).toHaveLength(4);
    // Events of the closed stream are not delivered any more.
    first.emit('borehole.updated', { uid: HL01, revision: 9 });
    expect(events.some((e) => e.type === 'borehole.updated')).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF_MS);
    expect([gets(D2), gets(D5)]).toEqual([2, 2]);
    unsubscribe();
  });

  it('keeps being retried with growing waits up to 30 s; the third failure within a minute starts polling meanwhile', async () => {
    const { gets } = server();
    const api = createApiSource(BASE);
    api.follow(D2);
    const { statuses, unsubscribe } = listen(api);
    const createdAt: number[] = [];
    const start = Date.now();
    for (let k = 0; k < 7; k += 1) {
      createdAt.push(Date.now() - start);
      const n = MockEventSource.instances.length;
      MockEventSource.last.error(true);
      if (k === 1) expect(statuses.at(-1)).toBe('connecting');
      if (k === 2) expect(statuses.at(-1)).toBe('polling');
      for (let guard = 0; MockEventSource.instances.length === n && guard < 200; guard += 1) await vi.advanceTimersByTimeAsync(500);
    }
    // Waits 3, 6, 12, 24, 30, 30 s (each rounded up to the 0.5 s steps above).
    expect(createdAt.slice(1).map((t, i) => t - createdAt[i])).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
    expect(gets(D2)).toBeGreaterThan(10);
    MockEventSource.last.open();
    expect(statuses.at(-1)).toBe('live');
    unsubscribe();
  });
});

describe('offline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', MockEventSource);
  });

  it('is the status when neither the stream nor a poll has succeeded for OFFLINE_MS; a poll that answers ends it', async () => {
    let down = true;
    server((_, url) => {
      if (down && url.includes('/documents/')) throw new TypeError('Failed to fetch');
      return undefined;
    });
    const api = createApiSource(BASE);
    api.follow(D2);
    const { statuses, unsubscribe } = listen(api);
    for (let i = 0; i < STREAM_ERROR_LIMIT; i += 1) MockEventSource.last.error();
    await vi.advanceTimersByTimeAsync(OFFLINE_MS - 1);
    expect(statuses).toEqual(['connecting', 'polling']);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses).toEqual(['connecting', 'polling', 'offline']);
    down = false;
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(statuses).toEqual(['connecting', 'polling', 'offline', 'polling']);
    MockEventSource.last.open();
    expect(statuses.at(-1)).toBe('live');
    unsubscribe();
  });

  it('counts from the moment a live stream was lost; never while the stream is open', async () => {
    server();
    const { statuses, unsubscribe } = listen(createApiSource(BASE));
    MockEventSource.last.open();
    await vi.advanceTimersByTimeAsync(5 * OFFLINE_MS);
    expect(statuses).toEqual(['connecting', 'live']);
    MockEventSource.last.error(); // lost at t0; nothing followed, so nothing to poll
    await vi.advanceTimersByTimeAsync(OFFLINE_MS - 1);
    expect(statuses.at(-1)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.at(-1)).toBe('offline');
    MockEventSource.last.open();
    expect(statuses.at(-1)).toBe('live');
    unsubscribe();
  });

  it('comes from the start when the stream never opens', async () => {
    server();
    const { statuses, unsubscribe } = listen(createApiSource(BASE));
    await vi.advanceTimersByTimeAsync(OFFLINE_MS);
    expect(statuses).toEqual(['connecting', 'offline']);
    unsubscribe();
  });
});

describe('unsubscribe', () => {
  it('closes the stream, clears every timer and stops polling, the reconnect and the offline clock', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', MockEventSource);
    let release: (() => void) | undefined;
    const { calls } = server((_, url) => {
      if (url.endsWith(`/documents/${D5}`)) return new Promise<Response>((r) => (release = () => r(json(200, fixture<WireDocumentList>('documents').documents[4]))));
      return undefined;
    });
    const api = createApiSource(BASE);
    api.follow(D2);
    api.follow(D5);
    const { events, statuses, unsubscribe } = listen(api);
    const es = MockEventSource.last;
    es.error();
    es.error();
    es.error(true); // polling, a reconnect pending, the offline clock running
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3);
    const before = calls.length;
    const delivered = events.length;
    unsubscribe();
    expect(es.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    release?.(); // a poll still in flight answers after unsubscribe
    await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF_MS);
    expect(calls.length).toBe(before);
    expect(events.length).toBe(delivered);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'polling']);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });
});
