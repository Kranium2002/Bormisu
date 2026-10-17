/**
 * The filter panel's model (fictional values): depth texts and their validation, tri-states, the DIN
 * code list, and the request APPLY builds through setFilter / applyFilter (a fake store, and the real
 * store with a fake source).
 */
import { describe, expect, it, vi } from 'vitest';
import type { BoreholeFilter } from '../../../domain/types';
import { emptyFilter, EMPTY_FILTER } from '../../../store/mapDataSlice';
import {
  areaText,
  depthTextOf,
  dinGroups,
  fromTri,
  knownProjects,
  parseDepthText,
  submitFilter,
  toggled,
  toTri,
  validateDepths,
  type DepthTexts,
  type FilterActions,
} from './filterModel';

const texts = (o: Partial<DepthTexts> = {}): DepthTexts => ({ minDepth: '', maxDepth: '', lithologyMinDepth: '', ...o });

/** A fake store: records every call, and the filter as setFilter left it. */
function fakeStore(start: BoreholeFilter = emptyFilter()) {
  const calls: string[] = [];
  let filter = start;
  const store: FilterActions & { filter(): BoreholeFilter } = {
    setFilter: vi.fn((patch: Partial<BoreholeFilter>) => {
      calls.push('setFilter');
      filter = { ...filter, ...patch };
    }),
    applyFilter: vi.fn(async () => {
      calls.push('applyFilter');
    }),
    filter: () => filter,
  };
  return { store, calls };
}

describe('depth texts', () => {
  it('reads metres with a point or a comma; blank is unset; text, negatives and non-finite numbers are invalid', () => {
    expect(parseDepthText('')).toBeNull();
    expect(parseDepthText('  ')).toBeNull();
    expect(parseDepthText('12')).toBe(12);
    expect(parseDepthText(' 7,5 ')).toBe(7.5);
    expect(parseDepthText('0')).toBe(0);
    expect(parseDepthText('-3')).toBeUndefined();
    expect(parseDepthText('ten')).toBeUndefined();
    expect(parseDepthText('1e3')).toBeUndefined();
    expect(depthTextOf(null)).toBe('');
    expect(depthTextOf(7.5)).toBe('7.5');
  });

  it('min must not exceed max; each field says what is wrong', () => {
    expect(validateDepths(texts({ minDepth: '5', maxDepth: '12' }), [])).toEqual({
      values: { minDepth: 5, maxDepth: 12, lithologyMinDepth: null },
      errors: {},
    });
    expect(validateDepths(texts({ minDepth: '12', maxDepth: '5' }), []).errors).toEqual({
      maxDepth: 'The maximum depth must not be less than the minimum.',
    });
    expect(validateDepths(texts({ minDepth: 'x', maxDepth: '-1' }), []).errors).toEqual({
      minDepth: 'Enter a depth in metres (0 or more).',
      maxDepth: 'Enter a depth in metres (0 or more).',
    });
    // Equal bounds are a valid range.
    expect(validateDepths(texts({ minDepth: '6', maxDepth: '6' }), []).errors).toEqual({});
  });

  it('the lithology depth counts only with DIN codes', () => {
    expect(validateDepths(texts({ lithologyMinDepth: '4' }), []).values.lithologyMinDepth).toBeNull();
    expect(validateDepths(texts({ lithologyMinDepth: 'deep' }), []).errors).toEqual({});
    expect(validateDepths(texts({ lithologyMinDepth: '4' }), ['G']).values.lithologyMinDepth).toBe(4);
    expect(validateDepths(texts({ lithologyMinDepth: 'deep' }), ['G']).errors).toEqual({ lithologyMinDepth: 'Enter a depth in metres (0 or more).' });
  });
});

