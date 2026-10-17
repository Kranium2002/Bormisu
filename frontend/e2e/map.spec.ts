import { AMBER, expect, legendNumber, nav, navLink, openApp, pathOf, pinFills, pins, resultRow, test, uidOf } from './fixtures';

test.describe('map', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('renders pins, legend counts, the not-on-map list and the results table', async ({ page }) => {
    await expect(pins(page)).toHaveCount(45);
    // Every plotted borehole is counted once under its status; amber pins are exactly the attention count.
    const counts = await Promise.all((['approved', 'in_review', 'unreviewed', 'attention'] as const).map((s) => legendNumber(page, s)));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(45);
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(counts[3]);

    const aside = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: 'NOT ON MAP (3)' }) });
    await expect(aside).toContainText('BK-13');
    await expect(aside).toContainText('BK-14');
    await expect(aside).toContainText('SK-05');
    // Reasons are the backend's codes as labels, never a made-up text.
    await expect(aside.getByText(/^(No coordinates in source|Coordinate system unknown|Coordinate system needs confirmation|Coordinates implausible|Not placed on the map)$/)).toHaveCount(3);

    await expect(page.getByText('48 boreholes · 7 projects', { exact: true })).toBeVisible();
    await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(48);
    await expect(resultRow(page, 'BK-07')).toContainText('18.00 m');
  });

  test('FE-MAP-1: the first view shows every pin inside the map, none under the legend', async ({ page }) => {
    await expect(pins(page)).toHaveCount(45);
    const map = (await page.getByRole('region', { name: 'Borehole map' }).boundingBox())!;
    const legend = (await page.getByRole('group', { name: 'Review status legend' }).boundingBox())!;
    const centres = await pins(page).evaluateAll((ps) =>
      ps.map((p) => {
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );
    const hidden = centres.filter(
      (c) =>
        c.x < map.x || c.x > map.x + map.width || c.y < map.y || c.y > map.y + map.height ||
        (c.x >= legend.x && c.x <= legend.x + legend.width && c.y >= legend.y && c.y <= legend.y + legend.height),
    );
    expect(hidden, 'pins outside the map or under the legend').toEqual([]);
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

  test('a results row opens the borehole detail at /boreholes/:uid', async ({ page }) => {
    const uid = await uidOf(page, 'EQ-02');
    await resultRow(page, 'EQ-02').click();
    await expect(page.getByText('EQ-02', { exact: true }).first()).toBeVisible();
    expect(pathOf(page)).toBe(`/boreholes/${uid}`);
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await expect(page.getByRole('button', { name: 'EXPORT ▾' })).toBeVisible();
  });

  test('boreholes that are not on the map still open their detail', async ({ page }) => {
    await page.getByRole('button', { name: /^Open detail of SK-05:/ }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await expect(page.getByText(/not on the map/).first()).toBeVisible();
    await nav(page, 'MAP');
    const row = resultRow(page, 'BK-13');
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

  test('search "EQ-03" flies to the pin and opens its popup, from any screen; the pin goes into the URL', async ({ page }) => {
    const uid = await uidOf(page, 'EQ-03');
    await nav(page, 'UPLOAD & QUEUE');
    await page.getByLabel('Search project or borehole ID').fill('EQ-03');
    await page.keyboard.press('Enter');
    await expect(navLink(page, 'MAP')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.leaflet-popup-content')).toContainText('EQ-03');
    await expect(page.locator('.leaflet-popup-content')).toContainText('Elbquerung Ost');
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(uid);
    expect(new URL(page.url()).pathname).toBe('/map');
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
