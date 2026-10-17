/// <reference lib="dom" />
// The callbacks of page.evaluate run in the browser, so they use the DOM types.
/**
 * The map canvas in sample mode (fictional sample data): pins on a canvas renderer with clusters,
 * the colour switch (status | depth) with its legend, pin popups with DETAIL, REVIEW and SOURCE,
 * area selection with the draw tools and its reset, reduced motion, and teardown (FRONTEND.md F9 to
 * F11). Pins are canvas drawings, not elements: the spec reads the map's data attributes, the
 * cluster icons (DOM) and the pixels of the pins' canvas.
 */
import type { Page } from '@playwright/test';
import { expect, loaded, nav, navLink, openApp, openUrl, pathOf, resultRow, test, uidOf } from './fixtures';

/** Plotted boreholes of the fictional sample. */
const SAMPLE_PINS = 45;
const AMBER = '#E39B00';
const GREEN = '#1E7B34';
/** Depth class colours (src/screens/map/depthClasses.ts). */
const DEPTH_COLOURS = ['#FCA636', '#E16462', '#B12A90', '#6A00A8', '#0D0887'];
const DEPTH_LABELS = ['0–10 m', '>10–20 m', '>20–50 m', '>50–100 m', '>100 m', 'Depth not stated'];

const mapRegion = (page: Page) => page.getByRole('region', { name: 'Borehole map' });

/** What the map shows (its data attributes), as numbers. */
async function mapStats(page: Page) {
  const d = await mapRegion(page).evaluate((e) => ({ ...(e as HTMLElement).dataset }));
  return { pins: Number(d.pins), drawn: Number(d.pinsDrawn), inView: Number(d.pinsInView), members: Number(d.members), ready: d.ready === 'true', colourBy: d.colourBy };
}

/** Waits until the map has added its pins. */
async function mapReady(page: Page, pins = SAMPLE_PINS): Promise<void> {
  await expect(mapRegion(page)).toHaveAttribute('data-ready', 'true');
  await expect(mapRegion(page)).toHaveAttribute('data-pins', String(pins));
}

/** The cluster icons on the map with their counts. */
const clusters = (page: Page) => mapRegion(page).locator('[data-count]');
const clusterCounts = (page: Page) => clusters(page).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-count'))));

/** The legend and its rows. */
const legend = (page: Page) => page.getByRole('group', { name: /legend$/ });
async function legendRows(page: Page): Promise<[string, number][]> {
  return legend(page)
    .locator('li')
    .evaluateAll((lis) => lis.map((li) => [li.children[1].textContent ?? '', Number(li.children[2].textContent)] as [string, number]));
}

/** Fill colours drawn on the pins' canvas, with at least `min` exact pixels each (edges are blends). */
async function canvasColours(page: Page, min = 12): Promise<string[]> {
  return mapRegion(page)
    .locator('.leaflet-pins-pane canvas')
    .evaluate((c, least) => {
      const canvas = c as HTMLCanvasElement;
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const counts = new Map<number, number>();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 255) continue;
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts].filter(([, n]) => n >= least).map(([k]) => `#${k.toString(16).padStart(6, '0').toUpperCase()}`);
    }, min);
}

/**
 * Pixels drawn on the pins' canvas inside a screen rectangle. Leaflet adds the canvas with the first
 * pin drawn on its own: while every pin is inside a cluster there is none, and nothing is drawn.
 */
async function canvasPixelsIn(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<number> {
  return mapRegion(page)
    .locator('.leaflet-pins-pane canvas')
    .evaluateAll((cs, b) => {
      const canvas = cs[0] as HTMLCanvasElement | undefined;
      if (!canvas) return 0;
      const r = canvas.getBoundingClientRect();
      const scale = canvas.width / r.width;
      const x0 = Math.max(0, Math.floor((b.x - r.left) * scale));
      const y0 = Math.max(0, Math.floor((b.y - r.top) * scale));
      const x1 = Math.min(canvas.width, Math.ceil((b.x + b.width - r.left) * scale));
      const y1 = Math.min(canvas.height, Math.ceil((b.y + b.height - r.top) * scale));
      if (x1 <= x0 || y1 <= y0) return 0;
      const { data } = canvas.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n += 1;
      return n;
    }, box);
}

/** Ring backgrounds of the cluster icons (CSS conic gradients, colours as rgb()). */
const ringBackgrounds = (page: Page) => clusters(page).evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundImage));
const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

