/**
 * Shared Leaflet helpers: the base map every map in the app uses (OpenStreetMap standard tiles,
 * shown in grayscale via CSS) and a safe way to tear a map down.
 */
import * as L from 'leaflet';

/** Leaflet internals that outlive remove() as pending timers. */
interface LeafletTimers {
  _animatingZoom?: boolean;
  scrollWheelZoom?: { _timer?: ReturnType<typeof setTimeout> };
}

/**
 * Removes a map, also in the middle of a zoom. Two Leaflet timers survive remove() and then read the
 * deleted map pane ("Cannot read properties of undefined (reading '_leaflet_pos')"):
 * - the 250 ms zoom-animation end, e.g. when the CRS dialog closes right after its fitBounds;
 * - the 40 ms wheel-zoom debounce, e.g. when the screen changes while a trackpad still scrolls.
 * Ending the animation and clearing the debounce first makes both harmless.
 */
export function removeMap(map: L.Map): void {
  const internals = map as unknown as LeafletTimers;
  map.stop();
  internals._animatingZoom = false;
  clearTimeout(internals.scrollWheelZoom?._timer);
  map.remove();
}

/** OSM's tile usage policy asks for the single host, not the old a/b/c subdomains. */
export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** A new OSM tile layer with the required attribution. */
export function osmTileLayer(): L.TileLayer {
  return L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 });
}

/** Attribution control for small maps: just "© OpenStreetMap", without the Leaflet prefix. */
export function compactAttribution(): L.Control.Attribution {
  return L.control.attribution({ prefix: false, position: 'bottomright' });
}
