/**
 * Live updates of the API source (contracts/realtime-and-chat.md section 1). The event stream
 * GET /events runs through EventSource, which reconnects by itself and resends Last-Event-ID. When it
 * fails three times within a minute, the documents the source follows are polled (GET
 * /documents/{id}) until the stream works again; a stream the browser gave up on (readyState CLOSED)
 * is recreated after a delay. Wire shapes stay in adapters.ts: this module sees LiveEvents only.
 */
import type { LiveEvent, LiveStatus } from '../domain/types';
import { isLiveEventType, isTerminal, LIVE_EVENT_TYPES } from './adapters';
import { errorText } from './errors';

/** Polling interval of a followed document while the stream is down (ms). */
export const POLL_MS = 2000;
/** Longest wait between polls after errors (ms); the wait doubles from POLL_MS up to this. */
export const MAX_BACKOFF_MS = 30_000;
/** Stream failures within STREAM_ERROR_WINDOW_MS that switch to polling. */
export const STREAM_ERROR_LIMIT = 3;
/** The sliding window in which stream failures are counted (ms). */
export const STREAM_ERROR_WINDOW_MS = 60_000;
/** First wait before a stream the browser closed for good is opened again (ms); doubles up to MAX_BACKOFF_MS. */
export const STREAM_RETRY_MS = 3000;
/**
 * The status is 'offline' when, for this long (ms), the stream has not been open and no poll was
 * answered: live updates are not arriving. It ends with the next poll answered or the stream opening.
 */
export const OFFLINE_MS = 60_000;

/** EventSource.CLOSED: the browser will not reconnect this stream by itself. */
const CLOSED = 2;

/** The documents a source follows: still being processed, so the polling fallback fetches them. */
export class FollowedDocuments {
  private readonly ids = new Set<string>();
  private readonly listeners = new Set<(id: string) => void>();

