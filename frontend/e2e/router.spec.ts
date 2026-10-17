/**
 * F4 router and URL state in sample mode (fictional sample data): the URL is the source of navigation
 * truth. Redirect, deep links, reload, Back, not-found pages, the header links and the overlays
 * (Escape, side panel, CRS dialog, toast) across routes.
 */
import type { Page } from '@playwright/test';
import { expect, loaded, mainNav, nav, navLink, openApp, openUrl, pathOf, resultRow, test, uidOf } from './fixtures';

const detailHeading = (page: Page, id: string) => page.getByRole('heading', { level: 1, name: id, exact: true });
const reviewHeading = (page: Page, id: string) => page.getByRole('heading', { level: 1, name: `REVIEW · ${id}` });

test('/ redirects to /map', async ({ page }) => {
  await openApp(page);
  expect(new URL(page.url()).pathname).toBe('/map');
  await expect(navLink(page, 'MAP')).toHaveAttribute('aria-current', 'page');
});

test('the Back button walks back through the screens; Forward again', async ({ page }) => {
  await openApp(page);
  const uid = await uidOf(page, 'BK-07');
  await nav(page, 'LIST');
  await resultRow(page, 'BK-07').click();
  await expect(detailHeading(page, 'BK-07')).toBeVisible();
  expect(pathOf(page)).toBe(`/boreholes/${uid}`);
  await page.getByRole('button', { name: '› OPEN IN REVIEW' }).click();
  await expect(reviewHeading(page, 'BK-07')).toBeVisible();
  expect(pathOf(page)).toMatch(new RegExp(`^/review/${uid}`));
  await nav(page, 'UPLOAD & QUEUE');
  expect(pathOf(page)).toBe('/queue');

  await page.goBack();
  await expect(reviewHeading(page, 'BK-07')).toBeVisible();
  await page.goBack();
  await expect(detailHeading(page, 'BK-07')).toBeVisible();
  await expect(navLink(page, 'MAP')).toHaveClass(/active/);
  await page.goBack();
  await expect(navLink(page, 'LIST')).toHaveAttribute('aria-current', 'page');
  expect(new URL(page.url()).pathname).toBe('/list');
  await page.goForward();
  await expect(detailHeading(page, 'BK-07')).toBeVisible();
});

test('a deep link to /boreholes/:uid opens that detail, also after a reload, with its layer', async ({ page }) => {
  await openApp(page);
  const uid = await uidOf(page, 'BK-07');
  await openUrl(page, `/boreholes/${encodeURIComponent(uid)}`);
  await expect(detailHeading(page, 'BK-07')).toBeVisible();
  const layers = page.getByRole('grid', { name: 'Layers' });
  const third = layers.getByRole('row').filter({ has: page.getByRole('gridcell', { name: '3', exact: true }) }).first();
  await third.click();
  await expect(third).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => pathOf(page)).toBe(`/boreholes/${uid}?layer=3`);

  await page.reload();
  await loaded(page);
  await expect(detailHeading(page, 'BK-07')).toBeVisible();
  await expect(layers.getByRole('row', { selected: true })).toHaveCount(1);
  await expect(third).toHaveAttribute('aria-selected', 'true');
});

test('a deep link to /review/:uid?key=… opens Review on that value, also after a reload', async ({ page }) => {
  await openApp(page);
  const uid = await uidOf(page, 'BK-07');
  await openUrl(page, `/review/${encodeURIComponent(uid)}?key=BoreholeDepth`);
  await expect(reviewHeading(page, 'BK-07')).toBeVisible();
  const depth = page.locator('[data-key="BoreholeDepth"]');
  await expect(depth).toHaveAttribute('aria-current', 'true');
  // Focusing another value writes its key into the URL (history replace).
  const entries = await page.evaluate(() => history.length);
  await page.locator('[data-key="StartDate"]').click();
  await expect.poll(() => pathOf(page)).toBe(`/review/${uid}?key=StartDate`);
  expect(await page.evaluate(() => history.length)).toBe(entries);

  await page.reload();
  await loaded(page);
  await expect(reviewHeading(page, 'BK-07')).toBeVisible();
  await expect(page.locator('[data-key="StartDate"]')).toHaveAttribute('aria-current', 'true');
});

test('reload keeps the map view and reopens the selected pin’s popup; pan and zoom replace the entry', async ({ page }) => {
  await openApp(page);
  const uid = await uidOf(page, 'BK-11');
  // The first view goes into the URL.
  await expect.poll(() => new URL(page.url()).searchParams.get('at')).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?$/);
  await page.getByLabel('Search project or borehole ID').fill('BK-11');
  await page.keyboard.press('Enter');
  const popup = page.locator('.leaflet-popup-content');
  await expect(popup).toContainText('BK-11');
  await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(uid);
  // The view after the flight (the popup may pan the map a little once it opened).
  await page.waitForTimeout(600);
  const entries = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('at')).not.toBeNull();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => history.length), 'zoom replaces the history entry').toBe(entries);
  const at = new URL(page.url()).searchParams.get('at');

  await page.reload();
  await loaded(page);
  await expect(page.locator('.leaflet-popup-content')).toContainText('BK-11');
  await page.waitForTimeout(400);
  expect(new URL(page.url()).searchParams.get('at')).toBe(at);
  expect(new URL(page.url()).searchParams.get('sel')).toBe(uid);

  // Closing the popup takes the borehole out of the URL.
  await page.locator('.leaflet-popup-close-button').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBeNull();
});

