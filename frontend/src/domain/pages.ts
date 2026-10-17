/** Document pages: placeholders for pages not classified yet, and the usage text for tooltips and the Source panel. */
import type { DocumentPage, PageRole } from './types';

/** Readable names of the backend's page roles. */
export const PAGE_ROLE_LABELS: Record<PageRole, string> = {
  log_sheet: 'log sheet',
  log_continuation: 'log continuation',
  summary_table: 'summary table',
  coordinate_table: 'coordinate table',
  lab_results: 'lab results',
  legend_or_key: 'legend or key',
  location_plan: 'location plan',
  cross_section: 'cross section',
  narrative: 'narrative',
  cover_or_toc: 'cover or contents',
  photos: 'photos',
  blank: 'blank page',
  duplicate: 'duplicate page',
  other: 'other',
};

/** A page the backend hasn't classified yet. */
export function placeholderPage(n: number): DocumentPage {
  return {
    n,
    type: 'unknown',
    role: null,
    used: false,
    unusedReason: null,
    boreholeIds: [],
    sheetLabel: null,
    handwriting: null,
    language: null,
    ocr: null,
    duplicateOf: null,
    classified: false,
  };
}

/**
 * Usage note of a page, e.g. "used: log sheet" or "unused: cover or contents". It says only what the
 * backend reported; a page without a classification is "not classified yet".
 */
export function pageUsageText(p: DocumentPage | undefined): string {
  if (!p || !p.classified) return 'not classified yet';
  const what = p.role ? PAGE_ROLE_LABELS[p.role] : p.type.replace('_', ' ');
  if (p.used) return `used: ${what}`;
  if (p.duplicateOf) return `unused: duplicate of page ${p.duplicateOf.n}`;
  return `unused: ${p.unusedReason ?? what}`;
}
