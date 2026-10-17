/** Server-rendered document card (fictional document): progress, questions, duplicates, retry. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { placeholderPage } from '../../domain/pages';
import type { Health } from '../../domain/types';
import { makeHealth } from '../../store/testing';
import { retryBlockedReason } from '../../store/uploads';
import { makeDocument, makePage } from '../../test/fixtures';
import { CLASSIFIED_UNKNOWN_PAGE, PAGE_TYPE_META } from '../../theme';
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

  describe('BE-RETRY-1: RETRY by server mode', () => {
    const failed = makeDocument({ status: 'failed', step: 1, error: 'OCR timeout' });
    const retryButton = (health: Health | null) =>
      renderToStaticMarkup(<DocumentCard doc={failed} retryBlocked={retryBlockedReason(health)} onShowDocument={noop} />).match(
        /<button[^>]*>RETRY<\/button>/,
      )?.[0] ?? '';

    it('is disabled in demo mode with the reason', () => {
      const button = retryButton(makeHealth({ mode: 'demo' }));
      expect(button).toContain('disabled=""');
      expect(button).toContain('title="Live extraction needs API keys"');
      expect(button).toContain('aria-description="Live extraction needs API keys"');
    });

    it.each(['live', 'sample'] as const)('works in %s mode', (mode) => {
      expect(retryButton(makeHealth({ mode }))).not.toContain('disabled');
    });

    it('works while the server mode is unknown', () => {
      expect(retryButton(null)).not.toContain('disabled');
    });
  });

  it('FE-QUEUE-1: a classified page of unknown type gets the neutral classified swatch and names its role', () => {
    const doc = makeDocument({
      pages: [
        makePage({ n: 1, type: 'unknown', role: 'duplicate', used: false, ocr: 'skipped', duplicateOf: { documentId: 'doc_TEST0000000000000000000001', n: 3 } }),
        placeholderPage(2),
      ],
    });
    const html = renderToStaticMarkup(<DocumentCard doc={doc} onShowDocument={noop} />);
    const cells = html.match(/<button[^>]*aria-label="p\.\d[^"]*"[^>]*>/g) ?? [];
    expect(cells[0]).toContain('aria-label="p.1 · duplicate page · unused: duplicate of page 3 · OCR skipped"');
    expect(cells[0]).toContain(`background:${CLASSIFIED_UNKNOWN_PAGE.color}`);
    expect(cells[1]).toContain('aria-label="p.2 · not classified yet"');
    expect(cells[1]).toContain(`background:${PAGE_TYPE_META.unknown.color}`);
    expect(CLASSIFIED_UNKNOWN_PAGE.color).not.toBe(PAGE_TYPE_META.unknown.color);
  });
});
