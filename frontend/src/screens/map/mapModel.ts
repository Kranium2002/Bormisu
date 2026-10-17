/**
 * Pure presentation logic of the Map screen: which boreholes are plotted, legend counts,
 * the CRS column text, the NOT ON MAP reasons and the RESULTS summary line. Unit-tested.
 */
import { crsLabel, metres, unplottedText } from '../../domain/format';
import { displayStatus } from '../../domain/status';
import type { Borehole, BoreholeStatus } from '../../domain/types';
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
export function legendEntries(boreholes: Borehole[], statuses: Map<string, BoreholeStatus>): LegendEntry[] {
  const counts: Record<BoreholeStatus, number> = { approved: 0, in_review: 0, unreviewed: 0, attention: 0 };
  for (const b of boreholes) {
    if (isPlotted(b)) counts[statuses.get(b.uid) ?? displayStatus(b)] += 1;
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
export function depthText(b: Borehole): string {
  return b.finalDepth != null && Number.isFinite(b.finalDepth) && b.finalDepth > 0 ? metres(b.finalDepth) : '–';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** RESULTS summary, e.g. "48 boreholes · 7 projects". No country: projects can be anywhere. */
export function resultsSummary(boreholes: Borehole[]): string {
  const projects = new Set(boreholes.map((b) => b.project)).size;
  return `${plural(boreholes.length, 'borehole', 'boreholes')} · ${plural(projects, 'project', 'projects')}`;
}

/**
 * First view of the map: the bounds of all pins, wherever they are, so none starts off-screen; the
 * whole world while nothing is plotted (the empty start). No country is built in.
 */
export function initialBounds(boreholes: Borehole[]): Bounds {
  const pins = boreholes.filter(isPlotted);
  if (!pins.length) return WORLD_BOUNDS;
  const lats = pins.map((b) => b.lat);
  const lngs = pins.map((b) => b.lng);
  return [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];
}
