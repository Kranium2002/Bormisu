import {
  AMBER,
  expect,
  legendCount,
  nav,
  openApp,
  pinFills,
  pins,
  test,
} from './fixtures';

test.describe('map (World)', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('renders pins and legend counts; LIST has every borehole, the ones not on the map marked', async ({ page }) => {
    await expect(pins(page)).toHaveCount(58);
    await expect(legendCount(page, 'reviewed')).toHaveText('29');
    await expect(legendCount(page, 'unreviewed')).toHaveText('12');
    await expect(legendCount(page, 'attention')).toHaveText('17');
    expect((await pinFills(page)).filter((f) => f === AMBER)).toHaveLength(17);

    await nav(page, 'LIST');
    await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(61);
    for (const id of ['BK-13', 'BK-14', 'SK-05']) {
      await expect(page.locator(`[role="table"] [data-uid$=":${id}"]`)).toContainText('NOT ON MAP');
    }
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

  test('a LIST row opens the borehole detail', async ({ page }) => {
    await nav(page, 'LIST');
    await page.locator('[data-uid="eq:EQ-02"]').click();
    await expect(page.getByText('EQ-02', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await expect(page.getByRole('button', { name: 'EXPORT ▾' })).toBeVisible();
  });

  test('boreholes that are not on the map still open their detail', async ({ page }) => {
    await nav(page, 'LIST');
    await page.getByRole('button', { name: 'Open detail of SK-05' }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    await expect(page.getByText(/not on the map/).first()).toBeVisible();
    await nav(page, 'LIST');
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
    const message = page.getByRole('status').filter({ hasText: 'Shown in LIST as not on map' });
    await expect(message).toBeVisible();
    await expect(message).toContainText('BK-13:');
    await expect(page.locator('.leaflet-popup')).toHaveCount(0);
  });
});
