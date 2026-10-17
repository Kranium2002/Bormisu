/// <reference lib="dom" />
// The callbacks of page.evaluate run in the browser, so they use the DOM types.
/**
 * The generated sheet with the uploaded original beside it (fictional sample, BK-07 on pages 7 and 8
 * of neckarbogen_BG_2019.pdf): the pane opens half and half on the first page, values on the sheet
 * show their page and box, it hides and resizes (remembered), and print keeps only the sheet.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, openApp, openUrl, test, uidOf } from './fixtures';

const FILE = 'neckarbogen_BG_2019.pdf';

async function openSheet(page: Page) {
  await openApp(page);
  const uid = await uidOf(page, 'BK-07');
  await openUrl(page, `/sheet/${encodeURIComponent(uid)}`);
  await expect(page.getByRole('article', { name: /BK-07$/ })).toBeVisible();
}

const pane = (page: Page) => page.getByRole('region', { name: 'Original page' });
const sheet = (page: Page) => page.getByRole('article', { name: /BK-07$/ });
const handle = (page: Page) => page.getByRole('separator', { name: 'Resize the original page' });
/** The highlighted box on the original (ScanPage variant 'highlight'). */
const highlight = (p: Locator) => p.locator('[class*="highlight"]');

test.describe('sheet: the original page beside it', () => {
  test.beforeEach(async ({ page }) => openSheet(page));

  test('opens half and half on the borehole’s first page, both sides named', async ({ page }) => {
    await expect(pane(page)).toBeVisible();
    await expect(pane(page).getByRole('heading', { level: 2 })).toHaveText(`ORIGINAL · ${FILE}, page 7 (as uploaded)`);
    await expect(page.getByText('RECONSTRUCTED · from extracted values')).toBeVisible();
    const strip = pane(page).getByRole('navigation', { name: 'Pages with values of this borehole' });
    await expect(strip.getByRole('button')).toHaveText(['7', '8']);
    await expect(strip.getByRole('button', { name: 'PAGE 7' })).toHaveAttribute('aria-current', 'page');
    // The page with the boxes of its values, each a button that picks the value.
    await expect(pane(page).getByRole('img', { name: /^page 7 · / })).toBeVisible();
    await expect(pane(page).getByRole('button', { name: 'Borehole ID (as printed): BK 7' })).toBeVisible();
    await expect(highlight(pane(page))).toHaveCount(0);
    // About half the row.
    const [p, row] = await Promise.all([pane(page).boundingBox(), page.getByRole('article').locator('xpath=../..').boundingBox()]);
    expect(p!.width / row!.width).toBeGreaterThan(0.45);
    expect(p!.width / row!.width).toBeLessThan(0.55);
  });

  test('clicking a layer row shows its page and box; hovering a header value shows that one; leaving goes back', async ({ page }) => {
    // Layer 5 (gravel) is on the second sheet, page 8.
    await sheet(page).getByRole('row').filter({ hasText: '8.20–11.20' }).getByText('8.20–11.20').click();
    await expect(pane(page).getByRole('heading', { level: 2 })).toHaveText(`ORIGINAL · ${FILE}, page 8 (as uploaded)`);
    await expect(highlight(pane(page))).toHaveAttribute('title', 'Lithology (as printed): Kies, sandig, dicht, gerundet, grau');
    await expect(sheet(page).getByRole('button', { name: 'Gravel, sandy, dense, rounded, grey' })).toHaveAttribute('aria-pressed', 'true');

    await sheet(page).getByRole('button', { name: /^18\.00 m/ }).hover();
    await expect(pane(page).getByRole('heading', { level: 2 })).toHaveText(`ORIGINAL · ${FILE}, page 7 (as uploaded)`);
    await expect(highlight(pane(page))).toHaveAttribute('title', 'Final depth (as printed): 18,00 m');
    await expect(pane(page).getByText('as printed: “18,00 m”')).toBeVisible();

    // A value read without a box says so on its page.
    await sheet(page).getByRole('button', { name: 'Rotary core drilling' }).hover();
    await expect(pane(page).getByText('No box on this page')).toBeVisible();
    await expect(highlight(pane(page))).toHaveCount(0);

    // Away from the values the clicked one is shown again.
    await page.getByRole('button', { name: 'PRINT / SAVE AS PDF' }).hover();
    await expect(pane(page).getByRole('heading', { level: 2 })).toHaveText(`ORIGINAL · ${FILE}, page 8 (as uploaded)`);
    await expect(highlight(pane(page))).toHaveCount(1);
  });

  test('values are reachable by keyboard: focusing one shows it in the original', async ({ page }) => {
    const value = sheet(page).getByRole('button', { name: /^18\.00 m/ });
    await expect(value).toHaveAttribute('title', 'Show in the original');
    await value.focus();
    await expect(highlight(pane(page))).toHaveAttribute('title', 'Final depth (as printed): 18,00 m');
    await page.keyboard.press('Enter');
    await expect(value).toHaveAttribute('aria-pressed', 'true');
  });

  test('hides and shows again, remembered across a reload', async ({ page }) => {
    await pane(page).getByRole('button', { name: 'Hide the original' }).click();
    await expect(pane(page)).toHaveCount(0);
    await expect(handle(page)).toHaveCount(0);
    const show = page.getByRole('button', { name: 'SHOW THE ORIGINAL' });
    await expect(show).toBeVisible();
    await page.reload();
    await expect(show).toBeVisible();
    await expect(pane(page)).toHaveCount(0);
    await show.click();
    await expect(pane(page)).toBeVisible();
  });

  test('← → on the handle resize the pane, within its limits', async ({ page }) => {
    const before = Number(await handle(page).getAttribute('aria-valuenow'));
    const width = (await pane(page).boundingBox())!.width;
    expect(Number(await handle(page).getAttribute('aria-valuemin'))).toBe(280);
    await handle(page).focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(handle(page)).toHaveAttribute('aria-valuenow', String(before + 48));
    expect((await pane(page).boundingBox())!.width).toBeCloseTo(width + 48, 0);
    await page.keyboard.press('Home');
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '280');
  });

  test('print keeps only the sheet: no pane, handle or side label, no highlight on the values', async ({ page }) => {
    const value = sheet(page).getByRole('button', { name: /^18\.00 m/ });
    await value.click();
    await page.emulateMedia({ media: 'print' });
    await expect(pane(page)).toBeHidden();
    await expect(handle(page)).toBeHidden();
    await expect(page.getByText('RECONSTRUCTED · from extracted values')).toBeHidden();
    await expect(sheet(page)).toBeVisible();
    const look = await value.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, shadow: s.boxShadow };
    });
    expect(look).toEqual({ bg: 'rgba(0, 0, 0, 0)', shadow: 'none' });
  });
});

test.describe('sheet on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the original starts hidden under the page and the screen does not scroll sideways', async ({ page }) => {
    await openSheet(page);
    await expect(pane(page)).toHaveCount(0);
    const show = page.getByRole('button', { name: 'SHOW THE ORIGINAL' });
    await show.scrollIntoViewIfNeeded();
    await show.click();
    await expect(pane(page)).toBeVisible();
    const overflow = await sheet(page).evaluate((a) => {
      const row = a.parentElement!.parentElement!;
      return { doc: document.documentElement.scrollWidth - window.innerWidth, row: row.scrollWidth - row.clientWidth };
    });
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(overflow.row).toBeLessThanOrEqual(1);
  });
});
