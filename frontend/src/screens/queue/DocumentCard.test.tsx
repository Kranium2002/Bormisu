/** Server-rendered document card (fictional document): progress, questions, duplicates, retry. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeClarification } from '../../components/clarify/clarifyFixtures';
import { resetTestStore } from '../../components/clarify/testStore';
import { placeholderPage } from '../../domain/pages';
import type { Health } from '../../domain/types';
import { featureOf, makeHealth } from '../../store/testing';
import { retryBlockedReason } from '../../store/uploads';
import { makeBorehole, makeDocument, makePage } from '../../test/fixtures';
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
      expect(html).toContain('Extraction failed at text recognition (OCR): Text recognition failed on page 2.');
      expect(html.match(/<button[^>]*>RETRY<\/button>/)?.[0]).not.toContain('disabled');
    });

    it('marks the step of the failed stage', () => {
      const html = renderToStaticMarkup(
        <DocumentCard
          doc={makeDocument({ status: 'failed', step: 1, error: 'x' })}
          failure={{ stage: 'classify', detail: 'Page 1 could not be read.', retryable: true }}
          onShowDocument={noop}
        />,
      );
      expect(html).toContain('title="classifying: failed at page classification"');
      expect(html).toContain('title="extracting: not started"');
    });

    it('disables RETRY with the reason when the server says a retry cannot fix it', () => {
      const retry = render(false).match(/<button[^>]*>RETRY<\/button>/)?.[0];
      expect(retry).toContain('disabled=""');
      expect(retry).toContain(`title="${NOT_RETRYABLE}"`);
    });
  });

  describe('1.2.0: the failed stage of a document (failed_stage)', () => {
    it('marks the failed step and names the stage in the error', () => {
      const doc = makeDocument({ status: 'failed', step: 1, error: 'The OCR provider timed out.', failedStage: 'ocr' });
      const html = renderToStaticMarkup(<DocumentCard doc={doc} onShowDocument={noop} />);
      expect(html).toContain('Extraction failed at text recognition (OCR): The OCR provider timed out.');
      expect(html).toContain('title="extracting: failed at text recognition (OCR)"');
      expect(html).toContain('title="classifying: done"');
    });

    it('in demo mode RETRY is off with the reason (the server answers 409 demo_mode too)', () => {
      const doc = makeDocument({ status: 'failed', step: 1, error: 'x', failedStage: 'extract' });
      const html = renderToStaticMarkup(<DocumentCard doc={doc} retryBlocked={retryBlockedReason(makeHealth({ mode: 'demo' }))} onShowDocument={noop} />);
      const retry = html.match(/<button[^>]*>RETRY<\/button>/)?.[0] ?? '';
      expect(retry).toContain('disabled=""');
      expect(retry).toContain('title="Live extraction needs API keys"');
    });
  });

  describe('upload → map: the next step of a processed card', () => {
    const D = 'doc_TEST0000000000000000000001';
    const doc = makeDocument({ id: D, status: 'needs_review', step: 2 });
    const card = () => renderToStaticMarkup(<DocumentCard doc={doc} onShowDocument={noop} />);
    const stepButtons = (html: string) => (html.match(/<button[^>]*data-map-step="[^"]+"[^>]*>[^<]*<\/button>/g) ?? []);
    const pinned = makeBorehole({ uid: 'bh_P', documentId: D });
    const noXy = makeBorehole({ uid: 'bh_N', id: 'TB-02', documentId: D, onMap: false, lat: null, lng: null, unplottedReason: 'no_coordinates' });
    const noCrs = makeBorehole({ uid: 'bh_C', id: 'TB-03', documentId: D, onMap: false, lat: null, lng: null, unplottedReason: 'crs_unconfirmed' });

    it('"N on the map · SHOW" when its boreholes are pinned', () => {
      resetTestStore({ features: [featureOf(pinned)!], boreholes: [pinned] });
      const [show] = stepButtons(card());
      expect(show).toContain('data-map-step="onMap"');
      expect(show).toContain('>1 on the map · SHOW</button>');
    });

    it('a coordinate-system question: CONFIRM opens it', () => {
      resetTestStore({
        boreholes: [noCrs], unplottedUids: [noCrs.uid], clarificationsState: 'ready',
        clarifications: [makeClarification({ id: 'cl_crs', kind: 'crs_confirm', documentId: D, boreholeUids: [noCrs.uid] })],
      });
      const buttons = stepButtons(card());
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toContain('data-map-step="crs"');
      expect(buttons[0]).toContain('>1 borehole needs a coordinate system · CONFIRM</button>');
    });

    it('a position question: PLACE opens it', () => {
      resetTestStore({
        boreholes: [noXy], unplottedUids: [noXy.uid], clarificationsState: 'ready',
        clarifications: [makeClarification({ id: 'cl_loc', kind: 'locate_borehole', documentId: D, boreholeUids: [noXy.uid] })],
      });
      expect(stepButtons(card())[0]).toContain('>1 borehole needs a position · PLACE</button>');
    });

    it('boreholes without coordinates and without a question: "N not on the map · WHY"', () => {
      resetTestStore({ boreholes: [noXy], unplottedUids: [noXy.uid] });
      const [why] = stepButtons(card());
      expect(why).toContain('data-map-step="notOnMap"');
      expect(why).toContain('>1 not on the map · WHY</button>');
      expect(why).toContain('title="Open the NOT ON MAP list');
    });

    it('a failed document offers no map step, only RETRY', () => {
      resetTestStore({ features: [featureOf(pinned)!], boreholes: [pinned] });
      const html = renderToStaticMarkup(<DocumentCard doc={{ ...doc, status: 'failed', error: 'x' }} onShowDocument={noop} />);
      expect(stepButtons(html)).toEqual([]);
      expect(html).toContain('>RETRY</button>');
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

describe('1.2.1: document warnings', () => {
  const warning = 'Page 3 was not read; boreholes on it are missing. Retry the document to read it.';

  it('shows the warnings as the server wrote them, with RETRY, next to OPEN IN REVIEW ›', () => {
    const doc = makeDocument({ status: 'needs_review', step: 2, reviewBoreholeUid: 'bh_TEST', warnings: [warning] });
    const html = renderToStaticMarkup(<DocumentCard doc={doc} onShowDocument={noop} />);
    expect(html).toContain(warning);
    expect(html).toContain('OPEN IN REVIEW ›');
    expect(html.match(/<button[^>]*>RETRY<\/button>/)?.[0]).toContain('title="Read the missing pages again"');
  });

  it('a document without warnings shows none', () => {
    const html = renderToStaticMarkup(<DocumentCard doc={makeDocument({ status: 'done', step: 3, warnings: [] })} onShowDocument={noop} />);
    expect(html).not.toContain('Document warnings');
    expect(html).not.toContain('RETRY');
  });
});
