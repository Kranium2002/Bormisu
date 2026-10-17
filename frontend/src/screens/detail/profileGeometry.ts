/**
 * Geometry of the DIN 4023 profile column (prototype detail section of renderVals):
 * a 414 x 660 SVG whose depth axis runs from y = 28 (0 m) over 576 px down to the final depth.
 */
import { K } from '../../domain/keys';
import type { Borehole, GroundwaterReading, Layer } from '../../domain/types';

export const PROFILE_W = 414;
export const PROFILE_H = 660;
/** y of 0 m. */
export const PROFILE_TOP = 28;
/** Height of the depth axis in px. */
export const PROFILE_DEPTH_PX = 576;

/** Columns (x in px). */
export const X = {
  axis: 44,
  tickFrom: 38,
  stratX: 52,
  stratW: 36,
  stratMid: 70,
  /** Lane between Strat. and the lithology (Table 5): groundwater symbols, sample symbols, the cored line. */
  gwFrom: 88,
  gwX: 89,
  sampleX: 103,
  sampleW: 8,
  layerX: 120,
  layerW: 100,
  layerMid: 170,
  /** DIN 4023 Table 6 strip right of the column (consistency, density, weathering, jointing, wet), kept clear
   *  of the selected layer's thick outline. */
  propX: 230,
  propW: 44,
  bottomTickTo: 279,
  bottomLabel: 282,
  code: 317,
  rockFrom: 116,
  rockTo: 367,
  refusalX: 355,
} as const;

export interface DepthScale {
  /** Depth the axis covers, m (the final depth, or the log bottom if that is deeper). */
  depth: number;
  /** px per metre. */
  s: number;
  y(d: number): number;
}

/** Depth scale of a borehole. Never divides by zero, even for a borehole without depth or layers. */
export function depthScale(b: Pick<Borehole, 'finalDepth' | 'logBottom'>): DepthScale {
  const depth = Math.max(b.finalDepth || 0, b.logBottom || 0) || 1;
  const s = PROFILE_DEPTH_PX / depth;
  return { depth, s, y: (d) => PROFILE_TOP + d * s };
}

/** Tick spacing: every 2 m, 4 m below 22 m depth, 10 m for very deep holes (keeps labels apart). */
export function tickStep(depth: number): number {
  if (depth > 60) return 10;
  return depth > 22 ? 4 : 2;
}

/** Depths of the axis ticks: 0, step, 2·step … up to the depth. */
export function depthTicks(depth: number): number[] {
  const step = tickStep(depth);
  const out: number[] = [];
  for (let d = 0; d <= depth + 0.001; d += step) out.push(d);
  return out;
}

export interface StratBlock { code: string; from: number; to: number }

/** Strat. column: consecutive layers with the same stratigraphy code merge into one block. */
export function stratBlocks(layers: Layer[]): StratBlock[] {
  const out: StratBlock[] = [];
  for (const l of layers) {
    const last = out[out.length - 1];
    if (last && last.code === l.strat) last.to = l.to;
    else out.push({ code: l.strat, from: l.from, to: l.to });
  }
  return out;
}

/** "Not logged" band when the log stops above the final depth (e.g. a missing sheet). */
export function notLogged(b: Pick<Borehole, 'finalDepth' | 'logBottom' | 'layers'>): { from: number; to: number } | null {
  if (b.finalDepth == null || !b.layers.length || b.logBottom >= b.finalDepth - 0.005) return null;
  return { from: b.logBottom, to: b.finalDepth };
}

/**
 * True unless the reviewer marked the value "not in source" or "illegible": the profile draws only
 * measurements the source states (groundwater, rock head, SPT refusal), as the tables show them.
 */
export function isStated(b: Pick<Borehole, 'values'>, key: string): boolean {
  const v = b.values.find((x) => x.key === key);
  return !v || v.state === 'ok';
}

/** First SPT refusal from the top: the profile's amber R marker. */
export function firstRefusal(layers: Layer[]): { layer: Layer; depth: number; raw: string } | null {
  for (const l of layers) {
    if (l.spt?.refusal) return { layer: l, depth: l.spt.depth, raw: l.spt.raw };
  }
  return null;
}

/** Markers the profile draws: only measurements the source states. */
export interface DrawnMarks {
  groundwater: GroundwaterReading[];
  rockHead: number | null;
  refusal: ReturnType<typeof firstRefusal>;
}

export function drawnMarks(b: Pick<Borehole, 'values' | 'groundwater' | 'rockHead' | 'layers'>): DrawnMarks {
  return {
    groundwater: b.groundwater.filter((g) => isStated(b, g.key)),
    rockHead: isStated(b, K.rockHead) ? b.rockHead : null,
    refusal: firstRefusal(b.layers.filter((l) => isStated(b, K.spt(l.n)))),
  };
}
