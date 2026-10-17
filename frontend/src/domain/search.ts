/**
 * The header search as it is typed (from frontend_din): the map keeps only the matching pins and LIST
 * only the matching rows. Enter still jumps to the best match (store `search`).
 */

/** A borehole ID without case, dashes and spaces: "BK 07", "bk-07" and "BK07" are the same. */
export const flatId = (id: string) => id.toLowerCase().replace(/[-\s]/g, '');

/** True when the query filters something: it holds a letter or a digit (dashes alone match every ID). */
export const isFilterQuery = (query: string) => /[\p{L}\p{N}]/u.test(query.trim());

/**
 * True when a borehole matches the search box: its ID (ignoring case, dashes, spaces) or its project
 * contains the query. An empty query, or one without letters or digits, filters nothing.
 */
export function matchesQuery(b: { id: string; project: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!isFilterQuery(q)) return true;
  return flatId(b.id).includes(flatId(q)) || (b.project ?? '').toLowerCase().includes(q);
}
