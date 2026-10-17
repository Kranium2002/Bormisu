import codes from '../../assets/din4023_patterns/din_codes.json';
import secondaryCodes from '../../assets/din4023_patterns/secondary_codes.json';
import properties from '../../assets/din4023_patterns/properties.json';
import sprite from '../../assets/din4023_patterns/patterns.svg?raw';
import symbolSprite from '../../assets/din4023_patterns/symbols.svg?raw';
import gwStruck from '../../assets/din4023_patterns/left_symbols/groundwater_struck.svg?raw';
import gwAfter from '../../assets/din4023_patterns/left_symbols/groundwater_after_drilling.svg?raw';
import gwRest from '../../assets/din4023_patterns/left_symbols/groundwater_rest.svg?raw';
import cored from '../../assets/din4023_patterns/left_symbols/sample_cored.svg?raw';
import type { GroundwaterType, Layer, LayerProps, PatternId } from '../../domain/types';
import { COL } from '../../theme';

/** DIN 4023 symbols, read from src/assets/din4023_patterns. */
type DinCode = keyof typeof codes;
type SecondaryCode = keyof typeof secondaryCodes;

const PROPERTY_FILES = import.meta.glob('../../assets/din4023_patterns/properties/*.svg', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/** `<pattern>` markup per pattern id, cut out of the sprites so each profile embeds only what it draws. */
const PATTERNS = new Map(
  [...(sprite + symbolSprite).matchAll(/<pattern id="([^"]+)"[\s\S]*?<\/pattern>/g)].map((m) => [m[1], m[0]] as const),
);

/** A DIN code with no pattern file: solid red, so the missing visualization stands out. */
export const MISSING_PATTERN = 'din-missing';
PATTERNS.set(
  MISSING_PATTERN,
  `<pattern id="${MISSING_PATTERN}" patternUnits="userSpaceOnUse" width="10" height="10"><rect width="10" height="10" fill="${COL.red}"/></pattern>`,
);

/** A symbol file split into its size and inner markup, so it can be scaled into a pattern or a nested svg. */
interface SvgSymbol { w: number; h: number; inner: string }
function parse(svg: string): SvgSymbol {
  const m = /<svg[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*>([\s\S]*)<\/svg>/.exec(svg);
  if (!m) throw new Error('not an svg file');
  return { w: Number(m[1]), h: Number(m[2]), inner: m[3] };
}

/** A tile repeated from the origin of the element that uses it (draw it inside a translated group). */
function tilePattern(id: string, s: SvgSymbol, k: number) {
  PATTERNS.set(id, `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${s.w * k}" height="${s.h * k}" ` +
    `viewBox="0 0 ${s.w} ${s.h}">${s.inner}</pattern>`);
}

/* ---------- lithology fill (Tables 1–4) ---------- */

/** Layers without a DIN code get the hatching guessed from their lithology. */
const FROM_GUESS: Record<PatternId, DinCode> = {
  topsoil: 'Mu', fill: 'A', clay: 'T', silt: 'U', gravel: 'G', sst: 'Sst', sand: 'S', lst: 'Kst', marl: 'Mg',
};

/** One rectangle of the layer fill: from x0 to x1 (fractions of the column width). */
export interface FillPart { x0: number; x1: number; fill: string; patternId?: string }

const isCode = (c: string): c is DinCode => Object.hasOwn(codes, c);
/** "fs'" (slightly), "fs̄" / "fs*" (strongly) are text only: drawn like "fs". */
const bare = (c: string) => c.replace(/['’*̄]/g, '');

/**
 * How the layer's lithology column is filled (DIN 4023 §4.2): main component tile over the full width,
 * the first secondary component's symbol over the right half ("U, s"); two equal parts ("S/G"): each colour
 * on one half, both symbols over the full width. Unknown code → red (MISSING_PATTERN); no code → the
 * lithology guess, or nothing (plain #E0E0E0) when the source names nothing.
 */
export function layerFill(l: Pick<Layer, 'din' | 'lithology' | 'pattern'>): FillPart[] {
  const [main, ...rest] = l.din.split(',').map((t) => bare(t.trim()));
  const tile = (c: DinCode, x0 = 0, x1 = 1): FillPart => ({ x0, x1, fill: `url(#${codes[c].pattern_id})`, patternId: codes[c].pattern_id });
  const sym = (id: string, x0: number): FillPart => ({ x0, x1: 1, fill: `url(#${id})`, patternId: id });
  if (!main) return l.lithology ? [tile(FROM_GUESS[l.pattern])] : [];
  const halves = main.split('/');
  if (halves.length === 2 && halves.every(isCode)) {
    const [a, b] = halves as DinCode[];
    return [
      { x0: 0, x1: 0.5, fill: codes[a].colour ?? '#fff' }, { x0: 0.5, x1: 1, fill: codes[b].colour ?? '#fff' },
      sym(codes[a].symbol_pattern_id, 0), sym(codes[b].symbol_pattern_id, 0),
    ];
  }
  if (!isCode(main)) return [{ x0: 0, x1: 1, fill: `url(#${MISSING_PATTERN})`, patternId: MISSING_PATTERN }];
  const second = rest[0]?.toLowerCase();
  const sec = second && Object.hasOwn(secondaryCodes, second) ? secondaryCodes[second as SecondaryCode] : null;
  return sec ? [tile(main), sym(sec.symbol_pattern_id, 0.5)] : [tile(main)];
}

/** The `<pattern>` definitions for these ids, as markup for a `<defs>`. */
export const patternDefs = (ids: Iterable<string | null | undefined>) =>
  [...new Set(ids)].map((id) => (id && PATTERNS.get(id)) ?? '').join('');

/* ---------- Table 6: properties right of the column ---------- */

/** Scale of the Table 6 symbols in the profile (their files are drawn at ~8 px per pt). */
export const PROP_K = 0.25;

interface PropertyEntry { group: string; key: string; name_de: string; name_en: string; svg: string; tile_width: number; tile_height: number; repeat_y: boolean; frame: number | null }
const PROPS = new Map((properties as PropertyEntry[]).map((p) => {
  const file = PROPERTY_FILES[`../../assets/din4023_patterns/${p.svg}`];
  const id = `din-prop-${p.group}_${p.key}`;
  const s = parse(file);
  if (p.repeat_y) tilePattern(id, s, PROP_K);
  return [`${p.group}_${p.key}`, { ...p, id, symbol: s }] as const;
}));

/** "steif", "Stiff", "medium dense", "breiig" … → the consistency / density entry (never a guess). */
function matchConsistency(text: string) {
  const t = text.trim().toLowerCase();
  for (const p of PROPS.values()) {
    if (p.group !== 'consistency' && p.group !== 'density') continue;
    const names = [p.key.replace(/_/g, ' '), p.name_en.toLowerCase(), ...p.name_de.toLowerCase().split('/')];
    if (names.includes(t)) return p;
  }
  return null;
}

/** One Table 6 symbol of a layer, in the order drawn left to right. */
export interface PropertySymbol {
  key: string; label: string; w: number; h: number;
  /** Repeating tile: fill a rect with url(#patternId) inside a group translated to the strip's top left. */
  patternId?: string;
  /** Single mark (wet) or nothing to repeat: draw this markup once in a nested svg (viewBox w × h at scale 1). */
  markup?: string;
  /** Weathering: thickness of the top / bottom edge to draw at the layer boundaries. */
  frame?: number;
}

export function propertySymbols(p: LayerProps | undefined): PropertySymbol[] {
  if (!p) return [];
  const entries = [
    p.wet ? PROPS.get('moisture_wet') : null,
    p.consistencyDensity ? matchConsistency(p.consistencyDensity) : null,
    p.weathering ? PROPS.get(`weathering_${p.weathering}`) : null,
    p.jointing ? PROPS.get(`jointing_${p.jointing}`) : null,
  ];
  return entries.filter((e) => e != null).map((e) => ({
    key: `${e.group}_${e.key}`, label: e.name_en, w: e.tile_width * PROP_K, h: e.tile_height * PROP_K,
    ...(e.repeat_y ? { patternId: e.id } : { markup: e.symbol.inner }),
    ...(e.frame != null ? { frame: e.frame * PROP_K } : {}),
  }));
}

/* ---------- Table 5: groundwater and cored sections left of the column ---------- */

/** Groundwater symbol per reading type (DIN 4023 §5.8): struck ▽, rest after drilling half-filled, standpipe ▼. */
export const GW_SYMBOL: Record<GroundwaterType, SvgSymbol> = {
  strike: parse(gwStruck), rest: parse(gwAfter), standpipe: parse(gwRest), other: parse(gwStruck),
};

/** Cored section: the double line, repeated in y. */
export const CORED_PATTERN = 'din-cored';
export const CORED_K = 0.2;
const coredSymbol = parse(cored);
tilePattern(CORED_PATTERN, coredSymbol, CORED_K);
export const CORED_W = coredSymbol.w * CORED_K;

/* ---------- explanations (shown when a symbol is clicked) ---------- */

const TILE_LABEL = new Map(Object.entries(codes).map(([c, v]) => [v.pattern_id, `${c} · ${v.name_en.toLowerCase()}`]));
const SYMBOL_LABEL = new Map(Object.entries(codes).map(([c, v]) => [v.symbol_pattern_id, `${c} · ${v.name_en.toLowerCase()}`]));
const SECONDARY_LABEL = new Map(Object.entries(secondaryCodes).map(([c, v]) => [v.symbol_pattern_id, `${c} · ${v.name_en}`]));

/** What the lithology fill of a layer shows, in one line (DIN 4023 §4.2). */
export function explainLayer(l: Pick<Layer, 'din' | 'lithology' | 'pattern'>): string {
  const parts = layerFill(l).filter((f) => f.patternId);
  if (!parts.length) return 'No lithology in the source: plain grey.';
  if (parts[0].patternId === MISSING_PATTERN) return `No DIN 4023 pattern for "${l.din}": drawn red.`;
  const text = parts.map((f) => (f.x0 === 0.5
    ? `${SECONDARY_LABEL.get(f.patternId!)}, symbol in the right half`
    : TILE_LABEL.get(f.patternId!) ?? SYMBOL_LABEL.get(f.patternId!))).join('; ');
  return l.din.trim() ? text : `${text} (guessed from the description, no DIN code in the source)`;
}

/** What a Table 6 symbol means: "consistency: firm". */
export const explainProperty = (p: PropertySymbol) => `${p.key.split('_')[0]}: ${p.label} (DIN 4023 Table 6)`;
