/// <reference lib="dom" />
// The callbacks of page.evaluate and addInitScript run in the browser, so they use the DOM types.
/**
 * FRONTEND.md F9 "Done when 5,000 fictional pins pan smoothly": the map layer is answered with 5,000
 * FICTIONAL features spread over the world (a deterministic generator below; no seed or challenge
 * data), then the spec measures
 * - the boot: from navigation to every pin added to the clustered canvas layer (`data-ready`), and
 *   from the map layer's answer to that moment;
 * - panning and zooming with real input (mouse drags, wheel zooms, keyboard pans) while sampling the
 *   intervals between animation frames: the median frame must stay under 25 ms and the 95th
 *   percentile under 60 ms.
 * The numbers are attached to the test (perf.json) and printed, so a run reports them.
 *
 * Runs in the API project against any app in API mode (E2E_BASE_URL): only GET
 * /map/boreholes.geojson is replaced; everything else is the backend's. Read-only.
 */
import type { Page } from '@playwright/test';
import { API, expect, openApp, test } from './fixtures';

const PINS = 5000;
/** Frame budget (ms): median and 95th percentile of the frame intervals while panning and zooming. */
const MEDIAN_MS = 25;
const P95_MS = 60;
/** Boot budget (ms): from the map layer's answer until every pin is on the map, and from navigation. */
const PINS_READY_MS = 5000;
const BOOT_MS = 10_000;

/** mulberry32: a small deterministic PRNG, so every run draws the same world. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ['unreviewed', 'in_review', 'approved'] as const;
const CRS = ['stated', 'inferred', 'confirmed'] as const;

/**
 * 5,000 fictional boreholes: 60 % at 80 project sites (dense, as real projects are), the rest
 * scattered over every continent's latitudes. Some depths are not stated (null), some need attention.
 */
function fictionalFeatures(n = PINS, seed = 20261017) {
  const rnd = prng(seed);
  const sites = Array.from({ length: 80 }, () => ({ lng: -170 + rnd() * 340, lat: -50 + rnd() * 115 }));
  return Array.from({ length: n }, (_, i) => {
    const atSite = i < n * 0.6;
    const site = sites[i % sites.length];
    const lng = atSite ? site.lng + (rnd() - 0.5) * 0.2 : -179 + rnd() * 358;
    const lat = atSite ? site.lat + (rnd() - 0.5) * 0.12 : -55 + rnd() * 125;
    const uid = `bh_PERF${String(i).padStart(5, '0')}`;
    return {
      type: 'Feature',
      id: uid,
      geometry: { type: 'Point', coordinates: [Number(lng.toFixed(6)), Number(lat.toFixed(6))] },
      properties: {
        uid,
        borehole_id: `FX-${i + 1}`,
        project_name: `Fictional perf site ${(i % sites.length) + 1}`,
        document_id: null,
        borehole_depth_m: rnd() < 0.1 ? null : Number((1 + rnd() * 140).toFixed(2)),
        review_status: STATUSES[Math.floor(rnd() * STATUSES.length)],
        crs_status: CRS[Math.floor(rnd() * CRS.length)],
        revision: 1,
        attention: rnd() < 0.08,
        open_clarifications: 0,
      },
    };
  });
}

const mapRegion = (page: Page) => page.getByRole('region', { name: 'Borehole map' });