const popup = (page: Page) => page.locator('.leaflet-popup-content');

async function search(page: Page, text: string): Promise<void> {
  await page.getByLabel('Search project or borehole ID').fill(text);
  await page.keyboard.press('Enter');
}

/**
 * Draws a rectangle with the draw tool between two points of the map (fractions of its size).
 * `finish` runs the last click (e.g. inside a measurement).
 */
async function drawRectangle(page: Page, from: [number, number], to: [number, number], finish = (click: () => Promise<void>) => click()): Promise<void> {
  const box = (await mapRegion(page).boundingBox())!;
  await page.getByRole('button', { name: 'Select by rectangle' }).click();
  await expect(page.getByRole('button', { name: 'Select by rectangle' })).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 4 });
  await finish(() => page.mouse.click(box.x + box.width * to[0], box.y + box.height * to[1]));
}

/** How many animation frames moved the cluster icons or pins' canvas while `action` ran (and 1.2 s after). */
async function movingFrames(page: Page, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __stop: boolean };
    w.__frames = 0;
    w.__stop = false;
    let last = '';
    const tick = () => {
      if (w.__stop) return;
      const pane = document.querySelector('.leaflet-map-pane') as HTMLElement | null;
      const parts = [pane?.style.transform ?? ''];
      document.querySelectorAll<HTMLElement>('.leaflet-marker-icon, .leaflet-pins-pane canvas, .leaflet-tile-container').forEach((e) => parts.push(e.style.transform));
      const now = parts.join('|');
      if (now !== last) w.__frames += 1;
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number; __stop: boolean };
    w.__stop = true;
    return w.__frames;
  });
}

