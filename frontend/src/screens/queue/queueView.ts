/**
 * Pure view logic of the Upload & queue screen (prototype `renderVals` docs mapping):
 * status steps, card hint, count chips, progress bars, page-strip tooltips. No React, unit-tested.
 */
import { pageUsageText, PAGE_ROLE_LABELS } from '../../domain/pages';
import type { Borehole, Clarification, DocumentPage, DocumentProgress, DocumentStep, DocumentSummary } from '../../domain/types';
import { pageMeta } from '../../theme';

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

/** A failure the server reported for a document (live event job.failed): the stage as the server names it. */
export interface JobFailure { stage: string; detail: string; retryable: boolean }

/** Why RETRY is off for a failure the server says retrying cannot fix. */
export const NOT_RETRYABLE = 'The server reports that retrying cannot fix this failure';

/**
 * The pipeline stages in words (contract `Document.failed_stage`, the job.failed event's `stage`).
 * A stage this client does not know yet is shown as the server names it.
 */
export const STAGE_LABELS: Record<string, string> = {
  triage: 'triage',
  classify: 'page classification',
  ocr: 'text recognition (OCR)',
  extract: 'extraction',
  reread: 'second reading',
  sheet_read: 'reading the spreadsheet',
  sheet_map: 'mapping the spreadsheet columns',
  sheet_extract: 'spreadsheet extraction',
};

/** A failed stage in words; '' without a stage. */
export function stageText(stage: string | null | undefined): string {
  const s = stage?.trim();
  if (!s) return '';
  return Object.hasOwn(STAGE_LABELS, s) ? STAGE_LABELS[s] : s.replace(/_/g, ' ');
}

/** "No boreholes found in this report" once extraction is through and the server counted none. */
export const NO_BOREHOLES_FOUND = 'No boreholes found in this report';

/**
 * Bottom-right hint of a card, in the prototype's order of precedence (failures first). A failure
 * names its stage when the server reported one (live, or the document's failed_stage) and the
 * server's detail.
 */
export function docHint(d: DocumentSummary, failure: JobFailure | null = null): HintView | null {
  if (failure) {
    const stage = stageText(failure.stage);
    return { text: stage ? `Extraction failed at ${stage}: ${failure.detail}` : `Extraction failed: ${failure.detail}`, tone: 'error' };
  }
  if (d.error) {
    const stage = stageText(d.failedStage);
    return { text: stage ? `Extraction failed at ${stage}: ${d.error}` : `Extraction failed: ${d.error}`, tone: 'error' };
  }
  if (canOpenReview(d)) return { text: 'OPEN REVIEW ›', tone: 'action' };
  if (d.step === 3) return { text: 'All boreholes reviewed', tone: 'muted' };
  if (d.simulated && d.step === 2) return { text: 'Simulated: live extraction needs an API key', tone: 'muted' };
  if (d.step < 2) return { text: 'Processing…', tone: 'muted' };
  if (d.counts?.boreholes === 0) return { text: NO_BOREHOLES_FOUND, tone: 'muted' };
  return null;
}

/* ---------- upload → map: what a processed document's card offers next ---------- */

/** What the store knows about a document's boreholes and questions, for its card's map steps. */
export interface MapStepInput {
  /** Pins of the document on the map. */
  pinned: number;
  /** The document's boreholes on the NOT ON MAP list, with their reason. */
  offMap: Pick<Borehole, 'uid' | 'unplottedReason'>[];
  /** Every unresolved question the store holds. */
  questions: readonly Clarification[];
  /** Uids of the document's boreholes the store knows (pins and records). */
  uids: readonly string[];
}

/**
 * One step a processed document's card offers on the way to the map:
 * - onMap: "N on the map · SHOW" (flies the map to the document's pins);
 * - crs: the coordinate system is needed: opens the CRS question (questionId), else the CRS dialog
 *   for the document (no question loaded);
 * - locate: a position question: opens it (a map_point: click the map to place the borehole);
 * - notOnMap: "N not on the map · WHY": opens the map's NOT ON MAP list (no question can place them).
 * Other questions keep the card's open-questions badge.
 */
export type MapStep =
  | { kind: 'onMap'; n: number }
  | { kind: 'crs'; n: number; questionId: string | null }
  | { kind: 'locate'; n: number; questionId: string }
  | { kind: 'notOnMap'; n: number };

