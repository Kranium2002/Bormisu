/**
 * Server-rendered Source panel view (fictional values): page, box, cell, values on no page (uiv-6),
 * page-less boreholes, values from another document and classified pages of unknown type.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import type { PageContent } from '../domain/types';
import { makeDocument, makePage, makeValue } from '../test/fixtures';
import { sourceStop, SourcePanelView } from './SourcePanel';

const doc = makeDocument();
const guessed = makeValue({ key: K.country, label: 'Country', value: 'Fictionland', raw: '', page: null, box: null, method: 'Guessed', confidence: null });
const onPage = makeValue({ key: K.finalDepth, label: 'Final depth', value: '6.00', raw: '6,00 m', page: 1, box: null });
const content: PageContent = { documentId: doc.id, page: 1, type: 'log', usage: 'used: log sheet', label: 'page 1 · test_report.pdf', items: [] };
const LOADING = { status: 'loading' } as const;
const NO_PAGE = { status: 'error', error: 'No source page for this value' } as const;

describe('SourcePanelView', () => {
  it('a guessed value on no page says so; it claims no page and no missing box', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView panel={{ kind: 'source', uid: 'bh_X', key: K.country, documentId: doc.id, page: null, box: null }} value={guessed} doc={doc} page={NO_PAGE} />,
    );
    expect(html).toContain('Not printed on a page: this value was guessed, so there is no page to show.');
    expect(html).not.toContain('Box not found');
    expect(html).not.toContain('No source page for this value');
    expect(html).not.toContain('page null');
  });

  it('a value on a page without a box shows the page and says the box was not found', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView
        panel={{ kind: 'source', uid: 'bh_X', key: K.finalDepth, documentId: doc.id, page: 1, box: null }}
        value={onPage}
        doc={doc}
        page={{ status: 'ready', content }}
      />,
    );
    expect(html).toContain('Box not found: page shown');
    expect(html).toContain('page 1 · test_report.pdf');
    expect(html).toContain('as printed: “6,00 m”');
  });

  it('a page still loading says so', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView panel={{ kind: 'source', documentId: doc.id, page: 3, box: null, pageOnly: true }} value={undefined} doc={doc} page={LOADING} />,
    );
    expect(html).toContain('Loading page 3…');
  });

  it('PRIMARY-PAGE-NULL: no page and no value says "No source page", never "page null"', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView panel={{ kind: 'source', uid: 'bh_X', key: 'x', documentId: doc.id, page: null, box: null }} value={undefined} doc={doc} page={NO_PAGE} />,
    );
    expect(html).toContain('No source page for this borehole.');
    expect(html).not.toContain('null');
    expect(html).not.toContain('role="alert"');
  });
});

describe('DV-11-UI: a value whose source is in another document', () => {
  const LAB = 'doc_FICTIONAL_LAB_0000000000001';
  const lab = makeDocument({ id: LAB, name: 'fictional-lab-results.xlsx', pages: [] });
  const ucs = makeValue({ key: K.test(0), label: 'UCS', value: '12.5', page: null, cell: 'Lab!D7', documentId: LAB });
  const su = makeValue({ key: K.test(1), label: 'Su', value: '40', page: 3, box: null, documentId: LAB });

  it('names that document’s file next to the cell', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView panel={{ kind: 'source', uid: 'bh_X', key: ucs.key, documentId: LAB, page: null, box: null, cell: 'Lab!D7' }} value={ucs} doc={lab} page={NO_PAGE} />,
    );
    expect(html).toContain('fictional-lab-results.xlsx · cell Lab!D7');
    expect(html).not.toContain('test_report.pdf');
  });

  it('says “another document” while that document is not loaded, for a cell and for a page', () => {
    const cell = renderToStaticMarkup(
      <SourcePanelView panel={{ kind: 'source', uid: 'bh_X', key: ucs.key, documentId: LAB, page: null, box: null, cell: 'Lab!D7' }} value={ucs} doc={undefined} page={NO_PAGE} />,
    );
    expect(cell).toContain('another document · cell Lab!D7');
    expect(cell).not.toContain('spreadsheet · cell');
    const page = renderToStaticMarkup(
      <SourcePanelView panel={{ kind: 'source', uid: 'bh_X', key: su.key, documentId: LAB, page: 3, box: null }} value={su} doc={undefined} page={LOADING} />,
    );
    expect(page).toContain('page 3 · another document');
    expect(page).toContain('Loading page 3…');
  });

  it('names the borehole’s own file when its document is not in the store', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView
        panel={{ kind: 'source', uid: 'bh_X', key: onPage.key, documentId: doc.id, page: 1, box: null }}
        value={onPage}
        doc={undefined}
        ownFile="own_log.pdf"
        page={LOADING}
      />,
    );
    expect(html).toContain('page 1 · own_log.pdf');
  });
});

describe('FE-QUEUE-1: a classified page of unknown type', () => {
  it('is named by its role, not “not classified yet”', () => {
    const dupDoc = makeDocument({
      pages: [makePage({ n: 1 }), makePage({ n: 2, type: 'unknown', role: 'duplicate', used: false, duplicateOf: { documentId: doc.id, n: 1 } })],
    });
    const dup: PageContent = { documentId: doc.id, page: 2, type: 'unknown', usage: 'unused: duplicate of page 1', label: 'page 2 · test_report.pdf', items: [] };
    const html = renderToStaticMarkup(
      <SourcePanelView panel={{ kind: 'source', documentId: doc.id, page: 2, box: null, pageOnly: true }} value={undefined} doc={dupDoc} page={{ status: 'ready', content: dup }} />,
    );
    expect(html).toContain('duplicate page · unused: duplicate of page 1');
    expect(html).not.toContain('not classified yet');
  });
});

describe('SourcePanelView: correcting the value', () => {
  const panel = { kind: 'source' as const, uid: 'bh_X', key: K.finalDepth, documentId: doc.id, page: 1, box: null };
  const ready = { status: 'ready', content } as const;

  it('shows a field with the value and CONFIRM (nothing changed yet), and OPEN FULL REVIEW', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView panel={panel} value={onPage} doc={doc} page={ready} onCorrect={() => undefined} onOpenInReview={() => undefined} />,
    );
    expect(html).toContain('aria-label="Corrected value for Final depth"');
    expect(html).toContain('value="6.00"');
    expect(html).toContain('>CONFIRM</button>');
    expect(html).toContain('OPEN FULL REVIEW ›');
  });

  it('a read-only value can only be confirmed and says why', () => {
    const crs = makeValue({ key: K.crs, label: 'CRS', value: 'EPSG:25832', page: 1, box: null, readOnlyReason: 'Set the CRS in the CRS dialog' });
    const html = renderToStaticMarkup(<SourcePanelView panel={{ ...panel, key: K.crs }} value={crs} doc={doc} page={ready} onCorrect={() => undefined} />);
    expect(html).toContain('readOnly=""');
    expect(html).toContain('Set the CRS in the CRS dialog');
    expect(html).toContain('>CONFIRM</button>');
  });

  it('a value without a provenance entry says it can’t be corrected', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView panel={panel} value={{ ...onPage, hasProvenance: false }} doc={doc} page={ready} onCorrect={() => undefined} />,
    );
    expect(html).not.toContain('Corrected value for');
    expect(html).toContain('can’t be corrected here');
  });

  it('has no field without a correction action (a page opened from the queue)', () => {
    const html = renderToStaticMarkup(<SourcePanelView panel={panel} value={onPage} doc={doc} page={ready} />);
    expect(html).not.toContain('Corrected value for');
  });
});

describe('a value cited on several pages', () => {
  const sources = [
    { page: 1, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } },
    { page: 2, box: null },
  ];
  const opened = { kind: 'source' as const, uid: 'bh_X', key: K.finalDepth, documentId: doc.id, page: 1, box: sources[0].box, sources };

  it('steps to each page with its box, or none', () => {
    expect(sourceStop(opened, 0)).toMatchObject({ page: 1, box: sources[0].box });
    expect(sourceStop(opened, 1)).toMatchObject({ page: 2, box: null });
    // Out of range or without sources: the panel as opened.
    expect(sourceStop({ ...opened, sources: undefined }, 1)).toMatchObject({ page: 1 });
  });

  it('shows ‹ source i of N › and says when this page has no box', () => {
    const second = renderToStaticMarkup(
      <SourcePanelView
        panel={sourceStop(opened, 1)}
        value={onPage}
        doc={doc}
        page={{ status: 'ready', content: { ...content, page: 2 } }}
        stepper={{ index: 1, count: 2, onStep: () => undefined }}
      />,
    );
    expect(second).toContain('source 2 of 2 · page 2');
    expect(second).toContain('No box on this page');
    expect(second).not.toContain('Box not found');
    expect(second).toMatch(/aria-label="Next source" disabled=""/);
    const first = renderToStaticMarkup(
      <SourcePanelView panel={sourceStop(opened, 0)} value={onPage} doc={doc} page={LOADING} stepper={{ index: 0, count: 2, onStep: () => undefined }} />,
    );
    expect(first).toContain('source 1 of 2 · page 1');
    expect(first).toMatch(/aria-label="Previous source" disabled=""/);
  });

  it('a value on one page has no stepper', () => {
    const html = renderToStaticMarkup(
      <SourcePanelView panel={{ ...opened, sources: undefined }} value={onPage} doc={doc} page={LOADING} />,
    );
    expect(html).not.toContain('Sources of this value');
  });
});
