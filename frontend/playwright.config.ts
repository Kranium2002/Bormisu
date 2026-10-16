import { defineConfig } from '@playwright/test';

/** Smoke tests run against `npm run dev:sample` with the system Chrome. */
const port = Number(process.env.PORT ?? 5174);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npm run dev:sample -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
