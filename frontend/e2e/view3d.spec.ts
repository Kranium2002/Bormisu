/// <reference lib="dom" />
/**
 * The 3D view (/3d) in sample mode (fictional sample data): 3D VIEW from an area drawn on the map,
 * from LIST and from the report's toolbar; the stage's state (boreholes, columns, layers shown,
 * vertical axis, groundwater link), the panel's switches, the legend, a reload, no selection, and the
 * German button. WebGL runs on SwiftShader; where it can't, only the calm notice is checked, so a CI
 * runner without WebGL still passes. VIEW3D_SHOTS=<dir> saves screenshots of the ready view.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, loaded, nav, openApp, openUrl, test } from './fixtures';

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

const mapRegion = (page: Page) => page.getByRole('region', { name: 'Borehole map' });
const stage = (page: Page) => page.getByTestId('view3d');
const panel = (page: Page) => page.getByRole('region', { name: '3D view settings' });

/**
 * The map on one fictional site (Elbquerung Ost), opened by its link: the view is the one the link
 * names from the start, so nothing waits for the map to finish fitting or zooming.
 */
async function openSite(page: Page): Promise<void> {
  await openUrl(page, '/map?at=53.535,10.02,13');
  await expect(mapRegion(page)).toHaveAttribute('data-ready', 'true');
}

async function drawRectangle(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await mapRegion(page).boundingBox())!;
  await page.getByRole('button', { name: 'Select by rectangle' }).click();
  await page.mouse.click(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 4 });
  await page.mouse.click(box.x + box.width * to[0], box.y + box.height * to[1]);
}

/** The space-separated layer groups the stage says are drawn. */
const layers = async (page: Page) => ((await stage(page).getAttribute('data-layers')) ?? '').split(' ').filter(Boolean);

/**
 * The view is there: boreholes and columns counted; a canvas once WebGL is ready, else the notice.
 * Returns whether WebGL drew.
 */
