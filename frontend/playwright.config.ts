import { defineConfig } from '@playwright/test';

/**
 * Two Playwright projects; which one runs depends on E2E_BASE_URL.
 *
 * - `sample` (E2E_BASE_URL unset): e2e/*.spec.ts against `npm run dev:sample`, which this config
 *   starts on 127.0.0.1:$PORT (default 5174) and stops afterwards.
 *     npm run e2e
 *
 * - `api` (E2E_BASE_URL set): e2e/api/**\/*.spec.ts against a running app in API mode, usually
 *   `docker compose up --build -d` plus the fictional seed (`docker compose exec api python -m app.seed`).
 *   No web server is started. The specs change review data and put it back afterwards; each spec
 *   names the seed state it needs at its top.
 *     E2E_BASE_URL=http://localhost:8080 npm run e2e
 *     E2E_BASE_URL=http://localhost:8080 npx playwright test --project=api e2e/api/review.spec.ts
 *
 * Locally both use the installed Chrome (`channel: 'chrome'`); in CI (`CI` set) Playwright's bundled
 * Chromium (`npx playwright install --with-deps chromium`).
 */
const port = Number(process.env.PORT ?? 5174);
const externalURL = process.env.E2E_BASE_URL?.trim() || undefined;
const browser = process.env.CI ? {} : { channel: 'chrome' as const };
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  // One retry absorbs a page that is slow to load while the whole suite runs on a busy machine; a real
  // failure still fails twice.
  retries: 1,
  use: { ...browser, viewport },
  projects: externalURL
    ? [
        {
          name: 'api',
          testDir: 'e2e/api',
          // The api specs share one backend and change its review data: one worker, in file order.
          fullyParallel: false,
          use: { ...browser, viewport, baseURL: externalURL },
        },
      ]
    : [
        {
          name: 'sample',
          testDir: 'e2e',
          testIgnore: ['api/**'],
          use: { ...browser, viewport, baseURL: `http://127.0.0.1:${port}` },
        },
      ],
  // One worker in API mode: the specs share the seeded database.
  workers: externalURL ? 1 : undefined,
  webServer: externalURL
    ? undefined
    : {
        command: `npm run dev:sample -- --host 127.0.0.1 --port ${port} --strictPort`,
        url: `http://127.0.0.1:${port}`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
