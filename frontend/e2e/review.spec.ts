import type { Page } from '@playwright/test';
import { expect, nav, openApp, pathOf, resultRow, test, uidOf } from './fixtures';

async function openReview(page: Page) {
  await openApp(page);
  const uid = await uidOf(page, 'BK-07');
  await nav(page, 'REVIEW');
  await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
  // The first document in review; the link carries its first value to review.
  expect(pathOf(page)).toMatch(new RegExp(`^/review/${uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?key=.+)?$`));
}

const row = (page: Page, key: string) => page.locator(`[data-key="${key}"]`);

/** "n of m values reviewed" as numbers. */
async function progress(page: Page): Promise<[number, number]> {
  const text = (await page.getByText(/^\d+ of \d+ values reviewed$/).textContent()) ?? '';
  const [, done, total] = /^(\d+) of (\d+)/.exec(text) ?? [];
  return [Number(done), Number(total)];
}

test.describe('review', () => {
  test.beforeEach(async ({ page }) => openReview(page));

  test('opens on the inferred CRS with the scan, sheet tabs and progress', async ({ page }) => {
    await expect(page.getByText('0 of 30 values reviewed')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveText(['SHEET 1 · P.7', 'SHEET 2 · P.8']);
    await expect(row(page, 'CoordinateSystem')).toHaveAttribute('aria-current', 'true');
    // The note says where the CRS came from, without guessing a CRS family.
    await expect(row(page, 'CoordinateSystem').getByText(/^not stated in source · inferred/)).toBeVisible();
    await expect(page.getByText('page 7 · sheet 1 of 2 · click a box to jump to its field')).toBeVisible();
  });

  test('approve all clean counts first, approves the document’s clean values and reloads them', async ({ page }) => {
    await page.getByRole('button', { name: 'APPROVE ALL CLEAN' }).click();
    const confirm = page.getByRole('dialog', { name: 'Approve clean values' });
    const title = confirm.getByText(/^Approve \d+ clean values? in neckarbogen_BG_2019\.pdf\?$/);
    await expect(title).toBeVisible();
    const n = Number(/\d+/.exec((await title.textContent()) ?? '')?.[0]);
    expect(n).toBeGreaterThan(0);
    const [before] = await progress(page);
    await confirm.getByRole('button', { name: 'APPROVE', exact: true }).click();
    await expect(page.getByText(`${n} clean value${n === 1 ? '' : 's'} approved`)).toBeVisible();
    await expect.poll(async () => (await progress(page))[0]).toBeGreaterThan(before);
    // Nothing clean is left in the document.
    await page.getByRole('button', { name: 'APPROVE ALL CLEAN' }).click();
    await expect(page.getByRole('dialog', { name: 'Approve clean values' }).getByText('No clean values')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Approve clean values' })).toHaveCount(0);
  });

  test('an edit keeps the AI value struck through', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit Surface elevation' }).click();
    const input = page.getByLabel('Corrected value for Surface elevation');
    await expect(input).toBeFocused();
    await input.fill('241.40');
    await input.press('Enter');
    const elev = row(page, 'SurfaceElevation');
    await expect(elev.getByText(/^241\.40/)).toBeVisible();
    await expect(elev.locator('s')).toHaveText('241.35');
    await expect(elev).toContainText('(AI value)');
    await expect(elev.getByText('Edited', { exact: true })).toBeVisible();
    await expect(page.getByText('1 of 30 values reviewed')).toBeVisible();
  });

  test('a flag shows the flag line, and flagging again removes it', async ({ page }) => {
    await page.getByRole('button', { name: 'Flag Final depth' }).click();
    await page.getByLabel('Flag reason for Final depth').fill('check against sheet 2');
    await page.getByRole('button', { name: 'SAVE' }).click();
    await expect(row(page, 'BoreholeDepth').getByText('⚑ Flagged: check against sheet 2')).toBeVisible();
    await page.getByRole('button', { name: 'Flag Final depth' }).click();
    await expect(page.getByText('⚑ Flagged: check against sheet 2')).toHaveCount(0);
  });

  test('approve and a state button toggle off again (undo)', async ({ page }) => {
    const approve = page.getByRole('button', { name: 'Approve Final depth' });
    await approve.click();
    await expect(approve).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('1 of 30 values reviewed')).toBeVisible();
    await approve.click();
    await expect(approve).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('0 of 30 values reviewed')).toBeVisible();

    await row(page, 'StartDate').click();
    const illegible = row(page, 'StartDate').getByRole('button', { name: 'Illegible' });
    await illegible.click();
    await expect(illegible).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('1 of 30 values reviewed')).toBeVisible();
    await illegible.click();
    await expect(illegible).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('0 of 30 values reviewed')).toBeVisible();
  });

  test('closing the CRS dialog while its map is still zooming raises no error', async ({ page }) => {
    for (let i = 0; i < 3; i++) {
      await row(page, 'CoordinateSystem').click();
      await page.getByRole('button', { name: 'CHOOSE CRS…' }).click();
      await expect(page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' })).toHaveCount(0);
    }
    // Leaflet's zoom-end timer fires 250 ms later; the fixture fails the test on any page error.
    await page.waitForTimeout(500);
  });

  test('confirming the CRS stores it for the whole document and reloads the boreholes', async ({ page }) => {
    await row(page, 'CoordinateSystem').click();
    await page.getByRole('button', { name: 'CHOOSE CRS…' }).click();
    const dialog = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
    await expect(dialog).toBeVisible();
    const radios = dialog.getByRole('radio');
    await expect(radios.first()).toBeVisible();
    // No name set: the footer doesn't claim one is stored.
    await expect(dialog.getByText(/Stored with your name/)).toHaveCount(0);
    // An out-of-range candidate can't be confirmed.
    const outOfRange = radios.filter({ hasText: 'out of range' });
    if ((await outOfRange.count()) > 0) {
      await outOfRange.first().click();
      await expect(dialog.getByText('Coordinates out of range: no pins can be placed')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'CONFIRM FOR WHOLE DOCUMENT' })).toBeDisabled();
    }
    const match = radios.filter({ hasText: 'pins on site' }).first();
    await match.click();
    const label = (await match.locator('span').first().textContent()) ?? '';
    await dialog.getByRole('button', { name: 'CONFIRM FOR WHOLE DOCUMENT' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(new RegExp(`^CRS confirmed for \\d+ boreholes? in this report: ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))).toBeVisible();
    await expect(row(page, 'CoordinateSystem').getByText('confirmed for the whole document')).toBeVisible();

    await nav(page, 'MAP');
    await expect(resultRow(page, 'BK-01')).toContainText(`confirmed · ${label}`);
  });

  test('with your name set, the CRS dialog says it is stored with it', async ({ page }) => {
    await page.getByRole('banner').getByRole('button', { name: 'YOUR NAME' }).click();
    await page.getByRole('dialog', { name: 'Your name' }).getByLabel('YOUR NAME').fill('A. Reviewer (fictional)');
    await page.getByRole('dialog', { name: 'Your name' }).getByRole('button', { name: 'SAVE' }).click();
    await row(page, 'CoordinateSystem').click();
    await page.getByRole('button', { name: 'CHOOSE CRS…' }).click();
    const dialog = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
    await expect(dialog.getByText(/^Stored with your name \(A\. Reviewer \(fictional\)\)\./)).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
