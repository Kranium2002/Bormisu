import type { Page } from '@playwright/test';
import { expect, nav, navLink, openApp, test } from './fixtures';

/** The drop zone's file input (the folder picker has its own). */
const fileInput = (page: Page) => page.locator('label').filter({ hasText: 'DROP REPORTS HERE' }).locator('input[type=file]');

/** A fictional PDF of `kb` kilobytes. */
const pdf = (name: string, kb = 1) => ({ name, mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(kb * 1024)]) });

const uploads = (page: Page) => page.getByRole('region', { name: 'UPLOADS' });
const uploadRow = (page: Page, name: string) => uploads(page).getByRole('listitem').filter({ hasText: name });

test.describe('upload & queue', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await nav(page, 'UPLOAD & QUEUE');
    await expect(page.getByText('DROP REPORTS HERE')).toBeVisible();
  });

  test('shows the three sample documents with their page maps', async ({ page }) => {
    const cards = page.getByRole('region', { name: 'Document queue' }).locator('article');
    await expect(cards).toHaveCount(3);
    const nb = page.getByRole('article', { name: 'neckarbogen_BG_2019.pdf' });
    await expect(nb).toContainText('needs review');
    // Page tooltips say only what the source reported about each page (sample mode has no page images).
    const firstPage = nb.getByRole('group', { name: /^Page map of/ }).getByRole('button').first();
    await expect(firstPage).toHaveAttribute('title', /^p\.1 · /);
  });

  test('the drop zone takes its accepted types from the server', async ({ page }) => {
    // The sample source reports its limits like the backend's health answer; nothing is hard-coded in the page.
    await expect(fileInput(page)).toHaveAttribute('accept', /^\.[a-z0-9]+(,\.[a-z0-9]+)*$/);
    await expect(page.getByText(/^or click to choose files · [A-Z0-9, ]+ · up to \d+ MB each$/)).toBeVisible();
  });

  test('the live-update status is shown in the header of the queue', async ({ page }) => {
    const status = page.getByRole('status').filter({ hasText: /^(Live|Updating every few seconds|Offline, retrying|Connecting to live updates…)$/ });
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('aria-live', 'polite');
  });

  test('the completeness panel lists BK-12 as missing', async ({ page }) => {
    const nb = page.getByRole('article', { name: 'neckarbogen_BG_2019.pdf' });
    await nb.getByRole('button', { name: 'Report lists 14 · extracted 13 · ⚠ 1 missing' }).click();
    const panel = page.getByRole('dialog', { name: 'Completeness' });
    await expect(panel.getByText('Report lists 14 · extracted 13 · 1 missing')).toBeVisible();
    await expect(panel.getByText('BK-12', { exact: true })).toHaveAttribute('title', 'Named in the report, no log found');
    await expect(panel.locator('[title="Extracted"]')).toHaveCount(13);
    await expect(panel.getByText('LINT', { exact: true })).toBeVisible();
    // Still on the queue: the chip opens the panel, not Review.
    await expect(page.getByText('DROP REPORTS HERE')).toBeVisible();
  });

  test('a .txt upload shows the red unsupported-type error', async ({ page }) => {
    await fileInput(page).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    const error = page.getByRole('alert').filter({ hasText: 'File type not supported: notes.txt' });
    await expect(error).toBeVisible();
    await expect(error).toHaveCSS('color', 'rgb(200, 16, 46)');
    await expect(page.getByRole('region', { name: 'Document queue' }).locator('article')).toHaveCount(3);
    await expect(uploads(page)).toHaveCount(0);
  });

  test('an upload shows its byte progress, then its card; the card advances through the steps', async ({ page }) => {
    await fileInput(page).setInputFiles(pdf('test_upload.pdf', 256));
    const row = uploadRow(page, 'test_upload.pdf');
    const bar = row.getByRole('progressbar', { name: 'Upload of test_upload.pdf' });
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
    await expect(bar).toHaveAttribute('aria-valuenow', /^\d{1,3}$/);
    await expect(bar).toHaveAttribute('aria-valuenow', '100', { timeout: 10_000 });
    await expect(row).toContainText('Uploaded');
    // The queue summary is announced as it changes.
    await expect(uploads(page).getByRole('status')).toHaveText(/1 done/);

    const card = page.getByRole('article', { name: 'test_upload.pdf' });
    await expect(card).toBeVisible();
    await expect(page.getByRole('region', { name: 'Document queue' }).locator('article')).toHaveCount(4);
    // SHOW DOCUMENT moves focus to the card.
    await row.getByRole('button', { name: 'Show the document of test_upload.pdf' }).click();
    await expect(card).toBeFocused();
    const current = card.locator('li[aria-current="step"]');
    await expect(current).toContainText('needs review', { timeout: 15_000 });
    // The header badge counts documents waiting for review.
    await expect(navLink(page, 'UPLOAD & QUEUE')).toContainText('2');
    // A finished upload can be removed from the list; the card stays.
    await row.getByRole('button', { name: 'Remove test_upload.pdf from the list' }).click();
    await expect(uploads(page)).toHaveCount(0);
    await expect(card).toBeVisible();
  });

  test('at most two uploads run at a time; a waiting one can be cancelled and is never sent', async ({ page }) => {
    await fileInput(page).setInputFiles([pdf('one.pdf', 512), pdf('two.pdf', 512), pdf('three.pdf', 512), pdf('four.pdf', 512)]);
    const four = uploadRow(page, 'four.pdf');
    await expect(four).toContainText('Waiting');
    await four.getByRole('button', { name: 'Cancel upload of four.pdf' }).click();
    await expect(four).toContainText('Cancelled');
    // Focus stays in the row: CANCEL became REMOVE.
    await expect(four.getByRole('button', { name: 'Remove four.pdf from the list' })).toBeFocused();
    await expect(uploadRow(page, 'three.pdf')).toContainText('Uploaded', { timeout: 15_000 });
    await expect(uploadRow(page, 'one.pdf')).toContainText('Uploaded');
    await expect(page.getByRole('article', { name: 'three.pdf' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'four.pdf' })).toHaveCount(0);
  });

  test('the project typed next to the drop zone is sent with every file of the drop', async ({ page }) => {
    const field = page.getByLabel('Project (optional)');
    await expect(field).toBeEnabled();
    await field.fill('Harbour Wall (fictional)');
    await fileInput(page).setInputFiles([pdf('wall_a.pdf'), pdf('wall_b.pdf')]);
    for (const name of ['wall_a.pdf', 'wall_b.pdf']) {
      await expect(uploadRow(page, name)).toContainText('Project: Harbour Wall (fictional)');
      await expect(page.getByRole('article', { name })).toContainText('Harbour Wall (fictional)', { timeout: 10_000 });
    }
  });

  test('the Neckarbogen card opens Review', async ({ page }) => {
    await page.getByRole('article', { name: 'neckarbogen_BG_2019.pdf' }).getByRole('button', { name: 'OPEN REVIEW ›' }).click();
    await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
  });
});