async function expectView(page: Page): Promise<boolean> {
  await expect(stage(page)).toBeVisible();
  await expect.poll(async () => Number(await stage(page).getAttribute('data-boreholes'))).toBeGreaterThan(0);
  expect(Number(await stage(page).getAttribute('data-columns'))).toBeGreaterThan(0);
  await expect(stage(page)).toHaveAttribute('data-webgl', /^(ready|unavailable)$/, { timeout: 20_000 });
  const ready = (await stage(page).getAttribute('data-webgl')) === 'ready';
  if (ready) {
    const canvas = stage(page).locator('canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('role', 'img');
    await expect(canvas).toHaveAttribute('aria-label', /boreholes drawn/);
  } else {
    await expect(stage(page).getByText('3D NOT AVAILABLE')).toBeVisible();
  }
  return ready;
}

/** With VIEW3D_SHOTS set and WebGL drawing: the whole page, once tiles and text are drawn. */
async function shot(page: Page, ready: boolean, name: string): Promise<void> {
  const dir = process.env.VIEW3D_SHOTS;
  if (!dir || !ready) return;
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function toggle(box: Locator, label: string, on: boolean): Promise<void> {
  const c = box.getByLabel(label, { exact: true });
  if (on) await c.check();
  else await c.uncheck();
}

test.describe('3D view', () => {
  test('an area drawn on the map: 3D VIEW opens the view; the switches change what is drawn', async ({ page }) => {
    // One site: the rectangle takes in the boreholes of a fictional project.
    await openSite(page);
    await drawRectangle(page, [0.2, 0.25], [0.8, 0.92]);
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toMatch(/^rs_/);
    const rs = new URL(page.url()).searchParams.get('rs');

    await page.locator('[data-result-set-bar]').getByTestId('view-3d').click();
    await expect(page).toHaveURL(new RegExp(`/3d\\?rs=${rs}$`));
    const ready = await expectView(page);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Area: Rectangle');

    // The legend lists the DIN codes in view.
    const legend = page.getByRole('list', { name: 'Legend' });
    await expect(legend.locator('li[data-din]').first()).toBeVisible();
    await shot(page, ready, 'view3d-area');

    // Boreholes and the map switch their layers off and on.
    expect(await layers(page)).toContain('columns');
    await toggle(panel(page), 'Boreholes', false);
    await expect.poll(() => layers(page)).not.toContain('columns');
    await toggle(panel(page), 'Boreholes', true);
    await expect.poll(() => layers(page)).toContain('columns');
    expect(await layers(page)).toContain('basemap');
    await toggle(panel(page), 'Basemap', false);
    await expect.poll(() => layers(page)).not.toContain('basemap');
    await toggle(panel(page), 'Basemap', true);

    // The groundwater link: line, surface (when there are enough readings), off.
    const radio = (name: string) => panel(page).getByRole('radio', { name, exact: true });
    await radio('Line').check();
    await expect(stage(page)).toHaveAttribute('data-water', 'line');
    if (await radio('Surface').isEnabled()) {
      await radio('Surface').check();
      await expect(stage(page)).toHaveAttribute('data-water', 'surface');
      await expect.poll(() => layers(page)).toContain('water-surface');
    }
    await radio('Off').check();
    await expect(stage(page)).toHaveAttribute('data-water', 'off');
    expect(await layers(page)).not.toContain('water-surface');
    expect(await layers(page)).not.toContain('water-line');

    // The vertical axis, when the boreholes state their ground level.
    if (await radio('BY ELEVATION').isEnabled()) {
      await radio('BELOW GROUND').check();
      await expect(stage(page)).toHaveAttribute('data-mode', 'depth');
      await shot(page, ready, 'view3d-area-depth');
      await radio('BY ELEVATION').check();
      await expect(stage(page)).toHaveAttribute('data-mode', 'elevation');
    }

    // The exaggeration slider.
    const slider = panel(page).getByRole('slider', { name: 'Vertical exaggeration' });
    await slider.fill('12');
    await expect(page.getByTestId('view3d-exaggeration')).toHaveText('×12');
    await slider.fill('3');
    await expect(page.getByTestId('view3d-exaggeration')).toHaveText('×3');
    if (ready) await panel(page).getByRole('button', { name: 'RESET VIEW' }).click();

    // A reload keeps the URL and asks for its set again (sample sets live in the page, so here it is
    // gone and says so, as on the map; against the API the view comes back).
    await page.reload();
    await loaded(page);
    await expect(page).toHaveURL(new RegExp(`/3d\\?rs=${rs}$`));
    await expect(page.getByRole('alert').filter({ hasText: 'Result set not found or expired.' })).toBeVisible();
  });

  test('Back and Forward to the view build it again from its URL', async ({ page }) => {
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByTestId('view-3d').click();
    await expectView(page);
    const url = page.url();
    // Back to LIST and forward again: the same URL, the view built anew from it.
    await page.goBack();
    await expect(page).toHaveURL(/\/list/);
    await page.goForward();
    await expect(page).toHaveURL(url);
    await expectView(page);
  });

  test('LIST without a selection: 3D VIEW shows every borehole that has a map position', async ({ page }) => {
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByTestId('view-3d').click();
    await expect(page).toHaveURL(/\/3d\?rs=rs_/);
    const ready = await expectView(page);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('All boreholes');
    // Boreholes without a map position are counted, not drawn.
    await expect(panel(page)).toContainText('without a map position are not shown');
    await shot(page, ready, 'view3d-list');
  });

  test('the report toolbar opens the same selection in 3D', async ({ page }) => {
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByTestId('export-report').click();
    await expect(page).toHaveURL(/\/report\?rs=rs_/);
    const query = new URL(page.url()).search;
    await page.getByTestId('view-3d').click();
    await expect(page).toHaveURL(new RegExp(`/3d${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expectView(page);
    // And back: EXPORT REPORT on the 3D view's toolbar.
    await page.getByRole('link', { name: 'EXPORT REPORT' }).click();
    await expect(page).toHaveURL(/\/report\?rs=rs_/);
  });

  test('at phone width the panel starts folded behind LAYERS and the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByTestId('view-3d').click();
    await expectView(page);
    const fold = panel(page).getByRole('button', { name: /^LAYERS/ });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).getByLabel('Boreholes', { exact: true })).toBeHidden();
    await fold.click();
    await expect(panel(page).getByLabel('Boreholes', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('the map without a selection: 3D VIEW takes what the map shows; the camera buttons and the drag switch move the view', async ({ page }) => {
    // The map on one fictional site; nothing drawn, nothing selected.
    await openSite(page);
    expect(new URL(page.url()).searchParams.get('rs')).toBeNull();

    const button = page.locator('[data-screen-label="Map"]').getByTestId('view-3d');
    await expect(button).toHaveCount(1);
    await button.click();
    await expect(page).toHaveURL(/\/3d\?rs=rs_/);
    const ready = await expectView(page);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Area: Rectangle');
    if (!ready) return;

    // The camera buttons: a step each, read from the stage.
    const camera = page.getByRole('group', { name: 'Move the view' });
    const number = async (name: string) => Number(await stage(page).getAttribute(name));
    const bearing = await number('data-bearing');
    await camera.getByRole('button', { name: 'Turn right' }).click();
    await expect.poll(() => number('data-bearing')).toBe(bearing + 15);
    await camera.getByRole('button', { name: 'Face north' }).click();
    await expect(stage(page)).toHaveAttribute('data-bearing', '0');
    const zoom = await number('data-zoom');
    await camera.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => number('data-zoom')).toBe(zoom + 0.5);
    await camera.getByRole('button', { name: 'Zoom out' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => number('data-zoom')).toBe(zoom);
    const pitch = await number('data-pitch');
    await camera.getByRole('button', { name: 'Look more from above' }).click();
    await expect.poll(() => number('data-pitch')).toBe(pitch - 10);

    // The named views.
    await panel(page).getByRole('button', { name: 'TOP', exact: true }).click();
    await expect(stage(page)).toHaveAttribute('data-pitch', '0');
    await panel(page).getByRole('button', { name: 'SIDE', exact: true }).click();
    await expect(stage(page)).toHaveAttribute('data-pitch', '80');

    // A plain drag moves the ground, as on the map; with ROTATES chosen it turns the view.
    await expect(stage(page)).toHaveAttribute('data-drag', 'pan');
    const box = (await stage(page).boundingBox())!;
    const drag = async () => {
      const [x, y] = [box.x + box.width * 0.6, box.y + box.height * 0.55];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 140, y, { steps: 6 });
      await page.mouse.up();
    };
    await drag();
    await page.waitForTimeout(400);
    expect(await number('data-bearing')).toBe(0);
    expect(await number('data-pitch')).toBe(80);
    await panel(page).getByRole('radio', { name: 'ROTATES' }).check();
    await expect(stage(page)).toHaveAttribute('data-drag', 'rotate');
    await drag();
    await expect.poll(() => number('data-bearing')).not.toBe(0);
  });

  test('/3d without a selection explains how to get one', async ({ page }) => {
    await openApp(page);
    await page.goto('/3d');
    await expect(page.getByText('NO SELECTION')).toBeVisible();
    await expect(page.getByText(/then choose 3D VIEW/)).toBeVisible();
  });

  test('German: the button reads 3D-ANSICHT', async ({ page }) => {
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'DE', exact: true }).click();
    await expect(page.getByTestId('view-3d')).toHaveText('3D-ANSICHT');
  });
});
