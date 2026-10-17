/**
 * Which country a point (a borehole) lies in. Pure: bounding-box rejection first, then
 * point-in-polygon, then the border tolerance.
 *
 * The tolerance: a point up to 2 km outside a country's outline still counts as in that country. The
 * 1:50m outlines are generalised by up to about a kilometre (plus 0.01° of simplification), which
 * matters along rivers that form a border (a borehole on the German bank of the Upper Rhine must not
 * drop off the Germany map) and along coasts (a harbour borehole must not fall into the sea).
 */
import type { Country } from './countries';
import { distanceToRingsKm, inBox, nearBox, pointInPolygon } from './polygon';

/** Points this close (km) outside an outline still count as inside. */
export const BORDER_TOLERANCE_KM = 2;

export interface CountryHit {
  /**
   * The point's country: the one whose outline contains it, else the one with the nearest outline
   * within the tolerance. Null when no country is that close (offshore, or a Natural Earth unit without
   * an ISO code).
   */
  country: string | null;
  /**
   * Every country whose map focus shows the point: the containing country plus every country within the
   * tolerance, `country` first. Near a border a point can be in two country views.
   */
  countries: readonly string[];
}

const NOWHERE: CountryHit = { country: null, countries: [] };

/** True if the point lies inside the country's outline (and in none of its holes). */
export function containsPoint(c: Country, lat: number, lng: number): boolean {
  if (!inBox(lat, lng, c.bounds)) return false;
  return c.polygons.some((p, i) => inBox(lat, lng, c.polygonBounds[i]) && pointInPolygon(lat, lng, p));
}

/** Distance (km) from the point to the country's nearest outline, or Infinity when farther than `maxKm`. */
export function distanceToCountryKm(c: Country, lat: number, lng: number, maxKm: number): number {
  if (!nearBox(lat, lng, c.bounds, maxKm)) return Infinity;
  let best = Infinity;
  c.polygons.forEach((p, i) => {
    if (nearBox(lat, lng, c.polygonBounds[i], maxKm)) best = Math.min(best, distanceToRingsKm(lat, lng, [p]));
  });
  return best <= maxKm ? best : Infinity;
}

/** True if the country's map focus shows the point: inside the outline or within the tolerance. */
export function inCountry(c: Country, lat: number, lng: number, toleranceKm = BORDER_TOLERANCE_KM): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return containsPoint(c, lat, lng) || distanceToCountryKm(c, lat, lng, toleranceKm) <= toleranceKm;
}

/** Locates one point among the countries. */
export function locatePoint(
  countries: readonly Country[],
  lat: number,
  lng: number,
  toleranceKm = BORDER_TOLERANCE_KM,
): CountryHit {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NOWHERE;
  const inside: Country[] = [];
  const near: { code: string; km: number }[] = [];
  for (const c of countries) {
    if (!nearBox(lat, lng, c.bounds, toleranceKm)) continue;
    if (containsPoint(c, lat, lng)) inside.push(c);
    else {
      const km = distanceToCountryKm(c, lat, lng, toleranceKm);
      if (km <= toleranceKm) near.push({ code: c.code, km });
    }
  }
  near.sort((a, b) => a.km - b.km || a.code.localeCompare(b.code));
  // Shared borders are simplified identically, so outlines don't overlap; should two ever both contain
  // the point, the one it lies deeper inside wins.
  const depth = (c: Country) => distanceToRingsKm(lat, lng, c.polygons);
  const ordered = inside.length > 1 ? [...inside].sort((a, b) => depth(b) - depth(a)) : inside;
  const codes = [...ordered.map((c) => c.code), ...near.map((n) => n.code)];
  return codes.length ? { country: codes[0], countries: codes } : NOWHERE;
}

/** A point to place; boreholes qualify. */
export interface LocatedPoint {
  uid: string;
  lat: number;
  lng: number;
}

export interface CountryLocator {
  /** Locates one point; results are cached per coordinate. */
  locate(lat: number, lng: number): CountryHit;
  /** Locates every point, keyed by uid. */
  assign(points: readonly LocatedPoint[]): Map<string, CountryHit>;
}

/**
 * A locator over the countries that remembers every coordinate it has seen, so re-assigning the
 * boreholes after a review edit (same coordinates, new objects) costs a map lookup each.
 */
export function createCountryLocator(countries: readonly Country[], toleranceKm = BORDER_TOLERANCE_KM): CountryLocator {
  const cache = new Map<string, CountryHit>();
  const locate = (lat: number, lng: number): CountryHit => {
    const key = `${lat},${lng}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = locatePoint(countries, lat, lng, toleranceKm);
      cache.set(key, hit);
    }
    return hit;
  };
  return {
    locate,
    assign: (points) => new Map(points.map((p) => [p.uid, locate(p.lat, p.lng)])),
  };
}

const locators = new WeakMap<readonly Country[], CountryLocator>();

/** The shared locator of a country list (one per loaded list, so its cache survives remounts). */
export function countryLocator(countries: readonly Country[]): CountryLocator {
  let l = locators.get(countries);
  if (!l) {
    l = createCountryLocator(countries);
    locators.set(countries, l);
  }
  return l;
}
