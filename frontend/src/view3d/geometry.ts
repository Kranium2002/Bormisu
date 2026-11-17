/**
 * Geometry of the 3D view: a borehole selection drawn below the map as plain numbers (no React, no
 * deck.gl, no DOM). The screen hands these objects to deck.gl layers as they are.
 *
 * - Local metric frame: the origin is the centroid of the drawn boreholes; positions are
 *   [east, north, z] in metres, z up.
 * - Every z is a height above the scene's reference level times the vertical exaggeration k. Depths
 *   and elevations kept on scene objects for display stay in real metres.
 * - `depth` mode: every collar sits at z = 0. `elevation` mode (only when at least two drawn boreholes
 *   state a ground level, the soil chart's rule): collars stand at their ground level above the lowest
 *   one. A borehole without a ground level can't be placed then: it is drawn at z = 0 as a faint ghost,
 *   counted, and left out of every connecting line and surface.
 * - Groundwater: every drawable reading is a marker; one representative reading per borehole (rest,
 *   then standpipe, then strike; the latest date first) joins the boreholes: along a planned line as a
 *   broken polyline, otherwise as the edges of a triangulated surface. Gaps are never bridged and a
 *   borehole without a reading never gets a marker at 0.
 *
 * At most MAX_BOREHOLES are drawn (the first ones in report order); the counts say what was left out.
 */
import { Delaunay } from 'd3-delaunay';
import { DIN_UNKNOWN_FILL, dinEntry, dinLegendItems, type DinLegendItem } from '../domain/din';
import type { Borehole, GroundwaterReading, GroundwaterType } from '../domain/types';
import { canAlignByElevation, logDepth, niceStep, type ChartMode } from '../report/combinedChart';
import { elevationDatum, groundLevel } from '../report/reportModel';

/** Boreholes the view draws at most. */
export const MAX_BOREHOLES = 300;
/** Usual range of the vertical exaggeration slider. */
export const EXAGGERATION_MIN = 1;
export const EXAGGERATION_MAX = 20;
/** The most a site may ask for: boreholes a few metres deep and kilometres apart need more than 20 to be seen. */
export const EXAGGERATION_LIMIT = 500;
/** Exaggeration used when the site has no width or no depth to derive one from. */
export const EXAGGERATION_FALLBACK = 5;

/** A point of the scene: [east, north, z] in metres (z already exaggerated). */
export type Vec3 = [number, number, number];
/** A deck.gl colour: red, green, blue, alpha, each 0–255. */
export type Rgba = [number, number, number, number];
/** How columns stand: all from z = 0 (`depth`) or at their ground level (`elevation`). */
export type VerticalMode = ChartMode;
/** What the selection is: a planned line (ordered by chainage), an area, or a set of boreholes. */
export type SelectionKind = 'line' | 'area' | 'set';

/** Equatorial circumference of the Web Mercator sphere (m). */
const EARTH_CIRCUMFERENCE = 40075016.686;
/**
 * Metres per degree of latitude, and of longitude at the equator, in the local frame: the Web
 * Mercator sphere's 111 319.49 m on both axes. This is the scale deck.gl's METER_OFFSETS uses at the
 * coordinate origin, so columns drawn as metre offsets from the frame origin stand on their map
 * position (110 540 m per degree of latitude, the equator's ellipsoid value, would be 0.6 % short at
 * latitude 48 and shift columns off the map tiles).
 */
export const M_PER_DEG = EARTH_CIRCUMFERENCE / 360;
const M_PER_DEG_LAT = M_PER_DEG;
const M_PER_DEG_LON = M_PER_DEG;
/** Latitude limit of Web Mercator tiles. */
const MERCATOR_MAX_LAT = 85.0511287798066;

/** Alpha of a ghost segment (a borehole that can't be placed), of a "not logged" tail. */
const GHOST_ALPHA = 90;
const NOT_LOGGED_ALPHA = 70;
/** Fill of the "not logged" tail between the last logged layer and the final depth. */
const NOT_LOGGED_RGB: [number, number, number] = [200, 200, 200];
/** A final depth deeper than the last layer by more than this (m) gets a "not logged" tail. */
const NOT_LOGGED_MIN = 0.005;

// ---------------------------------------------------------------------------------------------------
// Small helpers

/** `v` limited to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** '#RRGGBB' (or '#RGB') as an Rgba with the given alpha; black for text that isn't a hex colour. */
export function hexToRgb(hex: string, alpha = 255): Rgba {
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 0, 0, alpha];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), alpha];
}

