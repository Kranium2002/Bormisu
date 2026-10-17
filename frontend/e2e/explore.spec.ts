/**
 * Explore layout in sample mode (fictional sample data only, FRONTEND.md F9 to F11): the explore
 * panel (PLACE SEARCH and FILTERS), the RESULTS table with the result set's summary, NOT ON MAP
 * under the map, and the narrow layouts.
 *
 * The sample's gazetteer is fictional: "Elbhafen" is one town (by the Elbquerung Ost site),
 * "Neckar" an uploaded project site and a town, "Lindenfurt" a town with no borehole, "Atlantis"
 * nothing.
 */
import type { Page } from '@playwright/test';
import { expect, openApp, pathOf, resultRow, test, uidOf } from './fixtures';

const panel = (page: Page) => page.getByRole('region', { name: 'Search and filters' });
const placeField = (page: Page) => panel(page).getByRole('textbox', { name: 'Town, address or place' });
const places = (page: Page) => panel(page).getByRole('list', { name: 'Places found' }).getByRole('button');
const placeStatus = (page: Page) => panel(page).getByRole('status');
const rows = (page: Page) => page.locator('[role="table"] [role="row"][data-uid]');
const summary = (page: Page) => page.locator('[data-result-set-bar] p[aria-live]');
const rsParam = (page: Page) => new URL(page.url()).searchParams.get('rs');

/** The map's centre from the URL (`at`), once the map reported a view. */
function mapCentre(page: Page): { lat: number; lng: number } | null {
  const at = new URL(page.url()).searchParams.get('at');
  if (!at) return null;
  const [lat, lng] = at.split(',').map(Number);
  return { lat, lng };
}

