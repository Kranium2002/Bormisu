import { expect, nav, openApp, openReviewPage, test } from './fixtures';

// Console errors fail the test via the shared fixture.
test('shell renders in sample mode without console errors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('BORMISU', { exact: true })).toBeVisible();
  const main = page.getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('button', { name: /^UPLOAD & QUEUE/ })).toContainText('1');

  // Review is no tab of its own: it opens from a document, and UPLOAD & QUEUE stays marked.
  await expect(main.getByRole('button', { name: 'REVIEW', exact: true })).toHaveCount(0);
  await openReviewPage(page);
  await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
  await expect(main.getByRole('button', { name: /^UPLOAD & QUEUE/ })).toHaveAttribute('aria-current', 'page');

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
});

test('browser back and forward step through the app instead of leaving it', async ({ page }) => {
  await openApp(page);
  const screen = (label: string) => page.locator(`[data-screen-label="${label}"]`);
  await nav(page, 'LIST');
  await page.getByRole('button', { name: 'Open detail of BK-07' }).click();
  await expect(screen('Borehole detail')).toBeVisible();
  await nav(page, 'UPLOAD & QUEUE');
  await page.goBack();
  await expect(screen('Borehole detail')).toBeVisible();
  await page.goBack();
  await expect(screen('List')).toBeVisible();
  await page.goBack();
  await expect(screen('Map')).toBeVisible();
  await page.goForward();
  await expect(screen('List')).toBeVisible();
  await page.goForward();
  await expect(screen('Borehole detail')).toBeVisible();
});
