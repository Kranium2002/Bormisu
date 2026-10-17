/** The queue card's "N on the map · SHOW": the map opens on the document's pins (fictional data). */
import { describe, expect, it } from 'vitest';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { useAppStore } from './appStore';
import { fakeSource, readyStore } from './testing';

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
