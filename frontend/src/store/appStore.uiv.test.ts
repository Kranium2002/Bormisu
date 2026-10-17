/**
 * M0 UI verification (uiv-*): races between pending saves and the refetches of approve-clean, CRS
 * confirmation and document reloads, and the Source panel for values that are on no page. Fake
 * sources over fictional data only.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { SaveError } from '../data/errors';
import { K } from '../domain/keys';
import { applyValuePatch } from '../domain/review';
import type { Borehole, CrsCandidate, ValuePatch } from '../domain/types';
import { makeBorehole, makeDocument, makeValue } from '../test/fixtures';
import { useAppStore } from './appStore';
import { fakeSource, readyStore, settle } from './testing';

const UID = makeBorehole().uid;
const UID2 = 'bh_TEST0000000000000000000002';
const doc = makeDocument({ reviewBoreholeUid: UID });

const st = () => useAppStore.getState();
const bh = (uid = UID) => st().boreholes.find((b) => b.uid === uid);
const value = (key: string, uid = UID) => bh(uid)?.values.find((v) => v.key === key);

/** Saves the test answers by hand. */
function manualSaves() {
  const pending: { patch: ValuePatch; resolve(b: Borehole): void; reject(e: unknown): void }[] = [];
  const updateValue = vi.fn<DataSource['updateValue']>(
    (_uid, _key, patch) => new Promise<Borehole>((resolve, reject) => pending.push({ patch, resolve, reject })),
  );
  return { pending, updateValue };
}

/** The server's record of a fixture borehole after some patches, at a revision. */
function record(revision: number, patches: [string, ValuePatch][] = [], base: Borehole = makeBorehole()): Borehole {
  return { ...patches.reduce((b, [key, p]) => applyValuePatch(b, key, p), base), revision };
}

async function ready(over: Partial<DataSource> = {}, boreholes: Borehole[] = [makeBorehole()]) {
  const fake = fakeSource({ boreholes, documents: [doc] }, over);
  await readyStore(fake, UID);
  return fake;
}

describe('uiv races: a refetch while saves are pending', () => {
  it('approve-clean reloads the document; a save that then fails without a record keeps the newer reload', async () => {
    const { pending, updateValue } = manualSaves();
    const fake = await ready({ updateValue });
    st().toggleApprove(K.finalDepth);
    const reloaded = record(3, [[K.finalDepth, { status: 'approved' }], [K.boreholeId, { status: 'approved' }]]);
    fake.documentBoreholes = async () => [reloaded];
    useAppStore.setState({ confirmCleanOpen: true, cleanCount: 2 });
    await st().approveClean();
    pending[0].reject(new Error('offline'));
    await settle();
    // Not the state from before the save (revision 1): the reload is newer than what the save rolled back to.
    expect(bh()?.revision).toBe(3);
    expect([value(K.finalDepth)?.status, value(K.boreholeId)?.status]).toEqual(['approved', 'approved']);
    expect(st().toast?.text).toBe('Not saved: offline');
  });

  it('a CRS confirmation reload wins over an older save answer that arrives after it', async () => {
    const { pending, updateValue } = manualSaves();
    const candidates: CrsCandidate[] = [
      { name: 'Fictional grid', code: 'EPSG:0001', note: null, score: 0.9, verdict: 'match', swapAxes: false, points: [] },
    ];
    const fake = await ready({ updateValue, crsCandidates: async () => candidates, confirmCrs: async () => 1 });
    st().toggleApprove(K.finalDepth);
    const confirmed = { ...record(5, [[K.finalDepth, { status: 'approved' }]]), crs: { name: null, code: 'EPSG:0001', status: 'confirmed' as const } };
    fake.documentBoreholes = async () => [confirmed];
    await st().openCrsDialog();
    await st().confirmCrs();
    // Still the optimistic state while the save is pending.
    expect(bh()?.crs.status).toBe('stated');
    pending[0].resolve(record(4, [[K.finalDepth, { status: 'approved' }]]));
    await settle();
    expect(bh()?.revision).toBe(5);
    expect(bh()?.crs).toEqual({ name: null, code: 'EPSG:0001', status: 'confirmed' });
  });

  it('a SaveError record older than a reload seen meanwhile does not roll the borehole back', async () => {
    const { pending, updateValue } = manualSaves();
    const fake = await ready({ updateValue });
    editFinalDepth('6.50');
    fake.documentBoreholes = async () => [record(7, [[K.boreholeId, { status: 'approved' }]])];
    useAppStore.setState({ confirmCleanOpen: true, cleanCount: 1 });
    await st().approveClean();
    pending[0].reject(new SaveError('changed', record(6), 'revision_conflict'));
    await settle();
    expect(bh()?.revision).toBe(7);
    expect(value(K.boreholeId)?.status).toBe('approved');
    expect(value(K.finalDepth)?.value).toBe('6.00');
  });

  it('a reload replaces the other boreholes of the document at once and only defers the one with a pending save', async () => {
    const { pending, updateValue } = manualSaves();
    const second = makeBorehole({ uid: UID2, id: 'TB-02' });
    const fake = await ready({ updateValue }, [makeBorehole(), second]);
    st().toggleApprove(K.finalDepth);
    fake.documentBoreholes = async () => [record(2, [[K.boreholeId, { status: 'approved' }]]), record(2, [[K.boreholeId, { status: 'approved' }]], second)];
    useAppStore.setState({ confirmCleanOpen: true, cleanCount: 2 });
    await st().approveClean();
    expect(bh(UID2)?.revision).toBe(2);
    expect(value(K.boreholeId, UID2)?.status).toBe('approved');
    expect(bh()?.revision).toBe(1);
    pending[0].resolve(record(3, [[K.finalDepth, { status: 'approved' }], [K.boreholeId, { status: 'approved' }]]));
    await settle();
    expect(bh()?.revision).toBe(3);
  });
});

function editFinalDepth(text: string) {
  st().startEdit(K.finalDepth, 'edit');
  st().setEditText(text);
  st().saveEdit();
}

describe('uiv-6: a value with a source entry but no page (guessed or derived)', () => {
  const guessed = () => {
    const b = makeBorehole();
    b.values = [...b.values, makeValue({ key: K.country, label: 'Country', value: 'Fictionland', page: null, box: null, method: 'Guessed', confidence: null })];
    return b;
  };

  it('opens the Source panel without a page instead of the borehole’s first page', async () => {
    await ready({}, [guessed()]);
    st().openSource(UID, K.country);
    expect(st().panel).toEqual({ kind: 'source', uid: UID, key: K.country, documentId: doc.id, page: null, box: null });
  });
});