/** Frame intervals in ms between consecutive animation frames while `action` runs. */
async function frameIntervals(page: Page, action: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: { on: boolean; t: number[] } };
    w.__frames = { on: true, t: [] };
    const tick = (ts: number) => {
      if (!w.__frames.on) return;
      w.__frames.t.push(ts);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  const t = await page.evaluate(() => {
    const w = window as unknown as { __frames: { on: boolean; t: number[] } };
    w.__frames.on = false;
    return w.__frames.t;
  });
  return t.slice(1).map((x, i) => x - t[i]);
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const round1 = (x: number) => Math.round(x * 10) / 10;

const zoomOf = (page: Page) => Number(new URL(page.url()).searchParams.get('at')?.split(',')[2] ?? NaN);

test('F9: 5,000 fictional pins boot in a few seconds and pan and zoom smoothly', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const features = fictionalFeatures();
  let answeredAt = 0;
  await page.route(
    (url) => url.pathname === `${API}/map/boreholes.geojson`,
    async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/geo+json', json: { type: 'FeatureCollection', features } });
      answeredAt = Date.now();
    },
  );
  // The moment every pin is on the map, in the page's clock (from navigation start).
  await page.addInitScript((pins) => {
    const w = window as unknown as { __pinsReadyAt?: number };
    const check = () => {
      const el = document.querySelector('[aria-label="Borehole map"]') as HTMLElement | null;
      if (el?.dataset.ready === 'true' && el.dataset.pins === String(pins)) {
        w.__pinsReadyAt = performance.now();
        return;
      }
      setTimeout(check, 10);
    };
    check();
  }, PINS);

  await openApp(page);
  await expect(mapRegion(page)).toHaveAttribute('data-pins', String(PINS), { timeout: 30_000 });
  await expect(mapRegion(page)).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  const readyAt = await page.waitForFunction(() => (window as unknown as { __pinsReadyAt?: number }).__pinsReadyAt).then((h) => h.jsonValue() as Promise<number>);
  const navToReady = Math.round(readyAt);
  const wallReady = Date.now();
  // From the layer's answer to the pins on the map (wall clock, an upper bound: includes the polling step).
  const answerToReady = Math.max(0, wallReady - answeredAt);
  // Every pin is in the clusters or drawn on its own; the first view fits the world's pins.
  await expect(mapRegion(page)).toHaveAttribute('data-pins-in-view', String(PINS));

  const box = (await mapRegion(page).boundingBox())!;
  const centre = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.45 };
  // Settle (tiles, the first cluster split) before measuring.
  await page.waitForTimeout(500);

  const zoomBefore = zoomOf(page);
  let zoomIn = NaN;
  const intervals = await frameIntervals(page, async () => {
    // Zoom in three steps with the wheel at different spots, then pan with drags at that zoom.
    for (const [fx, fy] of [[0.55, 0.45], [0.5, 0.5], [0.45, 0.55]] as const) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(450);
    }
    zoomIn = zoomOf(page);
    for (let i = 0; i < 8; i++) {
      const dx = (i % 2 === 0 ? 1 : -1) * Math.min(320, box.width * 0.3);
      const dy = (i % 4 < 2 ? 1 : -1) * Math.min(120, box.height * 0.15);
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      await page.mouse.move(centre.x + dx, centre.y + dy, { steps: 24 });
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    // Keyboard pans (Leaflet animates each arrow press), then zoom back out.
    await mapRegion(page).locator('.leaflet-container').focus();
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowLeft']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(120);
    }
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(450);
    }
  });
  // The map really moved: the wheel zoomed it in.
  expect(zoomIn, `zoom after the wheel (from ${zoomBefore})`).toBeGreaterThan(zoomBefore);

  const median = percentile(intervals, 50);
  const p95 = percentile(intervals, 95);
  const max = Math.max(...intervals);
  const long = intervals.filter((x) => x > 50).length;
  const report = {
    pins: PINS,
    boot: { navigationToPinsMs: navToReady, layerAnswerToPinsMs: answerToReady },
    frames: { count: intervals.length, medianMs: round1(median), p95Ms: round1(p95), maxMs: round1(max), over50Ms: long },
    thresholds: { MEDIAN_MS, P95_MS, PINS_READY_MS, BOOT_MS },
    browser: `${testInfo.project.use.channel ?? 'chromium'} ${page.context().browser()?.version() ?? ''}`.trim(),
  };
  console.log(`perf: ${JSON.stringify(report)}`);
  await testInfo.attach('perf.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });

  expect(intervals.length, 'frames sampled').toBeGreaterThan(100);
  expect(median, `median frame (ms) of ${intervals.length}`).toBeLessThan(MEDIAN_MS);
  expect(p95, `95th percentile frame (ms) of ${intervals.length}`).toBeLessThan(P95_MS);
  expect(answerToReady, 'map layer answer → every pin on the map (ms)').toBeLessThan(PINS_READY_MS);
  expect(navToReady, 'navigation → every pin on the map (ms)').toBeLessThan(BOOT_MS);
});
