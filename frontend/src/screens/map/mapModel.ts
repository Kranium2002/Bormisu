/**
 * Pure presentation logic of the Map screen, unit-tested (no Leaflet here, so it runs in Node):
 * - the rows and pins it shows (light map features of the plotted boreholes plus the full records
 *   of the unplotted ones), the CRS column text, the NOT ON MAP reasons, the RESULTS summary line;
 * - how a pin is painted: by review status or by depth class (depthClasses.ts), highlighted or
 *   dimmed while a result set is active; the legend rows and their counts; cluster icons (count and
 *   the mix of statuses or depth classes as ring segments);
 * - areas drawn on the map (rectangle, polygon, circle) as the contract's Area, and bboxes as map
 *   bounds;
 * - the pin popup: its texts and why REVIEW or SOURCE is off;
 * - fitting: the first view, padding clear of the legend.
 */
import { crsLabel, metres, unplottedText } from '../../domain/format';
import { K } from '../../domain/keys';
import { sourceDocumentId } from '../../domain/review';
import { displayStatus } from '../../domain/status';
import type { Area, Borehole, BoreholeFilter, BoreholeStatus, MapFeature } from '../../domain/types';
import { isReviewable } from '../../store/context';
import { COL, pinColor, statusChip } from '../../theme';
import { DEPTH_CLASSES, DEPTH_NOT_STATED, DEPTH_OUTSIDE, type DepthClass } from './depthClasses';

type Bounds = [[number, number], [number, number]];
/** [min_lon, min_lat, max_lon, max_lat] as the contract sends it; min_lon > max_lon crosses the antimeridian. */
export type Bbox = [number, number, number, number];

/** The whole inhabited world: the first view before anything is plotted. No country is preferred. */
export const WORLD_BOUNDS: Bounds = [
  [-60, -180],
  [75, 180],
];
/** Fallback centre and zoom when the map container has no size yet (fitBounds needs one). */
export const WORLD_CENTER: [number, number] = [20, 0];
export const WORLD_ZOOM = 2;

/** Pin radius: the borehole open in Review is drawn larger, a member of the active result set a little larger. */
export const PIN_RADIUS = { highlight: 8, member: 7, normal: 6 } as const;

/** A borehole the map can place: the server says it is plotted and both coordinates are known. */
export type PlottedBorehole = Borehole & { lat: number; lng: number };

/** True if the borehole is drawn on the map. `onMap` alone isn't enough: a pin needs both coordinates. */
export function isPlotted(b: Borehole): b is PlottedBorehole {
  return b.onMap && b.lat != null && b.lng != null && Number.isFinite(b.lat) && Number.isFinite(b.lng);
}

/** Display status per borehole uid (displayStatus: attention wins over the server's review status). */
export function statusByUid(boreholes: Borehole[]): Map<string, BoreholeStatus> {
  return new Map(boreholes.map((b) => [b.uid, displayStatus(b)]));
}

/** Display status of a map feature: the server's attention wins over its review status. */
export function featureStatus(f: Pick<MapFeature, 'attention' | 'reviewStatus'>): BoreholeStatus {
  return f.attention ? 'attention' : f.reviewStatus;
}

/**
 * One borehole as the Map screen shows it: a pin with its RESULTS row (a plotted feature), or a
 * RESULTS row listed under NOT ON MAP (an unplotted record).
 */
export interface MapRow {
  uid: string;
  /** BoreholeID as printed. */
  id: string;
  /** Project name; '' when the server has none. */
  project: string;
  /** Final depth in m; null when not stated. */
  depth: number | null;
  status: BoreholeStatus;
  /** The CRS as far as the store knows it: the full record's, else only the feature's status. */
  crs: Borehole['crs'];
  /** Where the pin goes; null for a borehole that is not on the map. */
  pin: { lat: number; lng: number } | null;
}

/** A row with a pin. */
export type PinRow = MapRow & { pin: { lat: number; lng: number } };

