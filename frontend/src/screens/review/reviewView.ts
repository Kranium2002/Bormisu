/**
 * Pure view helpers of the Review screen (prototype `rows`, `scanBoxes`, `scanCaption`, CRS note).
 * No React, no store: unit-tested in reviewView.test.ts.
 */
import type { ScanBox, ScanBoxVariant } from '../../components/ScanPage';
import { crsLabel, printedCoordinates } from '../../domain/format';
import { K } from '../../domain/keys';
import { fromOtherDocument } from '../../domain/review';
import { sptDepthText } from '../../domain/spt';
import type { Borehole, Box, CrsCandidate, CrsVerdict, ExtractedValue, Reading } from '../../domain/types';

/** One line of the field list: a group heading or a value. */
export type ReviewRow =
  | { kind: 'head'; id: string; title: string }
  | { kind: 'field'; value: ExtractedValue };

const GROUP_RANK: Record<ExtractedValue['group'], number> = { borehole: 0, groundwater: 1, layer: 2, sample: 3, test: 4 };
const GROUP_TITLE = { borehole: 'BOREHOLE', groundwater: 'GROUNDWATER', sample: 'SAMPLES', test: 'TEST RESULTS' } as const;

/** Values in list order: borehole, groundwater, layers by number, samples, test results. Stable within a group. */
export function orderedValues(b: Borehole): ExtractedValue[] {
  return b.values
    .map((v, i) => ({ v, i }))
    .sort(
      (a, c) =>
        GROUP_RANK[a.v.group] - GROUP_RANK[c.v.group] ||
        (a.v.layer ?? 0) - (c.v.layer ?? 0) ||
        a.i - c.i,
    )
    .map((x) => x.v);
}

/** Heading of a layer group: "LAYER 5 · 8.20–11.20 M · P.8" (a page of the borehole's own document). */
export function layerTitle(b: Borehole, n: number): string {
  const l = b.layers.find((x) => x.n === n);
  const page = b.values.find((v) => v.layer === n && v.page != null && !fromOtherDocument(b, v))?.page;
  const range = l ? ` · ${l.from.toFixed(2)}–${l.to.toFixed(2)} M` : '';
  return `LAYER ${n}${range}${page ? ` · P.${page}` : ''}`;
}

/** Field list rows with BOREHOLE / GROUNDWATER / LAYER n / SAMPLES / TEST RESULTS headings (prototype `rows`). */
export function reviewRows(b: Borehole): ReviewRow[] {
  const rows: ReviewRow[] = [];
  let last = '';
  for (const v of orderedValues(b)) {
    const group = v.group === 'layer' ? `layer:${v.layer ?? 0}` : v.group;
    if (group !== last) {
      last = group;
      const title = v.group === 'layer' ? layerTitle(b, v.layer ?? 0) : GROUP_TITLE[v.group];
      rows.push({ kind: 'head', id: `head:${group}`, title });
    }
    rows.push({ kind: 'field', value: v });
  }
  return rows;
}

/**
 * The row that offers CHOOSE CRS…: the CRS value, else the X / Y value. A log that prints no
 * coordinate system has no CRS value at all, and that is exactly the borehole whose system must be
 * chosen. Null without coordinates.
 */
export function crsActionKey(b: Borehole): string | null {
  const crs = b.values.find((v) => v.kind === 'crs');
  if (crs) return crs.key;
  return b.values.some((v) => v.key === K.xy) ? K.xy : null;
}

/** Keys of the field rows in list order (keyboard J / K). */
export function rowKeys(rows: ReviewRow[]): string[] {
  return rows.flatMap((r) => (r.kind === 'field' ? [r.value.key] : []));
}

/**
 * Pages of the borehole's own document that hold its values, ascending: one sheet tab each. Without
 * any, its first page; a borehole without pages (e.g. a spreadsheet) has no tab, never a made-up page 1.
 */
export function sheetPages(b: Borehole): number[] {
  const pages = new Set<number>();
  for (const v of b.values) if (v.page != null && !fromOtherDocument(b, v)) pages.add(v.page);
  if (!pages.size && b.documentId && b.primaryPage != null && !b.values.some((v) => v.cell)) pages.add(b.primaryPage);
  return [...pages].sort((x, y) => x - y);
}

/** How a value's box is drawn on the scan (prototype border rules). */
export function boxVariant(v: ExtractedValue, focused: boolean): ScanBoxVariant {
  if (focused) return 'focus';
  if (v.status === 'flagged') return 'flagged';
  if (v.lint && v.status !== 'approved') return 'lint';
  if (v.status === 'approved') return 'approved';
  return 'idle';
}

/** Hover title of a box. Generic labels ("Bottom depth") get their layer so they are unambiguous. */
export function boxTitle(v: ExtractedValue): string {
  return v.layer != null && !/layer/i.test(v.label) ? `Layer ${v.layer} · ${v.label}` : v.label;
}

