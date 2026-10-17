/**
 * Pure presentation logic of the Map screen: which boreholes are plotted for the map focus, legend
 * counts, the focus dropdown's options, the CRS column text, the NOT ON MAP reasons, the RESULTS
 * summary line and the NEAR YOU list. Unit-tested.
 */
import { metres } from '../../domain/format';
import { boreholeStatus } from '../../domain/review';
import type { Borehole, BoreholeStatus } from '../../domain/types';
import type { Country } from '../../geo/countries';
import type { CountryHit } from '../../geo/countryAssign';
import { WORLD, type MapFocus } from '../../geo/mapFocus';
import { formatDistance, nearest, type GeoPoint, type Nearby } from '../../geo/nearest';
import { pinColor } from '../../theme';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many boreholes NEAR YOU lists, and the radius it calls "near". */
export const NEAR_YOU_COUNT = 5;
export const NEAR_YOU_RADIUS_M = 2000;

export interface NearYouModel {
  /** "Accuracy ±25 m". */
  accuracy: string;
  /** The nearest pins, nearest first, with distance ("112 m") and compass direction ("SW"). */
  rows: (Nearby<PlottedBorehole> & { distance: string })[];
  /** "No borehole within 2 km of you. Nearest: BK-07 at 3.4 km." when even the nearest is farther; else null. */
  farMessage: string | null;
}

/** NEAR YOU: the five boreholes with coordinates nearest to the position (in any country). */
export function nearYouModel(at: GeoPoint & { accuracyM: number }, pins: readonly PlottedBorehole[]): NearYouModel {
  const rows = nearest(at, pins, NEAR_YOU_COUNT).map((n) => ({ ...n, distance: formatDistance(n.distanceM) }));
  const first = rows[0];
  return {
    accuracy: `Accuracy ±${formatDistance(at.accuracyM)}`,
    rows,
    farMessage:
      first && first.distanceM > NEAR_YOU_RADIUS_M
        ? `No borehole within 2 km of you. Nearest: ${first.item.id} at ${first.distance}.`
        : null,
  };
}

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

export interface NotOnMapItem {
  borehole: Borehole;
  reason: NotOnMapReason;
}

/** Country of each plotted borehole, keyed by uid (src/geo/countryAssign.ts). */
export type CountryHits = ReadonlyMap<string, CountryHit>;

/** Which boreholes the map draws as pins for the focus, and which it lists elsewhere. */
export interface MapPlacement {
  /** Pins: every borehole with coordinates (World), or those in the focus country. */
  plotted: PlottedBorehole[];
  /** No usable coordinates: listed under NOT ON MAP in every focus. */
  unplaced: NotOnMapItem[];
  /** With coordinates, but outside the focus country (always empty for World). */
  outside: PlottedBorehole[];
  /**
   * RESULTS rows, in data order: the pins plus the boreholes without coordinates that belong here. In a
   * country view that is one whose project has a pin in the country, or no pin anywhere (its country is
   * unknown, so it shows in every view).
   */
  results: Borehole[];
}

/**
 * Splits the boreholes for the map focus. A borehole is in a country's view when it lies inside the
 * outline or within the 2 km border tolerance (`CountryHit.countries`). Without `hits` (outlines not
 * loaded yet) a country focus has no pins.
 */
export function placeBoreholes(boreholes: Borehole[], focus: MapFocus, hits: CountryHits | null): MapPlacement {
  const placement: MapPlacement = { plotted: [], unplaced: [], outside: [], results: [] };
  const located = new Set<string>();
  const here = new Set<string>();
  for (const b of boreholes) {
    if (!isPlotted(b)) continue;
    located.add(b.project);
    if (focus === WORLD || hits?.get(b.uid)?.countries.includes(focus)) here.add(b.project);
  }
  for (const b of boreholes) {
    if (!isPlotted(b)) {
      placement.unplaced.push({ borehole: b, reason: notOnMapReason(b) });
      if (here.has(b.project) || !located.has(b.project)) placement.results.push(b);
    } else if (focus === WORLD || hits?.get(b.uid)?.countries.includes(focus)) {
      placement.plotted.push(b);
      placement.results.push(b);
    } else {
      placement.outside.push(b);
    }
  }
  return placement;
}

