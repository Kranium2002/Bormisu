import type { Page } from '@playwright/test';
import { AMBER, expect, legendCount, MAP_FOCUS_WORLD, moveSampleProject, nav, openApp, pinFills, pins, test } from './fixtures';

test.describe('map', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('renders pins, legend counts, the not-on-map list and the results table', async ({ page }) => {
    await expect(pins(page)).toHaveCount(45);
    await expect(legendCount(page, 'reviewed')).toHaveText('23');
    await expect(legendCount(page, 'unreviewed')).toHaveText('8');
    await expect(legendCount(page, 'attention')).toHaveText('14');
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(14);

    const aside = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: 'NOT ON MAP (3)' }) });
    await expect(aside).toContainText('BK-13');
    await expect(aside).toContainText('BK-14');
    await expect(aside).toContainText('SK-05');

    await expect(page.getByText('48 boreholes · 7 projects', { exact: true })).toBeVisible();
    await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(48);
    await expect(page.locator('[data-uid="nb:BK-07"]')).toContainText('18.00 m');
    await expect(page.locator('[data-uid="nb:BK-07"]')).toContainText('Needs attention');
  });

  test('leaving the map in the middle of a wheel zoom raises no error', async ({ page }) => {
    const map = page.getByRole('region', { name: 'Borehole map' });
    for (let i = 0; i < 3; i++) {
      await map.hover();
      await page.mouse.wheel(0, -300);
      await nav(page, 'UPLOAD & QUEUE');
      await nav(page, 'MAP');
      await expect(map).toBeVisible();
    }
    await page.waitForTimeout(500);
  });

  test('a results row opens the borehole detail', async ({ page }) => {
    await page.locator('[data-uid="eq:EQ-02"]').click();
    await expect(page.getByText('EQ-02', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await expect(page.getByRole('button', { name: 'EXPORT ▾' })).toBeVisible();
  });

  test('boreholes that are not on the map still open their detail', async ({ page }) => {
    await page.getByRole('button', { name: /^Open detail of SK-05:/ }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await expect(page.getByText(/not on the map/).first()).toBeVisible();
    await nav(page, 'MAP');
    const row = page.locator('[role="table"] [data-uid$=":BK-13"]');
    await expect(row).toContainText('OPEN DETAIL ›');
    await row.click();
    await expect(page.getByText('BK-13', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
  });

  test('a pin popup opens the detail', async ({ page }) => {
    await page.getByLabel('Search project or borehole ID').fill('BK-11');
    await page.keyboard.press('Enter');
    const popup = page.locator('.leaflet-popup-content');
    await expect(popup).toContainText('BK-11');
    await expect(popup.getByRole('button', { name: 'Open detail of BK-11' })).toHaveText('OPEN DETAIL ›');
    await popup.getByRole('button', { name: 'Open detail of BK-11' }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
  });

  test('search "EQ-03" flies to the pin and opens its popup, from any screen', async ({ page }) => {
    await nav(page, 'UPLOAD & QUEUE');
    await page.getByLabel('Search project or borehole ID').fill('EQ-03');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'MAP', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.leaflet-popup-content')).toContainText('EQ-03');
    await expect(page.locator('.leaflet-popup-content')).toContainText('Elbquerung Ost');
  });

  test('search "BK-13" explains why it is not on the map', async ({ page }) => {
    await page.getByLabel('Search project or borehole ID').fill('BK-13');
    await page.keyboard.press('Enter');
    const message = page.getByRole('status').filter({ hasText: 'Listed under Not on map' });
    await expect(message).toBeVisible();
    await expect(message).toContainText('BK-13:');
    await expect(page.locator('.leaflet-popup')).toHaveCount(0);
  });
});

/** Pins whose centre shows the pin itself (or another pin), not the mask, the legend or nothing. */
const pinsOnTop = (page: Page) =>
  pins(page).evaluateAll(
    (ps) =>
      ps.filter((p) => {
        const r = p.getBoundingClientRect();
        const top = p.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!top?.closest('.leaflet-overlay-pane') && top.classList.contains('leaflet-interactive');
      }).length,
  );

test.describe('map focus: Germany (VITE_MAP_FOCUS=DE, the default)', () => {
  test.skip(MAP_FOCUS_WORLD, 'the e2e server runs with VITE_MAP_FOCUS=world');
  test.beforeEach(async ({ page }) => openApp(page));

  test('masks everything outside Germany and draws its border, between the tiles and the pins', async ({ page }) => {
    const focusPane = page.locator('.leaflet-bormisuFocus-pane');
    const mask = focusPane.locator('path.bormisu-focus-mask');
    const border = focusPane.locator('path.bormisu-focus-border');
    await expect(mask).toHaveCount(1);
    await expect(border).toHaveCount(1);
    // The mask is the map background (tokens.css --c-line), opaque, without an outline.
    await expect(mask).toHaveAttribute('fill', '#EFEFEF');
    await expect(mask).toHaveAttribute('fill-opacity', '1');
    await expect(mask).toHaveAttribute('stroke', 'none');
    await expect(border).toHaveAttribute('stroke', '#003E25');
    await expect(border).toHaveAttribute('stroke-width', '1.5');
    await expect(border).toHaveAttribute('fill', 'none');
    // Neither takes clicks.
    await expect(mask).not.toHaveClass(/leaflet-interactive/);
    await expect(border).not.toHaveClass(/leaflet-interactive/);

    const zIndex = (selector: string) =>
      page.locator(selector).evaluate((el) => Number(el.ownerDocument.defaultView?.getComputedStyle(el).zIndex));
    const tilesZ = await zIndex('.leaflet-tile-pane');
    const focusZ = await zIndex('.leaflet-bormisuFocus-pane');
    expect(focusZ).toBeGreaterThan(tilesZ);
    expect(focusZ).toBeLessThan(await zIndex('.leaflet-overlay-pane'));

    // The whole border is in view.
    const map = (await page.getByRole('region', { name: 'Borehole map' }).boundingBox())!;
    const b = (await border.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(map.x);
    expect(b.y).toBeGreaterThanOrEqual(map.y);
    expect(b.x + b.width).toBeLessThanOrEqual(map.x + map.width);
    expect(b.y + b.height).toBeLessThanOrEqual(map.y + map.height);
  });

  test('the zoom-out button and the wheel cannot zoom out beyond Germany', async ({ page }) => {
    const border = page.locator('path.bormisu-focus-border');
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    const zoomOut = page.getByRole('button', { name: 'Zoom out' });
    const width = async () => (await border.boundingBox())?.width ?? 0;

    // The first view is the whole of Germany, which is also the smallest zoom.
    await expect(zoomOut).toHaveClass(/leaflet-disabled/);
    const full = await width();
    expect(full).toBeGreaterThan(100);

    await zoomIn.click();
    await expect.poll(width).toBeGreaterThan(full * 1.5);
    await expect(zoomOut).not.toHaveClass(/leaflet-disabled/);

    for (let i = 0; i < 3; i++) await zoomOut.click({ force: true });
    await expect(zoomOut).toHaveClass(/leaflet-disabled/);
    await expect.poll(width).toBeLessThan(full * 1.02);
    expect(await width()).toBeGreaterThan(full * 0.98);

    await page.getByRole('region', { name: 'Borehole map' }).hover();
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(600);
    expect(await width()).toBeGreaterThan(full * 0.98);
    await expect(zoomOut).toHaveClass(/leaflet-disabled/);
  });

  test('all 45 sample pins lie in Germany and stay visible above the mask', async ({ page }) => {
    await expect(pins(page)).toHaveCount(45);
    expect(await pinsOnTop(page)).toBe(45);
    await expect(page.getByRole('heading', { name: 'NOT ON MAP (3)' })).toBeVisible();
    await expect(page.getByText('Outside map focus (Germany)')).toHaveCount(0);
  });
});

test.describe('map focus: boreholes outside Germany', () => {
  test.skip(MAP_FOCUS_WORLD, 'the e2e server runs with VITE_MAP_FOCUS=world');
  test.beforeEach(async ({ page }) => {
    // The four reviewed Rheinbogen boreholes (RB-01..04), moved from Cologne to Brussels.
    await moveSampleProject(page, 'RB-', 50.8467, 4.3525);
    await openApp(page);
  });

  test('are listed under NOT ON MAP with the reason instead of plotted; counts stay consistent', async ({ page }) => {
    await expect(pins(page)).toHaveCount(41);
    await expect(legendCount(page, 'reviewed')).toHaveText('19');
    await expect(legendCount(page, 'unreviewed')).toHaveText('8');
    await expect(legendCount(page, 'attention')).toHaveText('14');

    const aside = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: 'NOT ON MAP (7)' }) });
    await expect(aside).toContainText('No usable coordinates, or outside Germany, so these are listed');
    for (const id of ['RB-01', 'RB-02', 'RB-03', 'RB-04']) {
      await expect(aside.getByRole('button', { name: `Open detail of ${id}: Outside map focus (Germany)` })).toBeVisible();
    }

    // RESULTS still lists every borehole, and an out-of-focus row opens its detail.
    await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(48);
    await page.locator('[role="table"] [role="row"][data-uid]').filter({ hasText: 'RB-02' }).click();
    await expect(page.getByText('RB-02', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
  });

  test('a NOT ON MAP item opens the detail', async ({ page }) => {
    await page.getByRole('button', { name: 'Open detail of RB-03: Outside map focus (Germany)' }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
  });

  test('search explains why the borehole is not on the map instead of flying', async ({ page }) => {
    await nav(page, 'UPLOAD & QUEUE');
    await page.getByLabel('Search project or borehole ID').fill('RB-02');
    await page.keyboard.press('Enter');
    const message = page.getByRole('status').filter({ hasText: 'Listed under Not on map' });
    await expect(message).toHaveText('RB-02: Outside map focus (Germany). Listed under Not on map.');
    await expect(page.locator('.leaflet-popup')).toHaveCount(0);
    // The Germany view is unchanged: nothing flew to Brussels.
    await expect(page.getByRole('button', { name: 'Zoom out' })).toHaveClass(/leaflet-disabled/);
  });
});

test.describe('map focus: world (run with VITE_MAP_FOCUS=world)', () => {
  test.skip(!MAP_FOCUS_WORLD, 'the e2e server runs with the default VITE_MAP_FOCUS=DE');

  test('no mask, no border, no zoom limit; boreholes abroad are plotted as before', async ({ page }) => {
    await moveSampleProject(page, 'RB-', 50.8467, 4.3525);
    await openApp(page);
    await expect(pins(page)).toHaveCount(45);
    await expect(page.getByRole('heading', { name: 'NOT ON MAP (3)' })).toBeVisible();
    await expect(page.locator('.leaflet-bormisuFocus-pane')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Zoom out' })).not.toHaveClass(/leaflet-disabled/);
    expect(await pinsOnTop(page)).toBe(45);
  });
});
