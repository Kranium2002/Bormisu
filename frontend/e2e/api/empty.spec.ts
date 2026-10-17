/**
 * Empty start in API mode: what a fresh clone shows before anything is uploaded (README section 5:
 * the database starts empty). The real backend answers health; the borehole list and the document
 * list are answered empty in the browser (route), so the seeded stack stays as it is.
 *
 * Seed state needed: none (the lists are replaced). Read-only.
 */
import type { Page } from '@playwright/test';
import { expect, knownBug, nav, test } from './fixtures';

async function openEmpty(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/boreholes\?limit=/, (route) => route.fulfill({ json: { count: 0, boreholes: [], next_cursor: null } }));
  await page.route(/\/api\/v1\/documents$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { documents: [] } }) : route.continue(),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible({ timeout: 15_000 });
}

test('an empty database loads without errors: no pins, empty RESULTS, queue and review texts', async ({ page }) => {
  await openEmpty(page);
  await expect(page.getByRole('heading', { name: 'NOT ON MAP (0)' })).toBeVisible();
  await expect(page.getByText('No boreholes yet. Upload a report under UPLOAD & QUEUE.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Borehole map' }).locator('.leaflet-overlay-pane path.leaflet-interactive')).toHaveCount(0);
  await nav(page, 'UPLOAD & QUEUE');
  await expect(page.getByText('No documents yet.')).toBeVisible();
  await nav(page, 'REVIEW');
  await expect(page.getByText('NOTHING TO REVIEW')).toBeVisible();
});

test('FE-EMPTY-1: the empty map says "Upload a report to see boreholes here" and NOT ON MAP does not claim every borehole is placed', async ({ page }) => {
  knownBug('FE-EMPTY-1', 'no empty-map text (F5); NOT ON MAP (0) says "Every borehole has usable coordinates and is placed on the map."');
  await openEmpty(page);
  await expect.soft(page.getByText('Upload a report to see boreholes here')).toBeVisible();
  await expect.soft(page.getByText('Every borehole has usable coordinates and is placed on the map.')).toHaveCount(0);
});
