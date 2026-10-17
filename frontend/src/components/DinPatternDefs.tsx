import patternsSvg from '@din/patterns.svg?raw';
import symbolsSvg from '@din/symbols.svg?raw';
import { EXTRA_PATTERN_DEFS } from '../screens/detail/dinPatterns';

/**
 * The DIN 4023 `<pattern>`s, inlined once into the page so every SVG can fill with
 * `url(#<pattern_id>)` (references into an external file don't work in browsers). Mount it once,
 * near the app root:
 * - the 49 coloured tiles of assets/din4023_patterns/patterns.svg (`din-<kind>_<code>`),
 * - the same tiles without colour from symbols.svg (`din-sym-…`), drawn over another fill for a
 *   secondary component,
 * - the Table 6 property tiles and the cored line (`din-prop-…`, `din-cored`, see dinPatterns.ts).
 *
 * Each root `<svg>` is 0×0 and absolutely positioned. It must never be hidden with `display: none`:
 * some browsers don't paint patterns defined inside a display:none SVG (the sheet's print CSS keeps
 * `[data-din-defs]` for that reason). The markup is a build-time asset from the repository, never user data.
 */
export function DinPatternDefs() {
  return <div aria-hidden="true" data-din-defs="" style={WRAPPER} dangerouslySetInnerHTML={{ __html: MARKUP }} />;
}

const MARKUP = patternsSvg + symbolsSvg + EXTRA_PATTERN_DEFS;

/** Out of the layout flow and not clickable, but still rendered (no display:none). */
const WRAPPER = { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' } as const;
