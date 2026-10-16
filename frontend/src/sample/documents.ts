// DEMO ONLY: fictional sample data. Used only when VITE_DATA_SOURCE=sample. Not part of the production data path.
/** The queue's documents (prototype DOCS0) and the CRS candidates of the Neckarbogen report (prototype CRS). */
import type { Borehole, CrsCandidate, DocumentSummary, PageType } from '../domain/types';
import type { ReportTitle } from './helpers';
import { NB_DOC_ID, NB_FILE, NB_PROJECT } from './neckarbogen';

const PAGE_CODES: Record<string, PageType> = { L: 'log', B: 'lab_table', T: 'text', D: 'drawing', P: 'photo', '?': 'unknown' };

/** Expands a prototype page string like "TTDLL?" into page types. */
export const pageTypes = (codes: string): PageType[] => [...codes].map((c) => PAGE_CODES[c]);

export const EQ_DOC_ID = 'eq';
export const EQ_FILE = 'elbquerung_ost_GU_2017.pdf';

/**
 * The prototype's three documents. The Neckarbogen report has 14 log pages (7–20) instead of the
 * prototype's 10, so each of its 13 boreholes has its own log page.
 */
export function sampleDocuments(): DocumentSummary[] {
  return [
    {
      id: NB_DOC_ID, name: NB_FILE, project: NB_PROJECT,
      pageTypes: pageTypes('TTTTTD' + 'L'.repeat(14) + 'BBPPTTDP'),
      step: 2,
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
    },
    {
      id: EQ_DOC_ID, name: EQ_FILE, project: 'Elbquerung Ost',
      pageTypes: pageTypes('TTTDLLLLLLLLLBBBTP'),
      step: 3,
      counts: { boreholes: 9, layers: 41, spt: 30, groundwater: 9 },
      completeness: { listed: 9, idPrefix: 'EQ-', missing: [], unexpected: [], lint: [] },
      reviewBoreholeUid: null,
    },
    {
      id: 'is', name: 'isartal_stollen_scan.pdf', project: 'Isartal-Wasserstollen',
      pageTypes: pageTypes('TTDLLLLLLLLPLLLLLBBTT' + '?'.repeat(19)),
      step: 1,
      counts: null,
      completeness: null,
      reviewBoreholeUid: null,
    },
  ];
}

/** First log page available to generated boreholes, per document. */
export const FIRST_GENERATED_PAGE: Record<string, number> = { [NB_DOC_ID]: 9, [EQ_DOC_ID]: 5 };

/** Title page text per document; uploads and archive files get a plain one. */
export const REPORT_TITLES: Record<string, ReportTitle> = {
  [NB_DOC_ID]: { project: 'Stadtbahn Neckarbogen, Los 2', date: 'März 2019' },
  [EQ_DOC_ID]: { project: 'Elbquerung Ost', date: 'Juni 2017' },
  is: { project: 'Isartal-Wasserstollen', date: 'Oktober 2021' },
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
    { name: 'DHDN / 3-degree Gauss-Krüger zone 3', code: 'EPSG:31467', note: 'Zone prefix 3 matches. Pins land in the Neckar valley, where the report says the site is.', verdict: 'match', points: at(0) },
    { name: 'DHDN / 3-degree Gauss-Krüger zone 4', code: 'EPSG:31468', note: 'Ignores the zone prefix. Pins land ~220 km east, near Ingolstadt.', verdict: 'shifted', points: at(3) },
    { name: 'ETRS89 / UTM zone 32N', code: 'EPSG:25832', note: 'A 7-digit easting is out of range for UTM. No pins can be placed.', verdict: 'out_of_range', points: [] },
  ];
}
