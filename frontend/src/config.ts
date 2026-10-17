/**
 * Build-time settings, read once from Vite env variables (Docker build args in production).
 * Nothing here is secret: the frontend has no keys.
 */

/** Product name in the UI. Change it here or with VITE_APP_NAME; nothing else names the product. */
export const APP_NAME = import.meta.env.VITE_APP_NAME?.trim() || 'Bormisu';

/** Basemap tiles. OSM's tile usage policy asks for the single host, not the old a/b/c subdomains. */
export const TILE_URL = import.meta.env.VITE_TILE_URL?.trim() || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** Attribution the tile source requires (HTML, rendered by Leaflet's attribution control). */
export const TILE_ATTRIBUTION =
  import.meta.env.VITE_TILE_ATTRIBUTION?.trim() ||
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
