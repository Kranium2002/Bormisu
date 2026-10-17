import { expect, it } from 'vitest';
import { matchesQuery } from './search';

const b = { id: 'BK-07', project: 'Stadtbahn Neckarbogen' };

it('matches the ID without case, dashes and spaces, or the project', () => {
  expect(matchesQuery(b, 'bk 07')).toBe(true);
  expect(matchesQuery(b, 'BK07')).toBe(true);
  expect(matchesQuery(b, 'neckar')).toBe(true);
  expect(matchesQuery(b, 'EQ')).toBe(false);
});

it('filters nothing without letters or digits', () => {
  expect(matchesQuery(b, '')).toBe(true);
  expect(matchesQuery(b, ' - ')).toBe(true);
});
