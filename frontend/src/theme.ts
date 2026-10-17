/**
 * TS mirror of the colours that are computed at runtime (pins, chips, badges, page types,
 * profile fills). Static styling lives in CSS modules + src/styles/tokens.css.
 */
import type { BoreholeStatus, Method, PageType, PatternId } from './domain/types';

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
  faint: '#6F6F6E', // = --c-faint: lightest text tone (5.0:1 on white)
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

/** Fill of the stratigraphy column per stratigraphy code. Unknown codes use STRAT_FALLBACK. */
export const STRAT_COLORS: Record<string, string> = {
  qh: '#FFF3C4',
  y: '#E0E0E0',
  qp: '#FBE3A8',
  kmS: '#EBC2A6',
  qw: '#FFF0B3',
  tm: '#D7E8F5',
  kro: '#DCEBC8',
};
export const STRAT_FALLBACK = '#EEEEEE';

/** Pastel DIN 4023 fill per hatching pattern (the hatching itself is drawn on top). */
export const PATTERN_FILLS: Record<PatternId, string> = {
  topsoil: '#E8D9C4',
  fill: '#EFEFEF',
  clay: '#DCD2EA',
  silt: '#E1EAB8',
  gravel: '#FFFACD',
  sst: '#FFD08A',
  sand: '#FFF5B0',
  lst: '#B7D7F0',
  marl: '#D9E3C4',
};

/** Page-type legend: display name, swatch colour, border and default usage note. */
export const PAGE_TYPE_META: Record<PageType, { name: string; color: string; border: string; usage: string }> = {
  log: { name: 'log', color: '#003E25', border: '#003E25', usage: 'used: borehole log' },
  lab_table: { name: 'lab table', color: '#6E8FB5', border: '#6E8FB5', usage: 'unused: lab table (roadmap)' },
  text: { name: 'text', color: '#C9C9C8', border: '#C9C9C8', usage: 'unused: text' },
  drawing: { name: 'drawing', color: '#C9A36B', border: '#C9A36B', usage: 'unused: drawing' },
  photo: { name: 'photo', color: '#6F6F6E', border: '#6F6F6E', usage: 'unused: photo' },
  unknown: { name: 'not classified yet', color: '#FFFFFF', border: '#C9C9C8', usage: 'not classified yet' },
};

/** Page types shown in the queue legend, in prototype order. */
export const PAGE_TYPE_LEGEND: PageType[] = ['log', 'lab_table', 'text', 'drawing', 'photo'];

/** Usage note for a page: the first two text pages carry the project metadata. */
export function pageUsage(type: PageType, page: number): string {
  if (type === 'text' && page <= 2) return 'used: project metadata';
  return PAGE_TYPE_META[type].usage;
}

/** Review status chip label and colours. */
export function statusChip(s: BoreholeStatus): { label: string; bg: string; fg: string } {
  if (s === 'reviewed') return { label: 'Reviewed', bg: COL.greenBg, fg: COL.greenText };
  if (s === 'attention') return { label: 'Needs attention', bg: COL.amberBg, fg: COL.amberText };
  return { label: 'Unreviewed', bg: COL.line, fg: COL.muted };
}

/** Map pin colour by review status: green = reviewed, amber = attention, grey = unreviewed. */
export function pinColor(s: BoreholeStatus): string {
  if (s === 'reviewed') return COL.green;
  if (s === 'attention') return COL.amber;
  return COL.grey;
}
