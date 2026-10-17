/**
 * How a CRS candidate is shown (CRS dialog F13, the crs_picker widget F12): the backend's label, code,
 * score, verdict, note and swap flag, nothing derived from the code itself (no CRS-family rules).
 */
import type { CrsCandidate, CrsVerdict } from '../../domain/types';
import { COL } from '../../theme';

/** Short text of a candidate's verdict (the backend's own note is shown next to it). */
export const VERDICT_LABEL: Record<CrsVerdict, string> = {
  match: 'pins on site',
  shifted: 'shifted from the site',
  out_of_range: 'out of range',
};

/** Pin and edge colour by verdict: match green, shifted amber, out of range red; no verdict neutral grey. */
export function verdictColor(v: CrsVerdict | null): string {
  if (v === 'match') return COL.green;
  if (v === 'shifted') return COL.amber;
  if (v === 'out_of_range') return COL.red;
  return COL.grey;
}

/** Score of a candidate as text, e.g. "score 0.92"; '' when the backend sent none. */
export function scoreText(c: Pick<CrsCandidate, 'score'>): string {
  return c.score == null ? '' : `score ${c.score.toFixed(2)}`;
}

/** Verdict and note: "pins on site · <note>"; a candidate without either says the backend gave none. */
export function verdictText(c: Pick<CrsCandidate, 'verdict' | 'note'>): string {
  return [c.verdict ? VERDICT_LABEL[c.verdict] : '', c.note ?? ''].filter(Boolean).join(' · ') || 'No verdict from the backend';
}

/** The swap-axes mark and its explanation. */
export const SWAP_TEXT = '⇄ X / Y swapped';
export const SWAP_TITLE = 'The printed X is the northing: X and Y are swapped for this candidate';

/** Points a map can show: finite, on the globe. A candidate out of range may have none. */
export function plottablePoints(c: Pick<CrsCandidate, 'points' | 'verdict'>): CrsCandidate['points'] {
  if (c.verdict === 'out_of_range') return [];
  return c.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
}
