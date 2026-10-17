import { expect, nav, test } from './fixtures';

// Console errors fail the test via the shared fixture.
test('shell renders in sample mode without console errors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('BORMISU', { exact: true })).toBeVisible();
  const main = page.getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('button', { name: /^UPLOAD & QUEUE/ })).toContainText('1');

  await nav(page, 'REVIEW');
  await expect(main.getByRole('button', { name: 'REVIEW', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.getByLabel('Search project or borehole ID').fill('nothing-here');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'No results for “nothing-here”' })).toBeVisible();

  // Escape closes overlays one at a time.
  await nav(page, 'UPLOAD & QUEUE');
  await page.getByRole('button', { name: /^Report lists 14/ }).click();
  await expect(page.getByRole('dialog', { name: 'Completeness' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Completeness' })).toHaveCount(0);
});

// F2: the side panel traps Tab. Its scroller must be in the trap, or Tab only ever reaches × and the
// content can't be scrolled from the keyboard.
test('Tab reaches the side panel scroller, which scrolls with the arrow keys', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'UPLOAD & QUEUE');
  const close = page.getByRole('button', { name: 'Close panel' });

  await page.getByRole('button', { name: /^Report lists 14/ }).click();
  const checks = page.getByRole('dialog', { name: 'Completeness' }).getByRole('region', { name: 'Completeness checks' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(checks).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(checks).toBeFocused();
  await page.keyboard.press('Escape');

  // A page opened from the page map has no OPEN IN REVIEW: × and the page are the only stops.
  await page.getByRole('group', { name: 'Page map of neckarbogen_BG_2019.pdf' }).getByRole('button').nth(6).click();
  const scan = page.getByRole('dialog', { name: 'Source' }).getByRole('region', { name: 'Source page' });
  await expect(scan.getByRole('group')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(scan).toBeFocused();
  await scan.evaluate((el) => (el.scrollTop = 0));
  await page.keyboard.press('PageDown');
  await expect.poll(() => scan.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
});