/** Goes to a URL inside the app (as a link or Back would), without reloading the page. */
async function goInApp(page: Page, url: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

async function searchPlace(page: Page, q: string): Promise<void> {
  await placeField(page).fill(q);
  await placeField(page).press('Enter');
}

test.describe('place search (F11)', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('Enter submits; typing alone asks nothing', async ({ page }) => {
    await placeField(page).fill('Neckar');
    await page.waitForTimeout(300);
    await expect(places(page)).toHaveCount(0);
    await expect(placeStatus(page)).toHaveText('');
    await placeField(page).press('Enter');
    await expect(placeStatus(page)).toHaveText('2 places found');
  });

  test('one candidate is chosen at once', async ({ page }) => {
    await searchPlace(page, 'Elbhafen');
    await expect(placeStatus(page)).toHaveText('1 place found');
    await expect(places(page)).toHaveCount(1);
    const only = places(page).first();
    await expect(only).toContainText('Elbhafen-Ost (fictional town)');
    await expect(only).toContainText('geocoder');
    await expect(only).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByText('No uploaded boreholes here')).toHaveCount(0);
  });

  // The flight itself is the map canvas's (BoreholeMap follows the store's mapOutline, m2/map): this
  // test needs both halves of M2 round 2.
  test('one candidate: the map flies there', async ({ page }) => {
    await searchPlace(page, 'Elbhafen');
    await expect(placeStatus(page)).toHaveText('1 place found');
    // The map flies to the place (its view goes into the URL when the flight ends).
    await expect
      .poll(() => {
        const c = mapCentre(page);
        return c ? Math.abs(c.lat - 53.535) < 0.05 && Math.abs(c.lng - 10.02) < 0.05 : false;
      }, { timeout: 5000 })
      .toBe(true);
  });

  test('several candidates are listed, uploaded places first; a click chooses one', async ({ page }) => {
    await searchPlace(page, 'Neckar');
    await expect(places(page)).toHaveCount(2);
    await expect(places(page).nth(0)).toContainText('Stadtbahn Neckarbogen project site (uploaded)');
    await expect(places(page).nth(0)).toContainText('uploaded');
    await expect(places(page).nth(0)).toContainText('11 boreholes');
    await expect(places(page).nth(1)).toContainText('Neckarweiler (fictional town)');
    await expect(places(page).nth(1)).toContainText('geocoder');
    for (const b of await places(page).all()) await expect(b).toHaveAttribute('aria-pressed', 'false');
    await places(page).nth(1).click();
    await expect(places(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
    // It holds uploaded boreholes: no "none here" note.
    await expect(panel(page).getByText('No uploaded boreholes here')).toHaveCount(0);
  });

  test('a place without uploaded boreholes says so; an unknown place says "No place found"', async ({ page }) => {
    await searchPlace(page, 'Lindenfurt');
    await expect(places(page)).toHaveCount(1);
    await expect(places(page).first()).toContainText('Lindenfurt (fictional town)');
    const note = panel(page).getByText('No uploaded boreholes here', { exact: true });
    await expect(note).toBeVisible();
    await expect(places(page).first()).toHaveAttribute('aria-describedby', (await note.getAttribute('id'))!);

    await searchPlace(page, 'Atlantis');
    await expect(placeStatus(page)).toHaveText('No place found');
    await expect(places(page)).toHaveCount(0);
  });

  test('a query of one letter is not sent', async ({ page }) => {
    await searchPlace(page, 'x');
    await expect(placeStatus(page)).toHaveText('Type at least two characters.');
  });
});

test.describe('filters and the result set (F10)', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('a filter by project gives a result set: summary, rows and its id in the URL; the URL brings it back; RESET clears it', async ({ page }) => {
    await expect(rows(page)).toHaveCount(48);
    await panel(page).getByLabel('Project', { exact: true }).fill('Spree-Kabeltunnel');
    await panel(page).getByRole('button', { name: 'APPLY' }).click();
    await expect(summary(page)).toHaveText('5 boreholes · 4 on the map · 1 not located · 0 unreviewed left out');
    await expect.poll(() => rsParam(page)).toMatch(/^rs_/);
    const rs = rsParam(page)!;
    await expect(rows(page)).toHaveCount(5);
    for (const r of await rows(page).all()) await expect(r.getByRole('cell').nth(1)).toHaveText('Spree-Kabeltunnel');
    await expect(page.getByText('5 boreholes · 1 project', { exact: true })).toBeVisible();

    // CLEAR next to the summary drops the set and the filter.
    await page.getByRole('button', { name: 'Clear the result set and the filters' }).click();
    await expect.poll(() => rsParam(page)).toBeNull();
    await expect(rows(page)).toHaveCount(48);
    await expect(panel(page).getByLabel('Project', { exact: true })).toHaveValue('');

    // The set's URL (a link, Back) shows it again, with its definition in the panel.
    await goInApp(page, `/map?rs=${rs}`);
    await expect(summary(page)).toHaveText('5 boreholes · 4 on the map · 1 not located · 0 unreviewed left out');
    await expect(rows(page)).toHaveCount(5);
    await expect(panel(page).getByLabel('Project', { exact: true })).toHaveValue('Spree-Kabeltunnel');

    await panel(page).getByRole('button', { name: 'RESET' }).click();
    await expect.poll(() => rsParam(page)).toBeNull();
    await expect(summary(page)).toHaveText('');
    await expect(rows(page)).toHaveCount(48);
    await expect(panel(page).getByLabel('Project', { exact: true })).toHaveValue('');
  });

  test('a reload asks for the URL’s set again (sample sets live in the page, so here it is gone and says so)', async ({ page }) => {
    await panel(page).getByLabel('Project', { exact: true }).fill('Elbquerung Ost');
    await panel(page).getByLabel('Minimum depth (m)').fill('12');
    await panel(page).getByRole('button', { name: 'APPLY' }).click();
    await expect(summary(page)).toHaveText(/^\d+ boreholes? · \d+ on the map · 0 not located · 0 unreviewed left out$/);
    await expect.poll(() => rsParam(page)).toMatch(/^rs_/);
    const rs = rsParam(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
    expect(rsParam(page)).toBe(rs);
    await expect(page.getByRole('alert').filter({ hasText: 'Result set not found or expired.' })).toBeVisible();
  });

  test('a filter nothing matches gives an empty set: zero counts, an empty table that says why', async ({ page }) => {
    await panel(page).getByLabel('Project', { exact: true }).fill('No Such Project (fictional)');
    await panel(page).getByRole('button', { name: 'APPLY' }).click();
    await expect(summary(page)).toHaveText('0 boreholes · 0 on the map · 0 not located · 0 unreviewed left out');
    await expect.poll(() => rsParam(page)).toMatch(/^rs_/);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByRole('table').getByText('No borehole matches this selection.')).toBeVisible();
  });

  test('an invalid depth range is refused before anything is sent', async ({ page }) => {
    await panel(page).getByLabel('Minimum depth (m)').fill('20');
    await panel(page).getByLabel('Maximum depth (m)').fill('5');
    await panel(page).getByRole('button', { name: 'APPLY' }).click();
    await expect(panel(page).getByRole('alert')).toHaveText('The maximum depth must not be less than the minimum.');
    await expect(panel(page).getByLabel('Maximum depth (m)')).toBeFocused();
    await expect(panel(page).getByLabel('Maximum depth (m)')).toHaveAttribute('aria-invalid', 'true');
    expect(rsParam(page)).toBeNull();
    await expect(rows(page)).toHaveCount(48);
  });

  test('DIN codes, tri-states and review status narrow the set; the lithology depth needs a code', async ({ page }) => {
    const lithology = panel(page).getByLabel('Lithology reaches below (m)');
    await expect(lithology).toBeDisabled();
    await panel(page).getByLabel('Find a code').fill('clay');
    await panel(page).locator('input[data-din="T"]').check();
    await expect(lithology).toBeEnabled();
    await expect(panel(page).getByText('1 chosen: T Clay')).toBeVisible();
    await panel(page).getByRole('group', { name: 'Has groundwater' }).getByRole('radio', { name: 'Yes' }).check();
    await panel(page).getByRole('checkbox', { name: 'Approved' }).check();
    await panel(page).getByRole('button', { name: 'APPLY' }).click();
    await expect(summary(page)).toHaveText(/^\d+ boreholes? · /);
    // Every row is approved by the server (an open question or a flag still shows "Needs attention" first).
    for (const r of await rows(page).all()) await expect(r.getByRole('cell').nth(3)).toHaveText(/^(Approved|Needs attention)$/);
  });
});

