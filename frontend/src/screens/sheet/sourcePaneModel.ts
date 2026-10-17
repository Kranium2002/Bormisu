/**
 * Pure model of the original-page pane next to the generated sheet (/sheet/:uid): which uploaded page
 * it shows (the borehole's own document, or another document a value comes from once that page is
 * opened), which box it highlights for the active value (the value hovered on the sheet, else the
 * clicked one), how many sources that value has, and what it says instead of a box (no box on the
 * page, another document, no page). Provenance only: a value's page and box, and its `sources`. Also
 * the pane's remembered share of the row and collapsed state. No React, no store.
 */
import { fromOtherDocument } from '../../domain/review';
import type { Borehole, Box, ExtractedValue } from '../../domain/types';
import { pageItems, placementOf, verifyPages } from '../verify/verifyModel';

/** What the pane shows for the active value. */
export type PaneTarget =
  /** A page of the borehole's document, with the value's box there (null: no box on this page); source `index` of `count`. */
  | { kind: 'page'; page: number; box: Box | null; index: number; count: number }
  /** The value's source is another document (e.g. a lab report): its page and box there, or its cell. */
  | { kind: 'otherDocument'; documentId: string; page: number | null; box: Box | null; cell: string | null }
  /** A spreadsheet value of the borehole's own document: a cell, no page image. */
  | { kind: 'cell'; cell: string }
  /** A value printed on no page (guessed, derived, or no page reference). */
  | { kind: 'noPage'; method: ExtractedValue['method'] };

/** The page the pane opens on: the borehole's first page with values (or read from); null without pages. */
export function firstPage(b: Borehole): number | null {
  return verifyPages(b)[0] ?? null;
}

/**
 * Source `index` of a value (its page and box there) when it is cited on several pages; its own page
 * and box otherwise. As SourcePanel's sourceStop does for the Source panel.
 */
export function valueStop(v: Pick<ExtractedValue, 'page' | 'box' | 'sources'>, index: number): { page: number | null; box: Box | null } {
  const s = v.sources && v.sources.length > 1 ? v.sources[index] : undefined;
  return s ? { page: s.page, box: s.box } : { page: v.page, box: v.box };
}

/** Number of sources the pane steps through for a value: its cited pages when more than one, else 1. */
export const sourceCount = (v: Pick<ExtractedValue, 'sources'>) => (v.sources && v.sources.length > 1 ? v.sources.length : 1);

/** What the pane shows for value `key` at source `index` (clamped to its sources); null when the borehole has no such value. */
export function paneTarget(b: Borehole, key: string | null, index = 0): PaneTarget | null {
  const v = key ? b.values.find((x) => x.key === key) : undefined;
  if (!v) return null;
  // A value backed by the whole page has no box to draw.
  const boxOf = (box: Box | null) => (placementOf(v) === 'page' ? null : box);
  if (fromOtherDocument(b, v)) {
    return { kind: 'otherDocument', documentId: v.documentId!, page: v.cell ? null : v.page, box: v.cell ? null : boxOf(v.box), cell: v.cell ?? null };
  }
  if (v.cell) return { kind: 'cell', cell: v.cell };
  const count = sourceCount(v);
  const i = Math.min(Math.max(0, Math.trunc(index) || 0), count - 1);
  const stop = valueStop(v, i);
  if (stop.page == null) return { kind: 'noPage', method: v.method };
  return { kind: 'page', page: stop.page, box: boxOf(stop.box), index: i, count };
}

/** The uploaded page the pane shows; `other` when it is another document's (a value's source opened there). */
export interface PaneView {
  documentId: string | null;
  page: number | null;
  other: boolean;
}

/**
 * The page shown: another document's page when the active value comes from there and that page was
 * opened (`otherOpen`); else the active value's page, else the page picked in the strip, else the
 * borehole's first page.
 */
export function paneView(b: Borehole, target: PaneTarget | null, picked: number | null, otherOpen: boolean): PaneView {
  if (otherOpen && target?.kind === 'otherDocument' && target.page != null) return { documentId: target.documentId, page: target.page, other: true };
  const page = target?.kind === 'page' ? target.page : (picked ?? firstPage(b));
  return { documentId: b.documentId, page, other: false };
}

/** A value box drawn on the shown page: the active value's ('highlight') or another value's ('idle', clickable). */
export interface PaneBox {
  key: string;
  box: Box;
  variant: 'highlight' | 'idle';
  label: string;
  /** As printed. */
  raw: string;
}

/**
 * The boxes on the shown page: on the borehole's own page every boxed value there as 'idle'; and the
 * active value's box at its current source as 'highlight' (drawn last, on top), also on another
 * document's page.
 */
