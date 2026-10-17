/**
 * Pure view helpers of the Review screen (prototype `rows`, `scanBoxes`, `scanCaption`, CRS note).
 * No React, no store: unit-tested in reviewView.test.ts.
 */
import type { ScanBox, ScanBoxVariant } from '../../components/ScanPage';
import { K } from '../../domain/keys';
import { PAGE_W, type Borehole, type Box, type CrsCandidate, type ExtractedValue } from '../../domain/types';

/** DOM id of the scan pane, the panel the sheet tabs control (aria-controls). */
export const SCAN_PANE_ID = 'review-scan';

/** One line of the field list: a group heading or a value. */
export type ReviewRow =
  | { kind: 'head'; id: string; title: string }
  | { kind: 'field'; value: ExtractedValue };

const GROUP_RANK: Record<ExtractedValue['group'], number> = { borehole: 0, groundwater: 1, layer: 2 };

/** Values in list order: borehole, groundwater, then layers by number. Stable within a group. */
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

/** Heading of a layer group: "LAYER 5 · 8.20–11.20 m · p.8" (units and page refs stay lowercase). */
export function layerTitle(b: Borehole, n: number): string {
  const l = b.layers.find((x) => x.n === n);
  const page = b.values.find((v) => v.layer === n && v.page != null)?.page;
  const range = l ? ` · ${l.from.toFixed(2)}–${l.to.toFixed(2)} m` : '';
  return `LAYER ${n}${range}${page ? ` · p.${page}` : ''}`;
}

/** Field list rows with BOREHOLE / GROUNDWATER / LAYER n headings (prototype `rows`). */
export function reviewRows(b: Borehole): ReviewRow[] {
  const rows: ReviewRow[] = [];
  let last = '';
  for (const v of orderedValues(b)) {
    const group = v.group === 'layer' ? `layer:${v.layer ?? 0}` : v.group;
    if (group !== last) {
      last = group;
      const title =
        v.group === 'borehole' ? 'BOREHOLE' : v.group === 'groundwater' ? 'GROUNDWATER' : layerTitle(b, v.layer ?? 0);
      rows.push({ kind: 'head', id: `head:${group}`, title });
    }
    rows.push({ kind: 'field', value: v });
  }
  return rows;
}

/** Keys of the field rows in list order (keyboard J / K). */
export function rowKeys(rows: ReviewRow[]): string[] {
  return rows.flatMap((r) => (r.kind === 'field' ? [r.value.key] : []));
}

