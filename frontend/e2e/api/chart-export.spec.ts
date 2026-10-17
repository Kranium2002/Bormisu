/**
 * Copy / download of the DIN 4023 profile as an image in API mode.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`): a borehole with layers. Read-only:
 * changes nothing on the server.
 */
import { expectCopy, expectDownloads } from '../chartExportChecks';
import { expect, openApp, openDetail, records, test } from './fixtures';

test('DOWNLOAD saves a sharp PNG and the SVG, COPY puts image/png on the clipboard', async ({ page, context, request }) => {
  const r = (await records(request)).find((x) => x.stratigraphy.length > 0);
  expect(r, 'a seeded borehole with layers').toBeTruthy();
  const id = r!.metadata.borehole_id;
  await openApp(page);
  await openDetail(page, id);
  await expectDownloads(page, `${id.replace(/[^\p{L}\p{N}_-]+/gu, '_')}_profile`, process.env.E2E_CHART_PNG);
  await expectCopy(page, context);
});
