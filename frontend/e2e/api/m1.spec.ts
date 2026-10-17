/**
 * M1 work items of FRONTEND.md section 5 that the M0 merge (c2e40bd) does not have yet. They are
 * marked as expected failures (knownBug) so the suite turns red, and the marker gets removed, the
 * moment they land: F4 routes and deep links, F6 live events.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`). Read-only.
 */
import { expect, knownBug, openApp, records, test } from './fixtures';

test('M1-ROUTER (F4): /boreholes/:uid opens that borehole’s Detail and survives a reload', async ({ page, request }) => {
  knownBug('M1-ROUTER', 'no router yet: every URL starts on the map');
  const [r] = (await records(request)).filter((x) => x.plotted);
  await page.goto(`/boreholes/${r.uid}`);
  await expect(page.getByRole('heading', { level: 1, name: r.metadata.borehole_id, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: r.metadata.borehole_id, exact: true })).toBeVisible();
});

test('M1-SSE (F6): the app follows GET /api/v1/events for live updates', async ({ page }) => {
  knownBug('M1-SSE', 'no EventSource yet: documents in progress are polled every 2 s');
  const events = page.waitForRequest((req) => req.url().includes('/api/v1/events'), { timeout: 10_000 });
  await openApp(page);
  expect((await events).headers()['accept']).toContain('text/event-stream');
});
