/// <reference lib="dom" />
/**
 * The selection report in sample mode (fictional sample data): EXPORT REPORT from an area drawn on the
 * map and from LIST, the summary table, the combined soil chart (below ground and by elevation, capped
 * at 40 with a note), the DIN legend, the per-borehole pages, the downloads (layers CSV and xlsx, the
 * chart as PNG and SVG), the print layout and the German labels. REPORT_SHOTS=<dir> saves screenshots.
 */
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, nav, openApp, test } from './fixtures';

const mapRegion = (page: Page) => page.getByRole('region', { name: 'Borehole map' });
const report = (page: Page) => page.getByTestId('report');

/** With REPORT_SHOTS set: the whole report (the screen scrolls in its own box, so the viewport grows to it). */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.REPORT_SHOTS;
  if (!dir) return;
  const size = page.viewportSize()!;
  const height = await page.locator('[data-screen-label="Report"]').evaluate((e) => e.scrollHeight + 160);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 16000) });
  await page.screenshot({ path: `${dir}/${name}.png` });
  await page.setViewportSize(size);
}

async function drawRectangle(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await mapRegion(page).boundingBox())!;
  await page.getByRole('button', { name: 'Select by rectangle' }).click();
  await page.mouse.click(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 4 });
  await page.mouse.click(box.x + box.width * to[0], box.y + box.height * to[1]);
}

/** With REPORT_SHOTS set: one element of the report. */
async function shotOf(locator: ReturnType<Page['locator']>, name: string): Promise<void> {
  const dir = process.env.REPORT_SHOTS;
  if (dir) await locator.screenshot({ path: `${dir}/${name}.png` });
}

/** A download started by `click`: its file name and content. */
async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; body: Buffer }> {
  const started = page.waitForEvent('download');
  await click();
  const d = await started;
  return { name: d.suggestedFilename(), body: await readFile((await d.path())!) };
}