test.describe('map canvas', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await mapReady(page);
  });

  test('F9: pins are drawn on a canvas and clustered; every pin is counted once in the clusters or on its own', async ({ page }) => {
    const stats = await mapStats(page);
    expect(stats).toMatchObject({ pins: SAMPLE_PINS, inView: SAMPLE_PINS, ready: true, colourBy: 'status' });
    // No SVG pin elements: the pins are canvas drawings (the canvas comes with the first pin drawn on its own).
    await expect(mapRegion(page).locator('.leaflet-overlay-pane path.leaflet-interactive')).toHaveCount(0);
    await expect(mapRegion(page).locator('.leaflet-pins-pane canvas')).toHaveCount(stats.drawn > 0 ? 1 : 0);
    const counts = await clusterCounts(page);
    expect(counts.length, 'clusters at the first view').toBeGreaterThan(0);
    expect(counts.reduce((a, b) => a + b, 0) + stats.drawn).toBe(SAMPLE_PINS);
    // Clusters show their count and are named for screen readers, but take no tab stop (the results table is the keyboard path).
    const first = clusters(page).first();
    await expect(first).toHaveAttribute('role', 'img');
    await expect(first).toHaveAttribute('aria-label', /^\d+ boreholes?: /);
    await expect(mapRegion(page).locator('.leaflet-marker-icon[tabindex]')).toHaveCount(0);
    // The status legend counts every pin once.
    const rows = await legendRows(page);
    expect(rows.map(([label]) => label)).toEqual(['Approved', 'In review', 'Unreviewed', 'Needs attention']);
    expect(rows.reduce((a, [, n]) => a + n, 0)).toBe(SAMPLE_PINS);
    await expect(legend(page).locator('ul')).toHaveAttribute('aria-live', 'polite');

    // A click on a cluster zooms into it; every pin is still counted once.
    const zoomOf = () => Number(new URL(page.url()).searchParams.get('at')?.split(',')[2]);
    const before = zoomOf();
    await clusters(page).first().click();
    await expect.poll(zoomOf).toBeGreaterThan(before);
    await expect(mapRegion(page)).toHaveAttribute('data-pins', String(SAMPLE_PINS));
  });

  test('FE-MAP-1: the first view shows every pin inside the map, none under the legend', async ({ page }) => {
    expect((await mapStats(page)).inView).toBe(SAMPLE_PINS);
    const map = (await mapRegion(page).boundingBox())!;
    const box = (await legend(page).boundingBox())!;
    const icons = await clusters(page).evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );
    const hidden = icons.filter(
      (c) =>
        c.x < map.x || c.x > map.x + map.width || c.y < map.y || c.y > map.y + map.height ||
        (c.x >= box.x && c.x <= box.x + box.width && c.y >= box.y && c.y <= box.y + box.height),
    );
    expect(hidden, 'clusters outside the map or under the legend').toEqual([]);
    expect(await canvasPixelsIn(page, box), 'pins drawn under the legend').toBe(0);
  });

  test('F9: the colour switch recolours pins, cluster rings and the legend by depth class, and back', async ({ page }) => {
    // Some pins on their own: the Neckarbogen site, zoomed in by a search.
    await search(page, 'BK-11');
    await expect(popup(page)).toContainText('BK-11');
    await expect.poll(async () => (await mapStats(page)).drawn).toBeGreaterThan(0);
    const statusColours = await canvasColours(page);
    expect(statusColours.some((c) => c === AMBER || c === GREEN), `status colours drawn: ${statusColours}`).toBe(true);
    expect(statusColours.filter((c) => DEPTH_COLOURS.includes(c))).toEqual([]);

    await page.getByRole('radio', { name: 'DEPTH' }).check();
    await expect(mapRegion(page)).toHaveAttribute('data-colour-by', 'depth');
    await expect(page.getByRole('group', { name: 'Final depth legend' })).toBeVisible();
    const rows = await legendRows(page);
    expect(rows.map(([label]) => label)).toEqual(DEPTH_LABELS);
    expect(rows.reduce((a, [, n]) => a + n, 0)).toBe(SAMPLE_PINS);
    await expect.poll(async () => (await canvasColours(page)).filter((c) => DEPTH_COLOURS.includes(c)).length).toBeGreaterThan(0);
    const depthColours = await canvasColours(page);
    expect(depthColours.filter((c) => c === AMBER || c === GREEN), 'no status colour left on the canvas').toEqual([]);
    for (const ring of await ringBackgrounds(page)) {
      expect(ring).not.toContain(rgb(GREEN));
      expect(ring).not.toContain(rgb(AMBER));
    }

    await page.getByRole('radio', { name: 'STATUS' }).check();
    await expect(page.getByRole('group', { name: 'Review status legend' })).toBeVisible();
    await expect.poll(async () => (await canvasColours(page)).filter((c) => DEPTH_COLOURS.includes(c))).toEqual([]);
  });

  test('F9: a pin popup shows ID, project, depth and status with DETAIL, REVIEW and SOURCE', async ({ page }) => {
    await search(page, 'BK-11');
    const p = popup(page);
    await expect(p).toContainText('BK-11');
    await expect(p).toContainText('Stadtbahn Neckarbogen');
    await expect(p).toContainText('Final depth 12.00 m');
    await expect(p).toContainText('Needs attention');
    const detail = p.getByRole('button', { name: 'Open detail of BK-11' });
    const review = p.getByRole('button', { name: 'Review BK-11' });
    const source = p.getByRole('button', { name: 'Source of the final depth of BK-11' });
    await expect(detail).toHaveText('OPEN DETAIL ›');
    await expect(review).toBeEnabled();
    await expect(source).toBeEnabled();

    // SOURCE: the Source panel of the final depth, on the map screen.
    await source.click();
    await expect(page.getByRole('dialog', { name: 'Source' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/map');
    await page.getByRole('button', { name: 'Close panel' }).click();

    // REVIEW: the Review screen on this borehole.
    await review.click();
    await expect(page.getByRole('heading', { level: 1, name: 'REVIEW · BK-11' })).toBeVisible();
    await page.goBack();

    // Back on the map the popup is open again; DETAIL opens the Detail screen.
    await expect(popup(page)).toContainText('BK-11');
    await popup(page).getByRole('button', { name: 'Open detail of BK-11' }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
  });

  test('a selection from outside shows a pin inside a cluster (zoomToShowLayer) and opens its popup', async ({ page }) => {
    await search(page, 'BK-11');
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).not.toBeNull();
    const uid = new URL(page.url()).searchParams.get('sel')!;
    // A deep link at a view where BK-11 is inside a cluster.
    await openUrl(page, `/map?at=49.5,9.5,6&sel=${encodeURIComponent(uid)}`);
    await mapReady(page);
    await expect(popup(page)).toContainText('BK-11');
    const zoom = Number(new URL(page.url()).searchParams.get('at')!.split(',')[2]);
    expect(zoom, 'zoomed in out of the cluster').toBeGreaterThan(6);
    expect(new URL(page.url()).searchParams.get('sel')).toBe(uid);
  });

  test('F10: drawing a rectangle creates a result set and highlights its members; removing it resets', async ({ page }) => {
    await drawRectangle(page, [0.3, 0.3], [0.75, 0.85]);
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toMatch(/^rs_/);
    await expect(page.getByRole('button', { name: 'Select by rectangle' })).toHaveAttribute('aria-pressed', 'false');
    await expect(mapRegion(page).locator('[data-map-shape="area"]')).toHaveCount(1);
    // Members highlighted, the others dimmed but still drawn; the legend counts the selection.
    await expect.poll(async () => (await mapStats(page)).members).toBeGreaterThan(0);
    const { members, pins } = await mapStats(page);
    expect(pins).toBe(SAMPLE_PINS);
    await expect(legend(page)).toContainText('SELECTION · STATUS');
    expect((await legendRows(page)).reduce((a, [, n]) => a + n, 0)).toBe(members);
    await expect(clusters(page).first()).toHaveAttribute('data-members', /\d+/);

    // Remove the area (RESET of the area): the result set, its highlight and the drawn area go.
    await page.getByRole('button', { name: 'Remove the selected area' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toBeNull();
    await expect(mapRegion(page).locator('[data-map-shape="area"]')).toHaveCount(0);
    await expect(mapRegion(page)).toHaveAttribute('data-members', '0');
    await expect(legend(page)).toContainText('REVIEW STATUS');
    expect((await legendRows(page)).reduce((a, [, n]) => a + n, 0)).toBe(SAMPLE_PINS);
    await expect(page.getByRole('button', { name: 'Remove the selected area' })).toHaveCount(0);
  });

  test('F10: polygon and circle tools select areas too; Escape cancels drawing and closes nothing else', async ({ page }) => {
    const box = (await mapRegion(page).boundingBox())!;
    const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;

    // Escape cancels a drawing in progress (and leaves an open side panel alone).
    await page.getByRole('button', { name: 'Select by polygon' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Esc cancels' })).toBeVisible();
    await page.mouse.click(...at(0.3, 0.3));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Select by polygon' })).toHaveAttribute('aria-pressed', 'false');
    expect(new URL(page.url()).searchParams.get('rs')).toBeNull();

    // A polygon: corners, then the first corner again.
    await page.getByRole('button', { name: 'Select by polygon' }).click();
    for (const p of [at(0.25, 0.25), at(0.8, 0.25), at(0.8, 0.85), at(0.25, 0.85)]) await page.mouse.click(...p);
    await page.mouse.click(...at(0.25, 0.25));
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toMatch(/^rs_/);
    await expect(mapRegion(page).locator('[data-map-shape="area"]')).toHaveCount(1);
    const polygonSet = new URL(page.url()).searchParams.get('rs');

    // A circle replaces it: one area at a time.
    await page.getByRole('button', { name: 'Select by circle' }).click();
    await page.mouse.click(...at(0.5, 0.5));
    await page.mouse.move(...at(0.7, 0.5), { steps: 4 });
    await page.mouse.click(...at(0.7, 0.5));
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).not.toBe(polygonSet);
    await expect(mapRegion(page).locator('[data-map-shape="area"]')).toHaveCount(1);
  });

  test('prefers-reduced-motion: a result set and a search move the map at once instead of flying', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await mapReady(page);
    let still = 0;
    await drawRectangle(page, [0.3, 0.3], [0.75, 0.85], async (click) => {
      still = await movingFrames(page, async () => {
        await click();
        await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toMatch(/^rs_/);
      });
    });
    expect(still, 'frames with movement under reduced motion').toBeLessThanOrEqual(4);
    await page.getByRole('button', { name: 'Remove the selected area' }).click();

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await mapReady(page);
    const flying = await movingFrames(page, async () => {
      await search(page, 'EQ-03');
      await expect(popup(page)).toContainText('EQ-03');
    });
    expect(flying, 'frames with movement during a flight').toBeGreaterThan(8);
  });

  test('leaving the map in the middle of a wheel zoom or a flight raises no error', async ({ page }) => {
    const map = mapRegion(page);
    for (let i = 0; i < 3; i++) {
      await map.hover();
      await page.mouse.wheel(0, -300);
      await nav(page, 'UPLOAD & QUEUE');
      await nav(page, 'MAP');
      await expect(map).toBeVisible();
    }
    await search(page, 'EQ-03');
    await page.waitForTimeout(200);
    await nav(page, 'UPLOAD & QUEUE');
    await page.waitForTimeout(1200);
    await nav(page, 'MAP');
    // The search box still holds "EQ-03": the map keeps only its match.
    await mapReady(page, 1);
  });
});

test.describe('header search on the map', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('search "EQ-03" flies to the pin and opens its popup, from any screen; the pin goes into the URL', async ({ page }) => {
    await nav(page, 'UPLOAD & QUEUE');
    await search(page, 'EQ-03');
    await expect(navLink(page, 'MAP')).toHaveAttribute('aria-current', 'page');
    await expect(popup(page)).toContainText('EQ-03');
    await expect(popup(page)).toContainText('Elbquerung Ost');
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toMatch(/.+/);
    expect(new URL(page.url()).pathname).toBe('/map');
  });

  test('search "BK-13" explains why it is not on the map and opens LIST', async ({ page }) => {
    await search(page, 'BK-13');
    const message = page.getByRole('status').filter({ hasText: 'Shown in LIST' });
    await expect(message).toBeVisible();
    await expect(message).toContainText('BK-13:');
    await expect(navLink(page, 'LIST')).toHaveAttribute('aria-current', 'page');
  });
});

/* LIST (/list): every borehole the map knows, those without a pin with their reason. */
test.describe('LIST', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await nav(page, 'LIST');
  });

  test('every borehole once; those not on the map with their reason', async ({ page }) => {
    await expect(page.getByText('48 boreholes · 7 projects', { exact: false })).toBeVisible();
    await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(48);
    await expect(resultRow(page, 'BK-07')).toContainText('18.00 m');
    for (const id of ['BK-13', 'BK-14', 'SK-05']) await expect(resultRow(page, id)).toContainText('NOT ON MAP · ');
  });

  test('a row opens the borehole detail at /boreholes/:uid', async ({ page }) => {
    const uid = await uidOf(page, 'EQ-02');
    await resultRow(page, 'EQ-02').click();
    await expect(page.getByText('EQ-02', { exact: true }).first()).toBeVisible();
    expect(pathOf(page)).toBe(`/boreholes/${uid}`);
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
  });

  test('boreholes that are not on the map still open their detail', async ({ page }) => {
    await page.getByRole('button', { name: /^Open detail of SK-05:/ }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await expect(page.getByText(/not on the map/).first()).toBeVisible();
  });

  test('+ adds a column from the full records (loading, then values); × removes it; the choice is kept', async ({ page }) => {
    await page.getByRole('columnheader', { name: 'Add a column' }).locator('summary').click();
    await page.getByRole('button', { name: 'LAYERS', exact: true }).click();
    const layers = page.getByRole('columnheader', { name: /^LAYERS/ });
    await expect(layers).toBeVisible();
    await expect(resultRow(page, 'BK-07').getByRole('cell').nth(6)).toHaveText(/^\d+$/);
    await page.reload();
    await loaded(page);
    await expect(page.getByRole('columnheader', { name: /^LAYERS/ })).toBeVisible();
    await page.getByRole('button', { name: 'Remove column LAYERS' }).click();
    await expect(page.getByRole('columnheader', { name: /^LAYERS/ })).toHaveCount(0);
  });

  test('the header search narrows the rows as it is typed', async ({ page }) => {
    await page.getByLabel('Search project or borehole ID').fill('EQ-0');
    await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(9);
  });
});
