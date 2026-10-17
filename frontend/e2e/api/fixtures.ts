/**
 * Shared fixtures of the API-mode e2e suite (fictional seed data only). Runs against a running app
 * (E2E_BASE_URL, e.g. docker compose plus `python -m app.seed`); see playwright.config.ts.
 *
 * - OSM tiles are answered with a blank PNG, so the tests run offline and fast.
 * - Console errors and page errors are collected and must be empty at the end of every test (as in
 *   e2e/fixtures.ts). A failed request (4xx / 5xx) also logs a console error in Chrome, so an
 *   unexpected error answer of the backend fails the test too.
 * - Every /api/ response is recorded (`apiLog`) and written next to a failing test as api-log.json
 *   (also for every test with E2E_SHOW_KNOWN=1), for root causes.
 * - The helpers below read the seed state straight from the backend with Playwright's `request`
 *   (same origin, through nginx), so the specs never hard-code ids, and put back what a test
 *   changed when the UI cannot.
 * - knownBug(id) marks a test that fails because of a reported finding; E2E_SHOW_KNOWN=1 shows the
 *   actual failure.
 */
import { test as base, expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

/** A 1×1 light-grey PNG. */
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
  'base64',
);

export const API = '/api/v1';

/** Pin and chip colours (src/theme.ts COL). */
export const COLOR = { approved: '#7DB713', attention: '#E39B00', grey: '#A3A3A2', unknownDin: '#E0E0E0' } as const;

/** Status chip labels (src/theme.ts statusChip). */
export const STATUS_LABEL = {
  approved: 'Approved',
  in_review: 'In review',
  unreviewed: 'Unreviewed',
  attention: 'Needs attention',
} as const;

/** Labels of the backend's unplotted_reason codes (FRONTEND.md 4.9). */
export const UNPLOTTED_LABEL: Record<string, string> = {
  no_coordinates: 'No coordinates in source',
  crs_unknown: 'Coordinate system unknown',
  crs_unconfirmed: 'Coordinate system needs confirmation',
  implausible: 'Coordinates implausible',
};

/** The DIN 4023 code table shared with the backend (assets/din4023_patterns/din_codes.json). */
export const DIN_CODES = JSON.parse(
  readFileSync(new URL('../../../assets/din4023_patterns/din_codes.json', import.meta.url), 'utf8'),
) as Record<string, { pattern_id: string; name_en: string; colour: string | null }>;

/* ---------- wire shapes (only what the specs read) ---------- */

export interface WireProvenance {
  page: number | null;
  box: number[] | null;
  raw: string | null;
  cell: string | null;
  method: string;
  confidence: number | null;
  status: 'unreviewed' | 'approved' | 'flagged';
  state: 'ok' | 'not_in_source' | 'illegible';
  ai_value: unknown;
  flag: string | null;
  readings: { reader: string; text: string; confidence: number | null }[];
}

export interface WireRecord {
  uid: string;
  document_id: string;
  source_file: string;
  revision: number;
  review_status: 'unreviewed' | 'in_review' | 'approved';
  crs_status: 'stated' | 'inferred' | 'confirmed' | 'unknown';
  plotted: boolean;
  unplotted_reason: string | null;
  open_clarifications?: number;
  rock_head_m: number | null;
  metadata: {
    borehole_id: string;
    project_name: string | null;
    borehole_depth_m: number | null;
    surface_elevation_mASL: number | null;
    elevation_datum: string | null;
    coordinates: {
      latitude: number | null;
      longitude: number | null;
      local_x: number | null;
      local_y: number | null;
      coordinate_system: string | null;
      crs_code: string | null;
      x_raw: string | null;
      y_raw: string | null;
      axis_labels_raw: string | null;
    };
  };
  stratigraphy: { depth_from_m: number; depth_to_m: number; din4023_code: string | null; english_lithology: string | null }[];
  provenance: Record<string, WireProvenance>;
  lint: { path: string; severity: string; message: string }[];
}

export interface WireDocument {
  document_id: string;
  file_name: string;
  project: string | null;
  status: string;
  error: string | null;
  page_count: number | null;
  pages: {
    n: number;
    type: string;
    role: string | null;
    used: boolean;
    unused_reason: string | null;
    duplicate_of: { document_id: string; n: number } | null;
  }[];
  progress: { pages_total: number; pages_classified: number; pages_ocr_total: number; pages_ocr_done: number; boreholes_extracted: number } | null;
  found: { boreholes: number; layers: number; spt: number; groundwater: number } | null;
  open_clarifications: number;
}

