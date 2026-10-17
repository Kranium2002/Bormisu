/**
 * Shared Leaflet helpers: the base map every map in the app uses (TILE_URL and TILE_ATTRIBUTION
 * from src/config.ts, OpenStreetMap by default, shown in grayscale via CSS) and a safe way to tear
 * a map down.
 */
import * as L from 'leaflet';
import { TILE_ATTRIBUTION, TILE_URL } from '../config';

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

/** Tile URL template of the configured basemap (build arg VITE_TILE_URL). */
export const BASEMAP_TILE_URL = TILE_URL;
/** Attribution the configured basemap requires (build arg VITE_TILE_ATTRIBUTION). */
export const BASEMAP_ATTRIBUTION = TILE_ATTRIBUTION;

/** A new tile layer of the configured basemap, with its attribution. */
export function basemapTileLayer(): L.TileLayer {
  return L.tileLayer(BASEMAP_TILE_URL, { attribution: BASEMAP_ATTRIBUTION, maxZoom: 19 });
}

/** Attribution control for small maps: just the tile attribution, without the Leaflet prefix. */
export function compactAttribution(): L.Control.Attribution {
  return L.control.attribution({ prefix: false, position: 'bottomright' });
}

/** @deprecated Kept for existing imports: the configured basemap (OpenStreetMap unless VITE_TILE_URL says otherwise). */
export const OSM_TILE_URL = BASEMAP_TILE_URL;
/** @deprecated Kept for existing imports: use BASEMAP_ATTRIBUTION. */
export const OSM_ATTRIBUTION = BASEMAP_ATTRIBUTION;
/** @deprecated Kept for existing imports: use basemapTileLayer(). */
export const osmTileLayer = basemapTileLayer;
