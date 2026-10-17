/**
 * Server-rendered Source panel view (fictional values): page, box, cell, values on no page (uiv-6),
 * page-less boreholes, values from another document and classified pages of unknown type.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import type { PageContent } from '../domain/types';
import { makeDocument, makePage, makeValue } from '../test/fixtures';
import { SourcePanelView } from './SourcePanel';

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