  /** Follows a document; listeners hear of it only when it was not followed yet. */
  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    for (const listener of [...this.listeners]) listener(id);
  }

  delete(id: string): void {
    this.ids.delete(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  list(): string[] {
    return [...this.ids];
  }

  /** Calls `listener` for every document followed from now on; returns the unsubscribe function. */
  onAdd(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** What the live feed needs from the API source. */
export interface LiveFeedSource {
  /** URL of the event stream, e.g. "/api/v1/events". */
  url: string;
  followed: FollowedDocuments;
  /** One event's parsed data as a LiveEvent; null when the data lacks what the contract requires. */
  adapt(type: string, data: unknown): LiveEvent | null;
  /**
   * The current state of one followed document: its document.updated event, or document.deleted
   * when the backend no longer has it. Rejects when it can't be fetched.
   */
  refetch(documentId: string): Promise<LiveEvent>;
}

interface Poller { timer?: ReturnType<typeof setTimeout>; errors: number }

/**
 * Opens the live feed: calls `onStatus` at once with the first status and on every change, and
 * `onEvent` with every update. Returns the function that closes the stream and clears every timer.
 *
 * - Status: 'connecting' until the stream opens, 'live' while it is open, 'polling' once it failed
 *   three times within a minute (or without EventSource), 'offline' after OFFLINE_MS without an open
 *   stream and without an answered poll.
 * - Every new EventSource refetches the followed documents once when it first opens: it has no
 *   Last-Event-ID to resume from (the browser's own reconnects of one EventSource resend it).
 * - Polling: every followed document every POLL_MS; after errors its wait doubles up to
 *   MAX_BACKOFF_MS and polling goes on (one console warning per error streak). A terminal status
 *   (needs_review, done, failed) or document.deleted ends following that document.
 */
export function openLiveFeed(
  source: LiveFeedSource,
  onEvent: (event: LiveEvent) => void,
  onStatus: (status: LiveStatus) => void,
): () => void {
  const EventSourceClass = (globalThis as { EventSource?: typeof EventSource }).EventSource;
  const { followed } = source;
  let active = true;
  let stream: EventSource | null = null;
  let open = false;
  let polling = false;
  let offline = false;
  let status: LiveStatus | null = null;
  /** Times of the stream failures within the window. */
  const failures: number[] = [];
  /** Closed streams since the stream was last open (the reconnect wait doubles with each). */
  let closedInARow = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  const pollers = new Map<string, Poller>();

  function report(): void {
    if (!active) return;
    const next: LiveStatus = open ? 'live' : offline ? 'offline' : polling ? 'polling' : 'connecting';
    if (next === status) return;
    status = next;
    onStatus(next);
  }

  /** The server answered just now: the offline clock starts again (it runs only while the stream is not open). */
  function alive(): void {
    offline = false;
    clearTimeout(offlineTimer);
    offlineTimer = open
      ? undefined
      : setTimeout(() => {
          offline = true;
          report();
        }, OFFLINE_MS);
  }

  /** Hands an event to the subscriber; a terminal or deleted document is no longer followed. */
  function deliver(event: LiveEvent): void {
    if (!active) return;
    if (event.type === 'document.deleted') followed.delete(event.documentId);
    else if (event.type === 'document.updated' && isTerminal(event.document.status)) followed.delete(event.document.id);
    try {
      onEvent(event);
    } catch (e) {
      // The subscriber's failure must not stop the stream or the polling.
      console.error('Handling a live update failed:', e);
    }
  }

  /** One frame of the stream; unknown types and unusable data are ignored with one console.info each. */
  function receive(type: string, raw: unknown): void {
    if (!active) return;
    if (!isLiveEventType(type)) {
      console.info(`Ignored an event of unknown type "${type}" from the server.`);
      return;
    }
    let data: unknown;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      console.info(`Ignored a "${type}" event from the server: its data is not JSON.`);
      return;
    }
    let event: LiveEvent | null = null;
    try {
      event = source.adapt(type, data);
    } catch {
      event = null;
    }
    if (!event) {
      console.info(`Ignored a "${type}" event from the server: unexpected data.`);
      return;
    }
    deliver(event);
  }

  /** Refetches every followed document once (a new stream has nothing to replay from). */
  function refetchFollowed(): void {
    for (const id of followed.list()) {
      source.refetch(id).then(deliver, () => {
        // The stream is open: the document's next change arrives as an event.
      });
    }
  }

  function connect(): void {
    reconnectTimer = undefined;
    if (!active) return;
    if (!EventSourceClass) {
      startPolling();
      return;
    }
    const es = new EventSourceClass(source.url);
    let opened = false;
    stream = es;
    es.onopen = () => {
      if (stream !== es || !active) return;
      open = true;
      closedInARow = 0;
      alive();
      stopPolling();
      report();
      if (!opened) {
        opened = true;
        refetchFollowed();
      }
    };
    es.onerror = () => {
      if (stream === es && active) lost(es);
    };
    for (const type of LIVE_EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        if (stream === es) receive(type, (e as MessageEvent).data);
      });
    }
    // Events without a name (or with one this client does not listen for) are not used.
    es.onmessage = (e) => {
      if (stream === es) receive(e.type || 'message', e.data);
    };
  }

  /** A stream failure: counted in the window; a closed stream is recreated after a delay. */
  function lost(es: EventSource): void {
    if (open) {
      open = false;
      alive(); // the stream was working until now: the offline clock starts here
    }
    const now = Date.now();
    failures.push(now);
    while (failures.length && now - failures[0] >= STREAM_ERROR_WINDOW_MS) failures.shift();
    if (failures.length >= STREAM_ERROR_LIMIT) startPolling();
    if (es.readyState === CLOSED) {
      es.close();
      stream = null;
      const wait = Math.min(STREAM_RETRY_MS * 2 ** closedInARow, MAX_BACKOFF_MS);
      closedInARow += 1;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, wait);
    }
    report();
  }

  function startPolling(): void {
    if (polling || !active) return;
    polling = true;
    for (const id of followed.list()) schedulePoll(id, 0);
    report();
  }

  function stopPolling(): void {
    polling = false;
    for (const p of pollers.values()) clearTimeout(p.timer);
    pollers.clear();
  }

  function schedulePoll(id: string, wait: number): void {
    const p = pollers.get(id) ?? { errors: 0 };
    clearTimeout(p.timer);
    pollers.set(id, p);
    p.timer = setTimeout(() => void poll(id, p), wait);
  }

  /** One poll of one document. A failed poll never fails the document: the wait grows and polling goes on. */
  async function poll(id: string, p: Poller): Promise<void> {
    p.timer = undefined;
    const current = () => active && polling && pollers.get(id) === p;
    if (!current()) return;
    if (!followed.has(id)) {
      pollers.delete(id);
      return;
    }
    let event: LiveEvent;
    try {
      event = await source.refetch(id);
    } catch (e) {
      if (!current()) return;
      if (p.errors === 0) console.warn(`Following document ${id} failed (${errorText(e)}); retrying with backoff.`);
      p.errors += 1;
      schedulePoll(id, Math.min(POLL_MS * 2 ** (p.errors - 1), MAX_BACKOFF_MS));
      return;
    }
    if (!active) return;
    alive();
    report();
    deliver(event);
    if (current() && followed.has(id)) {
      p.errors = 0;
      schedulePoll(id, POLL_MS);
    } else if (pollers.get(id) === p) {
      pollers.delete(id);
    }
  }

  const stopFollowing = followed.onAdd((id) => {
    if (active && polling) schedulePoll(id, 0);
  });

  alive();
  connect();
  report();

  return () => {
    if (!active) return;
    active = false;
    stopFollowing();
    stopPolling();
    clearTimeout(reconnectTimer);
    clearTimeout(offlineTimer);
    reconnectTimer = undefined;
    offlineTimer = undefined;
    stream?.close();
    stream = null;
    open = false;
  };
}
