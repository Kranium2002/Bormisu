/**
 * Live updates in the store (realtime-and-chat.md section 1, "Client action"), driven by a fake
 * source whose events the test sends by hand. Fictional data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { K } from '../domain/keys';
import type { Borehole, DocumentSummary, LiveEvent } from '../domain/types';
import { canOpenReview } from '../screens/queue/queueView';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { fakeSource, featureOf, makeClarification, makeHealth, manualLive, readyStore, settle, type FakeSource } from './testing';

/** init() asks createDataSource once; it gets a proxy that forwards to the current fake source. */
let current: DataSource;
const proxy = new Proxy({} as DataSource, {
  get: (_t, prop: keyof DataSource) => {
    const v = current[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
  },
});
vi.mock('../data/createDataSource', () => ({
  createDataSource: async () => proxy,
  dataSourceKind: () => 'sample',
  apiBase: () => '/api/v1',
}));
const { useAppStore } = await import('./appStore');

const UID = makeBorehole().uid;
const doc = makeDocument({ reviewBoreholeUid: UID });
const NEW_DOC = 'doc_TEST_LIVE_000000000000001';
const NEW_UID = 'bh_TEST_LIVE_000000000000021';

const st = () => useAppStore.getState();
const bh = (uid: string) => st().boreholes.find((b) => b.uid === uid);
const docById = (id: string) => st().documents.find((d) => d.id === id);

let live: ReturnType<typeof manualLive>;

/** A fake source with manual live updates; `extra` boreholes are on the "server" but not loaded. */
async function ready(over: Partial<DataSource> = {}, documents: DocumentSummary[] = [doc], extra: Borehole[] = []) {
  live = manualLive();
  const fake = fakeSource({ boreholes: [makeBorehole(), ...extra], documents }, { subscribe: live.subscribe, ...over });
  current = fake;
  await readyStore(fake, UID);
  // The extra boreholes exist on the server only (created after the load): no record, pin or NOT ON MAP entry.
  const later = (uid: string) => extra.some((x) => x.uid === uid);
  useAppStore.setState({
    boreholes: st().boreholes.filter((b) => !later(b.uid)),
    features: st().features.filter((f) => !later(f.uid)),
    unplottedUids: st().unplottedUids.filter((uid) => !later(uid)),
  });
  st().startLive();
  return fake;
}

const updated = (d: DocumentSummary): LiveEvent => ({ type: 'document.updated', document: d });

describe('subscription', () => {
  beforeEach(() => {
    useAppStore.setState({ source: null, health: null, loadState: 'loading', boreholes: [], documents: [] });
  });

  it('init subscribes once after load and shows the transport status', async () => {
    const calls: string[] = [];
    live = manualLive();
    const fake = fakeSource({ boreholes: [makeBorehole()], documents: [doc] });
    const load = fake.load;
    fake.load = async () => (calls.push('load'), load());
    fake.subscribe = (onEvent, onStatus) => (calls.push('subscribe'), live.subscribe(onEvent, onStatus));
    current = fake;
    await st().init();
    expect(calls).toEqual(['load', 'subscribe']);
    expect(st().liveStatus).toBe('connecting');
    live.status('live');
    expect(st().liveStatus).toBe('live');
    live.status('polling');
    expect(st().liveStatus).toBe('polling');
    live.status('offline');
    expect(st().liveStatus).toBe('offline');
  });

  it('init again ends the old subscription first; events of the old one are ignored', async () => {
    live = manualLive();
    current = fakeSource({ boreholes: [makeBorehole()], documents: [doc] }, { subscribe: live.subscribe });
    await st().init();
    const [first] = live.subscriptions;
    await st().init();
    expect(live.subscriptions).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(live.subscriptions[1].closed).toBe(false);
    first.onEvent({ type: 'document.deleted', documentId: doc.id });
    first.onStatus('offline');
    expect(st().documents).toHaveLength(1);
    expect(st().liveStatus).not.toBe('offline');
  });

  it('a failed load subscribes to nothing', async () => {
    live = manualLive();
    current = fakeSource({ boreholes: [], documents: [] }, { subscribe: live.subscribe, load: () => Promise.reject(new Error('down')) });
    await st().init();
    expect(live.subscriptions).toHaveLength(0);
  });

  it('stopLive ends the subscription (app teardown)', async () => {
    await ready();
    st().stopLive();
    expect(live.subscriptions[0].closed).toBe(true);
    live.subscriptions[0].onEvent({ type: 'document.deleted', documentId: doc.id });
    expect(st().documents).toHaveLength(1);
  });

  it('init does not ask the store to follow loaded documents: the source follows what load returns', async () => {
    const follow = vi.fn<DataSource['follow']>();
    const extracting = makeDocument({ id: NEW_DOC, status: 'extracting', step: 1, reviewBoreholeUid: null });
    current = fakeSource({ boreholes: [makeBorehole()], documents: [doc, extracting] }, { follow });
    await st().init();
    expect(follow).not.toHaveBeenCalled();
  });
});

describe('document.updated', () => {
  it('replaces the document in place, keeping its review target and project', async () => {
    await ready();
    live.emit(updated({ ...doc, reviewBoreholeUid: null, project: '', openClarifications: 3 }));
    expect(st().documents).toHaveLength(1);
    expect(docById(doc.id)).toMatchObject({ reviewBoreholeUid: UID, project: doc.project, openClarifications: 3 });
  });

  it('inserts a document the store does not know yet (e.g. uploaded in another tab) and follows it while it is processed', async () => {
    const follow = vi.fn<DataSource['follow']>();
    await ready({ follow });
    const queued = makeDocument({ id: NEW_DOC, name: 'other_tab.pdf', status: 'classifying', step: 0, reviewBoreholeUid: null });
    live.emit(updated(queued));
    live.emit(updated(queued));
    expect(st().documents.map((d) => d.id)).toEqual([NEW_DOC, doc.id]);
    expect(follow).toHaveBeenCalledTimes(1);
    expect(follow).toHaveBeenCalledWith(NEW_DOC);
  });

  it('keeps the upload flags of a card when the event has none', async () => {
    const mine = makeDocument({ id: NEW_DOC, status: 'queued', step: 0, uploaded: true, reviewBoreholeUid: null });
    await ready({}, [mine, doc]);
    live.emit(updated({ ...mine, uploaded: undefined, status: 'classifying' }));
    expect(docById(NEW_DOC)).toMatchObject({ uploaded: true, status: 'classifying' });
  });
});

describe('F7: a document that reaches needs_review through events becomes reviewable without a reload', () => {
  const processing = makeDocument({ id: NEW_DOC, name: 'new_log.pdf', project: '', status: 'extracting', step: 1, reviewBoreholeUid: null, counts: null });
  const extracted = makeBorehole({ uid: NEW_UID, id: 'TB-21', documentId: NEW_DOC, project: 'Live Project (fictional)' });

  /** Map-layer requests for the new document. */
  const pinCalls = (mapFeatures: ReturnType<typeof vi.fn<DataSource['mapFeatures']>>) => mapFeatures.mock.calls.filter(([id]) => id === NEW_DOC);

  it('loads its pins once, points the card at one, and Review and the map can show them', async () => {
    const fake = await ready({ getDocument: async () => ({ ...processing, status: 'needs_review', step: 2 }) }, [processing, doc], [extracted]);
    const mapFeatures = vi.fn(fake.mapFeatures);
    fake.mapFeatures = mapFeatures;
    live.emit(updated({ ...processing, progress: { pagesTotal: 4, pagesClassified: 4, pagesOcrTotal: 2, pagesOcrDone: 1, boreholesExtracted: 0 } }));
    expect(docById(NEW_DOC)?.progress?.pagesOcrDone).toBe(1);
    expect(canOpenReview(docById(NEW_DOC)!)).toBe(false);

    const review = { ...processing, status: 'needs_review' as const, step: 2 as const };
    live.emit(updated(review));
    live.emit(updated(review));
    await vi.waitFor(() => expect(docById(NEW_DOC)?.reviewBoreholeUid).toBe(NEW_UID));
    expect(pinCalls(mapFeatures)).toHaveLength(1);
    // The card's OPEN REVIEW works and takes the project from its boreholes.
    const card = docById(NEW_DOC)!;
    expect(canOpenReview(card)).toBe(true);
    expect(card.project).toBe('Live Project (fictional)');
    // Its pin is on the map; Review opens it and loads the record on demand.
    expect(st().features.find((f) => f.uid === NEW_UID)).toMatchObject({ id: 'TB-21', documentId: NEW_DOC });
    expect(bh(NEW_UID)).toBeUndefined();
    st().openReview(card.reviewBoreholeUid!);
    expect(st()).toMatchObject({ screen: 'review', reviewUid: NEW_UID });
    await vi.waitFor(() => expect(st().focusKey).not.toBeNull());
    expect(bh(NEW_UID)).toMatchObject({ id: 'TB-21', onMap: true });
    // A later update (all approved) does not load them again.
    live.emit(updated({ ...review, status: 'done', step: 3 }));
    await settle();
    expect(pinCalls(mapFeatures)).toHaveLength(1);
    expect(docById(NEW_DOC)?.reviewBoreholeUid).toBe(NEW_UID);
  });

  it('boreholes created during extraction come one by one as pins, then the document’s pins are reloaded', async () => {
    const second = makeBorehole({ uid: 'bh_TEST_LIVE_000000000000022', id: 'TB-22', documentId: NEW_DOC });
    const fake = await ready({}, [processing, doc], [extracted]);
    live.emit({ type: 'borehole.created', uid: NEW_UID, documentId: NEW_DOC, revision: 1, plotted: true });
    await vi.waitFor(() => expect(st().features.map((f) => f.uid)).toContain(NEW_UID));
    expect(st().features.map((f) => f.uid)).not.toContain(second.uid);
    fake.held.set(second.uid, second);
    fake.getDocument = async () => ({ ...processing, status: 'needs_review', step: 2 });
    live.emit(updated({ ...processing, status: 'needs_review', step: 2 }));
    await vi.waitFor(() => expect(st().features.map((f) => f.uid)).toContain(second.uid));
    expect(st().features.filter((f) => f.documentId === NEW_DOC).map((f) => f.uid)).toEqual([NEW_UID, second.uid]);
    expect(docById(NEW_DOC)?.reviewBoreholeUid).toBe(NEW_UID);
  });

  it('pins that arrive after the needs_review update still give the card its Review target', async () => {
    // borehole.created only refreshes the document's pins (records stay on demand); that request is
    // still running when the document reaches review.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const mapFeatures = vi.fn<DataSource['mapFeatures']>(async (id) => {
      await held;
      return id === NEW_DOC ? [featureOf(extracted)!] : [];
    });
    await ready({ mapFeatures }, [processing, doc], [extracted]);
    live.emit({ type: 'borehole.created', uid: NEW_UID, documentId: NEW_DOC, revision: 1, plotted: true });
    live.emit(updated({ ...processing, status: 'needs_review', step: 2 }));
    await settle();
    expect(docById(NEW_DOC)?.reviewBoreholeUid).toBeNull();
    release();
    await vi.waitFor(() => expect(docById(NEW_DOC)?.reviewBoreholeUid).toBe(NEW_UID));
    expect(canOpenReview(docById(NEW_DOC)!)).toBe(true);
  });

  it('an unplotted borehole whose record arrives after the needs_review update gives the card its Review target', async () => {
    // No pin will come for it: the borehole.created record is the only thing that names the document's borehole.
    const unplotted = makeBorehole({ uid: NEW_UID, id: 'TB-21', documentId: NEW_DOC, lat: null, lng: null, onMap: false, unplottedReason: 'no_coordinates' });
    const inReview = { ...processing, status: 'needs_review' as const, step: 2 as const };
    await ready({ mapFeatures: async () => [] }, [inReview, doc], [unplotted]);
    // The store has not heard of the borehole yet, so the card has no Review target.
    useAppStore.setState({ documents: st().documents.map((d) => (d.id === NEW_DOC ? { ...d, reviewBoreholeUid: null } : d)) });
    live.emit({ type: 'borehole.created', uid: NEW_UID, documentId: NEW_DOC, revision: 1, plotted: false });
    await vi.waitFor(() => expect(st().unplottedUids).toContain(NEW_UID));
    expect(docById(NEW_DOC)?.reviewBoreholeUid).toBe(NEW_UID);
    expect(canOpenReview(docById(NEW_DOC)!)).toBe(true);
  });

  it('a document seen for the first time at needs_review loads its pins too', async () => {
    const mapFeatures = vi.fn<DataSource['mapFeatures']>(async (id) => (id === NEW_DOC ? [featureOf(extracted)!] : []));
    await ready({ mapFeatures, getDocument: async () => ({ ...processing, status: 'needs_review', step: 2 }) });
    live.emit(updated({ ...processing, status: 'needs_review', step: 2 }));
    await vi.waitFor(() => expect(docById(NEW_DOC)?.reviewBoreholeUid).toBe(NEW_UID));
    expect(mapFeatures).toHaveBeenCalledWith(NEW_DOC);
  });

  it('a failed document loads nothing', async () => {
    const mapFeatures = vi.fn<DataSource['mapFeatures']>(async () => []);
    const documentBoreholes = vi.fn<DataSource['documentBoreholes']>(async () => []);
    await ready({ mapFeatures, documentBoreholes }, [processing, doc]);
    live.emit(updated({ ...processing, status: 'failed', error: 'OCR failed' }));
    await settle();
    expect(mapFeatures).not.toHaveBeenCalled();
    expect(documentBoreholes).not.toHaveBeenCalled();
  });
});

