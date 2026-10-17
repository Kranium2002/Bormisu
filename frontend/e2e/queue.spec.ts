import { expect, nav, openApp, test } from './fixtures';

test.describe('upload & queue', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await nav(page, 'UPLOAD & QUEUE');
    await expect(page.getByText('DROP PDF, DOCX OR IMAGES HERE')).toBeVisible();
  });

  test('shows the three sample documents', async ({ page }) => {
    const cards = page.getByRole('region', { name: 'Document queue' }).locator('article');
    await expect(cards).toHaveCount(3);
    await expect(page.getByRole('article', { name: 'neckarbogen_BG_2019.pdf' })).toContainText('needs review');
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
    await expect(page.getByText('DROP PDF, DOCX OR IMAGES HERE')).toBeVisible();
  });

  test('a .txt upload shows the red unsupported-type error', async ({ page }) => {
    await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    const error = page.getByRole('alert').filter({ hasText: 'File type not supported: notes.txt' });
    await expect(error).toBeVisible();
    await expect(error).toHaveCSS('color', 'rgb(200, 16, 46)');
    await expect(page.getByRole('region', { name: 'Document queue' }).locator('article')).toHaveCount(3);
  });

  test('a .pdf upload adds a simulated document that advances through the steps', async ({ page }) => {
    await page.locator('input[type=file]').setInputFiles({ name: 'test_upload.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    const card = page.getByRole('article', { name: 'test_upload.pdf' });
    await expect(card).toBeVisible();
    await expect(page.getByRole('region', { name: 'Document queue' }).locator('article')).toHaveCount(4);
    const current = card.locator('li[aria-current="step"]');
    await expect(current).toContainText('classifying');
    await expect(current).toContainText('extracting', { timeout: 5_000 });
    await expect(current).toContainText('needs review', { timeout: 8_000 });
    await expect(card.getByText('Simulated: live extraction needs an API key')).toBeVisible();
    // The header badge counts documents waiting for review.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^UPLOAD & QUEUE/ })).toContainText('2');
  });

  test('the Neckarbogen card opens Review', async ({ page }) => {
    await page.getByRole('article', { name: 'neckarbogen_BG_2019.pdf' }).getByRole('button', { name: 'OPEN IN REVIEW ›' }).click();
    await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
  });
});
