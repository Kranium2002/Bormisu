/**
 * M0 fix round (UI side): page-less boreholes, values whose source is in another document,
 * read-only values and RETRY in demo mode. Fake sources over fictional data only.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import { K } from '../domain/keys';
import type { Borehole, Box } from '../domain/types';
import { makeBorehole, makeDocument, makeValue } from '../test/fixtures';
import { useAppStore } from './appStore';
import { fakeSource, makeHealth, readyStore, settle } from './testing';
import { DEMO_UPLOAD_REASON } from './uploads';

const UID = makeBorehole().uid;
const doc = makeDocument({ reviewBoreholeUid: UID });
const LAB = 'doc_FICTIONAL_LAB_0000000000001';
const BOX: Box = { x: 0.2, y: 0.3, w: 0.1, h: 0.02 };

const st = () => useAppStore.getState();
const value = (key: string) => st().boreholes.find((b) => b.uid === UID)?.values.find((v) => v.key === key);

async function ready(boreholes: Borehole[], over: Partial<DataSource> = {}, documents = [doc]) {
  const fake = fakeSource({ boreholes, documents }, over);
  await readyStore(fake, UID);
  return fake;
}

/** A borehole read from a spreadsheet only: no page at all. */
const pageless = () =>
  makeBorehole({
    pages: [],
    primaryPage: null,
    values: [
      makeValue({ key: K.boreholeId, page: null, cell: 'Logdata!A2' }),
      makeValue({ key: K.country, label: 'Country', page: null, method: 'Guessed' }),
    ],
  });

describe('PRIMARY-PAGE-NULL: a borehole without pages never shows page 1', () => {
  it('the Review page is unset until a borehole with pages is opened', () => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    expect(st().reviewPage).toBeNull();
  });

  it('opening it in Review shows no page; focusing its values keeps it that way', async () => {
    await ready([makeBorehole({ uid: 'bh_OTHER' }), pageless()]);
    useAppStore.setState({ reviewUid: 'bh_OTHER' });
    st().openReview(UID);
    expect(st().reviewPage).toBeNull();
    st().focusValue(K.country);
    expect(st().reviewPage).toBeNull();
  });

  it('a source request without a value or page explains itself instead of opening page 1', async () => {
    await ready([pageless()]);
    st().openSource(UID, 'no-such-value');
    expect(st().panel).toBeNull();
    expect(st().toast?.text).toBe('No source page for this borehole');
  });
});

describe('DV-11-UI: a value whose source is in another document', () => {
  const withLab = (o: Partial<Borehole> = {}) => {
    const b = makeBorehole(o);
    b.values = [
      ...b.values,
      makeValue({ key: K.test(0), label: 'UCS', group: 'test', index: 0, page: null, cell: 'Lab!D7', documentId: LAB }),
      makeValue({ key: K.test(1), label: 'Su', group: 'test', index: 1, page: 3, box: BOX, documentId: LAB }),
    ];
    return b;
  };

  it('opens the Source panel on that document: its cell, or its page with the box', async () => {
    await ready([withLab()]);
    st().openSource(UID, K.test(0));
    expect(st().panel).toEqual({ kind: 'source', uid: UID, key: K.test(0), documentId: LAB, page: null, box: null, cell: 'Lab!D7' });
    st().openSource(UID, K.test(1));
    expect(st().panel).toEqual({ kind: 'source', uid: UID, key: K.test(1), documentId: LAB, page: 3, box: BOX });
  });

  it('a value cited on several pages opens with all of them; one page carries none', async () => {
    const b = withLab();
    const sources = [{ page: 3, box: BOX }, { page: 4, box: null }];
    b.values = b.values.map((v) => (v.key === K.test(1) ? { ...v, sources } : v.key === K.test(0) ? { ...v, sources: [{ page: 3, box: null }] } : v));
    await ready([b]);
    st().openSource(UID, K.test(1));
    expect(st().panel).toMatchObject({ page: 3, box: BOX, sources });
    st().openSource(UID, K.test(0));
    expect(st().panel).not.toHaveProperty('sources');
  });

  it('opens even when the borehole itself names no document', async () => {
    await ready([withLab({ documentId: null })]);
    st().openSource(UID, K.test(1));
    expect(st().panel).toMatchObject({ documentId: LAB, page: 3 });
  });

  it('focusing it in Review keeps the scan on the borehole’s own page', async () => {
    await ready([withLab()]);
    st().openReview(UID);
    const page = st().reviewPage;
    st().focusValue(K.test(1));
    expect(st().focusKey).toBe(K.test(1));
    expect(st().reviewPage).toBe(page);
  });
});

describe('READONLY: a value with a read-only reason', () => {
  const REASON = 'Set through the CRS dialog only';
  const readOnly = () => {
    const b = makeBorehole();
    b.values = b.values.map((v) => (v.key === K.finalDepth ? { ...v, readOnlyReason: REASON } : v));
    return b;
  };

  it('cannot be edited: the reason is shown and nothing is sent', async () => {
    const updateValue = vi.fn<DataSource['updateValue']>();
    await ready([readOnly()], { updateValue });
    st().startEdit(K.finalDepth, 'edit');
    expect(st().editing).toBeNull();
    expect(st().toast?.text).toBe(REASON);
    // An edit opened before the value became read-only is not sent either.
    useAppStore.setState({ editing: { key: K.finalDepth, mode: 'edit', text: '7.00' } });
    st().saveEdit();
    expect(updateValue).not.toHaveBeenCalled();
    expect(value(K.finalDepth)?.value).toBe('6.00');
  });

  it('can still be approved, flagged and set to a state', async () => {
    await ready([readOnly()]);
    st().toggleApprove(K.finalDepth);
    expect(value(K.finalDepth)?.status).toBe('approved');
    await settle();
    st().toggleFlag(K.finalDepth);
    expect(st().editing).toEqual({ key: K.finalDepth, mode: 'flag', text: '' });
    st().setEditText('check the end note');
    st().saveEdit();
    expect(value(K.finalDepth)).toMatchObject({ status: 'flagged', flag: 'check the end note' });
    await settle();
    st().setState(K.finalDepth, 'illegible');
    expect(value(K.finalDepth)).toMatchObject({ state: 'illegible' });
    await settle();
  });
});

describe('BE-RETRY-1: RETRY in demo mode', () => {
  const failed = makeDocument({ id: 'doc_TEST_F', name: 'bad.pdf', status: 'failed', step: 1, error: 'OCR timeout' });

  it('is refused with the demo reason; nothing is sent', async () => {
    const retry = vi.fn<DataSource['retry']>(async () => undefined);
    await ready([makeBorehole()], { retry, health: async () => makeHealth({ mode: 'demo' }) }, [doc, failed]);
    await st().retryDocument(failed.id);
    expect(retry).not.toHaveBeenCalled();
    expect(st().toast?.text).toBe(DEMO_UPLOAD_REASON);
  });

  it('works in sample mode', async () => {
    const retry = vi.fn<DataSource['retry']>(async () => undefined);
    await ready([makeBorehole()], { retry, health: async () => makeHealth({ mode: 'sample' }) }, [doc, failed]);
    await st().retryDocument(failed.id);
    expect(retry).toHaveBeenCalledWith(failed.id);
  });
});
