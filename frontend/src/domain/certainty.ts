import type { ExtractedValue } from './types';

/** From this AI confidence on, a value counts as "AI sure". */
export const SURE_CONFIDENCE = 0.85;

/** The one mark a value shows instead of its extraction method: green ✓ (sure) or yellow ? (unsure). */
export interface Certainty { sure: boolean; title: string }

type Rated = Pick<ExtractedValue, 'method'> & Partial<Pick<ExtractedValue, 'status' | 'confidence' | 'lint' | 'flag'>>;

/**
 * Green ✓ when a reviewer approved or corrected the value, or the AI read it with at least 85 %
 * confidence and no open warning. Yellow ? when the AI is less sure, guessed it, a warning is open
 * or a reviewer flagged it. The detail stays in the tooltip.
 */
export function certaintyOf(v: Rated): Certainty {
  const pct = v.confidence != null ? ` (${Math.round(v.confidence * 100)} %)` : '';
  if (v.status === 'approved') return { sure: true, title: 'Reviewed' };
  if (v.method === 'Edited') return { sure: true, title: 'Corrected by a reviewer' };
  if (v.status === 'flagged') return { sure: false, title: `Flagged${v.flag ? `: ${v.flag}` : ''}` };
  if (v.lint) return { sure: false, title: v.lint.message };
  if (v.method === 'Guessed') return { sure: false, title: `Guessed by the AI${pct}` };
  if (v.confidence == null || v.confidence >= SURE_CONFIDENCE) return { sure: true, title: `AI sure${pct}` };
  return { sure: false, title: `AI unsure${pct}` };
}
