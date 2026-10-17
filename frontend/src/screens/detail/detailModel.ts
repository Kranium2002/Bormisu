/**
 * Pure view model of the Borehole detail screen: what each metadata row, layer row and
 * groundwater row shows. One code path for every borehole (sample or API); displayed values always
 * come from the borehole's ExtractedValues, with the borehole's metadata only where no value exists.
 */
import { crsLabel, printedCoordinates, unplottedText } from '../../domain/format';
import { K } from '../../domain/keys';
import { progress } from '../../domain/review';
import { formatSpt, refusalTitle, sptDepthText } from '../../domain/spt';
import { displayStatus } from '../../domain/status';
import type { Borehole, DepthOrigin, ExtractedValue, GroundwaterReading, Layer, Lint, Method, Spt } from '../../domain/types';

/** Colour family of a small chip next to a value. */
export type ChipTone = 'red' | 'amber' | 'green' | 'grey';
export interface Chip { label: string; tone: ChipTone; title?: string }

/** A value as shown in a table cell. `missing` renders grey italics ("not in source", never 0). */
export interface Shown { text: string; missing: boolean }

const DASH = '–';
const valueOf = (b: Borehole, key: string) => b.values.find((v) => v.key === key);

/** True if a value has a lint that nobody approved yet. */
export const hasOpenLint = (v: ExtractedValue | undefined): v is ExtractedValue & { lint: Lint } =>
  !!v?.lint && v.status !== 'approved';

/** Display text of a value: "18.00 m", or its state ("not in source", "illegible") in grey italics. */
export function shown(v: ExtractedValue | undefined, missingText = 'not in source'): Shown {
  if (!v) return { text: missingText, missing: true };
  if (v.state !== 'ok') return { text: v.state, missing: true };
  if (!v.value) return { text: missingText, missing: true };
  return { text: v.unit ? `${v.value} ${v.unit}` : v.value, missing: false };
}

/** Plain cell text for numeric table columns (TCR, RQD): the value or a dash. */
function cell(v: ExtractedValue | undefined): string {
  return v && v.state === 'ok' && v.value ? v.value : DASH;
}

/** Chips every value can carry: an open lint (red error / amber warning) and a review flag. */
function reviewChips(v: ExtractedValue | undefined): Chip[] {
  const chips: Chip[] = [];
  if (hasOpenLint(v)) chips.push({ label: 'LINT', tone: v.lint.severity === 'error' ? 'red' : 'amber', title: v.lint.message });
  if (v?.status === 'flagged') chips.push({ label: 'FLAGGED', tone: 'amber', ...(v.flag ? { title: v.flag } : {}) });
  return chips;
}

/** CRS status chip: INFERRED (amber) until confirmed in review; STATED / CONFIRMED green; UNKNOWN red. */
export function crsChip(b: Borehole): Chip {
  switch (b.crs.status) {
    case 'inferred':
      return { label: 'INFERRED', tone: 'amber', title: 'Not printed in the source. Confirm it in review.' };
    case 'confirmed':
      return { label: 'CONFIRMED', tone: 'green' };
    case 'stated':
      return { label: 'STATED', tone: 'green' };
    default:
      return { label: 'UNKNOWN', tone: 'red', title: 'No usable coordinate system' };
  }
}

/* ---------- metadata ---------- */

/**
 * Source icon of a row: `open` opens the value's source, `dim` is faded (nothing printed to point
 * at), `none` shows no icon (the backend sent no provenance entry for the value).
 */
export type SourceLink = 'open' | 'dim' | 'none';

export interface MetaRow {
  label: string;
  /** Value key for the Source panel; null when there is no value to show the source of. */
  key: string | null;
  shown: Shown;
  chips: Chip[];
  method: Method | null;
  confidence?: number | null;
  formula?: string;
  /** Second line, e.g. the coordinates exactly as printed under the converted X / Y. */
  sub?: string;
  source: SourceLink;
}

function sourceLink(v: ExtractedValue | undefined): SourceLink {
  if (!v) return 'dim';
  if (!v.hasProvenance) return 'none';
  return v.state === 'not in source' || (v.page == null && !v.cell) ? 'dim' : 'open';
}

function metaRow(b: Borehole, label: string, key: string, extraChips: (v: ExtractedValue | undefined) => Chip[] = () => []): MetaRow {
  const v = valueOf(b, key);
  return {
    label,
    key: v ? key : null,
    shown: shown(v),
    chips: [...extraChips(v), ...reviewChips(v)],
    method: v?.method ?? null,
    confidence: v?.confidence,
    formula: v?.formula,
    source: sourceLink(v),
  };
}

