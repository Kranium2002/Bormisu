/**
 * The explore panel's store contract (fictional data): APPLY sends exactly the panel's filter, a
 * result set shown from a link or the chat puts its definition into the panel (so APPLY and area
 * selection go on from it), and an answer of APPLY never overwrites what was changed meanwhile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data/DataSource';
import type { BoreholeFilter } from '../domain/types';
import { submitFilter } from '../screens/map/explore/filterModel';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { emptyFilter } from './mapDataSlice';
import { fakeSource, readyStore } from './testing';

vi.mock('../data/createDataSource', () => ({
  createDataSource: async () => {
    throw new Error('not used: the tests ready the store themselves');
  },
  dataSourceKind: () => 'sample',
  apiBase: () => '/api/v1',
}));
const { useAppStore } = await import('./appStore');
const st = () => useAppStore.getState();

const DOC = 'doc_TEST0000000000000000000001';
const A = makeBorehole({ uid: 'bh_TEST_A', id: 'TB-01', lat: 50, lng: 8, finalDepth: 6 });
const B = makeBorehole({ uid: 'bh_TEST_B', id: 'TB-02', lat: 50.1, lng: 8.1, finalDepth: 14, reviewStatus: 'approved' });
const OFF = makeBorehole({ uid: 'bh_TEST_OFF', id: 'TB-03', onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates', finalDepth: 9 });

async function boot(over: Partial<DataSource> = {}) {
  const fake = fakeSource({ boreholes: [A, B, OFF], documents: [makeDocument({ id: DOC })] }, over);
  const createResultSet = vi.fn(fake.createResultSet);
  fake.createResultSet = createResultSet;
  await readyStore(fake, null, { cache: 'boot' });
  return { fake, createResultSet };
}

afterEach(() => vi.restoreAllMocks());

describe('APPLY through the store', () => {
  it('sends the panel’s filter with the parsed depths and trimmed texts, and shows the set', async () => {
    const { createResultSet } = await boot();
    st().setFilter({ project: ' Test Project (fictional) ', reviewStatus: ['unreviewed'], hasGroundwater: true, dinCodes: ['S'] });
    const errors = await submitFilter({ minDepth: '5', maxDepth: '10,5', lithologyMinDepth: '1' }, st().filter, st());
    expect(errors).toEqual({});
    const sent: BoreholeFilter = createResultSet.mock.calls[0][0];
    expect(sent).toEqual({
      ...emptyFilter(), project: 'Test Project (fictional)', minDepth: 5, maxDepth: 10.5, dinCodes: ['S'], lithologyMinDepth: 1,
      hasGroundwater: true, reviewStatus: ['unreviewed'],
    });
    // TB-01 (6 m, plotted) and TB-03 (9 m, no coordinates) match the fake server's simple filter; TB-02 is 14 m.
    expect(st().resultSet).toMatchObject({ count: 2, uids: [A.uid, OFF.uid], locatedCount: 1, unlocatedCount: 1 });
  });

  it('an invalid depth range sends nothing', async () => {
    const { createResultSet } = await boot();
    const errors = await submitFilter({ minDepth: '20', maxDepth: '5', lithologyMinDepth: '' }, st().filter, st());
    expect(errors.maxDepth).toBeTruthy();
    expect(createResultSet).not.toHaveBeenCalled();
    expect(st().resultSet).toBeNull();
  });
});

describe('the panel follows the result set shown', () => {
  it('a set shown from a link (or the chat) puts its definition into the panel', async () => {
    const { fake } = await boot();
    const made = await fake.createResultSet({ ...emptyFilter(), minDepth: 8, includeUnreviewed: false, area: { type: 'bbox', bbox: [7, 49, 9, 51] } });
    expect(st().filter).toEqual(emptyFilter());
    await st().showResultSet(made.id);
    expect(st().filter).toEqual(made.definition);
    // A copy: changing the panel never changes the stored set.
    st().setFilter({ dinCodes: ['G'] });
    expect(st().resultSet?.definition.dinCodes).toEqual([]);
  });

  it('APPLY keeps what the panel holds: a change made while the request runs is not overwritten', async () => {
    let answer: () => void = () => undefined;
    const { fake } = await boot();
    const real = fake.createResultSet;
    fake.createResultSet = (f) => new Promise((resolve) => (answer = () => resolve(real(f))));
    st().setFilter({ minDepth: 5 });
    const running = st().applyFilter();
    st().setFilter({ project: 'Typed meanwhile (fictional)' });
    answer();
    await running;
    expect(st().resultSet?.definition.project).toBeNull();
    expect(st().filter).toMatchObject({ minDepth: 5, project: 'Typed meanwhile (fictional)' });
  });

  it('RESET empties the panel again', async () => {
    const { fake } = await boot();
    const made = await fake.createResultSet({ ...emptyFilter(), project: 'Test Project (fictional)' });
    await st().showResultSet(made.id);
    st().clearResultSet();
    expect(st().filter).toEqual(emptyFilter());
    expect(st().resultSet).toBeNull();
  });
});
