import codes from '../../../../assets/din4023_patterns/din_codes.json';
import sprite from '../../../../assets/din4023_patterns/patterns.svg?raw';
import type { Layer, PatternId } from '../../domain/types';

/** DIN 4023 fill patterns, read from the repo's assets/din4023_patterns (not copied into the frontend). */
type DinCode = keyof typeof codes;

/** `<pattern>` markup per pattern id, cut out of patterns.svg so each profile embeds only what it draws. */
const PATTERNS = new Map(
  [...sprite.matchAll(/<pattern id="([^"]+)"[\s\S]*?<\/pattern>/g)].map((m) => [m[1], m[0]] as const),
);

/** When the layer's DIN code isn't one of the 49, fall back to the hatching guessed from its lithology. */
const FROM_GUESS: Record<PatternId, DinCode> = {
  topsoil: 'Mu', fill: 'A', clay: 'T', silt: 'U', gravel: 'G', sst: 'Sst', sand: 'S', lst: 'Kst', marl: 'Mg',
};

/**
 * The DIN pattern id for a layer: main component of its DIN code ("T, u" → T, case-sensitive: mG ≠ Mg),
 * else the lithology guess. Null when the source names nothing: draw plain #E0E0E0 then.
 */
export function dinPatternId(l: Pick<Layer, 'din' | 'lithology' | 'pattern'>): string | null {
  const main = l.din.trim().split(/[\s,;+/]/)[0];
  const code: DinCode | null = main in codes ? (main as DinCode) : l.din || l.lithology ? FROM_GUESS[l.pattern] : null;
  return code && codes[code].pattern_id;
}

/** The `<pattern>` definitions for these ids, as markup for a `<defs>`. */
export const patternDefs = (ids: Iterable<string | null>) =>
  [...new Set(ids)].map((id) => (id && PATTERNS.get(id)) ?? '').join('');