describe('borehole.created and borehole.updated', () => {
  const extracted = makeBorehole({ uid: NEW_UID, id: 'TB-21', documentId: doc.id });

  it('borehole.created of a plotted borehole reloads its document’s pins once; no full record is fetched', async () => {
    const getBorehole = vi.fn<DataSource['getBorehole']>(async () => structuredClone(extracted));
    const fake = await ready({ getBorehole }, [doc], [extracted]);
    const mapFeatures = vi.fn(fake.mapFeatures);
    fake.mapFeatures = mapFeatures;
    const created: LiveEvent = { type: 'borehole.created', uid: NEW_UID, documentId: doc.id, revision: 1, plotted: true };
    live.emit(created);
    await vi.waitFor(() => expect(st().features.map((f) => f.uid)).toContain(NEW_UID));
    live.emit(created);
    await settle();
    expect(mapFeatures).toHaveBeenCalledTimes(1);
    expect(mapFeatures).toHaveBeenCalledWith(doc.id);
    expect(st().features.filter((f) => f.uid === NEW_UID)).toHaveLength(1);
    expect(getBorehole).not.toHaveBeenCalled();
  });

  it('borehole.created of an unplotted borehole fetches its record once and lists it under NOT ON MAP', async () => {
    const off = makeBorehole({ uid: NEW_UID, id: 'TB-21', documentId: doc.id, onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });
    const fake = await ready({}, [doc], [off]);
    const getBorehole = vi.fn(fake.getBorehole);
    fake.getBorehole = getBorehole;
    const created: LiveEvent = { type: 'borehole.created', uid: NEW_UID, documentId: doc.id, revision: 1, plotted: false };
    live.emit(created);
    await vi.waitFor(() => expect(bh(NEW_UID)).toBeDefined());
    live.emit(created);
    await settle();
    expect(getBorehole).toHaveBeenCalledTimes(1);
    expect(st().unplottedUids).toContain(NEW_UID);
    expect(st().boreholes.filter((b) => b.uid === NEW_UID)).toHaveLength(1);
  });

  it('borehole.updated of a pin without a cached record reloads its document’s pins (newer revisions only)', async () => {
    const fake = await ready({}, [doc]);
    useAppStore.setState({ boreholes: [] });
    const mapFeatures = vi.fn(fake.mapFeatures);
    const getBorehole = vi.fn(fake.getBorehole);
    Object.assign(fake, { mapFeatures, getBorehole });
    live.emit({ type: 'borehole.updated', uid: UID, revision: 1 });
    await settle();
    expect(mapFeatures).not.toHaveBeenCalled();
    fake.held.set(UID, { ...fake.held.get(UID)!, revision: 2, reviewStatus: 'approved' });
    live.emit({ type: 'borehole.updated', uid: UID, revision: 2 });
    await vi.waitFor(() => expect(st().features.find((f) => f.uid === UID)?.reviewStatus).toBe('approved'));
    expect(mapFeatures).toHaveBeenCalledWith(doc.id);
    expect(getBorehole).not.toHaveBeenCalled();
  });

  it('a cached unplotted record that the server placed leaves NOT ON MAP and brings its pin', async () => {
    const off = makeBorehole({ onMap: false, lat: null, lng: null, unplottedReason: 'crs_unconfirmed' });
    const fake = await ready({}, [doc]);
    useAppStore.setState({ boreholes: [off], features: [], unplottedUids: [UID] });
    fake.held.set(UID, { ...makeBorehole(), revision: 2 });
    live.emit({ type: 'borehole.updated', uid: UID, revision: 2 });
    await vi.waitFor(() => expect(st().features.map((f) => f.uid)).toEqual([UID]));
    expect(st().unplottedUids).toEqual([]);
    expect(bh(UID)?.onMap).toBe(true);
  });

  it('borehole.updated refetches only when the store holds an older revision', async () => {
    const fake = await ready();
    const getBorehole = vi.fn(fake.getBorehole);
    fake.getBorehole = getBorehole;
    live.emit({ type: 'borehole.updated', uid: UID, revision: 1 });
    await settle();
    expect(getBorehole).not.toHaveBeenCalled();
    fake.held.set(UID, { ...fake.held.get(UID)!, revision: 2, reviewStatus: 'approved' });
    live.emit({ type: 'borehole.updated', uid: UID, revision: 2 });
    await vi.waitFor(() => expect(bh(UID)?.revision).toBe(2));
    expect(bh(UID)?.reviewStatus).toBe('approved');
    expect(getBorehole).toHaveBeenCalledTimes(1);
  });

  it('borehole.updated for a borehole the store does not hold fetches it', async () => {
    const getBorehole = vi.fn<DataSource['getBorehole']>(async () => structuredClone(extracted));
    await ready({ getBorehole });
    live.emit({ type: 'borehole.updated', uid: NEW_UID, revision: 3 });
    await vi.waitFor(() => expect(bh(NEW_UID)).toBeDefined());
  });

  it('coalesces a burst: one refetch at a time per borehole, then one more for the newest revision', async () => {
    const fake = await ready();
    const answers: ((b: Borehole) => void)[] = [];
    const getBorehole = vi.fn<DataSource['getBorehole']>(() => new Promise((r) => answers.push(r)));
    fake.getBorehole = getBorehole;
    const rec = (revision: number) => ({ ...structuredClone(fake.held.get(UID)!), revision });
    for (const revision of [2, 3, 4, 5]) live.emit({ type: 'borehole.updated', uid: UID, revision });
    expect(getBorehole).toHaveBeenCalledTimes(1);
    answers[0](rec(3));
    await vi.waitFor(() => expect(getBorehole).toHaveBeenCalledTimes(2));
    expect(bh(UID)?.revision).toBe(3);
    answers[1](rec(5));
    await vi.waitFor(() => expect(bh(UID)?.revision).toBe(5));
    await settle();
    expect(getBorehole).toHaveBeenCalledTimes(2);
  });

  it('no second refetch when the first answer is already the newest revision', async () => {
    const fake = await ready();
    const answers: ((b: Borehole) => void)[] = [];
    const getBorehole = vi.fn<DataSource['getBorehole']>(() => new Promise((r) => answers.push(r)));
    fake.getBorehole = getBorehole;
    live.emit({ type: 'borehole.updated', uid: UID, revision: 2 }, { type: 'borehole.updated', uid: UID, revision: 3 });
    answers[0]({ ...structuredClone(fake.held.get(UID)!), revision: 3 });
    await vi.waitFor(() => expect(bh(UID)?.revision).toBe(3));
    await settle();
    expect(getBorehole).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending save’s optimistic state: the refetched record is applied once the save settles', async () => {
    const fake = await ready();
    let answerSave: (b: Borehole) => void = () => undefined;
    fake.updateValue = () => new Promise((r) => (answerSave = r));
    st().toggleApprove(K.finalDepth);
    const elsewhere = { ...structuredClone(fake.held.get(UID)!), revision: 2 };
    fake.held.set(UID, elsewhere);
    live.emit({ type: 'borehole.updated', uid: UID, revision: 2 });
    await settle();
    expect(bh(UID)?.values.find((v) => v.key === K.finalDepth)?.status).toBe('approved');
    expect(bh(UID)?.revision).toBe(1);
    answerSave({ ...elsewhere, revision: 3, values: bh(UID)!.values });
    await vi.waitFor(() => expect(bh(UID)?.revision).toBe(3));
    expect(bh(UID)?.values.find((v) => v.key === K.finalDepth)?.status).toBe('approved');
  });

  it('a failed refetch is logged and the next event tries again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = await ready();
    fake.getBorehole = () => Promise.reject(new Error('offline'));
    live.emit({ type: 'borehole.updated', uid: UID, revision: 2 });
    await settle();
    expect(warn).toHaveBeenCalled();
    fake.getBorehole = async () => ({ ...structuredClone(fake.held.get(UID)!), revision: 2 });
    live.emit({ type: 'borehole.updated', uid: UID, revision: 2 });
    await vi.waitFor(() => expect(bh(UID)?.revision).toBe(2));
    warn.mockRestore();
  });
});

