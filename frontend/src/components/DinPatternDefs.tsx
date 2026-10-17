import patternsSvg from '@din/patterns.svg?raw';

/**
 * The 49 DIN 4023 `<pattern>`s of assets/din4023_patterns/patterns.svg, inlined once into the page
 * so every SVG can fill with `url(#<pattern_id>)` (references into an external file don't work in
 * browsers). Mount it once, near the app root.
 *
 * The file's root `<svg>` is already 0×0 and absolutely positioned. It must never be hidden with
 * `display: none`: some browsers don't paint patterns defined inside a display:none SVG.
 * The markup is a build-time asset from the repository, never user data.
 */
export function DinPatternDefs() {
  return <div aria-hidden="true" style={WRAPPER} dangerouslySetInnerHTML={{ __html: patternsSvg }} />;
}

/** Out of the layout flow and not clickable, but still rendered (no display:none). */
const WRAPPER = { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' } as const;
