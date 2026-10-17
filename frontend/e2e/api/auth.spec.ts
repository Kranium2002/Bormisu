/**
 * Sign-in in API mode (contract 1.3.0): sign-in screen, create account, user menu, sign-out, change
 * password, and a session that ends mid-way (any 401 not_authenticated) showing the sign-in on the
 * same URL and returning there after signing in.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`). Read-only: changes nothing.
 *
 * The backend of the test stack still runs contract 1.1.0 without sign-in, so this spec plays the
 * 1.3.0 server in the browser with Playwright routes: health gains `auth {enabled, registration:
 * "open"}`, the /auth/* endpoints answer from a fictional in-test session, and every other /api/v1
 * request answers 401 not_authenticated while that session is signed out (as the always-on backend
 * will) and goes to the real stack while it is signed in. Accounts and passwords are fictional
 * (example.test). The other API specs see the real health without `auth`, i.e. no sign-in.
 *
 * Once the backend ships sign-in: run the suite with E2E_AUTH=1 and import `test` from
 * ./auth-session in the other specs; it registers a fictional account (e2e-<timestamp>@example.test,
 * a strong fictional password) per worker and starts every page with its session cookie.
 */
import type { Page, Request, Route } from '@playwright/test';
import { API, expect, expectConsoleErrors, getJson, loaded, mapFeatures, navLink, resultRow, test } from './fixtures';

interface WireUser { user_id: string; email: string; display_name: string | null; role: 'reviewer' | 'admin'; created_at: string }

const USER: WireUser = {
  user_id: 'usr_01JFICTE2E00000000000U01',
  email: 'ada.reviewer@example.test',
  display_name: 'Ada Reviewer',
  role: 'admin',
  created_at: '2026-10-17T07:00:00Z',
};
const PASSWORD = 'fictional-river-lantern-42';
const NEW_PASSWORD = 'fictional-harbour-compass-77';

interface AuthCall { method: string; path: string; body: Record<string, unknown> | null }

/** The 1.3.0 server played in the browser (see the file comment). */
interface FakeAuth {
  /** The session's user; null while signed out (every data request then answers 401). */
  user: WireUser | null;
  /** The /auth/* requests the app made, in order. */
  calls: AuthCall[];
  /** Answers the next POST /auth/login with this instead (e.g. a rate limit). */
  nextLogin: { status: number; body: unknown; headers?: Record<string, string> } | null;
  /**
   * The session ends on the server when the app requests this path (GET), so the test knows which
   * request sees the first 401 (the app's background requests, e.g. live refetches, keep working until then).
   */
  expireOn: string | null;
}

const error = (code: string, detail: string, errors?: { loc: (string | number)[]; msg: string }[]) => ({ detail, code, ...(errors ? { errors } : {}) });

async function fulfill(route: Route, status: number, body?: unknown, headers: Record<string, string> = {}) {
  if (status === 204) return route.fulfill({ status, headers });
  return route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
}

const bodyOf = (req: Request): Record<string, unknown> | null => {
  try {
    return req.postDataJSON() as Record<string, unknown> | null;
  } catch {
    return null;
  }
};

