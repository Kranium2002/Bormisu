import { defineConfig } from '@playwright/test';

/**
 * Smoke tests run against `npm run dev:sample`: with the system Chrome locally, with Playwright's
 * bundled Chromium in CI (`npx playwright install --with-deps chromium`).
 * E2E_BASE_URL (e.g. http://localhost:8080 from docker compose) runs them against that app instead
 * and starts no web server.
 */
const port = Number(process.env.PORT ?? 5174);
const externalURL = process.env.E2E_BASE_URL?.trim() || undefined;
const baseURL = externalURL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL,
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    viewport: { width: 1440, height: 900 },
  },
  webServer: externalURL
    ? undefined
    : {
        command: `npm run dev:sample -- --host 127.0.0.1 --port ${port} --strictPort`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
