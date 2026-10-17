// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/** Page-drawing, value and page-map helpers shared by the sample modules (prototype T, Ln, add). */
import { placeholderPage } from '../domain/pages';
import { PAGE_H, PAGE_W } from '../domain/types';
import type { Box, DocumentPage, ExtractedValue, PageItem, PageType } from '../domain/types';
import type { ValueFieldName } from '../schema/targetFormat';

/** Text item at (x, y) px in the 560x780 page space. */
export function T(x: number, y: number, text: string, fontSize = 12, fontWeight = 400): PageItem {
  return { kind: 'text', x, y, text, fontSize, fontWeight };
}

/** Filled rectangle (a rule or a shaded area) in the 560x780 page space. */
export function Ln(x: number, y: number, w: number, h: number, color = '#2b2b2b'): PageItem {
  return { kind: 'line', x, y, w, h, color };
}

/** Converts a prototype px box [x, y, w, h] to a normalised Box. */
export function px(b: readonly [number, number, number, number]): Box {
  return { x: b[0] / PAGE_W, y: b[1] / PAGE_H, w: b[2] / PAGE_W, h: b[3] / PAGE_H };
}

/** Box width the prototype uses for a printed string: 7.2 px per character + 8. */
export const textWidth = (s: string) => Math.round(s.length * 7.2 + 8);

export interface SampleValueInput
  extends Omit<ExtractedValue, 'field' | 'box' | 'unit' | 'status' | 'state' | 'aiValue' | 'confidence' | 'hasProvenance' | 'method'> {
  field: ValueFieldName;
  box: readonly [number, number, number, number] | null;
  method: NonNullable<ExtractedValue['method']>;
  unit?: string;
  confidence?: number;
  state?: ExtractedValue['state'];
}

/** Builds a sample value: unreviewed, state ok, with provenance, AI value = value (prototype `add`). */
export function sampleValue(o: SampleValueInput): ExtractedValue {
  return {
    unit: '',
    confidence: 0.9,
    state: 'ok',
    ...o,
    box: o.box ? px(o.box) : null,
    hasProvenance: true,
    status: 'unreviewed',
    aiValue: o.value,
  };
}

/** Title shown on page 1 of a sample report. */
export interface ReportTitle {
  project: string;
  date: string;
}

/** A non-log page drawn by type (prototype pageItems for pages other than the BK-07 sheets). */
export function genericPage(page: number, type: PageType, title: ReportTitle): PageItem[] {
  if (page === 1) {
    return [
      T(60, 200, 'BAUGRUNDGUTACHTEN', 24, 700),
      T(60, 242, title.project, 14),
      T(60, 266, 'Geotechnischer Bericht'),
      T(60, 288, title.date),
      T(60, 700, 'Ingenieurbüro Muster GmbH (fiktiv)', 11),
      Ln(60, 320, 440, 2),
    ];
  }
  const it = [T(24, 22, `Seite ${page}`, 11)];
  if (type === 'photo') {
    it.push(Ln(40, 90, 480, 340, '#B8B6B1'), T(250, 250, 'Foto', 14), T(40, 450, `Abb. ${page}: Bohrkern`, 11));
  } else if (type === 'drawing') {
    it.push(Ln(40, 90, 480, 560, '#EFEDE6'), T(240, 360, 'Lageplan', 14));
  } else if (type === 'lab_table') {
    it.push(T(40, 60, 'Laborversuche', 14, 700));
    for (let r = 0; r < 16; r++) it.push(Ln(40, 100 + r * 30, 480, 1, '#9a9a9a'));
  } else {
    for (let r = 0; r < 26; r++) it.push(Ln(40, 70 + r * 24, r % 5 === 4 ? 280 : 480, 4, '#DDD8D0'));
  }
  return it;
}

/**
 * Page codes of the sample page maps: C cover, T narrative text, K legend, D site plan, L log sheet,
 * N log continuation, B lab results, P photos, X duplicate photo page, ? not classified yet.
 */
const PAGE_CODES: Record<string, Pick<DocumentPage, 'type' | 'role' | 'used' | 'unusedReason'> | null> = {
  C: { type: 'text', role: 'cover_or_toc', used: false, unusedReason: 'cover page' },
  T: { type: 'text', role: 'narrative', used: false, unusedReason: 'no borehole data' },
  K: { type: 'text', role: 'legend_or_key', used: false, unusedReason: 'legend' },
  D: { type: 'drawing', role: 'location_plan', used: false, unusedReason: 'site plan' },
  L: { type: 'log', role: 'log_sheet', used: true, unusedReason: null },
  N: { type: 'log', role: 'log_continuation', used: true, unusedReason: null },
  B: { type: 'lab_table', role: 'lab_results', used: true, unusedReason: null },
  P: { type: 'photo', role: 'photos', used: false, unusedReason: 'core photographs' },
  X: { type: 'photo', role: 'duplicate', used: false, unusedReason: null },
  '?': null,
};

/** Per-page extras of a sample page map, by page number. */
export interface PageExtras {
  boreholeIds?: string[];
  sheetLabel?: string | null;
  handwriting?: DocumentPage['handwriting'];
  ocr?: DocumentPage['ocr'];
  duplicateOf?: DocumentPage['duplicateOf'];
}

/** Expands a page-code string like "CTDLL?" into classified pages (placeholders for "?"). */
export function pageMap(
  codes: string,
  base: Pick<DocumentPage, 'language' | 'handwriting'>,
  extras: (n: number) => PageExtras = () => ({}),
): DocumentPage[] {
  return [...codes].map((c, i) => {
    const n = i + 1;
    const kind = PAGE_CODES[c];
    if (!kind) return placeholderPage(n);
    const ocr = kind.type === 'log' || kind.type === 'lab_table' ? 'done' : 'skipped';
    return {
      n, ...kind, boreholeIds: [], sheetLabel: null, handwriting: base.handwriting, language: base.language, ocr, duplicateOf: null,
      classified: true, ...extras(n),
    };
  });
}