test.describe('selection report', () => {
  test('an area drawn on the map: EXPORT REPORT opens the report with its boreholes, chart, details and downloads', async ({ page }) => {
    await openApp(page);
    await expect(mapRegion(page)).toHaveAttribute('data-ready', 'true');
    await drawRectangle(page, [0.25, 0.2], [0.8, 0.85]);
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toMatch(/^rs_/);
    const rs = new URL(page.url()).searchParams.get('rs');

    // The chip's links sit on the line of its CLEAR button, as buttons do (a link is a block in the bar).
    const middle = async (name: string) => {
      const b = (await page.locator('[data-result-set-bar]').getByText(name, { exact: true }).boundingBox())!;
      return b.y + b.height / 2;
    };
    const clear = await middle('CLEAR');
    expect(Math.abs((await middle('EXPORT REPORT')) - clear)).toBeLessThan(2.5);
    expect(Math.abs((await middle('OPEN LIST ›')) - clear)).toBeLessThan(2.5);

    await page.getByTestId('export-report').click();
    await expect(page).toHaveURL(new RegExp(`/report\\?rs=${rs}$`));
    await expect(report(page)).toBeVisible();
    await expect(report(page).getByRole('heading', { level: 1 })).toHaveText('BOREHOLE REPORT');
    await expect(report(page)).toContainText('Area: Rectangle');

    // Summary: one row per member, numbered; positions and sources are there.
    const rows = page.getByTestId('report-summary').locator('tbody tr');
    const n = await rows.count();
    expect(n).toBeGreaterThan(5);
    await expect(rows.first().locator('td').first()).toHaveText('1');
    await expect(rows.first()).toContainText('° N');
    await expect(page.getByTestId('report-map')).toBeVisible();

    // The combined chart: one column per borehole (up to 40), the DIN legend, the axis switch.
    const chart = page.getByTestId('combined-chart');
    await expect(chart).toBeVisible();
    expect(await chart.locator('g[data-uid]').count()).toBe(Math.min(n, 40));
    await expect(page.getByRole('list', { name: 'DIN 4023 legend' }).locator('li').first()).toBeVisible();
    await page.getByText('BY ELEVATION').click();
    await expect(chart).toContainText('Elevation (m NN)');
    await page.getByText('BELOW GROUND').click();
    await expect(chart).toContainText('Depth below ground (m)');

    // Per borehole: ten on a page, with their profile and layer table; NEXT shows the next ten.
    const details = report(page).locator('section[data-uid]');
    await expect(details).toHaveCount(Math.min(n, 10));
    await expect(details.first().locator('svg').first()).toBeVisible();
    await expect(details.first().locator('table tbody tr').first()).toBeVisible();
    if (n > 10) {
      const first = await details.first().getAttribute('data-uid');
      await page.getByRole('navigation', { name: 'Borehole pages' }).first().getByRole('button', { name: 'NEXT ›' }).click();
      await expect(details.first()).not.toHaveAttribute('data-uid', first!);
    }
    await shot(page, 'sample-area-report');
    await shotOf(page.getByTestId('combined-chart'), 'sample-area-chart');
    await shotOf(details.first(), 'sample-area-borehole');
    await shotOf(page.getByTestId('report-summary'), 'sample-area-summary');

    // Layers as CSV: a header and one row per layer, with source file and page.
    const csv = await download(page, () => page.getByRole('button', { name: 'LAYERS CSV' }).click());
    expect(csv.name).toMatch(/^Area_Rectangle.*_layers\.csv$/);
    const lines = csv.body.toString('utf8').replace(/^﻿/, '').split('\n');
    expect(lines[0]).toContain('"BoreholeID"');
    expect(lines[0]).toContain('"DIN4023"');
    expect(lines[0]).toContain('"SourceDocument"');
    expect(lines.length).toBeGreaterThan(n);

    const xlsx = await download(page, () => page.getByRole('button', { name: 'LAYERS XLSX' }).click());
    expect(xlsx.name).toMatch(/_layers\.xlsx$/);
    expect(xlsx.body.subarray(0, 2).toString()).toBe('PK');

    // The chart as PNG and SVG, with its DIN patterns inlined.
    const tools = page.getByRole('group', { name: 'Chart image' });
    const png = await download(page, () => tools.getByRole('button', { name: 'Download chart as PNG' }).click());
    expect(png.name).toMatch(/_soil-chart\.png$/);
    const svg = await download(page, () => tools.getByRole('button', { name: 'Download chart as SVG' }).click());
    expect(svg.body.toString()).toContain('<pattern id="din-');

    // Print: only the page; the toolbar and the axis switch are hidden.
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'PRINT / SAVE AS PDF' })).toBeHidden();
    await expect(report(page)).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
  });

  test('LIST without a selection: EXPORT REPORT reports every borehole; the chart says it is capped at 40', async ({ page }) => {
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByTestId('export-report').click();
    await expect(page).toHaveURL(/\/report\?rs=rs_/);
    await expect(report(page)).toContainText('All boreholes');
    await expect(page.getByTestId('report-summary').locator('tbody tr')).toHaveCount(48);
    await expect(page.getByTestId('chart-note')).toContainText('Showing the first 40 of 48 boreholes');
    // Boreholes without a map position are in the report, said so.
    await expect(page.getByTestId('report-summary')).toContainText('not on the map');
    await shot(page, 'sample-list-report');
  });

  test('German labels follow the app language', async ({ page }) => {
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'DE', exact: true }).click();
    await page.getByTestId('export-report').click();
    await expect(report(page).getByRole('heading', { level: 1 })).toHaveText('BOHRBERICHT');
    await expect(report(page)).toContainText('Alle Bohrungen');
    await expect(page.getByRole('button', { name: 'DRUCKEN / ALS PDF SPEICHERN' })).toBeVisible();
  });

  test('at phone width the summary table scrolls in its own box and the page stays on the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByTestId('export-report').click();
    await expect(page.getByTestId('report-summary').locator('tbody tr')).toHaveCount(48);
    const pageBox = (await report(page).boundingBox())!;
    expect(pageBox.x).toBeGreaterThanOrEqual(0);
    expect(pageBox.x + pageBox.width).toBeLessThanOrEqual(390);
    const scroll = page.getByTestId('report-summary-scroll');
    const [scrollWidth, clientWidth] = await scroll.evaluate((e) => [e.scrollWidth, e.clientWidth]);
    expect(scrollWidth).toBeGreaterThan(clientWidth);
    // The table's last column is reachable by scrolling the box.
    await scroll.evaluate((e) => e.scrollTo({ left: e.scrollWidth }));
    await expect(page.getByTestId('report-summary').getByRole('columnheader', { name: 'Source' })).toBeInViewport();
  });

  test('print keeps the A4 layout, also when the page is narrower than a phone breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 1000 });
    await openApp(page);
    await nav(page, 'LIST');
    await page.getByTestId('export-report').click();
    await expect(report(page)).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    // Each borehole: profile beside its tables (two columns), as on paper, not the stacked phone layout.
    const columns = await report(page)
      .locator('section[data-uid] > div')
      .first()
      .evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(2);
    await page.emulateMedia({ media: 'screen' });
  });

  test('LIST with a selection: EXPORT REPORT is a link that looks like the buttons (no underline)', async ({ page }) => {
    await openApp(page);
    await expect(mapRegion(page)).toHaveAttribute('data-ready', 'true');
    await drawRectangle(page, [0.25, 0.2], [0.8, 0.85]);
    await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toMatch(/^rs_/);
    await nav(page, 'LIST');
    const link = page.getByRole('link', { name: 'EXPORT REPORT' });
    await expect(link).toBeVisible();
    expect(await link.evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('none');
    // Its text centred in the button box (a flex item's inline-flex computes as flex).
    expect(await link.evaluate((e) => getComputedStyle(e).display)).toMatch(/flex$/);
    expect(await link.evaluate((e) => getComputedStyle(e).alignItems)).toBe('center');
  });

  test('/report without a selection explains how to get one', async ({ page }) => {
    await openApp(page);
    await page.goto('/report');
    await expect(page.getByText('NO SELECTION')).toBeVisible();
  });
});
