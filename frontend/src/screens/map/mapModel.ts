/**
 * Pure presentation logic of the Map screen: the rows and pins it shows (light map features of the
 * plotted boreholes plus the full records of the unplotted ones), legend counts, the CRS column
 * text, the NOT ON MAP reasons and the RESULTS summary line. Unit-tested.
 */
import { crsLabel, metres, unplottedText } from '../../domain/format';
import { displayStatus } from '../../domain/status';
import type { Borehole, BoreholeStatus, MapFeature } from '../../domain/types';
import { pinColor } from '../../theme';

type Bounds = [[number, number], [number, number]];

/** The whole inhabited world: the first view before anything is plotted. No country is preferred. */
export const WORLD_BOUNDS: Bounds = [
  [-60, -180],
  [75, 180],
];
/** Fallback centre and zoom when the map container has no size yet (fitBounds needs one). */
export const WORLD_CENTER: [number, number] = [20, 0];
export const WORLD_ZOOM = 2;

/** Pin radius: the borehole open in Review is drawn larger, every other pin is 6 px. */
export const PIN_RADIUS = { highlight: 8, normal: 6 } as const;

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

/** RESULTS row and pin of a plotted feature; its full record, when loaded and as new, gives the status. */
export function featureRow(f: MapFeature, record?: Borehole): PinRow {
  const b = newerRecord(record, f) ? record : undefined;
  return {
    uid: f.uid,
    id: b?.id ?? f.id,
    project: b?.project ?? f.project ?? '',
    depth: b ? b.finalDepth : f.depth,
    status: b ? displayStatus(b) : featureStatus(f),
    crs: b?.crs ?? { name: null, code: null, status: f.crsStatus },
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

export interface LegendEntry {
  status: BoreholeStatus;
  label: string;
  color: string;
  count: number;
}

const LEGEND_ORDER: { status: BoreholeStatus; label: string }[] = [
  { status: 'approved', label: 'Approved' },
  { status: 'in_review', label: 'In review' },
  { status: 'unreviewed', label: 'Unreviewed' },
  { status: 'attention', label: 'Needs attention' },
];

/** STATUS legend: one entry per status with its pin colour, counting only the boreholes drawn on the map. */
export function legendEntries(rows: MapRow[]): LegendEntry[] {
  const counts: Record<BoreholeStatus, number> = { approved: 0, in_review: 0, unreviewed: 0, attention: 0 };
  for (const r of rows) {
    if (r.pin) counts[r.status] += 1;
  }
  return LEGEND_ORDER.map(({ status, label }) => ({ status, label, color: pinColor(status), count: counts[status] }));
}

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
  const full = crs.name?.trim() ? `${crs.name.trim()}${crs.code ? ` (${crs.code})` : ''}` : (label ?? 'No coordinate system');
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
  return depth != null && Number.isFinite(depth) && depth > 0 ? metres(depth) : '–';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** RESULTS summary, e.g. "48 boreholes · 7 projects". No country: projects can be anywhere. */
export function resultsSummary(boreholes: Pick<MapRow, 'project'>[]): string {
  const projects = new Set(boreholes.map((b) => b.project)).size;
  return `${plural(boreholes.length, 'borehole', 'boreholes')} · ${plural(projects, 'project', 'projects')}`;
}

/** Margin (px) kept between the pins and the map's edges, and between the pins and the legend, when fitting. */
export const FIT_MARGIN = 24;

/**
 * Space the REVIEW STATUS legend takes in the map's bottom-left corner, from the map's left and
 * bottom edges, when it can't be measured: its CSS offsets (left 12 px, bottom 24 px) plus the box
 * those styles give it (about 156 × 122 px: title and four 12 px rows at line height 1.7, 10 / 12 px
 * padding), rounded up. See MapLegend.module.css.
 */
export const LEGEND_EXTENT = { width: 12 + 160, height: 24 + 126 } as const;

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
 * Padding for fitting the map to the pins, so no pin ends up under the legend in the bottom-left
 * corner: the margin on every side, plus the legend's width on the left or its height at the bottom,
 * whichever takes the smaller share of the map.
 */
export function fitPadding(map: Size, legend: Size): FitPadding {
  const m = FIT_MARGIN;
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
  const pins = rows.flatMap((r) => (r.pin ? [r.pin] : []));
  if (!pins.length) return WORLD_BOUNDS;
  const lats = pins.map((p) => p.lat);
  const lngs = pins.map((p) => p.lng);
  return [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];
}