const boxId = (b: Box) => `${b.x.toFixed(4)},${b.y.toFixed(4)},${b.w.toFixed(4)},${b.h.toFixed(4)}`;

/** A value read off the page, as opposed to one derived or guessed from it. */
const isPrinted = (v: ExtractedValue) => v.method !== 'Derived' && v.method !== 'Guessed';

/**
 * Value boxes on one page of the borehole's own document (values from another document are never
 * drawn here). When several values share a box (the CRS guessed from the X / Y line, the rock head
 * derived from a lithology), only the first printed one is drawn, plus the focused one while it is
 * focused. The focused box is drawn last, so it is on top.
 */
export function scanBoxes(
  b: Borehole,
  page: number | null,
  focusKey: string | null,
  onClick: (key: string) => void,
): ScanBox[] {
  const groups = new Map<string, ExtractedValue[]>();
  if (page == null) return [];
  for (const v of orderedValues(b)) {
    if (v.page !== page || !v.box || fromOtherDocument(b, v)) continue;
    const id = boxId(v.box);
    groups.set(id, [...(groups.get(id) ?? []), v]);
  }
  const boxes: ScanBox[] = [];
  for (const group of groups.values()) {
    const primary = group.find(isPrinted) ?? group[0];
    for (const v of group) {
      const focused = v.key === focusKey;
      if (v !== primary && !focused) continue;
      if (!v.box) continue;
      boxes.push({ id: v.key, box: v.box, variant: boxVariant(v, focused), title: boxTitle(v), onClick: () => onClick(v.key) });
    }
  }
  return boxes.sort((x, y) => Number(x.variant === 'focus') - Number(y.variant === 'focus'));
}

export interface Caption { text: string; tone: 'normal' | 'warn' }

/** Why a value with a source entry has no page: guessed or derived values are not printed. */
export function noPageText(v: Pick<ExtractedValue, 'method'>): string {
  if (v.method === 'Guessed' || v.method === 'Derived') return `${v.method.toLowerCase()}, not printed on a page`;
  return 'no page reference from the backend';
}

/**
 * Caption under the scan: page and sheet; "box not found, page shown" for a focused value without a
 * box; the cell for a spreadsheet value; "no source reference" for a value without provenance; where
 * a value from another document is (`elsewhere`); "no source page" for a borehole without pages.
 */
export function scanCaption(page: number | null, sheets: number[], focused: ExtractedValue | undefined, elsewhere = false): Caption {
  if (focused && !focused.hasProvenance) {
    return { text: `${focused.label}: no source reference from the backend`, tone: 'warn' };
  }
  if (focused && elsewhere) {
    const where = focused.cell ? `spreadsheet cell ${focused.cell} in` : focused.page != null ? `page ${focused.page} of` : 'source in';
    return { text: `${focused.label}: ${where} another document · Larger source view shows it`, tone: 'normal' };
  }
  if (focused?.cell) return { text: `${focused.label}: spreadsheet cell ${focused.cell}, no page image`, tone: 'normal' };
  // A value whose source entry names no page: the page shown is not its source.
  if (focused && focused.page == null && focused.state === 'ok') return { text: `${focused.label}: ${noPageText(focused)}`, tone: 'warn' };
  if (page == null) return { text: 'no source page for this borehole', tone: 'normal' };
  if (focused && !focused.box && focused.state === 'ok') {
    return { text: `${focused.label}: box not found, page shown`, tone: 'warn' };
  }
  const i = sheets.indexOf(page);
  const sheet = i >= 0 ? ` · sheet ${i + 1} of ${sheets.length}` : '';
  return { text: `page ${page}${sheet} · click a box to jump to its field`, tone: 'normal' };
}

/**
 * "p.7", "p.7 · no box", the spreadsheet cell ("Logdata!C5"), "no source reference" or "" (prototype
 * pageTxt). A value from another document (`elsewhere`) says so: its page is not one of this report's.
 */
export function pageText(v: ExtractedValue, elsewhere = false): string {
  if (!v.hasProvenance) return 'no source reference';
  const where = v.cell ? v.cell : v.page == null ? '' : v.box || elsewhere ? `p.${v.page}` : `p.${v.page} · no box`;
  return elsewhere ? [where, 'other document'].filter(Boolean).join(' · ') : where;
}

/** Raw text as printed, in quotes, or an em dash. */
export function rawText(v: ExtractedValue): string {
  return v.raw ? `“${v.raw}”` : '—';
}

/** Normalised value with unit; a confirmed CRS gets "(confirmed)". */
export function normalisedText(b: Borehole, v: ExtractedValue): string {
  if (v.kind === 'crs' && b.crs.status === 'confirmed') return `${v.value} (confirmed)`;
  if (!v.value) return '—';
  return v.unit ? `${v.value} ${v.unit}` : v.value;
}

export interface Note { text: string; tone: 'faint' | 'ok' | 'warn' }