describe('document.deleted', () => {
  const second = makeDocument({ id: NEW_DOC, name: 'second.pdf', reviewBoreholeUid: NEW_UID });
  const other = makeBorehole({ uid: NEW_UID, id: 'TB-21', documentId: NEW_DOC });

  async function readyTwo() {
    await ready({}, [doc, second]);
    useAppStore.setState({ boreholes: [...st().boreholes, other], features: [...st().features, featureOf(other)!] });
  }

  it('removes the document, its boreholes, pins, NOT ON MAP entries, cached pages and failure, and nothing else', async () => {
    await readyTwo();
    const off = makeBorehole({ uid: 'bh_TEST_LIVE_OFF', id: 'TB-23', documentId: NEW_DOC, onMap: false, lat: null, lng: null });
    useAppStore.setState({
      screen: 'queue',
      boreholes: [...st().boreholes, off],
      unplottedUids: [off.uid],
      recordLoads: { bh_TEST_LIVE_GONE: 'loading', [off.uid]: 'error' },
      pages: { [`${NEW_DOC}:1`]: { status: 'loading' }, [`${doc.id}:1`]: { status: 'loading' } },
      jobFailures: { [NEW_DOC]: { stage: 'ocr', detail: 'x', retryable: true } },
    });
    live.emit({ type: 'document.deleted', documentId: NEW_DOC });
    expect(st().documents.map((d) => d.id)).toEqual([doc.id]);
    expect(st().boreholes.map((b) => b.uid)).toEqual([UID]);
    expect(st().features.map((f) => f.uid)).toEqual([UID]);
    expect(st().unplottedUids).toEqual([]);
    expect(st().recordLoads).toEqual({ bh_TEST_LIVE_GONE: 'loading' });
    expect(Object.keys(st().pages)).toEqual([`${doc.id}:1`]);
    expect(st().jobFailures).toEqual({});
    expect(st().screen).toBe('queue');
    expect(st().toast).toBeNull();
    // Idempotent; an unknown id changes nothing.
    live.emit({ type: 'document.deleted', documentId: NEW_DOC }, { type: 'document.deleted', documentId: 'doc_UNKNOWN' });
    expect(st().documents).toHaveLength(1);
  });

  it('leaves Review with a toast when it shows one of the removed boreholes', async () => {
    await readyTwo();
    st().openReview(NEW_UID);
    useAppStore.setState({ panel: { kind: 'source', documentId: NEW_DOC, page: 1 } });
    live.emit({ type: 'document.deleted', documentId: NEW_DOC });
    expect(st().screen).not.toBe('review');
    expect(st().reviewUid).not.toBe(NEW_UID);
    expect(st().panel).toBeNull();
    expect(st().toast?.text).toBe('second.pdf was deleted; its boreholes were removed.');
  });

  it('leaves Detail with a toast when it shows one of the removed boreholes', async () => {
    await readyTwo();
    st().openBorehole(NEW_UID);
    live.emit({ type: 'document.deleted', documentId: NEW_DOC });
    expect(st().screen).toBe('map');
    expect(st().selectedUid).toBeNull();
    expect(st().toast?.text).toBe('second.pdf was deleted; its boreholes were removed.');
  });

  it('a borehole fetch that answers after the deletion is dropped', async () => {
    let answer: (b: Borehole) => void = () => undefined;
    await ready({ getBorehole: () => new Promise((r) => (answer = r)) }, [doc, second]);
    live.emit({ type: 'borehole.created', uid: NEW_UID, documentId: NEW_DOC, revision: 1, plotted: true });
    live.emit({ type: 'document.deleted', documentId: NEW_DOC });
    answer(structuredClone(other));
    await settle();
    expect(bh(NEW_UID)).toBeUndefined();
  });
});