/**
 * A row for a field many logs don't have: shown only when the value exists with text or a
 * provenance entry (a provenance entry in state "not in source" says the source was checked), or
 * when the borehole's metadata knows it (`fallback`, shown without a source icon).
 */
function optionalRow(b: Borehole, label: string, key: string, fallback: string | null = null): MetaRow | null {
  const v = valueOf(b, key);
  if (v && (v.value.trim() || v.hasProvenance || v.state !== 'ok')) return metaRow(b, label, key);
  if (fallback) return { label, key: null, shown: { text: fallback, missing: false }, chips: [], method: null, source: 'none' };
  return null;
}

/** Readable depth origins. */
export const DEPTH_ORIGIN_LABEL: Record<DepthOrigin, string> = {
  ground: 'ground level',
  mudline: 'mudline',
  seabed: 'seabed',
  relative: 'relative to a stated level',
};

/** Unit of a depth below the stated origin, e.g. "m bgl"; plain "m" when the source states no origin. */
const DEPTH_UNIT: Record<DepthOrigin, string> = {
  ground: 'm bgl',
  mudline: 'm below mudline',
  seabed: 'm below seabed',
  relative: 'm, relative to a stated level',
};

function depthUnit(origin: DepthOrigin | null): string {
  return origin ? DEPTH_UNIT[origin] : 'm';
}

/**
 * What the depths of a borehole are measured from, for the profile header: "depth in m bgl" only
 * when the source says ground level; no origin is assumed.
 */
export function depthOriginText(meta: Pick<Borehole['meta'], 'depthOrigin'>): string {
  return meta.depthOrigin ? `depth in ${DEPTH_UNIT[meta.depthOrigin]}` : 'depth in m, origin not stated';
}

/** The elevation datum: the reviewed value when stated, else the borehole metadata, else null. */
function elevationDatum(b: Borehole): string | null {
  const v = valueOf(b, K.elevationDatum);
  if (v && v.state === 'ok' && v.value.trim()) return v.value.trim();
  return b.meta.elevationDatum;
}

/**
 * The surface elevation row with its datum ("241.35 m · datum NHN"), or a chip when no datum is
 * stated. A unit that already names the datum ("m NHN", from the backend record) isn't repeated.
 */
function elevationRow(b: Borehole): MetaRow {
  const datum = elevationDatum(b);
  const v = valueOf(b, K.elevation);
  const row = metaRow(b, 'Surface elevation', K.elevation, (x) =>
    x && x.state === 'ok' && x.value && !datum ? [{ label: 'DATUM NOT STATED', tone: 'grey', title: 'The source names no height datum' }] : [],
  );
  const named = !!datum && !!v?.unit.trim().endsWith(datum);
  return datum && !named && !row.shown.missing ? { ...row, shown: { ...row.shown, text: `${row.shown.text} · datum ${datum}` } } : row;
}

/** The X / Y row; the coordinates as printed go underneath. */
function xyRow(b: Borehole): MetaRow {
  const printed = printedCoordinates(b.meta);
  const row = metaRow(b, 'X / Y', K.xy);
  return printed ? { ...row, sub: `as printed: ${printed}` } : row;
}

/**
 * The CRS row. Without a CRS value (nothing printed and no provenance entry), a CRS the server
 * holds anyway, e.g. one a reviewer confirmed, shows its EPSG code: no source icon, no method.
 */
function crsRow(b: Borehole): MetaRow {
  const row = metaRow(b, 'CRS', K.crs, () => [crsChip(b)]);
  if (row.key || !b.crs.code) return row;
  return { ...row, shown: { text: b.crs.code, missing: false }, method: null, source: 'none' };
}

/** The METADATA card rows: the prototype rows, plus every other field the source states. */
export function metadataRows(b: Borehole): MetaRow[] {
  const rock = valueOf(b, K.rockHead);
  const rockRow: MetaRow = rock
    ? metaRow(b, 'Rock head', K.rockHead)
    : // The backend states no rock head: unknown, not "not reached" (that would be an interpretation).
      { label: 'Rock head', key: null, shown: { text: 'not in source', missing: true }, chips: [], method: null, source: 'none' };
  const origin = b.meta.depthOrigin ? DEPTH_ORIGIN_LABEL[b.meta.depthOrigin] : null;
  const rows: (MetaRow | null)[] = [
    optionalRow(b, 'Borehole name', K.boreholeName),
    optionalRow(b, 'Location', K.locationName),
    optionalRow(b, 'Country', K.country),
    optionalRow(b, 'Project ID', K.projectId),
    optionalRow(b, 'Client', K.client),
    optionalRow(b, 'Contractor', K.contractor),
    metaRow(b, 'Final depth', K.finalDepth),
    optionalRow(b, 'Borehole length', K.boreholeLength),
    optionalRow(b, 'Inclination', K.inclination),
    rockRow,
    elevationRow(b),
    optionalRow(b, 'Depth origin', K.depthOrigin, origin),
    xyRow(b),
    crsRow(b),
    optionalRow(b, 'Drilling date', K.drillingDate),
    optionalRow(b, 'Start date', K.startDate),
    optionalRow(b, 'End date', K.endDate),
    optionalRow(b, 'Drilling method', K.method),
    optionalRow(b, 'Casing', K.casing),
    optionalRow(b, 'Remarks', K.notes),
  ];
  return rows.filter((r): r is MetaRow => r !== null);
}

