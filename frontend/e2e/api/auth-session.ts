/**
 * A signed-in session for the API e2e suite once the backend ships sign-in (contract 1.3.0), behind
 * E2E_AUTH=1. Until then every spec runs as today (health without `auth`: no sign-in).
 *
 * With E2E_AUTH=1, `registerTestSession` creates a fictional account on the running stack
 * (e2e-<timestamp>@example.test with a strong fictional password; the first account of a fresh
 * database becomes admin) and saves its session cookie as a Playwright storage state. A spec that
 * imports `test` from this file starts every page signed in with that state (one account per
 * worker); without E2E_AUTH it is the `test` of ./fixtures unchanged.
 *
 *   E2E_AUTH=1 E2E_BASE_URL=http://localhost:8081 npx playwright test --project=api
 *
 * The account is fictional and stays in the test database; nothing here calls a model provider.
 */
import { request } from '@playwright/test';
import { API, test as base } from './fixtures';

export const E2E_AUTH = process.env.E2E_AUTH === '1';

/** A fictional account, new on every call. */
export function fictionalAccount(stamp = Date.now()): { email: string; password: string; display_name: string } {
  return {
    email: `e2e-${stamp}@example.test`,
    // 8 to 128 characters (contract 1.3.0, minimal auth).
    password: `Fictional-e2e-${stamp}-river-lantern-42`,
    display_name: 'E2E Fictional Reviewer',
  };
}

/**
 * Registers a fictional account on the stack at `baseURL` (POST /auth/register signs it in) and saves
 * the session as a storage state at `path`. The server's CSRF check compares the Origin, so the
 * request sends the app's own.
 */
export async function registerTestSession(baseURL: string, path: string): Promise<string> {
  const origin = new URL(baseURL).origin;
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: origin } });
  try {
    const account = fictionalAccount();
    const res = await api.post(`${API}/auth/register`, { data: account });
    if (res.status() !== 201) throw new Error(`Registering ${account.email} failed: HTTP ${res.status()} ${await res.text()}`);
    await api.storageState({ path });
    return path;
  } finally {
    await api.dispose();
  }
}

/** The suite's `test`; with E2E_AUTH=1 each page starts with a registered fictional account's session. */
export const test = base.extend<object, { authStorage: string | undefined }>({
  authStorage: [
    async ({}, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      if (!E2E_AUTH || !baseURL) {
        await use(undefined);
        return;
      }
      await use(await registerTestSession(baseURL, workerInfo.project.outputDir + `/auth-session-${workerInfo.workerIndex}.json`));
    },
    { scope: 'worker' },
  ],
  storageState: async ({ authStorage, storageState }, use) => {
    await use(authStorage ?? storageState);
  },
});

export { expect } from './fixtures';
