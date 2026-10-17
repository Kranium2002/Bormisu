/**
 * Pure model of the FILTERS panel (FRONTEND.md F10): the depth fields as typed text and their
 * validation, the tri-state switches, the DIN 4023 code list (din_codes.json through domain/din.ts)
 * and APPLY, which sets the validated values with setFilter and runs applyFilter. Only what the
 * contract's BoreholeFilter supports; unset fields are null or empty (never a default value).
 */
import { DIN_CODES, dinEntry, type DinEntry } from '../../../domain/din';
import { parseNumber } from '../../../domain/format';
import type { Area, BoreholeFilter } from '../../../domain/types';

/** The depth fields as typed. */
export interface DepthTexts { minDepth: string; maxDepth: string; lithologyMinDepth: string }
export type DepthField = keyof DepthTexts;
export type FilterErrors = Partial<Record<DepthField, string>>;

export const DEPTH_INVALID = 'Enter a depth in metres (0 or more).';
export const RANGE_INVALID = 'The maximum depth must not be less than the minimum.';

/** A typed depth: null when blank, a number of metres (0 or more), undefined when it is not one. */
export function parseDepthText(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const n = parseNumber(text);
  return n != null && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A stored depth as the field shows it. */
export function depthTextOf(n: number | null): string {
  return n == null ? '' : String(n);
}

export interface DepthValues { minDepth: number | null; maxDepth: number | null; lithologyMinDepth: number | null }

/**
 * Checks the depth fields: each a depth in metres, the minimum not above the maximum. The lithology
 * depth only counts with DIN codes (the field is off without them).
 */
export function validateDepths(t: DepthTexts, dinCodes: string[]): { values: DepthValues; errors: FilterErrors } {
  const errors: FilterErrors = {};
  const minDepth = parseDepthText(t.minDepth);
  const maxDepth = parseDepthText(t.maxDepth);
  const lithology = dinCodes.length ? parseDepthText(t.lithologyMinDepth) : null;
  if (minDepth === undefined) errors.minDepth = DEPTH_INVALID;
  if (maxDepth === undefined) errors.maxDepth = DEPTH_INVALID;
  if (lithology === undefined) errors.lithologyMinDepth = DEPTH_INVALID;
  if (minDepth != null && maxDepth != null && minDepth > maxDepth) errors.maxDepth = RANGE_INVALID;
  return { values: { minDepth: minDepth ?? null, maxDepth: maxDepth ?? null, lithologyMinDepth: lithology ?? null }, errors };
}

/** The store actions APPLY uses. */
export interface FilterActions {
  setFilter(patch: Partial<BoreholeFilter>): void;
  applyFilter(): Promise<void>;
}

const textOrNull = (s: string | null) => (s?.trim() ? s.trim() : null);

/**
 * APPLY: validates the depth fields; when they are valid, sets them (and the trimmed texts) with
 * setFilter and runs applyFilter. Returns the errors to show (none when it ran).
 */
export async function submitFilter(t: DepthTexts, filter: BoreholeFilter, store: FilterActions): Promise<FilterErrors> {
  const { values, errors } = validateDepths(t, filter.dinCodes);
  if (Object.keys(errors).length) return errors;
  store.setFilter({
    search: textOrNull(filter.search),
    country: textOrNull(filter.country),
    project: textOrNull(filter.project),
    ...values,
  });
  await store.applyFilter();
  return {};
}

/* ---------- tri-states, lists ---------- */

export type Tri = 'any' | 'yes' | 'no';

export function toTri(v: boolean | null): Tri {
  return v == null ? 'any' : v ? 'yes' : 'no';
}

export function fromTri(t: Tri): boolean | null {
  return t === 'any' ? null : t === 'yes';
}

/** The list with `item` added, or removed when it is there (a new list). */
export function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** Project names the map knows, each once and sorted; blanks left out. */
export function knownProjects(names: (string | null)[]): string[] {
  return [...new Set(names.filter((n): n is string => !!n?.trim()))].sort((a, b) => a.localeCompare(b));
}

/* ---------- DIN 4023 codes ---------- */

export interface DinItem { code: string; name: string }
export interface DinGroup { kind: DinEntry['kind']; label: string; items: DinItem[] }

const KIND_LABEL: Record<DinEntry['kind'], string> = { soil: 'Soil', rock: 'Rock', geological: 'Geological' };

/**
 * The DIN 4023 codes of the shared asset set with their English names, grouped by kind in file
 * order; `query` keeps the codes whose key or name contains it (not case-sensitive). Empty groups
 * are left out.
 */
export function dinGroups(query: string): DinGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<DinEntry['kind'], DinItem[]>();
  for (const code of DIN_CODES) {
    const e = dinEntry(code);
    if (!e) continue;
    if (q && !code.toLowerCase().includes(q) && !e.nameEn.toLowerCase().includes(q)) continue;
    groups.set(e.kind, [...(groups.get(e.kind) ?? []), { code, name: e.nameEn }]);
  }
  return (['soil', 'rock', 'geological'] as const)
    .filter((k) => groups.has(k))
    .map((k) => ({ kind: k, label: KIND_LABEL[k], items: groups.get(k)! }));
}

/** The English name of a DIN code, or the code itself when it is not a key of the asset set. */
export function dinName(code: string): string {
  return dinEntry(code)?.nameEn ?? code;
}

/* ---------- area ---------- */

/** What an area drawn on the map is, in words. */
export function areaText(area: Area): string {
  if (area.type === 'bbox') return 'Rectangle drawn on the map';
  if (area.type === 'polygon') return 'Polygon drawn on the map';
  return `Circle drawn on the map (radius ${Math.round(area.radiusM).toLocaleString('en')} m)`;
}

/* ---------- FILTERS button ---------- */

/**
 * How many filters are set, for the FILTERS button: each field that narrows the set counts once (both
 * depth bounds count as two, any number of DIN codes or review statuses as one). The area drawn on
 * the map is not a filter of the panel and is not counted; neither is the text search of the panel's
 * set when it is empty.
 */
export function activeFilterCount(f: BoreholeFilter): number {
  const set = [
    f.search?.trim(),
    f.country,
    f.project,
    f.documentId,
    f.minDepth != null,
    f.maxDepth != null,
    f.dinCodes.length > 0,
    f.lithologyMinDepth != null,
    f.hasSpt != null,
    f.hasGroundwater != null,
    f.reviewStatus.length > 0,
    !f.includeUnreviewed,
  ];
  return set.filter(Boolean).length;
}