/**
 * Note under a value. The CRS row says where the CRS came from (the backend's own note when it sent
 * one); the X / Y row shows the coordinates exactly as printed next to the converted values.
 */
export function fieldNote(b: Borehole, v: ExtractedValue): Note | null {
  if (v.kind === 'crs') {
    if (b.crs.status === 'confirmed') return { text: 'confirmed for the whole document', tone: 'ok' };
    if (b.crs.status === 'inferred') {
      return { text: `not stated in source · inferred${v.note ? `: ${v.note}` : ', confirm it for the document'}`, tone: 'warn' };
    }
    if (b.crs.status === 'unknown') {
      return { text: v.note || 'not known, so this borehole is not on the map', tone: 'warn' };
    }
  }
  if (v.key === K.xy) {
    const printed = printedCoordinates(b.meta);
    // Without a CRS row the X / Y row offers CHOOSE CRS…, so it names the CRS the server has (FE-CRS-1/2).
    const crs = b.values.some((x) => x.kind === 'crs') ? '' : xyCrsText(b);
    const text = [printed ? `as printed: ${printed}` : '', crs, v.note ?? ''].filter(Boolean).join(' · ');
    const tone = crs && b.crs.status !== 'confirmed' ? 'warn' : 'faint';
    return text ? { text, tone } : null;
  }
  return v.note ? { text: v.note, tone: 'faint' } : null;
}

/**
 * The CRS on the X / Y row of a borehole without a CRS row (the source prints no system): a confirmed
 * one by its name or code, else what is missing. Nothing for a stated CRS.
 */
function xyCrsText(b: Borehole): string {
  const name = crsLabel(b.crs);
  if (b.crs.status === 'confirmed') return name ? `CRS ${name}, confirmed for the whole document` : 'CRS confirmed for the whole document';
  if (b.crs.status === 'inferred') return `CRS not stated in source${name ? ` · inferred ${name}` : ''}, confirm it for the document`;
  if (b.crs.status === 'unknown') return 'CRS not known, so this borehole is not on the map';
  return '';
}

/** Hover text of an SPT value: its depth ("depth not stated" when the source has none) and how N is formed. */
export function sptTitle(v: ExtractedValue): string | undefined {
  if (!v.spt) return undefined;
  const depth = v.spt.depth == null ? sptDepthText(v.spt) : `at ${sptDepthText(v.spt)}`;
  const inc = v.spt.increments;
  if (v.spt.refusal || !inc || inc.length < 3) return `SPT ${depth}`;
  return `SPT ${depth} · increments ${inc.join(' · ')}: N = ${inc[1]} + ${inc[2]} (2nd + 3rd)`;
}

/** One reading of a value in the side-by-side list: "reader: “text” · 82 %". */
export function readingText(r: Reading): string {
  return `${r.reader}: “${r.text}”${r.confidence != null ? ` · ${Math.round(r.confidence * 100)} %` : ''}`;
}

/** Intro sentence of the CRS dialog, from the printed X / Y and the number of placed boreholes. */
export function crsIntro(b: Borehole | undefined, candidates: CrsCandidate[]): string {
  const xy = b?.values.find((v) => v.key === K.xy);
  const crsValue = b?.values.find((v) => v.key === K.crs);
  const printed = (b && printedCoordinates(b.meta)) || xy?.raw;
  const n =
    candidates.find((c) => c.verdict === 'match')?.points.length ??
    Math.max(0, ...candidates.map((c) => c.points.length));
  const places = `Each candidate places the ${n} borehole${n === 1 ? '' : 's'} of this report differently.`;
  if (!printed) return `The source prints no coordinates for this borehole. ${places}`;
  const statedRaw = b?.crs.status === 'stated' ? crsValue?.raw : '';
  return `Source prints “${printed}” ${statedRaw ? `with CRS “${statedRaw}”` : 'with no CRS'}. ${places}`;
}

/** Short text of a candidate's verdict (the backend's own note is shown next to it). */
export const VERDICT_LABEL: Record<CrsVerdict, string> = {
  match: 'pins on site',
  shifted: 'shifted from the site',
  out_of_range: 'out of range',
};

/** Score of a candidate as text, e.g. "score 0.92"; '' when the backend sent none. */
export function scoreText(c: CrsCandidate): string {
  return c.score == null ? '' : `score ${c.score.toFixed(2)}`;
}

/** Centre of the "site per report text" circle: the centroid of the matching candidate's points. */
export function siteCentre(candidates: CrsCandidate[]): { lat: number; lng: number } | null {
  const pts = candidates.find((c) => c.verdict === 'match')?.points ?? [];
  if (!pts.length) return null;
  return {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
  };
}

/** Boreholes of the same document that can be reviewed, in natural ID order (borehole switcher). */
export function siblings(all: Borehole[], b: Borehole): Borehole[] {
  if (!b.documentId) return [b];
  return all
    .filter((x) => x.documentId === b.documentId && x.values.some((v) => v.page != null || v.cell != null))
    .sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }));
}
