import type { Page } from '@playwright/test';
import { expect, focusSelect, nav, openApp, test } from './fixtures';

/** The NEAR YOU panel (a region named by its heading). */
const nearYou = (page: Page) => page.getByRole('region', { name: 'NEAR YOU' });
const myLocation = (page: Page) => page.getByRole('button', { name: 'MY LOCATION' });
const nearYouRows = (page: Page) => nearYou(page).getByRole('button', { name: /^Open detail of / });

/** About 110 m north-east of BK-07 (48.7905, 9.1835), the fictional Neckarbogen site. */
const NEAR_BK07 = { latitude: 48.7912, longitude: 9.1846, accuracy: 18 };

test.describe('MY LOCATION with a position near BK-07', () => {
  test.use({ geolocation: NEAR_BK07, permissions: ['geolocation'] });

  test('switches to the country, draws the position and lists BK-07 first; the position stays in the browser', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(`${r.url()} ${r.postData() ?? ''}`));
    await openApp(page);
    await expect(focusSelect(page)).toHaveValue('world');

    await myLocation(page).click();
    const panel = nearYou(page);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Accuracy ±18 m');
    await expect(nearYouRows(page)).toHaveCount(5);
    await expect(nearYouRows(page).first()).toHaveAccessibleName('Open detail of BK-07, 112 m south-west');
    await expect(nearYouRows(page).first()).toContainText('112 m SW');
    await expect(nearYouRows(page).first()).toContainText('Needs attention');
    await expect(panel).toContainText('Your location stays in this browser.');
    await expect(panel).not.toContainText('SIMULATED');

    // The focus follows the position; the dot and its accuracy circle are drawn.
    await expect(focusSelect(page)).toHaveValue('DE');
    await expect(page.locator('path.bormisu-me-dot')).toHaveCount(1);
    await expect(page.locator('path.bormisu-me-accuracy')).toHaveCount(1);
    await expect(page.locator('path.bormisu-me-dot')).not.toHaveClass(/leaflet-interactive/);

    // Privacy: the position is neither in the URL nor in any request.
    expect(page.url()).not.toMatch(/48\.79|9\.18/);
    expect(requests.filter((r) => /48\.791|9\.184/.test(r))).toEqual([]);

    // Escape closes the panel; the dot stays.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.locator('path.bormisu-me-dot')).toHaveCount(1);
  });

  test('a NEAR YOU row opens the borehole detail, and the panel is still there on the way back', async ({ page }) => {
    await openApp(page);
    await myLocation(page).click();
    await nearYouRows(page).first().click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await expect(page.getByText('BK-07', { exact: true }).first()).toBeVisible();
    await nav(page, 'MAP');
    await expect(nearYou(page)).toBeVisible();
    await nearYou(page).getByRole('button', { name: 'Close near you' }).click();
    await expect(nearYou(page)).toHaveCount(0);
  });
});

test.describe('MY LOCATION far from every borehole', () => {
  test.use({ geolocation: { latitude: 48.137, longitude: 11.575, accuracy: 40 }, permissions: ['geolocation'] });

  test('says that no borehole is within 2 km and names the nearest', async ({ page }) => {
    await openApp(page);
    await myLocation(page).click();
    await expect(nearYou(page)).toContainText(/No borehole within 2 km of you\. Nearest: [A-Z]{2}-\d{2} at \d+\.\d km\./);
    await expect(focusSelect(page)).toHaveValue('DE');
  });
});

test.describe('MY LOCATION without permission', () => {
  test('explains that the permission was denied', async ({ page }) => {
    await openApp(page);
    await myLocation(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Location permission denied' })).toHaveText(
      'Location permission denied. Allow it in the browser to see boreholes near you.',
    );
    await expect(nearYou(page)).toHaveCount(0);
    await expect(page.locator('path.bormisu-me-dot')).toHaveCount(0);
    await expect(focusSelect(page)).toHaveValue('world');
  });
});

test.describe('simulated location (sample mode only)', () => {
  test('?simLocation=lat,lng opens NEAR YOU as a SIMULATED LOCATION', async ({ page }) => {
    await openApp(page, '?simLocation=48.7912,9.1846');
    const panel = nearYou(page);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('SIMULATED LOCATION');
    await expect(panel).toContainText('Accuracy ±25 m');
    await expect(nearYouRows(page).first()).toHaveAccessibleName('Open detail of BK-07, 112 m south-west');
    await expect(page.locator('.leaflet-tooltip').filter({ hasText: 'SIMULATED LOCATION' })).toBeVisible();
    await expect(focusSelect(page)).toHaveValue('DE');
  });

  test('the "Simulate: Neckarbogen site" option does the same without a real position', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Simulate: Neckarbogen site' }).click();
    await expect(nearYou(page)).toContainText('SIMULATED LOCATION');
    await expect(nearYouRows(page).first()).toContainText('BK-07');
  });
});
