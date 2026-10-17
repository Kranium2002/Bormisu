/**
 * Shared Playwright fixtures for the sample-mode smoke tests:
 * - OSM tiles are answered with a blank PNG, so the tests run offline and fast.
 * - Console errors and page errors are collected and must be empty at the end of every test.
 */
import { test as base, expect, type Page } from '@playwright/test';

/** A 1×1 light-grey PNG. */
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
  'base64',
);

export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`);
      });
      page.on('pageerror', (e) => errors.push(process.env.E2E_STACKS ? `${e.message}\n${e.stack}` : e.message));
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

/** Opens the app (optionally with a query, e.g. '?focus=DE') and waits for the sample data to load (map screen). */
export async function openApp(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
}

/** Goes to one of the three main screens through the header nav. */
export async function nav(page: Page, name: 'MAP' | 'UPLOAD & QUEUE' | 'REVIEW'): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

/** The map's circle markers (Leaflet SVG paths). */
export const pins = (page: Page) => page.locator('.leaflet-overlay-pane path.leaflet-interactive');

/** Fill colours of the map pins. */
export const pinFills = (page: Page) => pins(page).evaluateAll((ps) => ps.map((p) => p.getAttribute('fill')));

export const AMBER = '#E39B00';

/** The map focus dropdown (MAP FOCUS). */
export const focusSelect = (page: Page) => page.getByLabel('MAP FOCUS');

/** Picks a focus in the dropdown, e.g. 'DE' or 'world', and waits until the map shows it. */
export async function chooseFocus(page: Page, value: string): Promise<void> {
  await focusSelect(page).selectOption(value);
  await expect(page).toHaveURL(new RegExp(`[?&]focus=${value}(&|#|$)`));
}

/**
 * Test-only: moves one fictional sample project (by ID prefix, e.g. "RB-") to another position by
 * patching the sample generator module as the dev server serves it; src/sample/ stays untouched.
 * The tests use it to put boreholes where no country is (offshore). Call before openApp().
 */
export async function moveSampleProject(page: Page, prefix: string, lat: number, lng: number): Promise<void> {
  await page.route(/\/src\/sample\/generate\.ts(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const p = JSON.stringify(prefix);
    const patch =
      `\n;{ const p = PROJECTS.find((x) => x.pre === ${p});` +
      ` if (!p) throw new Error('e2e: no sample project ' + ${p}); p.lat = ${lat}; p.lng = ${lng}; }\n`;
    await route.fulfill({ response, body: (await response.text()) + patch });
  });
}

/** The count shown in one row of the REVIEW STATUS legend. */
export const legendCount = (page: Page, status: 'reviewed' | 'unreviewed' | 'attention') =>
  page.getByRole('group', { name: 'Review status legend' }).locator(`li[data-status="${status}"] span`).last();
