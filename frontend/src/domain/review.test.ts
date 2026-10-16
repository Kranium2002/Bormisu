import { describe, expect, it } from 'vitest';
import { makeBorehole, makeValue } from '../test/fixtures';
import { K } from './keys';
import {
  applyValuePatch,
  boreholeStatus,
  cleanKeys,
  completenessSummary,
  confirmCrsOn,
  editPatch,
  statePatch,
  flagPatch,
  initialFocusKey,
  patchOf,
  progress,
  UNFLAG_PATCH,
} from './review';
import { firstRefusal } from '../screens/detail/profileGeometry';
import { formatSpt, sptLint } from './spt';
import type { Borehole, Spt } from './types';

const approveAll = (b = makeBorehole()) => ({
  ...b,
  values: b.values.map((v) => ({ ...v, status: 'approved' as const })),
});

describe('boreholeStatus', () => {
  it('is unreviewed when nothing is approved', () => {
    expect(boreholeStatus(makeBorehole())).toBe('unreviewed');
  });

  it('is reviewed when every value is approved', () => {
    expect(boreholeStatus(approveAll())).toBe('reviewed');
  });

  it('needs attention when the CRS is inferred, even if all values are approved', () => {
    const b = approveAll(makeBorehole({ crs: { name: 'X', code: null, status: 'inferred' } }));
    expect(boreholeStatus(b)).toBe('attention');
  });

  it('needs attention for a flagged value', () => {
    const b = makeBorehole();
    expect(boreholeStatus(applyValuePatch(b, K.finalDepth, flagPatch('odd')))).toBe('attention');
  });

  it('needs attention for an open lint, but not once that value is approved', () => {
    const b = makeBorehole();
    const linted = {
      ...b,
      values: b.values.map((v) =>
        v.key === K.finalDepth ? { ...v, lint: { severity: 'error' as const, message: 'x' } } : v,
      ),
    };
    expect(boreholeStatus(linted)).toBe('attention');
    expect(boreholeStatus(approveAll(linted))).toBe('reviewed');
  });

  it('is unreviewed (not reviewed) when there are no values', () => {
    expect(boreholeStatus(makeBorehole({ values: [] }))).toBe('unreviewed');
  });
});

describe('cleanKeys', () => {
  it('returns only unreviewed Read values with no lint, flag or special state', () => {
    const b = makeBorehole({
      values: [
        makeValue({ key: 'a' }),
        makeValue({ key: 'b', method: 'OCR' }),
        makeValue({ key: 'c', lint: { severity: 'warning', message: 'w' } }),
        makeValue({ key: 'd', flag: 'f', status: 'flagged' }),
        makeValue({ key: 'e', state: 'illegible' }),
        makeValue({ key: 'f', status: 'approved' }),
      ],
    });
    expect(cleanKeys(b)).toEqual(['a']);
  });
});

describe('progress', () => {
  it('counts approved values', () => {
    const b = applyValuePatch(makeBorehole(), K.boreholeId, { status: 'approved' });
    expect(progress(b)).toEqual({ approved: 1, total: 7 });
  });
});

describe('initialFocusKey', () => {
  it('focuses the CRS value when the CRS is inferred', () => {
    const b = makeBorehole({
      crs: { name: 'X', code: null, status: 'inferred' },
      values: [makeValue({ key: K.boreholeId }), makeValue({ key: K.crs })],
    });
    expect(initialFocusKey(b)).toBe(K.crs);
  });

  it('otherwise focuses the first open lint', () => {
    const b = makeBorehole({
      values: [makeValue({ key: 'a' }), makeValue({ key: 'b', lint: { severity: 'error', message: 'x' } })],
    });
    expect(initialFocusKey(b)).toBe('b');
  });
});

describe('completenessSummary', () => {
  it('reports missing IDs as an error and generates the expected IDs', () => {
    const s = completenessSummary({ listed: 3, idPrefix: 'TB-', missing: ['TB-02'], unexpected: ['TB-09'], lint: [] });
    expect(s.tone).toBe('error');
    expect(s.chipText).toBe('Report lists 3 · extracted 2 · ⚠ 1 missing');
    expect(s.headText).toBe('Report lists 3 · extracted 2 · 1 missing');
    expect(s.ids).toEqual([
      { id: 'TB-01', state: 'extracted' },
      { id: 'TB-02', state: 'missing' },
      { id: 'TB-03', state: 'extracted' },
      { id: 'TB-09', state: 'unexpected' },
    ]);
  });

  it('is a warning with lint only, ok without', () => {
    const lint = [{ severity: 'warning' as const, boreholeId: 'TB-01', message: 'gap' }];
    expect(completenessSummary({ listed: 1, idPrefix: 'TB-', missing: [], unexpected: [], lint }).tone).toBe('warning');
    const ok = completenessSummary({ listed: 1, idPrefix: 'TB-', missing: [], unexpected: [], lint: [] });
    expect(ok.tone).toBe('ok');
    expect(ok.chipText).toBe('Report lists 1 · extracted 1 ✓');
  });

  it('uses explicit expected IDs when given', () => {
    const s = completenessSummary({
      listed: 2, idPrefix: '', missing: [], unexpected: [], lint: [], expectedIds: ['A7', 'Z1'],
    });
    expect(s.ids.map((x) => x.id)).toEqual(['A7', 'Z1']);
  });
});

