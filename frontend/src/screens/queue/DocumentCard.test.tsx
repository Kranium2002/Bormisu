/** Server-rendered document card (fictional document): progress, questions, duplicates, retry. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { placeholderPage } from '../../domain/pages';
import { makeDocument, makePage } from '../../test/fixtures';
import { DocumentCard } from './DocumentCard';

const noop = () => undefined;

describe('DocumentCard', () => {
  it('shows progress bars, open questions and the page map from the classified pages', () => {
    const doc = makeDocument({
      status: 'extracting', step: 1, openClarifications: 2,
      pages: [makePage({ n: 1, ocr: 'done' }), placeholderPage(2)],
      progress: { pagesTotal: 2, pagesClassified: 1, pagesOcrTotal: 1, pagesOcrDone: 1, boreholesExtracted: 0 },
    });
    const html = renderToStaticMarkup(<DocumentCard doc={doc} onShowDocument={noop} />);
    expect(html).toContain('pages classified 1/2');
    expect(html).toContain('OCR 1/1');
    expect(html).toContain('0 boreholes extracted');
    expect(html).toContain('2 open questions');
    expect(html).toContain('title="p.1 · log · used: log sheet · OCR done"');
    expect(html).toContain('title="p.2 · not classified yet"');
  });

  it('shows a failure with RETRY, and a duplicate of an unlisted upload as text', () => {
    const doc = makeDocument({ status: 'failed', step: 1, error: 'OCR timeout', duplicateOf: 'doc_EARLIER' });
    const html = renderToStaticMarkup(<DocumentCard doc={doc} onShowDocument={noop} />);
    expect(html).toContain('Extraction failed: OCR timeout');
    expect(html).toContain('>RETRY</button>');
    expect(html).toContain('Same file as an earlier upload');
  });
});