/**
 * True when a full record in the store is at least as new as the feature: it then shows its own
 * state (e.g. a review change the map layer doesn't know yet, or an optimistic one).
 */
function newerRecord(b: Borehole | undefined, f: MapFeature): b is Borehole {
  return !!b && (f.revision == null || b.revision >= f.revision);
}

/** The CRS a map feature carries: its status, and its system's code and label when the server sends them (1.2.0). */
export function featureCrs(f: Pick<MapFeature, 'crsStatus' | 'crsCode' | 'crsLabel'>): Borehole['crs'] {
  return { name: null, code: f.crsCode ?? null, label: f.crsLabel ?? null, status: f.crsStatus };
}

/** RESULTS row and pin of a plotted feature; its full record, when loaded and as new, gives the status. */
export function featureRow(f: MapFeature, record?: Borehole): PinRow {
  const b = newerRecord(record, f) ? record : undefined;
  return {
    uid: f.uid,
    id: b?.id ?? f.id,
    project: b?.project ?? f.project ?? '',
    depth: b ? b.finalDepth : f.depth,
    status: b ? displayStatus(b) : featureStatus(f),
    // The light layer names the stated or confirmed system since 1.2.0 (code and label).
    crs: b?.crs ?? featureCrs(f),
    pin: { lat: f.lat, lng: f.lng },
  };
}

/** RESULTS row of a borehole that is not on the map (a full record). */
export function recordRow(b: Borehole): MapRow {
  return { uid: b.uid, id: b.id, project: b.project, depth: b.finalDepth, status: displayStatus(b), crs: b.crs, pin: null };
}

/**
 * What the Map screen lists: every plotted feature (with a pin) and every unplotted record the store
 * holds (NOT ON MAP), each borehole once. `boreholes` is the store's cache of full records.
 */
export function mapRows(features: MapFeature[], boreholes: Borehole[], unplottedUids: string[]): { rows: MapRow[]; pins: PinRow[]; notOnMap: Borehole[] } {
  const byUid = new Map(boreholes.map((b) => [b.uid, b]));
  const pins = features.map((f) => featureRow(f, byUid.get(f.uid)));
  const plotted = new Set(pins.map((p) => p.uid));
  const notOnMap = unplottedUids
    .filter((uid) => !plotted.has(uid))
    .map((uid) => byUid.get(uid))
    .filter((b): b is Borehole => !!b);
  return { rows: [...pins, ...notOnMap.map(recordRow)], pins, notOnMap };
}

/* ---------- colouring: by status or by depth class ---------- */

/** What the pins are coloured by: the review status (default) or the final depth class. */
export type ColourBy = 'status' | 'depth';

/** Fill and ring (stroke) colour of a pin. */
export interface PinPaint {
  fill: string;
  stroke: string;
}

const WHITE = '#FFFFFF';

/**
 * Pins by status: approved green, unreviewed grey, in review grey with a dark ring (so it reads
 * apart from unreviewed), attention amber. Fills are theme.pinColor.
 */
export const STATUS_PAINT: Record<BoreholeStatus, PinPaint> = {
  approved: { fill: pinColor('approved'), stroke: WHITE },
  in_review: { fill: pinColor('in_review'), stroke: COL.muted },
  unreviewed: { fill: pinColor('unreviewed'), stroke: WHITE },
  attention: { fill: pinColor('attention'), stroke: WHITE },
};

/** Status order of the legend and of cluster ring segments. */
export const STATUS_ORDER: readonly BoreholeStatus[] = ['approved', 'in_review', 'unreviewed', 'attention'];

/** One colour class of the map: a status, a depth class, "depth not stated" or "other depth". */
export interface ColourClass {
  /** Stable key: the status, `depth-<i>` (index in DEPTH_CLASSES), `depth-none` or `depth-other`. */
  key: string;
  label: string;
  paint: PinPaint;
  status?: BoreholeStatus;
}

export const DEPTH_NONE_KEY = 'depth-none';
export const DEPTH_OTHER_KEY = 'depth-other';

