/**
 * Explore layout in API mode against the seeded backend (fictional seed only): filters run as
 * result sets with the server's counts (and a reload brings the set back from its id), place search
 * on the server's candidates, a place without uploaded boreholes, and the geocoder being down.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`). Nothing is changed: the specs only
 * create result sets (immutable snapshots) and read. Expected values come from the backend's own
 * answers (records, result sets, places), never from hard-coded ids. Place search for real towns
 * goes through the server's geocoder when health says it has one; the spec adapts when it has not.
 */
import type { APIRequestContext, Page, Response } from '@playwright/test';
import { API, expect, expectConsoleErrors, getJson, mapFeatures, openApp, records, reload, test, type WireRecord } from './fixtures';

interface WireResultSet {
  result_set_id: string;
  count: number;
  located_count: number;
  unlocated_count: number;
  excluded_unreviewed?: number;
  uids: string[];
}
interface WirePlace { label: string; lat: number; lon: number; bbox: number[] | null; source: 'uploaded' | 'geocoder'; kind: string | null; borehole_count: number | null }
interface WireHealth { mode: string; providers: { geocoder: boolean } }
type SeedRecord = WireRecord & { metadata: WireRecord['metadata'] & { location_name?: string | null } };

const panel = (page: Page) => page.getByRole('region', { name: 'Search and filters' });
const rows = (page: Page) => page.locator('[role="table"] [role="row"][data-uid]');
const summary = (page: Page) => page.locator('[data-result-set-bar] p[aria-live]');
const placeField = (page: Page) => panel(page).getByRole('textbox', { name: 'Town, address or place' });
const places = (page: Page) => panel(page).getByRole('list', { name: 'Places found' }).getByRole('button');
const placeStatus = (page: Page) => panel(page).getByRole('status');
const rsParam = (page: Page) => new URL(page.url()).searchParams.get('rs');

/** The summary line the UI shows for a result set, from the server's counts. */
function summaryOf(rs: WireResultSet): string {
  const parts = [`${rs.count} ${rs.count === 1 ? 'borehole' : 'boreholes'}`, `${rs.located_count} on the map`, `${rs.unlocated_count} not located`];
  if (typeof rs.excluded_unreviewed === 'number') parts.push(`${rs.excluded_unreviewed} unreviewed left out`);
  return parts.join(' · ');
}

/** Clicks APPLY and returns the request body the app sent and the server's result set. */
async function apply(page: Page): Promise<{ sent: Record<string, unknown>; rs: WireResultSet }> {
  const created = page.waitForResponse((r: Response) => new URL(r.url()).pathname === `${API}/result-sets` && r.request().method() === 'POST');
  await panel(page).getByRole('button', { name: 'APPLY' }).click();
  const res = await created;
  expect(res.status(), 'POST /result-sets').toBe(201);
  return { sent: JSON.parse(res.request().postData() ?? '{}') as Record<string, unknown>, rs: (await res.json()) as WireResultSet };
}

/** Place search as the app asks it (GET /geocode?q=): the candidates, or the error status. */
async function serverPlaces(api: APIRequestContext, q: string): Promise<WirePlace[] | number> {
  const res = await api.get(`${API}/geocode?q=${encodeURIComponent(q)}`);
  return res.status() === 200 ? ((await res.json()) as WirePlace[]) : res.status();
}

const insideBbox = (lat: number, lng: number, [minLon, minLat, maxLon, maxLat]: number[]) =>
  lat >= minLat && lat <= maxLat && (minLon <= maxLon ? lng >= minLon && lng <= maxLon : lng >= minLon || lng <= maxLon);

