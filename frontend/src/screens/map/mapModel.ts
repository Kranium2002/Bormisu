/**
 * Pure presentation logic of the Map screen: which boreholes are plotted, legend counts,
 * the CRS column text, the NOT ON MAP reasons and the RESULTS summary line. Unit-tested.
 */
import { metres } from '../../domain/format';
import { boreholeStatus } from '../../domain/review';
import type { Borehole, BoreholeStatus } from '../../domain/types';
import { pinColor } from '../../theme';

/** Initial map view: Germany, as in the prototype. */
export const GERMANY_BOUNDS: [[number, number], [number, number]] = [
  [47.3, 5.9],
  [55.0, 15.0],
];
/** Fallback centre when the map container has no size yet (fitBounds needs one). */
export const GERMANY_CENTER: [number, number] = [51.2, 10.45];

/** Pin radius: the borehole open in Review is drawn larger, every other pin is 6 px. */
export const PIN_RADIUS = { highlight: 8, normal: 6 } as const;

/** A borehole the map can place: flagged as plottable and with both coordinates. */
export type PlottedBorehole = Borehole & { lat: number; lng: number };

/** True if the borehole is drawn on the map. `onMap` alone isn't enough: a pin needs both coordinates. */
export function isPlotted(b: Borehole): b is PlottedBorehole {
  return b.onMap && b.lat != null && b.lng != null && Number.isFinite(b.lat) && Number.isFinite(b.lng);
}

/** Review status per borehole uid, computed once per data change. */
export function statusByUid(boreholes: Borehole[]): Map<string, BoreholeStatus> {
  return new Map(boreholes.map((b) => [b.uid, boreholeStatus(b)]));
}

export interface LegendEntry {
  status: BoreholeStatus;
  label: string;
  color: string;
  count: number;
}

const LEGEND_ORDER: { status: BoreholeStatus; label: string }[] = [
  { status: 'reviewed', label: 'Reviewed' },
  { status: 'unreviewed', label: 'Unreviewed' },
  { status: 'attention', label: 'Needs attention / CRS inferred' },
];

/** REVIEW STATUS legend: one entry per pin colour, counting only the boreholes drawn on the map. */
export function legendEntries(boreholes: Borehole[], statuses: Map<string, BoreholeStatus>): LegendEntry[] {
  const counts: Record<BoreholeStatus, number> = { reviewed: 0, unreviewed: 0, attention: 0 };
  for (const b of boreholes) {
    if (isPlotted(b)) counts[statuses.get(b.uid) ?? boreholeStatus(b)] += 1;
  }
  return LEGEND_ORDER.map(({ status, label }) => ({ status, label, color: pinColor(status), count: counts[status] }));
}

/**
 * Short CRS name for the RESULTS table:
 * "DHDN / 3-degree Gauss-Krüger zone 3" and "DHDN / GK zone 3" → "DHDN / GK3",
 * "ETRS89 / UTM zone 32N" → "ETRS89 / UTM32N". Unknown patterns are returned unchanged.
 */
export function shortCrsName(name: string): string {
  return name
    .replace(/(?:3-degree\s+)?(?:Gauss[-\s]?Kr(?:ü|ue|u)ger|GK)\s+zone\s+(\d+)/i, 'GK$1')
    .replace(/UTM\s+zone\s+(\d+\s*[NS])/i, (_, z: string) => `UTM${z.replace(/\s+/g, '')}`);
}

export interface CrsCell {
  text: string;
  /** Amber text: the CRS is inferred or unknown, so the pin position is not confirmed. */
  warn: boolean;
  /** Full name and EPSG code, shown on hover. */
  title: string;
}

/** CRS column of the RESULTS table: "inferred · DHDN / GK3", "confirmed · …", "stated" or "unknown". */
export function crsCell(crs: Borehole['crs']): CrsCell {
  const full = crs.name ? `${crs.name}${crs.code ? ` (${crs.code})` : ''}` : 'No coordinate system';
  const short = crs.name ? shortCrsName(crs.name) : null;
  switch (crs.status) {
    case 'inferred':
      return { text: short ? `inferred · ${short}` : 'inferred', warn: true, title: `Inferred, not stated in the source: ${full}` };
    case 'confirmed':
      return { text: short ? `confirmed · ${short}` : 'confirmed', warn: false, title: `Confirmed by a reviewer: ${full}` };
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
  /** Amber text for CRS problems, grey for missing coordinates. */
  warn: boolean;
}

/** Why a borehole is listed under NOT ON MAP instead of plotted. */
export function notOnMapReason(b: Borehole): NotOnMapReason {
  const text =
    b.unplottedReason?.trim() ||
    (b.crs.status === 'unknown' && b.lat != null ? 'CRS unknown' : 'No usable coordinates');
  return { text, warn: /^crs\b/i.test(text) };
}

/** Final depth as "18.00 m", or "–" when no depth was extracted (a blank never means 0). */
export function depthText(b: Borehole): string {
  return b.finalDepth != null && Number.isFinite(b.finalDepth) && b.finalDepth > 0 ? metres(b.finalDepth) : '–';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** RESULTS summary, e.g. "48 boreholes · 7 projects". No country: projects can be anywhere. */
export function resultsSummary(boreholes: Borehole[]): string {
  const projects = new Set(boreholes.map((b) => b.project)).size;
  return `${plural(boreholes.length, 'borehole', 'boreholes')} · ${plural(projects, 'project', 'projects')}`;
}

type Bounds = [[number, number], [number, number]];

/**
 * First view of the map: Germany, as in the prototype, unless a pin lies outside it; then the
 * bounds of all pins, so no borehole starts off-screen.
 */
export function initialBounds(boreholes: Borehole[]): Bounds {
  const pins = boreholes.filter(isPlotted);
  const [[s, w], [n, e]] = GERMANY_BOUNDS;
  if (pins.every((b) => b.lat >= s && b.lat <= n && b.lng >= w && b.lng <= e)) return GERMANY_BOUNDS;
  const lats = pins.map((b) => b.lat);
  const lngs = pins.map((b) => b.lng);
  return [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];
}
