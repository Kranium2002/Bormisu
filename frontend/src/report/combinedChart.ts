/**
 * Geometry of the report's combined soil chart: the DIN 4023 profiles of a selection side by side on
 * one shared vertical axis, as plain numbers (no React, no DOM).
 *
 * - `depth` mode: every column starts at its ground, the axis is metres below ground.
 * - `elevation` mode: columns hang from their ground level, the axis is the elevation (m NN or the
 *   datum the logs state). Boreholes without a stated ground level can't be placed and are named.
 * - For a planned line the columns sit at their chainage along the line (a simple longitudinal ground
 *   section), pushed apart just enough not to overlap; a leader joins each column to its true chainage
 *   on the axis below. Other selections stand side by side in report order.
 *
 * At most CHART_MAX columns are drawn (a 100-borehole chart can't be read); the chart says so.
 */
import { dinFill, dinLegendItems, dinNeedsUnderlay, type DinLegendItem } from '../domain/din';
import type { Borehole } from '../domain/types';
import { layerLabel, tickStep } from '../screens/detail/profileGeometry';
import { elevationDatum, groundLevel } from './reportModel';

export type ChartMode = 'depth' | 'elevation';

/** Columns a combined chart draws at most. */
export const CHART_MAX = 40;

/** Width of a profile column and the least distance between two column centres (px). */
export const COL_W = 30;
export const PITCH = 46;
const LEFT = 62;
const RIGHT = 18;
/** Room above the drawing for the rotated borehole IDs. */
const LABEL_H = 96;
const DRAW_TOP = LABEL_H + 14;
export const DRAW_H = 440;
const BOTTOM = 26;
const CHAINAGE_H = 46;
const MIN_INNER = 560;
const LINE_INNER = 860;

export interface ChartLayer {
  n: number;
  y0: number;
  y1: number;
  din: string | null;
  fill: string;
  underlay: boolean;
  /** The code written in the layer when it is tall enough, else ''. */
  label: string;
}

export interface ChartColumn {
  uid: string;
  id: string;
  /** Left edge and centre of the column. */
  x: number;
  cx: number;
  /** y of the ground (depth 0) and of the bottom of the drawn log. */
  groundY: number;
  bottomY: number;
  layers: ChartLayer[];
  /** Between the last logged layer and the final depth: drawn as "not logged". */
  notLogged: { y0: number; y1: number } | null;
  /** y of the first groundwater reading with a depth, or null. */
  groundwaterY: number | null;
  groundLevel: number | null;
  /** Planned line: the chainage (m) and its x on the axis. */
  chainage: number | null;
  anchorX: number | null;
}

export interface ChartTick { y: number; label: string }

export interface CombinedChart {
  mode: ChartMode;
  width: number;
  height: number;
  drawTop: number;
  drawBottom: number;
  left: number;
  columns: ChartColumn[];
  ticks: ChartTick[];
  /** "Depth below ground (m)" or "Elevation (m NN)", untranslated (the screen translates it). */
  axisTitle: string;
  /** The datum of the elevation axis, when the logs state one. */
  datum: string | null;
  chainageAxis: { y: number; x0: number; x1: number; ticks: { x: number; label: string }[] } | null;
  /** Columns drawn, and how many boreholes could have been (capped when shown < eligible). */
  shown: number;
  eligible: number;
  /** IDs left out of the elevation mode for want of a ground level. */
  withoutGroundLevel: string[];
  legend: DinLegendItem[];
  /** True when a drawn layer has no DIN code in its record (drawn plain grey, said so in the legend). */
  uncoded: boolean;
}

/** Depth of the drawn log: the final depth or the last layer's bottom, whichever is deeper (0 without either). */
export function logDepth(b: Pick<Borehole, 'finalDepth' | 'logBottom' | 'layers'>): number {
  return Math.max(b.finalDepth || 0, b.logBottom || 0, ...b.layers.map((l) => l.to || 0), 0);
}

/** True when an elevation axis makes sense: at least two boreholes state their ground level. */
export function canAlignByElevation(records: readonly Borehole[]): boolean {
  return records.filter((b) => groundLevel(b) != null).length >= 2;
}

