import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { EXTRA_FIELDS, section } from '../src/schema/targetFormat';
import { expect, openApp, resultRow, test } from './fixtures';

/** Opens BK-07 (the hand-made fictional sample borehole) on the detail screen. */
async function openBk07(page: Page) {
  await openApp(page);
  await resultRow(page, 'BK-07').click();
  await expect(page.getByText('DIN 4023 · depth in m bgl')).toBeVisible();
}

async function exportAs(page: Page, option: RegExp) {
  await page.getByRole('button', { name: 'EXPORT ▾' }).click();
  await expect(page.getByText('EXPORT PROJECT · STADTBAHN NECKARBOGEN')).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: option }).click();
  return downloading;
}

test.describe('detail', () => {
  test.beforeEach(async ({ page }) => openBk07(page));

  test('shows the DIN 4023 profile, metadata and layer tables', async ({ page }) => {
    await expect(page.getByRole('group', { name: /^DIN 4023 profile of BK-07/ })).toBeVisible();
    await expect(page.getByText('0 of 30 values reviewed')).toBeVisible();
    await expect(page.getByText('Log bottom 14.50 m ≠ final depth 18.00 m. Possibly a missing sheet 3.')).toBeVisible();
    const layers = page.getByRole('grid', { name: 'Layers' });
    await expect(layers.getByRole('columnheader', { name: 'DIN 4023' })).toBeVisible();
    await expect(layers.getByRole('columnheader', { name: 'STRAT.' })).toBeVisible();
    // Metadata: unknown values read "not in source", never 0.
    const meta = page.getByRole('region', { name: 'Metadata' });
    await expect(meta.getByText('Final depth')).toBeVisible();
    await expect(meta.getByText(/^0(\.0+)?( m)?$/)).toHaveCount(0);
  });

  test('a layer’s SPT opens the source panel with the highlighted box', async ({ page }) => {
    const layers = page.getByRole('grid', { name: 'Layers' });
    const refusal = layers.getByRole('button', { name: 'R', exact: true }).first();
    await expect(refusal).toHaveAttribute('title', /SPT (at \d+\.\d\d m|depth not stated)\./);
    await refusal.click();
    const panel = page.getByRole('dialog', { name: 'Source' });
    await expect(panel.getByText(/^SOURCE · SPT/)).toBeVisible();
    await expect(panel.getByText('as printed: “50/30”')).toBeVisible();
    const box = panel.locator('[class*="highlight"]');
    await expect(box).toBeVisible();
    await expect(panel.getByText('Box not found: page shown')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('tidy CSV export downloads a file', async ({ page }) => {
    const download = await exportAs(page, /^Tidy CSV/);
    expect(download.suggestedFilename()).toBe('neckarbogen_tidy.csv');
    const text = await readFile(await download.path(), 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff); // BOM, so Excel reads umlauts as UTF-8
    const header = text.slice(1).split(/\r?\n/)[0].replaceAll('"', '');
    expect(header).toBe('borehole,field,layer,raw,value,unit,page,method,status,state');
    await expect(page.getByText(/^Tidy CSV: \d+ values · approved only$/)).toBeVisible();
  });

  test('standard xlsx export has the template sheets with the field names in row 1', async ({ page }) => {
    const download = await exportAs(page, /^Project xlsx \(target format\)/);
    expect(download.suggestedFilename()).toBe('neckarbogen_target-format.xlsx');
    const wb = new ExcelJS.Workbook();
    const bytes = await readFile(await download.path());
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Metadata', 'Logdata', 'Test Results', 'Provenance']);

    const row1 = (sheet: string) => {
      const values = wb.getWorksheet(sheet)?.getRow(1).values as unknown[];
      return values.slice(1).map(String);
    };
    const meta = section('metadata').fields.map((f) => f.name);
    const log = section('logdata').fields.map((f) => f.name);
    const tests = section('testResults').fields.map((f) => f.name);
    // The template's columns come first, in order; fields beyond the template follow them.
    expect(row1('Metadata').slice(0, meta.length)).toEqual(meta);
    expect(row1('Metadata').slice(meta.length)).toContain(EXTRA_FIELDS.drillingMethod);
    expect(row1('Logdata').slice(0, 3 + log.length)).toEqual([meta[0], EXTRA_FIELDS.depthFrom, EXTRA_FIELDS.depthTo, ...log]);
    expect(row1('Test Results').slice(-tests.length)).toEqual(tests);
    expect(row1('Provenance').slice(0, 3)).toEqual([meta[0], 'key', 'field']);
    expect(meta).toHaveLength(14);
    expect(log).toHaveLength(12);
    expect(tests).toHaveLength(19);
    // One Metadata row per borehole of the document after the units row, each keyed by its ID.
    const ids = (wb.getWorksheet('Metadata')?.getColumn(1).values as unknown[]).slice(3).map(String);
    expect(ids).toHaveLength(13);
    expect(ids).toContain('BK-07');
    expect(ids).not.toContain('BK-12');
  });
});
