/**
 * View model of the side-by-side verification screen (/verify/:uid?page=n): which pages carry a
 * borehole's values, what each value draws on the "extracted page" (its normalised text at its box,
 * coloured by certainty) and how the zoom maps to a page width. Pure: no React, no store.
 */
import { certaintyOf, type Certainty } from '../../domain/certainty';
import { fromOtherDocument } from '../../domain/review';
import { PAGE_H, PAGE_W, type Borehole, type Box, type ExtractedValue } from '../../domain/types';
import { NO_SOURCE_REFERENCE } from '../../store/reviewSlice';

/**
 * How a value's position is drawn:
 * - exact: a solid box where the value is printed;
 * - approx: a dashed box labelled "approx." (method Guessed or "approximate", or a value flagged approximate);
 * - page: the value is backed by the whole page (method "page"), so only the page outline marks it.
 */
export type Placement = 'exact' | 'approx' | 'page';

/**
 * A word on the page as OCR or the PDF text layer read it. Seam for GET /documents/{id}/pages/{n}/words:
 * the extracted pane draws these faint behind the values once the backend sends them.
 */
export interface VerifyWord {
  text: string;
  box: Box;
}

/** One value of the borehole as the verification screen draws it on a page. */
export interface VerifyItem {
  key: string;
  label: string;
  /** As printed in the source. */
  raw: string;
  /** Normalised value with its unit, as the extracted page shows it. */
  text: string;
  page: number;
  /** Null for a value on this page without a box (or a whole-page value). */
  box: Box | null;
  placement: Placement;
  certainty: Certainty;
  /** Tooltip: label, the raw text as printed, method, confidence and the certainty reason. */
  title: string;
  /** Why the value can't be reviewed here (no provenance, read-only); null when it can. */
  lockedReason: string | null;
}

/** Methods the backend sends or will send; anything else counts as exact. */
const APPROX_METHODS = new Set(['guessed', 'approximate', 'approx']);

/** How a value's box is drawn, from its method (domain or raw backend string) and its flag / note. */
export function placementOf(v: { method: string | null; box: Box | null; flag?: string; note?: string }): Placement {
  const m = (v.method ?? '').toLowerCase();
  if (m === 'page') return 'page';
  if (APPROX_METHODS.has(m)) return 'approx';
  if (/approx/i.test(v.flag ?? '') || /approx/i.test(v.note ?? '')) return 'approx';
  return 'exact';
}

/** The normalised value with its unit; the raw text when there is no normalised one; '–' when neither. */
export function valueText(v: Pick<ExtractedValue, 'value' | 'unit' | 'raw'>): string {
  const base = v.value || v.raw;
  if (!base) return '–';
  return v.unit && v.value ? `${base} ${v.unit}` : base;
}

const pct = (c: number | null) => (c == null ? 'not given' : `${Math.round(c * 100)} %`);

/** Why a value can't be reviewed here, or null. */
export function lockedReason(v: Pick<ExtractedValue, 'hasProvenance' | 'readOnlyReason'>): string | null {
  if (!v.hasProvenance) return NO_SOURCE_REFERENCE;
  return v.readOnlyReason ?? null;
}

/** True when the value lies on a page of the borehole's own document. */
const onOwnPage = (b: Borehole, v: ExtractedValue): v is ExtractedValue & { page: number } =>
  v.page != null && !v.cell && !fromOtherDocument(b, v);

/** The item of one value on its page. */
export function verifyItem(v: ExtractedValue & { page: number }): VerifyItem {
  const placement = placementOf(v);
  const certainty = certaintyOf(v);
  const lines = [
    v.label,
    `As printed: ${v.raw || '–'}`,
    `Method: ${v.method ?? 'unknown'} · Confidence: ${pct(v.confidence)}`,
    certainty.title,
  ];
  if (placement === 'approx') lines.push('Position approximate');
  if (placement === 'page') lines.push('Backed by the whole page, no box');
  return {
    key: v.key,
    label: v.label,
    raw: v.raw,
    text: valueText(v),
    page: v.page,
    box: placement === 'page' ? null : v.box,
    placement,
    certainty,
    title: lines.join('\n'),
    lockedReason: lockedReason(v),
  };
}

/** The pages that carry this borehole's values (own document only), with the pages it was read from; ascending. */
export function verifyPages(b: Borehole): number[] {
  const set = new Set<number>(b.pages);
  for (const v of b.values) if (onOwnPage(b, v)) set.add(v.page);
  return [...set].filter((n) => Number.isInteger(n) && n >= 1).sort((x, y) => x - y);
}

/** The values on page `page`: those with a box (drawn at it) and those without (listed under the paper). */
export function pageItems(b: Borehole, page: number | null): { boxed: VerifyItem[]; unboxed: VerifyItem[] } {
  const boxed: VerifyItem[] = [];
  const unboxed: VerifyItem[] = [];
  if (page == null) return { boxed, unboxed };
  for (const v of b.values) {
    if (!onOwnPage(b, v) || v.page !== page) continue;
    const item = verifyItem(v);
    (item.box ? boxed : unboxed).push(item);
  }
  return { boxed, unboxed };
}

/**
 * The page to show: the URL's page when the document has it (any page of the document, also one
 * without values), else the borehole's first page with values; null when the borehole has no page.
 */
export function pickPage(requested: number | null, pages: number[], pageCount: number | null): number | null {
  if (requested != null && (pageCount == null ? pages.includes(requested) || pages.length === 0 : requested <= pageCount)) {
    return requested;
  }
  return pages[0] ?? null;
}

/** The previous and next page among the borehole's pages (a page outside them steps to the nearest one). */
export function neighbours(pages: number[], page: number | null): { prev: number | null; next: number | null } {
  if (page == null) return { prev: null, next: null };
  const prev = [...pages].reverse().find((n) => n < page) ?? null;
  const next = pages.find((n) => n > page) ?? null;
  return { prev, next };
}

/* ---------- zoom ---------- */

export type Zoom = number | 'fit';
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.25;

/** The page scale (1 = 560 px wide) a zoom stands for; `fitScale` is the scale that fills one pane. */
export function scaleOf(zoom: Zoom, fitScale: number): number {
  return zoom === 'fit' ? fitScale : zoom;
}

/** One zoom step in or out from the current scale, on the 25 % grid, within the limits. */
export function stepZoom(current: number, dir: 1 | -1): number {
  const snapped = dir > 0 ? Math.floor(current / ZOOM_STEP + 1e-6) * ZOOM_STEP : Math.ceil(current / ZOOM_STEP - 1e-6) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped + dir * ZOOM_STEP));
}

/** The scale at which a page fills a pane `paneWidth` px wide (never below the minimum zoom). */
export function fitScale(paneWidth: number): number {
  return Math.max(ZOOM_MIN / 2, paneWidth / PAGE_W);
}

/** Height over width of a page: the image's when known, else the sample page's. */
export function pageAspect(natural: { w: number; h: number } | null): number {
  return natural && natural.w > 0 && natural.h > 0 ? natural.h / natural.w : PAGE_H / PAGE_W;
}

/**
 * Font size (px) of a value drawn into its box: as tall as the box allows, narrowed so the text fits
 * its width (about 0.6 em per character), between 7 and 48 px.
 */
export function fontSizeFor(text: string, box: Box, pageW: number, pageH: number): number {
  const byHeight = box.h * pageH * 0.72;
  const byWidth = (box.w * pageW) / (Math.max(1, text.length) * 0.6);
  return Math.round(Math.min(48, Math.max(7, Math.min(byHeight, byWidth))) * 10) / 10;
}
