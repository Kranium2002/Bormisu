/** Copy / download of the DIN 4023 profile as an image, on the detail screen and the sheet (fictional sample). */
import { expect, openApp, openUrl, test, uidOf } from './fixtures';
import { expectCopy, expectDownloads } from './chartExportChecks';

/** Set to a file path to keep the detail screen's PNG (to look at it). */
const KEEP = process.env.E2E_CHART_PNG;

test.describe('profile chart image', () => {
  test('detail: DOWNLOAD saves a sharp PNG and the SVG, COPY puts image/png on the clipboard', async ({ page, context }) => {
    await openApp(page);
    const uid = await uidOf(page, 'BK-07');
    await openUrl(page, `/boreholes/${encodeURIComponent(uid)}`);
    await expect(page.getByRole('group', { name: 'Chart image' })).toBeVisible();
    if (KEEP) await page.screenshot({ path: KEEP.replace(/\.png$/, '_screen.png') });
    await expectDownloads(page, 'BK-07_profile', KEEP);
    await expectCopy(page, context);
    // A dark system theme changes nothing in the image: it keeps the print look.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectDownloads(page, 'BK-07_profile', KEEP?.replace(/\.png$/, '_dark.png'));
  });

  test('sheet: the same buttons next to PROFILE, not printed', async ({ page }) => {
    await openApp(page);
    const uid = await uidOf(page, 'BK-07');
    await openUrl(page, `/sheet/${encodeURIComponent(uid)}?lang=de`);
    await expectDownloads(page, 'BK-07_profile', KEEP?.replace(/\.png$/, '_sheet_de.png'));
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('group', { name: 'Chart image' })).toBeHidden();
  });
});
