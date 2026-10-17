/**
 * Upload → map (fictional data): the queue card's "N on the map · SHOW" opens the map on the
 * document's pins, placed boreholes are flown to (revealPlaced, SHOW ON MAP off the map), "N not on
 * the map · WHY" opens the NOT ON MAP list, and RETRY in demo mode says why.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../data/errors';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { useAppStore } from './appStore';
import { placedText, SHOW_ON_MAP } from './mapDataSlice';
import { ACTION_TOAST_MS } from './panelSlice';
import { fakeSource, readyStore } from './testing';
import { DEMO_UPLOAD_REASON } from './uploads';

const st = () => useAppStore.getState();
const DOC = makeDocument().id;

describe('showDocumentOnMap', () => {
  it('goes to the map and flies to the bounds of the document’s pins', async () => {
    const a = makeBorehole({ uid: 'bh_TEST_SHOW_00000000000001', id: 'TS-1', lat: 50, lng: 8 });
    const b = makeBorehole({ uid: 'bh_TEST_SHOW_00000000000002', id: 'TS-2', lat: 51, lng: 9.5 });
    await readyStore(fakeSource({ boreholes: [a, b], documents: [makeDocument()] }));
    st().go('queue');
    const before = st().mapOutline?.nonce ?? 0;
    st().showDocumentOnMap(DOC);
    expect(st().screen).toBe('map');
    expect(st().mapOutline).toMatchObject({ bbox: [8, 50, 9.5, 51], outline: false });
    expect(st().mapOutline!.nonce).toBeGreaterThan(before);
  });

  it('says so when no borehole of the document is on the map yet', async () => {
    const unplotted = makeBorehole({ lat: null, lng: null, onMap: false, unplottedReason: 'no_coordinates' });
    await readyStore(fakeSource({ boreholes: [unplotted], documents: [makeDocument()] }));
    st().go('queue');
    st().showDocumentOnMap(DOC);
    expect(st().screen).toBe('queue');
    expect(st().toast?.text).toBe('No borehole of this report is on the map yet.');
  });
});

describe('upload → map: placed boreholes (revealPlaced)', () => {
  const a = makeBorehole({ uid: 'bh_TEST_SHOW_00000000000001', id: 'TS-1', lat: 50, lng: 8 });
  const b = makeBorehole({ uid: 'bh_TEST_SHOW_00000000000002', id: 'TS-2', lat: 51, lng: 9.5 });

  it('off the map: flies there (when the map opens) and the toast offers SHOW ON MAP, which opens the map', async () => {
    await readyStore(fakeSource({ boreholes: [a, b], documents: [makeDocument()] }));
    st().go('queue');
    expect(st().revealPlaced({ documentId: DOC }, 'CRS confirmed')).toBe(2);
    expect(st().screen).toBe('queue');
    expect(st().mapOutline).toMatchObject({ bbox: [8, 50, 9.5, 51], outline: false });
    expect(st().toast).toMatchObject({ text: 'CRS confirmed · 2 boreholes placed', action: { label: SHOW_ON_MAP } });
    const nonce = st().mapOutline!.nonce;
    st().toast!.action!.run();
    expect(st().screen).toBe('map');
    // The map flies again when it opens.
    expect(st().mapOutline!.nonce).toBeGreaterThan(nonce);
  });

  it('on the map: flies there and says how many, without a button; only the given boreholes', async () => {
    await readyStore(fakeSource({ boreholes: [a, b], documents: [makeDocument()] }));
    st().go('map');
    expect(st().revealPlaced({ uids: [b.uid] })).toBe(1);
    expect(st().mapOutline).toMatchObject({ bbox: [9.5, 51, 9.5, 51] });
    expect(st().toast?.text).toBe(placedText(1));
    expect(st().toast?.action).toBeUndefined();
  });

  it('without pins it changes nothing', async () => {
    await readyStore(fakeSource({ boreholes: [a], documents: [makeDocument()] }));
    const before = st().mapOutline;
    expect(st().revealPlaced({ uids: ['bh_NOT_PINNED'] })).toBe(0);
    expect(st().mapOutline).toBe(before);
    expect(st().toast).toBeNull();
  });

  it('a toast with a button stays longer', async () => {
    await readyStore(fakeSource({ boreholes: [a], documents: [makeDocument()] }));
    vi.useFakeTimers();
    try {
      st().showToast('Plain');
      st().showToast('With a button', { label: 'GO', run: () => undefined });
      vi.advanceTimersByTime(ACTION_TOAST_MS - 1);
      expect(st().toast?.text).toBe('With a button');
      vi.advanceTimersByTime(1);
      expect(st().toast).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('"N not on the map · WHY" (showNotOnMap)', () => {
  it('opens the map and asks the NOT ON MAP list to point at the document', async () => {
    const off = makeBorehole({ lat: null, lng: null, onMap: false, unplottedReason: 'no_coordinates' });
    await readyStore(fakeSource({ boreholes: [off], documents: [makeDocument()] }));
    st().go('queue');
    st().showNotOnMap(DOC);
    expect(st().screen).toBe('map');
    expect(st().notOnMapFocus).toMatchObject({ documentId: DOC });
    const first = st().notOnMapFocus!.nonce;
    st().showNotOnMap(DOC);
    expect(st().notOnMapFocus!.nonce).toBeGreaterThan(first);
  });
});

describe('RETRY in demo mode (1.2.0: 409 demo_mode)', () => {
  it('says why instead of the raw code, and leaves the document as it is', async () => {
    const failed = makeDocument({ status: 'failed', step: 1, error: 'x' });
    await readyStore(
      fakeSource({ boreholes: [], documents: [failed] }, { retry: () => Promise.reject(new ApiError(409, 'demo_mode', 'demo_mode')) }),
    );
    await st().retryDocument(failed.id);
    expect(st().toast?.text).toBe(`Retry failed: ${DEMO_UPLOAD_REASON}`);
    expect(st().documents[0]).toMatchObject({ status: 'failed' });
  });
});
