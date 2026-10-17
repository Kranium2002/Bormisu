/// <reference lib="dom" />
// The callbacks of page.evaluate run in the browser, so they use the DOM types.
/**
 * The generated sheet with the uploaded original beside it, in API mode: the pane shows the page
 * image the backend serves for the borehole's first page, and draws the value boxes on it only once
 * it has loaded.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`): a borehole with layers whose values
 * name their page. Read-only: changes nothing on the server.
 */
import { expect, openApp, openUrl, records, test } from './fixtures';

test('the sheet shows the original page image of the borehole next to it', async ({ page, request }) => {
  const r = (await records(request)).find((x) => x.stratigraphy.length > 0 && Object.values(x.provenance).some((p) => p.page != null));
  expect(r, 'a seeded borehole with layers and paged values').toBeTruthy();
  await openApp(page);
  await openUrl(page, `/sheet/${encodeURIComponent(r!.uid)}`);
  const pane = page.getByRole('region', { name: 'Original page' });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('heading', { level: 2 })).toContainText(`ORIGINAL · ${r!.source_file}, page `);
  await expect(page.getByText('RECONSTRUCTED · from extracted values')).toBeVisible();

  const scan = pane.getByRole('region', { name: 'Page image' }).locator('img');
  await expect(scan).toHaveAttribute('src', new RegExp(`/api/v1/documents/${r!.document_id}/pages/\\d+\\.png`));
  await expect
    .poll(() => scan.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), { timeout: 20_000 })
    .toBe(true);
  await expect(pane.getByText('Loading the original scan…')).toHaveCount(0);
  await expect(pane.getByText('Original page could not be loaded')).toHaveCount(0);
});