async function fakeAuth(page: Page, signedIn: boolean): Promise<FakeAuth> {
  const state: FakeAuth = { user: signedIn ? USER : null, calls: [], nextLogin: null, expireOn: null };
  let password = PASSWORD;
  const taken = new Set([USER.email]);
  await page.route(
    (url) => url.pathname.startsWith(`${API}/`),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.slice(API.length);
      const method = req.method();
      if (path === '/health') {
        const res = await route.fetch();
        const health = (await res.json()) as Record<string, unknown>;
        await route.fulfill({ response: res, json: { ...health, auth: { enabled: true, registration: 'open' } } });
        return;
      }
      if (path.startsWith('/auth/')) {
        const body = bodyOf(req);
        state.calls.push({ method, path, body });
        if (method === 'GET' && path === '/auth/me') {
          return state.user ? fulfill(route, 200, { user: state.user }) : fulfill(route, 401, error('not_authenticated', 'Sign in first.'));
        }
        if (method === 'POST' && path === '/auth/login') {
          if (state.nextLogin) {
            const { status, body: answer, headers } = state.nextLogin;
            state.nextLogin = null;
            return fulfill(route, status, answer, headers);
          }
          const email = String(body?.email ?? '').trim().toLowerCase();
          if (email !== USER.email || body?.password !== password) return fulfill(route, 401, error('invalid_credentials', 'Invalid email or password.'));
          state.user = USER;
          return fulfill(route, 200, { user: USER });
        }
        if (method === 'POST' && path === '/auth/register') {
          const email = String(body?.email ?? '').trim().toLowerCase();
          if (taken.has(email)) return fulfill(route, 409, error('email_taken', 'Email already registered.'));
          taken.add(email);
          const name = typeof body?.display_name === 'string' ? body.display_name : null;
          state.user = { ...USER, user_id: 'usr_01JFICTE2E00000000000U02', email, display_name: name, role: 'reviewer' };
          return fulfill(route, 201, { user: state.user });
        }
        if (method === 'POST' && path === '/auth/logout') {
          state.user = null;
          return fulfill(route, 204);
        }
        if (method === 'POST' && path === '/auth/password') {
          if (!state.user) return fulfill(route, 401, error('not_authenticated', 'Sign in first.'));
          if (body?.current_password !== password) return fulfill(route, 401, error('invalid_credentials', 'Invalid email or password.'));
          password = String(body?.new_password);
          return fulfill(route, 204);
        }
        return fulfill(route, 404, error('route_not_found', 'Not found.'));
      }
      if (state.expireOn === path && method === 'GET') {
        state.expireOn = null;
        state.user = null;
      }
      // Always-on sign-in: without a session every other route answers 401.
      if (!state.user) return fulfill(route, 401, error('not_authenticated', 'Sign in first.'));
      await route.fallback();
    },
  );
  return state;
}

/** Chrome logs every 4xx answer as a console error; these are the ones a sign-in test expects. */
const AUTH_ANSWER = (e: string) => /status of (401|409|422|429)\b/.test(e) && e.includes(`${API}/`);

const signInHeading = (page: Page) => page.getByRole('heading', { level: 2, name: 'SIGN IN', exact: true });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const userButton = (page: Page, name: string) => page.getByRole('banner').getByRole('button', { name, exact: true });

