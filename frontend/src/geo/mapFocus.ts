/**
 * The map focus: what the Map screen's map shows. `world` (every borehole with coordinates, no
 * restriction) or one country by ISO 3166-1 alpha-2 code, e.g. `DE`: only that country's boreholes,
 * everything outside it masked, the view kept on it.
 *
 * It is a runtime choice (the dropdown on the map, store `mapFocus` / `setMapFocus`). The first value
 * comes from the URL (`?focus=DE` or `?focus=world`), else from `VITE_MAP_FOCUS` (a build-time preset,
 * e.g. `DE`), else `world`. The URL parameter is kept in sync with every change, so a view can be
 * shared as a link. The CRS dialog and the detail mini-map are never restricted.
 */

/** `world`, or an ISO 3166-1 alpha-2 country code in upper case. */
export type MapFocus = string;

export const WORLD: MapFocus = 'world';

/** The URL query parameter that carries the focus. */
export const FOCUS_PARAM = 'focus';

/**
 * Parses a focus value from the URL or the env: `world` (any case) or a two-letter code (any case,
 * returned in upper case). Anything else is null. Whether the code is a known country is checked once
 * the outlines are loaded (an unknown one falls back to world).
 */
export function parseMapFocus(raw: string | null | undefined): MapFocus | null {
  const v = raw?.trim();
  if (!v) return null;
  if (v.toLowerCase() === WORLD) return WORLD;
  return /^[a-z]{2}$/i.test(v) ? v.toUpperCase() : null;
}

/** The first focus: `?focus=` from the URL, else VITE_MAP_FOCUS, else world. */
export function initialMapFocus(search: string, envValue: string | undefined): MapFocus {
  return parseMapFocus(new URLSearchParams(search).get(FOCUS_PARAM)) ?? parseMapFocus(envValue) ?? WORLD;
}

/** The same URL with `?focus=` set, as a path + query + hash for history.replaceState. Other parameters stay. */
export function withFocusParam(href: string, focus: MapFocus): string {
  const url = new URL(href);
  url.searchParams.set(FOCUS_PARAM, focus);
  return `${url.pathname}${url.search}${url.hash}`;
}
