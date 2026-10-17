/**
 * Test helpers for the store: a fake data source over fictional in-memory data that behaves like the
 * backend (saves bump the revision and answer with the record), and a store reset. Not used by the app.
 */
import type { DataSource, LoadResult } from '../data/DataSource';
import { applyValuePatch } from '../domain/review';
import { isClean } from '../domain/status';
import type { Borehole, Health } from '../domain/types';
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

/**
 * A data source over `data`. It keeps its own copy of the boreholes ("the server"): saves apply the
 * patch, bump the revision and resolve with the record; approve-clean and CRS confirmation change
 * it the same way. Any method can be replaced through `over`.
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
    upload: async () => undefined,
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

const initial = useAppStore.getState();

/**
 * Resets the store and loads `source` without init() (which would create the configured source):
 * the data is ready and `reviewUid` / `selectedUid` point at the given borehole.
 */
export async function readyStore(source: DataSource, uid: string | null = null): Promise<void> {
  useAppStore.setState(initial, true);
  const { boreholes, documents } = await source.load();
  useAppStore.setState({ source, loadState: 'ready', boreholes, documents, reviewUid: uid, selectedUid: uid, health: await source.health() });
}

/** Lets every queued promise reaction run. */
export const settle = () => new Promise((r) => setTimeout(r, 0));