test.describe('filters give the server’s result sets', () => {
  test('a depth range: the request carries the bounds, the counts are the server’s, the rows are the set; a reload brings it back', async ({ page, request }) => {
    const all = await records(request);
    const depths = all.map((r) => r.metadata.borehole_depth_m).filter((d): d is number => d != null).sort((a, b) => a - b);
    expect(depths.length, 'seeded boreholes with a stated depth').toBeGreaterThan(3);
    const min = depths[Math.floor(depths.length / 4)];
    const max = depths[Math.floor((depths.length * 3) / 4)];
    const expected = all.filter((r) => r.metadata.borehole_depth_m != null && r.metadata.borehole_depth_m >= min && r.metadata.borehole_depth_m <= max);

    await openApp(page);
    await panel(page).getByLabel('Minimum depth (m)').fill(String(min));
    await panel(page).getByLabel('Maximum depth (m)').fill(String(max));
    const { sent, rs } = await apply(page);
    expect(sent).toEqual({ include_unreviewed: true, min_depth_m: min, max_depth_m: max });
    expect([...rs.uids].sort()).toEqual(expected.map((r) => r.uid).sort());
    expect(rs.located_count).toBe(expected.filter((r) => r.plotted).length);
    await expect(summary(page)).toHaveText(summaryOf(rs));
    await expect.poll(() => rsParam(page)).toBe(rs.result_set_id);
    await expect(rows(page)).toHaveCount(rs.count);
    for (const uid of rs.uids) await expect(page.locator(`[role="table"] [role="row"][data-uid="${uid}"]`)).toHaveCount(1);

    await reload(page);
    expect(rsParam(page)).toBe(rs.result_set_id);
    await expect(summary(page)).toHaveText(summaryOf(rs));
    await expect(rows(page)).toHaveCount(rs.count);
    // The panel shows the set's definition again.
    await expect(panel(page).getByLabel('Minimum depth (m)')).toHaveValue(String(min));
    await expect(panel(page).getByLabel('Maximum depth (m)')).toHaveValue(String(max));

    await panel(page).getByRole('button', { name: 'RESET' }).click();
    await expect.poll(() => rsParam(page)).toBeNull();
    await expect(rows(page)).toHaveCount(all.length);
  });

  test('review status: approved only, then approved boreholes only with the others counted as left out', async ({ page, request }) => {
    const all = await records(request);
    const approved = all.filter((r) => r.review_status === 'approved');

    await openApp(page);
    await panel(page).getByRole('checkbox', { name: 'Approved' }).check();
    const first = await apply(page);
    expect(first.sent).toEqual({ include_unreviewed: true, review_status: ['approved'] });
    expect([...first.rs.uids].sort()).toEqual(approved.map((r) => r.uid).sort());
    await expect(summary(page)).toHaveText(summaryOf(first.rs));
    await expect(rows(page)).toHaveCount(approved.length);

    await panel(page).getByRole('checkbox', { name: 'Approved' }).uncheck();
    await panel(page).getByRole('checkbox', { name: 'Include unreviewed boreholes' }).uncheck();
    const second = await apply(page);
    expect(second.sent).toEqual({ include_unreviewed: false });
    expect(second.rs.count).toBe(approved.length);
    expect(second.rs.excluded_unreviewed).toBe(all.length - approved.length);
    await expect(summary(page)).toHaveText(summaryOf(second.rs));
    await expect.poll(() => rsParam(page)).toBe(second.rs.result_set_id);
  });

  test('an invalid range is never sent', async ({ page }) => {
    await openApp(page);
    let posted = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === `${API}/result-sets`) posted += 1;
    });
    await panel(page).getByLabel('Minimum depth (m)').fill('20');
    await panel(page).getByLabel('Maximum depth (m)').fill('5');
    await panel(page).getByRole('button', { name: 'APPLY' }).click();
    await expect(panel(page).getByRole('alert')).toHaveText('The maximum depth must not be less than the minimum.');
    expect(posted).toBe(0);
  });
});