test.describe('results table (F9)', () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test('MAP in a row (or Space on it) selects the borehole on the map: its popup opens and the row is current', async ({ page }) => {
    const uid = await uidOf(page, 'BK-07');
    await resultRow(page, 'BK-07').getByRole('button', { name: 'Show BK-07 on the map' }).click();
    await expect(page.locator('.leaflet-popup-content')).toContainText('BK-07');
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe(uid);
    await expect(resultRow(page, 'BK-07')).toHaveAttribute('aria-current', 'true');
    expect(new URL(page.url()).pathname).toBe('/map');

    await resultRow(page, 'EQ-02').focus();
    await page.keyboard.press(' ');
    await expect(page.locator('.leaflet-popup-content').filter({ hasText: 'EQ-02' })).toBeVisible();
    // The previous popup fades out (Leaflet removes it after 200 ms): then only this one is left.
    await expect(page.locator('.leaflet-popup-content')).toHaveCount(1);
    await expect(resultRow(page, 'EQ-02')).toHaveAttribute('aria-current', 'true');
    await expect(resultRow(page, 'BK-07')).not.toHaveAttribute('aria-current', 'true');
  });

  test('Enter on a focused row opens Detail; arrow keys move between rows', async ({ page }) => {
    const first = rows(page).first();
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(first).toBeFocused();
    const uid = await first.getAttribute('data-uid');
    await page.keyboard.press('Enter');
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
    expect(pathOf(page)).toBe(`/boreholes/${uid}`);
  });

  test('a pin selected on the map marks its row and scrolls it into view', async ({ page }) => {
    await page.getByLabel('Search project or borehole ID').fill('EQ-09');
    await page.keyboard.press('Enter');
    await expect(page.locator('.leaflet-popup-content')).toContainText('EQ-09');
    const row = resultRow(page, 'EQ-09');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row).toBeInViewport();
  });

  test('headers sort the rows (aria-sort); a depth that is not stated never sorts as 0', async ({ page }) => {
    const header = page.getByRole('columnheader', { name: 'FINAL DEPTH' });
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    const depths = async () =>
      (await rows(page).locator('[role="cell"]:nth-child(3)').allTextContents()).filter((t) => t !== 'not stated').map((t) => parseFloat(t));
    const asc = await depths();
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    const desc = await depths();
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    await expect(page.getByRole('columnheader', { name: 'BOREHOLE' })).not.toHaveAttribute('aria-sort', /./);
  });

  test('NOT ON MAP sits under the map with the reasons; each item opens Detail', async ({ page }) => {
    const map = (await page.getByRole('region', { name: 'Borehole map' }).boundingBox())!;
    const aside = page.getByRole('complementary').filter({ has: page.getByRole('heading', { name: 'NOT ON MAP (3)' }) });
    const box = (await aside.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(map.y + map.height - 1);
    await aside.getByRole('button', { name: /^Open detail of BK-13:/ }).click();
    await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
  });
});

