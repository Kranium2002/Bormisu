/**
 * The area a map view shows, as plain numbers (no Leaflet): the map's centre and zoom in a box of a
 * given size, in the Web Mercator of the map tiles (256 px tiles: the world is 256 × 2^zoom px wide).
 * The 3D view uses it to take "what the map shows" when nothing is selected.
 */
import type { Area } from '../../domain/types';
import type { MapView } from '../../routing/urlState';

/** Latitude where the square Web Mercator world ends. */
const MAX_LAT = 85.0511287798;

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** The box [west, south, east, north] a map of `size` px shows at `view`; null without a size. */
export function viewArea(view: MapView, size: { width: number; height: number }): Area | null {
  if (!(size.width > 0) || !(size.height > 0)) return null;
  const world = 256 * 2 ** view.zoom;
  const x = ((view.lng + 180) / 360) * world;
  const lat = (clamp(view.lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * world;
  const lngAt = (px: number) => clamp((px / world) * 360 - 180, -180, 180);
  const latAt = (py: number) => clamp((Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / world))) * 180) / Math.PI, -MAX_LAT, MAX_LAT);
  const round = (d: number) => Number(d.toFixed(6));
  return {
    type: 'bbox',
    bbox: [round(lngAt(x - size.width / 2)), round(latAt(y + size.height / 2)), round(lngAt(x + size.width / 2)), round(latAt(y - size.height / 2))],
  };
}
