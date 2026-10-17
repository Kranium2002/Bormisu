/**
 * Test doubles for the browser transports of the API source: XMLHttpRequest (uploads with byte
 * progress) and EventSource (GET /events). Tests install them with vi.stubGlobal and drive them by
 * hand; nothing leaves the process. Not used by the app.
 */

type Handler<E = unknown> = ((event: E) => void) | null;

/** Upload side of a MockXhr: the source listens for `progress` and `load` here. */
class MockXhrUpload {
  onprogress: Handler<ProgressEventInit> = null;
  onload: Handler<ProgressEventInit> = null;
}

/** A fake XMLHttpRequest; every instance is kept in `MockXhr.sent` once sent. */
export class MockXhr {
  static sent: MockXhr[] = [];

  /** The latest request sent. */
  static get last(): MockXhr {
    const x = MockXhr.sent.at(-1);
    if (!x) throw new Error('No XMLHttpRequest was sent');
    return x;
  }

  static reset(): void {
    MockXhr.sent = [];
  }

  method = '';
  url = '';
  requestHeaders: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  readyState = 0;
  aborted = false;
  readonly upload = new MockXhrUpload();
  onload: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  ontimeout: Handler = null;
  private responseHeaders: Record<string, string> = {};

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  send(body?: unknown): void {
    this.body = body ?? null;
    MockXhr.sent.push(this);
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  /** Like the browser: an abort before the answer fires `abort`; after it, nothing happens. */
  abort(): void {
    if (this.readyState === 4 || this.aborted) return;
    this.aborted = true;
    this.readyState = 4;
    this.onabort?.({ type: 'abort' });
  }

  /* ---------- test controls ---------- */

  /** The sent multipart body. */
  get form(): FormData {
    if (!(this.body instanceof FormData)) throw new Error('The request body is no FormData');
    return this.body;
  }

  /** Bytes sent so far (an upload `progress` event). */
  progress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable });
  }

  /** The server's answer. */
  respond(status: number, body: string, contentType: string | null = 'application/json'): void {
    this.status = status;
    this.responseText = body;
    this.responseHeaders = contentType ? { 'content-type': contentType } : {};
    this.readyState = 4;
    this.onload?.({ type: 'load' });
  }

  /** A JSON answer. */
  respondJson(status: number, body: unknown): void {
    this.respond(status, JSON.stringify(body));
  }

  /** A network failure (no answer at all). */
  fail(): void {
    this.readyState = 4;
    this.onerror?.({ type: 'error' });
  }
}

/** A fake EventSource; every instance is kept in `MockEventSource.instances`. */
export class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  /** The latest stream created. */
  static get last(): MockEventSource {
    const s = MockEventSource.instances.at(-1);
    if (!s) throw new Error('No EventSource was created');
    return s;
  }

  static reset(): void {
    MockEventSource.instances = [];
  }

  readonly url: string;
  readonly withCredentials = false;
  readyState = MockEventSource.CONNECTING;
  onopen: Handler = null;
  onerror: Handler = null;
  onmessage: Handler<{ type: string; data: unknown; lastEventId: string }> = null;
  private readonly listeners = new Map<string, Set<(event: { type: string; data: unknown; lastEventId: string }) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { type: string; data: unknown; lastEventId: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: { type: string; data: unknown; lastEventId: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  /* ---------- test controls ---------- */

  /** Named event types with a listener. */
  get listenedTypes(): string[] {
    return [...this.listeners].filter(([, set]) => set.size > 0).map(([type]) => type).sort();
  }

  get closed(): boolean {
    return this.readyState === MockEventSource.CLOSED;
  }

  /** The connection is (re)established. */
  open(): void {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.({ type: 'open' });
  }

  /**
   * One frame: `event: <type>` and `data: <data>` (objects are sent as JSON). Like the browser, a
   * named event reaches only that type's listeners; `message` (no event name) reaches onmessage.
   */
  emit(type: string, data: unknown, lastEventId = ''): void {
    const event = { type, data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (type === 'message') this.onmessage?.(event);
  }

  /**
   * A failure. Without `closed` the browser reconnects by itself (readyState CONNECTING); with it
   * (e.g. an HTTP error answer) the stream is closed for good.
   */
  error(closed = false): void {
    this.readyState = closed ? MockEventSource.CLOSED : MockEventSource.CONNECTING;
    this.onerror?.({ type: 'error' });
  }
}
