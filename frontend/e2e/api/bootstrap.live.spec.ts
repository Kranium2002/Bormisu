/**
 * The startup account (AUTH_BOOTSTRAP_EMAIL / AUTH_BOOTSTRAP_PASSWORD in the
 * backend's environment) signs in through the real form with no other step. It runs only when the test is
 * given the same account:
 *
 *   E2E_BOOTSTRAP_EMAIL=... E2E_BOOTSTRAP_PASSWORD=... E2E_BASE_URL=http://localhost:8080 \
 *     npx playwright test --project=api e2e/api/bootstrap.live.spec.ts
 *
 * Seed state needed: any. Writes: nothing (one session).
 */
import { expect, test } from './fixtures';

const email = process.env.E2E_BOOTSTRAP_EMAIL ?? '';
const password = process.env.E2E_BOOTSTRAP_PASSWORD ?? '';

test.skip(!email || !password, 'needs E2E_BOOTSTRAP_EMAIL and E2E_BOOTSTRAP_PASSWORD of the startup account');

test('the startup account signs in through the form and lands on the map', async ({ page, errors }) => {
  await page.goto('/map');
  await expect(page.getByRole('heading', { level: 2, name: 'SIGN IN', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('EMAIL', { exact: true }).fill(email);
  await page.getByLabel('PASSWORD', { exact: true }).fill(password);
  const signedIn = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login'));
  await page.getByRole('button', { name: 'SIGN IN', exact: true }).click();
  const answer = await signedIn;
  expect(answer.status()).toBe(200);
  expect((await answer.json()).user).toMatchObject({ email: email.trim().toLowerCase(), role: 'admin' });
  await expect(page.getByRole('region', { name: 'Borehole map' })).toBeVisible({ timeout: 15_000 });
  expect((await page.request.get('/api/v1/documents')).status()).toBe(200);
  // Chrome logs the signed-out 401 of the first visit as a console error; it is expected here.
  errors.splice(0, errors.length, ...errors.filter((e) => !/status of 401/.test(e)));
});