describe('patches', () => {
  const v = makeValue({ key: K.finalDepth, value: '6.00' });

  it('an edit with a new value becomes Edited and approved', () => {
    expect(editPatch(v, ' 6.50 ')).toEqual({ value: '6.50', method: 'Edited', status: 'approved' });
  });

  it('typing a value clears a not-in-source / illegible state, even when the text is unchanged', () => {
    const ill = { ...v, state: 'illegible' as const };
    expect(editPatch(ill, '6.00')).toEqual({ status: 'approved', state: 'ok' });
    expect(editPatch(ill, '7.00')).toEqual({ value: '7.00', method: 'Edited', status: 'approved', state: 'ok' });
    expect(editPatch(ill, ' ')).toEqual({ status: 'approved' });
  });

  it('a state button sets the state, and pressing it again resets it', () => {
    expect(statePatch(v, 'illegible')).toEqual({ state: 'illegible', status: 'approved' });
    const ill = { ...v, state: 'illegible' as const, status: 'approved' as const };
    expect(statePatch(ill, 'illegible')).toEqual({ state: 'ok', status: 'unreviewed' });
    expect(statePatch(ill, 'not in source')).toEqual({ state: 'not in source', status: 'approved' });
  });

  it('an unchanged or empty edit only approves', () => {
    expect(editPatch(v, '6.00')).toEqual({ status: 'approved' });
    expect(editPatch(v, '  ')).toEqual({ status: 'approved' });
  });

  it('an empty flag reason gets a default', () => {
    expect(flagPatch(' ')).toEqual({ flag: 'needs a second look', status: 'flagged' });
  });

  it('unflagging clears the flag', () => {
    const b = applyValuePatch(applyValuePatch(makeBorehole(), K.finalDepth, flagPatch('x')), K.finalDepth, UNFLAG_PATCH);
    const after = b.values.find((x) => x.key === K.finalDepth);
    expect(after?.status).toBe('unreviewed');
    expect(after?.flag).toBeUndefined();
  });
});

describe('applyValuePatch', () => {
  it('does not mutate the input and ignores unknown keys', () => {
    const b = makeBorehole();
    const next = applyValuePatch(b, K.finalDepth, { status: 'approved' });
    expect(b.values.find((x) => x.key === K.finalDepth)?.status).toBe('unreviewed');
    expect(next.values.find((x) => x.key === K.finalDepth)?.status).toBe('approved');
    expect(applyValuePatch(b, 'nope', { status: 'approved' })).toBe(b);
  });

  it('syncs final depth, layer bottoms and groundwater on edits', () => {
    let b = makeBorehole();
    b = applyValuePatch(b, K.finalDepth, { value: '7.00' });
    b = applyValuePatch(b, K.bottom(1), { value: '3.00' });
    b = applyValuePatch(b, K.gwStrike, { value: '2.20' });
    expect(b.finalDepth).toBe(7);
    expect(b.layers[0].to).toBe(3);
    expect(b.layers[1].from).toBe(3);
    expect(b.groundwater[0].depth).toBe(2.2);
  });

  it('updates the logged bottom when the last layer bottom changes', () => {
    const b = applyValuePatch(makeBorehole(), K.bottom(2), { value: '5.50' });
    expect(b.logBottom).toBe(5.5);
  });
});

