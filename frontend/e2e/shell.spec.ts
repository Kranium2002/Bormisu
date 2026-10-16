import { expect, nav, test } from './fixtures';

// Console errors fail the test via the shared fixture.
test('shell renders in sample mode without console errors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('BORMISU', { exact: true })).toBeVisible();
  await expect(page.getByText('Demo mode: fictional sample loaded. Live extraction needs an API key.')).toBeVisible();
  const main = page.getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('button', { name: /^UPLOAD & QUEUE/ })).toContainText('1');

  await nav(page, 'REVIEW');
  await expect(main.getByRole('button', { name: 'REVIEW', exact: true })).toHaveAttribute('aria-current', 'page');

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
