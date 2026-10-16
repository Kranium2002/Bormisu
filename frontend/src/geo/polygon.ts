/**
 * Pure polygon geometry on [lat, lng] coordinates: point-in-polygon by ray casting and the distance
 * from a point to a polygon's outline. No Leaflet, no projection: rings are plain lat/lng arrays,
 * which is accurate enough for a country outline at 1:50m.
 */

/** A coordinate as [lat, lng] (Leaflet order). */
export type LatLng = readonly [lat: number, lng: number];
/** A closed ring. The closing point may be repeated or left out. */
export type Ring = readonly LatLng[];
/** A polygon: the first ring is the outline, any further rings are holes. */
export type PolygonRings = readonly Ring[];
/** Several polygons, e.g. a mainland and its islands. */
export type MultiPolygonRings = readonly PolygonRings[];
/** A bounding box as [[south, west], [north, east]]. */
export type LatLngBox = readonly [LatLng, LatLng];

/**
 * True if the point lies inside the ring (ray casting, even-odd rule). A horizontal ray goes from the
 * point towards increasing longitude, and every ring edge it crosses toggles inside/outside.
 */
export function pointInRing(lat: number, lng: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    // The edge straddles the ray's latitude (half-open, so a shared vertex counts once) ...
    if (latI > lat !== latJ > lat) {
      // ... and crosses it east of the point.
      const crossLng = lngI + ((lat - latI) / (latJ - latI)) * (lngJ - lngI);
      if (lng < crossLng) inside = !inside;
    }
  }
  return inside;
}

/** True if the point lies inside the polygon's outline and in none of its holes. */
export function pointInPolygon(lat: number, lng: number, polygon: PolygonRings): boolean {
  const [outline, ...holes] = polygon;
  if (!outline || !pointInRing(lat, lng, outline)) return false;
  return !holes.some((hole) => pointInRing(lat, lng, hole));
}

/** True if the point lies inside any of the polygons. */
export function pointInMultiPolygon(lat: number, lng: number, polygons: MultiPolygonRings): boolean {
  return polygons.some((polygon) => pointInPolygon(lat, lng, polygon));
}

/** True if the point lies inside the bounding box (edges included). */
export function inBox(lat: number, lng: number, [[south, west], [north, east]]: LatLngBox): boolean {
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

/** The box grown by `deg` degrees on every side. */
export function padBox([[south, west], [north, east]]: LatLngBox, deg: number): LatLngBox {
  return [
    [south - deg, west - deg],
    [north + deg, east + deg],
  ];
}

const KM_PER_DEG = 111.32;

/**
 * Shortest distance in km from the point to any ring edge of the polygons (outlines and holes).
 * Uses a local equirectangular projection around the point, which is accurate to well under 1 %
 * for the few kilometres this is used for.
 */
export function distanceToRingsKm(lat: number, lng: number, polygons: MultiPolygonRings): number {
  const kx = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const ky = KM_PER_DEG;
  let best = Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        // Segment from J to I, relative to the point, in km.
        const ax = (ring[j][1] - lng) * kx;
        const ay = (ring[j][0] - lat) * ky;
        const bx = (ring[i][1] - lng) * kx;
        const by = (ring[i][0] - lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return best;
}
