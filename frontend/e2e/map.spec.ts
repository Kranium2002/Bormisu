import type { Page } from '@playwright/test';
import {
  AMBER,
  chooseFocus,
  expect,
  focusSelect,
  legendCount,
  moveSampleProject,
  nav,
  openApp,
  pinFills,
  pins,
  test,
} from './fixtures';

test.describe('map (World, the default focus)', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('renders pins, legend counts, the not-on-map list and the results table', async ({ page }) => {
    await expect(pins(page)).toHaveCount(58);
    await expect(legendCount(page, 'reviewed')).toHaveText('29');
    await expect(legendCount(page, 'unreviewed')).toHaveText('12');
    await expect(legendCount(page, 'attention')).toHaveText('17');
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(17);

    const aside = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: 'NOT ON MAP (3)' }) });
    await expect(aside).toContainText('BK-13');
    await expect(aside).toContainText('BK-14');
    await expect(aside).toContainText('SK-05');

    await expect(page.getByRole('heading', { name: 'RESULTS · WORLD' })).toBeVisible();
    await expect(page.getByText('61 boreholes · 10 projects', { exact: true })).toBeVisible();
    await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(61);
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
    // In World every pin is reachable: the focus stays.
    await expect(focusSelect(page)).toHaveValue('world');
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

const mask = (page: Page) => page.locator('.leaflet-bormisuFocus-pane path.bormisu-focus-mask');
const border = (page: Page) => page.locator('.leaflet-bormisuFocus-pane path.bormisu-focus-border');
const zoomOut = (page: Page) => page.getByRole('button', { name: 'Zoom out' });