/**
 * Colour of a DIN code as drawn in 3D: its DIN background colour, white for `A` (a pattern without
 * a background), DIN_UNKNOWN_FILL grey for a missing or unknown code. Never a guessed colour.
 */
export function dinColor(code: string | null | undefined, alpha = 255): Rgba {
  const e = dinEntry(code);
  if (!e) return hexToRgb(DIN_UNKNOWN_FILL, alpha);
  return hexToRgb(e.colour ?? '#FFFFFF', alpha);
}

/** Horizontal distance between two scene points (x, y only). */
function dist2d(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// ---------------------------------------------------------------------------------------------------
// Local frame

/** Origin of the local metric frame: the centroid of the drawn boreholes in degrees. */
export interface Frame {
  /** Longitude of the origin (degrees). */
  lon0: number;
  /** Latitude of the origin (degrees). */
  lat0: number;
}

/** The frame centred on the mean longitude and latitude of the points ({0, 0} for no points). */
export function localFrame(points: readonly { lat: number; lng: number }[]): Frame {
  if (!points.length) return { lon0: 0, lat0: 0 };
  let lon = 0;
  let lat = 0;
  for (const p of points) {
    lon += p.lng;
    lat += p.lat;
  }
  return { lon0: lon / points.length, lat0: lat / points.length };
}

/** [east, north] in metres of a WGS 84 point in the frame (an equirectangular approximation at lat0). */
export function toLocal(frame: Frame, lng: number, lat: number): [number, number] {
  const east = (lng - frame.lon0) * M_PER_DEG_LON * Math.cos((frame.lat0 * Math.PI) / 180);
  const north = (lat - frame.lat0) * M_PER_DEG_LAT;
  return [east, north];
}

// ---------------------------------------------------------------------------------------------------
// Scale helpers

/**
 * A starting exaggeration: round(0.3 × span / height) in [1, EXAGGERATION_LIMIT], so the scene is about
 * a third as tall as the site is wide. `heightM` is what stands on the vertical axis in real metres: the
 * deepest log below ground, or the relief plus the logs by elevation. EXAGGERATION_FALLBACK when either
 * is not > 0.
 */
export function defaultExaggeration(spanM: number, heightM: number): number {
  if (!(spanM > 0) || !(heightM > 0)) return EXAGGERATION_FALLBACK;
  return clamp(Math.round((0.3 * spanM) / heightM), EXAGGERATION_MIN, EXAGGERATION_LIMIT);
}

/**
 * The upper end of the slider for a site that starts at `start`: EXAGGERATION_MAX, or a tidy value
 * (1, 2 or 5 × 10^n) of about twice the start when the site needs more, at most EXAGGERATION_LIMIT.
 */
export function exaggerationMax(start: number): number {
  if (!(start > EXAGGERATION_MAX / 2)) return EXAGGERATION_MAX;
  const p = 10 ** Math.floor(Math.log10(2 * start));
  const f = (2 * start) / p;
  return Math.min(EXAGGERATION_LIMIT, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
}

/**
 * The widest a column is drawn (m): a fourteenth of the tallest column, so a column reads as a column
 * (not a disc) at any exaggeration, and at least span / 400, so it can be found on a wide site. At
 * least 0.5. Where boreholes stand close together the screen draws them slimmer (radiusOnScreen).
 */
export function columnRadius(spanM: number, tallestSceneHeight: number): number {
  return Math.max((tallestSceneHeight || 0) / 14, (spanM || 0) / 400, 0.5);
}

/**
 * The radius columns are drawn with at a camera showing `metresPerPixel` (m): slim enough that
 * neighbours don't merge (0.4 of their spacing), but never thinner than `minPixels` on screen, and
 * never wider than the scene's radius. Seen from afar a dense site still shows every borehole; zoomed
 * in, each column stands apart.
 */
export function radiusOnScreen(scene: Pick<Scene, 'radius' | 'spacing'>, metresPerPixel: number, minPixels = 3): number {
  const slim = scene.spacing != null ? Math.min(scene.radius, Math.max(0.4 * scene.spacing, 0.5)) : scene.radius;
  const visible = metresPerPixel > 0 ? Math.min(scene.radius, minPixels * metresPerPixel) : 0;
  return Math.max(slim, visible);
}

/**
 * How close neighbouring points stand (m): the 10th percentile of the nearest-neighbour distances.
 * Points on the same spot (within 0.5 m: the same borehole in two documents) don't count as neighbours.
 * null with fewer than two distinct spots.
 */
export function neighbourSpacing(points: readonly { x: number; y: number }[]): number | null {
  const nn: number[] = [];
  for (let i = 0; i < points.length; i++) {
    let d = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const dij = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (dij > 0.5 && dij < d) d = dij;
    }
    if (Number.isFinite(d)) nn.push(d);
  }
  if (!nn.length) return null;
  nn.sort((a, b) => a - b);
  return nn[Math.floor(0.1 * (nn.length - 1))];
}

/**
 * A level with its unit and datum: "231 m NN". A datum that already carries the metre ("m ü. NN",
 * "mNN", "moh") is not given a second one; without a datum it is "231 m".
 */
export function levelLabel(value: string, datum: string | null | undefined): string {
  const d = datum?.trim();
  if (!d) return `${value} m`;
  return /^m(?:\s|ü|\.|[A-Z]|oh\b)/.test(d) ? `${value} ${d}` : `${value} m ${d}`;
}

// ---------------------------------------------------------------------------------------------------
// Groundwater

/** Preference of reading types for the connecting line and surface; `other` never connects. */
const TYPE_RANK: Record<GroundwaterType, number> = { rest: 0, standpipe: 1, strike: 2, other: -1 };

/**
 * A reading's date as a sortable number, or null when it has none or isn't a date the view can read
 * (ISO "2021-03-12", "12.03.2021", "12/03/2021": day first, as printed on logs).
 */
export function readingTime(date: string | null): number | null {
  if (!date) return null;
  const s = date.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  m = /^(\d{4})$/.exec(s);
  if (m) return Date.UTC(+m[1], 0, 1);
  return null;
}

/**
 * The reading that stands for a borehole in the connecting line and surface: a rest level first, then
 * a standpipe reading, then a strike; `other` never. Within a type a dated reading beats an undated
 * one and the latest date wins; on a tie the first one listed. null when no reading qualifies.
 */
export function representativeReading<R extends Pick<GroundwaterReading, 'type' | 'date'>>(readings: readonly R[]): R | null {
  let best: R | null = null;
  let bestRank = Infinity;
  let bestTime: number | null = null;
  for (const r of readings) {
    const rank = TYPE_RANK[r.type] ?? -1;
    if (rank < 0) continue;
    const t = readingTime(r.date);
    const better =
      rank < bestRank || (rank === bestRank && t != null && (bestTime == null || t > bestTime));
    if (better) {
      best = r;
      bestRank = rank;
      bestTime = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------
// Lines and surfaces

/** Polylines of consecutive points: a null breaks the line and is never bridged; a lone point is dropped. */
export function connectRuns(points: readonly (Vec3 | null)[]): Vec3[][] {
  const out: Vec3[][] = [];
  let run: Vec3[] = [];
  const close = () => {
    if (run.length >= 2) out.push(run);
    run = [];
  };
  for (const p of points) {
    if (p) run.push(p);
    else close();
  }
  close();
  return out;
}

/** A triangulated surface through scene points (a TIN). */
export interface Surface {
  /** The kept triangles, each by its three corner points. */
  triangles: [Vec3, Vec3, Vec3][];
  /** Every edge of a kept triangle, once. */
  edges: [Vec3, Vec3][];
  /** How many points are a corner of a kept triangle (one per borehole). */
  boreholes: number;
}

/** Points with x and y closer than this (m) are one point. */
const SAME_POINT = 0.01;
/** A TIN never keeps an edge shorter than this limit would cut (m). */
const MIN_EDGE_LIMIT = 150;

/**
 * Delaunay triangulation over x and y. A triangle with an edge longer (horizontally) than
 * max(3 × median nearest-neighbour distance, 150 m) is dropped, so far-apart clusters aren't joined
 * by long slivers. Points at the same x, y (within 1 cm) count once (the first wins). Nothing is
 * extrapolated beyond the hull. null with fewer than 3 distinct points or when no triangle survives
 * (e.g. all points on one line).
 */
export function tin(points: readonly Vec3[]): Surface | null {
  const pts: Vec3[] = [];
  for (const p of points) {
    if (!p.every(Number.isFinite)) continue;
    if (pts.some((q) => dist2d(p, q) < SAME_POINT)) continue;
    pts.push(p);
  }
  if (pts.length < 3) return null;

  const nn = pts.map((p, i) => {
    let d = Infinity;
    for (let j = 0; j < pts.length; j++) if (j !== i) d = Math.min(d, dist2d(p, pts[j]));
    return d;
  });
  nn.sort((a, b) => a - b);
  const mid = nn.length >> 1;
  const median = nn.length % 2 ? nn[mid] : (nn[mid - 1] + nn[mid]) / 2;
  const limit = Math.max(3 * median, MIN_EDGE_LIMIT);

  const d = Delaunay.from(pts, (p) => p[0], (p) => p[1]);
  const triangles: [Vec3, Vec3, Vec3][] = [];
  const edges: [Vec3, Vec3][] = [];
  const seenEdge = new Set<string>();
  const used = new Set<number>();
  const t = d.triangles;
  for (let i = 0; i + 2 < t.length; i += 3) {
    const [a, b, c] = [t[i], t[i + 1], t[i + 2]];
    const [ab, bc, ca] = [dist2d(pts[a], pts[b]), dist2d(pts[b], pts[c]), dist2d(pts[c], pts[a])];
    if (ab > limit || bc > limit || ca > limit) continue;
    // d3-delaunay jitters collinear input into slivers: a triangle without area isn't a surface.
    const area2 = Math.abs((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1]));
    if (area2 <= 1e-6 * Math.max(ab, bc, ca) ** 2) continue;
    triangles.push([pts[a], pts[b], pts[c]]);
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push([pts[u], pts[v]]);
    }
    used.add(a).add(b).add(c);
  }
  if (!triangles.length) return null;
  return { triangles, edges, boreholes: used.size };
}

// ---------------------------------------------------------------------------------------------------
// Ground tiles (the map drawn on the ground plane)

/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

/** One slippy-map tile and its bounds. */
export interface GroundTile {
  z: number;
  x: number;
  y: number;
  /** [west, south, east, north] in degrees. */
  bounds: BBox;
}

/** The tiles that cover a padded site box at one zoom. */
export interface GroundTiles {
  zoom: number;
  tiles: GroundTile[];
  /** The padded box the tiles cover (degrees). */
  padded: BBox;
}

/** Tile column of a longitude at zoom z. */
function tileX(lng: number, z: number): number {
  const n = 2 ** z;
  return clamp(Math.floor(((lng + 180) / 360) * n), 0, n - 1);
}

/** Tile row of a latitude at zoom z (row 0 at the north). */
function tileY(lat: number, z: number): number {
  const n = 2 ** z;
  const r = (clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * Math.PI) / 180;
  return clamp(Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n), 0, n - 1);
}

/** Bounds of a tile in degrees. */
export function tileBounds(z: number, x: number, y: number): BBox {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/**
 * The map tiles under the site: the box padded on every side by the larger of 60 % of its size and
 * 150 m, at the highest zoom (at most maxZoom) whose tile cover has at most maxTiles tiles.
 */
export function groundTiles(bbox: BBox, opts: { maxTiles?: number; maxZoom?: number } = {}): GroundTiles {
  const maxTiles = opts.maxTiles ?? 36;
  const maxZoom = opts.maxZoom ?? 19;
  const [w, s, e, n] = bbox;
  const latMid = (s + n) / 2;
  const mPerDegLon = M_PER_DEG_LON * Math.max(Math.cos((latMid * Math.PI) / 180), 1e-6);
  const size = Math.max((e - w) * mPerDegLon, (n - s) * M_PER_DEG_LAT);
  const pad = Math.max(0.6 * size, 150);
  const padded: BBox = [
    Math.max(w - pad / mPerDegLon, -180),
    Math.max(s - pad / M_PER_DEG_LAT, -MERCATOR_MAX_LAT),
    Math.min(e + pad / mPerDegLon, 180),
    Math.min(n + pad / M_PER_DEG_LAT, MERCATOR_MAX_LAT),
  ];
  const cover = (z: number) => {
    const x0 = tileX(padded[0], z);
    const x1 = tileX(padded[2], z);
    const y0 = tileY(padded[3], z);
    const y1 = tileY(padded[1], z);
    return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  let zoom = 0;
  for (let z = Math.max(0, Math.floor(maxZoom)); z >= 0; z--) {
    if (cover(z).count <= maxTiles) {
      zoom = z;
      break;
    }
  }
  const { x0, x1, y0, y1 } = cover(zoom);
  const tiles: GroundTile[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z: zoom, x, y, bounds: tileBounds(zoom, x, y) });
  return { zoom, tiles, padded };
}

/** A tile's URL from a template: {z} {x} {y} filled, {s} → 'a', {r} → '' (as the report's map does). */
export function tileUrl(template: string, tile: Pick<GroundTile, 'z' | 'x' | 'y'>): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
    .replace('{s}', 'a')
    .replace('{r}', '');
}

// ---------------------------------------------------------------------------------------------------
// Scene

/** One drawn borehole. */
export interface SceneBorehole {
  uid: string;
  /** BoreholeID as printed. */
  id: string;
  /** Collar position in the local frame (m). */
  x: number;
  y: number;
  /** Collar height in the scene (exaggerated); 0 in depth mode and for an unplaced borehole. */
  collarZ: number;
  /** Bottom of the column in the scene: collarZ − depth × k. */
  bottomZ: number;
  /** Stated ground level (m, in `datum`), null when the source states none. */
  groundLevel: number | null;
  /** False in elevation mode for a borehole without a ground level: drawn as a ghost, never connected. */
  placed: boolean;
  /** Depth of the drawn log (m below ground): final depth or last layer bottom (logDepth). */
  depth: number;
  /** WGS 84 position, for tooltips and links. */
  lat: number;
  lng: number;
}

/** One cylinder piece of a column: a logged layer, or the "not logged" tail. */
export interface SceneSegment {
  uid: string;
  id: string;
  /** Layer number; 0 for the "not logged" tail. */
  n: number;
  kind: 'layer' | 'notLogged';
  /** Centre of the segment's bottom face (scene m). */
  position: Vec3;
  /** Height in the scene (top z − bottom z), always > 0. */
  height: number;
  /** Top and bottom in real metres below ground. */
  from: number;
  to: number;
  /** The layer's DIN code as recorded (null: none, or the tail). */
  din: string | null;
  color: Rgba;
  /** Part of an unplaced borehole (drawn faint). */
  ghost: boolean;
}

/** One groundwater reading drawn at its depth. */
export interface SceneWater {
  uid: string;
  id: string;
  position: Vec3;
  type: GroundwaterType;
  /** Rest and standpipe readings are drawn filled; strike and other as an open ring. */
  filled: boolean;
  /**
   * Depth below ground (m) the marker is drawn at: ground level − printed elevation when both are
   * stated, else the printed depth.
   */
  depth: number | null;
  /** Elevation as printed, else ground level − depth when the ground level is stated, else null. */
  elevation: number | null;
  date: string | null;
  /** The reading as printed. */
  raw: string | null;
  /** True for the borehole's reading used in the connecting line and surface. */
  representative: boolean;
  /** Reading of an unplaced borehole (drawn faint, never connected). */
  ghost: boolean;
}

/** One level of the depth scale frame. */
export interface ScaleRing {
  /** Scene height of the ring. */
  z: number;
  /** Real metres: depth below ground in depth mode, elevation in elevation mode. */
  value: number;
  /** Closed rectangle around the site (5 points, the first repeated). */
  path: Vec3[];
}

/** Bounding box of the scene (m, z exaggerated); span = max(width, height, 30). */
export interface SceneExtent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  span: number;
}

