/**
 * Empty start in API mode: what a fresh clone shows before anything is uploaded (README section 5:
 * the database starts empty). The real backend answers health; what the app boots from (the map
 * layer, the unplotted list, the documents, the questions) is answered empty in the browser (route),
 * so the seeded stack stays as it is.
 *
 * Seed state needed: none (the lists are replaced). Read-only.
 */
import type { Page } from '@playwright/test';
import { expect, expectPins, loaded, nav, navLink, test } from './fixtures';

async function emptyLists(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/map\/boreholes\.geojson/, (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  await page.route(/\/api\/v1\/boreholes\?/, (route) => route.fulfill({ json: { count: 0, boreholes: [], next_cursor: null } }));
  await page.route(/\/api\/v1\/clarifications(\?|$)/, (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/v1\/documents$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { documents: [] } }) : route.continue(),
  );
}

async function openEmpty(page: Page): Promise<void> {
  await emptyLists(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible({ timeout: 15_000 });
}

test('an empty database loads without errors: no pins, empty RESULTS, queue and review texts', async ({ page }) => {
  await openEmpty(page);
  await expect(page.getByRole('heading', { name: 'NOT ON MAP (0)' })).toBeVisible();
  await expect(page.getByText('No boreholes yet. Upload a report under UPLOAD & QUEUE.')).toBeVisible();
  await expectPins(page, 0);
  await nav(page, 'UPLOAD & QUEUE');
  await expect(page.getByText('No documents yet.')).toBeVisible();
  // Nothing to review: REVIEW is off and says why; /review says so too.
  const review = navLink(page, 'REVIEW');
  await expect(review).toHaveAttribute('aria-disabled', 'true');
  await expect(review).toHaveAttribute('title', 'No report is ready for review yet. Upload one under UPLOAD & QUEUE.');
  await expect(review).not.toHaveAttribute('href');
  await page.goto('/review');
  await loaded(page);
  await expect(page.getByText('NOTHING TO REVIEW')).toBeVisible();
});

test('FE-EMPTY-1: the empty map says "Upload a report to see boreholes here" and NOT ON MAP does not claim every borehole is placed', async ({ page }) => {
  await openEmpty(page);
  await expect.soft(page.getByText('Upload a report to see boreholes here')).toBeVisible();
  await expect.soft(page.getByText('Every borehole has usable coordinates and is placed on the map.')).toHaveCount(0);
  await expect.soft(page.getByText('No boreholes yet. Boreholes without usable coordinates are listed here once a report is uploaded.')).toBeVisible();
  // The overlay's button leads to the queue.
  await page.getByRole('button', { name: 'OPEN UPLOAD & QUEUE' }).click();
  await expect(page.getByText('No documents yet.')).toBeVisible();
  await expect(page).toHaveURL(/\/queue$/);
});