/** True for a stated final depth (a number above 0; 0 or a blank is "not stated", as in depthText). */
export const isStatedDepth = (depth: number | null | undefined): depth is number => depth != null && Number.isFinite(depth) && depth > 0;

/**
 * Depth class of a final depth: the configured class with min < depth ≤ max; an unknown depth is
 * "Depth not stated", never a class; a stated depth outside every class is "Other depth".
 */
export function depthClassOf(depth: number | null, classes: readonly DepthClass[] = DEPTH_CLASSES): ColourClass {
  if (!isStatedDepth(depth)) return { key: DEPTH_NONE_KEY, label: DEPTH_NOT_STATED.label, paint: { fill: DEPTH_NOT_STATED.colour, stroke: WHITE } };
  const i = classes.findIndex((c) => depth > c.min && (c.max == null || depth <= c.max));
  if (i < 0) return { key: DEPTH_OTHER_KEY, label: DEPTH_OUTSIDE.label, paint: { fill: DEPTH_OUTSIDE.colour, stroke: WHITE } };
  return { key: `depth-${i}`, label: classes[i].label, paint: { fill: classes[i].colour, stroke: WHITE } };
}

/** Every colour class of a mode, in legend order ("Other depth" only shows when a pin is in it). */
export function colourClasses(colourBy: ColourBy, classes: readonly DepthClass[] = DEPTH_CLASSES): ColourClass[] {
  if (colourBy === 'status') {
    return STATUS_ORDER.map((status) => ({ key: status, status, label: statusChip(status).label, paint: STATUS_PAINT[status] }));
  }
  return [
    ...classes.map((c, i) => ({ key: `depth-${i}`, label: c.label, paint: { fill: c.colour, stroke: WHITE } })),
    { key: DEPTH_OTHER_KEY, label: DEPTH_OUTSIDE.label, paint: { fill: DEPTH_OUTSIDE.colour, stroke: WHITE } },
    { key: DEPTH_NONE_KEY, label: DEPTH_NOT_STATED.label, paint: { fill: DEPTH_NOT_STATED.colour, stroke: WHITE } },
  ];
}

/** The colour class of a pin in a mode. */
export function colourClassOf(row: Pick<MapRow, 'status' | 'depth'>, colourBy: ColourBy, classes: readonly DepthClass[] = DEPTH_CLASSES): ColourClass {
  if (colourBy === 'depth') return depthClassOf(row.depth, classes);
  return { key: row.status, status: row.status, label: statusChip(row.status).label, paint: STATUS_PAINT[row.status] };
}

/** How a pin stands out: normal; a member of the active result set; dimmed (not a member). */
export type PinEmphasis = 'normal' | 'member' | 'dimmed';

/** Emphasis of a pin: without an active result set every pin is normal. */
export function emphasisOf(uid: string, members: ReadonlySet<string> | null): PinEmphasis {
  if (!members) return 'normal';
  return members.has(uid) ? 'member' : 'dimmed';
}

/** Leaflet circle-marker style of a pin (plain object, so this file needs no Leaflet). */
export interface PinStyle {
  radius: number;
  color: string;
  weight: number;
  opacity: number;
  fillColor: string;
  fillOpacity: number;
}

/** Opacity of pins outside the active result set: still there, but clearly behind the members. */
export const DIMMED_OPACITY = { fill: 0.25, stroke: 0.3 } as const;

export function pinStyle(paint: PinPaint, emphasis: PinEmphasis, highlight = false): PinStyle {
  const dimmed = emphasis === 'dimmed';
  return {
    radius: highlight ? PIN_RADIUS.highlight : emphasis === 'member' ? PIN_RADIUS.member : PIN_RADIUS.normal,
    color: paint.stroke,
    weight: 2,
    opacity: dimmed ? DIMMED_OPACITY.stroke : 1,
    fillColor: paint.fill,
    fillOpacity: dimmed ? DIMMED_OPACITY.fill : 1,
  };
}

/* ---------- legend ---------- */

export interface LegendEntry {
  status: BoreholeStatus;
  label: string;
  color: string;
  count: number;
}