test('signed out at a deep link: the sign-in on that URL, client checks, a wrong password, then back to the URL', async ({ page, errors }) => {
  const auth = await fakeAuth(page, false);
  await page.goto('/queue');
  await expect(signInHeading(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Bormisu' })).toBeVisible();
  // Nothing of the app shows (and nothing is loaded) without a session.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/queue');
  await expect(field(page, 'EMAIL')).toBeFocused();
  await expect(field(page, 'EMAIL')).toHaveAttribute('autocomplete', 'email');
  await expect(field(page, 'PASSWORD')).toHaveAttribute('autocomplete', 'current-password');

  // Show / hide the password.
  await field(page, 'PASSWORD').fill('typed');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(field(page, 'PASSWORD')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(field(page, 'PASSWORD')).toHaveAttribute('type', 'password');

  // Client checks before sending: the focus goes to the first invalid field.
  await field(page, 'PASSWORD').fill('');
  await page.getByRole('button', { name: 'SIGN IN', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Check the fields marked below.');
  await expect(page.getByText('Enter your email.')).toBeVisible();
  await expect(page.getByText('Enter your password.')).toBeVisible();
  await expect(field(page, 'EMAIL')).toBeFocused();
  expect(auth.calls.filter((c) => c.path === '/auth/login')).toHaveLength(0);

  // A wrong password: the server's answer on top; Enter submits.
  await field(page, 'EMAIL').fill('  ada.reviewer@example.test ');
  await field(page, 'PASSWORD').fill('fictional-wrong-pass');
  await field(page, 'PASSWORD').press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.');
  expect(auth.calls.at(-1)).toEqual({ method: 'POST', path: '/auth/login', body: { email: 'ada.reviewer@example.test', password: 'fictional-wrong-pass' } });

  // The right one: the app loads on the same URL, the header names the user.
  await field(page, 'PASSWORD').fill(PASSWORD);
  await field(page, 'PASSWORD').press('Enter');
  await loaded(page);
  expect(new URL(page.url()).pathname).toBe('/queue');
  await expect(navLink(page, 'UPLOAD & QUEUE')).toHaveAttribute('aria-current', 'page');
  await expect(userButton(page, 'Ada Reviewer')).toBeVisible();
  // Signed in, the "Your name" setting is gone: the server records the session's user.
  await expect(page.getByRole('button', { name: 'YOUR NAME' })).toHaveCount(0);

  expect(expectConsoleErrors(errors, AUTH_ANSWER)).toBeGreaterThan(0);
});

test('create account: the rules, client checks, 409 email_taken, then 201 signs the new account in', async ({ page, errors }) => {
  const auth = await fakeAuth(page, false);
  await page.goto('/map');
  await expect(signInHeading(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'CREATE ACCOUNT' })).toBeVisible();
  for (const rule of ['10 to 128 characters', 'Not the same as your email', 'Not a common password']) {
    await expect(page.getByRole('listitem').filter({ hasText: rule })).toBeVisible();
  }
  await expect(field(page, 'PASSWORD')).toHaveAttribute('autocomplete', 'new-password');
  await expect(field(page, 'REPEAT PASSWORD')).toHaveAttribute('autocomplete', 'new-password');

  await field(page, 'EMAIL').fill(USER.email);
  await field(page, 'DISPLAY NAME').fill('Ada Second');
  await field(page, 'PASSWORD').fill('short');
  await field(page, 'REPEAT PASSWORD').fill('other');
  await page.getByRole('button', { name: 'CREATE ACCOUNT', exact: true }).click();
  await expect(page.getByText('Use at least 10 characters.')).toBeVisible();
  await expect(page.getByText('The passwords do not match.')).toBeVisible();
  await expect(field(page, 'PASSWORD')).toBeFocused();
  await field(page, 'PASSWORD').fill(USER.email.toUpperCase());
  await field(page, 'REPEAT PASSWORD').fill(USER.email.toUpperCase());
  await field(page, 'REPEAT PASSWORD').press('Enter');
  await expect(page.getByText('The password must not be your email.')).toBeVisible();
  expect(auth.calls.filter((c) => c.path === '/auth/register')).toHaveLength(0);

  await field(page, 'PASSWORD').fill(NEW_PASSWORD);
  await field(page, 'REPEAT PASSWORD').fill(NEW_PASSWORD);
  await field(page, 'REPEAT PASSWORD').press('Enter');
  await expect(page.getByRole('alert')).toHaveText('An account with this email exists. Sign in instead.');
  await expect(field(page, 'EMAIL')).toHaveAttribute('aria-invalid', 'true');
  await expect(field(page, 'EMAIL')).toBeFocused();

  await field(page, 'EMAIL').fill('ada.second@example.test');
  await field(page, 'REPEAT PASSWORD').press('Enter');
  await loaded(page);
  expect(auth.calls.at(-1)).toEqual({
    method: 'POST', path: '/auth/register', body: { email: 'ada.second@example.test', password: NEW_PASSWORD, display_name: 'Ada Second' },
  });
  expect(new URL(page.url()).pathname).toBe('/map');
  await expect(userButton(page, 'Ada Second')).toBeVisible();

  expect(expectConsoleErrors(errors, AUTH_ANSWER)).toBeGreaterThan(0);
});

test('a rate limit says how long to wait (Retry-After)', async ({ page, errors }) => {
  const auth = await fakeAuth(page, false);
  auth.nextLogin = { status: 429, body: error('rate_limited', 'Too many attempts.'), headers: { 'Retry-After': '120' } };
  await page.goto('/map');
  await expect(signInHeading(page)).toBeVisible({ timeout: 15_000 });
  await field(page, 'EMAIL').fill(USER.email);
  await field(page, 'PASSWORD').fill(PASSWORD);
  await field(page, 'PASSWORD').press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Too many attempts. Try again in 2 minutes.');
  expectConsoleErrors(errors, AUTH_ANSWER);
});

test('user menu: email and role; SIGN OUT posts logout and shows the sign-in on the same URL', async ({ page, errors }) => {
  const auth = await fakeAuth(page, true);
  await page.goto('/queue');
  await loaded(page);
  await userButton(page, 'Ada Reviewer').click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await expect(menu).toContainText(USER.email);
  await expect(menu).toContainText('ADMIN');
  // Escape closes the menu and gives the focus back to the button.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(userButton(page, 'Ada Reviewer')).toBeFocused();

  await userButton(page, 'Ada Reviewer').click();
  await menu.getByRole('button', { name: 'SIGN OUT' }).click();
  await expect(signInHeading(page)).toBeVisible();
  expect(auth.calls.filter((c) => c.method === 'POST' && c.path === '/auth/logout')).toHaveLength(1);
  expect(new URL(page.url()).pathname).toBe('/queue');
  // A plain sign-out is no "session ended".
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  expectConsoleErrors(errors, AUTH_ANSWER);
});

test('a 401 on a data request mid-session: the sign-in on the same URL, and back there after signing in', async ({ page, request, errors }) => {
  // A plotted borehole: its full record is fetched only when its detail opens.
  const plotted = (await mapFeatures(request))[0];
  expect(plotted, 'a plotted borehole in the fictional seed').toBeTruthy();
  const { uid, borehole_id: id } = plotted.properties;
  const auth = await fakeAuth(page, true);
  await page.goto('/map');
  await loaded(page);
  await expect(resultRow(page, id)).toBeVisible();

  // The server ends the session (expired, signed out elsewhere) just before the detail's record is
  // asked for: that request answers 401, as would every one after it.
  auth.expireOn = `/boreholes/${uid}`;
  await resultRow(page, id).click();
  await expect(signInHeading(page)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Your session ended. Sign in again.');
  expect(new URL(page.url()).pathname).toBe(`/boreholes/${uid}`);

  await field(page, 'EMAIL').fill(USER.email);
  await field(page, 'PASSWORD').fill(PASSWORD);
  await field(page, 'PASSWORD').press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: id, exact: true })).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe(`/boreholes/${uid}`);
  expect(expectConsoleErrors(errors, AUTH_ANSWER)).toBeGreaterThan(0);
});

test('change password: client checks, a wrong current password, then success with a toast', async ({ page, errors }) => {
  const auth = await fakeAuth(page, true);
  await page.goto('/map');
  await loaded(page);
  await userButton(page, 'Ada Reviewer').click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'CHANGE PASSWORD' }).click();
  const dialog = page.getByRole('dialog', { name: 'CHANGE PASSWORD' });
  await expect(dialog).toBeVisible();
  await expect(field(page, 'CURRENT PASSWORD')).toBeFocused();
  // Escape closes it; the focus goes back to the user button.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(userButton(page, 'Ada Reviewer')).toBeFocused();

  await userButton(page, 'Ada Reviewer').click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'CHANGE PASSWORD' }).click();
  await dialog.getByRole('button', { name: 'CHANGE PASSWORD', exact: true }).click();
  await expect(dialog.getByText('Enter your current password.')).toBeVisible();
  await expect(field(page, 'CURRENT PASSWORD')).toBeFocused();

  await field(page, 'CURRENT PASSWORD').fill('fictional-wrong-pass');
  await field(page, 'NEW PASSWORD').fill(NEW_PASSWORD);
  await field(page, 'REPEAT NEW PASSWORD').fill(NEW_PASSWORD);
  await field(page, 'REPEAT NEW PASSWORD').press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('The current password is wrong.');
  await expect(field(page, 'CURRENT PASSWORD')).toBeFocused();

  await field(page, 'CURRENT PASSWORD').fill(PASSWORD);
  await field(page, 'REPEAT NEW PASSWORD').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Password changed. Your other sessions were signed out.' })).toBeVisible();
  expect(auth.calls.filter((c) => c.path === '/auth/password').at(-1)?.body).toEqual({ current_password: PASSWORD, new_password: NEW_PASSWORD });
  // Still signed in.
  await expect(userButton(page, 'Ada Reviewer')).toBeVisible();
  expectConsoleErrors(errors, AUTH_ANSWER);
});

test('the sign-in screen fits a 390 px phone without sideways scrolling', async ({ page, errors }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await fakeAuth(page, false);
  await page.goto('/map');
  await expect(signInHeading(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Create an account' }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await page.getByRole('button', { name: 'CREATE ACCOUNT', exact: true }).boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  expectConsoleErrors(errors, AUTH_ANSWER);
});

test('the real stack (health without auth) has no sign-in: no session check, the "Your name" setting as before', async ({ page, request, apiLog }) => {
  const health = await getJson<Record<string, unknown>>(request, '/health');
  expect(health.auth, 'contract 1.1.0 stack without sign-in').toBeUndefined();
  await page.goto('/map');
  await loaded(page);
  await expect(page.getByRole('button', { name: 'YOUR NAME' })).toBeVisible();
  expect(apiLog.filter((c) => new URL(c.url).pathname.startsWith(`${API}/auth/`))).toEqual([]);
});
