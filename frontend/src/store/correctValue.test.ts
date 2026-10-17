/** The document view's correction (correctValue) on any borehole, not only the review one. Fictional data. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { K } from '../domain/keys';
import type { Borehole } from '../domain/types';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { useAppStore } from './appStore';
import { NO_SOURCE_REFERENCE } from './reviewSlice';
import { fakeSource, readyStore, settle } from './testing';

const other: Borehole = makeBorehole({ uid: 'bh_TEST0000000000000000000002', id: 'TB-02' });
const st = () => useAppStore.getState();
const value = (uid: string, key: string) => st().boreholes.find((b) => b.uid === uid)?.values.find((v) => v.key === key);

describe('correctValue', () => {
  beforeEach(() => readyStore(fakeSource({ boreholes: [makeBorehole(), other], documents: [makeDocument()] }), makeBorehole().uid));

  it('saves a changed text as Edited + approved on a borehole that is not the review one', async () => {
    st().correctValue(other.uid, K.finalDepth, '6.50');
    expect(value(other.uid, K.finalDepth)).toMatchObject({ value: '6.50', method: 'Edited', status: 'approved', aiValue: '6.00' });
    await vi.waitFor(() => expect(st().boreholes.find((b) => b.uid === other.uid)?.revision).toBe(2));
    expect(value(other.uid, K.finalDepth)).toMatchObject({ value: '6.50', status: 'approved' });
  });

  it('confirms an unchanged text: approved, the value stays', async () => {
    st().correctValue(other.uid, K.finalDepth, '6.00');
    expect(value(other.uid, K.finalDepth)).toMatchObject({ value: '6.00', status: 'approved' });
    expect(value(other.uid, K.finalDepth)?.method).not.toBe('Edited');
    await settle();
  });

  it('refuses a value without a provenance entry, and a change of a read-only value', async () => {
    useAppStore.setState((s) => ({
      boreholes: s.boreholes.map((b) =>
        b.uid !== other.uid
          ? b
          : { ...b, values: b.values.map((v) => (v.key === K.finalDepth ? { ...v, hasProvenance: false } : v.key === K.gw(0) ? { ...v, readOnlyReason: 'Set elsewhere' } : v)) },
      ),
    }));
    st().correctValue(other.uid, K.finalDepth, '7');
    expect(st().toast?.text).toBe(NO_SOURCE_REFERENCE);
    st().correctValue(other.uid, K.gw(0), '9.99');
    expect(st().toast?.text).toBe('Set elsewhere');
    expect(value(other.uid, K.gw(0))?.value).toBe('1.80');
    await settle();
  });
});
