/**
 * Pure view model of the Borehole detail screen: what each metadata row, layer row and
 * groundwater row shows. One code path for every borehole (hand-made, generated or from the API);
 * displayed values always come from the borehole's ExtractedValues.
 */
import { boreholeStatus, progress } from '../../domain/review';
import { K } from '../../domain/keys';
import { formatSpt, refusalTitle } from '../../domain/spt';
import type { Borehole, ExtractedValue, GroundwaterReading, Layer, Lint, Method } from '../../domain/types';

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

export interface MetaRow {
  label: string;
  /** Value key for the Source panel; null when there is no value to show the source of. */
  key: string | null;
  shown: Shown;
  chips: Chip[];
  method: Method | null;
  confidence?: number;
  formula?: string;
  /** The source icon is faded: nothing printed to point at. */
  dimSource: boolean;
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
    dimSource: !v || v.state === 'not in source' || v.page == null,
  };
}

/** The METADATA card rows, in prototype order. */
export function metadataRows(b: Borehole): MetaRow[] {
  const rock = valueOf(b, K.rockHead);
  const rockRow: MetaRow = rock
    ? metaRow(b, 'Rock head', K.rockHead)
    : // No rock layer in the log: rock head is derived as "not reached", nothing to point at.
      { label: 'Rock head', key: null, shown: { text: 'not reached', missing: true }, chips: [], method: 'Derived', dimSource: true };
  return [
    metaRow(b, 'Final depth', K.finalDepth),
    rockRow,
    metaRow(b, 'Surface elevation', K.elevation, (v) =>
      v && v.state === 'ok' ? [{ label: 'DATUM UNCONFIRMED', tone: 'grey', title: v.note ?? 'Height datum stored as printed' }] : [],
    ),
    metaRow(b, 'X / Y', K.xy),
    metaRow(b, 'CRS', K.crs, () => [crsChip(b)]),
    metaRow(b, 'Start date', K.startDate),
    metaRow(b, 'Drilling method', K.method),
    metaRow(b, 'Remarks', K.notes),
  ];
}

/* ---------- header ---------- */

/**
 * Text next to the status chip: "7 of 30 values reviewed", or "all values reviewed". When every
 * value is approved but the borehole still needs attention, it says why (CRS inferred / not usable).
 */
export function reviewedText(b: Borehole): string {
  const p = progress(b);
  if (p.total === 0) return 'no values extracted';
  if (p.approved < p.total) return `${p.approved} of ${p.total} values reviewed`;
  if (boreholeStatus(b) === 'attention' && b.crs.status === 'inferred') return 'all values reviewed · CRS inferred, not stated';
  return 'all values reviewed';
}

/* ---------- location ---------- */

export interface LocationInfo { text: string; tone: 'muted' | 'amber' | 'red' }

/** Compact CRS name for the one-line map caption: "ETRS89 / UTM 32N", "DHDN / GK zone 3". */
export function shortCrsName(name: string): string {
  return name.replace(/3-degree Gauss-Kr(?:ü|ue|u)ger/i, 'GK').replace(/\bUTM zone\s+/i, 'UTM ');
}

/** Caption under the mini map: coordinates and which CRS they come from, or why there is no pin. */
export function locationInfo(b: Borehole): LocationInfo {
  if (b.lat == null || b.lng == null || !b.onMap) {
    const reason = b.unplottedReason ?? 'No usable coordinates';
    return { text: `${reason}: not on the map`, tone: reason.startsWith('CRS') ? 'amber' : 'red' };
  }
  const at = `${b.lat.toFixed(4)}, ${b.lng.toFixed(4)}`;
  const { name, status } = b.crs;
  if (status === 'inferred') return { text: `${at} · from inferred CRS, confirm in review`, tone: 'amber' };
  if (status === 'unknown' || !name) return { text: `${at} · CRS unknown`, tone: 'red' };
  return { text: `${at} · from ${shortCrsName(name)} (${status})`, tone: 'muted' };
}

/* ---------- layers ---------- */

export interface SptCell {
  key: string;
  text: string;
  refusal: boolean;
  /** Red text: the SPT has an open lint (e.g. increments don't add up to N). */
  lint: boolean;
  /** Tooltip of the R badge. */
  title: string;
}

export interface LayerRow {
  n: number;
  range: string;
  lithology: Shown;
  printed: string;
  din: string;
  spt: SptCell | null;
  tcr: string;
  rqd: string;
  method: Method;
  confidence: number;
  /** Key of the layer's lithology value: the row's source icon opens it. */
  sourceKey: string | null;
}

function sptCell(l: Layer, v: ExtractedValue | undefined): SptCell | null {
  const spt = v?.spt ?? l.spt;
  if (!v && !spt) return null;
  const refusal = !!(v?.refusal ?? spt?.refusal);
  // A refusal shows what was printed ("50/30"), or what the reviewer entered, next to the R badge; never an N value.
  const printed = v?.method === 'Edited' ? v.value : v?.raw || spt?.raw;
  const text = v && v.state !== 'ok' ? v.state : refusal ? (printed || DASH) : (v?.value || (spt ? formatSpt(spt) : DASH));
  return {
    key: v?.key ?? K.spt(l.n),
    text,
    refusal,
    lint: hasOpenLint(v),
    title: refusal && spt ? `${refusalTitle(spt)} Click for source.` : 'Click for source',
  };
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
      din: l.din || lith?.din || DASH,
      spt: sptCell(l, valueOf(b, K.spt(l.n))),
      tcr: cell(valueOf(b, K.tcr(l.n))),
      rqd: cell(valueOf(b, K.rqd(l.n))),
      method: lith?.method ?? l.method,
      confidence: lith?.confidence ?? l.confidence,
      sourceKey: lith?.key ?? null,
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
  confidence?: number;
}

export const GW_LABEL: Record<GroundwaterReading['type'], string> = {
  strike: 'Strike', rest: 'Rest level', standpipe: 'Standpipe', other: 'Reading',
};

/** The GROUNDWATER table rows, one per reading. */
export function groundwaterRows(b: Borehole): GroundwaterRow[] {
  return b.groundwater.map((g) => {
    const v = valueOf(b, g.key);
    return {
      key: g.key,
      type: GW_LABEL[g.type],
      depth: v ? shown(v) : { text: `${g.depth.toFixed(2)} m bgl`, missing: false },
      raw: v?.raw ? `“${v.raw}”` : '',
      method: v?.method ?? null,
      confidence: v?.confidence,
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