describe('job.failed', () => {
  const failing = makeDocument({ id: NEW_DOC, name: 'scan.pdf', status: 'extracting', step: 1, reviewBoreholeUid: null });

  it('keeps the stage, detail and retryable flag until the document runs again', async () => {
    await ready({}, [failing, doc]);
    live.emit(
      updated({ ...failing, status: 'failed', error: 'OCR failed' }),
      { type: 'job.failed', documentId: NEW_DOC, stage: 'ocr', detail: 'Text recognition failed on page 2.', retryable: true },
    );
    expect(st().jobFailures[NEW_DOC]).toEqual({ stage: 'ocr', detail: 'Text recognition failed on page 2.', retryable: true });
    // The same event again changes nothing; another failed update keeps it.
    live.emit({ type: 'job.failed', documentId: NEW_DOC, stage: 'ocr', detail: 'Text recognition failed on page 2.', retryable: true });
    live.emit(updated({ ...failing, status: 'failed', error: 'OCR failed' }));
    expect(Object.keys(st().jobFailures)).toEqual([NEW_DOC]);
    live.emit(updated({ ...failing, status: 'queued', step: 0, error: null }));
    expect(st().jobFailures).toEqual({});
  });

  it('retryDocument re-queues, forgets the failure and asks the source to follow the document', async () => {
    const retry = vi.fn<DataSource['retry']>(async () => undefined);
    const follow = vi.fn<DataSource['follow']>();
    const failed = { ...failing, status: 'failed' as const, error: 'OCR failed' };
    await ready({ retry, follow, getDocument: async () => ({ ...failing, status: 'queued', step: 0, error: null }) }, [failed, doc]);
    live.emit({ type: 'job.failed', documentId: NEW_DOC, stage: 'ocr', detail: 'x', retryable: true });
    await st().retryDocument(NEW_DOC);
    expect(retry).toHaveBeenCalledWith(NEW_DOC);
    expect(follow).toHaveBeenCalledWith(NEW_DOC);
    expect(st().jobFailures).toEqual({});
    expect(docById(NEW_DOC)).toMatchObject({ status: 'queued', error: null });
  });

  it('retry stays off in demo mode', async () => {
    const retry = vi.fn<DataSource['retry']>(async () => undefined);
    await ready({ retry, health: async () => makeHealth({ mode: 'demo' }) }, [failing, doc]);
    live.emit({ type: 'job.failed', documentId: NEW_DOC, stage: 'ocr', detail: 'x', retryable: true });
    await st().retryDocument(NEW_DOC);
    expect(retry).not.toHaveBeenCalled();
    expect(st().jobFailures[NEW_DOC]).toBeDefined();
  });
});

