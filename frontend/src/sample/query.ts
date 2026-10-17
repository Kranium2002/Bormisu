// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/**
 * In-memory queries of the sample source with the backend's semantics (contract BoreholeFilter,
 * ResultSet, BoreholeFeatureCollection, PlaceCandidate): the light map features, filters with areas,
 * result sets, and a small fictional gazetteer for place search.
 */
import { K } from '../domain/keys';
import { hasAttention } from '../domain/status';
import type { Area, Borehole, BoreholeFilter, MapFeature, PlaceCandidate, ResultSet } from '../domain/types';

/** [min_lon, min_lat, max_lon, max_lat]. */
export type Bbox = [number, number, number, number];

/** True when a borehole is placed on the map (the server's `plotted` with a position). */
export function isLocated(b: Borehole): boolean {
  return b.onMap && b.lat != null && b.lng != null;
}

/** The light map feature of a placed borehole (what GET /map/boreholes.geojson carries). */
export function toFeature(b: Borehole): MapFeature {
  return {
    uid: b.uid,
    id: b.id,
    project: b.project || null,
    documentId: b.documentId,
    lat: b.lat as number,
    lng: b.lng as number,
    depth: b.finalDepth,
    reviewStatus: b.reviewStatus,
    crsStatus: b.crs.status,
    revision: b.revision,
    attention: hasAttention(b),
    openClarifications: b.openClarifications,
  };
}

/** Features of the placed boreholes, in the given order. */
export function featuresOf(boreholes: Borehole[]): MapFeature[] {
  return boreholes.filter(isLocated).map(toFeature);
}

/* ---------- geometry (WGS84) ---------- */

/** Mean earth radius (m), as the haversine distance uses it. */
const EARTH_RADIUS_M = 6_371_008.8;
/** Metres per degree of latitude, as the backend sizes a circle's bbox. */
const M_PER_DEGREE = 111_320;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in m between two [lon, lat] points. */
export function haversineM(a: readonly [number, number], b: readonly [number, number]): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting: true when [lon, lat] lies inside one ring (positions [lon, lat]). */
function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when [lon, lat] lies inside a GeoJSON polygon: inside its outer ring and outside its holes. */
export function inPolygon(lon: number, lat: number, rings: number[][][]): boolean {
  if (!rings.length || !inRing(lon, lat, rings[0])) return false;
  return !rings.slice(1).some((hole) => inRing(lon, lat, hole));
}

/** True when [lon, lat] lies in the area; a bbox with min_lon > max_lon crosses the antimeridian. */
export function inArea(lon: number, lat: number, area: Area): boolean {
  if (area.type === 'bbox') {
    const [minLon, minLat, maxLon, maxLat] = area.bbox;
    if (lat < minLat || lat > maxLat) return false;
    return minLon <= maxLon ? lon >= minLon && lon <= maxLon : lon >= minLon || lon <= maxLon;
  }
  if (area.type === 'polygon') return inPolygon(lon, lat, area.polygon.coordinates);
  return haversineM(area.center, [lon, lat]) <= area.radiusM;
}

/** The bbox of an area (the backend's rule; a circle by its radius in degrees, clamped to the world). */
export function areaBbox(area: Area): Bbox {
  if (area.type === 'bbox') return [...area.bbox];
  if (area.type === 'polygon') {
    const points = area.polygon.coordinates.flat();
    const lons = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }
  const [lon, lat] = area.center;
  const dLat = area.radiusM / M_PER_DEGREE;
  const dLon = area.radiusM / (M_PER_DEGREE * Math.max(Math.cos(rad(lat)), 0.01));
  return [Math.max(lon - dLon, -180), Math.max(lat - dLat, -90), Math.min(lon + dLon, 180), Math.min(lat + dLat, 90)];
}