export function paneBoxes(b: Borehole, view: PaneView, activeKey: string | null, target: PaneTarget | null): PaneBox[] {
  if (view.page == null) return [];
  const boxes: PaneBox[] = view.other
    ? []
    : pageItems(b, view.page)
        .boxed.filter((it) => it.key !== activeKey)
        .map((it) => ({ key: it.key, box: it.box!, variant: 'idle', label: it.label, raw: it.raw }));
  const active = activeKey ? b.values.find((v) => v.key === activeKey) : undefined;
  const onThisPage =
    (target?.kind === 'page' && !view.other && target.page === view.page) ||
    (target?.kind === 'otherDocument' && view.other && target.documentId === view.documentId && target.page === view.page);
  if (active && onThisPage && target.box) {
    boxes.push({ key: active.key, box: target.box, variant: 'highlight', label: active.label, raw: active.raw });
  }
  return boxes;
}

/**
 * What the pane says instead of a box for the target, in the UI language (`t`); null when it draws a
 * box or shows no value. `docName` names another document when the store has it; `otherShown` when
 * the pane already shows that document's page.
 */
export function paneNote(target: PaneTarget | null, t: (en: string) => string, opts: { docName?: string; otherShown?: boolean } = {}): string | null {
  if (!target) return null;
  switch (target.kind) {
    case 'page':
      return target.box ? null : t('No box on this page');
    case 'otherDocument': {
      if (opts.otherShown) return target.box ? null : t('No box on this page');
      const where = target.cell ? ` · ${t('cell')} ${target.cell}` : target.page != null ? ` · ${t('page')} ${target.page}` : '';
      return `${t('This value is from another document')}${opts.docName ? `: ${opts.docName}` : ''}${where}`;
    }
    case 'cell':
      return `${t('Spreadsheet value')}: ${t('cell')} ${target.cell}, ${t('no page image')}`;
    case 'noPage':
      if (target.method === 'Guessed') return t('Not printed on a page: this value was guessed.');
      if (target.method === 'Derived') return t('Not printed on a page: this value was derived.');
      return t('No page reference for this value.');
  }
}

/** Whether the pane offers "Open that page": a value from another document with a page there, not shown yet. */
export const canOpenOther = (target: PaneTarget | null, otherShown: boolean) =>
  target?.kind === 'otherDocument' && target.page != null && !otherShown;

/* ---------- width and collapsed state, remembered in this browser ---------- */

export const PANE_KEY = 'bormisu.sheet.sourcePane';
/** The pane's share of the row next to the sheet at first: half, like the verification screen. */
export const PANE_SHARE = 0.5;
export const PANE_MIN = 280;
/** The sheet keeps at least this much width next to the pane (px). */
export const SHEET_MIN = 320;
/** Arrow keys on the resize handle move it this far (px); with Shift four times as far. */
export const PANE_STEP = 24;

/** `share`: the pane's part of the row's width (0–1). */
export interface PaneLayout { share: number; collapsed: boolean }

const clampShare = (share: number) => Math.min(0.9, Math.max(0.1, share));

/** The widest the pane may be in a row `available` px wide (never below the minimum). */
export function paneMax(available: number): number {
  return Math.max(PANE_MIN, available - SHEET_MIN);
}

/** A width (px) within the limits of a row `available` px wide, rounded to whole px. */
export function clampWidth(width: number, available: number): number {
  const w = Number.isFinite(width) ? width : PANE_SHARE * available;
  return Math.round(Math.min(Math.max(w, PANE_MIN), paneMax(available)));
}

/** The pane's width (px) for its share of a row `available` px wide. */
export const paneWidth = (share: number, available: number) => clampWidth(share * available, available);

/** The share of the row a width (px) stands for, as stored. */
export function shareOf(width: number, available: number): number {
  return available > 0 ? clampShare(clampWidth(width, available) / available) : PANE_SHARE;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The stored layout; half the row and shown for anything missing or unreadable. A narrow screen
 * (`narrow`, the pane under the page) always starts with the pane hidden.
 */
export function readPaneLayout(narrow: boolean, storage: ReadStorage | null = browserStorage()): PaneLayout {
  try {
    const raw = storage?.getItem(PANE_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : null;
    if (!stored || typeof stored !== 'object') return { share: PANE_SHARE, collapsed: narrow };
    const s = stored as Partial<Record<keyof PaneLayout, unknown>>;
    return {
      share: typeof s.share === 'number' && Number.isFinite(s.share) ? clampShare(s.share) : PANE_SHARE,
      collapsed: narrow || s.collapsed === true,
    };
  } catch {
    return { share: PANE_SHARE, collapsed: narrow };
  }
}

/**
 * Stores the layout; a failure is ignored (the layout still holds for this visit). On a narrow screen
 * only the share: showing or hiding the pane there keeps the wide screen's choice.
 */
export function writePaneLayout(layout: PaneLayout, narrow = false, storage: WriteStorage | null = browserStorage()): void {
  try {
    const collapsed = narrow ? readPaneLayout(false, storage).collapsed : layout.collapsed;
    storage?.setItem(PANE_KEY, JSON.stringify({ share: layout.share, collapsed }));
  } catch {
    /* storage blocked or full */
  }
}
