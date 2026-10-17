import type { Borehole } from './types';

/** A borehole ID without case, dashes and spaces: "BK 07", "bk-07" and "BK07" are the same. */
export const flatId = (id: string) => id.toLowerCase().replace(/[-\s]/g, '');

/**
 * True when a borehole matches the search box as it is typed: its ID (ignoring case, dashes, spaces) or
 * its project contains the query. An empty query, or one without letters or digits, filters nothing.
 */
export function matchesQuery(b: Pick<Borehole, 'id' | 'project'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!/[\p{L}\p{N}]/u.test(q)) return true;
  return flatId(b.id).includes(flatId(q)) || b.project.toLowerCase().includes(q);
}
