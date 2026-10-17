/**
 * A backend without sign-in (health without `auth`, or auth.enabled false; e.g. AUTH_ENABLED=false):
 * the app opens straight to the map, never shows the sign-in screen and gets no 401 answer.
 * Skips itself on a stack whose sign-in is on (auth.live.spec.ts covers that path).
 *
 * Seed state needed: any. Read-only.
 */
import { expect, test } from './fixtures';

test('without sign-in on the server the app opens to the map, with no sign-in screen and no 401', async ({ page }) => {
  const health = await (await page.request.get('/api/v1/health')).json();
  test.skip(health.auth?.enabled === true, 'this stack has sign-in on');
  const unauthorised: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 401) unauthorised.push(r.url());
  });
  await page.goto('/');
  await expect(page).toHaveURL(/\/map/);
  await expect(page.getByRole('region', { name: 'Borehole map' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 2, name: 'SIGN IN', exact: true })).toHaveCount(0);
  // Let the boot finish (map layer, questions, live events) before counting; the event stream never idles.
  await page.waitForTimeout(1500);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^UPLOAD/ }).click();
  await expect(page.getByText('DROP REPORTS HERE')).toBeVisible();
  expect(unauthorised, '401 answers').toEqual([]);
});
