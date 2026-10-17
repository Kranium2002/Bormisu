/**
 * Test helpers for the store: a fake data source over fictional in-memory data that behaves like the
 * backend (saves bump the revision and answer with the record), uploads and live updates the test
 * drives by hand, and a store reset. Not used by the app.
 */
import type { DataSource, LoadResult, UploadHandle, UploadOptions } from '../data/DataSource';
import { UploadCancelledError } from '../data/errors';
import { applyValuePatch } from '../domain/review';
import { isClean } from '../domain/status';
import type { Borehole, DocumentSummary, Health, LiveEvent, LiveStatus, UploadResult } from '../domain/types';
import { useAppStore } from './appStore';

/** Health of a working server with fictional limits. */
export function makeHealth(o: Partial<Health> = {}): Health {
  return {
    mode: 'live',
    status: 'ok',
    version: 'test',
    providers: { ocr: true, classifier: true, extractor: true, chat: true, geocoder: true },
    upload: { maxMb: 1, extensions: ['.pdf', '.png'] },
    ...o,
  };
}

/** A fake source plus what it holds, for assertions. */
export type FakeSource = DataSource & { held: Map<string, Borehole> };

const clone = <T>(x: T): T => structuredClone(x);

/** A document the fake server makes for an uploaded file: queued, no pages yet. */
export function queuedDocument(file: File, project: string | null): DocumentSummary {
  return {
    id: `doc_${file.name}`, name: file.name, project: project ?? '', status: 'queued', pages: [], step: 0, progress: null,
    counts: null, completeness: null, reviewBoreholeUid: null, openClarifications: 0, duplicateOf: null, error: null, uploaded: true,
  };
}

/** An upload handle that answers at once (the default of fakeSource). */
function answeredUpload(file: File, options: UploadOptions): UploadHandle {
  options.onProgress?.({ loaded: file.size, total: file.size });
  return { done: Promise.resolve({ document: queuedDocument(file, options.project), duplicate: false }), cancel: () => undefined };
}

/**
 * A data source over `data`. It keeps its own copy of the boreholes ("the server"): saves apply the
 * patch, bump the revision and resolve with the record; approve-clean and CRS confirmation change
 * it the same way. Uploads answer at once with a queued document; live updates never come (use
 * manualLive). Any method can be replaced through `over`.
 */
export function fakeSource(data: LoadResult, over: Partial<DataSource> = {}): FakeSource {
  const held = new Map(data.boreholes.map((b) => [b.uid, clone(b)]));
  const get = (uid: string) => {
    const b = held.get(uid);
    if (!b) throw new Error(`unknown borehole ${uid}`);
    return b;
  };
  const ofDocument = (id: string) => [...held.values()].filter((b) => b.documentId === id);
  const source: DataSource = {
    kind: 'sample',
    health: async () => makeHealth(),
    load: async () => ({ boreholes: [...held.values()].map(clone), documents: clone(data.documents) }),
    getBorehole: async (uid) => clone(get(uid)),
    documentBoreholes: async (id) => ofDocument(id).map(clone),
    getDocument: async (id) => {
      const d = data.documents.find((x) => x.id === id);
      if (!d) throw new Error(`unknown document ${id}`);
      return clone(d);
    },
    getPage: async (documentId, page) => ({ documentId, page, type: 'log', usage: 'used', label: `page ${page}`, items: [] }),
    thumbnailUrl: () => null,
    upload: answeredUpload,
    subscribe: () => () => undefined,
    follow: () => undefined,
    updateValue: async (uid, key, patch) => {
      const b = get(uid);
      const next = { ...applyValuePatch(b, key, patch), revision: b.revision + 1 };
      held.set(uid, next);
      return clone(next);
    },
    approveClean: async (id, dryRun) => {
      let count = 0;
      for (const b of ofDocument(id)) {
        const keys = b.values.filter(isClean).map((v) => v.key);
        count += keys.length;
        if (!dryRun && keys.length) {
          const next = keys.reduce((acc, k) => applyValuePatch(acc, k, { status: 'approved' }), b);
          held.set(b.uid, { ...next, revision: b.revision + 1 });
        }
      }
      return count;
    },
    retry: async () => undefined,
    crsCandidates: async () => [],
    confirmCrs: async (id, c) => {
      const all = ofDocument(id);
      for (const b of all) {
        held.set(b.uid, { ...b, revision: b.revision + 1, crs: { name: b.crs.name, code: c.code, status: 'confirmed' } });
      }
      return all.length;
    },
    ...over,
  };
  return Object.assign(source, { held });
}