/* ---------- header ---------- */

/**
 * Text next to the status chip: "7 of 30 values reviewed", or "all values reviewed". When every
 * value is approved but something is still open, it says what (open questions, an inferred CRS).
 */
export function reviewedText(b: Borehole): string {
  const p = progress(b);
  if (p.total === 0) return 'no reviewable values';
  if (p.approved < p.total) return `${p.approved} of ${p.total} values reviewed`;
  if (b.openClarifications > 0) {
    return `all values reviewed · ${b.openClarifications} open question${b.openClarifications === 1 ? '' : 's'}`;
  }
  if (displayStatus(b) === 'attention') return 'all values reviewed · needs attention';
  if (b.crs.status === 'inferred') return 'all values reviewed · CRS inferred, not stated';
  return 'all values reviewed';
}

/* ---------- location ---------- */

export interface LocationInfo { text: string; tone: 'muted' | 'amber' | 'red' }

/** Caption under the mini map: coordinates and which CRS they come from (the backend's label), or why there is no pin. */
export function locationInfo(b: Borehole): LocationInfo {
  if (b.lat == null || b.lng == null || !b.onMap) {
    const missing = !b.unplottedReason || b.unplottedReason === 'no_coordinates';
    return { text: `${unplottedText(b)}: not on the map`, tone: missing ? 'red' : 'amber' };
  }
  const at = `${b.lat.toFixed(4)}, ${b.lng.toFixed(4)}`;
  const { status } = b.crs;
  // The system as printed, else the server's code: a confirmed CRS often has only the code.
  const name = crsLabel(b.crs);
  if (status === 'inferred') return { text: `${at} · from inferred CRS${name ? ` ${name}` : ''}, confirm in review`, tone: 'amber' };
  if (status === 'unknown') return { text: `${at} · CRS unknown`, tone: 'red' };
  return { text: name ? `${at} · from ${name} (${status})` : `${at} · CRS ${status}`, tone: 'muted' };
}

/* ---------- layers ---------- */

export interface SptCell {
  key: string;
  text: string;
  refusal: boolean;
  /** Red text: the SPT has an open lint (e.g. increments don't add up to N). */
  lint: boolean;
  /** Tooltip: depth ("depth not stated" when the source has none) and, for a refusal, what was printed. */
  title: string;
}

export interface LayerRow {
  n: number;
  range: string;
  /** English lithology. */
  lithology: Shown;
  /** Hover text: the original description as printed. */
  printed: string;
  /** DIN 4023 notation (e.g. "U, t, s'"), else the main code, else a dash. */
  din: string;
  /** Stratigraphic name as text, or a dash. */
  strat: string;
  spt: SptCell | null;
  tcr: string;
  rqd: string;
  method: Method | null;
  confidence: number | null;
  /** Key of the layer's lithology value: the row's source icon opens it (null without a provenance entry). */
  sourceKey: string | null;
}

/** "at 10.50 m" or "depth not stated": a test outside the profile never gets an invented depth. */
function sptAt(spt: Spt): string {
  return spt.depth == null ? sptDepthText(spt) : `at ${sptDepthText(spt)}`;
}

function sptCell(l: Layer, v: ExtractedValue | undefined): SptCell | null {
  const spt = v?.spt ?? l.spt;
  if (!v && !spt) return null;
  const refusal = !!(v?.refusal ?? spt?.refusal);
  // A refusal shows what was printed ("50/30"), or what the reviewer entered, next to the R badge; never an N value.
  const printed = v?.method === 'Edited' ? v.value : v?.raw || spt?.raw;
  const text = v && v.state !== 'ok' ? v.state : refusal ? (printed || DASH) : (v?.value || (spt ? formatSpt(spt) : DASH));
  const where = spt ? `SPT ${sptAt(spt)}.` : 'SPT.';
  const title = [where, refusal && spt ? refusalTitle(spt) : '', 'Click for source.'].filter(Boolean).join(' ');
  return { key: v?.key ?? K.spt(l.n), text, refusal, lint: hasOpenLint(v), title };
}

