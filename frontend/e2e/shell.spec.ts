import { APP_NAME, expect, mainNav, nav, navLink, test } from './fixtures';

// Console errors fail the test via the shared fixture.
test('shell renders in sample mode without console errors', async ({ page }) => {
  await page.goto('/');
  // The header shows the configured product name (upper case by CSS) and a tagline without a customer name.
  const banner = page.getByRole('banner');
  await expect(banner.getByText(APP_NAME, { exact: true })).toBeVisible();
  await expect(banner.getByText('Borehole Intelligence', { exact: true })).toBeVisible();
  await expect(page.getByText('Demo mode: fictional sample loaded. Live extraction needs an API key.')).toBeVisible();
  // The navigation is links; no inbox before M2.
  await expect(mainNav(page).getByRole('link')).toHaveText(['MAP', /^UPLOAD & QUEUE/, 'REVIEW']);
  await expect(navLink(page, 'UPLOAD & QUEUE')).toContainText('1');
  await expect(mainNav(page).getByText(/inbox/i)).toHaveCount(0);

  await nav(page, 'REVIEW');
  await expect(navLink(page, 'REVIEW')).toHaveAttribute('aria-current', 'page');
  await expect(navLink(page, 'MAP')).not.toHaveAttribute('aria-current', 'page');

  await page.getByLabel('Search project or borehole ID').fill('nothing-here');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'No results for “nothing-here”' })).toBeVisible();

  // Escape closes overlays one at a time; the sample banner can't be dismissed.
  await nav(page, 'UPLOAD & QUEUE');
  await page.getByRole('button', { name: /^Report lists 14/ }).click();
  await expect(page.getByRole('dialog', { name: 'Completeness' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Completeness' })).toHaveCount(0);
  await expect(page.getByText('Demo mode: fictional sample loaded.', { exact: false })).toBeVisible();
});

test('your name is kept in this browser and can be cleared', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('banner').getByRole('button', { name: 'YOUR NAME' });
  await button.click();
  const form = page.getByRole('dialog', { name: 'Your name' });
  await form.getByLabel('YOUR NAME').fill('A. Reviewer (fictional)');
  await form.getByRole('button', { name: 'SAVE' }).click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'A. Reviewer (fictional)' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('bormisu.reviewerName'))).toBe('A. Reviewer (fictional)');

  await page.reload();
  await page.getByRole('banner').getByRole('button', { name: 'A. Reviewer (fictional)' }).click();
  await page.getByRole('dialog', { name: 'Your name' }).getByRole('button', { name: 'Clear name' }).click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'YOUR NAME' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('bormisu.reviewerName'))).toBeNull();
});