/** One upload the test answers by hand (see manualUploads). */
export interface ManualUpload {
  file: File;
  options: UploadOptions;
  /** True once the store called cancel(). */
  cancelled: boolean;
  /** Reports byte progress to the store. */
  progress(loaded: number, total?: number): void;
  /** Answers with the server's document (`duplicate` for bytes uploaded before). */
  resolve(result: UploadResult): void;
  reject(e: unknown): void;
}

/**
 * Uploads that stay open until the test answers them. Like the API source, cancel() rejects the
 * upload with UploadCancelledError unless it was answered already.
 */
export function manualUploads(): { uploads: ManualUpload[]; upload: DataSource['upload'] } {
  const uploads: ManualUpload[] = [];
  const upload: DataSource['upload'] = (file, options) => {
    let settled = false;
    let resolve!: (r: UploadResult) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<UploadResult>((res, rej) => {
      resolve = (r) => {
        if (!settled) (settled = true), res(r);
      };
      reject = (e) => {
        if (!settled) (settled = true), rej(e);
      };
    });
    const entry: ManualUpload = {
      file,
      options,
      cancelled: false,
      progress: (loaded, total = file.size) => options.onProgress?.({ loaded, total }),
      resolve,
      reject,
    };
    uploads.push(entry);
    return {
      done,
      cancel() {
        entry.cancelled = true;
        reject(new UploadCancelledError(file.name));
      },
    };
  };
  return { uploads, upload };
}

/** One subscription of the store to a manualLive source. */
export interface LiveSubscription {
  onEvent(event: LiveEvent): void;
  onStatus(status: LiveStatus): void;
  closed: boolean;
}

/** Live updates the test sends by hand to the open subscription. */
export function manualLive(): {
  subscriptions: LiveSubscription[];
  subscribe: DataSource['subscribe'];
  /** Sends events to every open subscription, in order. */
  emit(...events: LiveEvent[]): void;
  status(status: LiveStatus): void;
} {
  const subscriptions: LiveSubscription[] = [];
  const open = () => subscriptions.filter((s) => !s.closed);
  return {
    subscriptions,
    subscribe(onEvent, onStatus) {
      const sub: LiveSubscription = { onEvent, onStatus, closed: false };
      subscriptions.push(sub);
      return () => {
        sub.closed = true;
      };
    },
    emit: (...events) => events.forEach((e) => open().forEach((s) => s.onEvent(e))),
    status: (status) => open().forEach((s) => s.onStatus(status)),
  };
}

const initial = useAppStore.getState();

/**
 * Resets the store and loads `source` without init() (which would create the configured source):
 * the data is ready and `reviewUid` / `selectedUid` point at the given borehole. Live updates are
 * not subscribed (call startLive()).
 */
export async function readyStore(source: DataSource, uid: string | null = null): Promise<void> {
  useAppStore.getState().stopLive();
  useAppStore.setState(initial, true);
  const { boreholes, documents } = await source.load();
  useAppStore.setState({ source, loadState: 'ready', boreholes, documents, reviewUid: uid, selectedUid: uid, health: await source.health() });
}

/** Lets every queued promise reaction run. */
export const settle = () => new Promise((r) => setTimeout(r, 0));

/** A File of `bytes` bytes (fictional content). */
export const testFile = (name: string, bytes = 1, relativePath?: string): File => {
  const f = new File([new Uint8Array(bytes)], name);
  if (relativePath !== undefined) Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
  return f;
};