test.describe('explore panel', () => {
  test('sections open and close from the keyboard, and stay so after a reload', async ({ page }) => {
    await openApp(page);
    const filters = panel(page).getByRole('button', { name: 'FILTERS', exact: true });
    await expect(filters).toHaveAttribute('aria-expanded', 'true');
    await filters.focus();
    await page.keyboard.press('Enter');
    await expect(filters).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).getByLabel('Minimum depth (m)')).toBeHidden();
    await page.reload();
    await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'FILTERS', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page).getByRole('button', { name: 'PLACE SEARCH' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('768–1279 px: the panel opens over the map from its toggle; Escape closes it and the focus goes back', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openApp(page);
    const toggle = page.getByRole('button', { name: 'SEARCH & FILTERS' });
    await expect(panel(page)).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'PLACE SEARCH' })).toBeFocused();
    // Over the map, not beside it.
    const map = (await page.getByRole('region', { name: 'Borehole map' }).boundingBox())!;
    const box = (await panel(page).boundingBox())!;
    expect(box.x).toBeLessThan(map.x + 10);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(toggle).toBeFocused();
    // A place flown to closes it too.
    await toggle.click();
    await searchPlace(page, 'Elbhafen');
    await expect(panel(page)).toBeHidden();
  });

  test('below 768 px the panel is a full-screen sheet and the map screen itself fits 390 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    // The app shell (App.module.css, min-width 1280 px) is not part of this screen: lift it to measure the screen alone.
    await page.addStyleTag({ content: 'div[class*="_app_"]{min-width:0 !important}' });
    const screen = page.locator('[data-screen-label="Map"]');
    await expect.poll(() => screen.evaluate((el) => el.clientWidth)).toBe(390);
    expect(await screen.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    await page.getByRole('button', { name: 'SEARCH & FILTERS' }).click();
    const box = (await panel(page).boundingBox())!;
    expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await panel(page).getByRole('button', { name: 'CLOSE' }).click();
    await expect(panel(page)).toBeHidden();
  });

  test('no horizontal page scroll at 390 px', async ({ page }) => {
    test.fail(true, 'App shell: App.module.css sets min-width 1280px on .app (and the header does not wrap); the map screen itself fits, see the test above');
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