/** Pages that hold this borehole's values, ascending: one sheet tab each. */
export function sheetPages(b: Borehole): number[] {
  const pages = new Set<number>();
  for (const v of b.values) if (v.page != null) pages.add(v.page);
  if (!pages.size && b.documentId) pages.add(b.primaryPage);
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
 * Value boxes on one page. When several values share a box (the CRS guessed from the X / Y line,
 * the rock head derived from a lithology), only the first printed one is drawn, plus the focused
 * one while it is focused. The focused box is drawn last, so it is on top.
 */
export function scanBoxes(
  b: Borehole,
  page: number,
  focusKey: string | null,
  onClick: (key: string) => void,
): ScanBox[] {
  const groups = new Map<string, ExtractedValue[]>();
  for (const v of orderedValues(b)) {
    if (v.page !== page || !v.box) continue;
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

/** Smallest and largest scale of the scan page in the Review pane. */
export const SCAN_SCALE = { min: 0.95, max: 1.45 } as const;

/**
 * Scale of the scan page in a pane `paneWidth` px wide (its clientWidth): the page fills the pane
 * less 50 px each side, within SCAN_SCALE. Rounded, so a 1 px resize doesn't re-render the page.
 */
export function scanScale(paneWidth: number): number {
  const fit = (paneWidth - 100) / PAGE_W;
  const s = Math.min(SCAN_SCALE.max, Math.max(SCAN_SCALE.min, fit));
  return Math.round(s * 1000) / 1000;
}

export interface Caption { text: string; tone: 'normal' | 'warn' }

/** Caption above the scan: page and sheet, or "box not found, page shown" for a focused value without a box. */
export function scanCaption(page: number, sheets: number[], focused: ExtractedValue | undefined): Caption {
  if (focused && !focused.box && focused.state === 'ok') {
    return { text: `${focused.label}: box not found, page shown`, tone: 'warn' };
  }
  const i = sheets.indexOf(page);
  const sheet = i >= 0 ? ` · sheet ${i + 1} of ${sheets.length}` : '';
  return { text: `page ${page}${sheet} · click a box to jump to its field`, tone: 'normal' };
}

/** "p.7", "p.7 · no box" or "" (prototype pageTxt). */
export function pageText(v: ExtractedValue): string {
  if (v.page == null) return '';
  return v.box ? `p.${v.page}` : `p.${v.page} · no box`;
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

/** True if the X / Y value starts with a 7-digit easting (a Gauss-Krüger Rechtswert with zone prefix). */
export function hasSevenDigitEasting(b: Borehole): boolean {
  const xy = b.values.find((v) => v.key === K.xy);
  return !!xy && /^\d{7}(\D|$)/.test(xy.value.replace(/\s+/g, ''));
}

/** Note under a value. The CRS row explains where the CRS came from (prototype CRS note). */
export function fieldNote(b: Borehole, v: ExtractedValue): Note | null {
  if (v.kind === 'crs') {
    if (b.crs.status === 'confirmed') return { text: 'confirmed for whole document by you', tone: 'ok' };
    if (b.crs.status === 'inferred') {
      const from = hasSevenDigitEasting(b) ? '7-digit Rechtswert' : 'the coordinate format';
      return { text: `not stated in source · inferred from ${from}`, tone: 'warn' };
    }
    if (b.crs.status === 'unknown') {
      return { text: v.note || 'local grid: no transformation known, so this borehole is not on the map', tone: 'warn' };
    }
  }
  return v.note ? { text: v.note, tone: 'faint' } : null;
}

/** Hover text of an SPT value: its increments and how N is formed. */
export function sptTitle(v: ExtractedValue): string | undefined {
  const inc = v.spt?.increments;
  if (!v.spt || v.spt.refusal || !inc || inc.length < 3) return undefined;
  return `Increments ${inc.join(' · ')}: N = ${inc[1]} + ${inc[2]} (2nd + 3rd)`;
}

/** Intro sentence of the CRS dialog, from the printed X / Y and the number of placed boreholes. */
export function crsIntro(b: Borehole | undefined, candidates: CrsCandidate[]): string {
  const xy = b?.values.find((v) => v.key === K.xy);
  const crsValue = b?.values.find((v) => v.key === K.crs);
  const n =
    candidates.find((c) => c.verdict === 'match')?.points.length ??
    Math.max(0, ...candidates.map((c) => c.points.length));
  const places = `Each candidate places the ${n} borehole${n === 1 ? '' : 's'} of this report differently.`;
  if (!xy?.raw) return `The source prints no coordinates for this borehole. ${places}`;
  const statedRaw = b?.crs.status === 'stated' ? crsValue?.raw : '';
  return `Source prints “${xy.raw}” ${statedRaw ? `with CRS “${statedRaw}”` : 'with no CRS'}. ${places}`;
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

export interface EmptyReview {
  message: string;
  action: { label: string; screen: 'queue' | 'map' };
}

/**
 * What Review says when it has no borehole to show. Boreholes without source pages (the backend
 * has no page images for them yet) can't be checked here; without any boreholes, upload one.
 */
export function emptyReview(hasBoreholes: boolean, anyReviewable: boolean): EmptyReview {
  if (hasBoreholes && !anyReviewable) {
    return {
      message: 'These boreholes have no source pages from the backend yet, so there is nothing to check them against.',
      action: { label: 'OPEN MAP ›', screen: 'map' },
    };
  }
  return {
    message: 'No report is ready for review yet. Upload one and wait until it reaches “needs review”.',
    action: { label: 'OPEN UPLOAD & QUEUE ›', screen: 'queue' },
  };
}

/** Boreholes of the same document that can be reviewed, in natural ID order (borehole switcher). */
export function siblings(all: Borehole[], b: Borehole): Borehole[] {
  if (!b.documentId) return [b];
  return all
    .filter((x) => x.documentId === b.documentId && x.values.some((v) => v.page != null))
    .sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }));
}