/** What was given, what could be drawn and what was left out. */
export interface SceneCounts {
  /** Records given. */
  selected: number;
  /** Records not on the map or without coordinates (not drawn). */
  noPosition: number;
  /** Records with a map position. */
  eligible: number;
  /** Records drawn (at most `max`). */
  drawn: number;
  /** Drawn boreholes without a ground level in elevation mode (ghosts); 0 in depth mode. */
  noGroundLevel: number;
  /** Drawn boreholes without a drawable groundwater reading. */
  noGroundwater: number;
}

/** Everything the 3D view draws. */
export interface Scene {
  /** The mode actually used (elevation falls back to depth with fewer than 2 ground levels). */
  mode: VerticalMode;
  /** Vertical exaggeration k used. */
  exaggeration: number;
  kind: SelectionKind;
  /** Local frame; null when nothing is drawn. */
  frame: Frame | null;
  /** Elevation mode: the lowest ground level among the drawn boreholes (z = 0), else null. */
  base: number | null;
  /** Common elevation datum of the drawn boreholes; null when they differ or state none. */
  datum: string | null;
  /** [west, south, east, north] of the drawn boreholes; null when none. */
  bbox: BBox | null;
  /** The widest a column is drawn (m); see radiusOnScreen for the radius at a camera. */
  radius: number;
  /** How close neighbouring boreholes stand (m, neighbourSpacing); null with fewer than two spots. */
  spacing: number | null;
  extent: SceneExtent;
  boreholes: SceneBorehole[];
  segments: SceneSegment[];
  water: SceneWater[];
  /** Groundwater connections: a broken polyline along a line, the TIN edges (or one segment) otherwise. */
  waterLine: Vec3[][];
  /** TIN through the representative readings of placed boreholes, or null. */
  waterSurface: Surface | null;
  /** Placed boreholes that have a representative reading (the points of waterLine and waterSurface). */
  waterPoints: number;
  /** TIN through the collars of placed boreholes in elevation mode; null in depth mode. */
  groundSurface: Surface | null;
  /** TIN through the rock head of placed boreholes that state one, or null. */
  rockSurface: Surface | null;
  /** Dashed ring (12 short arcs) at the collar of each unplaced borehole. */
  ghostRings: Vec3[][];
  /** Depth scale frame: horizontal rings at tidy levels and the 4 vertical corner posts. */
  scale: { rings: ScaleRing[]; posts: [Vec3, Vec3][] };
  counts: SceneCounts;
  /** DIN codes of the drawn layers, top down, unknown codes included. */
  legend: DinLegendItem[];
  /** True when a drawn layer has no DIN code (drawn plain grey). */
  uncoded: boolean;
  /** True when a column has a "not logged" tail. */
  notLogged: boolean;
}

