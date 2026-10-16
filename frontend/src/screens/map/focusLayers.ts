/**
 * Leaflet side of the map focus (VITE_MAP_FOCUS=DE, see src/geo/mapFocus.ts), used by the Map
 * screen's map only:
 * - a mask: one polygon covering the world with the region cut out, filled with the map background,
 *   so tiles outside the region are not seen;
 * - the region's border as a thin dark-green line;
 * - view limits: the view can't pan past the region's box (plus a margin) or zoom out beyond the
 *   zoom at which the whole region fits.
 * Mask and border sit in their own pane between the tiles and the pins, so pins stay on top and
 * clickable. Both are non-interactive.
 */
import * as L from 'leaflet';
import type { FocusRegion } from '../../geo/mapFocus';
import { padBox, type LatLngBox, type Ring } from '../../geo/polygon';
import { COL } from '../../theme';

/** Pane of mask and border. Leaflet's tile pane is z-index 200, vectors (pins) 400, markers 600. */
export const FOCUS_PANE = 'bormisuFocus';
const FOCUS_PANE_Z_INDEX = 350;

/** How far (degrees) the view may pan beyond the region's bounding box. */
const MAX_BOUNDS_MARGIN_DEG = 0.5;

/** Space (px) kept between the region and the map edge when the whole region is shown. */
export const FIT_PADDING_PX = 12;

/** Map background behind the tiles (tokens.css `.leaflet-container`, --c-line). */
const MASK_COLOR = COL.line;
const BORDER_COLOR = COL.dark;
const BORDER_WEIGHT = 1.5;

/** The world rectangle the region is cut out of. ±85° is about where Web Mercator ends. */
const WORLD: L.LatLngTuple[] = [
  [-85, -180],
  [85, -180],
  [85, 180],
  [-85, 180],
];

const toTuples = (ring: Ring): L.LatLngTuple[] => ring.map(([lat, lng]) => [lat, lng]);
const toBounds = ([[south, west], [north, east]]: LatLngBox) =>
  L.latLngBounds([
    [south, west],
    [north, east],
  ]);

/** The region's bounding box as Leaflet bounds. */
export const regionBounds = (region: FocusRegion): L.LatLngBounds => toBounds(region.bounds);

/** Map options that keep the view on the region: hard max bounds (viscosity 1). */
export function focusMapOptions(region: FocusRegion): L.MapOptions {
  return { maxBounds: toBounds(padBox(region.bounds, MAX_BOUNDS_MARGIN_DEG)), maxBoundsViscosity: 1 };
}

/** fitBounds options of the region view, the same padding fitMinZoom uses. */
export const fitOptions: L.FitBoundsOptions = { padding: [FIT_PADDING_PX, FIT_PADDING_PX] };

/** Adds the mask and the border line in their own pane. */
export function addFocusLayers(map: L.Map, region: FocusRegion): void {
  const pane = map.createPane(FOCUS_PANE);
  pane.style.zIndex = String(FOCUS_PANE_Z_INDEX);
  // One SVG renderer for both. Its padding (1 = one map size on every side) keeps the mask drawn well
  // past the view, so a fast pan or a zoom-out animation never shows unmasked tiles before the
  // renderer redraws at the end of the move.
  const renderer = L.svg({ pane: FOCUS_PANE, padding: 1 });
  const rings = region.polygons.map((polygon) => polygon.map(toTuples));

  // Every outline (and any hole, which the even-odd fill rule then masks again) cuts a hole into the world.
  L.polygon([WORLD, ...rings.flat()], {
    renderer,
    pane: FOCUS_PANE,
    stroke: false,
    fillColor: MASK_COLOR,
    fillOpacity: 1,
    fillRule: 'evenodd',
    interactive: false,
    className: 'bormisu-focus-mask',
  }).addTo(map);

  L.polygon(rings, {
    renderer,
    pane: FOCUS_PANE,
    fill: false,
    color: BORDER_COLOR,
    weight: BORDER_WEIGHT,
    opacity: 1,
    lineJoin: 'round',
    interactive: false,
    className: 'bormisu-focus-border',
  }).addTo(map);
}

/**
 * Sets the minimum zoom to the largest zoom at which the whole region fits the map, so the user
 * can't zoom out beyond it. Call again whenever the map size changes.
 */
export function fitMinZoom(map: L.Map, region: FocusRegion): void {
  const size = map.getSize();
  if (size.x <= 0 || size.y <= 0) return;
  // getBoundsZoom never returns less than the current minZoom, which is too high after the map shrank.
  const current = map.options.minZoom;
  map.options.minZoom = 0;
  const zoom = map.getBoundsZoom(regionBounds(region), false, L.point(2 * FIT_PADDING_PX, 2 * FIT_PADDING_PX));
  map.options.minZoom = current;
  map.setMinZoom(zoom);
}
