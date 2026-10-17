/**
 * Borehole detail in API mode: the DIN 4023 profile drawn from assets/din4023_patterns, its legend,
 * and the metadata with the coordinates exactly as printed.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`): boreholes with layers whose
 * din4023_code is a key of din_codes.json (one starts with fill `A`), and printed coordinates.
 * The seed has no layer with an unknown or missing code, so that case patches one record of the
 * real answers in the browser (route) and checks the drawing. Read-only: changes nothing.
 */
import { readFileSync } from 'node:fs';
import { DIN_CODES, COLOR, editRecords, expect, openApp, openDetail, records, test, UNPLOTTED_LABEL, type WireRecord } from './fixtures';

const profile = (page: import('@playwright/test').Page, id: string) =>
  page.getByRole('group', { name: new RegExp(`^DIN 4023 profile of ${id.replace(/[-]/g, '\\-')},`) });

/** "18.00" style labels of the profile (decimal point, uiv-B8: the comma is kept only for the sample's printed text). */
const decimal = (n: number) => n.toFixed(2);

test('every layer fills with url(#<pattern_id>) of its DIN code, the patterns are defined once in the page', async ({ page, request }) => {
  const all = (await records(request)).filter((r) => r.stratigraphy.length > 0);
  expect(all.length).toBeGreaterThan(0);
  await openApp(page);

  // patterns.svg is inlined once: every pattern id of din_codes.json exists exactly once, user-space tiles.
  const ids = Object.values(DIN_CODES).map((e) => e.pattern_id);
  const inPage = await page.locator('[id]').evaluateAll((els) =>
    els.map((e) => ({ id: e.getAttribute('id') as string, tag: (e.tagName as string).toLowerCase(), units: e.getAttribute('patternUnits') as string | null })),
  );
  for (const id of ids) {
    const hits = inPage.filter((x) => x.id === id);
    expect(hits, `pattern ${id}`).toEqual([{ id, tag: 'pattern', units: 'userSpaceOnUse' }]);
  }

  for (const r of all) {
    const id = r.metadata.borehole_id;
    await openDetail(page, id);
    const rects = profile(page, id).locator('rect[data-din]');
    await expect(rects).toHaveCount(r.stratigraphy.length);
    const fills = await rects.evaluateAll((els) => els.map((e) => ({ din: e.getAttribute('data-din'), fill: e.getAttribute('fill') })));
    expect(fills, `${id} layer fills`).toEqual(
      r.stratigraphy.map((l) => ({
        din: l.din4023_code ?? '',
        fill: l.din4023_code && DIN_CODES[l.din4023_code] ? `url(#${DIN_CODES[l.din4023_code].pattern_id})` : COLOR.unknownDin,
      })),
    );
    // `A` (fill) has no background colour: a white underlay is drawn first.
    const aLayers = r.stratigraphy.filter((l) => l.din4023_code === 'A').length;
    await expect(profile(page, id).locator('rect[fill="#fff"]')).toHaveCount(aLayers);
    // Final depth label; unknown depth says so and is never 0.
    const depth = r.metadata.borehole_depth_m;
    await expect(profile(page, id)).toContainText(depth != null && depth > 0 ? `ET ${decimal(depth)} m` : 'ET not stated');
  }
});

test('the legend lists the codes used with their English names and says "nach DIN 4023"', async ({ page, request }) => {
  const [r] = (await records(request)).filter((x) => x.stratigraphy.length >= 3);
  await openApp(page);
  await openDetail(page, r.metadata.borehole_id);
  const legend = page.getByRole('list', { name: 'DIN 4023 codes in this profile' });
  const codes = [...new Set(r.stratigraphy.map((l) => l.din4023_code).filter((c): c is string => !!c))];
  await expect(legend.locator('li[data-din]')).toHaveCount(codes.length);
  for (const code of codes) {
    const item = legend.locator(`li[data-din="${code}"]`);
    await expect(item).toContainText(code);
    await expect(item).toContainText(DIN_CODES[code].name_en);
    await expect(item.locator('rect').last()).toHaveAttribute('fill', `url(#${DIN_CODES[code].pattern_id})`);
  }
  await expect(page.getByText('nach DIN 4023', { exact: true })).toBeVisible();
});

