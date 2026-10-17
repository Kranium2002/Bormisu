/**
 * Test helpers for the store: a fake data source over fictional in-memory data that behaves like the
 * backend (saves bump the revision and answer with the record; the boot loads documents, the map
 * features of the plotted boreholes and the records of the unplotted ones), uploads and live updates
 * the test drives by hand, and a store reset. Not used by the app.
 */
import type { DataSource, UploadHandle, UploadOptions } from '../data/DataSource';
import { ApiError, UploadCancelledError } from '../data/errors';
import { applyValuePatch } from '../domain/review';
import { displayStatus, isClean } from '../domain/status';
import type {
  Borehole,
  BoreholeFilter,
  Clarification,
  DocumentSummary,
  Health,
  LiveEvent,
  LiveStatus,
  MapFeature,
  ResultSet,
  UploadResult,
} from '../domain/types';
import { useAppStore } from './appStore';
import { plotted, withReviewTarget } from './context';

/** Health of a working server with fictional limits. */
export function makeHealth(o: Partial<Health> = {}): Health {
  return {
    mode: 'live',
    status: 'ok',
    version: 'test',
    providers: { ocr: true, classifier: true, extractor: true, chat: true, geocoder: true },
    upload: { maxMb: 1, extensions: ['.pdf', '.png'] },
    auth: { enabled: false, registration: 'closed' },
    ...o,
  };
}

/** What the fake server holds: every full record, the documents and the questions. */
export interface FakeData {
  boreholes: Borehole[];
  documents: DocumentSummary[];
  /** Questions, any status (default none). */
  clarifications?: Clarification[];
}

/** A fake source plus what it holds, for assertions. */
export type FakeSource = DataSource & {
  held: Map<string, Borehole>;
  /** The questions as the fake server holds them, by id. */
  questions: Map<string, Clarification>;
  /** Result sets it stored, by id. */
  resultSets: Map<string, ResultSet>;
};

const clone = <T>(x: T): T => structuredClone(x);

/**
 * The map feature the backend's light layer has for a plotted record (null when not plotted), as
 * GET /map/boreholes.geojson derives it: attention for a flag, a lint error or an open question.
 */
export function featureOf(b: Borehole): MapFeature | null {
  if (!plotted(b)) return null;
  return {
    uid: b.uid,
    id: b.id,
    project: b.project || null,
    documentId: b.documentId,
    lat: b.lat as number,
    lng: b.lng as number,
    depth: b.finalDepth,
    reviewStatus: b.reviewStatus,
    crsStatus: b.crs.status,
    revision: b.revision,
    attention: displayStatus(b) === 'attention',
    openClarifications: b.openClarifications,
  };
}

/** A fictional question with the contract's shape (a text field) about `o.boreholeUids`. */
export function makeClarification(o: Partial<Clarification> & Pick<Clarification, 'id'>): Clarification {
  return {
    kind: 'unit_ambiguous',
    status: 'open',
    documentId: 'doc_TEST0000000000000000000001',
    boreholeUids: [],
    path: null,
    question: 'Which unit do the depths of this fictional log use?',
    fields: [{ name: 'unit', widget: 'select', label: 'Unit', help: null, required: true, unitOptions: [], options: [], default: undefined }],
    evidence: [],
    answer: null,
    answeredBy: null,
    createdAt: '2026-10-17T08:00:00Z',
    resolvedAt: null,
    ...o,
  };
}

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

/** True when a plotted record matches the simple parts of a filter the fake server understands. */
function matches(b: Borehole, f: BoreholeFilter): boolean {
  if (!f.includeUnreviewed && b.reviewStatus !== 'approved') return false;
  if (f.reviewStatus.length && !f.reviewStatus.includes(b.reviewStatus)) return false;
  if (f.documentId && b.documentId !== f.documentId) return false;
  if (f.project && b.project !== f.project) return false;
  if (f.search && !`${b.id} ${b.project}`.toLowerCase().includes(f.search.toLowerCase())) return false;
  if (f.minDepth != null && (b.finalDepth == null || b.finalDepth < f.minDepth)) return false;
  if (f.maxDepth != null && (b.finalDepth == null || b.finalDepth > f.maxDepth)) return false;
  if (f.area?.type === 'bbox') {
    const [minLon, minLat, maxLon, maxLat] = f.area.bbox;
    if (b.lat == null || b.lng == null || b.lat < minLat || b.lat > maxLat || b.lng < minLon || b.lng > maxLon) return false;
  }
  return true;
}

/**
 * A data source over `data`. It keeps its own copy of the boreholes ("the server"): saves apply the
 * patch, bump the revision and resolve with the record; approve-clean and CRS confirmation change
 * it the same way. The boot answers with the documents, the features of the plotted records and the
 * unplotted records. Uploads answer at once with a queued document; live updates never come (use
 * manualLive). Result sets keep the plotted matches of simple filters; geocode finds nothing; answers
 * resolve the fake server's question. Any method can be replaced through `over`.
 */