test('Back from a pin’s detail returns to the same view with its popup open', async ({ page }) => {
  await openApp(page);
  await page.getByLabel('Search project or borehole ID').fill('EQ-03');
  await page.keyboard.press('Enter');
  const popup = page.locator('.leaflet-popup-content');
  await expect(popup).toContainText('EQ-03');
  await page.waitForTimeout(600);
  const before = new URL(page.url()).searchParams.get('at');
  await popup.getByRole('button', { name: 'Open detail of EQ-03' }).click();
  await expect(detailHeading(page, 'EQ-03')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.leaflet-popup-content')).toContainText('EQ-03');
  expect(new URL(page.url()).searchParams.get('at')).toBe(before);
});

test('unknown boreholes and pages say so, with a link to the map', async ({ page }) => {
  for (const url of ['/boreholes/bh_DOES_NOT_EXIST', '/review/bh_DOES_NOT_EXIST']) {
    await openUrl(page, url);
    await expect(page.getByRole('heading', { name: 'BOREHOLE NOT FOUND' })).toBeVisible();
  }
  await page.getByRole('link', { name: 'OPEN MAP' }).click();
  await expect(page.getByRole('button', { name: /^FILTERS/ }).first()).toBeVisible();

  await openUrl(page, '/no-such-page');
  await expect(page.getByRole('heading', { name: 'PAGE NOT FOUND' })).toBeVisible();
  for (const name of ['MAP', 'LIST', 'UPLOAD & QUEUE', 'INBOX'] as const) {
    await expect(navLink(page, name)).not.toHaveAttribute('aria-current', 'page');
  }
  await page.getByRole('link', { name: 'OPEN MAP' }).click();
  expect(new URL(page.url()).pathname).toBe('/map');
});

test('a deep link shows the loading state, never "not found", while the data loads', async ({ page }) => {
  await openApp(page);
  const uid = await uidOf(page, 'BK-07');
  // Slow the app's module load down so the loading state is visible on the deep link.
  await page.route(/\/src\/sample\//, async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.goto(`/boreholes/${encodeURIComponent(uid)}`);
  await expect(page.getByText('Loading boreholes and documents…')).toBeVisible();
  await expect(page.getByText('BOREHOLE NOT FOUND')).toHaveCount(0);
  await expect(detailHeading(page, 'BK-07')).toBeVisible();
  await expect(page.getByText('BOREHOLE NOT FOUND')).toHaveCount(0);
});

test('/review goes to the last reviewed borehole with its focused value; UPLOAD & QUEUE is the active tab', async ({ page }) => {
  await openApp(page);
  const uid = await uidOf(page, 'BK-01');
  await nav(page, 'LIST');
  await resultRow(page, 'BK-01').click();
  await page.getByRole('button', { name: '› OPEN IN REVIEW' }).click();
  await expect(reviewHeading(page, 'BK-01')).toBeVisible();
  await page.locator('[data-key="BoreholeDepth"]').click();
  await expect.poll(() => pathOf(page)).toBe(`/review/${uid}?key=BoreholeDepth`);
  await nav(page, 'MAP');
  await nav(page, 'REVIEW');
  await expect.poll(() => pathOf(page)).toBe(`/review/${uid}?key=BoreholeDepth`);
  await expect(reviewHeading(page, 'BK-01')).toBeVisible();
  await expect(navLink(page, 'UPLOAD & QUEUE')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-key="BoreholeDepth"]')).toHaveAttribute('aria-current', 'true');
});

test('overlays across routes: Escape and the side panel work, Back out of Review closes its CRS dialog', async ({ page }) => {
  await openApp(page);
  await nav(page, 'LIST');
  await resultRow(page, 'BK-07').click();
  const refusal = page.getByRole('grid', { name: 'Layers' }).getByRole('button', { name: 'R', exact: true }).first();
  await refusal.click();
  const panel = page.getByRole('dialog', { name: 'Source' });
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  await page.getByRole('button', { name: '› OPEN IN REVIEW' }).click();
  await page.locator('[data-key="CoordinateSystem"]').click();
  await page.getByRole('button', { name: 'CHOOSE CRS…' }).click();
  const dialog = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(detailHeading(page, 'BK-07')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // A toast raised on one screen stays while the next one shows.
  await page.goForward();
  await expect(reviewHeading(page, 'BK-07')).toBeVisible();
  await page.getByRole('button', { name: 'APPROVE ALL CLEAN' }).click();
  await page.getByRole('dialog', { name: 'Approve clean values' }).getByRole('button', { name: 'APPROVE', exact: true }).click();
  const toast = page.getByRole('status').filter({ hasText: /clean values? approved$/ });
  await expect(toast).toBeVisible();
  await nav(page, 'MAP');
  await expect(page.getByRole('button', { name: /^FILTERS/ }).first()).toBeVisible();
  await expect(toast).toBeVisible();
  await expect(mainNav(page)).toBeVisible();
});
