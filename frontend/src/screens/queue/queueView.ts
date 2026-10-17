/**
 * Pure view logic of the Upload & queue screen (prototype `renderVals` docs mapping):
 * status steps, card hint, count chips, page-strip tooltips, the drop zone's error line. No React,
 * unit-tested.
 */
import type { DocumentStep, DocumentSummary, PageType } from '../../domain/types';
import { PAGE_TYPE_META, pageUsage } from '../../theme';

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
  if (canOpenReview(d)) return { text: 'OPEN IN REVIEW ›', tone: 'action' };
  if (d.step === 3) return { text: 'All boreholes reviewed', tone: 'muted' };
  if (d.simulated && d.step === 2) return { text: 'Simulated: live extraction needs an API key', tone: 'muted' };
  if (d.step < 2) return { text: 'Processing…', tone: 'muted' };
  return null;
}

/** "24 pages · Stadtbahn Neckarbogen". Parts the backend has not delivered yet are left out. */
export function docMeta(d: DocumentSummary): string {
  const n = d.pageTypes.length;
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

/** Page-strip tooltip, e.g. "p.7 · log · used: borehole log". `page` is 1-based. */
export function pageTitle(type: PageType, page: number): string {
  if (type === 'unknown') return `p.${page} · ${PAGE_TYPE_META.unknown.name}`;
  return `p.${page} · ${PAGE_TYPE_META[type].name} · ${pageUsage(type, page)}`;
}

/** Pages that are not classified yet can't be opened in the Source panel. */
export function canOpenPage(type: PageType): boolean {
  return type !== 'unknown';
}

/** Start of the store's message for dropped files of another type ("File type not supported: notes.txt"). */
const UNSUPPORTED_TYPE = 'File type not supported';

/**
 * The drop zone's error line: the store's message as a sentence, followed by what to do when the file
 * type was the problem ("File type not supported: notes.txt. Use PDF, DOCX, JPG or PNG.").
 */
export function dropErrorText(message: string): string {
  const sentence = /[.!?…]$/.test(message) ? message : `${message}.`;
  return message.startsWith(UNSUPPORTED_TYPE) ? `${sentence} Use PDF, DOCX, JPG or PNG.` : sentence;
}
