/**
 * Shared Playwright fixtures for the sample-mode smoke tests (fictional sample data only):
 * - OSM tiles are answered with a blank PNG, so the tests run offline and fast.
 * - Console errors and page errors are collected and must be empty at the end of every test.
 */
import { test as base, expect, type Page } from '@playwright/test';

/** A 1×1 light-grey PNG. */
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
  'base64',
);

/** The product name the app shows (VITE_APP_NAME, default as in src/config.ts). */
export const APP_NAME = process.env.VITE_APP_NAME?.trim() || 'Bormisu';

const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/;

export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        // A network blip on the Google Fonts stylesheet is not an app error (the font stack falls back).
        if (m.type() === 'error' && !FONT_HOSTS.test(`${m.text()} ${m.location().url}`)) errors.push(`${m.text()} ${m.location().url}`);
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

/** Opens the app and waits for the sample data to load (map screen). */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText('Demo mode: fictional sample loaded. Live extraction needs an API key.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
}

/** Opens a URL of the app (deep link) and waits until the data is loaded, whatever screen it shows. */
export async function openUrl(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await loaded(page);
}

/** Waits until the header is there and the loading state is gone (after goto, reload or Back). */
export async function loaded(page: Page): Promise<void> {
  await expect(mainNav(page)).toBeVisible();
  await expect(page.getByText('Loading boreholes and documents…')).toHaveCount(0);
}

/** The header's main navigation. */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** A link of the header nav (MAP, UPLOAD & QUEUE with its badge, REVIEW). */
export const navLink = (page: Page, name: 'MAP' | 'UPLOAD & QUEUE' | 'REVIEW') =>
  mainNav(page).getByRole('link', { name: new RegExp(`^${name}`) });

/** Goes to one of the three main screens through the header nav. */
export async function nav(page: Page, name: 'MAP' | 'UPLOAD & QUEUE' | 'REVIEW'): Promise<void> {
  await navLink(page, name).click();
}

/** The opaque uid of a borehole, read from its RESULTS row on the map screen. */
export async function uidOf(page: Page, id: string): Promise<string> {
  const uid = await resultRow(page, id).getAttribute('data-uid');
  expect(uid, `uid of ${id}`).toBeTruthy();
  return uid as string;
}

/** The path and query of the page's URL, decoded (e.g. "/boreholes/nb:BK-07?layer=3"). */
export const pathOf = (page: Page) => {
  const u = new URL(page.url());
  return decodeURIComponent(u.pathname + u.search);
};

/** The map's circle markers (Leaflet SVG paths). */
/** Pins are canvas drawings: the map root reports how many it shows in data-pins. */
export const pinCount = async (page: Page) => Number(await page.locator('[data-pins]').getAttribute('data-pins'));


export const AMBER = '#E39B00';

export type LegendStatus = 'approved' | 'in_review' | 'unreviewed' | 'attention';

/** The count shown in one row of the status legend. */
export const legendCount = (page: Page, status: LegendStatus) =>
  page.getByRole('group', { name: 'Review status legend' }).locator(`li[data-status="${status}"] span`).last();

/** The count of one legend row as a number. */
export async function legendNumber(page: Page, status: LegendStatus): Promise<number> {
  return Number(await legendCount(page, status).textContent());
}

/** A RESULTS row by its borehole ID as printed (uids are opaque). */
export const resultRow = (page: Page, id: string) =>
  page.locator('[role="table"] [role="row"][data-uid]').filter({ has: page.getByText(id, { exact: true }) }).first();
