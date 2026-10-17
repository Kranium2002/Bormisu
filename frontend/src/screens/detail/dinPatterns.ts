/**
 * DIN 4023 drawing over the shared assets (assets/din4023_patterns, whose README is binding):
 * the lithology fill of a layer (Tables 1–4: main tile, first secondary component, two equal parts),
 * the Table 6 property symbols right of the column, the Table 5 groundwater, sample and cored
 * symbols left of it, and the extra `<pattern>`s DinPatternDefs mounts next to patterns.svg.
 *
 * Only what the source states is drawn: a property the record leaves empty, or names in words no
 * DIN term matches, draws nothing (never a default).
 */
import properties from '@din/properties.json';
import secondaryCodes from '@din/secondary_codes.json';
import gwAfter from '@din/left_symbols/groundwater_after_drilling.svg?raw';
import gwRest from '@din/left_symbols/groundwater_rest.svg?raw';
import gwStruck from '@din/left_symbols/groundwater_struck.svg?raw';
import cored from '@din/left_symbols/sample_cored.svg?raw';
import sampleSoil from '@din/left_symbols/sample_sample.svg?raw';
import sampleWater from '@din/left_symbols/sample_water_sample.svg?raw';
import { DIN_UNKNOWN_FILL, dinEntry } from '../../domain/din';
import type { GroundwaterType, Layer, Sample } from '../../domain/types';
import { COL } from '../../theme';

/* ---------- svg files ---------- */

/** A symbol file split into its size and inner markup, so it can be scaled into a pattern or a nested svg. */
export interface SvgSymbol { w: number; h: number; inner: string }

