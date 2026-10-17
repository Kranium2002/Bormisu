/** Store basics with fake sources (fictional data): review actions, Escape, search, panels, pages, uploads. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { K } from '../domain/keys';
import type { Borehole } from '../domain/types';
import { makeBorehole, makeDocument, makeValue } from '../test/fixtures';
import { useAppStore } from './appStore';
import { NO_SOURCE_REFERENCE } from './reviewSlice';
import { fakeSource, makeHealth, readyStore, settle, type FakeSource } from './testing';
import { DEMO_UPLOAD_REASON } from './uploads';

const UID = makeBorehole().uid;
const doc = makeDocument({ reviewBoreholeUid: UID });
const other: Borehole = makeBorehole({
  uid: 'bh_TEST0000000000000000000002', id: 'TB-02', onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates',
});

const source = (over: Partial<DataSource> = {}, boreholes = [makeBorehole(), other]) =>
  fakeSource({ boreholes, documents: [doc] }, over);

const st = () => useAppStore.getState();
const value = (key: string) => st().boreholes.find((b) => b.uid === UID)?.values.find((v) => v.key === key);

describe('review actions', () => {
  beforeEach(() => readyStore(source(), UID));

  it('approves optimistically, then shows the record the source answers with', async () => {
    st().toggleApprove(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('approved');
    expect(st().boreholes[0].reviewStatus).toBe('in_review');
    expect(st().focusKey).toBe(K.finalDepth);
    await vi.waitFor(() => expect(st().boreholes[0].revision).toBe(2));
    expect(value(K.finalDepth)?.status).toBe('approved');
    st().toggleApprove(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('unreviewed');
    await vi.waitFor(() => expect(st().boreholes[0].revision).toBe(3));
  });

  it('rolls back to what the source holds and toasts when saving fails', async () => {
    await readyStore(source({ updateValue: () => Promise.reject(new Error('offline')) }), UID);
    st().toggleApprove(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('approved');
    await vi.waitFor(() => expect(value(K.finalDepth)?.status).toBe('unreviewed'));
    expect(st().toast?.text).toBe('Not saved: offline');
    expect(st().boreholes[0].reviewStatus).toBe('unreviewed');
  });

  it('saves an edit as Edited + approved and keeps the AI value', async () => {
    st().startEdit(K.finalDepth, 'edit');
    expect(st().editing).toEqual({ key: K.finalDepth, mode: 'edit', text: '6.00' });
    st().setEditText('6.50');
    st().saveEdit();
    expect(value(K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited', status: 'approved', aiValue: '6.00' });
    expect(st().boreholes[0].finalDepth).toBe(6.5);
    expect(st().editing).toBeNull();
    await settle();
  });

  it('flags with a reason and unflags', async () => {
    st().toggleFlag(K.finalDepth);
    expect(st().editing?.mode).toBe('flag');
    st().setEditText('odd');
    st().saveEdit();
    expect(value(K.finalDepth)).toMatchObject({ status: 'flagged', flag: 'odd' });
    await settle();
    st().toggleFlag(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('unreviewed');
    expect(value(K.finalDepth)?.flag).toBeUndefined();
    await settle();
  });

  it('sets a field state and approves it', async () => {
    st().setState(K.boreholeId, 'illegible');
    expect(value(K.boreholeId)).toMatchObject({ state: 'illegible', status: 'approved' });
    await settle();
  });
});

describe('values without a provenance entry', () => {
  const noRef = () => {
    const b = makeBorehole();
    b.values = b.values.map((v) => (v.key === K.finalDepth ? { ...v, hasProvenance: false, method: null, page: null } : v));
    return b;
  };

  it('cannot be approved, edited, flagged or opened; the reason is shown and nothing is sent', async () => {
    const updateValue = vi.fn<DataSource['updateValue']>();
    await readyStore(source({ updateValue }, [noRef()]), UID);
    st().toggleApprove(K.finalDepth);
    expect(st().toast?.text).toBe(NO_SOURCE_REFERENCE);
    st().startEdit(K.finalDepth, 'edit');
    st().toggleFlag(K.finalDepth);
    st().setState(K.finalDepth, 'illegible');
    expect(st().editing).toBeNull();
    expect(value(K.finalDepth)).toMatchObject({ status: 'unreviewed', state: 'ok' });
    expect(updateValue).not.toHaveBeenCalled();
    st().openSource(UID, K.finalDepth);
    expect(st().panel).toBeNull();
  });
});

describe('escape', () => {
  beforeEach(() => readyStore(source(), UID));

  it('closes one layer per press: editing, confirm, export, CRS dialog, panel', () => {
    useAppStore.setState({
      editing: { key: 'x', mode: 'edit', text: '' }, confirmCleanOpen: true, exportOpen: true, crsDialogOpen: true,
      panel: { kind: 'completeness', documentId: doc.id },
    });
    const open = () => [!!st().editing, st().confirmCleanOpen, st().exportOpen, st().crsDialogOpen, !!st().panel];
    expect(open()).toEqual([true, true, true, true, true]);
    for (let i = 0; i < 5; i++) st().escape();
    expect(open()).toEqual([false, false, false, false, false]);
    useAppStore.setState({ exportOpen: true, panel: { kind: 'completeness', documentId: doc.id } });
    st().escape();
    expect(open()).toEqual([false, false, false, false, true]);
  });
});

describe('search', () => {
  beforeEach(() => readyStore(source(), UID));

  it('flies to an exact ID on the map', () => {
    useAppStore.setState({ screen: 'queue', query: 'tb-01' });
    st().search();
    expect(st().screen).toBe('map');
    expect(st().mapFocus).toMatchObject({ uid: UID, zoom: 13 });
  });

  it('explains boreholes that are not on the map with the reason label', () => {
    useAppStore.setState({ query: 'TB-02' });
    st().search();
    expect(st().searchMessage).toBe('TB-02: No coordinates in source. Listed under Not on map.');
  });

  it('reports no results', () => {
    useAppStore.setState({ query: 'zzz' });
    st().search();
    expect(st().searchMessage).toBe('No results for “zzz”');
  });
});

describe('navigation and panels', () => {
  beforeEach(() => readyStore(source(), UID));

  it('opens a borehole on the detail screen and a value in the source panel', () => {
    st().openBorehole(UID);
    expect(st().screen).toBe('detail');
    expect(st().selectedUid).toBe(UID);
    st().openSource(UID, K.finalDepth);
    expect(st().panel).toEqual({ kind: 'source', uid: UID, key: K.finalDepth, documentId: doc.id, page: 1, box: null });
  });

  it('opens a spreadsheet value at its cell, without a page', async () => {
    const b = makeBorehole();
    b.values = b.values.map((v) => (v.key === K.finalDepth ? { ...v, page: null, cell: 'Logdata!C5' } : v));
    await readyStore(source({}, [b]), UID);
    st().openSource(UID, K.finalDepth);
    expect(st().panel).toEqual({ kind: 'source', uid: UID, key: K.finalDepth, documentId: doc.id, page: null, box: null, cell: 'Logdata!C5' });
  });

  it('opens review on the CRS when it is inferred', () => {
    const b = makeBorehole({
      uid: 'bh_TEST0000000000000000000009', crs: { name: 'Fictional grid', code: null, status: 'inferred' },
      values: [makeValue({ key: K.boreholeId, page: 1 }), makeValue({ key: K.crs, page: 2, box: { x: 0, y: 0, w: 0.1, h: 0.1 } })],
    });
    useAppStore.setState({ boreholes: [...st().boreholes, b] });
    st().openReview(b.uid);
    expect(st()).toMatchObject({ screen: 'review', reviewUid: b.uid, focusKey: K.crs, reviewPage: 2 });
  });

  it('loads pages into the cache once', async () => {
    const getPage = vi.fn(source().getPage);
    await readyStore(source({ getPage }), UID);
    await st().loadPage(doc.id, 2);
    await st().loadPage(doc.id, 2);
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(st().pages[`${doc.id}:2`]?.status).toBe('ready');
  });
});

describe('uploads', () => {
  const file = (name: string, bytes = 1) => new File([new Uint8Array(bytes)], name);
  let fake: FakeSource;
  let upload: ReturnType<typeof vi.fn<DataSource['upload']>>;

  beforeEach(async () => {
    upload = vi.fn<DataSource['upload']>(async (files, onUpdate) => {
      for (const f of files) onUpdate(makeDocument({ id: `doc_${f.name}`, name: f.name, status: 'queued', step: 0, pages: [], uploaded: true }));
    });
    fake = source({ upload });
    await readyStore(fake, UID);
  });

  it('takes the accepted types and the size limit from health and explains the rest', async () => {
    useAppStore.setState({ health: makeHealth({ upload: { maxMb: 1, extensions: ['.pdf', '.png'] } }) });
    await st().addFiles([file('a.PDF'), file('notes.txt'), file('big.png', 2 * 1024 * 1024), file('scan.png')]);
    expect(upload.mock.calls[0][0].map((f) => f.name)).toEqual(['a.PDF', 'scan.png']);
    expect(st().dropError).toBe('File type not supported: notes.txt · Larger than 1 MB: big.png');
    expect(st().documents.map((d) => d.id).slice(0, 2)).toEqual(['doc_scan.png', 'doc_a.PDF']);
  });

  it('passes every file to the source when the limits are unknown (health failed)', async () => {
    useAppStore.setState({ health: null });
    await st().addFiles([file('notes.txt')]);
    expect(upload.mock.calls[0][0].map((f) => f.name)).toEqual(['notes.txt']);
    expect(st().dropError).toBe('');
  });

  it('refuses every upload in demo mode with the reason', async () => {
    useAppStore.setState({ health: makeHealth({ mode: 'demo' }) });
    await st().addFiles([file('a.pdf')]);
    expect(upload).not.toHaveBeenCalled();
    expect(st().dropError).toBe(DEMO_UPLOAD_REASON);
  });
});