test('unknown or missing DIN codes are plain #E0E0E0, named in the legend, never a guessed pattern', async ({ page, request }) => {
  const [target] = (await records(request)).filter((x) => x.stratigraphy.length >= 3);
  const id = target.metadata.borehole_id;
  // The seed has none: blank the first layer's code and give the second a code that is not a DIN key
  // (in the browser's copy of the record, whether it comes at boot or on demand).
  await editRecords(page, (rec: WireRecord) => {
    if (rec.uid !== target.uid) return;
    rec.stratigraphy[0].din4023_code = null;
    rec.stratigraphy[1].din4023_code = 'Qx';
  });
  await openApp(page);
  await openDetail(page, id);
  const rects = profile(page, id).locator('rect[data-din]');
  await expect(rects.nth(0)).toHaveAttribute('fill', COLOR.unknownDin);
  await expect(rects.nth(1)).toHaveAttribute('fill', COLOR.unknownDin);
  await expect(rects.nth(1)).toHaveAttribute('data-din', 'Qx');
  await expect(profile(page, id).locator('text', { hasText: /^Qx$/ })).toHaveCount(1);
  const legend = page.getByRole('list', { name: 'DIN 4023 codes in this profile' });
  await expect(legend.locator('li[data-din="Qx"]')).toContainText('not a DIN 4023 code');
  await expect(legend).toContainText('no DIN code in source');
});

test('metadata shows the coordinates exactly as printed next to the converted values', async ({ page, request }) => {
  const withRaw = (await records(request)).filter((r) => r.metadata.coordinates.x_raw || r.metadata.coordinates.y_raw);
  expect(withRaw.length).toBeGreaterThan(0);
  await openApp(page);
  for (const r of withRaw) {
    const c = r.metadata.coordinates;
    await openDetail(page, r.metadata.borehole_id);
    const meta = page.getByLabel('Metadata');
    const printed = [c.x_raw, c.y_raw].filter(Boolean).join(' / ');
    await expect(meta, r.metadata.borehole_id).toContainText(`as printed: ${printed}${c.axis_labels_raw ? ` (${c.axis_labels_raw})` : ''}`);
  }
});

test('location: plotted boreholes show their WGS84 position and CRS, unplotted ones the reason, never 0,0', async ({ page, request }) => {
  const all = await records(request);
  await openApp(page);
  for (const r of all) {
    await openDetail(page, r.metadata.borehole_id);
    const meta = page.getByLabel('Metadata');
    const c = r.metadata.coordinates;
    if (r.plotted) {
      await expect(meta, r.metadata.borehole_id).toContainText(`${c.latitude!.toFixed(4)}, ${c.longitude!.toFixed(4)}`);
      await expect(meta.getByRole('img', { name: /^Map of / })).toHaveCount(1);
    } else {
      await expect(meta, r.metadata.borehole_id).toContainText(`${UNPLOTTED_LABEL[r.unplotted_reason ?? '']}: not on the map`);
      await expect(meta).toContainText('No usable coordinates');
    }
    await expect(meta).not.toContainText('0.0000, 0.0000');
  }
});

test('EXPORT downloads the target-format xlsx and the tidy CSV built from the API data', async ({ page, request }) => {
  const [approved] = (await records(request)).filter((r) => r.review_status === 'approved');
  test.skip(!approved, 'no approved borehole in the seed');
  const id = approved.metadata.borehole_id;
  await openApp(page);
  await openDetail(page, id);
  const options = [
    { name: 'Project xlsx (target format)', ext: '.xlsx' },
    { name: 'Tidy CSV', ext: '.csv' },
  ];
  for (const o of options) {
    await page.getByRole('button', { name: /^EXPORT/ }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: o.name }).click();
    const file = await download;
    expect(file.suggestedFilename().endsWith(o.ext), file.suggestedFilename()).toBe(true);
    const bytes = readFileSync(await file.path());
    expect(bytes.length, `${o.name} size`).toBeGreaterThan(200);
    if (o.ext === '.csv') expect(bytes.toString('utf8')).toContain(id);
  }
});

/** The METADATA row with this label. */
const metaRow = (page: import('@playwright/test').Page, label: string) =>
  page.getByLabel('Metadata').getByText(label, { exact: true }).locator('..');

test('FE-DISP-1: surface elevation names its datum once (no "m m s.n.m.", no "NHN · datum NHN")', async ({ page, request }) => {
  const withDatum = (await records(request)).filter((r) => r.metadata.elevation_datum && r.metadata.surface_elevation_mASL != null);
  test.skip(!withDatum.length, 'no seeded elevation with a datum');
  await openApp(page);
  for (const r of withDatum) {
    await openDetail(page, r.metadata.borehole_id);
    const text = (await metaRow(page, 'Surface elevation').textContent()) ?? '';
    const datum = r.metadata.elevation_datum!;
    expect.soft(text.split(datum).length - 1, `${r.metadata.borehole_id}: "${text}"`).toBe(1);
    expect.soft(text, r.metadata.borehole_id).not.toMatch(/\bm m\b/);
  }
});

test('CONTRACT-2: a rock head the backend left null is not shown as a Derived "not reached"', async ({ page, request }) => {
  const r = (await records(request)).find((x) => x.rock_head_m == null && !x.provenance.rock_head_m && x.stratigraphy.length > 0);
  test.skip(!r, 'no seeded borehole without a rock head');
  await openApp(page);
  await openDetail(page, r!.metadata.borehole_id);
  await expect(metaRow(page, 'Rock head')).not.toContainText('Derived');
});
