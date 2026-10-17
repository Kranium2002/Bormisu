import { describe, expect, it } from 'vitest';
import type { DocumentSummary } from '../../domain/types';
import { canOpenPage, canOpenReview, countChips, docHint, docMeta, dropErrorText, pageTitle, stepViews } from './queueView';

const doc = (over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id: 'd1', name: 'report.pdf', project: 'Test project',
  pageTypes: ['text', 'text', 'log'], step: 2,
  counts: { boreholes: 1, layers: 4, spt: 0, groundwater: 2 },
  completeness: null, reviewBoreholeUid: null,
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
    expect(docHint(doc({ reviewBoreholeUid: 'd1:BK-01' }))).toEqual({ text: 'OPEN IN REVIEW ›', tone: 'action' });
    expect(canOpenReview(doc({ reviewBoreholeUid: 'd1:BK-01', step: 1 }))).toBe(false);
    expect(canOpenReview(doc({ reviewBoreholeUid: 'd1:BK-01', error: 'boom' }))).toBe(false);
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
});

describe('docMeta', () => {
  it('joins page count and project', () => {
    expect(docMeta(doc())).toBe('3 pages · Test project');
    expect(docMeta(doc({ pageTypes: ['log'], project: '' }))).toBe('1 page');
    expect(docMeta(doc({ pageTypes: [], project: '', uploaded: true }))).toBe('Uploaded, waiting for page count');
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

describe('page strip', () => {
  it('titles pages with type and usage', () => {
    expect(pageTitle('text', 1)).toBe('p.1 · text · used: project metadata');
    expect(pageTitle('text', 5)).toBe('p.5 · text · unused: text');
    expect(pageTitle('log', 7)).toBe('p.7 · log · used: borehole log');
    expect(pageTitle('unknown', 30)).toBe('p.30 · not classified yet');
  });

  it('only opens classified pages', () => {
    expect(canOpenPage('unknown')).toBe(false);
    expect(canOpenPage('photo')).toBe(true);
  });
});

describe('dropErrorText', () => {
  it('says what to do after an unsupported file type', () => {
    expect(dropErrorText('File type not supported: notes.txt')).toBe('File type not supported: notes.txt. Use PDF, DOCX, JPG or PNG.');
    expect(dropErrorText('File type not supported: a.txt, b.xls')).toBe('File type not supported: a.txt, b.xls. Use PDF, DOCX, JPG or PNG.');
  });

  it('shows other upload errors as one sentence, without the file-type advice', () => {
    expect(dropErrorText('Upload failed: 413 Payload Too Large')).toBe('Upload failed: 413 Payload Too Large.');
    expect(dropErrorText('Cannot reach the Bormisu backend.')).toBe('Cannot reach the Bormisu backend.');
  });
});
