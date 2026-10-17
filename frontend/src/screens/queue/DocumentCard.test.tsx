/** Server-rendered document card (fictional document): progress, questions, duplicates, retry. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClarification } from '../../components/clarify/clarifyFixtures';
import { resetTestStore } from '../../components/clarify/testStore';
import { placeholderPage } from '../../domain/pages';
import type { Health } from '../../domain/types';
import { makeHealth } from '../../store/testing';
import { retryBlockedReason } from '../../store/uploads';
import { makeDocument, makePage } from '../../test/fixtures';
import { CLASSIFIED_UNKNOWN_PAGE, PAGE_TYPE_META } from '../../theme';
import { DocumentCard } from './DocumentCard';
import { PageTip, THUMBNAIL_WIDTH } from './PageStrip';
import { NOT_RETRYABLE } from './queueView';

const noop = () => undefined;

// Server rendering reads the store's initial state: the test store adds the questions (F12).
vi.mock('../../store/appStore', async (importOriginal) => (await import('../../components/clarify/testStore')).mockAppStore(await importOriginal()));

beforeEach(() => resetTestStore());

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

  describe('F12: the open-questions badge', () => {
    const doc = makeDocument({ status: 'needs_review', step: 2, openClarifications: 2 });
    const badge = () => renderToStaticMarkup(<DocumentCard doc={doc} onShowDocument={noop} />).match(/<button[^>]*>2 open questions<\/button>/)?.[0] ?? '';

    it('is a button that opens the document’s first unresolved question', () => {
      resetTestStore({
        clarificationsState: 'ready',
        clarifications: [
          makeClarification({ id: 'cl_other', documentId: 'doc_OTHER' }),
          makeClarification({ id: 'cl_skipped', documentId: doc.id, status: 'skipped' }),
          makeClarification({ id: 'cl_open', documentId: doc.id }),
        ],
      });
      expect(badge()).toContain('title="Answer the first open question of this document"');
      expect(badge()).not.toContain('disabled');
    });

    it('opens the inbox while the questions are not loaded', () => {
      resetTestStore({ navigator: { navigate: noop } });
      expect(badge()).toContain('title="Open the inbox"');
    });

    it('without a router or questions it is off and says why', () => {
      expect(badge()).toContain('disabled=""');
      expect(badge()).toContain('title="The questions are not loaded"');
    });
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

  describe('a failure reported live (job.failed)', () => {
    const failed = makeDocument({ status: 'failed', step: 1, error: 'OCR failed' });
    const render = (retryable: boolean) =>
      renderToStaticMarkup(
        <DocumentCard doc={failed} failure={{ stage: 'ocr', detail: 'Text recognition failed on page 2.', retryable }} onShowDocument={noop} />,
      );

    it('names the stage and the server’s detail, with RETRY', () => {
      const html = render(true);
      expect(html).toContain('Extraction failed at ocr: Text recognition failed on page 2.');
      expect(html.match(/<button[^>]*>RETRY<\/button>/)?.[0]).not.toContain('disabled');
    });

    it('disables RETRY with the reason when the server says a retry cannot fix it', () => {
      const retry = render(false).match(/<button[^>]*>RETRY<\/button>/)?.[0];
      expect(retry).toContain('disabled=""');
      expect(retry).toContain(`title="${NOT_RETRYABLE}"`);
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

  describe('page thumbnails', () => {
    const doc = makeDocument({ pages: [makePage({ n: 1 }), placeholderPage(2)] });

    it('with page images, a cell keeps its label and leaves the tooltip to the thumbnail card', () => {
      const thumbnailUrl = (id: string, n: number) => `/api/v1/documents/${id}/pages/${n}.png?w=200`;
      const html = renderToStaticMarkup(<DocumentCard doc={doc} thumbnailUrl={thumbnailUrl} onShowDocument={noop} />);
      const cells = html.match(/<button[^>]*aria-label="p\.\d[^"]*"[^>]*>/g) ?? [];
      expect(cells).toHaveLength(2);
      for (const c of cells) expect(c).not.toContain(' title=');
      // A source without page images gives no URL: the native tooltip stays.
      const none = renderToStaticMarkup(<DocumentCard doc={doc} thumbnailUrl={() => null} onShowDocument={noop} />);
      expect(none).toContain('title="p.1 · log · used: log sheet · OCR done"');
    });

    it('without page images (sample mode), the swatch keeps its native tooltip', () => {
      const html = renderToStaticMarkup(<DocumentCard doc={doc} onShowDocument={noop} />);
      expect(html).toContain('title="p.1 · log · used: log sheet · OCR done"');
    });

    it('the card shows the image lazily at 200 px with the page number and type as alt text', () => {
      const html = renderToStaticMarkup(
        <PageTip id="tip" page={makePage({ n: 3 })} url="/api/v1/documents/doc_X/pages/3.png?w=200" title="p.3 · log" onBroken={noop} />,
      );
      expect(THUMBNAIL_WIDTH).toBe(200);
      expect(html).toContain('role="tooltip"');
      expect(html).toMatch(/<img[^>]*src="\/api\/v1\/documents\/doc_X\/pages\/3\.png\?w=200"/);
      expect(html).toContain('width="200"');
      expect(html).toContain('loading="lazy"');
      expect(html).toContain('alt="Page 3, log"');
      expect(html).toContain('p.3 · log');
    });

    it('an image that failed to load is replaced by a text', () => {
      const html = renderToStaticMarkup(<PageTip id="tip" page={placeholderPage(6)} url={null} title="p.6 · not classified yet" onBroken={noop} />);
      expect(html).not.toContain('<img');
      expect(html).toContain('No page image');
    });
  });
});