describe('tri-states and lists', () => {
  it('any / yes / no map to null / true / false and back', () => {
    expect([null, true, false].map(toTri)).toEqual(['any', 'yes', 'no']);
    expect((['any', 'yes', 'no'] as const).map(fromTri)).toEqual([null, true, false]);
  });

  it('toggles an item in a list without changing the list it got', () => {
    const list = ['G'];
    expect(toggled(list, 'S')).toEqual(['G', 'S']);
    expect(toggled(list, 'G')).toEqual([]);
    expect(list).toEqual(['G']);
  });

  it('lists every DIN code with its English name, grouped by kind; the search matches code or name', () => {
    const all = dinGroups('');
    expect(all.map((g) => g.label)).toEqual(['Soil', 'Rock', 'Geological']);
    expect(all.flatMap((g) => g.items)).toHaveLength(49);
    expect(all[0].items[0]).toEqual({ code: 'gY', name: 'Large boulders' });
    // Case-sensitive keys stay apart (mG is medium gravel, Mg is till marl); the search is not case-sensitive.
    const gravel = dinGroups('medium gravel').flatMap((g) => g.items);
    expect(gravel).toEqual([{ code: 'mG', name: 'Medium gravel' }]);
    expect(dinGroups('mg').flatMap((g) => g.items.map((i) => i.code))).toEqual(['mG', 'Mg']);
    expect(dinGroups('no such code')).toEqual([]);
  });

  it('known projects: each name once, sorted, blanks left out', () => {
    expect(knownProjects(['Bravo (fictional)', '', 'Alpha (fictional)', 'Bravo (fictional)', null])).toEqual(['Alpha (fictional)', 'Bravo (fictional)']);
  });

  it('describes a drawn area', () => {
    expect(areaText({ type: 'bbox', bbox: [7, 49, 8, 50] })).toBe('Rectangle drawn on the map');
    expect(areaText({ type: 'polygon', polygon: { type: 'Polygon', coordinates: [[[7, 49], [8, 49], [8, 50], [7, 49]]] } })).toBe('Polygon drawn on the map');
    expect(areaText({ type: 'circle', center: [8, 50], radiusM: 1250 })).toBe('Circle drawn on the map (radius 1,250 m)');
  });
});

describe('APPLY', () => {
  it('validates first: an invalid range sends nothing', async () => {
    const { store, calls } = fakeStore();
    const errors = await submitFilter(texts({ minDepth: '20', maxDepth: '5' }), store.filter(), store);
    expect(errors).toEqual({ maxDepth: 'The maximum depth must not be less than the minimum.' });
    expect(calls).toEqual([]);
  });

  it('sets the parsed depths and trimmed texts, then runs the filter', async () => {
    const start: BoreholeFilter = { ...emptyFilter(), search: '  TB ', project: ' Test Project (fictional) ', country: '   ', dinCodes: ['G'], hasSpt: true, reviewStatus: ['approved'] };
    const { store, calls } = fakeStore(start);
    const errors = await submitFilter(texts({ minDepth: '2,5', maxDepth: '18', lithologyMinDepth: '3' }), store.filter(), store);
    expect(errors).toEqual({});
    expect(calls).toEqual(['setFilter', 'applyFilter']);
    expect(store.setFilter).toHaveBeenCalledWith({
      search: 'TB', country: null, project: 'Test Project (fictional)', minDepth: 2.5, maxDepth: 18, lithologyMinDepth: 3,
    });
    expect(store.filter()).toEqual({
      ...EMPTY_FILTER, search: 'TB', project: 'Test Project (fictional)', minDepth: 2.5, maxDepth: 18, dinCodes: ['G'],
      lithologyMinDepth: 3, hasSpt: true, reviewStatus: ['approved'],
    });
  });

  it('drops the lithology depth when no DIN code is chosen', async () => {
    const { store } = fakeStore({ ...emptyFilter(), lithologyMinDepth: 4 });
    await submitFilter(texts({ lithologyMinDepth: '4' }), store.filter(), store);
    expect(store.filter().lithologyMinDepth).toBeNull();
  });
});
