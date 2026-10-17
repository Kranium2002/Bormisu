/**
 * TS mirror of the colours that are computed at runtime (pins, chips, badges, page types).
 * Static styling lives in CSS modules + src/styles/tokens.css.
 */
import type { BoreholeStatus, Method, PageType } from './domain/types';

/** Core palette (same names as the prototype's COL, plus text tones used in computed styles). */
export const COL = {
  green: '#7DB713',
  dark: '#003E25',
  amber: '#E39B00',
  red: '#C8102E',
  grey: '#A3A3A2',
  gw: '#1F5FA8',
  text: '#181818',
  muted: '#555555',
  faint: '#868685',
  border: '#D6D6D6',
  line: '#EFEFEF',
  greenText: '#3F6A00',
  amberText: '#8A5300',
  greenBg: '#E6F1D2',
  amberBg: '#FFEFCC',
  redBg: '#FDE7EA',
  selected: '#F5F9EC',
} as const;

/** Method badge colours. None of them is green: green must never imply "correct". */
export const METHOD_COLORS: Record<Method, { bg: string; fg: string }> = {
  Read: { bg: '#E3E9F3', fg: '#2D4A7A' },
  OCR: { bg: '#ECE6F3', fg: '#5B3F86' },
  Derived: { bg: '#F1EADF', fg: '#7A5A2B' },
  Guessed: { bg: '#FFEFCC', fg: '#8A5300' },
  Edited: { bg: '#E4E4E4', fg: '#181818' },
};

/** Page-type legend: display name, swatch colour and border. Usage text comes from domain/pages.ts. */
export const PAGE_TYPE_META: Record<PageType, { name: string; color: string; border: string }> = {
  log: { name: 'log', color: '#003E25', border: '#003E25' },
  lab_table: { name: 'lab table', color: '#6E8FB5', border: '#6E8FB5' },
  text: { name: 'text', color: '#C9C9C8', border: '#C9C9C8' },
  drawing: { name: 'drawing', color: '#C9A36B', border: '#C9A36B' },
  photo: { name: 'photo', color: '#6F6F6E', border: '#6F6F6E' },
  unknown: { name: 'not classified yet', color: '#FFFFFF', border: '#C9C9C8' },
};

/** Page types shown in the queue legend, in prototype order. */
export const PAGE_TYPE_LEGEND: PageType[] = ['log', 'lab_table', 'text', 'drawing', 'photo'];

/**
 * Status chip label and colours: approved green, unreviewed and in review grey (each with its own
 * label), attention amber.
 */
export function statusChip(s: BoreholeStatus): { label: string; bg: string; fg: string } {
  if (s === 'approved') return { label: 'Approved', bg: COL.greenBg, fg: COL.greenText };
  if (s === 'attention') return { label: 'Needs attention', bg: COL.amberBg, fg: COL.amberText };
  if (s === 'in_review') return { label: 'In review', bg: COL.line, fg: COL.muted };
  return { label: 'Unreviewed', bg: COL.line, fg: COL.muted };
}

/** Map pin colour by status: green = approved, amber = attention, grey = unreviewed or in review. */
export function pinColor(s: BoreholeStatus): string {
  if (s === 'approved') return COL.green;
  if (s === 'attention') return COL.amber;
  return COL.grey;
}
