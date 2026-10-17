/**
 * M1 work items of FRONTEND.md section 5 checked against the live stack: F4 routes and deep links
 * (with full records loaded on demand since M2), F6 live events.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`). Read-only.
 */
import { expect, expectConsoleErrors, openApp, openUrl, records, reload, test } from './fixtures';

const heading = (page: import('@playwright/test').Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });

test('M1-ROUTER (F4): /boreholes/:uid opens that borehole’s Detail and survives a reload', async ({ page, request }) => {
  const [r] = (await records(request)).filter((x) => x.plotted);
  await page.goto(`/boreholes/${r.uid}`);
  await expect(heading(page, r.metadata.borehole_id)).toBeVisible();
  await page.reload();
  await expect(heading(page, r.metadata.borehole_id)).toBeVisible();
});

test('M1-ROUTER (F4): /review/:uid?key=… opens Review on that value; reload and Back keep the screens', async ({ page, request }) => {
  const r = (await records(request)).find((x) => x.provenance['metadata.borehole_depth_m']);
  expect(r, 'a seeded borehole with a provenance entry for its depth').toBeTruthy();
  const id = r!.metadata.borehole_id;
  await openApp(page);
  await openUrl(page, `/review/${r!.uid}?key=BoreholeDepth`);
  await expect(page.getByRole('heading', { level: 1, name: `REVIEW · ${id}` })).toBeVisible();
  await expect(page.locator('[aria-label="Extracted values"] [data-key="BoreholeDepth"]')).toHaveAttribute('aria-current', 'true');
  await reload(page);
  await expect(page.getByRole('heading', { level: 1, name: `REVIEW · ${id}` })).toBeVisible();
  await expect(page.locator('[aria-label="Extracted values"] [data-key="BoreholeDepth"]')).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
});

const UNKNOWN_UID = 'bh_00000000000000000000000000';

test('M1-ROUTER (F4): an unknown uid says "Borehole not found" with a link to the map; while loading it says loading', async ({ page, errors }) => {
  // Hold the map layer back, so the deep link meets the loading state of the boot first.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/v1\/map\/boreholes\.geojson/, async (route) => {
    await held;
    await route.continue();
  });
  const asked = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/boreholes/${UNKNOWN_UID}`);
  await page.goto(`/boreholes/${UNKNOWN_UID}`);
  await expect(page.getByText('Loading boreholes and documents…')).toBeVisible();
  await expect(page.getByText('BOREHOLE NOT FOUND')).toHaveCount(0);
  release();
  // Full records come on demand: the app asks the backend, which knows no such borehole.
  const answer = await asked;
  expect(answer.status()).toBe(404);
  expect(((await answer.json()) as { code: string }).code).toBe('borehole_not_found');
  await expect(page.getByRole('heading', { name: 'BOREHOLE NOT FOUND' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'OPEN MAP' }).click();
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
  // Chrome logs that failed request as a console error: expected here, and only that one.
  expect(expectConsoleErrors(errors, (e) => e.includes(`/api/v1/boreholes/${UNKNOWN_UID}`) && /\b404\b/.test(e))).toBeLessThanOrEqual(1);
});

test('M2 on-demand records: a deep link to a plotted borehole never says "not found" while its record loads', async ({ page, request }) => {
  const [r] = (await records(request)).filter((x) => x.plotted);
  let release: () => void = () => undefined;
  const held = new Promise<void>((res) => (release = res));
  let asked = false;
  await page.route(
    (url) => url.pathname === `/api/v1/boreholes/${r.uid}` || url.pathname === `/api/v1/documents/${r.document_id}/boreholes`,
    async (route) => {
      asked = true;
      await held;
      await route.continue();
    },
  );
  await page.goto(`/boreholes/${r.uid}`);
  await expect.poll(() => asked, { message: 'the record is asked for on demand' }).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByText('BOREHOLE NOT FOUND')).toHaveCount(0);
  release();
  await expect(heading(page, r.metadata.borehole_id)).toBeVisible();
  await expect(page.getByText('BOREHOLE NOT FOUND')).toHaveCount(0);
});

test('M1-SSE (F6): the app follows GET /api/v1/events for live updates', async ({ page }) => {
  const events = page.waitForRequest((req) => req.url().includes('/api/v1/events'), { timeout: 10_000 });
  await openApp(page);
  expect((await events).headers()['accept']).toContain('text/event-stream');
});
