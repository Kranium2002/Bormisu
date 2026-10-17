/**
 * Sign-in against the real backend (contract 1.3.0, minimal auth), not route interception. It runs
 * only with E2E_AUTH=1 against a stack whose backend has sign-in on, through the web proxy:
 *
 *   E2E_AUTH=1 E2E_BASE_URL=http://localhost:8081 npx playwright test --project=api e2e/api/auth.live.spec.ts
 *
 * Seed state needed: any (on a fresh database the account it creates becomes admin; that is fine
 * for a test stack). Writes: one fictional account and one result set (an immutable snapshot).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

test.skip(process.env.E2E_AUTH !== '1', 'needs E2E_AUTH=1 and a stack whose backend has sign-in on');

const signInHeading = (page: Page) => page.getByRole('heading', { level: 2, name: 'SIGN IN', exact: true });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
/** Chrome logs every 401 answer as a console error; here they are expected (signed out, wrong password). */
const dropExpected401 = (errors: string[]) => errors.splice(0, errors.length, ...errors.filter((e) => !/status of 401/.test(e)));

test('register on the first visit, the map appears; sign out; sign in; a write with the session; an ended session asks to sign in on the same URL', async ({ page, errors }, info) => {
  // Fictional account, unique per run (the stack may already hold accounts from earlier runs).
  const email = `e2e-${info.workerIndex}-${Date.now()}@example.test`;
  const password = 'fictional-harbour-pass-01';

  // Health says sign-in is on: the first visit shows the sign-in screen, not the map.
  const health = await (await page.request.get('/api/v1/health')).json();
  expect(health.auth).toEqual({ enabled: true, registration: 'open' });
  expect((await page.request.get('/api/v1/documents')).status()).toBe(401);
  await page.goto('/map');
  await expect(signInHeading(page)).toBeVisible({ timeout: 15_000 });

  // Create an account: the server signs it in and the map appears.
  await page.getByRole('button', { name: 'Create an account' }).click();
  await field(page, 'EMAIL').fill(email);
  await field(page, 'DISPLAY NAME').fill('E2E Reviewer (fictional)');
  await field(page, 'PASSWORD').fill(password);
  await field(page, 'REPEAT PASSWORD').fill(password);
  const registered = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/register'));
  await page.getByRole('button', { name: 'CREATE ACCOUNT', exact: true }).click();
  expect((await registered).status()).toBe(201);
  await expect(page.getByRole('region', { name: 'Borehole map' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('banner').getByRole('button', { name: 'E2E Reviewer (fictional)', exact: true })).toBeVisible();

  // The session cookie works for reads and writes through the web proxy.
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200);
  const write = await page.request.post('/api/v1/result-sets', { data: { include_unreviewed: true } });
  expect(write.status(), 'POST /result-sets with the session cookie').toBe(201);

  // Sign out: the sign-in screen on the same URL; the API is closed again.
  await page.getByRole('banner').getByRole('button', { name: 'E2E Reviewer (fictional)', exact: true }).click();
  const loggedOut = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/logout'));
  await page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'SIGN OUT' }).click();
  expect((await loggedOut).status()).toBe(204);
  await expect(signInHeading(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/map');
  expect((await page.request.get('/api/v1/documents')).status()).toBe(401);

  // Sign in again with the same account.
  await field(page, 'EMAIL').fill(email.toUpperCase());
  await field(page, 'PASSWORD').fill(password);
  await page.getByRole('button', { name: 'SIGN IN', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Borehole map' })).toBeVisible({ timeout: 15_000 });

  // The session ends behind the app's back (cookie gone): the app asks to sign in on the same URL.
  await page.goto('/queue');
  await expect(page.getByText('DROP REPORTS HERE')).toBeVisible({ timeout: 15_000 });
  await page.context().clearCookies();
  await page.reload();
  await expect(signInHeading(page)).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe('/queue');
  dropExpected401(errors);
});

test('a wrong password is answered on the form, not a crash', async ({ page, errors }) => {
  await page.goto('/map');
  await expect(signInHeading(page)).toBeVisible({ timeout: 15_000 });
  await field(page, 'EMAIL').fill('nobody-here@example.test');
  await field(page, 'PASSWORD').fill('not-the-password-1');
  await page.getByRole('button', { name: 'SIGN IN', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Email or password is wrong.');
  dropExpected401(errors);
});