const CRS_REASONS = new Set<Borehole['unplottedReason']>(['crs_unconfirmed', 'crs_unknown']);

/** True for an unresolved question about this document (asked about it, or about one of its boreholes). */
function concerns(c: Clarification, documentId: string, uids: ReadonlySet<string>): boolean {
  return c.status !== 'answered' && (c.documentId === documentId || c.boreholeUids.some((u) => uids.has(u)));
}

/**
 * The map steps of a document's card, in order: its pins, then what places the rest (a CRS question
 * or dialog, a position question) or, when nothing can, why they are not on the map. Nothing before
 * extraction is through, after a failure, or while its boreholes are not known yet.
 */
export function mapSteps(d: Pick<DocumentSummary, 'id' | 'step' | 'error' | 'status'>, input: MapStepInput): MapStep[] {
  if (d.step < 2 || d.error || d.status === 'failed') return [];
  const uids = new Set(input.uids);
  for (const b of input.offMap) uids.add(b.uid);
  const mine = input.questions.filter((c) => concerns(c, d.id, uids));
  const crsQuestion = mine.find((c) => c.kind === 'crs_confirm') ?? null;
  const locate = mine.find((c) => c.kind === 'locate_borehole') ?? null;
  const offCrs = input.offMap.filter((b) => CRS_REASONS.has(b.unplottedReason));
  const steps: MapStep[] = [];
  if (input.pinned > 0) steps.push({ kind: 'onMap', n: input.pinned });
  let explained = 0;
  if (crsQuestion || offCrs.length) {
    const n = offCrs.length || (crsQuestion ? crsQuestion.boreholeUids.filter((u) => uids.has(u)).length : 0);
    steps.push({ kind: 'crs', n, questionId: crsQuestion?.id ?? null });
    explained += offCrs.length;
  }
  if (locate) {
    steps.push({ kind: 'locate', n: locate.boreholeUids.length, questionId: locate.id });
    explained += input.offMap.filter((b) => !CRS_REASONS.has(b.unplottedReason) && locate.boreholeUids.includes(b.uid)).length;
  }
  // The rest is not on the map and no question here places it: how many, and WHY opens the list.
  const rest = input.offMap.length - explained;
  if (rest > 0) steps.push({ kind: 'notOnMap', n: rest });
  return steps;
}

/** Button text of a map step. */
export function mapStepText(s: MapStep): string {
  const need = (n: number) => (n === 1 ? '1 borehole needs' : `${n} boreholes need`);
  switch (s.kind) {
    case 'onMap':
      return `${s.n} on the map · SHOW`;
    case 'crs':
      return s.n > 0 ? `${need(s.n)} a coordinate system · CONFIRM` : 'Coordinate system needed · CONFIRM';
    case 'locate':
      return s.n > 0 ? `${need(s.n)} a position · PLACE` : 'Position needed · PLACE';
    case 'notOnMap':
      return `${s.n} not on the map · WHY`;
  }
}

/** Hover text of a map step's button. */
export function mapStepTitle(s: MapStep): string {
  switch (s.kind) {
    case 'onMap':
      return 'Open the map on the boreholes of this report';
    case 'crs':
      return s.questionId
        ? 'Answer the coordinate-system question: the server then places these boreholes on the map'
        : 'Choose the coordinate system of this report: the server then places its boreholes on the map';
    case 'locate':
      return 'Answer the position question: click the map where the borehole was drilled';
    case 'notOnMap':
      return 'Open the NOT ON MAP list under the map: it says why each borehole has no position';
  }
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
  const name = pageMeta(p).name;
  const role = p.role ? PAGE_ROLE_LABELS[p.role] : '';
  // The usage text names the duplicated page; say when that page is in another document.
  const elsewhere = p.duplicateOf && p.duplicateOf.documentId !== documentId ? `page ${p.duplicateOf.n} of another document` : '';
  return [
    `p.${p.n}`,
    name,
    usage,
    // A classified page without a type is named by its role already.
    role && role !== name && !usage.includes(role) ? `role: ${role}` : '',
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

/** Alt text of a page thumbnail: its number and type, e.g. "Page 3, log". */
export function thumbnailAlt(p: DocumentPage): string {
  return `Page ${p.n}, ${pageMeta(p).name}`;
}
