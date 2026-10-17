import type { ExtractedValue } from './types';

/** From this AI confidence on, a value counts as "AI sure". */
export const SURE_CONFIDENCE = 0.85;

/**
 * The one mark a value shows instead of its extraction method:
 * green ✓ sure · yellow ? unsure · red ! flagged · grey – not in the source.
 */
export type CertaintyKind = 'sure' | 'unsure' | 'flagged' | 'missing';
export interface Certainty { kind: CertaintyKind; title: string }

type Rated = Pick<ExtractedValue, 'method'> & Partial<Pick<ExtractedValue, 'status' | 'confidence' | 'lint' | 'flag' | 'state'>>;

/**
 * Red ! when a reviewer flagged the value (a known problem comes first). Grey – when the source doesn't state
 * it or it is illegible. Green ✓ when a reviewer approved or corrected it, or the AI read it with at least
 * 85 % confidence and no open warning. Yellow ? when the AI is less sure, guessed it or a warning is open.
 * The detail stays in the tooltip.
 */
export function certaintyOf(v: Rated): Certainty {
  const pct = v.confidence != null ? ` (${Math.round(v.confidence * 100)} %)` : '';
  if (v.status === 'flagged') return { kind: 'flagged', title: `Flagged${v.flag ? `: ${v.flag}` : ''}` };
  if (v.state && v.state !== 'ok') {
    const what = v.state === 'illegible' ? 'Illegible in the source' : 'Not in the source';
    return { kind: 'missing', title: v.status === 'approved' ? `${what} (reviewed)` : what };
  }
  if (v.status === 'approved') return { kind: 'sure', title: 'Reviewed' };
  if (v.method === 'Edited') return { kind: 'sure', title: 'Corrected by a reviewer' };
  if (v.lint) return { kind: 'unsure', title: v.lint.message };
  if (v.method === 'Guessed') return { kind: 'unsure', title: `Guessed by the AI${pct}` };
  if (v.confidence == null || v.confidence >= SURE_CONFIDENCE) return { kind: 'sure', title: `AI sure${pct}` };
  return { kind: 'unsure', title: `AI unsure${pct}` };
}
