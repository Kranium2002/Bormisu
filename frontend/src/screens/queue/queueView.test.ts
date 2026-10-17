import { describe, expect, it } from 'vitest';
import { makeClarification } from '../../components/clarify/clarifyFixtures';
import type { Borehole, Clarification, DocumentSummary } from '../../domain/types';
import { makeDocument, makePage } from '../../test/fixtures';
import { placeholderPage } from '../../domain/pages';
import {
  canOpenPage,
  canOpenReview,
  countChips,
  docHint,
  docMeta,
  duplicateText,
  mapSteps,
  mapStepText,
  mapStepTitle,
  NO_BOREHOLES_FOUND,
  pageTitle,
  progressView,
  questionsText,
  stageText,
  stepViews,
  type MapStep,
  type MapStepInput,
} from './queueView';

const doc = (over: Partial<DocumentSummary> = {}): DocumentSummary =>
  makeDocument({
    id: 'doc_TEST_Q1', name: 'report.pdf', project: 'Test project',
    pages: [makePage({ n: 1, type: 'text', role: 'cover_or_toc', used: false }), makePage({ n: 2, type: 'text', role: 'narrative', used: false }), makePage({ n: 3 })],
    step: 2, counts: { boreholes: 1, layers: 4, spt: 0, groundwater: 2 },
    ...over,
  });

describe('stepViews', () => {
  it('pulses the active machine step and greys the rest', () => {
    expect(stepViews(1).map((s) => [s.state, s.pulse])).toEqual([
      ['done', false], ['active', true], ['pending', false], ['pending', false],
    ]);
  });

  it('shows needs review as amber without pulse', () => {
    expect(stepViews(2).map((s) => s.state)).toEqual(['done', 'done', 'review', 'pending']);
    expect(stepViews(2).some((s) => s.pulse)).toBe(false);
  });

  it('marks every step done at step 3', () => {
    expect(stepViews(3).every((s) => s.state === 'done')).toBe(true);
  });

  it('marks the current step failed instead of active', () => {
    const v = stepViews(1, true);
    expect(v[1]).toEqual({ label: 'extracting', state: 'failed', pulse: false });
  });
});

describe('docHint', () => {
  it('offers review only when a review borehole exists and extraction is through', () => {
    expect(docHint(doc({ reviewBoreholeUid: 'bh_1' }))).toEqual({ text: 'OPEN REVIEW ›', tone: 'action' });
    expect(canOpenReview(doc({ reviewBoreholeUid: 'bh_1', step: 1 }))).toBe(false);
    expect(canOpenReview(doc({ reviewBoreholeUid: 'bh_1', error: 'boom' }))).toBe(false);
  });

  it('follows the prototype order for the other states', () => {
    expect(docHint(doc({ step: 3 }))?.text).toBe('All boreholes reviewed');
    expect(docHint(doc({ step: 2, simulated: true, uploaded: true }))?.text).toBe('Simulated: live extraction needs an API key');
    expect(docHint(doc({ step: 0 }))?.text).toBe('Processing…');
    expect(docHint(doc({ step: 2 }))).toBeNull();
  });

  it('shows failures in red', () => {
    expect(docHint(doc({ step: 1, error: 'OCR timeout' }))).toEqual({ text: 'Extraction failed: OCR timeout', tone: 'error' });
  });

  it('1.2.0: names the failed stage (the document’s failed_stage, or the stage reported live)', () => {
    expect(docHint(doc({ step: 1, error: 'OCR timeout', failedStage: 'ocr' }))?.text).toBe('Extraction failed at text recognition (OCR): OCR timeout');
    expect(docHint(doc({ step: 1, error: 'x', failedStage: 'sheet_map' }), { stage: 'reread', detail: 'Model busy.', retryable: true })?.text).toBe(
      'Extraction failed at second reading: Model busy.',
    );
    // A stage this client does not know yet is named as the server names it.
    expect(docHint(doc({ step: 1, error: 'x', failedStage: 'new_stage' }))?.text).toBe('Extraction failed at new stage: x');
    expect(stageText(null)).toBe('');
  });

  it('says so when extraction is through and the server found no borehole', () => {
    expect(docHint(doc({ step: 2, counts: { boreholes: 0, layers: 0, spt: 0, groundwater: 0 } }))?.text).toBe(NO_BOREHOLES_FOUND);
  });
});

