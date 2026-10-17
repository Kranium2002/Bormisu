/**
 * Map movements that respect prefers-reduced-motion (FRONTEND.md F15): flights become instant moves.
 * Read at the moment of each move, so a changed system setting applies at once.
 */
import * as L from 'leaflet';
import { bboxBounds, FIT_MAX_ZOOM, isPointBbox, POINT_ZOOM, type Bbox, type FitPadding } from '../mapModel';

/** Duration of a flight (search, result set, place, selection from the table). */
export const FLY_DURATION_S = 0.8;

/** True when the user asked the system for reduced motion. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Flies to a bbox ([min_lon, min_lat, max_lon, max_lat]) with the padding (flyToBounds), or moves
 * there at once under reduced motion or while the map has no size. A bbox of no size (a point) is
 * shown at POINT_ZOOM.
 */
export function flyToBbox(map: L.Map, bbox: Bbox, padding: FitPadding): void {
  const size = map.getSize();
  const instant = prefersReducedMotion() || size.x === 0 || size.y === 0;
  if (isPointBbox(bbox)) {
    const at: L.LatLngTuple = [bbox[1], bbox[0]];
    if (instant) map.setView(at, POINT_ZOOM, { animate: false });
    else map.flyTo(at, POINT_ZOOM, { duration: FLY_DURATION_S });
    return;
  }
  const bounds = L.latLngBounds(bboxBounds(bbox));
  if (instant) map.fitBounds(bounds, { ...padding, maxZoom: FIT_MAX_ZOOM, animate: false });
  else map.flyToBounds(bounds, { ...padding, maxZoom: FIT_MAX_ZOOM, duration: FLY_DURATION_S });
}
