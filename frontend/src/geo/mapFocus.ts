/**
 * The map focus setting: the region the Map screen's map is restricted to. It is read once, from
 * VITE_MAP_FOCUS:
 * - `DE` (default): the map shows Germany only. Everything outside it is masked, the view can't
 *   leave it, and boreholes outside it are listed under NOT ON MAP instead of plotted.
 * - `world`: no restriction (the map as it was before the setting existed).
 * Any other value falls back to `DE`. The CRS dialog and the detail mini-map are never restricted.
 *
 * Not to be confused with the store's `mapFocus`, which is the header search's fly-to signal.
 */
import { GERMANY_BBOX, GERMANY_POLYGONS } from './germany';
import { distanceToRingsKm, inBox, padBox, pointInMultiPolygon, type LatLngBox, type MultiPolygonRings } from './polygon';

export type MapFocusSetting = 'DE' | 'world';

/** Parses a VITE_MAP_FOCUS value: `world` (any case) or else `DE`, the default. */
export function parseMapFocus(raw: string | undefined): MapFocusSetting {
  return raw?.trim().toLowerCase() === 'world' ? 'world' : 'DE';
}

/** The configured map focus, read once. */
export const MAP_FOCUS: MapFocusSetting = parseMapFocus(import.meta.env.VITE_MAP_FOCUS);

/** A region the map can be restricted to. */
export interface FocusRegion {
  code: 'DE';
  /** Used in UI text, e.g. "Outside map focus (Germany)". */
  name: string;
  polygons: MultiPolygonRings;
  bounds: LatLngBox;
  /**
   * Points this close (km) outside the outline still count as inside. The 1:50m outline is
   * generalised by up to about a kilometre, which matters along rivers that form the border
   * (e.g. the Upper Rhine): a borehole on the German bank must not drop off the map.
   */
  toleranceKm: number;
}

export const GERMANY: FocusRegion = {
  code: 'DE',
  name: 'Germany',
  polygons: GERMANY_POLYGONS,
  bounds: GERMANY_BBOX,
  toleranceKm: 2,
};

/** The region for a setting; null means no restriction. */
export function focusRegion(setting: MapFocusSetting): FocusRegion | null {
  return setting === 'DE' ? GERMANY : null;
}

/** The configured focus region, or null when the map shows the whole world. */
export const FOCUS_REGION: FocusRegion | null = focusRegion(MAP_FOCUS);

/** Degrees that cover `km` in both directions up to 60° latitude (1° of longitude is ≥ 55 km there). */
const kmToDeg = (km: number) => km / 55;

/** True if the point lies in the region, or within its border tolerance. */
export function inFocusRegion(region: FocusRegion, lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  // Cheap rejection first: most points far away never reach the polygon tests.
  if (!inBox(lat, lng, padBox(region.bounds, kmToDeg(region.toleranceKm)))) return false;
  return (
    pointInMultiPolygon(lat, lng, region.polygons) || distanceToRingsKm(lat, lng, region.polygons) <= region.toleranceKm
  );
}

/** NOT ON MAP reason for a borehole whose coordinates lie outside the region. */
export function outsideFocusReason(region: FocusRegion): string {
  return `Outside map focus (${region.name})`;
}
