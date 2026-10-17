/// <reference lib="dom" />
// The callbacks of evaluate run in the browser, so they use the DOM types.
/**
 * Responsive layout in sample mode (FRONTEND.md section 6; fictional sample data only):
 * - 1440 × 900: the three-pane desktop (explore panel, map with RESULTS under it, drawers on the right);
 * - 820 × 1180: panels and drawers lie over the map instead of squeezing it, the header wraps;
 * - 390 × 844: drawers, the explore panel and dialogs are full-screen sheets, tables scroll inside
 *   their own box, the map keeps a usable height.
 * On every main route and size: no horizontal page scroll, the main heading and the primary controls
 * are visible and not cut off sideways, and no console error (the shared fixture). Each test saves a
 * screenshot under test-results for the report (not committed).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, loaded, mainNav, openApp, test, uidOf } from './fixtures';

const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

type Size = (typeof SIZES)[number];

/** The page itself never scrolls sideways (1 px tolerance for sub-pixel rounding). */
async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, 'page width').toBeLessThanOrEqual(innerWidth + 1);
}

/**
 * Visible, and its full width is on screen: inside the viewport and not clipped by a box that hides
 * or scrolls what sticks out sideways. A control further down the page may need a vertical scroll.
 */
async function expectOnScreen(locator: Locator) {
  await expect(locator).toBeVisible();
  const cut = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > window.innerWidth + 1) return `outside the viewport (${Math.round(r.left)} to ${Math.round(r.right)})`;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowX === 'visible') continue;
      const c = p.getBoundingClientRect();
      if (r.left < c.left - 1 || r.right > c.right + 1) return `clipped by ${p.tagName.toLowerCase()}.${p.className}`;
    }
    return '';
  });
  expect(cut, `${locator} is cut off sideways`).toBe('');
}

/** The element covers the whole viewport (a full-screen sheet). */
async function expectFullScreen(locator: Locator, size: Size) {
  const box = await locator.boundingBox();
  expect(box, 'sheet box').not.toBeNull();
  if (!box) return;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.y)).toBe(0);
  expect(Math.round(box.width)).toBe(size.width);
  expect(Math.round(box.height)).toBe(size.height);
}

/** The element lies inside the viewport. */
async function expectInsideViewport(locator: Locator, size: Size) {
  const box = await locator.boundingBox();
  expect(box, 'box').not.toBeNull();
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
}

