/**
 * App shell in API mode against the running stack.
 *
 * Seed state needed: the backend runs without provider keys (GET /api/v1/health says mode "demo")
 * and the fictional seed is loaded (`python -m app.seed`). Read-only: changes nothing.
 */
import { API, expect, getJson, knownBug, nav, openApp, test } from './fixtures';

interface Health {
  mode: string;
  providers: Record<string, boolean>;
  upload: { max_mb: number; extensions: string[] };
}

test('health at boot: demo banner, upload off with the reason, accept list from health', async ({ page, request }) => {
  const health = await getJson<Health>(request, '/health');
  expect(health.mode, 'this suite runs against a stack without provider keys').toBe('demo');

  const healthCall = page.waitForResponse((r) => r.url().endsWith(`${API}/health`) && r.request().method() === 'GET');
  await openApp(page);
  expect((await healthCall).status()).toBe(200);

  const banner = page.getByRole('note');
  await expect(banner).toContainText('DEMO MODE');
  await expect(banner).toContainText('Live extraction needs API keys');
  // The sample-mode banner never shows in the API build.
  await expect(page.getByText('fictional sample loaded')).toHaveCount(0);

  await nav(page, 'UPLOAD & QUEUE');
  const zone = page.locator('label').filter({ hasText: 'DROP REPORTS HERE' });
  await expect(zone).toHaveAttribute('aria-disabled', 'true');
  await expect(zone).toHaveAttribute('title', 'Live extraction needs API keys');
  await expect(zone).toContainText('Uploading is off: Live extraction needs API keys.');
  const input = zone.locator('input[type="file"]');
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute('accept', health.upload.extensions.join(','));
});

test('header: product name from config, three screens, no console errors on any screen', async ({ page }) => {
  await openApp(page);
  await expect(page).toHaveTitle('Bormisu');
  await expect(page.getByRole('banner')).toContainText('Bormisu');
  for (const screen of ['UPLOAD & QUEUE', 'REVIEW', 'MAP'] as const) {
    await nav(page, screen);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${screen}`) })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
});

test('no frontend-only API calls fail: every request the app makes at boot answers 200', async ({ page, apiLog }) => {
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  await nav(page, 'REVIEW');
  await expect(page.getByRole('heading', { level: 1, name: /^REVIEW · / })).toBeVisible();
  const failed = apiLog.filter((c) => c.status >= 400);
  expect(failed, 'API calls answered with an error').toEqual([]);
  // The list is loaded once, with the contract's maximum page size, and the documents once.
  expect(apiLog.filter((c) => c.method === 'GET' && /\/api\/v1\/boreholes\?limit=5000$/.test(c.url))).toHaveLength(1);
  expect(apiLog.filter((c) => c.method === 'GET' && c.url.endsWith('/api/v1/documents'))).toHaveLength(1);
});

/** Paths the adapter warns about: "Backend bug: borehole <uid> has a value at <path> without a provenance entry." */
const unsourced = (warnings: string[]) =>
  warnings.flatMap((w) => {
    const m = /^Backend bug: borehole \S+ has a value at (\S+) without a provenance entry\.$/.exec(w);
    return m ? [m[1]] : [];
  });

test('FE-PROV-1: layer lithology has a source (the seed and the contract examples put it on original_description)', async ({ page, warnings }) => {
  // The adapter anchors the Lithology row at english_lithology; the backend (seed and
  // contracts/examples/BoreholeRecord.full.json) tracks a layer's description at original_description.
  knownBug('FE-PROV-1', 'Lithology rows look for provenance at english_lithology only');
  await openApp(page);
  expect(unsourced(warnings).filter((p) => p.endsWith('.english_lithology')), 'lithology rows without a source').toEqual([]);
});

test('BE-PROV-1: every other value the seed states has a provenance entry', async ({ page, warnings }) => {
  // FRONTEND.md 4.8: a value without a provenance entry cannot be reviewed and is a backend bug.
  knownBug('BE-PROV-1', 'seeded location_name, country, client, colour, consistency_density, is_core without provenance');
  await openApp(page);
  expect(unsourced(warnings).filter((p) => !p.endsWith('.english_lithology')), 'values without provenance').toEqual([]);
});