test.describe('place search on the server', () => {
  test('a seeded location name lists the server’s candidates in its order, uploaded places marked', async ({ page, request, errors }) => {
    const named = (await records(request)).map((r) => r as SeedRecord).find((r) => r.plotted && r.metadata.location_name?.trim());
    test.skip(!named, 'no plotted seeded borehole with a location name');
    const q = named!.metadata.location_name!.trim();
    const answer = await serverPlaces(request, q);

    await openApp(page);
    await placeField(page).fill(q);
    await placeField(page).press('Enter');
    if (typeof answer === 'number') {
      expect(answer, 'GET /geocode answered an error other than 503').toBe(503);
      await expect(placeStatus(page)).toHaveText('Place search unavailable');
      // Chrome logs the 503 the server gave; the app handled it.
      expectConsoleErrors(errors, (e) => /503/.test(e));
      return;
    }
    expect(answer.some((p) => p.source === 'uploaded'), `an uploaded place for "${q}"`).toBe(true);
    await expect(places(page)).toHaveCount(answer.length);
    for (const [i, p] of answer.entries()) {
      await expect(places(page).nth(i)).toContainText(p.label);
      await expect(places(page).nth(i)).toContainText(p.source);
      if (p.borehole_count != null) await expect(places(page).nth(i)).toContainText(`${p.borehole_count} borehole`);
    }
    // Uploaded places come first, as the server orders them.
    const firstGeocoder = answer.findIndex((p) => p.source === 'geocoder');
    if (firstGeocoder >= 0) expect(answer.slice(firstGeocoder).every((p) => p.source === 'geocoder')).toBe(true);
    await expect(placeStatus(page)).toHaveText(answer.length === 1 ? '1 place found' : `${answer.length} places found`);
    // Choosing the uploaded place: it holds boreholes, so no "none here" note.
    const uploaded = answer.findIndex((p) => p.source === 'uploaded');
    await places(page).nth(uploaded).click();
    await expect(places(page).nth(uploaded)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByText('No uploaded boreholes here')).toHaveCount(0);
  });

  test('a place without uploaded boreholes says so (with the server’s geocoder), or the search says why it can’t', async ({ page, request, errors }) => {
    const health = await getJson<WireHealth>(request, '/health');
    test.skip(!health.providers.geocoder, 'the server has no geocoder: only uploaded places, and each holds boreholes');
    const q = 'Reykjavik';
    const answer = await serverPlaces(request, q);
    const pins = (await mapFeatures(request)).map((f) => ({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));

    await openApp(page);
    await placeField(page).fill(q);
    await placeField(page).press('Enter');
    if (typeof answer === 'number') {
      await expect(placeStatus(page)).toHaveText('Place search unavailable');
      expectConsoleErrors(errors, (e) => /503/.test(e));
      return;
    }
    if (!answer.length) {
      await expect(placeStatus(page)).toHaveText('No place found');
      return;
    }
    const empty = answer.findIndex((p) => (p.borehole_count ?? 0) === 0 && (p.bbox ? !pins.some((x) => insideBbox(x.lat, x.lng, p.bbox!)) : p.borehole_count === 0));
    test.skip(empty < 0, `every candidate for "${q}" holds uploaded boreholes`);
    await expect(places(page)).toHaveCount(answer.length);
    if (answer.length > 1) await places(page).nth(empty).click();
    await expect(places(page).nth(empty)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByText('No uploaded boreholes here', { exact: true })).toBeVisible();
  });

  test('nothing found says "No place found"; a geocoder that is down says "Place search unavailable"', async ({ page, errors }) => {
    await openApp(page);
    await page.route(/\/api\/v1\/geocode\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await placeField(page).fill('Fictional Nowhere');
    await placeField(page).press('Enter');
    await expect(placeStatus(page)).toHaveText('No place found');

    await page.unroute(/\/api\/v1\/geocode\?/);
    await page.route(/\/api\/v1\/geocode\?/, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'The geocoder is unavailable (fictional test answer).', code: 'geocoder_unavailable' }),
      }),
    );
    await placeField(page).fill('Fictional Elsewhere');
    await placeField(page).press('Enter');
    await expect(placeStatus(page)).toHaveText('Place search unavailable');
    // Chrome logs the 503 it was given; that error is the point of this test.
    expect(expectConsoleErrors(errors, (e) => /503/.test(e)), 'the logged 503').toBeLessThanOrEqual(1);
  });
});
