/** F12: the question dialog and its evidence pane, server-rendered (fictional questions only). */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageContent } from '../../domain/types';
import { ClarificationDialogView, type AnswerOutcome, type DialogBusy } from './ClarificationDialog';
import { DOC, DOC_B, makeClarification, makeEvidence, makeField } from './clarifyFixtures';
import { EvidenceCropView, EvidencePageView, hasNoPages } from './EvidencePane';
import { resetTestStore } from './testStore';

vi.mock('leaflet', () => ({}));
vi.mock('../../store/appStore', async (importOriginal) => (await import('./testStore')).mockAppStore(await importOriginal()));

beforeEach(() => resetTestStore());

const QUESTION = makeClarification({
  kind: 'unit_ambiguous',
  question: 'The fictional unit weight is printed without a unit. Which unit is it?',
  fields: [
    makeField({ name: 'value', widget: 'number_unit', label: 'Unit weight', required: true, unitOptions: ['kN/m3', 't/m3'], default: 19.6 }),
    makeField({ name: 'note', widget: 'text', label: 'Note' }),
  ],
});

function render(o: { name?: string | null; busy?: DialogBusy; outcome?: AnswerOutcome | null; question?: typeof QUESTION; documentName?: string | null } = {}) {
  return renderToStaticMarkup(
    <ClarificationDialogView
      clarification={o.question ?? QUESTION}
      documentName={o.documentName === undefined ? 'fictional-report.pdf' : o.documentName}
      boreholes="BH-1, BH-2"
      reviewerName={o.name ?? null}
      ctx={{ pageCount: 9, crs: { status: 'idle', candidates: [], error: null }, reference: [], labels: {} }}
      busy={o.busy ?? null}
      outcome={o.outcome ?? null}
      onAnswer={() => undefined}
      onSkip={() => undefined}
      onClose={() => undefined}
      evidence={<section aria-label="Evidence">pages</section>}
    />,
  );
}

describe('ClarificationDialogView', () => {
  it('is a labelled modal with the kind, the file, the boreholes, the time asked and the question', () => {
    const html = render();
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="[^"]+-title" aria-describedby="[^"]+-question"/);
    expect(html).toContain('QUESTION · UNIT</h2>');
    expect(html).toContain('fictional-report.pdf · BH-1, BH-2 · asked <time dateTime="2026-10-17T07:33:15Z">');
    expect(html).toContain('The fictional unit weight is printed without a unit. Which unit is it?');
    expect(html).toContain('aria-label="Evidence"');
    // Inputs start from the server's default; the unit is left to the reviewer.
    expect(html).toMatch(/<input[^>]*value="19.6"/);
    expect(html).toContain('<option value="" selected="">Unit…</option>');
    expect(html).toContain('>ANSWER</button>');
    expect(html).toContain('>SKIP FOR NOW</button>');
  });

  it('a document the app has not loaded is named by its id, not a made-up name', () => {
    expect(render({ documentName: null })).toContain(`Document ${DOC} (not loaded)`);
  });

  it('says "Stored with your name" only when a name is set', () => {
    expect(render({ name: 'A. Reviewer (fictional)' })).toContain('Stored with your name (A. Reviewer (fictional)).');
    const anon = render();
    expect(anon).not.toContain('Stored with your name');
    expect(anon).toContain('No name is set: the answer is stored without one.');
  });

  it('shows the server’s message on top and its field errors next to the fields', () => {
    const html = render({ outcome: { message: 'The answer does not match the question’s fields.', fieldErrors: { value: 'Unit weight: choose one of the offered units.' } } });
    expect(html).toMatch(/role="alert">The answer does not match the question’s fields\.</);
    expect(html).toContain('Unit weight: choose one of the offered units.');
    // The part that is wrong is marked: the unit is not chosen yet, the number is fine.
    expect(html).toMatch(/<select[^>]*aria-label="Unit weight: unit"[^>]*aria-invalid="true"/);
    expect(html).not.toMatch(/<input[^>]*aria-invalid="true"[^>]*value="19.6"/);
    // The other field is not marked.
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
  });

  it('a skipped question says so; SKIP FOR NOW is off with the reason', () => {
    const html = render({ question: { ...QUESTION, status: 'skipped' } });
    expect(html).toContain('>SKIPPED</span>');
    const skip = html.match(/<button[^>]*>SKIP FOR NOW<\/button>/)?.[0] ?? '';
    expect(skip).toContain('disabled=""');
    expect(skip).toContain('title="Already skipped: the question stays in the inbox until it is answered"');
  });

  it('while answering, both buttons are off and ANSWER says so', () => {
    const html = render({ busy: 'answer' });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>ANSWERING…<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>SKIP FOR NOW<\/button>/);
  });

  it('marks required fields and explains the mark', () => {
    const html = render();
    expect(html).toMatch(/Unit weight<span[^>]*aria-hidden="true"> \*<\/span>/);
    expect(html).toContain('required</p>');
  });
});

