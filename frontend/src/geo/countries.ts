/**
 * Country outlines for the Map screen's map focus.
 *
 * Source: Natural Earth 1:50m Cultural Vectors, Admin 0 - Countries (ne_50m_admin_0_countries),
 * https://www.naturalearthdata.com/, public domain (Natural Earth).
 *
 * `countries-50m.json` next to this file is generated (do not edit by hand): 237 countries and
 * territories with an ISO 3166-1 alpha-2 code, simplified with a topology-preserving Douglas-Peucker
 * (0.01°, shared borders stay identical in both countries), coordinates to 3 decimals, rings stored as
 * integer deltas (see its "encoding" field). Three Natural Earth units without an ISO code (Somaliland,
 * N. Cyprus, Siachen Glacier) are left out; points there count as in no country. The raw download is not
 * in the repo.
 *
 * The file is not part of the JavaScript bundle: Vite emits it as a hashed asset and `loadCountries()`
 * fetches it the first time the Map screen mounts.
 */
import countriesUrl from './countries-50m.json?url';
import type { LatLng, LatLngBox, MultiPolygonRings, PolygonRings, Ring } from './polygon';

export interface Country {
  /** ISO 3166-1 alpha-2, e.g. `DE` (Natural Earth ISO_A2; ISO_A2_EH for France, Norway and Kosovo). */
  code: string;
  /** English short name, e.g. "Germany". */
  name: string;
  /** In each polygon the first ring is the outline, any further rings are holes. Largest polygon first. */
  polygons: MultiPolygonRings;
  /** Bounding box of every polygon, overseas territories included. */
  bounds: LatLngBox;
  /**
   * The main territory: the largest polygon plus the polygons within 2° of it. The map fits this
   * (France without French Guiana, the USA without Alaska and Hawaii, Norway without Svalbard).
   */
  view: LatLngBox;
  /** Bounding box per polygon, same order as `polygons`, for cheap rejection. */
  polygonBounds: LatLngBox[];
}

const CODE = /^[A-Z]{2}$/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readBox(v: unknown, what: string): LatLngBox {
  const ok =
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum));
  if (!ok) throw new Error(`Country outlines: bad ${what}`);
  const [[s, w], [n, e]] = v as [[number, number], [number, number]];
  return [
    [s, w],
    [n, e],
  ];
}

/** Decodes one delta-encoded ring: integer [lat, lng] of the first point, then differences, in 1/scale degree. */
export function decodeRing(flat: readonly number[], scale: number): Ring {
  const ring: LatLng[] = [];
  let lat = 0;
  let lng = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    lat += flat[i];
    lng += flat[i + 1];
    ring.push([lat / scale, lng / scale]);
  }
  return ring;
}

function ringBox(ring: Ring): LatLngBox {
  let [s, w, n, e] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lat, lng] of ring) {
    s = Math.min(s, lat);
    n = Math.max(n, lat);
    w = Math.min(w, lng);
    e = Math.max(e, lng);
  }
  return [
    [s, w],
    [n, e],
  ];
}

/** Parses and validates the asset (the parsed JSON of countries-50m.json). Throws on anything unexpected. */
export function decodeCountries(raw: unknown): Country[] {
  const asset = raw as { scale?: unknown; countries?: unknown } | null;
  if (!asset || !isNum(asset.scale) || asset.scale <= 0 || !Array.isArray(asset.countries)) {
    throw new Error('Country outlines: unexpected file format');
  }
  const scale = asset.scale;
  return asset.countries.map((c: { code?: unknown; name?: unknown; bbox?: unknown; view?: unknown; polygons?: unknown }) => {
    if (typeof c?.code !== 'string' || !CODE.test(c.code) || typeof c.name !== 'string' || !Array.isArray(c.polygons)) {
      throw new Error('Country outlines: bad country entry');
    }
    const polygons: PolygonRings[] = c.polygons.map((poly: unknown) => {
      if (!Array.isArray(poly)) throw new Error(`Country outlines: bad polygon in ${c.code}`);
      return poly.map((flat: unknown) => {
        if (!Array.isArray(flat) || flat.length < 6 || flat.length % 2 || !flat.every(isNum)) {
          throw new Error(`Country outlines: bad ring in ${c.code}`);
        }
        return decodeRing(flat, scale);
      });
    });
    return {
      code: c.code,
      name: c.name,
      polygons,
      bounds: readBox(c.bbox, `bbox of ${c.code}`),
      view: readBox(c.view, `view of ${c.code}`),
      polygonBounds: polygons.map((p) => ringBox(p[0])),
    };
  });
}

let loading: Promise<Country[]> | null = null;
let loaded: Country[] | null = null;

/** The outlines once loaded, else null (lets a remounted screen render without a loading flash). */
export const loadedCountries = (): Country[] | null => loaded;

/**
 * Fetches and decodes the outlines, once per page load. A failed load is not cached, so the next call
 * tries again.
 */
export function loadCountries(fetchFn: typeof fetch = fetch): Promise<Country[]> {
  loading ??= fetchFn(countriesUrl)
    .then(async (r) => {
      if (!r.ok) throw new Error(`Country outlines could not be loaded (HTTP ${r.status})`);
      loaded = decodeCountries(await r.json());
      return loaded;
    })
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}