/** STATUS legend: one entry per status with its pin colour, counting only the boreholes drawn on the map. */
export function legendEntries(rows: MapRow[]): LegendEntry[] {
  const counts: Record<BoreholeStatus, number> = { approved: 0, in_review: 0, unreviewed: 0, attention: 0 };
  for (const r of rows) {
    if (r.pin) counts[r.status] += 1;
  }
  return STATUS_ORDER.map((status) => ({ status, label: statusChip(status).label, color: pinColor(status), count: counts[status] }));
}

/** One row of the map legend. */
export interface LegendRow extends ColourClass {
  /** Boreholes in the class, on the map or not. */
  count: number;
  /** Of those, the ones with a pin. */
  onMap: number;
}

/**
 * The legend of the current colour mode: one row per class with the number of boreholes in it, placed
 * on the map or listed under NOT ON MAP, and how many of them have a pin. Counted are the given rows,
 * or, while a result set is active, its members among them. "Other depth" is listed only when a
 * borehole falls into it.
 */
export function legendRows(rows: MapRow[], colourBy: ColourBy, members: ReadonlySet<string> | null = null, classes: readonly DepthClass[] = DEPTH_CLASSES): LegendRow[] {
  const counts = new Map<string, { count: number; onMap: number }>();
  for (const r of rows) {
    if (members && !members.has(r.uid)) continue;
    const key = colourClassOf(r, colourBy, classes).key;
    const c = counts.get(key) ?? { count: 0, onMap: 0 };
    c.count += 1;
    if (r.pin) c.onMap += 1;
    counts.set(key, c);
  }
  return colourClasses(colourBy, classes)
    .map((c) => ({ ...c, count: counts.get(c.key)?.count ?? 0, onMap: counts.get(c.key)?.onMap ?? 0 }))
    .filter((c) => c.key !== DEPTH_OTHER_KEY || c.count > 0);
}

/* ---------- clusters ---------- */

/** How a cluster icon looks: its count, size, the ring of class segments, and its accessible text. */
export interface ClusterView {
  /** Count as printed: "8", "125", "1.2k", "25k". */
  label: string;
  /** Diameter in px. */
  size: number;
  /** CSS conic-gradient of the classes in the cluster, in legend order. */
  ring: string;
  /** Dimmed: a result set is active and no member is in this cluster. */
  dimmed: boolean;
  /** Members of the active result set in the cluster (0 without one). */
  members: number;
  total: number;
  /** Accessible name, e.g. "12 boreholes: 5 Approved, 7 Unreviewed". */
  text: string;
}