/** Pins per country view (a borehole within 2 km of a border counts for both countries). */
export function countryCounts(hits: CountryHits): Map<string, number> {
  const counts = new Map<string, number>();
  for (const hit of hits.values()) for (const code of hit.countries) counts.set(code, (counts.get(code) ?? 0) + 1);
  return counts;
}

export interface FocusOption {
  value: MapFocus;
  /** e.g. "World · 58", "Germany · 45". */
  label: string;
}

/**
 * The focus dropdown: World first, then every country with at least one pin, by count (most first)
 * and name. The current focus is always an option, also without pins or before the outlines are
 * loaded (then labelled by its code).
 */
export function focusOptions(
  focus: MapFocus,
  pinCount: number,
  countries: readonly Country[] | null,
  hits: CountryHits | null,
): FocusOption[] {
  const options: FocusOption[] = [{ value: WORLD, label: `World · ${pinCount}` }];
  const counts = hits ? countryCounts(hits) : new Map<string, number>();
  const named = (countries ?? [])
    .filter((c) => (counts.get(c.code) ?? 0) > 0 || c.code === focus)
    .map((c) => ({ value: c.code, name: c.name, count: counts.get(c.code) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  for (const c of named) options.push({ value: c.value, label: `${c.name} · ${c.count}` });
  if (focus !== WORLD && !named.some((c) => c.value === focus)) options.push({ value: focus, label: focus });
  return options;
}

/** Display name of a focus: "World", the country's name, or the code until the outlines are loaded. */
export function focusName(focus: MapFocus, country: Country | null): string {
  return focus === WORLD ? 'World' : (country?.name ?? focus);
}

export interface OutsideSummary {
  count: number;
  /** e.g. "13 boreholes outside Germany". */
  text: string;
  /** Where they are, e.g. "Norway 5 · Singapore 4 · Switzerland 4 · no country 1". */
  detail: string;
}

/** The one NOT ON MAP / RESULTS line for the boreholes outside the focus country, or null when there are none. */
export function outsideSummary(
  outside: readonly Borehole[],
  hits: CountryHits | null,
  focusLabel: string,
  countries: readonly Country[] | null,
): OutsideSummary | null {
  if (!outside.length) return null;
  const names = new Map((countries ?? []).map((c) => [c.code, c.name]));
  const counts = new Map<string, number>();
  for (const b of outside) {
    const code = hits?.get(b.uid)?.country ?? null;
    const name = code ? (names.get(code) ?? code) : 'no country';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const detail = [...counts]
    .sort(([a, x], [b, y]) => (a === 'no country' ? 1 : 0) - (b === 'no country' ? 1 : 0) || y - x || a.localeCompare(b))
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ');
  return { count: outside.length, text: `${plural(outside.length, 'borehole', 'boreholes')} outside ${focusLabel}`, detail };
}

/**
 * What the map does with a search result (store `flyTarget`):
 * - `fly`: the borehole is a pin of the current focus;
 * - `switch`: it lies in another country (or in none): switch the focus first, then fly;
 * - `missing`: flagged as on the map, but without usable coordinates: explain instead;
 * - `wait`: a country focus whose outlines are still loading.
 */
export type SearchStep =
  | { kind: 'fly' }
  | { kind: 'switch'; focus: MapFocus }
  | { kind: 'missing'; reason: string }
  | { kind: 'wait' };

export function searchStep(b: Borehole, placement: MapPlacement, hits: CountryHits | null): SearchStep {
  if (!isPlotted(b)) return { kind: 'missing', reason: notOnMapReason(b).text };
  if (placement.plotted.some((p) => p.uid === b.uid)) return { kind: 'fly' };
  if (!hits) return { kind: 'wait' };
  return { kind: 'switch', focus: hits.get(b.uid)?.country ?? WORLD };
}

/** Final depth as "18.00 m", or "–" when no depth was extracted (a blank never means 0). */
export function depthText(b: Borehole): string {
  return b.finalDepth != null && Number.isFinite(b.finalDepth) && b.finalDepth > 0 ? metres(b.finalDepth) : '–';
}

/** RESULTS summary, e.g. "48 boreholes · 7 projects". The focus is shown next to the RESULTS title. */
export function resultsSummary(boreholes: Borehole[]): string {
  const projects = new Set(boreholes.map((b) => b.project)).size;
  return `${plural(boreholes.length, 'borehole', 'boreholes')} · ${plural(projects, 'project', 'projects')}`;
}
