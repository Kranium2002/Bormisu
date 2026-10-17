import type { Page } from '@playwright/test';
import { AMBER, expect, legendCount, nav, openApp, pinFills, test } from './fixtures';

async function openReview(page: Page) {
  await openApp(page);
  await nav(page, 'REVIEW');
  await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
}

const row = (page: Page, key: string) => page.locator(`[data-key="${key}"]`);

test.describe('review', () => {
  test.beforeEach(async ({ page }) => openReview(page));

  test('opens on the inferred CRS with the scan, sheet tabs and progress', async ({ page }) => {
    await expect(page.getByText('0 of 30 values reviewed')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveText(['SHEET 1 · p.7', 'SHEET 2 · p.8']);
    await expect(row(page, 'CoordinateSystem')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText('not stated in source · inferred from 7-digit Rechtswert')).toBeVisible();
    await expect(page.getByText('page 7 · sheet 1 of 2 · click a box to jump to its field')).toBeVisible();
  });

  test('approve all clean approves n values and updates the progress', async ({ page }) => {
    await page.getByRole('button', { name: 'APPROVE ALL CLEAN (16)' }).click();
    await expect(page.getByText('Approve 16 clean values?')).toBeVisible();
    await page.getByRole('button', { name: 'APPROVE', exact: true }).click();
    await expect(page.getByText('16 of 30 values reviewed')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Values reviewed' })).toHaveAttribute('aria-valuenow', '16');
    await expect(page.getByRole('button', { name: 'APPROVE ALL CLEAN (0)' })).toBeDisabled();
    await expect(page.getByText('16 clean values approved')).toBeVisible();
  });

  test('an edit keeps the AI value struck through', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit Surface elevation' }).click();
    const input = page.getByLabel('Corrected value for Surface elevation');
    await expect(input).toBeFocused();
    await input.fill('241.40');
    await input.press('Enter');
    const elev = row(page, 'SurfaceElevation');
    await expect(elev.getByText('241.40 m NN')).toBeVisible();
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

  test('a state button toggles off again', async ({ page }) => {
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

  test('confirming the CRS turns the Neckarbogen pins from amber', async ({ page }) => {
    // World view: 11 Neckarbogen pins with an inferred CRS plus 6 boreholes with a lint warning.
    await nav(page, 'MAP');
    await expect(legendCount(page, 'attention')).toHaveText('17');
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(17);

    await nav(page, 'REVIEW');
    await row(page, 'CoordinateSystem').click();
    await page.getByRole('button', { name: 'CHOOSE CRS…' }).click();
    const dialog = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Krüger zone 3/ })).toBeChecked();
    await dialog.getByRole('radio', { name: /UTM zone 32N/ }).click();
    await expect(dialog.getByText('Coordinates out of range: no pins can be placed')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'CONFIRM FOR WHOLE DOCUMENT' })).toBeDisabled();
    await dialog.getByRole('radio', { name: /Krüger zone 3/ }).click();
    await dialog.getByRole('button', { name: 'CONFIRM FOR WHOLE DOCUMENT' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('CRS confirmed for all boreholes in this report: EPSG:31467')).toBeVisible();
    await expect(page.getByText('confirmed for whole document by you')).toBeVisible();

    await nav(page, 'MAP');
    // BK-07 keeps its open lints.
    await expect(legendCount(page, 'attention')).toHaveText('7');
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(7);
    await nav(page, 'LIST');
    await expect(page.locator('[data-uid="nb:BK-01"]')).toContainText('confirmed');
    await expect(page.locator('[data-uid="nb:BK-01"]')).toContainText('EPSG:31467');
  });
});
