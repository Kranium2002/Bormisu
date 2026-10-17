/**
 * The every-control walk (sample mode, fictional data): the main controls of every screen are
 * clicked once and each does what it says (or is disabled with its reason). The shared fixture
 * fails a test on any console error or page error.
 */
import type { Page } from '@playwright/test';
import { expect, loaded, mainNav, nav, openApp, resultRow, test } from './fixtures';

const popup = (page: Page) => page.locator('.leaflet-popup-content');
const question = (page: Page) => page.getByRole('dialog', { name: /^QUESTION · / });
const card = (page: Page, name: string) => page.getByRole('article', { name });
const toast = (page: Page) => page.getByRole('status').filter({ has: page.locator('button'), hasText: /placed/ });
const zoomOf = (page: Page) => Number(new URL(page.url()).searchParams.get('at')?.split(',')[2]);

/** Every disabled button on the page names its reason (a title, a description, or a described-by text). */
async function disabledWithoutReason(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button[disabled], button[aria-disabled="true"]')]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => {
        const by = b.getAttribute('aria-describedby');
        return !b.title && !b.getAttribute('aria-description') && !(by && document.getElementById(by)?.textContent?.trim());
      })
      .map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()),
  );
}

test.describe('every control works', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('header: the nav links, the inbox badge, your name and the borehole search', async ({ page }) => {
    for (const [name, path] of [['UPLOAD & QUEUE', '/queue'], ['LIST', '/list'], ['MAP', '/map']] as const) {
      await nav(page, name);
      await expect(page).toHaveURL(new RegExp(path));
    }
    await mainNav(page).getByRole('link', { name: /^INBOX/ }).click();
    await expect(page).toHaveURL(/\/inbox/);
    await page.getByRole('button', { name: 'YOUR NAME' }).click();
    const nameDialog = page.getByRole('dialog', { name: 'Your name' });
    await nameDialog.getByLabel('YOUR NAME').fill('A. Tester (fictional)');
    await nameDialog.getByRole('button', { name: 'SAVE' }).click();
    await expect(nameDialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: /A\. Tester \(fictional\)/ })).toBeVisible();
    await page.getByLabel('Search project or borehole ID').fill('BK-11');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/map/);
    await expect(popup(page)).toContainText('BK-11');
  });

  test('map: zoom, colour switch, draw tools, LIST sort and MAP, popup buttons, NOT ON MAP', async ({ page }) => {
    const before = zoomOf(page);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(before);
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect.poll(() => zoomOf(page)).toBe(before);

    await page.getByRole('radio', { name: 'DEPTH' }).check();
    await expect(page.getByRole('group', { name: 'Final depth legend' })).toBeVisible();
    await page.getByRole('radio', { name: 'STATUS' }).check();
    await expect(page.getByRole('group', { name: 'Review status legend' })).toBeVisible();

    for (const tool of ['Select by rectangle', 'Select by polygon', 'Select by circle']) {
      const button = page.getByRole('button', { name: tool });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('toolbar', { name: 'Select an area' }).locator('..').getByRole('status')).toContainText('Esc cancels');
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
    }

    await nav(page, 'LIST');
    const sortBy = page.getByRole('columnheader', { name: 'BOREHOLE' });
    await sortBy.getByRole('button').click();
    await expect(sortBy).toHaveAttribute('aria-sort', /ascending|descending/);

    await resultRow(page, 'BK-11').getByRole('button', { name: 'Show BK-11 on the map' }).click();
    await expect(popup(page)).toContainText('BK-11');
    await expect(popup(page)).toContainText(/CRS/);
    await popup(page).getByRole('button', { name: 'Source of the final depth of BK-11' }).click();
    await expect(page.getByRole('dialog', { name: 'Source' })).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await popup(page).getByRole('button', { name: 'Review BK-11' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'REVIEW · BK-11' })).toBeVisible();
    await page.goBack();
    await popup(page).getByRole('button', { name: 'Open detail of BK-11' }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await page.goBack();
    await loaded(page);

    await nav(page, 'LIST');
    await page.getByRole('button', { name: /^Open detail of BK-13:/ }).click();
    await expect(page).toHaveURL(/\/boreholes\//);
    expect(await disabledWithoutReason(page)).toEqual([]);
  });

  test('explore panel: place search, a filter applied, RESET', async ({ page }) => {
    await page.getByRole('button', { name: /^FILTERS/ }).first().click();
    const panel = page.getByRole('region', { name: 'Search and filters' });
    await panel.getByRole('textbox', { name: 'Town, address or place' }).fill('Elbhafen');
    await panel.getByRole('button', { name: 'SEARCH', exact: true }).click();
    await expect(panel.getByRole('status').first()).toHaveText('1 place found');
    await panel.getByLabel('Project', { exact: true }).fill('Elbquerung Ost');
    await panel.getByRole('button', { name: 'APPLY' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).not.toBeNull();
    await panel.getByRole('button', { name: 'RESET' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toBeNull();
    await expect(panel.getByLabel('Project', { exact: true })).toHaveValue('');
  });

  test('queue: SHOW, CONFIRM (the CRS question) then SHOW ON MAP, WHY, the questions badge, completeness, page strip, OPEN REVIEW', async ({ page }) => {
    await nav(page, 'UPLOAD & QUEUE');
    const nb = card(page, 'neckarbogen_BG_2019.pdf');

    await nb.locator('[data-map-step="onMap"]').click();
    await expect(page).toHaveURL(/\/map/);
    await nav(page, 'UPLOAD & QUEUE');

    await nb.locator('[data-map-step="notOnMap"]').click();
    await expect(page).toHaveURL(/\/list/);
    await expect(page.locator('[role="table"] [role="row"][data-uid]:focus')).toContainText('NOT ON MAP');
    await nav(page, 'UPLOAD & QUEUE');

    await nb.getByRole('button', { name: /open questions?$/ }).click();
    await expect(question(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(question(page)).toHaveCount(0);

    await nb.getByRole('button', { name: /^Report lists/ }).click();
    await expect(page.getByText('COMPLETENESS', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await nb.getByRole('group', { name: /^Page map of/ }).getByRole('button', { name: /^p\.7 · / }).click();
    await expect(page.getByRole('dialog', { name: 'Source' })).toBeVisible();
    await page.keyboard.press('Escape');

    // The way to the map: CONFIRM opens the CRS question; the answer places the boreholes and the
    // toast takes the map to them.
    await nb.locator('[data-map-step="crs"]').click();
    const crs = question(page);
    await expect(crs).toContainText('COORDINATE SYSTEM');
    await crs.locator('[data-widget="crs_picker"]').getByRole('radio').filter({ hasText: 'pins on site' }).first().click();
    await crs.getByRole('button', { name: 'ANSWER', exact: true }).click();
    await expect(crs).toHaveCount(0);
    await expect(toast(page)).toContainText(/^Answer stored · \d+ boreholes? placed/);
    await toast(page).getByRole('button', { name: 'SHOW ON MAP' }).click();
    await expect(page).toHaveURL(/\/map/);
    await nav(page, 'LIST');
    await expect(resultRow(page, 'BK-01')).toContainText('confirmed');

    await nav(page, 'UPLOAD & QUEUE');
    await expect(nb.locator('[data-map-step="crs"]')).toHaveCount(0);
    await nb.getByRole('button', { name: 'OPEN REVIEW ›' }).click();
    await expect(page).toHaveURL(/\/review\//);
  });

  test('review: value actions, APPROVE ALL CLEAN, the CRS dialog, sheet tabs, other boreholes, keys', async ({ page }) => {
    await nav(page, 'REVIEW');
    await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
    const progress = page.getByText(/^\d+ of \d+ values reviewed$/);
    const count = async () => Number(/^(\d+)/.exec((await progress.textContent()) ?? '')?.[1]);

    await page.getByRole('button', { name: 'Approve Surface elevation' }).click();
    await expect.poll(count).toBe(1);
    await page.getByRole('button', { name: 'Approve Surface elevation' }).click();
    await expect.poll(count).toBe(0);
    await page.getByRole('button', { name: 'Flag Surface elevation' }).click();
    await page.getByLabel('Flag reason for Surface elevation').fill('check the datum');
    await page.getByRole('button', { name: 'SAVE' }).click();
    await expect(page.locator('[data-key="SurfaceElevation"]')).toContainText('⚑ Flagged: check the datum');
    await page.getByRole('button', { name: 'Flag Surface elevation' }).click();
    await expect(page.locator('[data-key="SurfaceElevation"]')).not.toContainText('Flagged');
    await page.getByRole('button', { name: 'Edit Surface elevation' }).click();
    await expect(page.getByLabel('Corrected value for Surface elevation')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Corrected value for Surface elevation')).toHaveCount(0);

    await page.getByRole('button', { name: 'APPROVE ALL CLEAN' }).click();
    const confirm = page.getByRole('dialog', { name: 'Approve clean values' });
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);

    await page.locator('[data-key="CoordinateSystem"]').click();
    await page.getByRole('button', { name: 'CHOOSE CRS…' }).click();
    const crs = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
    await expect(crs.getByRole('radio').first()).toBeVisible();
    await crs.getByRole('button', { name: 'Close' }).click();
    await expect(crs).toHaveCount(0);

    await page.getByRole('tab', { name: 'SHEET 2 · P.8' }).click();
    await expect(page.getByRole('tab', { name: 'SHEET 2 · P.8' })).toHaveAttribute('aria-selected', 'true');

    // J moves to the next value; with a question dialog open, keys stay in the dialog.
    const current = () => page.locator('[aria-label="Extracted values"] [aria-current="true"]').getAttribute('data-key');
    const at = await current();
    await page.keyboard.press('j');
    await expect.poll(current).not.toBe(at);
    const asked = page.getByRole('button', { name: /^\d+ open questions?$/ });
    if (await asked.isVisible()) {
      const before = await progress.textContent();
      await asked.click();
      await expect(question(page)).toBeVisible();
      await page.keyboard.press('a');
      await expect(progress).toHaveText(before ?? '');
      await page.keyboard.press('Escape');
    }

    await page.getByRole('button', { name: /^Next borehole/ }).click();
    await expect(page.getByRole('heading', { name: 'REVIEW · BK-08' })).toBeVisible();
    await page.getByRole('button', { name: /^Previous borehole/ }).click();
    await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
    await page.getByRole('button', { name: '› BOREHOLE DETAIL' }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    expect(await disabledWithoutReason(page)).toEqual([]);
  });

  test('detail: a layer, a source, the export menu, OPEN IN REVIEW', async ({ page }) => {
    await nav(page, 'LIST');
    await resultRow(page, 'BK-07').click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await page.getByRole('button', { name: /^Layer 3: / }).first().click();
    await expect(page).toHaveURL(/layer=3/);
    await page.getByRole('button', { name: /show source$/ }).first().click();
    await expect(page.getByRole('dialog', { name: 'Source' })).toBeVisible();
    await page.keyboard.press('Escape');
    for (const option of [/^Tidy CSV/, /^Open questions \(CSV\)/, /^Project xlsx \(target format\)/]) {
      await page.getByRole('button', { name: 'EXPORT ▾' }).click();
      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: option }).click();
      expect((await downloading).suggestedFilename()).toMatch(/\.(csv|xlsx)$/);
    }
    await page.getByRole('button', { name: '› OPEN IN REVIEW' }).click();
    await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
  });

  test('inbox: a question opens, SKIP FOR NOW keeps it', async ({ page }) => {
    await mainNav(page).getByRole('link', { name: /^INBOX/ }).click();
    const open = page.locator('button[data-clarification-id]').filter({ hasNotText: 'SKIPPED' }).first();
    await open.click();
    await expect(question(page)).toBeVisible();
    await question(page).getByRole('button', { name: 'SKIP FOR NOW' }).click();
    await expect(question(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Skipped for now' })).toBeVisible();
    expect(await disabledWithoutReason(page)).toEqual([]);
  });
});