/** Stratigraphic name of a layer: the reviewed value, else the layer's own, else a dash. */
function stratText(b: Borehole, l: Layer): string {
  const v = valueOf(b, K.strat(l.n));
  if (v) return v.state === 'ok' && v.value ? v.value : v.state === 'ok' ? DASH : v.state;
  return l.stratigraphicName || DASH;
}

/** The LAYERS table rows. */
export function layerRows(b: Borehole): LayerRow[] {
  return b.layers.map((l) => {
    const lith = valueOf(b, K.lithology(l.n));
    const printed = lith?.raw || l.lithologyAsPrinted;
    return {
      n: l.n,
      range: `${l.from.toFixed(2)}–${l.to.toFixed(2)}`,
      lithology: lith ? shown(lith) : { text: l.lithology || 'not in source', missing: !l.lithology },
      printed: printed ? `As printed: ${printed}` : '',
      din: l.dinNotation || l.din || lith?.din || DASH,
      strat: stratText(b, l),
      spt: sptCell(l, valueOf(b, K.spt(l.n))),
      tcr: cell(valueOf(b, K.tcr(l.n))),
      rqd: cell(valueOf(b, K.rqd(l.n))),
      method: lith?.method ?? l.method,
      confidence: lith?.confidence ?? l.confidence,
      sourceKey: lith?.hasProvenance ? lith.key : null,
    };
  });
}

/** Note under the layers table when the final depth carries an open lint, e.g. the log ends early. */
export function layerLint(b: Borehole): { text: string; severity: Lint['severity'] } | null {
  const fd = valueOf(b, K.finalDepth);
  if (!hasOpenLint(fd)) return null;
  const msg = fd.lint.message.replace(/\.\s*$/, '');
  if (b.finalDepth == null || b.logBottom >= b.finalDepth) return { text: `${msg}.`, severity: fd.lint.severity };
  // The log stops before the final depth: most likely a continuation sheet is missing.
  const sheets = new Set(b.values.filter((v) => v.group === 'layer' && v.page != null).map((v) => v.page)).size;
  const hint = sheets > 0 ? ` Possibly a missing sheet ${sheets + 1}.` : ' Possibly a missing log sheet.';
  return { text: `${msg}.${hint}`, severity: fd.lint.severity };
}

/* ---------- groundwater ---------- */

export interface GroundwaterRow {
  key: string;
  type: string;
  depth: Shown;
  raw: string;
  method: Method | null;
  confidence?: number | null;
  /** The reading has a provenance entry: its source icon opens it. */
  hasSource: boolean;
}

export const GW_LABEL: Record<GroundwaterReading['type'], string> = {
  strike: 'Strike', rest: 'Rest level', standpipe: 'Standpipe', other: 'Reading',
};

/**
 * Depth of a reading without a value: the depth below the stated origin, else what was printed (an
 * elevation, "dry"), never a made-up 0.
 */
function readingDepth(g: GroundwaterReading, origin: DepthOrigin | null): Shown {
  if (g.depth != null) return { text: `${g.depth.toFixed(2)} ${depthUnit(origin)}`, missing: false };
  if (g.elevation != null) return { text: `elevation ${g.elevation.toFixed(2)} m`, missing: false };
  return { text: 'depth not stated', missing: true };
}

/** The GROUNDWATER table rows, one per reading. */
export function groundwaterRows(b: Borehole): GroundwaterRow[] {
  return b.groundwater.map((g) => {
    const v = valueOf(b, g.key);
    const raw = v?.raw || g.raw;
    return {
      key: g.key,
      type: GW_LABEL[g.type],
      depth: v ? shown(v) : readingDepth(g, b.meta.depthOrigin),
      raw: raw ? `“${raw}”` : '',
      method: v?.method ?? null,
      confidence: v?.confidence,
      hasSource: !!v?.hasProvenance,
    };
  });
}

/* ---------- export ---------- */

/** Values an approved-only export leaves blank. */
export function unreviewedCount(scope: Borehole[]): number {
  return scope.reduce((n, b) => n + b.values.filter((v) => v.status !== 'approved').length, 0);
}

/**
 * Line under "Include unreviewed values" in the export menu. The export covers the whole document,
 * so with more than one borehole the line says how many, e.g. "272 unreviewed values in 13 boreholes excluded".
 */
export function excludedText(count: number, include: boolean, boreholes = 1): string {
  if (count === 0) return 'All values reviewed: nothing left out';
  const what = `${count} unreviewed value${count === 1 ? '' : 's'}${boreholes > 1 ? ` in ${boreholes} boreholes` : ''}`;
  return include ? `${what} included · file stamped DRAFT` : `${what} excluded`;
}
