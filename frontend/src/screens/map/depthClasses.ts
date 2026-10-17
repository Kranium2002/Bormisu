/**
 * Depth classes of the map's "Colour by: depth" mode (FRONTEND.md F9: "the classes are a config
 * array, not code"). Edit this array to change the classes; the pins, the cluster rings and the
 * legend follow it.
 *
 * - A class holds the final depths (metres) with `min < depth ≤ max`; `max: null` has no upper
 *   bound. The classes should cover every depth above 0 without gaps (a unit test checks it); a
 *   stated depth that falls into no class is counted as "Other depth", never put into a class.
 * - A borehole whose final depth is not stated (null, or 0, which no report means as a final depth)
 *   is its own grey class, DEPTH_NOT_STATED: an unknown depth is never one of the classes.
 * - Colours: a sequential palette (plasma, light to dark with depth). It reads for the common
 *   colour-vision deficiencies and keeps clear of the status meanings (green approved, amber
 *   attention); the "not stated" grey is the map's neutral grey.
 */
export interface DepthClass {
  /** Legend text. */
  label: string;
  /** Lower bound in metres, exclusive. */
  min: number;
  /** Upper bound in metres, inclusive; null: no upper bound. */
  max: number | null;
  /** Pin fill and cluster ring colour (hex). */
  colour: string;
}

export const DEPTH_CLASSES: readonly DepthClass[] = [
  { label: '0–10 m', min: 0, max: 10, colour: '#FCA636' },
  { label: '>10–20 m', min: 10, max: 20, colour: '#E16462' },
  { label: '>20–50 m', min: 20, max: 50, colour: '#B12A90' },
  { label: '>50–100 m', min: 50, max: 100, colour: '#6A00A8' },
  { label: '>100 m', min: 100, max: null, colour: '#0D0887' },
];

/** The class of a borehole without a stated final depth. */
export const DEPTH_NOT_STATED = { label: 'Depth not stated', colour: '#A3A3A2' } as const;

/** A stated depth outside every configured class (only possible with a gap in DEPTH_CLASSES). */
export const DEPTH_OUTSIDE = { label: 'Other depth', colour: '#555555' } as const;
