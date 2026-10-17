/**
 * Pure helpers of the PLACE SEARCH section (FRONTEND.md F11): the status line, a candidate's texts,
 * which candidate counts as chosen, and whether a place holds no uploaded borehole. Unit-tested.
 */
import type { MapFeature, PlaceCandidate } from '../../../domain/types';
import { insideBbox } from '../../../store/mapDataSlice';

/**
 * True when the place holds no uploaded borehole: the server counts none (or does not know) and no
 * pin lies inside its box. A place without a box is a point: only the server's 0 says so.
 */
export function noUploadedBoreholes(c: PlaceCandidate, features: Pick<MapFeature, 'lat' | 'lng'>[]): boolean {
  if (c.boreholeCount != null && c.boreholeCount > 0) return false;
  const box = c.bbox;
  if (box) return !features.some((f) => insideBbox(f, box));
  return c.boreholeCount === 0;
}

/** A place kind in words ("project_site" → "project site"); '' when the server gives none. */
export function placeKindText(kind: string | null): string {
  return kind ? kind.replace(/_/g, ' ') : '';
}

/** "3 boreholes" when the server counted them, else null. */
export function placeCountText(c: Pick<PlaceCandidate, 'boreholeCount'>): string | null {
  if (c.boreholeCount == null) return null;
  return `${c.boreholeCount} ${c.boreholeCount === 1 ? 'borehole' : 'boreholes'}`;
}

/** The status line: searching, the error, or how many places were found. */
export function placeStatusText(s: { busy: boolean; error: string | null; places: PlaceCandidate[] | null }): string {
  if (s.busy) return 'Searching…';
  if (s.error) return s.error;
  if (!s.places?.length) return '';
  return s.places.length === 1 ? '1 place found' : `${s.places.length} places found`;
}

/** The candidate a fresh answer has chosen: the only one (the store flies there), else none yet. */
export function chosenAfterSearch(places: PlaceCandidate[] | null): number | null {
  return places?.length === 1 ? 0 : null;
}
