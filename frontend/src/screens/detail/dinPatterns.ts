import codes from '../../../../assets/din4023_patterns/din_codes.json';
import sprite from '../../../../assets/din4023_patterns/patterns.svg?raw';
import type { Layer, PatternId } from '../../domain/types';
import { COL } from '../../theme';

/** DIN 4023 fill patterns, read from the repo's assets/din4023_patterns (not copied into the frontend). */
type DinCode = keyof typeof codes;

/** `<pattern>` markup per pattern id, cut out of patterns.svg so each profile embeds only what it draws. */
const PATTERNS = new Map(
  [...sprite.matchAll(/<pattern id="([^"]+)"[\s\S]*?<\/pattern>/g)].map((m) => [m[1], m[0]] as const),
);

/** A DIN code with no pattern file: solid red, so the missing visualization stands out. */
export const MISSING_PATTERN = 'din-missing';
PATTERNS.set(
  MISSING_PATTERN,
  `<pattern id="${MISSING_PATTERN}" patternUnits="userSpaceOnUse" width="10" height="10"><rect width="10" height="10" fill="${COL.red}"/></pattern>`,
);

/** Layers without a DIN code get the hatching guessed from their lithology. */
const FROM_GUESS: Record<PatternId, DinCode> = {
  topsoil: 'Mu', fill: 'A', clay: 'T', silt: 'U', gravel: 'G', sst: 'Sst', sand: 'S', lst: 'Kst', marl: 'Mg',
};

/**
 * The DIN pattern id for a layer: main component of its DIN code ("T, u" → T, case-sensitive: mG ≠ Mg).
 * A code with no pattern → MISSING_PATTERN (red). No code → the lithology guess, or null when the source
 * names nothing: draw plain #E0E0E0 then.
 */
export function dinPatternId(l: Pick<Layer, 'din' | 'lithology' | 'pattern'>): string | null {
  const main = l.din.trim().split(/[\s,;+/]/)[0];
  if (Object.hasOwn(codes, main)) return codes[main as DinCode].pattern_id;
  if (main) return MISSING_PATTERN;
  return l.lithology ? codes[FROM_GUESS[l.pattern]].pattern_id : null;
}

/** The `<pattern>` definitions for these ids, as markup for a `<defs>`. */
export const patternDefs = (ids: Iterable<string | null>) =>
  [...new Set(ids)].map((id) => (id && PATTERNS.get(id)) ?? '').join('');