/** The count as a cluster prints it: up to 999 in full, then "1.2k", "25k". */
export function countLabel(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.floor(n / 1000)}k`;
}

/** Cluster diameter in px by its count. */
export function clusterSize(n: number): number {
  if (n < 10) return 32;
  if (n < 100) return 38;
  if (n < 1000) return 44;
  return 50;
}

const pct = (x: number) => `${Number(x.toFixed(2))}%`;

/** Conic-gradient ring of class segments (legend order), e.g. "conic-gradient(#7DB713 0% 40%, #A3A3A2 40% 100%)". */
export function ringGradient(segments: { colour: string; count: number }[]): string {
  const total = segments.reduce((a, s) => a + s.count, 0);
  if (total === 0) return `conic-gradient(${COL.grey} 0% 100%)`;
  let at = 0;
  const parts: string[] = [];
  for (const s of segments) {
    if (s.count <= 0) continue;
    const end = at + (s.count / total) * 100;
    parts.push(`${s.colour} ${pct(at)} ${pct(end)}`);
    at = end;
  }
  return `conic-gradient(${parts.join(', ')})`;
}

const boreholes = (n: number) => `${n} ${n === 1 ? 'borehole' : 'boreholes'}`;

/** The icon of a cluster of these pins in the current colour mode, with the active result set's members. */
export function clusterView(rows: Pick<MapRow, 'uid' | 'status' | 'depth'>[], colourBy: ColourBy, members: ReadonlySet<string> | null = null, classes: readonly DepthClass[] = DEPTH_CLASSES): ClusterView {
  const order = colourClasses(colourBy, classes);
  const counts = new Map<string, number>();
  let inSet = 0;
  for (const r of rows) {
    const key = colourClassOf(r, colourBy, classes).key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (members?.has(r.uid)) inSet += 1;
  }
  const total = rows.length;
  const mix = order.filter((c) => (counts.get(c.key) ?? 0) > 0).map((c) => `${counts.get(c.key)} ${c.label}`);
  const selection = members ? `; ${inSet} in the selection` : '';
  return {
    label: countLabel(total),
    size: clusterSize(total),
    ring: ringGradient(order.map((c) => ({ colour: c.paint.fill, count: counts.get(c.key) ?? 0 }))),
    dimmed: !!members && inSet === 0,
    members: inSet,
    total,
    text: `${boreholes(total)}: ${mix.join(', ')}${selection}`,
  };
}

/* ---------- areas drawn on the map, bboxes ---------- */

/** A point as Leaflet gives it. */
export interface LatLngLike {
  lat: number;
  lng: number;
}

const round6 = (x: number) => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};
const clampLat = (lat: number) => Math.max(-90, Math.min(90, lat));

/** A longitude in [-180, 180). The map repeats the world sideways, so a drawn point can lie past ±180. */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * A rectangle (two opposite corners) as an Area bbox [min_lon, min_lat, max_lon, max_lat]. Drawn
 * across the antimeridian it keeps min_lon > max_lon (the contract's crossing box); wider than the
 * world it is the whole world. Null when it has no width or height.
 */
export function bboxArea(a: LatLngLike, b: LatLngLike): Area | null {
  const west = Math.min(a.lng, b.lng);
  const east = Math.max(a.lng, b.lng);
  const south = clampLat(Math.min(a.lat, b.lat));
  const north = clampLat(Math.max(a.lat, b.lat));
  if (!(east > west) || !(north > south) || ![west, east, south, north].every(Number.isFinite)) return null;
  if (east - west >= 360) return { type: 'bbox', bbox: [-180, round6(south), 180, round6(north)] };
  const shift = wrapLng(west) - west;
  let max = east + shift;
  if (max > 180) max -= 360;
  return { type: 'bbox', bbox: [round6(west + shift), round6(south), round6(max), round6(north)] };
}

/**
 * A drawn polygon (its corners, open or closed) as a GeoJSON Polygon, [lon, lat], closed. The
 * shape is moved by whole turns so its middle lies on the main world; a corner still past ±180 is
 * clamped to it. Null with fewer than three distinct corners.
 */
export function polygonArea(corners: LatLngLike[]): Area | null {
  const pts = corners.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const distinct: LatLngLike[] = [];
  for (const p of pts) {
    const last = distinct[distinct.length - 1];
    if (!last || last.lat !== p.lat || last.lng !== p.lng) distinct.push(p);
  }
  if (distinct.length > 1 && distinct[0].lat === distinct[distinct.length - 1].lat && distinct[0].lng === distinct[distinct.length - 1].lng) distinct.pop();
  if (distinct.length < 3) return null;
  const mid = distinct.reduce((a, p) => a + p.lng, 0) / distinct.length;
  const shift = wrapLng(mid) - mid;
  const ring = distinct.map((p) => [round6(Math.max(-180, Math.min(180, p.lng + shift))), round6(clampLat(p.lat))]);
  ring.push([...ring[0]]);
  return { type: 'polygon', polygon: { type: 'Polygon', coordinates: [ring] } };
}

/** A drawn circle as an Area circle (centre [lon, lat], radius in metres); null without a radius. */
export function circleArea(center: LatLngLike, radiusM: number): Area | null {
  if (!Number.isFinite(radiusM) || radiusM <= 0 || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return null;
  return { type: 'circle', center: [round6(wrapLng(center.lng)), round6(clampLat(center.lat))], radiusM: Math.round(radiusM * 100) / 100 };
}

/** What the draw tools hand over: a Leaflet rectangle, polygon or circle (only the methods used here). */
export interface DrawnLayer {
  getBounds?(): { getSouthWest(): LatLngLike; getNorthEast(): LatLngLike };
  getLatLngs?(): unknown;
  getLatLng?(): LatLngLike;
  getRadius?(): number;
}

/** The first ring of Leaflet's getLatLngs() (a flat ring, or rings, or polygons of rings). */
function firstRing(latlngs: unknown): LatLngLike[] {
  let ring = latlngs;
  while (Array.isArray(ring) && Array.isArray(ring[0])) ring = ring[0];
  return Array.isArray(ring) ? (ring as LatLngLike[]) : [];
}

/** The Area of a shape drawn with the draw tools (geoman's shape name and its layer); null when unusable. */
export function areaFromDrawn(shape: string, layer: DrawnLayer): Area | null {
  if (shape === 'Rectangle' && layer.getBounds) {
    const b = layer.getBounds();
    return bboxArea(b.getSouthWest(), b.getNorthEast());
  }
  if (shape === 'Polygon' && layer.getLatLngs) return polygonArea(firstRing(layer.getLatLngs()));
  if (shape === 'Circle' && layer.getLatLng && layer.getRadius) return circleArea(layer.getLatLng(), layer.getRadius());
  return null;
}

/** A bbox as map bounds [[south, west], [north, east]]; a box across the antimeridian continues east past 180. */
export function bboxBounds([minLon, minLat, maxLon, maxLat]: Bbox): Bounds {
  return [
    [minLat, minLon],
    [maxLat, minLon > maxLon ? maxLon + 360 : maxLon],
  ];
}

/** True for a bbox of no size (a place given as a point): the map then flies to it at POINT_ZOOM. */
export const isPointBbox = ([minLon, minLat, maxLon, maxLat]: Bbox) => minLon === maxLon && minLat === maxLat;

/** Zoom for a bbox of no size (a point place, a result set of one pin at one spot). */
export const POINT_ZOOM = 14;
/** Fits never zoom in further than this (a result set of a few pins close together). */
export const FIT_MAX_ZOOM = 16;

/** The filter carries nothing but (maybe) an area: removing the area then means resetting everything. */
export function onlyArea(f: BoreholeFilter): boolean {
  return (
    f.search == null && f.country == null && f.project == null && f.documentId == null && f.minDepth == null && f.maxDepth == null &&
    f.dinCodes.length === 0 && f.lithologyMinDepth == null && f.hasSpt == null && f.hasGroundwater == null &&
    f.reviewStatus.length === 0 && f.includeUnreviewed
  );
}

/* ---------- popup ---------- */

/** Why REVIEW or SOURCE is off (null when on). */
export interface PopupAction {
  enabled: boolean;
  reason: string | null;
}

/** What a pin's popup shows. */
export interface PopupView {
  uid: string;
  id: string;
  project: string;
  /** "Final depth 18.00 m" or "Depth not stated". */
  depth: string;
  status: BoreholeStatus;
  crsWarning: string | null;
  /** The CRS line: the system's label (else its code, else the status) and whether it is a warning. */
  crs: PopupCrs;
  review: PopupAction;
  source: PopupAction;
}

export interface PopupCrs { text: string; warn: boolean }

export const POPUP_LOADING = 'Loading the borehole record…';
export const POPUP_MISSING = 'The server no longer has this borehole';
export const POPUP_LOAD_FAILED = 'The borehole record could not be loaded';
export const POPUP_NOT_REVIEWABLE = 'Nothing to review: no value of this borehole has a source page or cell';
export const POPUP_NO_DEPTH = 'No final depth was extracted';
export const POPUP_NO_DEPTH_SOURCE = 'No source reference for the final depth';
export const POPUP_NO_DEPTH_PAGE = 'The final depth is on no source page or cell';
export const POPUP_NO_SOURCE_DOCUMENT = 'No source document for this borehole';

/** Depth line of the popup: the metres when stated, else says so (never a 0). */
export function popupDepthText(depth: number | null): string {
  return isStatedDepth(depth) ? `Final depth ${metres(depth)}` : 'Depth not stated';
}

const on: PopupAction = { enabled: true, reason: null };
const off = (reason: string): PopupAction => ({ enabled: false, reason });

/**
 * The popup of a pin. REVIEW and SOURCE need the full record (fetched when the popup opens): until it
 * is there they are off with "Loading…"; REVIEW stays off when Review cannot show the borehole,
 * SOURCE when the final depth has no source to open.
 */
export function popupView(row: PinRow, record: Borehole | undefined, load: 'loading' | 'missing' | 'error' | undefined): PopupView {
  const base = {
    uid: row.uid, id: row.id, project: row.project, depth: popupDepthText(row.depth), status: row.status,
    crsWarning: popupCrsWarning(row.crs), crs: popupCrs(row.crs),
  };
  if (!record) {
    const why = off(load === 'missing' ? POPUP_MISSING : load === 'error' ? POPUP_LOAD_FAILED : POPUP_LOADING);
    return { ...base, review: why, source: why };
  }
  const v = record.values.find((x) => x.key === K.finalDepth);
  let source = on;
  if (!v) source = off(POPUP_NO_DEPTH);
  else if (!v.hasProvenance) source = off(POPUP_NO_DEPTH_SOURCE);
  else if (!sourceDocumentId(record, v)) source = off(POPUP_NO_SOURCE_DOCUMENT);
  else if (v.page == null && !v.cell) source = off(POPUP_NO_DEPTH_PAGE);
  return { ...base, review: isReviewable(record) ? on : off(POPUP_NOT_REVIEWABLE), source };
}

/* ---------- table texts ---------- */

export interface CrsCell {
  text: string;
  /** Amber text: the CRS is inferred or unknown, so the pin position is not confirmed. */
  warn: boolean;
  /** Full label and EPSG code, shown on hover. */
  title: string;
}

/**
 * CRS column of the RESULTS table with the backend's label: "inferred · <label>", "confirmed · …",
 * "stated", "unknown". The label is the system as printed, else the server's EPSG code.
 */
export function crsCell(crs: Borehole['crs']): CrsCell {
  const label = crsLabel(crs);
  const named = crs.label?.trim() || crs.name?.trim();
  const full = named ? `${named}${crs.code ? ` (${crs.code})` : ''}` : (label ?? 'No coordinate system');
  switch (crs.status) {
    case 'inferred':
      return { text: label ? `inferred · ${label}` : 'inferred', warn: true, title: `Inferred, not stated in the source: ${full}` };
    case 'confirmed':
      return { text: label ? `confirmed · ${label}` : 'confirmed', warn: false, title: `Confirmed by a reviewer: ${full}` };
    case 'unknown':
      return { text: 'unknown', warn: true, title: 'Coordinate system unknown: the borehole is not placed on the map' };
    case 'stated':
      return { text: 'stated', warn: false, title: `Stated in the source: ${full}` };
  }
}

/** One-line CRS warning for the pin popup, or null when the CRS is stated or confirmed. */
export function popupCrsWarning(crs: Borehole['crs']): string | null {
  if (crs.status === 'inferred') return 'CRS inferred, not stated';
  if (crs.status === 'unknown') return 'CRS unknown';
  return null;
}

/**
 * The popup's CRS line: the system's label (else the code; crsLabel), else only what the status
 * says. Amber for an inferred or unknown system (the pin's position is not confirmed).
 */
export function popupCrs(crs: Borehole['crs']): PopupCrs {
  const label = crsLabel(crs);
  switch (crs.status) {
    case 'inferred':
      return { text: label ? `CRS inferred, not stated: ${label}` : 'CRS inferred, not stated', warn: true };
    case 'unknown':
      return { text: 'CRS unknown', warn: true };
    case 'confirmed':
      return { text: label ? `CRS confirmed: ${label}` : 'CRS confirmed', warn: false };
    case 'stated':
      return { text: label ? `CRS: ${label}` : 'CRS stated', warn: false };
  }
}

export interface NotOnMapReason {
  text: string;
  /** Amber text for CRS problems and implausible coordinates, grey for missing coordinates. */
  warn: boolean;
}

/** Why a borehole is listed under NOT ON MAP instead of plotted: the backend's reason code as a label. */
export function notOnMapReason(b: Borehole): NotOnMapReason {
  return { text: unplottedText(b), warn: !!b.unplottedReason && b.unplottedReason !== 'no_coordinates' };
}

/** Final depth as "18.00 m", or "–" when no depth was extracted (a blank never means 0). */
export function depthText(depth: number | null): string {
  return isStatedDepth(depth) ? metres(depth) : '–';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** RESULTS summary, e.g. "48 boreholes · 7 projects". No country: projects can be anywhere. */
export function resultsSummary(rows: Pick<MapRow, 'project'>[]): string {
  const projects = new Set(rows.map((b) => b.project)).size;
  return `${plural(rows.length, 'borehole', 'boreholes')} · ${plural(projects, 'project', 'projects')}`;
}

/* ---------- fitting ---------- */

/** Margin (px) kept between the pins and the map's edges, and between the pins and the legend, when fitting the pins. */
export const FIT_MARGIN = 24;
/** Margin (px) of a result-set or place fit (FRONTEND.md F15: flyToBounds with 48 px padding). */
export const RESULT_FIT_MARGIN = 48;

/**
 * Space the legend takes in the map's bottom-left corner, from the map's left and bottom edges, when
 * it can't be measured: its CSS offsets (left 12 px, bottom 24 px) plus the box those styles give it
 * in the status mode (212 px wide, about 148 px high: the COLOUR BY switch, the title and four
 * rows), rounded up. See MapLegend.module.css.
 */
export const LEGEND_EXTENT = { width: 12 + 214, height: 24 + 152 } as const;

export interface Size { width: number; height: number }
/** A box in page pixels, as getBoundingClientRect gives it. */
export interface Rect { left: number; top: number; right: number; bottom: number }

/** Space the legend takes from the map's bottom-left corner; LEGEND_EXTENT when it can't be measured. */
export function legendExtent(map: Rect, legend: Rect | null): Size {
  if (!legend || legend.right <= legend.left || legend.bottom <= legend.top) return LEGEND_EXTENT;
  return { width: Math.ceil(legend.right - map.left), height: Math.ceil(map.bottom - legend.top) };
}

export interface FitPadding { paddingTopLeft: [number, number]; paddingBottomRight: [number, number] }

/**
 * Padding for fitting the map to pins or a bbox, so nothing ends up under the legend in the
 * bottom-left corner: the margin on every side, plus the legend's width on the left or its height
 * at the bottom, whichever takes the smaller share of the map.
 */
export function fitPadding(map: Size, legend: Size, margin: number = FIT_MARGIN): FitPadding {
  const m = margin;
  if (legend.width / map.width <= legend.height / map.height) {
    return { paddingTopLeft: [legend.width + m, m], paddingBottomRight: [m, m] };
  }
  return { paddingTopLeft: [m, m], paddingBottomRight: [m, legend.height + m] };
}

/**
 * First view of the map: the bounds of all pins, wherever they are, so none starts off-screen; the
 * whole world while nothing is plotted (the empty start). No country is built in.
 */
export function initialBounds(rows: MapRow[]): Bounds {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const r of rows) {
    if (!r.pin) continue;
    minLat = Math.min(minLat, r.pin.lat);
    maxLat = Math.max(maxLat, r.pin.lat);
    minLng = Math.min(minLng, r.pin.lng);
    maxLng = Math.max(maxLng, r.pin.lng);
  }
  if (minLat === Infinity) return WORLD_BOUNDS;
  return [
    [minLat, minLng],
    [maxLat, maxLng],
  ];
}
