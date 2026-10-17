/**
 * DIN 4023 lookup over the shared pattern assets (assets/din4023_patterns, whose README is binding).
 * A layer's `din` code is a key of din_codes.json. Keys are case-sensitive: `mG` is medium gravel,
 * `Mg` is till marl. A code that isn't a key (or no code) is drawn plain grey, never as a guess.
 */
import dinCodes from '@din/din_codes.json';

/** Fill of a layer whose code is unknown or missing: plain grey, no pattern. */
export const DIN_UNKNOWN_FILL = '#E0E0E0';

/** One entry of din_codes.json, in the app's naming. */
export interface DinEntry {
  code: string;
  kind: 'soil' | 'rock' | 'geological';
  nameEn: string;
  nameDe: string;
  /** DIN background colour; null only for `A` (fill), which needs a white underlay. */
  colour: string | null;
  /** Id of the `<pattern>` in patterns.svg (inlined once by DinPatternDefs). */
  patternId: string;
  /** Size of one tile in user units: tiles repeat at this size and are never stretched. */
  tileWidth: number;
  tileHeight: number;
}

/** Shape of din_codes.json. */
interface RawDinEntry {
  kind: DinEntry['kind'];
  name_de: string;
  name_en: string;
  colour: string | null;
  pattern_id: string;
  tile_width: number;
  tile_height: number;
}

const RAW = dinCodes as Record<string, RawDinEntry>;

const ENTRIES = new Map<string, DinEntry>(
  Object.entries(RAW).map(([code, e]) => [
    code,
    {
      code,
      kind: e.kind,
      nameEn: e.name_en,
      nameDe: e.name_de,
      colour: e.colour,
      patternId: e.pattern_id,
      tileWidth: e.tile_width,
      tileHeight: e.tile_height,
    },
  ]),
);

/** Every DIN code of the asset set, in file order. */
export const DIN_CODES: readonly string[] = [...ENTRIES.keys()];

/** The entry of a DIN code (exact, case-sensitive), or null for an unknown or missing code. */
export function dinEntry(code: string | null | undefined): DinEntry | null {
  return code ? (ENTRIES.get(code) ?? null) : null;
}

/** SVG fill of a code: `url(#<pattern_id>)`, or plain DIN_UNKNOWN_FILL for an unknown or missing code. */
export function dinFill(code: string | null | undefined): string {
  const e = dinEntry(code);
  return e ? `url(#${e.patternId})` : DIN_UNKNOWN_FILL;
}

/** True when the code's pattern has no background colour (`A`): draw a white rect under it. */
export function dinNeedsUnderlay(code: string | null | undefined): boolean {
  return dinEntry(code)?.colour === null;
}

/** One legend row: a code used in a profile and its entry (null when the code isn't a DIN key). */
export interface DinLegendItem { code: string; entry: DinEntry | null }

/** The distinct codes of a profile from the top down, unknown codes included; missing codes are left out. */
export function dinLegendItems(layers: readonly { din: string | null }[]): DinLegendItem[] {
  const seen = new Set<string>();
  const out: DinLegendItem[] = [];
  for (const { din } of layers) {
    if (!din || seen.has(din)) continue;
    seen.add(din);
    out.push({ code: din, entry: dinEntry(din) });
  }
  return out;
}
