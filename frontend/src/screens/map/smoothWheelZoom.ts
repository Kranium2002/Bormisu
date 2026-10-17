import * as L from 'leaflet';

/** Wheel pixels per zoom level: one mouse-wheel notch (~100 px) is about one level, like Google Maps. */
const PX_PER_LEVEL = 100;
/** Share of the remaining distance to the target zoom covered per frame (higher = snappier). */
const EASE = 0.25;

/**
 * Google-Maps-like wheel zoom for a Leaflet map (instead of its stepped `scrollWheelZoom`): every wheel
 * event moves a target zoom, and the map glides there frame by frame, around the cursor. Mouse wheels and
 * trackpads both feel continuous. Returns the cleanup.
 */
export function smoothWheelZoom(map: L.Map): () => void {
  const el = map.getContainer();
  let target = map.getZoom();
  let around = L.point(0, 0);
  let frame = 0;

  const step = () => {
    const z = map.getZoom();
    const done = Math.abs(target - z) < 0.01;
    map.setZoomAround(around, done ? target : z + (target - z) * EASE, { animate: false });
    frame = done ? 0 : requestAnimationFrame(step);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!frame) target = map.getZoom();
    // deltaMode: 0 = pixels, 1 = lines (Firefox mouse wheels), 2 = pages.
    const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
    target = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), target - px / PX_PER_LEVEL));
    around = map.mouseEventToContainerPoint(e as unknown as MouseEvent);
    if (!frame) frame = requestAnimationFrame(step);
  };

  el.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    el.removeEventListener('wheel', onWheel);
    cancelAnimationFrame(frame);
  };
}