describe('upload → map: the map steps of a processed card', () => {
  const D = 'doc_TEST_Q1';
  const off = (uid: string, unplottedReason: Borehole['unplottedReason']) => ({ uid, unplottedReason });
  const q = (o: Partial<Clarification>) => makeClarification({ documentId: D, ...o });
  const steps = (input: Partial<MapStepInput>, over: Partial<DocumentSummary> = {}) =>
    mapSteps(doc(over), { pinned: 0, offMap: [], questions: [], uids: [], ...input });

  it('"N on the map · SHOW" for the pinned boreholes', () => {
    expect(steps({ pinned: 3 })).toEqual([{ kind: 'onMap', n: 3 }]);
    expect(mapStepText({ kind: 'onMap', n: 3 })).toBe('3 on the map · SHOW');
  });

  it('nothing before extraction is through or after a failure', () => {
    expect(steps({ pinned: 3 }, { step: 1 })).toEqual([]);
    expect(steps({ pinned: 3 }, { error: 'boom', status: 'failed' })).toEqual([]);
  });

  it('an unresolved crs_confirm question: CONFIRM opens it; without a question the CRS dialog (questionId null)', () => {
    const crs = q({ id: 'cl_crs', kind: 'crs_confirm', boreholeUids: ['a', 'b', 'x_other_doc'] });
    const offCrs = [off('a', 'crs_unconfirmed'), off('b', 'crs_unknown')];
    expect(steps({ pinned: 1, offMap: offCrs, questions: [crs], uids: ['p', 'a', 'b'] })).toEqual([
      { kind: 'onMap', n: 1 },
      { kind: 'crs', n: 2, questionId: 'cl_crs' },
    ]);
    expect(steps({ offMap: offCrs })).toEqual([{ kind: 'crs', n: 2, questionId: null }]);
    expect(mapStepText({ kind: 'crs', n: 2, questionId: null })).toBe('2 boreholes need a coordinate system · CONFIRM');
    // An answered question is no next step.
    expect(steps({ questions: [{ ...crs, status: 'answered' }] })).toEqual([]);
    // A question about another document's boreholes only is not this card's.
    expect(steps({ questions: [q({ id: 'cl_x', kind: 'crs_confirm', documentId: 'doc_OTHER', boreholeUids: ['x'] })] })).toEqual([]);
  });

  it('a locate_borehole question: PLACE opens it (click the map), and explains its boreholes', () => {
    const locate = q({ id: 'cl_loc', kind: 'locate_borehole', boreholeUids: ['c'] });
    expect(steps({ offMap: [off('c', 'no_coordinates')], questions: [locate], uids: ['c'] })).toEqual([
      { kind: 'locate', n: 1, questionId: 'cl_loc' },
    ]);
    expect(mapStepText({ kind: 'locate', n: 1, questionId: 'cl_loc' })).toBe('1 borehole needs a position · PLACE');
  });

  it('"N not on the map · WHY" for boreholes no question places', () => {
    expect(steps({ offMap: [off('c', 'no_coordinates'), off('d', 'implausible')], uids: ['c', 'd'] })).toEqual([{ kind: 'notOnMap', n: 2 }]);
    expect(mapStepText({ kind: 'notOnMap', n: 2 })).toBe('2 not on the map · WHY');
    // Other questions (e.g. a unit) keep the open-questions badge; they are no map step.
    expect(steps({ offMap: [off('c', 'no_coordinates')], questions: [q({ id: 'cl_u', kind: 'unit_ambiguous', boreholeUids: ['c'] })], uids: ['c'] })).toEqual([
      { kind: 'notOnMap', n: 1 },
    ]);
  });

  it('every step has a hover text', () => {
    for (const s of [
      { kind: 'onMap', n: 1 }, { kind: 'crs', n: 1, questionId: 'q' }, { kind: 'crs', n: 1, questionId: null },
      { kind: 'locate', n: 1, questionId: 'q' }, { kind: 'notOnMap', n: 1 },
    ] as MapStep[]) {
      expect(mapStepTitle(s)).not.toBe('');
    }
  });
});

describe('docMeta', () => {
  it('joins page count and project', () => {
    expect(docMeta(doc())).toBe('3 pages · Test project');
    expect(docMeta(doc({ pages: [makePage({ n: 1 })], project: '' }))).toBe('1 page');
    expect(docMeta(doc({ pages: [], project: '', uploaded: true }))).toBe('Uploaded, waiting for page count');
  });
});

describe('countChips', () => {
  it('keeps 0 as 0 and null as not processed', () => {
    expect(countChips(null)).toBeNull();
    expect(countChips({ boreholes: 13, layers: 1, spt: 0, groundwater: 9 })).toEqual([
      { n: 13, label: 'BH' }, { n: 1, label: 'layer' }, { n: 0, label: 'SPT' }, { n: 9, label: 'GW readings' },
    ]);
  });
});

