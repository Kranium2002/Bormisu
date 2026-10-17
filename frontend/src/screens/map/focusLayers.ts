/**
 * Leaflet side of the map focus (src/geo/mapFocus.ts), used by the Map screen's map only.
 *
 * Country focus:
 * - a mask: one polygon covering the world with the country cut out, filled with the map background,
 *   so tiles outside the country are not seen;
 * - the country's border as a thin dark-green line;
 * - view limits: the view can't pan past the country's box (plus a margin) or zoom out beyond the
 *   zoom at which the whole country fits.
 * World focus: no mask, no border, no limits.
 *
 * Mask and border sit in their own pane between the tiles and the pins, so pins stay on top and
 * clickable. Both are non-interactive. Switching the focus replaces them (BoreholeMap keeps them in
 * one layer group and clears it).
 */
import * as L from 'leaflet';
import type { Country } from '../../geo/countries';
import { padBox, type LatLngBox, type Ring } from '../../geo/polygon';
import { COL } from '../../theme';

/** Pane of mask and border. Leaflet's tile pane is z-index 200, vectors (pins) 400, markers 600. */
export const FOCUS_PANE = 'bormisuFocus';
const FOCUS_PANE_Z_INDEX = 350;

/** How far (degrees) the view may pan beyond the country's box. */
const MAX_BOUNDS_MARGIN_DEG = 0.5;

/** Space (px) kept between the country and the map edge when the whole country is shown. */
export const FIT_PADDING_PX = 12;

/** World view: the pins' bounds with this padding, never closer than street level. */
const WORLD_FIT: L.FitBoundsOptions = { padding: [24, 24], maxZoom: 12, animate: false };

/** Map background behind the tiles (tokens.css `.leaflet-container`, --c-line). */
const MASK_COLOR = COL.line;
const BORDER_COLOR = COL.dark;
const BORDER_WEIGHT = 1.5;

/** The world rectangle the country is cut out of. ±85° is about where Web Mercator ends. */
const WORLD: L.LatLngTuple[] = [
  [-85, -180],
  [85, -180],
  [85, 180],
  [-85, 180],
];

const toTuples = (ring: Ring): L.LatLngTuple[] => ring.map(([lat, lng]) => [lat, lng]);

/** A box as Leaflet bounds. */
export const toBounds = ([[south, west], [north, east]]: LatLngBox): L.LatLngBounds =>
  L.latLngBounds([
    [south, west],
    [north, east],
  ]);

/** fitBounds options of the country view, the same padding fitMinZoom uses. */
export const countryFitOptions: L.FitBoundsOptions = { padding: [FIT_PADDING_PX, FIT_PADDING_PX], animate: false };

/**
 * Creates the focus pane and the SVG renderer mask and border share. Call once per map. The renderer's
 * padding (1 = one map size on every side) keeps the mask drawn well past the view, so a fast pan or a
 * zoom-out animation never shows unmasked tiles before the renderer redraws at the end of the move.
 */
export function createFocusRenderer(map: L.Map): L.Renderer {
  const pane = map.createPane(FOCUS_PANE);
  pane.style.zIndex = String(FOCUS_PANE_Z_INDEX);
  return L.svg({ pane: FOCUS_PANE, padding: 1 });
}

/** Mask and border of a country (add them to the map, e.g. through a layer group). */
export function countryLayers(country: Country, renderer: L.Renderer): L.Polygon[] {
  const rings = country.polygons.map((polygon) => polygon.map(toTuples));
  // Every outline (and any hole, which the even-odd fill rule then masks again) cuts a hole into the world.
  const mask = L.polygon([WORLD, ...rings.flat()], {
    renderer,
    pane: FOCUS_PANE,
    stroke: false,
    fillColor: MASK_COLOR,
    fillOpacity: 1,
    fillRule: 'evenodd',
    interactive: false,
    className: 'bormisu-focus-mask',
  });
  const border = L.polygon(rings, {
    renderer,
    pane: FOCUS_PANE,
    fill: false,
    color: BORDER_COLOR,
    weight: BORDER_WEIGHT,
    opacity: 1,
    lineJoin: 'round',
    interactive: false,
    className: 'bormisu-focus-border',
  });
  return [mask, border];
}

/** Keeps the view on the box: hard max bounds (viscosity 1, a map option) and the matching minimum zoom. */
export function setCountryLimits(map: L.Map, box: LatLngBox): void {
  map.setMaxBounds(toBounds(padBox(box, MAX_BOUNDS_MARGIN_DEG)));
  fitMinZoom(map, box);
}

/** Lifts the country limits (World). */
export function clearCountryLimits(map: L.Map): void {
  // Invalid (empty) bounds remove the max bounds and their moveend handler.
  map.setMaxBounds(L.latLngBounds([]));
  map.setMinZoom(0);
}

/**
 * Sets the minimum zoom to the largest zoom at which the whole box fits the map, so the user can't
 * zoom out beyond it. Call again whenever the map size changes.
 */
export function fitMinZoom(map: L.Map, box: LatLngBox): void {
  const size = map.getSize();
  if (size.x <= 0 || size.y <= 0) return;
  // getBoundsZoom never returns less than the current minZoom, which is too high after the map shrank.
  const current = map.options.minZoom;
  map.options.minZoom = 0;
  const zoom = map.getBoundsZoom(toBounds(box), false, L.point(2 * FIT_PADDING_PX, 2 * FIT_PADDING_PX));
  map.options.minZoom = current;
  map.setMinZoom(zoom);
}

/** Shows the country's box (the same view as the smallest zoom allowed). */
export function fitCountry(map: L.Map, box: LatLngBox): void {
  if (hasSize(map)) map.fitBounds(toBounds(box), countryFitOptions);
  else map.setView(toBounds(box).getCenter(), 5, { animate: false });
}

/** World view: every pin, or the whole world when there is none. */
export function fitWorld(map: L.Map, pins: LatLngBox | null): void {
  if (!pins) map.setView([30, 10], 2, { animate: false });
  else if (hasSize(map)) map.fitBounds(toBounds(pins), WORLD_FIT);
  else map.setView(toBounds(pins).getCenter(), 4, { animate: false });
}

function hasSize(map: L.Map): boolean {
  const { x, y } = map.getSize();
  return x > 0 && y > 0;
}