describe('clarification.created and clarification.resolved', () => {
  it('refetch the affected document, boreholes and pins, so the open-question badges and pin colours stay right', async () => {
    const fake = await ready();
    const getDocument = vi.fn<DataSource['getDocument']>(async () => ({ ...doc, openClarifications: 1 }));
    const getBorehole = vi.fn<DataSource['getBorehole']>(async () => ({ ...structuredClone(fake.held.get(UID)!), openClarifications: 1 }));
    const mapFeatures = vi.fn(fake.mapFeatures);
    Object.assign(fake, { getDocument, getBorehole, mapFeatures });
    fake.held.set(UID, { ...fake.held.get(UID)!, openClarifications: 1 });
    const question = makeClarification({ id: 'cl_TEST_1', documentId: doc.id, boreholeUids: [UID, 'bh_UNKNOWN'] });
    live.emit({ type: 'clarification.created', clarification: question });
    // The question joins the inbox at once (the event carries all of it).
    expect(st().clarifications.map((c) => c.id)).toEqual(['cl_TEST_1']);
    await vi.waitFor(() => expect(docById(doc.id)?.openClarifications).toBe(1));
    await vi.waitFor(() => expect(bh(UID)?.openClarifications).toBe(1));
    await vi.waitFor(() => expect(st().features.find((f) => f.uid === UID)?.attention).toBe(true));
    // Boreholes the store does not hold are left to borehole.created.
    expect(getBorehole).toHaveBeenCalledTimes(1);
    expect(mapFeatures).toHaveBeenCalledWith(doc.id);

    getDocument.mockImplementation(async () => ({ ...doc, openClarifications: 0 }));
    getBorehole.mockImplementation(async () => ({ ...structuredClone(fake.held.get(UID)!), openClarifications: 0 }));
    fake.held.set(UID, { ...fake.held.get(UID)!, openClarifications: 0 });
    live.emit({ type: 'clarification.resolved', clarificationId: 'cl_TEST_1', status: 'answered' });
    expect(st().clarifications).toEqual([]);
    await vi.waitFor(() => expect(docById(doc.id)?.openClarifications).toBe(0));
    await vi.waitFor(() => expect(bh(UID)?.openClarifications).toBe(0));
    await vi.waitFor(() => expect(st().features.find((f) => f.uid === UID)?.attention).toBe(false));
  });

  it('a question skipped elsewhere stays in the inbox as skipped; one listed before uses its own boreholes', async () => {
    const fake = await ready();
    const listed = makeClarification({ id: 'cl_TEST_2', documentId: doc.id, boreholeUids: [UID] });
    useAppStore.setState({ clarifications: [listed] });
    const getBorehole = vi.fn(fake.getBorehole);
    fake.getBorehole = getBorehole;
    live.emit({ type: 'clarification.resolved', clarificationId: 'cl_TEST_2', status: 'skipped' });
    expect(st().clarifications).toMatchObject([{ id: 'cl_TEST_2', status: 'skipped' }]);
    await vi.waitFor(() => expect(getBorehole).toHaveBeenCalledWith(UID));
  });

  it('1.2.0: a resolved clarification names its document and boreholes: only those are refetched, never a sweep', async () => {
    const quiet = makeDocument({ id: NEW_DOC, name: 'quiet.pdf', openClarifications: 3 });
    const fake = await ready({}, [{ ...doc, openClarifications: 1 }, quiet]);
    const getDocument = vi.fn<DataSource['getDocument']>(async (id) => (id === doc.id ? { ...doc, openClarifications: 0 } : quiet));
    const getBorehole = vi.fn(fake.getBorehole);
    Object.assign(fake, { getDocument, getBorehole });
    live.emit({ type: 'clarification.resolved', clarificationId: 'cl_NEVER_SEEN', status: 'answered', documentId: doc.id, boreholeUids: [UID] });
    await vi.waitFor(() => expect(docById(doc.id)?.openClarifications).toBe(0));
    await vi.waitFor(() => expect(getBorehole).toHaveBeenCalledWith(UID));
    // The other document with open questions is not refetched (the 1.1.0 sweep is not needed).
    expect(getDocument).not.toHaveBeenCalledWith(NEW_DOC);
  });

  it('a resolved clarification the store never saw refetches what shows open questions', async () => {
    const quiet = makeDocument({ id: NEW_DOC, name: 'quiet.pdf', openClarifications: 0 });
    const asking = { ...doc, openClarifications: 2 };
    const fake = await ready({}, [asking, quiet]);
    useAppStore.setState({ boreholes: st().boreholes.map((b) => ({ ...b, openClarifications: 1 })) });
    const getDocument = vi.fn<DataSource['getDocument']>(async () => ({ ...doc, openClarifications: 1 }));
    const getBorehole = vi.fn<DataSource['getBorehole']>(async () => ({ ...structuredClone(fake.held.get(UID)!), openClarifications: 0 }));
    Object.assign(fake, { getDocument, getBorehole });
    live.emit({ type: 'clarification.resolved', clarificationId: 'cl_SEEN_BEFORE_LOAD', status: 'skipped' });
    await vi.waitFor(() => expect(docById(doc.id)?.openClarifications).toBe(1));
    await vi.waitFor(() => expect(bh(UID)?.openClarifications).toBe(0));
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledWith(doc.id);
  });
});

describe('sources', () => {
  it('a source whose subscribe throws leaves the app working, offline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await ready({
      subscribe: () => {
        throw new Error('EventSource unavailable');
      },
    });
    expect(st().liveStatus).toBe('offline');
    expect(st().loadState).toBe('ready');
    warn.mockRestore();
  });

  it('the fake source type still satisfies the interface', () => {
    const f: FakeSource = fakeSource({ boreholes: [], documents: [] });
    expect(f.thumbnailUrl('doc', 1)).toBeNull();
  });
});
