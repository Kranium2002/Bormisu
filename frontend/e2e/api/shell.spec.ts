/**
 * App shell in API mode against the running stack.
 *
 * Seed state needed: the backend runs without provider keys (GET /api/v1/health says mode "demo")
 * and the fictional seed is loaded (`python -m app.seed`). Read-only: changes nothing.
 */
import type { Page } from '@playwright/test';
import { API, editRecords, expect, getJson, loadEveryRecord, nav, navLink, openApp, records, test, type WireRecord } from './fixtures';

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

test('header: product name from config, the screens as links with their URLs, no console errors on any screen', async ({ page }) => {
  await openApp(page);
  await expect(page).toHaveTitle('Bormisu');
  await expect(page.getByRole('banner')).toContainText('Bormisu');
  // MAP, LIST, UPLOAD & QUEUE and INBOX are links (Review opens from UPLOAD & QUEUE).
  for (const screen of ['MAP', 'LIST', 'UPLOAD & QUEUE', 'INBOX'] as const) await expect(navLink(page, screen)).toHaveCount(1);
  const paths = { 'UPLOAD & QUEUE': /^\/queue$/, LIST: /^\/list$/, INBOX: /^\/inbox$/, MAP: /^\/map$/ };
  for (const screen of ['UPLOAD & QUEUE', 'LIST', 'INBOX', 'MAP'] as const) {
    await nav(page, screen);
    await expect(navLink(page, screen)).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).pathname).toMatch(paths[screen]);
  }
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
});

test('no frontend-only API calls fail: every request the app makes at boot answers 200', async ({ page, apiLog }) => {
  await openApp(page);
  const boot = [...apiLog];
  await nav(page, 'UPLOAD & QUEUE');
  await nav(page, 'REVIEW');
  await expect(page.getByRole('heading', { level: 1, name: /^REVIEW · / })).toBeVisible();
  const failed = apiLog.filter((c) => c.status >= 400);
  expect(failed, 'API calls answered with an error').toEqual([]);
  const gets = (calls: typeof apiLog, re: RegExp) => calls.filter((c) => c.method === 'GET' && re.test(new URL(c.url).pathname + new URL(c.url).search));
  // The boot loads the documents, the light map layer and the NOT ON MAP records once each …
  expect(gets(boot, /^\/api\/v1\/documents$/)).toHaveLength(1);
  expect(gets(boot, /^\/api\/v1\/map\/boreholes\.geojson$/)).toHaveLength(1);
  expect(gets(boot, /^\/api\/v1\/boreholes\?(.*&)?plotted=false(&|$)/)).toHaveLength(1);
  // … and never the full records of every borehole (the backend asked for this: records are large).
  expect(gets(apiLog, /^\/api\/v1\/boreholes\?/).filter((c) => !/[?&]plotted=false(&|$)/.test(c.url))).toEqual([]);
  // The questions for the inbox, asked once after the load: the unresolved ones (open and skipped).
  expect(gets(apiLog, /^\/api\/v1\/clarifications\?(.*&)?status=open(&|$)/)).toHaveLength(1);
  expect(gets(apiLog, /^\/api\/v1\/clarifications\?(.*&)?status=skipped(&|$)/)).toHaveLength(1);
  // Review loads its borehole's document on demand (its answer may land after the heading shows).
  await expect.poll(() => gets(apiLog, /^\/api\/v1\/documents\/[^/]+\/boreholes$/).length).toBeGreaterThan(0);
  expect(apiLog.filter((c) => c.status >= 400), 'API calls answered with an error').toEqual([]);
});

/**
 * The API source's one console.info per batch of records it loads about values it shows without a
 * provenance entry (src/data/apiSource.ts reportUnsourced): "<n> values in <m> boreholes have no
 * provenance entry … E.g. <uid> <path>, …". The contract allows sparse provenance, so it is no
 * warning (PROV-SPARSE).
 */
const UNSOURCED = /^\d+ values? in \d+ boreholes? (?:has|have) no provenance entry/;

/**
 * Opens the app, waits until every borehole is listed in RESULTS, loads every full record (the boot
 * loads only the NOT ON MAP ones; the rest come on demand: one Review per document), and returns the
 * summaries the app logged about values without a provenance entry. No warning may mention provenance.
 */
async function unsourcedSummaries(page: Page, warnings: string[], all: WireRecord[]): Promise<string[]> {
  const infos: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'info' && UNSOURCED.test(m.text())) infos.push(m.text());
  });
  await openApp(page);
  await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(all.length);
  await loadEveryRecord(page, all);
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
  // Every other value gets an entry in the browser's copy of each record, so only a Lithology row could
  // be left without a source (it would be reported at stratigraphy[i].english_lithology).
  await editRecords(page, (r) => {
    r.stratigraphy.forEach((_, i) => {
      if (r.provenance[`stratigraphy[${i}].original_description`]) delete r.provenance[`stratigraphy[${i}].english_lithology`];
    });
    sourceAllBut(r, /^stratigraphy\[\d+\]\.english_lithology$/);
  });
  expect(await unsourcedSummaries(page, warnings, all), 'values shown without a provenance entry').toEqual([]);
});

test('BE-PROV-1: every value the seed states has a provenance entry', async ({ page, request, warnings }) => {
  // Contract 1.1.0 (provenance rule): every non-null value at a ValuePatch path has an entry, except
  // server-computed ones. The app shows such a value read-only and logs one summary per load.
  // (Fixed by the backend in contract 1.1.0; the 1.0.0 seed left location_name, country, client … without one.)
  const all = await records(request);
  expect(await unsourcedSummaries(page, warnings, all), 'values shown without a provenance entry').toEqual([]);
});