const PAGE: PageContent = { documentId: DOC, page: 6, type: 'log', usage: 'used', label: 'page 6 · fictional-report.pdf', items: [] };
const IMAGE_PAGE: PageContent = { ...PAGE, imageUrl: '/api/v1/documents/doc_X/pages/6.png' };

describe('EvidencePageView', () => {
  const one = { documentId: DOC, page: 6, boxes: [{ x: 0.08, y: 0.41, w: 0.06, h: 0.02 }], snippets: ['9,50 / 9,80 (handwritten)'] };

  it('shows the page with its box highlighted and the text as printed, captioned as the original', () => {
    const html = renderToStaticMarkup(<EvidencePageView page={one} load={{ status: 'ready', content: PAGE }} otherFile={null} fileName="fictional-report.pdf" noPages={false} />);
    expect(html).toContain('aria-label="Page 6"');
    expect(html).toMatch(/ORIGINAL<\/span> · fictional-report\.pdf, page 6 \(as uploaded\)/);
    expect(html).toContain('“9,50 / 9,80 (handwritten)”');
    expect(html).toMatch(/class="[^"]*highlight[^"]*" style="left:8%;top:41%;width:6%;height:2%"/);
  });

  it('an uploaded page image draws no box until it has loaded, and says it is loading the scan', () => {
    const html = renderToStaticMarkup(<EvidencePageView page={one} load={{ status: 'ready', content: IMAGE_PAGE }} otherFile={null} noPages={false} />);
    expect(html).toContain('src="/api/v1/documents/doc_X/pages/6.png"');
    expect(html).toContain('Loading the original scan… · page 6');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/class="[^"]*highlight/);
  });

  it('several boxes on one page are outlined, none dims the others', () => {
    const two = { ...one, boxes: [one.boxes[0], { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], snippets: ['a', 'b'] };
    const html = renderToStaticMarkup(<EvidencePageView page={two} load={{ status: 'ready', content: PAGE }} otherFile={null} noPages={false} />);
    expect(html.match(/class="[^"]*focus[^"]*"/g)).toHaveLength(2);
    expect(html).not.toMatch(/class="[^"]*highlight/);
  });

  it('names another document’s file; says when a page has no box', () => {
    const html = renderToStaticMarkup(
      <EvidencePageView page={{ documentId: DOC_B, page: 3, boxes: [], snippets: [] }} load={{ status: 'ready', content: PAGE }} otherFile="fictional-copy.pdf" noPages={false} />,
    );
    expect(html).toContain('Page 3 · fictional-copy.pdf');
    expect(html).toContain('no box on this page');
  });

  it('loading, a page that fails, and a document without pages (a spreadsheet)', () => {
    expect(renderToStaticMarkup(<EvidencePageView page={one} load={{ status: 'loading' }} otherFile={null} noPages={false} />)).toContain('Loading page 6…');
    expect(renderToStaticMarkup(<EvidencePageView page={one} load={{ status: 'error', error: 'Page 6 not found' }} otherFile={null} noPages={false} />)).toContain(
      'Page 6 can’t be shown: Page 6 not found',
    );
    const sheet = renderToStaticMarkup(<EvidencePageView page={one} load={{ status: 'loading' }} otherFile={null} noPages />);
    expect(sheet).toContain('No page image: this document has no pages (for example a spreadsheet).');
    expect(sheet).not.toContain('Loading');
  });

  it('a processed document without pages has no page images; one still being read may get them', () => {
    expect(hasNoPages({ pages: [], step: 3 })).toBe(true);
    expect(hasNoPages({ pages: [], step: 0 })).toBe(false);
    expect(hasNoPages(undefined)).toBe(false);
  });
});

describe('EvidenceCropView', () => {
  it('centres the box in the crop and outlines it', () => {
    const ev = makeEvidence({ page: 6, box: { x: 0.08, y: 0.41, w: 0.06, h: 0.02 }, snippet: '9,80' });
    const html = renderToStaticMarkup(<EvidenceCropView evidence={ev} load={{ status: 'ready', content: PAGE }} width={220} height={64} />);
    expect(html).toContain('role="img" aria-label="Page 6: “9,80”"');
    expect(html).toContain('style="width:220px;height:64px"');
    expect(html).toContain('transform:translate(-11%, -42%)');
    expect(html).toMatch(/class="[^"]*focus[^"]*" style="left:8%;top:41%;width:6%;height:2%"/);
  });

  it('says why there is no crop', () => {
    const ev = makeEvidence({ page: 6, box: null, snippet: '9,80' });
    expect(renderToStaticMarkup(<EvidenceCropView evidence={ev} load={{ status: 'ready', content: PAGE }} />)).toContain('Page 6: “9,80”, no box');
    expect(renderToStaticMarkup(<EvidenceCropView evidence={ev} load={{ status: 'loading' }} />)).toContain('Loading page 6…');
    expect(renderToStaticMarkup(<EvidenceCropView evidence={ev} load={{ status: 'error', error: 'x' }} />)).toContain('Page 6 can’t be shown');
  });
});