/** The bbox around placed boreholes, or null when none is placed. */
export function boundsOf(boreholes: Borehole[]): Bbox | null {
  const placed = boreholes.filter(isLocated);
  if (!placed.length) return null;
  const lons = placed.map((b) => b.lng as number);
  const lats = placed.map((b) => b.lat as number);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/* ---------- filters and result sets ---------- */

/** Text of one value of a borehole ('' when it has none). */
const valueText = (b: Borehole, key: string) => b.values.find((v) => v.key === key)?.value ?? '';
const lower = (s: string) => s.trim().toLowerCase();

/**
 * True when a borehole matches a filter, as the backend's filter does: search in the ID, the printed
 * IDs, the name, the location and the project (case-insensitive); country and project equal ignoring
 * case; depth bounds on the stated final depth (unknown never matches); a DIN code on any layer (with
 * lithologyMinDepth, a layer reaching below it); SPT as an N value or a refusal; any groundwater reading;
 * the review statuses; the area on the borehole's position (a borehole without one is never in an area).
 * With `reviewScope`, include_unreviewed false keeps approved boreholes only.
 */
export function matchesFilter(b: Borehole, f: BoreholeFilter, reviewScope = true): boolean {
  const search = f.search?.trim();
  if (search) {
    const q = search.toLowerCase();
    const texts = [b.id, ...b.meta.aliases, b.project, valueText(b, K.boreholeName), valueText(b, K.locationName)];
    if (!texts.some((t) => t.toLowerCase().includes(q))) return false;
  }
  if (f.country?.trim() && lower(valueText(b, K.country)) !== lower(f.country)) return false;
  if (f.project?.trim() && lower(b.project) !== lower(f.project)) return false;
  if (f.documentId && b.documentId !== f.documentId) return false;
  if (f.minDepth != null && (b.finalDepth == null || b.finalDepth < f.minDepth)) return false;
  if (f.maxDepth != null && (b.finalDepth == null || b.finalDepth > f.maxDepth)) return false;
  if (f.dinCodes.length) {
    const reach = f.lithologyMinDepth;
    if (!b.layers.some((l) => l.din != null && f.dinCodes.includes(l.din) && (reach == null || l.to > reach))) return false;
  }
  if (f.hasSpt != null) {
    const spt = b.layers.some((l) => l.spt != null && (l.spt.n != null || l.spt.refusal));
    if (spt !== f.hasSpt) return false;
  }
  if (f.hasGroundwater != null && (b.groundwater.length > 0) !== f.hasGroundwater) return false;
  if (f.reviewStatus.length && !f.reviewStatus.includes(b.reviewStatus)) return false;
  if (f.area && !(isLocated(b) && inArea(b.lng as number, b.lat as number, f.area))) return false;
  return !reviewScope || f.includeUnreviewed || b.reviewStatus === 'approved';
}

/**
 * Runs a filter as the backend stores a result set: members ordered by uid; located members are the
 * placed ones; the bbox is theirs, else the area's, else null; with include_unreviewed false the matches
 * that are not approved are left out and counted.
 */
export function runResultSet(boreholes: Borehole[], filter: BoreholeFilter, id: string, createdAt: string): ResultSet {
  const any = boreholes.filter((b) => matchesFilter(b, filter, false));
  const members = any.filter((b) => matchesFilter(b, filter)).sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  const located = members.filter(isLocated);
  return {
    id,
    count: members.length,
    locatedCount: located.length,
    unlocatedCount: members.length - located.length,
    excludedUnreviewed: any.length - members.length,
    uids: members.map((b) => b.uid),
    bbox: boundsOf(located) ?? (filter.area ? areaBbox(filter.area) : null),
    area: filter.area ? structuredClone(filter.area) : null,
    definition: structuredClone(filter),
    createdAt,
  };
}

/* ---------- place search (a small fictional gazetteer) ---------- */

/** A place of the sample's "geocoder": fictional towns near the sample sites, and one far from any. */
interface Town { label: string; kind: string; lat: number; lng: number; bbox: Bbox }

const TOWNS: Town[] = [
  { label: 'Neckarweiler (fictional town)', kind: 'city', lat: 48.796, lng: 9.2, bbox: [9.15, 48.765, 9.25, 48.83] },
  { label: 'Elbhafen-Ost (fictional town)', kind: 'city', lat: 53.535, lng: 10.02, bbox: [9.97, 53.505, 10.07, 53.565] },
  { label: 'Mainau-Süd (fictional town)', kind: 'district', lat: 50.105, lng: 8.69, bbox: [8.64, 50.075, 8.74, 50.135] },
  { label: 'Lindenfurt (fictional town)', kind: 'city', lat: 47.61, lng: 11.02, bbox: [10.97, 47.58, 11.07, 47.64] },
];

/** Padding (degrees) around a project's boreholes for its site bbox. */
const SITE_PADDING = 0.005;
/** Candidates per search, like the API's default limit. */
export const PLACE_LIMIT = 5;

/** Lower case without diacritics, so "mainau-sud" finds "Mainau-Süd". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Placed boreholes inside a bbox. */
function countIn(boreholes: Borehole[], bbox: Bbox): number {
  return boreholes.filter((b) => isLocated(b) && inArea(b.lng as number, b.lat as number, { type: 'bbox', bbox })).length;
}

/**
 * Place search: uploaded places first (a site per project with placed boreholes, named after the
 * project), then the fictional towns; each with the placed boreholes inside its bbox (a town may hold
 * none). Case- and accent-insensitive substring of the label; an unknown place gives [].
 */
export function searchPlaces(boreholes: Borehole[], query: string): PlaceCandidate[] {
  const q = fold(query.trim());
  const sites: PlaceCandidate[] = [];
  const projects = [...new Set(boreholes.filter(isLocated).map((b) => b.project))];
  for (const project of projects) {
    const own = boreholes.filter((b) => b.project === project);
    const box = boundsOf(own) as Bbox;
    const bbox: Bbox = [box[0] - SITE_PADDING, box[1] - SITE_PADDING, box[2] + SITE_PADDING, box[3] + SITE_PADDING];
    const label = `${project} project site (uploaded)`;
    if (!fold(label).includes(q)) continue;
    sites.push({
      label, lat: (bbox[1] + bbox[3]) / 2, lng: (bbox[0] + bbox[2]) / 2, bbox, source: 'uploaded', kind: 'project_site',
      boreholeCount: countIn(boreholes, bbox),
    });
  }
  const towns: PlaceCandidate[] = TOWNS.filter((t) => fold(t.label).includes(q)).map((t) => ({
    label: t.label, lat: t.lat, lng: t.lng, bbox: [...t.bbox], source: 'geocoder', kind: t.kind, boreholeCount: countIn(boreholes, t.bbox),
  }));
  return [...sites, ...towns].slice(0, PLACE_LIMIT);
}
