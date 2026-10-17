/**
 * Checks of the profile's copy / download buttons, shared by the sample spec (chartExport.spec.ts)
 * and the API spec (api/chart-export.spec.ts). Not a spec itself.
 */
import { readFile } from 'node:fs/promises';
import { expect, type BrowserContext, type Page } from '@playwright/test';

/** Width of the profile drawing on screen, px (profileGeometry PROFILE_W). */
const PROFILE_W = 414;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height of a PNG, from its IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature').toBe(true);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const tools = (page: Page) => page.getByRole('group', { name: 'Chart image' });
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

/**
 * DOWNLOAD saves `<file>.png`: a PNG at least 3 × the drawing's width, taller than wide, of a sensible
 * size; SVG saves `<file>.svg` with the DIN patterns inlined and no hover titles. `saveAs` keeps the PNG.
 */
export async function expectDownloads(page: Page, file: string, saveAs?: string): Promise<void> {
  let downloading = page.waitForEvent('download');
  await tools(page).getByRole('button', { name: 'Download chart as PNG' }).click();
  let download = await downloading;
  expect(download.suggestedFilename()).toBe(`${file}.png`);
  const png = await readFile(await download.path());
  const { width, height } = pngSize(png);
  expect(width).toBeGreaterThanOrEqual(3 * PROFILE_W);
  expect(height).toBeGreaterThan(width);
  expect(png.length).toBeGreaterThan(30_000);
  expect(png.length).toBeLessThan(8_000_000);
  if (saveAs) await download.saveAs(saveAs);
  await expect(toast(page, 'Chart downloaded')).toBeVisible();

  downloading = page.waitForEvent('download');
  await tools(page).getByRole('button', { name: 'Download chart as SVG' }).click();
  download = await downloading;
  expect(download.suggestedFilename()).toBe(`${file}.svg`);
  const svg = await readFile(await download.path(), 'utf8');
  expect(svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  expect(svg).toContain('<pattern id="din-');
  expect(svg).not.toContain('<title');
}

/** COPY (clipboard permissions granted) puts an image/png of a sensible size on the clipboard. */
export async function expectCopy(page: Page, context: BrowserContext): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await tools(page).getByRole('button', { name: 'Copy chart as image' }).click();
  await expect(toast(page, 'Chart copied')).toBeVisible();
  const items = await page.evaluate(async () => {
    const out: [string, number][] = [];
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) out.push([type, (await item.getType(type)).size]);
    }
    return out;
  });
  const image = items.find(([type]) => type === 'image/png');
  expect(image, `clipboard holds ${JSON.stringify(items)}`).toBeTruthy();
  expect(image![1]).toBeGreaterThan(30_000);
}
