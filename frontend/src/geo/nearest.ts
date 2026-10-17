/**
 * Distances and directions between points on the earth, and the k nearest points to a position.
 * Pure, no Leaflet. Used by the map's NEAR YOU panel; meant to be reused (e.g. "nearest evidence").
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Mean earth radius (IUGG), metres. */
export const EARTH_RADIUS_M = 6371008.8;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). Accurate to about 0.5 % (the earth isn't a sphere). */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `from` to `to`, degrees clockwise from north, 0 ≤ b < 360. */
export function bearingDeg(from: GeoPoint, to: GeoPoint): number {
  const φ1 = rad(from.lat);
  const φ2 = rad(to.lat);
  const Δλ = rad(to.lng - from.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Compass = (typeof COMPASS_POINTS)[number];

/** Eight-point compass direction of a bearing: N covers 337.5°–22.5°, NE 22.5°–67.5°, and so on. */
export function compass(bearing: number): Compass {
  const b = ((bearing % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(b / 45) % 8];
}

export interface Nearby<T> {
  item: T;
  distanceM: number;
  /** From the position to the item. */
  bearingDeg: number;
  direction: Compass;
}

/** The k items nearest to `from`, nearest first (equal distances keep the input order). */
export function nearest<T extends GeoPoint>(from: GeoPoint, items: readonly T[], k: number): Nearby<T>[] {
  return items
    .map((item, i) => ({ item, i, distanceM: haversineM(from, item) }))
    .sort((a, b) => a.distanceM - b.distanceM || a.i - b.i)
    .slice(0, Math.max(0, k))
    .map(({ item, distanceM }) => {
      const b = bearingDeg(from, item);
      return { item, distanceM, bearingDeg: b, direction: compass(b) };
    });
}

/** "350 m" below 1 km, else "1.2 km" (one decimal). */
export function formatDistance(m: number): string {
  const metres = Math.round(m);
  return metres < 1000 ? `${metres} m` : `${(m / 1000).toFixed(1)} km`;
}
