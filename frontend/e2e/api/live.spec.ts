/**
 * Live updates in API mode (F6, F7), without changing the backend's data: Playwright answers the
 * upload (POST /documents, which demo mode refuses) with a fake 202, serves a recorded fictional
 * event stream on GET /events in two connections, and answers the reads of the test's own document
 * and borehole (ids the seed never has). Health is reported as live so the drop zone is on;
 * everything else comes from the seeded stack.
 *
 * Seed state needed: any (python -m app.seed). Read-only: no request that writes reaches the backend.
 */
import type { Request, Route } from '@playwright/test';
import { expect, getJson, nav, openApp, resultRow, test } from './fixtures';
import {
  BLANK_PNG,
  LIVE_BOREHOLE_ID,
  LIVE_DOC,
  LIVE_FILE,
  LIVE_UID,
  liveBorehole,
  liveDocument,
  sseBody,
  sseEvent,
} from './live-helpers';

const path = (url: URL | string) => new URL(url).pathname;

test('an uploaded document updates live from the event stream and becomes reviewable without a reload', async ({ page, request }) => {
  const health = await getJson<Record<string, unknown>>(request, '/health');
  const providers = { ocr: true, classifier: true, extractor: true, chat: false, geocoder: true };
  await page.route((url) => path(url) === '/api/v1/health', (route) => route.fulfill({ json: { ...health, mode: 'live', providers } }));

  // The test's document as the "server" holds it now; GETs of it are counted (polling would repeat them).
  let doc = liveDocument('queued');
  const documentGets: string[] = [];
  await page.route(
    (url) => path(url) === `/api/v1/documents/${LIVE_DOC}`,
    (route) => {
      documentGets.push(route.request().url());
      return route.fulfill({ json: doc });
    },
  );
  await page.route(
    (url) => path(url) === `/api/v1/documents/${LIVE_DOC}/boreholes`,
    (route) => route.fulfill({ json: doc.status === 'needs_review' ? [liveBorehole()] : [] }),
  );
  await page.route((url) => path(url) === `/api/v1/boreholes/${LIVE_UID}`, (route) => route.fulfill({ json: liveBorehole() }));
  await page.route(
    (url) => path(url).startsWith(`/api/v1/documents/${LIVE_DOC}/pages/`),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG }),
  );

  // The upload: answered here, never sent on to the backend.
  let uploaded!: () => void;
  const uploadAnswered = new Promise<void>((r) => (uploaded = r));
  const uploads: Request[] = [];
  await page.route(
    (url) => path(url) === '/api/v1/documents',
    async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      uploads.push(route.request());
      await route.fulfill({ status: 202, json: { document_id: LIVE_DOC, status: 'queued', duplicate_of: null } });
      uploaded();
    },
  );

  // The event stream, recorded: the first connection waits for the upload, then sends the
  // classification and extraction progress and ends (the browser reconnects after `retry`); the
  // second brings the borehole and "needs review"; later connections stay open without events.
  let secondReady!: () => void;
  const second = new Promise<void>((r) => (secondReady = r));
  const streams: { accept: string | undefined }[] = [];
  const stream = (body: string) => ({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body });
  await page.route(
    (url) => path(url) === '/api/v1/events',
    async (route: Route) => {
      streams.push({ accept: (await route.request().allHeaders())['accept'] });
      const n = streams.length;
      if (n === 1) {
        await uploadAnswered;
        doc = liveDocument('extracting');
        await route.fulfill(
          stream(
            sseBody(1000, [
              sseEvent(901, 'document.updated', liveDocument('classifying')),
              sseEvent(902, 'document.updated', liveDocument('extracting')),
            ]),
          ),
        );
      } else if (n === 2) {
        await second;
        doc = liveDocument('needs_review');
        await route.fulfill(
          stream(
            sseBody(3_600_000, [
              sseEvent(903, 'borehole.created', { uid: LIVE_UID, document_id: LIVE_DOC, revision: 1, plotted: true }),
              sseEvent(904, 'document.updated', liveDocument('needs_review')),
            ]),
          ),
        );
      } else {
        // Open without events until the test ends.
        await new Promise(() => undefined);
      }
    },
  );

  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  // The app asks for the event stream as an event stream.
  await expect.poll(() => streams.length).toBeGreaterThan(0);
  expect(streams[0].accept).toContain('text/event-stream');

  await page.getByLabel('Project (optional)').fill('Live Updates (fictional)');
  await page
    .locator('label')
    .filter({ hasText: 'DROP REPORTS HERE' })
    .locator('input[type=file]')
    .setInputFiles({ name: LIVE_FILE, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fictional') });

  // The upload: one request, with the typed project, then the item says it is done.
  const row = page.getByRole('region', { name: 'UPLOADS' }).getByRole('listitem').filter({ hasText: LIVE_FILE });
  await expect(row).toContainText('Uploaded');
  await expect(row.getByRole('progressbar', { name: `Upload of ${LIVE_FILE}` })).toHaveAttribute('aria-valuenow', '100');
  expect(uploads).toHaveLength(1);
  expect(uploads[0].postData() ?? '').toContain('Live Updates (fictional)');

  // The card follows the stream: extracting, with the OCR progress of the last event.
  const card = page.locator(`article[data-doc-id="${LIVE_DOC}"]`);
  await expect(card.getByRole('list', { name: 'Processing status' }).locator('li[aria-current="step"]')).toHaveText('extracting');
  await expect(card.getByRole('progressbar', { name: 'OCR' })).toHaveAttribute('aria-valuenow', '1');
  await expect(card.getByRole('button', { name: 'OPEN REVIEW ›' })).toHaveCount(0);
  // Live, not polled: apart from the one resync when the stream opens (a new EventSource has no
  // Last-Event-ID, so the source refetches what it follows once), the document was never fetched.
  expect(documentGets.length, 'GETs of the document while it advanced').toBeLessThanOrEqual(1);

  // The browser reconnects after the stream's `retry` delay and the stream goes on. (Its Last-Event-ID
  // header is not visible to Playwright's interception in Chrome, so it is not asserted here.)
  secondReady();
  await expect.poll(() => streams.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  expect(streams[1].accept).toContain('text/event-stream');

  // F7: needs review, without a reload; OPEN REVIEW works and the borehole is on the map's list.
  await expect(card.getByRole('list', { name: 'Processing status' }).locator('li[aria-current="step"]')).toHaveText('needs review');
  await expect(card.getByRole('list', { name: 'Found' })).toContainText('1 BH');
  const fetchedOnce = documentGets.length;
  // At most two one-off fetches: the source's resync when the stream first opened, and the store's
  // refetch for the completeness checks once the boreholes are known. No polling afterwards.
  expect(fetchedOnce).toBeLessThanOrEqual(2);
  await page.waitForTimeout(3_000);
  expect(documentGets).toHaveLength(fetchedOnce);

  await card.getByRole('button', { name: 'OPEN REVIEW ›' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `REVIEW · ${LIVE_BOREHOLE_ID}` })).toBeVisible();
  await nav(page, 'MAP');
  await expect(resultRow(page, LIVE_BOREHOLE_ID)).toHaveCount(1);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('the live-update status line is shown on the queue', async ({ page }) => {
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  const status = page.getByRole('status').filter({ hasText: /^(Live|Updating every few seconds|Offline, retrying|Connecting to live updates…)$/ });
  await expect(status).toBeVisible();
  // Against the running stack the stream connects.
  await expect(status).toHaveText('Live', { timeout: 15_000 });
});
