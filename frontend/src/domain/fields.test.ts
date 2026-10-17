import { describe, expect, it } from 'vitest';
import { makeBorehole, makeLayer } from '../test/fixtures';
import { FIELD_GROUPS, FIELDS, fieldByKey } from './fields';

const text = (key: string, b = makeBorehole()) => fieldByKey.get(key)!.text(b);

describe('README_data fields for the LIST', () => {
  it('covers every README table with unique keys', () => {
    expect(new Set(FIELDS.map((f) => f.key)).size).toBe(FIELDS.length);
    expect(new Set(FIELDS.map((f) => f.group))).toEqual(new Set(FIELD_GROUPS));
  });

  it('shows a stated borehole column and "–" for one the source does not state', () => {
    const b = makeBorehole({ fields: { client: 'Musterstadt', notes: null } });
    expect(text('boreholes.client', b)).toBe('Musterstadt');
    expect(text('boreholes.notes', b)).toBe('–');
  });

  it('summarises the layers: codes joined, numbers as a range, yes / no as a count', () => {
    const b = makeBorehole({ layers: [
      makeLayer({ n: 1, from: 0, to: 2, din: 'T, u', rqd: 40, props: { core: true } }),
      makeLayer({ n: 2, from: 2, to: 5, din: 'Sst', rqd: 12 }),
    ] });
    expect(text('layers.din_code', b)).toBe('T, u · Sst');
    expect(text('layers.rqd', b)).toBe('12–40 %');
    expect(text('layers.core', b)).toBe('1 of 2');
    expect(text('layers.depth_to', b)).toBe('0–5 m');
  });
});