export interface WireFeature {
  geometry: { coordinates: [number, number] };
  properties: { uid: string; borehole_id: string; review_status: string; attention: boolean };
}

/* ---------- backend reads and writes ---------- */

export async function getJson<T>(api: APIRequestContext, path: string): Promise<T> {
  const res = await api.get(API + path);
  expect(res.status(), `GET ${path}`).toBe(200);
  return (await res.json()) as T;
}

export async function records(api: APIRequestContext, query = ''): Promise<WireRecord[]> {
  return (await getJson<{ boreholes: WireRecord[] }>(api, `/boreholes${query}`)).boreholes;
}

export async function record(api: APIRequestContext, uid: string): Promise<WireRecord> {
  return getJson<WireRecord>(api, `/boreholes/${encodeURIComponent(uid)}`);
}

/** The seeded borehole with this printed ID (borehole IDs are unique in the fictional seed). */
export async function recordByLabel(api: APIRequestContext, label: string): Promise<WireRecord> {
  const all = await records(api);
  const hit = all.filter((r) => r.metadata.borehole_id === label);
  expect(hit, `exactly one seeded borehole "${label}" (python -m app.seed)`).toHaveLength(1);
  return hit[0];
}

export async function documents(api: APIRequestContext): Promise<WireDocument[]> {
  return (await getJson<{ documents: WireDocument[] }>(api, '/documents')).documents;
}

export async function mapFeatures(api: APIRequestContext): Promise<WireFeature[]> {
  return (await getJson<{ features: WireFeature[] }>(api, '/map/boreholes.geojson')).features;
}

/**
 * One review action straight on the backend, at the record's current revision (cleanup only, when a
 * test cannot undo its change through the UI, or after a failure). Returns the new record.
 */
export async function patchValue(
  api: APIRequestContext,
  uid: string,
  body: { path: string; action: string; value?: unknown; state?: string; reason?: string | null },
): Promise<WireRecord> {
  const current = await record(api, uid);
  const res = await api.patch(`${API}/boreholes/${encodeURIComponent(uid)}/values`, {
    data: { ...body, if_revision: current.revision },
  });
  expect(res.status(), `PATCH ${body.action} ${body.path}: ${await res.text()}`).toBe(200);
  return (await res.json()) as WireRecord;
}

/** Puts a value back to unreviewed with no flag (`reset`) unless it already is. */
export async function ensureUnreviewed(api: APIRequestContext, uid: string, path: string): Promise<void> {
  const p = (await record(api, uid)).provenance[path];
  expect(p, `provenance entry ${path}`).toBeTruthy();
  if (p.state !== 'ok') await patchValue(api, uid, { path, action: 'set_state', state: 'ok' });
  if (p.status !== 'unreviewed' || p.flag) await patchValue(api, uid, { path, action: 'reset' });
}

/** Expected display status of a map feature: attention wins over the review status (src/domain/status.ts). */
export function expectedStatus(f: { review_status: string; attention: boolean }): keyof typeof STATUS_LABEL {
  return f.attention ? 'attention' : (f.review_status as keyof typeof STATUS_LABEL);
}

/** Expected pin colour of a status (src/theme.ts pinColor). */
export function expectedPinColor(status: keyof typeof STATUS_LABEL): string {
  return status === 'approved' ? COLOR.approved : status === 'attention' ? COLOR.attention : COLOR.grey;
}

/* ---------- fixtures ---------- */

export interface ApiCall {
  method: string;
  url: string;
  status: number;
  requestBody: string | null;
}