/** The header's controls, on every screen. */
async function expectHeader(page: Page) {
  const nav = mainNav(page);
  for (const name of [/^MAP/, /^UPLOAD & QUEUE/, /^REVIEW/, /^INBOX/]) await expectOnScreen(nav.getByRole('link', { name }));
  await expectOnScreen(page.getByLabel('Search project or borehole ID'));
  await expectOnScreen(page.getByRole('banner').getByRole('button', { name: 'YOUR NAME' }));
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

/** Opens the app on the map, then the given route of BK-07 (the hand-made fictional sample borehole). */
async function openRoute(page: Page, route: (uid: string) => string): Promise<string> {
  await openApp(page);
  const uid = await uidOf(page, 'BK-07');
  const url = route(encodeURIComponent(uid));
  if (url !== '/map') {
    await page.goto(url);
    await loaded(page);
  }
  return uid;
}

const mapCanvas = (page: Page) => page.locator('.leaflet-container').first();

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('map', async ({ page }) => {
      await openRoute(page, () => '/map');
      await expect(page.getByRole('heading', { name: /^RESULTS/ })).toBeVisible();
      await expectHeader(page);
      await expectOnScreen(page.getByRole('button', { name: 'Zoom in' }));
      await expectOnScreen(page.getByRole('button', { name: 'Select by rectangle' }));
      await expectOnScreen(page.getByRole('group', { name: 'Review status legend' }));
      const toggle = page.getByRole('button', { name: 'SEARCH & FILTERS' });
      if (size.width >= 1280) {
        // Three panes: the explore panel is a column left of the map, no toggle.
        await expect(toggle).toBeHidden();
        await expectOnScreen(page.getByRole('button', { name: 'PLACE SEARCH' }));
        const panel = await page.getByRole('region', { name: 'Search and filters' }).boundingBox();
        const map = await mapCanvas(page).boundingBox();
        expect(panel && map && panel.x + panel.width <= map.x + 1, 'panel left of the map').toBe(true);
      } else {
        await expectOnScreen(toggle);
      }
      // RESULTS under the map.
      const map = await mapCanvas(page).boundingBox();
      const results = await page.getByRole('heading', { name: /^RESULTS/ }).boundingBox();
      expect(map && results && results.y >= map.y + map.height - 1, 'RESULTS under the map').toBe(true);
      // The map keeps a usable height on every size.
      expect(map?.height ?? 0, 'map height').toBeGreaterThanOrEqual(260);
      await expectNoSidewaysScroll(page);
      await shot(page, `map-${size.width}`);
    });

    test('queue', async ({ page }) => {
      await openRoute(page, () => '/queue');
      await expect(page.getByRole('heading', { level: 1, name: 'UPLOAD & QUEUE' })).toBeVisible();
      await expectHeader(page);
      await expectOnScreen(page.locator('label').filter({ hasText: 'DROP REPORTS HERE' }));
      await expectOnScreen(page.getByLabel('Project (optional)'));
      await expectOnScreen(page.getByRole('button', { name: 'Choose a folder to upload' }));
      await expectOnScreen(page.getByRole('button', { name: 'OPEN IN REVIEW ›' }).first());
      await expectOnScreen(page.getByRole('button', { name: /^Report lists 14/ }));
      await expectNoSidewaysScroll(page);
      await shot(page, `queue-${size.width}`);
    });

    test('review', async ({ page }) => {
      await openRoute(page, (uid) => `/review/${uid}`);
      await expect(page.getByRole('heading', { level: 1, name: 'REVIEW · BK-07' })).toBeVisible();
      await expectHeader(page);
      await expectOnScreen(page.getByRole('button', { name: 'Previous borehole' }));
      await expectOnScreen(page.getByRole('button', { name: 'Next borehole' }));
      await expectOnScreen(page.getByRole('tab', { name: 'SHEET 1 · P.7' }));
      await expectOnScreen(page.getByRole('button', { name: '› OPEN DETAIL' }));
      await expectOnScreen(page.getByRole('button', { name: 'APPROVE ALL CLEAN' }));
      // The current value (the inferred CRS) with its actions.
      const row = page.locator('[data-key="CoordinateSystem"]');
      await expectOnScreen(row.getByRole('button', { name: 'CHOOSE CRS…' }));
      await expectOnScreen(row.getByRole('button', { name: /^Approve / }));
      await expectOnScreen(row.getByRole('button', { name: /^Flag / }));
      await expectNoSidewaysScroll(page);
      await shot(page, `review-${size.width}`);
    });

    test('detail', async ({ page }) => {
      await openRoute(page, (uid) => `/boreholes/${uid}`);
      await expect(page.getByRole('heading', { level: 1, name: 'BK-07', exact: true })).toBeVisible();
      await expectHeader(page);
      await expectOnScreen(page.getByRole('button', { name: '› OPEN IN REVIEW' }));
      await expectOnScreen(page.getByRole('button', { name: 'EXPORT ▾' }));
      await expectOnScreen(page.getByRole('group', { name: /^DIN 4023 profile of BK-07/ }));
      // The layers table keeps its columns and, where the screen is narrower, scrolls in its own box.
      const layers = page.getByRole('grid', { name: 'Layers' });
      await expectOnScreen(layers);
      const scroll = await layers.evaluate((el) => ({ overflow: getComputedStyle(el).overflowX, wider: el.scrollWidth > el.clientWidth + 1 }));
      if (scroll.wider) expect(scroll.overflow, 'a wider table scrolls in its own box').toBe('auto');
      await expectNoSidewaysScroll(page);
      await shot(page, `detail-${size.width}`);
    });

    test('inbox', async ({ page }) => {
      await openRoute(page, () => '/inbox');
      await expect(page.getByRole('heading', { level: 1, name: 'INBOX' })).toBeVisible();
      await expect(page.getByText('Loading questions…')).toHaveCount(0);
      await expectHeader(page);
      await expectOnScreen(page.locator('button[data-clarification-id]').first());
      await expectNoSidewaysScroll(page);
      await shot(page, `inbox-${size.width}`);
    });

    test('explore panel: column, overlay over the map, or full-screen sheet', async ({ page }) => {
      await openRoute(page, () => '/map');
      const panel = page.getByRole('region', { name: 'Search and filters' });
      const before = await mapCanvas(page).boundingBox();
      if (size.width >= 1280) {
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('button', { name: 'CLOSE' })).toBeHidden();
      } else {
        await expect(panel).toBeHidden();
        await page.getByRole('button', { name: 'SEARCH & FILTERS' }).click();
        await expect(panel).toBeVisible();
        await expectOnScreen(panel.getByRole('button', { name: 'CLOSE' }));
        if (size.width < 768) await expectFullScreen(panel, size);
        else await expectInsideViewport(panel, size);
      }
      await expectOnScreen(panel.getByRole('button', { name: 'SEARCH', exact: true }));
      await expectOnScreen(panel.getByRole('button', { name: 'APPLY' }));
      // The panel never squeezes the map: it lies over it or beside it as before.
      expect(await mapCanvas(page).boundingBox()).toEqual(before);
      await expectNoSidewaysScroll(page);
      await shot(page, `explore-${size.width}`);
      if (size.width < 1280) {
        await panel.getByRole('button', { name: 'CLOSE' }).click();
        await expect(panel).toBeHidden();
        await expect(page.getByRole('button', { name: 'SEARCH & FILTERS' })).toBeFocused();
      }
    });

    test('source drawer: on the right, or a full-screen sheet', async ({ page }) => {
      await openRoute(page, (uid) => `/review/${uid}`);
      await expect(page.getByRole('heading', { level: 1, name: 'REVIEW · BK-07' })).toBeVisible();
      await page.locator('[data-key="CoordinateSystem"]').getByRole('button', { name: 'Larger source view' }).click();
      const panel = page.getByRole('dialog', { name: 'Source' });
      await expect(panel.getByText(/^SOURCE · /)).toBeVisible();
      if (size.width < 768) {
        await expectFullScreen(panel, size);
      } else {
        const box = await panel.boundingBox();
        expect(box && Math.round(box.x + box.width), 'drawer on the right').toBe(size.width);
        expect(box?.width ?? 0).toBeLessThan(size.width);
      }
      await expectOnScreen(panel.getByRole('button', { name: 'Close panel' }));
      await expectOnScreen(panel.getByRole('button', { name: 'OPEN IN REVIEW' }));
      await expectNoSidewaysScroll(page);
      await shot(page, `source-${size.width}`);
      await panel.getByRole('button', { name: 'Close panel' }).click();
      await expect(panel).toHaveCount(0);
    });

    test('CRS dialog fits the viewport and scrolls inside', async ({ page }) => {
      await openRoute(page, (uid) => `/review/${uid}`);
      await page.locator('[data-key="CoordinateSystem"]').getByRole('button', { name: 'CHOOSE CRS…' }).click();
      const dialog = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('radio').first()).toBeVisible();
      await expectInsideViewport(dialog, size);
      if (size.width < 768) await expectFullScreen(dialog, size);
      await expectOnScreen(dialog.getByRole('radio').first());
      await expectOnScreen(dialog.getByRole('button', { name: 'CONFIRM FOR WHOLE DOCUMENT' }));
      await expectNoSidewaysScroll(page);
      await shot(page, `crs-${size.width}`);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });

    test('question dialog fits the viewport and scrolls inside', async ({ page }) => {
      await openRoute(page, () => '/inbox');
      await expect(page.getByText('Loading questions…')).toHaveCount(0);
      await page.locator('button[data-clarification-id]').first().click();
      const dialog = page.getByRole('dialog', { name: /^QUESTION · / });
      await expect(dialog).toBeVisible();
      await expectInsideViewport(dialog, size);
      if (size.width < 768) await expectFullScreen(dialog, size);
      await expectOnScreen(dialog.getByRole('button', { name: 'ANSWER' }));
      await expectOnScreen(dialog.getByRole('button', { name: 'SKIP FOR NOW' }));
      await expectNoSidewaysScroll(page);
      await shot(page, `question-${size.width}`);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });
  });
}