/** A tidy step for an axis covering `span` with about `parts` ticks: 1, 2 or 5 × 10^k. */
export function niceStep(span: number, parts = 6): number {
  if (!(span > 0)) return 1;
  const raw = span / parts;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** "0 m", "250 m", "1.25 km" for the chainage axis. */
export function chainageLabel(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, '')} km`;
  return `${Math.round(m)} m`;
}

/** Column centres at their chainage, pushed apart to at least PITCH, inside [lo, hi]. */
export function spreadAlong(anchors: readonly number[], lo: number, hi: number, pitch = PITCH): number[] {
  const out = anchors.map((a) => Math.min(Math.max(a, lo), hi));
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + pitch);
  if (out.length) out[out.length - 1] = Math.min(out[out.length - 1], hi);
  for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - pitch);
  return out;
}

interface Options {
  mode: ChartMode;
  /** Planned line: the chainage of each borehole (uid → m) and the line's length. */
  chainages?: ReadonlyMap<string, number>;
  lineLengthM?: number;
  max?: number;
}

/** The combined chart of the records (in report order). */
export function combinedChart(records: readonly Borehole[], opts: Options): CombinedChart {
  const max = opts.max ?? CHART_MAX;
  const isLine = !!opts.chainages;
  const withGl = records.filter((b) => groundLevel(b) != null);
  const eligible = opts.mode === 'elevation' ? withGl : [...records];
  const shown = eligible.slice(0, max);
  const withoutGroundLevel = opts.mode === 'elevation' ? records.filter((b) => groundLevel(b) == null).map((b) => b.id) : [];

  // Vertical scale.
  const depths = shown.map(logDepth);
  let ticks: ChartTick[];
  let y: (b: Borehole, depth: number) => number;
  let datum: string | null = null;
  if (opts.mode === 'elevation' && shown.length) {
    const tops = shown.map((b) => groundLevel(b)!);
    const top = Math.max(...tops);
    const bottom = Math.min(...tops.map((gl, i) => gl - depths[i]));
    const step = tickStep(Math.max(top - bottom, 1));
    const hi = Math.ceil(top / step) * step;
    const lo = Math.min(Math.floor(bottom / step) * step, hi - step);
    const s = DRAW_H / (hi - lo);
    y = (b, d) => DRAW_TOP + (hi - (groundLevel(b)! - d)) * s;
    ticks = [];
    for (let e = hi; e >= lo - 1e-6; e -= step) ticks.push({ y: DRAW_TOP + (hi - e) * s, label: String(Math.round(e * 100) / 100) });
    const datums = new Set(shown.map(elevationDatum).filter((d): d is string => !!d));
    datum = datums.size === 1 ? [...datums][0] : null;
  } else {
    const deepest = Math.max(1, ...depths);
    const step = tickStep(deepest);
    const hi = Math.ceil(deepest / step) * step;
    const s = DRAW_H / hi;
    y = (_b, d) => DRAW_TOP + d * s;
    ticks = [];
    for (let d = 0; d <= hi + 1e-6; d += step) ticks.push({ y: DRAW_TOP + d * s, label: String(Math.round(d * 100) / 100) });
  }

  // Horizontal positions.
  const n = shown.length;
  const inner = Math.max(n * PITCH, isLine ? LINE_INNER : MIN_INNER);
  const lo = LEFT + PITCH / 2;
  const hi = LEFT + inner - PITCH / 2;
  const length = opts.lineLengthM && opts.lineLengthM > 0 ? opts.lineLengthM : Math.max(1, ...shown.map((b) => opts.chainages?.get(b.uid) ?? 0));
  const anchorOf = (m: number) => lo + (Math.min(Math.max(m, 0), length) / length) * (hi - lo);
  const anchors = isLine ? shown.map((b) => anchorOf(opts.chainages!.get(b.uid) ?? 0)) : null;
  const centres = anchors ? spreadAlong(anchors, lo, hi) : shown.map((_b, i) => lo + i * PITCH);

  const columns: ChartColumn[] = shown.map((b, i) => {
    const cx = centres[i];
    const layers: ChartLayer[] = b.layers
      .filter((l) => l.to > l.from)
      .map((l) => {
        const y0 = y(b, l.from);
        const y1 = y(b, l.to);
        return { n: l.n, y0, y1, din: l.din, fill: dinFill(l.din), underlay: dinNeedsUnderlay(l.din), label: y1 - y0 >= 12 ? layerLabel(l, COL_W - 4) : '' };
      });
    const logged = Math.max(0, ...b.layers.map((l) => l.to || 0));
    const final = b.finalDepth || 0;
    // A reading above ground or below the log (a sign or datum the record doesn't settle) isn't drawn.
    const gw = b.groundwater.find((g) => g.depth != null && g.depth >= 0 && g.depth <= depths[i]);
    const chainage = opts.chainages?.get(b.uid) ?? null;
    return {
      uid: b.uid,
      id: b.id,
      x: cx - COL_W / 2,
      cx,
      groundY: y(b, 0),
      bottomY: y(b, depths[i]),
      layers,
      notLogged: final > logged + 0.005 ? { y0: y(b, logged), y1: y(b, final) } : null,
      groundwaterY: gw?.depth != null ? y(b, gw.depth) : null,
      groundLevel: groundLevel(b),
      chainage,
      anchorX: anchors ? anchors[i] : null,
    };
  });

  const drawBottom = DRAW_TOP + DRAW_H;
  let chainageAxis: CombinedChart['chainageAxis'] = null;
  if (isLine) {
    const axisY = drawBottom + BOTTOM + 8;
    const step = niceStep(length);
    const axisTicks: { x: number; label: string }[] = [];
    for (let m = 0; m <= length + 1e-6; m += step) axisTicks.push({ x: anchorOf(m), label: chainageLabel(m) });
    chainageAxis = { y: axisY, x0: lo, x1: hi, ticks: axisTicks };
  }

  return {
    mode: opts.mode,
    width: LEFT + inner + RIGHT,
    height: drawBottom + BOTTOM + (isLine ? CHAINAGE_H : 0),
    drawTop: DRAW_TOP,
    drawBottom,
    left: LEFT,
    columns,
    ticks,
    axisTitle: opts.mode === 'elevation' ? 'Elevation (m)' : 'Depth below ground (m)',
    datum,
    chainageAxis,
    shown: n,
    eligible: eligible.length,
    withoutGroundLevel,
    legend: dinLegendItems(shown.flatMap((b) => b.layers)),
    uncoded: shown.some((b) => b.layers.some((l) => !l.din && l.to > l.from)),
  };
}