test.describe('map focus dropdown', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('lists World and every country with boreholes, with counts, most first', async ({ page }) => {
    await expect(focusSelect(page)).toHaveValue('world');
    await expect(focusSelect(page).locator('option')).toHaveText([
      'World · 58',
      'Germany · 45',
      'Norway · 5',
      'Singapore · 4',
      'Switzerland · 4',
    ]);
  });

  test('the default view is World: no mask, no border, no zoom limit, no ?focus= yet', async ({ page }) => {
    await expect(pins(page)).toHaveCount(58);
    await expect(mask(page)).toHaveCount(0);
    await expect(border(page)).toHaveCount(0);
    await expect(zoomOut(page)).not.toHaveClass(/leaflet-disabled/);
    expect(new URL(page.url()).searchParams.get('focus')).toBeNull();
    expect(await pinsOnTop(page)).toBe(58);
  });

  test('Germany: mask and border between the tiles and the pins, results narrowed, SHOW WORLD restores', async ({ page }) => {
    await chooseFocus(page, 'DE');
    await expect(mask(page)).toHaveCount(1);
    await expect(border(page)).toHaveCount(1);
    // The mask is the map background (tokens.css --c-line), opaque, without an outline.
    await expect(mask(page)).toHaveAttribute('fill', '#EFEFEF');
    await expect(mask(page)).toHaveAttribute('fill-opacity', '1');
    await expect(mask(page)).toHaveAttribute('stroke', 'none');
    await expect(border(page)).toHaveAttribute('stroke', '#003E25');
    await expect(border(page)).toHaveAttribute('stroke-width', '1.5');
    await expect(border(page)).toHaveAttribute('fill', 'none');
    // Neither takes clicks.
    await expect(mask(page)).not.toHaveClass(/leaflet-interactive/);
    await expect(border(page)).not.toHaveClass(/leaflet-interactive/);

    const zIndex = (selector: string) =>
      page.locator(selector).evaluate((el) => Number(el.ownerDocument.defaultView?.getComputedStyle(el).zIndex));
    const focusZ = await zIndex('.leaflet-bormisuFocus-pane');
    expect(focusZ).toBeGreaterThan(await zIndex('.leaflet-tile-pane'));
    expect(focusZ).toBeLessThan(await zIndex('.leaflet-overlay-pane'));

    // The whole border is in view.
    const map = (await page.getByRole('region', { name: 'Borehole map' }).boundingBox())!;
    const b = (await border(page).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(map.x);
    expect(b.y).toBeGreaterThanOrEqual(map.y);
    expect(b.x + b.width).toBeLessThanOrEqual(map.x + map.width);
    expect(b.y + b.height).toBeLessThanOrEqual(map.y + map.height);

    // Only Germany's pins, all above the mask; the legend counts them.
    await expect(pins(page)).toHaveCount(45);
    expect(await pinsOnTop(page)).toBe(45);
    await expect(legendCount(page, 'reviewed')).toHaveText('23');
    await expect(legendCount(page, 'unreviewed')).toHaveText('8');
    await expect(legendCount(page, 'attention')).toHaveText('14');
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(14);

    // RESULTS: Germany's boreholes (incl. the three without coordinates of German projects).
    await expect(page.getByRole('heading', { name: 'RESULTS · GERMANY' })).toBeVisible();
    await expect(page.getByText('48 boreholes · 7 projects', { exact: true })).toBeVisible();
    await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(48);
    const footer = page.getByTestId('results-outside');
    await expect(footer).toContainText('13 boreholes outside Germany');
    await expect(footer).toContainText('Norway 5 · Singapore 4 · Switzerland 4');

    // NOT ON MAP: the three without coordinates plus one line for the 13 elsewhere.
    await expect(page.getByRole('heading', { name: 'NOT ON MAP (16)' })).toBeVisible();
    await expect(page.getByTestId('outside-focus')).toContainText('13 boreholes outside Germany');
    await expect(page.getByRole('button', { name: /^Open detail of (BK-13|BK-14|SK-05):/ })).toHaveCount(3);

    await footer.getByRole('button', { name: 'SHOW WORLD ›' }).click();
    await expect(focusSelect(page)).toHaveValue('world');
    await expect(page).toHaveURL(/[?&]focus=world/);
    await expect(pins(page)).toHaveCount(58);
    await expect(mask(page)).toHaveCount(0);
    await expect(zoomOut(page)).not.toHaveClass(/leaflet-disabled/);
    await expect(page.getByText('61 boreholes · 10 projects', { exact: true })).toBeVisible();
  });

  test('Germany: the zoom-out button and the wheel cannot zoom out beyond the country', async ({ page }) => {
    await chooseFocus(page, 'DE');
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    const width = async () => (await border(page).boundingBox())?.width ?? 0;

    // The first view is the whole of Germany, which is also the smallest zoom.
    await expect(zoomOut(page)).toHaveClass(/leaflet-disabled/);
    const full = await width();
    expect(full).toBeGreaterThan(100);

    await zoomIn.click();
    await expect.poll(width).toBeGreaterThan(full * 1.5);
    await expect(zoomOut(page)).not.toHaveClass(/leaflet-disabled/);

    for (let i = 0; i < 3; i++) await zoomOut(page).click({ force: true });
    await expect(zoomOut(page)).toHaveClass(/leaflet-disabled/);
    await expect.poll(width).toBeLessThan(full * 1.02);
    expect(await width()).toBeGreaterThan(full * 0.98);

    await page.getByRole('region', { name: 'Borehole map' }).hover();
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(600);
    expect(await width()).toBeGreaterThan(full * 0.98);
    await expect(zoomOut(page)).toHaveClass(/leaflet-disabled/);
  });

  test('switching countries replaces mask and border (no leaked layers) and pins keep their colours', async ({ page }) => {
    for (const [code, count] of [['DE', 45], ['NO', 5], ['SG', 4], ['CH', 4], ['DE', 45]] as const) {
      await chooseFocus(page, code);
      await expect(pins(page)).toHaveCount(count);
      await expect(mask(page)).toHaveCount(1);
      await expect(border(page)).toHaveCount(1);
      await expect(zoomOut(page)).toHaveClass(/leaflet-disabled/);
    }
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(14);
    await chooseFocus(page, 'world');
    await expect(mask(page)).toHaveCount(0);
    await expect(border(page)).toHaveCount(0);
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(17);
  });

  test('works with the keyboard', async ({ page }) => {
    await focusSelect(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(focusSelect(page)).toHaveValue('DE');
    await expect(page).toHaveURL(/[?&]focus=DE/);
    await expect(pins(page)).toHaveCount(45);
  });

  test('search for a borehole in another country switches the focus and opens its popup', async ({ page }) => {
    await chooseFocus(page, 'DE');
    await nav(page, 'UPLOAD & QUEUE');
    await page.getByLabel('Search project or borehole ID').fill('KC-02');
    await page.keyboard.press('Enter');
    await expect(focusSelect(page)).toHaveValue('SG');
    await expect(page).toHaveURL(/[?&]focus=SG/);
    await expect(page.locator('.leaflet-popup-content')).toContainText('KC-02');
    await expect(page.locator('.leaflet-popup-content')).toContainText('Kallang Cable Tunnel');
    await expect(pins(page)).toHaveCount(4);

    // Switching back by hand doesn't bounce back to the old search result.
    await chooseFocus(page, 'DE');
    await page.waitForTimeout(400);
    await expect(focusSelect(page)).toHaveValue('DE');
  });
});

test.describe('map focus from the URL', () => {
  test('?focus=DE opens on Germany', async ({ page }) => {
    await openApp(page, '?focus=DE');
    await expect(focusSelect(page)).toHaveValue('DE');
    await expect(mask(page)).toHaveCount(1);
    await expect(pins(page)).toHaveCount(45);
    await expect(zoomOut(page)).toHaveClass(/leaflet-disabled/);
    await expect(page.getByRole('heading', { name: 'RESULTS · GERMANY' })).toBeVisible();
  });

  test('an unknown code falls back to World', async ({ page }) => {
    await openApp(page, '?focus=ZZ');
    await expect(focusSelect(page)).toHaveValue('world');
    await expect(page).toHaveURL(/[?&]focus=world/);
    await expect(pins(page)).toHaveCount(58);
  });
});

test.describe('map focus: a borehole in no country', () => {
  test.beforeEach(async ({ page }) => {
    // The four reviewed Rheinbogen boreholes (RB-01..04), moved from Cologne into the North Sea.
    await moveSampleProject(page, 'RB-', 54.6, 5.2);
    await openApp(page);
  });

  test('is plotted only in World; searching it from a country view switches to World', async ({ page }) => {
    await expect(pins(page)).toHaveCount(58);
    await expect(focusSelect(page).locator('option').nth(1)).toHaveText('Germany · 41');

    await chooseFocus(page, 'DE');
    await expect(pins(page)).toHaveCount(41);
    await expect(page.getByTestId('outside-focus')).toContainText('17 boreholes outside Germany');
    await expect(page.getByTestId('outside-focus')).toContainText('no country 4');

    await page.getByLabel('Search project or borehole ID').fill('RB-02');
    await page.keyboard.press('Enter');
    await expect(focusSelect(page)).toHaveValue('world');
    await expect(page.locator('.leaflet-popup-content')).toContainText('RB-02');
    await expect(pins(page)).toHaveCount(58);
  });
});
