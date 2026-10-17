/**
 * Geometry of the DIN 4023 profile column (prototype detail section of renderVals):
 * a 414 x 660 SVG whose depth axis runs from y = 28 (0 m) over 576 px down to the final depth.
 * Left of the lithology column (DIN 4023 §5.6, Table 5): the groundwater, sample and cored lane;
 * right of it the Table 6 strip, the layer bottoms and the labels.
 * DIN patterns repeat at their native tile size (scale 1 for the whole profile), never stretched.
 */
import { decimal } from '../../domain/format';
import type { Borehole, Layer, Sample } from '../../domain/types';

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
  /** Table 6 strip right of the column (wet, consistency / density, weathering), clear of the selection outline. */
  propX: 230,
  propW: 44,
  bottomTickTo: 279,
  bottomLabel: 282,
  code: 317,
  rockFrom: 116,
  rockTo: 367,
  refusalX: 388,
} as const;

/** Font size of the layer label (DIN code or notation), px. */
export const LABEL_FONT = 11;

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

/** One block of the Strat. column; `name` is null where the source states no stratigraphic name. */
export interface StratBlock { name: string | null; from: number; to: number }

/** Strat. column: consecutive layers with the same stratigraphic name merge into one block. */
export function stratBlocks(layers: Layer[]): StratBlock[] {
  const out: StratBlock[] = [];
  for (const l of layers) {
    const name = l.stratigraphicName?.trim() || null;
    const last = out[out.length - 1];
    if (last && last.name === name) last.to = l.to;
    else out.push({ name, from: l.from, to: l.to });
  }
  return out;
}

/** Rough width of a text in the profile's sans font (px): enough to decide whether a label fits. */
export function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.62;
}

/** The text cut to fit maxPx, with an ellipsis; '' when not even two characters fit. */
export function fitText(text: string, maxPx: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxPx) return text;
  const chars = Math.floor(maxPx / (fontSize * 0.62)) - 1;
  return chars >= 2 ? `${text.slice(0, chars).trimEnd()}…` : '';
}

/**
 * Label next to a layer: its DIN 4023 notation ("U, t, s'") when that fits maxPx, else its DIN code,
 * else '' (nothing stated, nothing shown).
 */
export function layerLabel(l: Pick<Layer, 'din' | 'dinNotation'>, maxPx: number): string {
  const notation = l.dinNotation?.trim();
  if (notation && textWidth(notation, LABEL_FONT) <= maxPx) return notation;
  return l.din ?? '';
}

/** "Not logged" band when the log stops above the final depth (e.g. a missing sheet). */
export function notLogged(b: Pick<Borehole, 'finalDepth' | 'logBottom' | 'layers'>): { from: number; to: number; label: string } | null {
  if (b.finalDepth == null || !b.layers.length || b.logBottom >= b.finalDepth - 0.005) return null;
  return {
    from: b.logBottom,
    to: b.finalDepth,
    label: `log ends ${decimal(b.logBottom)} ≠ ET ${decimal(b.finalDepth)}`,
  };
}

/**
 * True unless the reviewer marked the value "not in source" or "illegible": the profile draws only
 * measurements the source states (groundwater, rock head, SPT refusal), as the tables show them.
 */
export function isStated(b: Pick<Borehole, 'values'>, key: string): boolean {
  const v = b.values.find((x) => x.key === key);
  return !v || v.state === 'ok';
}

/** The first SPT refusal from the top: the profile's amber R marker. `depth` is null when the source doesn't state it. */
export interface Refusal { layer: Layer; depth: number | null; raw: string }

/** First SPT refusal from the top: the profile's amber R marker. */
export function firstRefusal(layers: Layer[]): Refusal | null {
  for (const l of layers) {
    if (l.spt?.refusal) return { layer: l, depth: l.spt.depth, raw: l.spt.raw };
  }
  return null;
}

/**
 * Where the R marker sits, in metres. A stated test depth places it exactly; without one it sits in
 * the middle of its layer as a position only, and `stated` is false so nothing prints that depth.
 */
export function refusalMarkerDepth(r: Refusal): { at: number; stated: boolean } {
  return r.depth != null ? { at: r.depth, stated: true } : { at: (r.layer.from + r.layer.to) / 2, stated: false };
}

/** Depth a sample marker sits at: the bottom of its stated range, else its top; null when the source states neither. */
export function sampleDepth(s: Pick<Sample, 'from' | 'to'>): number | null {
  return s.to ?? s.from;
}
