/** Server-rendered Source panel view (fictional values): page, box, cell, and values on no page (uiv-6). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { K } from '../domain/keys';
import type { PageContent } from '../domain/types';
import { makeDocument, makeValue } from '../test/fixtures';
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
});
