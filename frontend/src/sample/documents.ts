// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/** The queue's documents (prototype DOCS0) and the CRS candidates of the Neckarbogen report (prototype CRS). */
import type { Borehole, CrsCandidate, DocumentPage, DocumentProgress, DocumentSummary } from '../domain/types';
import { pageMap, type PageExtras, type ReportTitle } from './helpers';
import { BK07_PAGES, NB_DOC_ID, NB_FILE, NB_PROJECT } from './neckarbogen';

export const EQ_DOC_ID = 'eq';
export const EQ_FILE = 'elbquerung_ost_GU_2017.pdf';
export const IS_DOC_ID = 'is';

/** Borehole IDs as printed per page, keyed `${documentId}:${page}` (filled from the drawn log pages). */
export type PrintedIds = Map<string, string[]>;

/** Progress of a fully classified document. */
function finished(pages: DocumentPage[], boreholes: number): DocumentProgress {
  const ocr = pages.filter((p) => p.ocr === 'done').length;
  return { pagesTotal: pages.length, pagesClassified: pages.length, pagesOcrTotal: ocr, pagesOcrDone: ocr, boreholesExtracted: boreholes };
}

/**
 * The prototype's three documents. The Neckarbogen report has 14 log pages (7–20) instead of the
 * prototype's 10, so each of its 13 boreholes has its own log page; page 8 continues BK-07 and page 28
 * repeats the photo page 24. The Isartal scan is still being extracted (19 pages not classified yet).
 */
export function sampleDocuments(printed: PrintedIds): DocumentSummary[] {
  const ids = (doc: string) => (n: number): PageExtras => {
    const found = printed.get(`${doc}:${n}`);
    return found ? { boreholeIds: found } : {};
  };
  const nbPages = pageMap('CTTTKD' + 'LN' + 'L'.repeat(12) + 'BBPPTTDX', { language: 'de', handwriting: 'none' }, (n) => ({
    ...ids(NB_DOC_ID)(n),
    ...(n === BK07_PAGES[0] ? { sheetLabel: 'Blatt 1 von 2' } : n === BK07_PAGES[1] ? { sheetLabel: 'Blatt 2 von 2', boreholeIds: ['BK 7'] } : {}),
    ...(n === 19 ? { handwriting: 'annotations' as const } : {}),
    ...(n === 28 ? { duplicateOf: { documentId: NB_DOC_ID, n: 24 } } : {}),
  }));
  const eqPages = pageMap('CTTDLLLLLLLLLBBBTP', { language: 'de', handwriting: 'none' }, ids(EQ_DOC_ID));
  // A scan: handwritten notes on the logs, OCR still running on the later ones.
  const isPages = pageMap('CTDLLLLLLLLPLLLLLBBTT' + '?'.repeat(19), { language: 'de', handwriting: 'none' }, (n) =>
    n >= 4 && n <= 17 && n !== 12 ? { handwriting: 'partial', ocr: n <= 9 ? 'done' : 'pending' } : {},
  );
  return [
    {
      id: NB_DOC_ID, name: NB_FILE, project: NB_PROJECT,
      status: 'needs_review',
      pages: nbPages,
      step: 2,
      progress: finished(nbPages, 13),
      counts: { boreholes: 13, layers: 63, spt: 22, groundwater: 9 },
      completeness: {
        listed: 14, idPrefix: 'BK-', missing: ['BK-12'], unexpected: [],
        lint: [
          { severity: 'error', boreholeId: 'BK-07', message: 'Log bottom 14.50 m ≠ final depth 18.00 m' },
          { severity: 'error', boreholeId: 'BK-07', message: 'SPT @ 1.50 m: increments 4 + 5 = 9 ≠ N 8' },
          { severity: 'warning', boreholeId: 'BK-03', message: 'Gap between layers at 6.20–6.40 m' },
          { severity: 'warning', boreholeId: 'BK-11', message: 'UCS 420 MPa out of plausible range' },
        ],
      },
      reviewBoreholeUid: `${NB_DOC_ID}:BK-07`,
      // Fictional 1.2.1 warning: the page that would hold the missing BK-12 was not read.
      warnings: ['Page 27 was not read; boreholes on it are missing. Retry the document to read it.'],
      // The coordinate system isn't printed: one question for the whole report (clarifications.ts),
      // counted by the sample source.
      openClarifications: 0,
      duplicateOf: null,
      error: null,
    },
    {
      id: EQ_DOC_ID, name: EQ_FILE, project: 'Elbquerung Ost',
      status: 'done',
      pages: eqPages,
      step: 3,
      progress: finished(eqPages, 9),
      counts: { boreholes: 9, layers: 41, spt: 30, groundwater: 9 },
      completeness: { listed: 9, idPrefix: 'EQ-', missing: [], unexpected: [], lint: [] },
      reviewBoreholeUid: null,
      openClarifications: 0,
      duplicateOf: null,
      error: null,
    },
    {
      id: IS_DOC_ID, name: 'isartal_stollen_scan.pdf', project: 'Isartal-Wasserstollen',
      status: 'extracting',
      pages: isPages,
      step: 1,
      progress: { pagesTotal: 40, pagesClassified: 21, pagesOcrTotal: 15, pagesOcrDone: 8, boreholesExtracted: 3 },
      counts: null,
      completeness: null,
      reviewBoreholeUid: null,
      openClarifications: 0,
      duplicateOf: null,
      error: null,
    },
  ];
}

/** First log page available to generated boreholes, per document. */
export const FIRST_GENERATED_PAGE: Record<string, number> = { [NB_DOC_ID]: 9, [EQ_DOC_ID]: 5 };

/** Title page text per document; uploads and archive files get a plain one. */
export const REPORT_TITLES: Record<string, ReportTitle> = {
  [NB_DOC_ID]: { project: 'Stadtbahn Neckarbogen, Los 2', date: 'März 2019' },
  [EQ_DOC_ID]: { project: 'Elbquerung Ost', date: 'Juni 2017' },
  [IS_DOC_ID]: { project: 'Isartal-Wasserstollen', date: 'Oktober 2021' },
};

/**
 * CRS candidates for a document (prototype CRS). Only the Neckarbogen report has an unstated CRS.
 * Each candidate places the document's mapped boreholes; zone 4 shifts them 3° east.
 */
export function crsCandidatesFor(documentId: string, boreholes: Borehole[]): CrsCandidate[] {
  if (documentId !== NB_DOC_ID) return [];
  const pins = boreholes.filter((b) => b.documentId === documentId && b.lat != null && b.lng != null);
  const at = (dl: number) => pins.map((b) => ({ uid: b.uid, lat: b.lat as number, lng: (b.lng as number) + dl }));
  return [
    {
      name: 'DHDN / 3-degree Gauss-Krüger zone 3', code: 'EPSG:31467', score: 0.94, verdict: 'match', swapAxes: false, points: at(0),
      note: 'Zone prefix 3 matches. Pins land in the Neckar valley, where the report says the site is.',
    },
    {
      name: 'DHDN / 3-degree Gauss-Krüger zone 4', code: 'EPSG:31468', score: 0.41, verdict: 'shifted', swapAxes: false, points: at(3),
      note: 'Ignores the zone prefix. Pins land ~220 km east, near Ingolstadt.',
    },
    {
      name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', score: 0.02, verdict: 'out_of_range', swapAxes: false, points: [],
      note: 'A 7-digit easting is out of range for UTM. No pins can be placed.',
    },
  ];
}