describe('progress, questions and duplicates', () => {
  it('shows classified pages and OCR as bars, and the boreholes extracted', () => {
    const v = progressView({ pagesTotal: 28, pagesClassified: 14, pagesOcrTotal: 4, pagesOcrDone: 1, boreholesExtracted: 1 });
    expect(v.bars).toEqual([
      { label: 'pages classified', done: 14, total: 28, pct: 50 },
      { label: 'OCR', done: 1, total: 4, pct: 25 },
    ]);
    expect(v.boreholes).toBe('1 borehole extracted');
  });

  it('leaves out the OCR bar when no page needs OCR, and never divides by 0', () => {
    const v = progressView({ pagesTotal: 0, pagesClassified: 0, pagesOcrTotal: 0, pagesOcrDone: 0, boreholesExtracted: 0 });
    expect(v.bars).toEqual([{ label: 'pages classified', done: 0, total: 0, pct: 0 }]);
    expect(v.boreholes).toBe('0 boreholes extracted');
  });

  it('counts open questions', () => {
    expect(questionsText(doc({ openClarifications: 0 }))).toBeNull();
    expect(questionsText(doc({ openClarifications: 1 }))).toBe('1 open question');
    expect(questionsText(doc({ openClarifications: 3 }))).toBe('3 open questions');
  });

  it('names the earlier upload of the same file', () => {
    const first = doc({ id: 'doc_A', name: 'first.pdf' });
    expect(duplicateText(doc({ duplicateOf: 'doc_A' }), [first])).toBe('Same file as first.pdf');
    expect(duplicateText(doc({ duplicateOf: 'doc_GONE' }), [first])).toBe('Same file as an earlier upload');
    expect(duplicateText(doc(), [first])).toBeNull();
  });
});

describe('page strip', () => {
  it('titles pages with what the backend reported', () => {
    expect(pageTitle(makePage({ n: 7, sheetLabel: '2', ocr: 'done', handwriting: 'partial' }), 'doc_A')).toBe(
      'p.7 · log · used: log sheet · sheet 2 · OCR done · handwriting: partial',
    );
    expect(pageTitle(makePage({ n: 1, type: 'text', role: 'cover_or_toc', used: false, unusedReason: 'cover page', ocr: null, handwriting: 'none' }), 'doc_A')).toBe(
      'p.1 · text · unused: cover page · role: cover or contents',
    );
    expect(pageTitle(makePage({ n: 9, used: false, ocr: 'skipped', duplicateOf: { documentId: 'doc_A', n: 3 } }), 'doc_A')).toBe(
      'p.9 · log · unused: duplicate of page 3 · role: log sheet · OCR skipped',
    );
    expect(pageTitle(makePage({ n: 4, used: false, ocr: null, duplicateOf: { documentId: 'doc_B', n: 3 } }), 'doc_A')).toBe(
      'p.4 · log · unused: duplicate of page 3 · role: log sheet · page 3 of another document',
    );
    expect(pageTitle(placeholderPage(30), 'doc_A')).toBe('p.30 · not classified yet');
  });

  it('only opens classified pages', () => {
    expect(canOpenPage(placeholderPage(2))).toBe(false);
    expect(canOpenPage(makePage({ n: 2, type: 'photo' }))).toBe(true);
  });

  it('FE-QUEUE-1: a classified page of unknown type is named by its role, never "not classified yet"', () => {
    const dup = makePage({ n: 2, type: 'unknown', role: 'duplicate', used: false, ocr: 'skipped', sheetLabel: 'SHEET 1 OF 1', duplicateOf: { documentId: 'doc_A', n: 3 } });
    expect(pageTitle(dup, 'doc_A')).toBe('p.2 · duplicate page · unused: duplicate of page 3 · sheet SHEET 1 OF 1 · OCR skipped');
    const blank = makePage({ n: 5, type: 'unknown', role: 'blank', used: false, ocr: null, handwriting: 'none' });
    expect(pageTitle(blank, 'doc_A')).toBe('p.5 · blank page · unused: blank page');
    const noRole = makePage({ n: 6, type: 'unknown', role: null, used: false, ocr: null, handwriting: 'none' });
    expect(pageTitle(noRole, 'doc_A')).toBe('p.6 · type unknown · unused: type unknown');
    expect(canOpenPage(dup)).toBe(true);
  });
});