export function fakeSource(data: FakeData, over: Partial<DataSource> = {}): FakeSource {
  const held = new Map(data.boreholes.map((b) => [b.uid, clone(b)]));
  const questions = new Map((data.clarifications ?? []).map((c) => [c.id, clone(c)]));
  const resultSets = new Map<string, ResultSet>();
  const get = (uid: string) => {
    const b = held.get(uid);
    if (!b) throw new ApiError(404, 'borehole_not_found', `Borehole ${uid} not found.`);
    return b;
  };
  const ofDocument = (id: string) => [...held.values()].filter((b) => b.documentId === id);
  const features = (documentId?: string) =>
    [...held.values()]
      .filter((b) => documentId === undefined || b.documentId === documentId)
      .map(featureOf)
      .filter((f): f is MapFeature => !!f);
  const unplotted = () => [...held.values()].filter((b) => !plotted(b)).map(clone);
  const question = (id: string) => {
    const c = questions.get(id);
    if (!c) throw new ApiError(404, 'clarification_not_found', `Clarification ${id} not found.`);
    return c;
  };
  const source: DataSource = {
    kind: 'sample',
    health: async () => makeHealth(),
    load: async () => ({ documents: clone(data.documents), features: features(), unplotted: unplotted() }),
    mapFeatures: async (documentId) => features(documentId),
    unplotted: async () => unplotted(),
    createResultSet: async (filter) => {
      const all = [...held.values()].filter((b) => matches(b, filter));
      const located = all.filter(plotted);
      const id = `rs_TEST_${resultSets.size + 1}`;
      const rs: ResultSet = {
        id,
        count: all.length,
        locatedCount: located.length,
        unlocatedCount: all.length - located.length,
        excludedUnreviewed: null,
        uids: all.map((b) => b.uid),
        bbox: located.length
          ? [
              Math.min(...located.map((b) => b.lng as number)),
              Math.min(...located.map((b) => b.lat as number)),
              Math.max(...located.map((b) => b.lng as number)),
              Math.max(...located.map((b) => b.lat as number)),
            ]
          : filter.area?.type === 'bbox'
            ? filter.area.bbox
            : null,
        area: filter.area,
        definition: clone(filter),
        createdAt: '2026-10-17T08:00:00Z',
      };
      resultSets.set(id, rs);
      return clone(rs);
    },
    getResultSet: async (id) => {
      const rs = resultSets.get(id);
      if (!rs) throw new ApiError(404, 'result_set_not_found', `Result set ${id} not found.`);
      return clone(rs);
    },
    resultSetFeatures: async (id) => {
      const rs = resultSets.get(id);
      if (!rs) throw new ApiError(404, 'result_set_not_found', `Result set ${id} not found.`);
      return rs.uids.map((uid) => held.get(uid)).flatMap((b) => (b ? [featureOf(b)].filter((f): f is MapFeature => !!f) : []));
    },
    geocode: async () => [],
    clarifications: async (options) => {
      const status = options?.status ?? 'open';
      return [...questions.values()]
        .filter((c) => c.status === status && (!options?.documentId || c.documentId === options.documentId))
        .map(clone);
    },
    answerClarification: async (id, values, answeredBy) => {
      const c = question(id);
      if (c.status === 'answered') throw new ApiError(409, 'already_resolved', 'This clarification was already answered.');
      const next: Clarification = { ...c, status: 'answered', answer: clone(values), answeredBy, resolvedAt: '2026-10-17T09:00:00Z' };
      questions.set(id, next);
      return clone(next);
    },
    skipClarification: async (id) => {
      const c = question(id);
      if (c.status === 'answered') throw new ApiError(409, 'already_resolved', 'This clarification was already answered.');
      const next: Clarification = { ...c, status: 'skipped' };
      questions.set(id, next);
      return clone(next);
    },
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
    // No sign-in unless a test turns it on (health.auth) and overrides these.
    currentUser: async () => null,
    signIn: async () => {
      throw new Error('The fake source has no sign-in');
    },
    register: async () => {
      throw new Error('The fake source has no sign-in');
    },
    signOut: async () => undefined,
    setSessionListener: () => undefined,
    ...over,
  };
  return Object.assign(source, { held, questions, resultSets });
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

export interface ReadyOptions {
  /**
   * What the boreholes cache holds: 'all' every record the fake server holds (in its order), as if
   * each had been fetched on demand already (the default, for tests of review, search and exports);
   * 'boot' only what the boot loads (the unplotted records), as in the app right after init.
   */
  cache?: 'all' | 'boot';
}

/**
 * Resets the store and loads `source` like the boot does, without init() (which would create the
 * configured source): documents, map features, the NOT ON MAP list and the cache of full records
 * (see ReadyOptions). `reviewUid` / `selectedUid` point at the given borehole. Live updates are not
 * subscribed (call startLive()) and the questions are not loaded (call loadClarifications()).
 */
export async function readyStore(source: DataSource, uid: string | null = null, options: ReadyOptions = {}): Promise<void> {
  useAppStore.getState().stopLive();
  useAppStore.setState(initial, true);
  const loaded = await source.load();
  const { documents } = loaded;
  const features = loaded.features ?? [];
  const unplotted = loaded.unplotted ?? [];
  const held = (source as Partial<FakeSource>).held;
  const boreholes = (options.cache ?? 'all') === 'all' && held ? [...held.values()].map(clone) : unplotted;
  // Review targets as the boot fills them in (from the pins and the NOT ON MAP records).
  const known = { boreholes: unplotted, features, unplottedUids: unplotted.map((b) => b.uid) };
  useAppStore.setState({
    source,
    loadState: 'ready',
    boreholes,
    documents: documents.map((d) => withReviewTarget(d, undefined, known)),
    features,
    unplottedUids: known.unplottedUids,
    reviewUid: uid,
    selectedUid: uid,
    health: await source.health(),
  });
}

/** Lets every queued promise reaction run. */
export const settle = () => new Promise((r) => setTimeout(r, 0));

/** A File of `bytes` bytes (fictional content). */
export const testFile = (name: string, bytes = 1, relativePath?: string): File => {
  const f = new File([new Uint8Array(bytes)], name);
  if (relativePath !== undefined) Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
  return f;
};