function parse(svg: string): SvgSymbol {
  const m = /<svg[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*>([\s\S]*)<\/svg>/.exec(svg);
  if (!m) throw new Error('not an svg file');
  return { w: Number(m[1]), h: Number(m[2]), inner: m[3] };
}

/** Extra `<pattern>` markup (property tiles, the cored line) for DinPatternDefs, keyed by id. */
const EXTRA = new Map<string, string>();

/** A tile repeated from the origin of the element that uses it (draw it inside a translated group); never stretched. */
function tilePattern(id: string, s: SvgSymbol, k: number) {
  EXTRA.set(
    id,
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${s.w * k}" height="${s.h * k}" viewBox="0 0 ${s.w} ${s.h}">${s.inner}</pattern>`,
  );
}

/* ---------- lithology fill (Tables 1–4) ---------- */

/** Fill of a code that is not a key of din_codes.json: solid red, so the missing pattern stands out. */
export const UNKNOWN_CODE_FILL = COL.red;

/** The fill of a layer's own rect (the one with data-din): its tile, red for an unknown code, plain grey without a code. */
export function mainFill(din: string | null | undefined): string {
  if (!din) return DIN_UNKNOWN_FILL;
  const e = dinEntry(din);
  return e ? `url(#${e.patternId})` : UNKNOWN_CODE_FILL;
}

/** True when the layer names a code that has no DIN 4023 pattern ("no pattern assigned"). */
export const isUnknownCode = (din: string | null | undefined): din is string => !!din && !dinEntry(din);

/** One rectangle drawn over a layer's fill: from x0 to x1 (fractions of the column width). */
export interface FillPart { x0: number; x1: number; fill: string; title: string }

interface SecondaryEntry { main: string; name_en: string; name_de: string; colour: string; symbol_pattern_id: string }
const SECONDARY = secondaryCodes as Record<string, SecondaryEntry>;

/** "fs'" (slightly), "fs̄" / "fs*" (strongly) are text only: drawn like "fs". */
const bare = (c: string) => c.replace(/['’*̄]/g, '').trim();

/**
 * What is drawn over a layer's main tile, from its DIN short form (§4.2): two equal parts ("S/G")
 * get the second colour on the right half and both symbols over the full width; otherwise the first
 * secondary component ("U, s") gets its symbol over the right half. An unknown main code, a missing
 * notation or a component that is no DIN term adds nothing.
 */
export function layerOverlays(l: Pick<Layer, 'din' | 'dinNotation'>): FillPart[] {
  if (!l.dinNotation || isUnknownCode(l.din) || !l.din) return [];
  const [first = '', ...rest] = l.dinNotation.split(',').map(bare);
  const halves = first.split('/').map((c) => c.trim());
  if (halves.length === 2) {
    const [a, b] = halves.map((c) => dinEntry(c));
    if (!a || !b) return [];
    const sym = (c: string) => `url(#din-sym-${dinFile(c)})`;
    return [
      { x0: 0.5, x1: 1, fill: b.colour ?? '#fff', title: b.nameEn },
      { x0: 0, x1: 1, fill: sym(a.code), title: a.nameEn },
      { x0: 0, x1: 1, fill: sym(b.code), title: b.nameEn },
    ];
  }
  const second = rest.find((c) => c.length > 0)?.toLowerCase();
  const sec = second && Object.hasOwn(SECONDARY, second) ? SECONDARY[second] : null;
  return sec ? [{ x0: 0.5, x1: 1, fill: `url(#${sec.symbol_pattern_id})`, title: sec.name_en }] : [];
}

/** File stem of a code's symbol pattern ("din-rock_Kst" → "rock_Kst"); the symbol is "din-sym-<stem>". */
function dinFile(code: string): string {
  return dinEntry(code)!.patternId.replace(/^din-/, '');
}

/** The secondary component drawn for a layer, for the legend; null when none is drawn. */
export function secondaryOf(l: Pick<Layer, 'din' | 'dinNotation'>): { code: string; nameEn: string; nameDe: string; patternId: string } | null {
  const parts = layerOverlays(l);
  if (parts.length !== 1) return null;
  const id = /^url\(#(.+)\)$/.exec(parts[0].fill)?.[1];
  const entry = Object.entries(SECONDARY).find(([, e]) => e.symbol_pattern_id === id);
  return entry && id ? { code: entry[0], nameEn: entry[1].name_en, nameDe: entry[1].name_de, patternId: id } : null;
}

/* ---------- Table 6: properties right of the column ---------- */

/** Scale of the Table 6 and Table 5 symbols in the profile (their files are drawn at ~4 px per profile px). */
export const PROP_K = 0.25;

interface PropertyEntry {
  group: string; key: string; name_de: string; name_en: string; svg: string;
  tile_width: number; tile_height: number; repeat_y: boolean; frame: number | null;
}

const PROPERTY_FILES = import.meta.glob('@din/properties/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const fileOf = (path: string) => {
  const hit = Object.entries(PROPERTY_FILES).find(([k]) => k.endsWith(`/${path}`));
  if (!hit) throw new Error(`missing DIN asset ${path}`);
  return hit[1];
};

interface Property extends PropertyEntry { id: string; symbol: SvgSymbol }

const PROPS = new Map<string, Property>(
  (properties as PropertyEntry[]).map((p) => {
    const id = `din-prop-${p.group}_${p.key}`;
    const symbol = parse(fileOf(p.svg));
    if (p.repeat_y) tilePattern(id, symbol, PROP_K);
    return [`${p.group}_${p.key}`, { ...p, id, symbol }] as const;
  }),
);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/** A DIN name without its grade note: "slightly weathered (grade 1)" → "slightly weathered". */
const withoutNote = (s: string) => norm(s.replace(/\(.*\)/, ''));

/** "stiff", "medium dense", "steif", "breiig" … → the consistency / density entry; exact terms only. */
function matchConsistency(text: string): Property | null {
  const t = norm(text);
  for (const p of PROPS.values()) {
    if (p.group !== 'consistency' && p.group !== 'density') continue;
    const names = [p.key.replace(/_/g, ' '), norm(p.name_en), ...p.name_de.split('/').map(norm)];
    if (names.includes(t)) return p;
  }
  return null;
}

/** "w1", "W2-3", "slightly weathered", "schwach verwittert" … → the weathering grade; exact terms only. */
function matchWeathering(text: string): Property | null {
  const t = norm(text);
  const grade = t.replace(/[\s–-]+/g, '_');
  const key = grade === 'w2' || grade === 'w3' ? 'w2_3' : grade;
  const byKey = PROPS.get(`weathering_${key}`);
  if (byKey) return byKey;
  for (const p of PROPS.values()) {
    if (p.group !== 'weathering') continue;
    if ([norm(p.name_en), withoutNote(p.name_en), norm(p.name_de), withoutNote(p.name_de)].includes(t)) return p;
  }
  return null;
}

/** "wet" / "nass": the wet mark (a moisture the source words otherwise draws nothing). */
function matchMoisture(text: string): Property | null {
  const t = norm(text);
  return t === 'wet' || t === 'nass' || t === norm(PROPS.get('moisture_wet')!.name_en) ? PROPS.get('moisture_wet')! : null;
}

/** One Table 6 symbol of a layer, in the order drawn left to right. */
export interface PropertySymbol {
  key: string;
  /** English DIN term, e.g. "stiff". */
  label: string;
  /** German DIN term, e.g. "halbfest". */
  labelDe: string;
  w: number; h: number;
  /** Repeating tile: fill a rect with url(#patternId) inside a group translated to the strip's top left. */
  patternId?: string;
  /** Single mark (wet): draw this markup once in a nested svg (viewBox w × h at scale 1). */
  markup?: string;
  /** Weathering: thickness of the top / bottom edge to draw at the layer boundaries. */
  frame?: number;
}

/** The Table 6 symbols of a layer: wet, consistency / density, weathering (jointing isn't in the record). */
export function propertySymbols(l: Pick<Layer, 'consistency' | 'weathering' | 'moisture'>): PropertySymbol[] {
  const entries = [
    l.moisture ? matchMoisture(l.moisture) : null,
    l.consistency ? matchConsistency(l.consistency) : null,
    l.weathering ? matchWeathering(l.weathering) : null,
  ];
  return entries
    .filter((e): e is Property => e != null)
    .map((e) => ({
      key: `${e.group}_${e.key}`,
      label: e.name_en,
      labelDe: e.name_de,
      w: e.tile_width * PROP_K,
      h: e.tile_height * PROP_K,
      ...(e.repeat_y ? { patternId: e.id } : { markup: e.symbol.inner }),
      ...(e.frame != null ? { frame: e.frame * PROP_K } : {}),
    }));
}

/* ---------- Table 5: groundwater, samples and cored sections left of the column ---------- */

/** Groundwater symbol per reading type (§5.8): struck ▽, rest after drilling half filled, standpipe ▼; another reading ▽. */
export const GW_SYMBOL: Record<GroundwaterType, SvgSymbol> = {
  strike: parse(gwStruck),
  rest: parse(gwAfter),
  standpipe: parse(gwRest),
  other: parse(gwStruck),
};

/** Sample symbol (Table 5): black box for a sample, open triangle for a water sample. */
export const SAMPLE_SYMBOL = { soil: parse(sampleSoil), water: parse(sampleWater) };

/** A water sample: the sampling code says W (DIN 4023 writes "W8" before the open triangle). */
export const isWaterSample = (s: Pick<Sample, 'typeCode'>) => /^w\d*$/i.test(s.typeCode?.trim() ?? '');

/** Cored section: the double line, repeated in y. */
export const CORED_PATTERN = 'din-cored';
const CORED_K = 0.2;
const coredSymbol = parse(cored);
tilePattern(CORED_PATTERN, coredSymbol, CORED_K);
export const CORED_W = coredSymbol.w * CORED_K;

/** `<pattern>`s beyond patterns.svg and symbols.svg (Table 6 tiles, the cored line), for DinPatternDefs. */
export const EXTRA_PATTERN_DEFS = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute"><defs>${[...EXTRA.values()].join('')}</defs></svg>`;