export const test = base.extend<{ errors: string[]; warnings: string[]; apiLog: ApiCall[] }>({
  apiLog: [
    async ({ page }, use, testInfo) => {
      const log: ApiCall[] = [];
      page.on('response', (r) => {
        if (!r.url().includes('/api/')) return;
        const req = r.request();
        log.push({ method: req.method(), url: r.url(), status: r.status(), requestBody: req.postData() });
      });
      await use(log);
      if (testInfo.status !== testInfo.expectedStatus || process.env.E2E_SHOW_KNOWN) {
        const path = testInfo.outputPath('api-log.json');
        writeFileSync(path, JSON.stringify(log, null, 2));
        await testInfo.attach('api-log.json', { path, contentType: 'application/json' });
      }
    },
    { auto: true },
  ],
  warnings: [
    async ({ page }, use) => {
      const warnings: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'warning') warnings.push(m.text());
      });
      await use(warnings);
    },
    { auto: true },
  ],
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`);
      });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route(/tile\.openstreetmap\.org/, (route) =>
        route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }),
      );
      await use(errors);
      expect(errors, 'console errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Marks a test as failing because of a reported finding (the suite documents the bug and turns red
 * once it is fixed, so the marker gets removed). E2E_SHOW_KNOWN=1 runs these tests normally to show
 * the actual failure.
 */
export function knownBug(id: string, why: string): void {
  test.fail(!process.env.E2E_SHOW_KNOWN, `${id}: ${why}`);
}

/* ---------- UI helpers ---------- */

/** Opens the app and waits until boreholes and documents are loaded (map screen). */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible({ timeout: 15_000 });
}

/** Waits until the header is there and the loading state is gone (after goto, reload or Back). */
export async function loaded(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Loading boreholes and documents…')).toHaveCount(0, { timeout: 15_000 });
}

/** Opens a URL of the app (deep link) and waits for the data, whatever screen it shows. */
export async function openUrl(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await loaded(page);
}

/** Reloads the page and waits for the data again; the URL keeps the screen (F4 router). */
export async function reload(page: Page): Promise<void> {
  await page.reload();
  await loaded(page);
}

/** A link of the header nav (MAP, UPLOAD & QUEUE with its badge, REVIEW). */
export const navLink = (page: Page, name: 'MAP' | 'UPLOAD & QUEUE' | 'REVIEW') =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(`^${name}`) });

/** Goes to one of the three main screens through the header nav. */
export async function nav(page: Page, name: 'MAP' | 'UPLOAD & QUEUE' | 'REVIEW'): Promise<void> {
  await navLink(page, name).click();
}

/** A RESULTS row by its borehole ID as printed. */
export const resultRow = (page: Page, id: string) =>
  page.locator('[role="table"] [role="row"][data-uid]').filter({ has: page.getByText(id, { exact: true }) });

/** From the map screen: opens the Detail screen of a borehole through its RESULTS row. */
export async function openDetail(page: Page, id: string): Promise<void> {
  await nav(page, 'MAP');
  await resultRow(page, id).click();
  await expect(page.getByRole('heading', { level: 1, name: id, exact: true })).toBeVisible();
}

/** Opens the Review screen of a borehole: RESULTS row → Detail → › OPEN IN REVIEW. */
export async function openReview(page: Page, id: string): Promise<void> {
  await openDetail(page, id);
  await page.getByRole('button', { name: '› OPEN IN REVIEW' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `REVIEW · ${id}` })).toBeVisible();
}

/** A Review field row by its value key (data-key, see src/domain/keys.ts). */
export const fieldRow = (page: Page, key: string) => page.locator(`[aria-label="Extracted values"] [data-key="${key}"]`);

/** The map's circle markers (Leaflet SVG paths) on the main map. */
export const pins = (page: Page) =>
  page.getByRole('region', { name: 'Borehole map' }).locator('.leaflet-overlay-pane path.leaflet-interactive');

/**
 * Runs `action` and waits for the next `count` PATCH answers of a borehole's values; resolves with
 * their request bodies in order. A non-200 answer rejects with the backend's body.
 */
export async function patchesDuring(page: Page, uid: string, count: number, action: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const onResponse = async (res: Response) => {
      if (res.request().method() !== 'PATCH' || !res.url().endsWith(`/boreholes/${uid}/values`)) return;
      bodies.push(JSON.parse(res.request().postData() ?? '{}') as Record<string, unknown>);
      if (res.status() !== 200) {
        page.off('response', onResponse);
        reject(new Error(`PATCH answered ${res.status()}: ${await res.text()}`));
        return;
      }
      if (bodies.length >= count) {
        page.off('response', onResponse);
        resolve();
      }
    };
    page.on('response', onResponse);
  });
  await action();
  await done;
  return bodies;
}
