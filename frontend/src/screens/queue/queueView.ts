/**
 * Pure view logic of the Upload & queue screen (prototype `renderVals` docs mapping):
 * status steps, card hint, count chips, progress bars, page-strip tooltips. No React, unit-tested.
 */
import { pageUsageText, PAGE_ROLE_LABELS } from '../../domain/pages';
import type { DocumentPage, DocumentProgress, DocumentStep, DocumentSummary } from '../../domain/types';
import { PAGE_TYPE_META } from '../../theme';

export const STEP_LABELS = ['classifying', 'extracting', 'needs review', 'done'] as const;

/**
 * done: finished (green). active: running now (green ring, pulses). review: waiting for a human
 * (amber, no pulse). failed: extraction stopped here (red). pending: not reached yet (grey).
 */
export type StepState = 'done' | 'active' | 'review' | 'failed' | 'pending';

export interface StepView {
  label: (typeof STEP_LABELS)[number];
  state: StepState;
  /** The prototype pulses the active step while the machine works (classifying, extracting). */
  pulse: boolean;
}

/** The four status steps of a document. `failed` marks the current step red instead of active. */
export function stepViews(step: DocumentStep, failed = false): StepView[] {
  return STEP_LABELS.map((label, i) => {
    const done = i < step || step === 3;
    const current = i === step && step < 3;
    let state: StepState = 'pending';
    if (done) state = 'done';
    else if (current && failed) state = 'failed';
    else if (current) state = i === 2 ? 'review' : 'active';
    return { label, state, pulse: state === 'active' && i < 2 };
  });
}

/** True when the card (and its hint) opens the Review screen: a review borehole exists and extraction is through. */
export function canOpenReview(d: DocumentSummary): boolean {
  return !!d.reviewBoreholeUid && d.step >= 2 && !d.error;
}

export type HintTone = 'action' | 'muted' | 'error';
export interface HintView { text: string; tone: HintTone }

/** Bottom-right hint of a card, in the prototype's order of precedence (failures first). */
export function docHint(d: DocumentSummary): HintView | null {
  if (d.error) return { text: `Extraction failed: ${d.error}`, tone: 'error' };
  if (canOpenReview(d)) return { text: 'OPEN REVIEW ›', tone: 'action' };
  if (d.step === 3) return { text: 'All boreholes reviewed', tone: 'muted' };
  if (d.simulated && d.step === 2) return { text: 'Simulated: live extraction needs an API key', tone: 'muted' };
  if (d.step < 2) return { text: 'Processing…', tone: 'muted' };
  return null;
}

/** "24 pages · Project name". Parts the backend has not delivered yet are left out. */
export function docMeta(d: DocumentSummary): string {
  const n = d.pages.length;
  const parts = [n ? `${n} ${n === 1 ? 'page' : 'pages'}` : '', d.project].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return d.uploaded ? 'Uploaded, waiting for page count' : '';
}

export interface CountChip { n: number; label: string }

/** Found-count chips. A 0 is shown as 0: "0 found" differs from "not processed yet" (counts = null). */
export function countChips(counts: DocumentSummary['counts']): CountChip[] | null {
  if (!counts) return null;
  const chip = (n: number, one: string, many: string) => ({ n, label: n === 1 ? one : many });
  return [
    chip(counts.boreholes, 'BH', 'BH'),
    chip(counts.layers, 'layer', 'layers'),
    chip(counts.spt, 'SPT', 'SPT'),
    chip(counts.groundwater, 'GW reading', 'GW readings'),
  ];
}

export interface ProgressBar { label: string; done: number; total: number; pct: number }
export interface ProgressView { bars: ProgressBar[]; boreholes: string }

/**
 * Progress of a document the backend works on: bars for classified pages and OCR (only when there
 * are pages to OCR) and the count of extracted boreholes.
 */
export function progressView(p: DocumentProgress): ProgressView {
  const bar = (label: string, done: number, total: number): ProgressBar => ({
    label,
    done,
    total,
    pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
  });
  const bars = [bar('pages classified', p.pagesClassified, p.pagesTotal)];
  if (p.pagesOcrTotal > 0) bars.push(bar('OCR', p.pagesOcrDone, p.pagesOcrTotal));
  const n = p.boreholesExtracted;
  return { bars, boreholes: `${n} borehole${n === 1 ? '' : 's'} extracted` };
}

/**
 * "Same file as <name>" for a duplicate upload, or a neutral text when the earlier document isn't
 * listed. The backend answers a duplicate upload with the existing document itself (document_id ==
 * duplicate_of): that card says it was uploaded again instead of pointing at itself.
 */
export function duplicateText(d: DocumentSummary, all: DocumentSummary[]): string | null {
  if (d.uploadedAgain || isSelfDuplicate(d)) return 'Already uploaded: same bytes as this document';
  if (!d.duplicateOf) return null;
  const original = all.find((x) => x.id === d.duplicateOf);
  return original ? `Same file as ${original.name}` : 'Same file as an earlier upload';
}

/** True when a duplicate answer names the document itself (the bytes were uploaded before as this document). */
export function isSelfDuplicate(d: Pick<DocumentSummary, 'id' | 'duplicateOf'>): boolean {
  return d.duplicateOf === d.id;
}

/** "3 open questions" badge text, or null when none are open. */
export function questionsText(d: DocumentSummary): string | null {
  const n = d.openClarifications;
  return n > 0 ? `${n} open question${n === 1 ? '' : 's'}` : null;
}

/**
 * Page-strip tooltip, e.g. "p.7 · log · used: log sheet · sheet 2 · OCR done · handwriting: partial".
 * Only what the backend reported; an unclassified page says so.
 */
export function pageTitle(p: DocumentPage, documentId: string): string {
  const usage = pageUsageText(p);
  if (!p.classified) return `p.${p.n} · ${usage}`;
  const role = p.role ? PAGE_ROLE_LABELS[p.role] : '';
  // The usage text names the duplicated page; say when that page is in another document.
  const elsewhere = p.duplicateOf && p.duplicateOf.documentId !== documentId ? `page ${p.duplicateOf.n} of another document` : '';
  return [
    `p.${p.n}`,
    PAGE_TYPE_META[p.type].name,
    usage,
    role && !usage.includes(role) ? `role: ${role}` : '',
    p.sheetLabel ? `sheet ${p.sheetLabel}` : '',
    p.ocr ? `OCR ${p.ocr}` : '',
    p.handwriting && p.handwriting !== 'none' ? `handwriting: ${p.handwriting}` : '',
    elsewhere,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Pages that are not classified yet can't be opened in the Source panel. */
export function canOpenPage(p: DocumentPage): boolean {
  return p.classified;
}