describe('confirmCrsOn', () => {
  it('confirms the CRS and approves the CRS value', () => {
    const b = makeBorehole({
      crs: { name: 'guess', code: null, status: 'inferred' },
      values: [makeValue({ key: K.crs, value: 'guess', method: 'Guessed' })],
    });
    const match = confirmCrsOn(b, {
      name: 'DHDN / GK zone 3', code: 'EPSG:31467', note: '', verdict: 'match',
      points: [{ uid: b.uid, lat: 48.1, lng: 9.1 }],
    });
    expect(match.crs).toEqual({ name: 'DHDN / GK zone 3', code: 'EPSG:31467', status: 'confirmed' });
    expect(match.values[0]).toMatchObject({ value: 'DHDN / GK zone 3', status: 'approved', method: 'Guessed' });
    expect([match.lat, match.lng]).toEqual([48.1, 9.1]);
    const other = confirmCrsOn(b, { name: 'Other', code: 'EPSG:1', note: '', verdict: 'shifted', points: [] });
    expect(other.values[0].method).toBe('Edited');
    expect([other.lat, other.lng]).toEqual([b.lat, b.lng]);
  });

  // Regression (c9): an API borehole with CRS "not in source" and plotted=false stayed missing and unplotted.
  it('clears a "not in source" CRS and puts a borehole with a candidate point on the map', () => {
    const b = makeBorehole({
      lat: null, lng: null, onMap: false, unplottedReason: 'CRS unknown',
      crs: { name: null, code: null, status: 'unknown' },
      values: [makeValue({ key: K.crs, value: '', state: 'not in source', method: 'Guessed' })],
    });
    const c = { name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', note: '', verdict: 'match' as const, points: [{ uid: b.uid, lat: 48.7, lng: 9.1 }] };
    const placed = confirmCrsOn(b, c);
    expect(placed.values[0]).toMatchObject({ value: 'ETRS89 / UTM zone 32N', state: 'ok', status: 'approved' });
    expect(placed).toMatchObject({ lat: 48.7, lng: 9.1, onMap: true, unplottedReason: null });
    // Without a point for this borehole it stays where it was.
    expect(confirmCrsOn(b, { ...c, points: [] })).toMatchObject({ onMap: false, unplottedReason: 'CRS unknown' });
  });
});

describe('final depth sync', () => {
  // Regression (c19): rolling back to an empty final depth left the edited number in finalDepth.
  it('an empty final depth is unknown again; other text keeps the last number', () => {
    const b = makeBorehole({ finalDepth: null, values: [makeValue({ key: K.finalDepth, value: '', state: 'not in source' })] });
    const edited = applyValuePatch(b, K.finalDepth, { value: '7', method: 'Edited', status: 'approved', state: 'ok' });
    expect(edited.finalDepth).toBe(7);
    expect(applyValuePatch(edited, K.finalDepth, { value: 'about 7 m' }).finalDepth).toBe(7);
    expect(applyValuePatch(edited, K.finalDepth, patchOf(b.values[0])).finalDepth).toBeNull();
  });
});

describe('SPT edits', () => {
  const N8: Spt = { raw: '3,4,5 = 8', depth: 1.5, refusal: false, increments: [3, 4, 5], n: 8 };
  const withSpt = () => {
    const b = makeBorehole();
    return {
      ...b,
      layers: b.layers.map((l) => (l.n === 1 ? { ...l, spt: N8 } : l)),
      values: [
        ...b.values,
        makeValue({
          key: K.spt(1), field: 'SPT', group: 'layer', layer: 1, raw: N8.raw, value: formatSpt(N8),
          kind: 'spt', spt: N8, refusal: false, lint: sptLint(N8),
        }),
      ],
    };
  };
  const spt = (b: Borehole) => b.values.find((v) => v.key === K.spt(1));

  // Regression (c4): the text changed but spt.n, the refusal flag and the increment lint did not.
  it('a corrected N updates the structured SPT, the layer and the increment lint', () => {
    const b = applyValuePatch(withSpt(), K.spt(1), { value: 'N = 9', method: 'Edited', status: 'approved' });
    expect(spt(b)?.spt).toMatchObject({ n: 9, refusal: false, raw: '3,4,5 = 8', increments: [3, 4, 5] });
    expect(spt(b)?.lint).toBeUndefined();
    expect(b.layers[0].spt?.n).toBe(9);
  });

  it('a refusal entered by the reviewer becomes a refusal (R marker), never an N', () => {
    const b = applyValuePatch(withSpt(), K.spt(1), { value: '50/30', method: 'Edited', status: 'approved' });
    expect(spt(b)).toMatchObject({ refusal: true, spt: { refusal: true, blows: 50, penetrationCm: 30 } });
    expect(spt(b)?.spt?.n).toBeUndefined();
    expect(firstRefusal(b.layers)?.layer.n).toBe(1);
  });

  it('unreadable text keeps no stale N, and a rollback restores N and its lint', () => {
    const odd = applyValuePatch(withSpt(), K.spt(1), { value: 'see note', method: 'Edited' });
    expect(spt(odd)?.spt?.n).toBeUndefined();
    const back = applyValuePatch(odd, K.spt(1), { value: 'N = 8', method: 'Read' });
    expect(spt(back)?.spt?.n).toBe(8);
    expect(spt(back)?.lint?.message).toBe('Increments 4 + 5 = 9 ≠ N 8');
  });
});