/** Options of buildScene. */
export interface SceneOptions {
  /** Asked mode; elevation falls back to depth when fewer than 2 drawn boreholes state a ground level. */
  mode: VerticalMode;
  /** Vertical exaggeration; limited to [EXAGGERATION_MIN, EXAGGERATION_LIMIT] (fallback when not a number). */
  exaggeration: number;
  kind: SelectionKind;
  /** Boreholes drawn at most (default MAX_BOREHOLES). */
  max?: number;
}

/** True when a record has a map position. */
function plottable(b: Borehole): b is Borehole & { lat: number; lng: number } {
  return b.onMap && b.lat != null && b.lng != null;
}

/** 12 short arcs around a centre: a dashed ring. */
function dashedRing(c: Vec3, r: number): Vec3[][] {
  const arcs: Vec3[][] = [];
  const step = (2 * Math.PI) / 12;
  for (let i = 0; i < 12; i++) {
    const a0 = i * step;
    const arc: Vec3[] = [];
    // Each dash covers 60 % of its twelfth, drawn with 4 points.
    for (let j = 0; j < 4; j++) {
      const a = a0 + (j / 3) * step * 0.6;
      arc.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2]]);
    }
    arcs.push(arc);
  }
  return arcs;
}

/** The scene of a selection (records in report order; for a planned line by chainage). */
export function buildScene(records: readonly Borehole[], opts: SceneOptions): Scene {
  const max = Math.max(0, Math.floor(opts.max ?? MAX_BOREHOLES));
  const k = Number.isFinite(opts.exaggeration) ? clamp(opts.exaggeration, EXAGGERATION_MIN, EXAGGERATION_LIMIT) : EXAGGERATION_FALLBACK;
  const eligible = records.filter(plottable);
  const drawn = eligible.slice(0, max);
  const mode: VerticalMode = opts.mode === 'elevation' && canAlignByElevation(drawn) ? 'elevation' : 'depth';

  const levels = drawn.map((b) => groundLevel(b));
  const stated = levels.filter((g): g is number => g != null);
  const base = mode === 'elevation' ? Math.min(...stated) : null;

  const datums = new Set<string>();
  for (const b of drawn) {
    const d = elevationDatum(b);
    if (d) datums.add(d);
  }
  const datum = datums.size === 1 ? [...datums][0] : null;

  const frame = drawn.length ? localFrame(drawn) : null;
  const bbox: BBox | null = drawn.length
    ? [Math.min(...drawn.map((b) => b.lng)), Math.min(...drawn.map((b) => b.lat)), Math.max(...drawn.map((b) => b.lng)), Math.max(...drawn.map((b) => b.lat))]
    : null;

  const boreholes: SceneBorehole[] = drawn.map((b, i) => {
    const [x, y] = toLocal(frame!, b.lng, b.lat);
    const gl = levels[i];
    const placed = mode === 'depth' || gl != null;
    const collarZ = mode === 'elevation' && gl != null ? (gl - base!) * k : 0;
    const depth = logDepth(b);
    return { uid: b.uid, id: b.id, x, y, collarZ, bottomZ: collarZ - depth * k, groundLevel: gl, placed, depth, lat: b.lat, lng: b.lng };
  });

  // Columns.
  const segments: SceneSegment[] = [];
  let uncoded = false;
  let notLogged = false;
  const drawnLayers: { din: string | null }[] = [];
  drawn.forEach((b, i) => {
    const sb = boreholes[i];
    const ghost = !sb.placed;
    for (const l of b.layers) {
      if (!(l.to > l.from)) continue;
      drawnLayers.push(l);
      if (!l.din) uncoded = true;
      segments.push({
        uid: b.uid, id: b.id, n: l.n, kind: 'layer',
        position: [sb.x, sb.y, sb.collarZ - l.to * k],
        height: (l.to - l.from) * k,
        from: l.from, to: l.to, din: l.din,
        color: dinColor(l.din, ghost ? GHOST_ALPHA : 255),
        ghost,
      });
    }
    const logged = Math.max(0, ...b.layers.map((l) => l.to || 0));
    const final = b.finalDepth || 0;
    if (final > logged + NOT_LOGGED_MIN) {
      notLogged = true;
      segments.push({
        uid: b.uid, id: b.id, n: 0, kind: 'notLogged',
        position: [sb.x, sb.y, sb.collarZ - final * k],
        height: (final - logged) * k,
        from: logged, to: final, din: null,
        color: [...NOT_LOGGED_RGB, NOT_LOGGED_ALPHA],
        ghost,
      });
    }
  });

  // Groundwater markers and the representative point of each borehole.
  const water: SceneWater[] = [];
  const repPoints: (Vec3 | null)[] = [];
  let noGroundwater = 0;
  drawn.forEach((b, i) => {
    const sb = boreholes[i];
    const gl = sb.groundLevel;
    const drawable: { r: GroundwaterReading; depth: number; type: GroundwaterType; date: string | null }[] = [];
    for (const r of b.groundwater) {
      const d = r.elevation != null && gl != null ? gl - r.elevation : r.depth;
      if (d == null || !Number.isFinite(d)) continue;
      // A reading above ground or below the log (a sign or datum the record doesn't settle) isn't drawn.
      if (d < 0 || d > sb.depth) continue;
      drawable.push({ r, depth: d, type: r.type, date: r.date });
    }
    if (!drawable.length) noGroundwater++;
    const rep = representativeReading(drawable);
    let repPoint: Vec3 | null = null;
    for (const w of drawable) {
      const position: Vec3 = [sb.x, sb.y, sb.collarZ - w.depth * k];
      const representative = w === rep;
      if (representative && sb.placed) repPoint = position;
      water.push({
        uid: b.uid, id: b.id, position, type: w.r.type,
        filled: w.r.type === 'rest' || w.r.type === 'standpipe',
        depth: w.depth,
        elevation: w.r.elevation ?? (gl != null ? gl - w.depth : null),
        date: w.r.date, raw: w.r.raw, representative, ghost: !sb.placed,
      });
    }
    repPoints.push(repPoint);
  });
  const placedReps = repPoints.filter((p): p is Vec3 => p != null);
  const waterSurface = tin(placedReps);
  let waterLine: Vec3[][];
  if (opts.kind === 'line') waterLine = connectRuns(repPoints);
  else if (placedReps.length === 2) waterLine = [[placedReps[0], placedReps[1]]];
  else waterLine = waterSurface ? waterSurface.edges.map(([a, b]) => [a, b]) : [];

  const placed = boreholes.filter((b) => b.placed);
  const groundSurface = mode === 'elevation' ? tin(placed.map((b) => [b.x, b.y, b.collarZ] as Vec3)) : null;
  const rockPoints: Vec3[] = [];
  drawn.forEach((b, i) => {
    const sb = boreholes[i];
    if (sb.placed && b.rockHead != null) rockPoints.push([sb.x, sb.y, sb.collarZ - b.rockHead * k]);
  });
  const rockSurface = tin(rockPoints);

  // Extent and column size.
  const xs = boreholes.map((b) => b.x);
  const ys = boreholes.map((b) => b.y);
  const zs = boreholes.flatMap((b) => [b.collarZ, b.bottomZ]);
  const extent: SceneExtent = boreholes.length
    ? {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
        minZ: Math.min(0, ...zs), maxZ: Math.max(0, ...zs),
        span: 0,
      }
    : { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0, span: 0 };
  extent.span = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY, 30);
  const tallest = Math.max(0, ...boreholes.map((b) => b.depth * k));
  const radius = columnRadius(extent.span, tallest);
  const spacing = neighbourSpacing(boreholes);

  // A ring around an unplaced collar: a little wider than a column as drawn from afar.
  const ringRadius = 1.8 * radiusOnScreen({ radius, spacing }, extent.span / 400);
  const ghostRings = boreholes.filter((b) => !b.placed).flatMap((b) => dashedRing([b.x, b.y, b.collarZ], ringRadius));

  // Scale frame.
  const scale: Scene['scale'] = { rings: [], posts: [] };
  if (boreholes.length) {
    const pad = Math.max(0.08 * extent.span, 2 * radius);
    const x0 = extent.minX - pad;
    const x1 = extent.maxX + pad;
    const y0 = extent.minY - pad;
    const y1 = extent.maxY + pad;
    const deepestZ = Math.min(...boreholes.map((b) => b.bottomZ));
    // value → z, and the top and bottom of the scale in real metres.
    const zOf = mode === 'elevation' ? (v: number) => (v - base!) * k : (v: number) => 0 - v * k;
    const values: number[] = [];
    if (mode === 'elevation') {
      const top = base! + Math.max(...boreholes.map((b) => b.collarZ)) / k;
      const bottom = base! + deepestZ / k;
      const step = niceStep(top - bottom);
      // Tidy levels: the first at or above the highest collar, down to the first at or below the deepest bottom.
      let v = Math.ceil(top / step - 1e-9) * step;
      values.push(v);
      while (v > bottom + 1e-9 || values.length < 2) values.push((v = v - step));
    } else {
      const deepest = -deepestZ / k;
      const step = niceStep(deepest);
      let v = 0;
      values.push(v);
      while (v < deepest - 1e-9 || values.length < 2) values.push((v = v + step));
    }
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    scale.rings = values.map((raw) => {
      const value = round(raw);
      const z = zOf(value);
      return { z, value, path: [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [x0, y0, z]] };
    });
    const zTop = scale.rings[0].z;
    const zBottom = scale.rings[scale.rings.length - 1].z;
    scale.posts = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const).map(([x, y]) => [[x, y, zTop], [x, y, zBottom]]);
  }

  return {
    mode,
    exaggeration: k,
    kind: opts.kind,
    frame,
    base,
    datum,
    bbox,
    radius,
    spacing,
    extent,
    boreholes,
    segments,
    water,
    waterLine,
    waterSurface,
    waterPoints: placedReps.length,
    groundSurface,
    rockSurface,
    ghostRings,
    scale,
    counts: {
      selected: records.length,
      noPosition: records.length - eligible.length,
      eligible: eligible.length,
      drawn: drawn.length,
      noGroundLevel: boreholes.filter((b) => !b.placed).length,
      noGroundwater,
    },
    legend: dinLegendItems(drawnLayers),
    uncoded,
    notLogged,
  };
}

// ---------------------------------------------------------------------------------------------------
// Camera

/** Initial camera of a deck.gl MapView. */
export interface FitView {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/**
 * The camera that shows the whole scene: centred on the frame origin, zoomed so that about 2.2 × the
 * span fits the smaller side of the viewport (zoom in [3, 20]), tilted 58° and turned −24°. null for an
 * empty scene.
 */
export function fitView(scene: Pick<Scene, 'frame' | 'extent'>, viewport: { width: number; height: number }): FitView | null {
  if (!scene.frame) return null;
  const { lon0, lat0 } = scene.frame;
  const side = Math.max(1, Math.min(viewport.width || 0, viewport.height || 0));
  const metresPerPixel = (2.2 * scene.extent.span) / side;
  const cos = Math.max(Math.cos((lat0 * Math.PI) / 180), 1e-6);
  const zoom = Math.log2((EARTH_CIRCUMFERENCE * cos) / (512 * metresPerPixel));
  return { longitude: lon0, latitude: lat0, zoom: clamp(zoom, 3, 20), pitch: 58, bearing: -24 };
}
