/**
 * App shell in API mode against the running stack.
 *
 * Seed state needed: the backend runs without provider keys (GET /api/v1/health says mode "demo")
 * and the fictional seed is loaded (`python -m app.seed`). Read-only: changes nothing.
 */
import type { Page } from '@playwright/test';
import { API, expect, getJson, nav, navLink, openApp, records, test, type WireRecord } from './fixtures';

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

test('header: product name from config, three screens as links with their URLs, no console errors on any screen', async ({ page }) => {
  await openApp(page);
  await expect(page).toHaveTitle('Bormisu');
  await expect(page.getByRole('banner')).toContainText('Bormisu');
  // No inbox before M2.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveCount(3);
  const paths = { 'UPLOAD & QUEUE': /^\/queue$/, REVIEW: /^\/review\/[^/]+$/, MAP: /^\/map$/ };
  for (const screen of ['UPLOAD & QUEUE', 'REVIEW', 'MAP'] as const) {
    await nav(page, screen);
    await expect(navLink(page, screen)).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).pathname).toMatch(paths[screen]);
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

/**
 * The API source's one console.info per load about values it shows without a provenance entry
 * (src/data/apiSource.ts reportUnsourced): "<n> values in <m> boreholes have no provenance entry … E.g.
 * <uid> <path>, …". The contract allows sparse provenance, so it is no warning (PROV-SPARSE).
 */
const UNSOURCED = /^\d+ values? in \d+ boreholes? (?:has|have) no provenance entry/;

/** The borehole list request of the app (one per load). */
const LIST = /\/api\/v1\/boreholes\?limit=/;

/**
 * Opens the app, waits until every borehole is listed in RESULTS, and returns the summaries the app
 * logged about values without a provenance entry. No warning may mention provenance.
 */
async function unsourcedSummaries(page: Page, warnings: string[], boreholes: number): Promise<string[]> {
  const infos: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'info' && UNSOURCED.test(m.text())) infos.push(m.text());
  });
  await openApp(page);
  await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(boreholes);
  // A round trip after the render, so a console message logged before it has arrived.
  await page.evaluate(() => undefined);
  expect(warnings.filter((w) => /provenance/i.test(w)), 'warnings about provenance').toEqual([]);
  return infos;
}

/** Values the provenance rule of contract 1.1.0 exempts (server-computed). */
const SERVER_COMPUTED = /^metadata\.(aliases|coordinates\.crs_code|coordinates\.crs_label)$|\.(thickness_m|description_language)$/;

/**
 * Gives every stated value of a record that has no provenance entry one (a copy of the record's
 * first entry), except the paths `keep` matches. Changes only the browser's copy of the list.
 */
function sourceAllBut(r: WireRecord, keep: RegExp): void {
  const [template] = Object.values(r.provenance);
  const add = (path: string) => {
    if (r.provenance[path] || SERVER_COMPUTED.test(path) || keep.test(path)) return;
    r.provenance[path] = { ...template, raw: null, ai_value: null, confidence: null, readings: [], status: 'unreviewed', state: 'ok', flag: null };
  };
  const walk = (v: unknown, path: string): void => {
    if (v == null) return;
    if (Array.isArray(v)) {
      if (v.some((x) => x !== null && typeof x === 'object')) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v.length) add(path);
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    } else {
      add(path);
    }
  };
  const rec = r as unknown as Record<string, unknown>;
  for (const top of ['metadata', 'stratigraphy', 'groundwater', 'samples', 'test_results']) walk(rec[top], top);
  walk(rec.rock_head_m, 'rock_head_m');
}

test('FE-PROV-1: every layer’s Lithology row has a source, also when the backend tracks only original_description', async ({ page, request, warnings }) => {
  const all = await records(request);
  // Since contract 1.1.0 the seed tracks english_lithology itself. The browser's copy of the list drops
  // those entries again wherever the description has one (the older seed's shape), so the Lithology
  // row has to fall back to original_description.
  const onDescription = all.flatMap((r) =>
    r.stratigraphy.flatMap((l, i) => (l.english_lithology && r.provenance[`stratigraphy[${i}].original_description`] ? [i] : [])),
  );
  expect(onDescription.length, 'seeded layers with an English lithology and a described source').toBeGreaterThan(0);
  // Every other value gets an entry in the browser's copy of the list, so only a Lithology row could
  // be left without a source (it would be reported at stratigraphy[i].english_lithology).
  await page.route(LIST, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { boreholes: WireRecord[] };
    for (const r of body.boreholes) {
      r.stratigraphy.forEach((_, i) => {
        if (r.provenance[`stratigraphy[${i}].original_description`]) delete r.provenance[`stratigraphy[${i}].english_lithology`];
      });
      sourceAllBut(r, /^stratigraphy\[\d+\]\.english_lithology$/);
    }
    await route.fulfill({ response: res, json: body });
  });
  expect(await unsourcedSummaries(page, warnings, all.length), 'values shown without a provenance entry').toEqual([]);
});

test('BE-PROV-1: every value the seed states has a provenance entry', async ({ page, request, warnings }) => {
  // Contract 1.1.0 (provenance rule): every non-null value at a ValuePatch path has an entry, except
  // server-computed ones. The app shows such a value read-only and logs one summary per load.
  // (Fixed by the backend in contract 1.1.0; the 1.0.0 seed left location_name, country, client … without one.)
  const all = await records(request);
  expect(await unsourcedSummaries(page, warnings, all.length), 'values shown without a provenance entry').toEqual([]);
});
