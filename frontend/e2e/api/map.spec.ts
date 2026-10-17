/**
 * Map screen in API mode: pins, legend, NOT ON MAP, RESULTS and pin popups against the seeded backend.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`) with plotted and unplotted boreholes.
 * Every expectation is computed from the backend's own answers (GET /boreholes, GET
 * /map/boreholes.geojson), so the spec also holds after other specs changed review states.
 * Read-only: changes nothing.
 */
import {
  expect,
  expectedPinColor,
  knownBug,
  expectedStatus,
  mapFeatures,
  openApp,
  pins,
  records,
  resultRow,
  STATUS_LABEL,
  test,
  UNPLOTTED_LABEL,
  type WireRecord,
} from './fixtures';

/** Display status of any record: attention (open question, flag, lint error) wins over review_status. */
function statusOf(r: WireRecord): keyof typeof STATUS_LABEL {
  const attention =
    (r.open_clarifications ?? 0) > 0 ||
    Object.values(r.provenance).some((p) => p.status === 'flagged') ||
    r.lint.some((l) => l.severity === 'error');
  return expectedStatus({ review_status: r.review_status, attention });
}

const sorted = (xs: string[]) => [...xs].sort();

test('plotted boreholes are pins coloured by status; the legend counts them', async ({ page, request }) => {
  const features = await mapFeatures(request);
  expect(features.length, 'seeded plotted boreholes').toBeGreaterThan(0);
  await openApp(page);

  await expect(pins(page)).toHaveCount(features.length);
  const fills = await pins(page).evaluateAll((ps) => ps.map((p) => p.getAttribute('fill') ?? ''));
  const expected = features.map((f) => expectedPinColor(expectedStatus(f.properties)));
  expect(sorted(fills)).toEqual(sorted(expected));

  const legend = page.getByRole('group', { name: 'Review status legend' });
  for (const status of ['approved', 'in_review', 'unreviewed', 'attention'] as const) {
    const n = features.filter((f) => expectedStatus(f.properties) === status).length;
    await expect(legend.locator(`li[data-status="${status}"] span`).last(), `legend ${status}`).toHaveText(String(n));
  }
});

test('NOT ON MAP lists exactly the unplotted boreholes with the reason label; none is drawn', async ({ page, request }) => {
  const unplotted = await records(request, '?plotted=false');
  const features = await mapFeatures(request);
  expect(unplotted.length, 'seeded unplotted boreholes').toBeGreaterThan(0);
  await openApp(page);

  const aside = page.locator('aside').filter({ has: page.getByRole('heading', { name: /^NOT ON MAP/ }) });
  await expect(aside.getByRole('heading')).toHaveText(`NOT ON MAP (${unplotted.length})`);
  const items = aside.locator('button[data-uid]');
  await expect(items).toHaveCount(unplotted.length);
  for (const r of unplotted) {
    const reason = UNPLOTTED_LABEL[r.unplotted_reason ?? ''];
    expect(reason, `known unplotted_reason "${r.unplotted_reason}" of ${r.metadata.borehole_id}`).toBeTruthy();
    const item = aside.locator(`button[data-uid="${r.uid}"]`);
    await expect(item).toContainText(r.metadata.borehole_id);
    await expect(item).toContainText(reason);
  }
  // No pin for an unplotted borehole (e.g. at 0,0): the pins are exactly the map layer's features.
  await expect(pins(page)).toHaveCount(features.length);
});

test('RESULTS lists every borehole with project, depth, status and CRS status', async ({ page, request }) => {
  const all = await records(request);
  await openApp(page);
  const projects = new Set(all.map((r) => r.metadata.project_name ?? '')).size;
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'RESULTS' }) })).toContainText(
    `${all.length} boreholes · ${projects} projects`,
  );
  await expect(page.locator('[role="table"] [role="row"][data-uid]')).toHaveCount(all.length);
  for (const r of all) {
    const row = page.locator(`[role="table"] [role="row"][data-uid="${r.uid}"]`);
    const cells = row.getByRole('cell');
    await expect(cells.nth(0)).toHaveText(r.metadata.borehole_id);
    await expect(cells.nth(1)).toHaveText(r.metadata.project_name ?? '');
    const depth = r.metadata.borehole_depth_m;
    await expect(cells.nth(2)).toHaveText(depth != null && depth > 0 ? `${depth.toFixed(2)} m` : '–');
    await expect(cells.nth(3)).toHaveText(STATUS_LABEL[statusOf(r)]);
    await expect(cells.nth(4)).toHaveText(new RegExp(`^${r.crs_status}`));
  }
});

test('search flies to each plotted borehole and its popup shows ID, project, depth and status; OPEN DETAIL opens Detail', async ({ page, request }) => {
  test.setTimeout(90_000);
  const features = await mapFeatures(request);
  const all = await records(request);
  await openApp(page);
  const search = page.getByRole('textbox', { name: 'Search project or borehole ID' });
  const popup = page.locator('.leaflet-popup-content');
  for (const f of features) {
    const r = all.find((x) => x.uid === f.properties.uid);
    expect(r, `record of map feature ${f.properties.borehole_id}`).toBeTruthy();
    await search.fill(f.properties.borehole_id);
    await search.press('Enter');
    await expect(popup).toHaveCount(1);
    await expect(popup.getByRole('button', { name: `Open detail of ${f.properties.borehole_id}` })).toBeVisible();
    await expect(popup).toContainText(r!.metadata.project_name ?? '');
    const depth = r!.metadata.borehole_depth_m;
    await expect(popup).toContainText(`Final depth ${depth != null && depth > 0 ? `${depth.toFixed(2)} m` : '–'}`);
    await expect(popup).toContainText(STATUS_LABEL[expectedStatus(f.properties)]);
  }
  // The last popup opens that borehole's Detail.
  const last = features[features.length - 1].properties.borehole_id;
  await popup.getByRole('button', { name: `Open detail of ${last}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: last, exact: true })).toBeVisible();
});

test('search for an unplotted borehole says why it is not on the map instead of flying anywhere', async ({ page, request }) => {
  const unplotted = await records(request, '?plotted=false');
  await openApp(page);
  const search = page.getByRole('textbox', { name: 'Search project or borehole ID' });
  for (const r of unplotted) {
    await search.fill(r.metadata.borehole_id);
    await search.press('Enter');
    await expect(page.getByRole('banner').getByRole('status')).toHaveText(
      `${r.metadata.borehole_id}: ${UNPLOTTED_LABEL[r.unplotted_reason ?? '']}. Listed under Not on map.`,
    );
    await expect(page.locator('.leaflet-popup-content')).toHaveCount(0);
  }
});

test('a RESULTS row and a NOT ON MAP item open the borehole detail', async ({ page, request }) => {
  const [plotted] = (await records(request)).filter((r) => r.plotted);
  const [unplotted] = await records(request, '?plotted=false');
  await openApp(page);
  await resultRow(page, plotted.metadata.borehole_id).click();
  await expect(page.getByRole('heading', { level: 1, name: plotted.metadata.borehole_id, exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Map' }).click();
  await page.locator(`aside button[data-uid="${unplotted.uid}"]`).click();
  await expect(page.getByRole('heading', { level: 1, name: unplotted.metadata.borehole_id, exact: true })).toBeVisible();
  await expect(page.getByLabel('Metadata')).toContainText(`${UNPLOTTED_LABEL[unplotted.unplotted_reason ?? '']}: not on the map`);
});

test('FE-MAP-1: the first view shows every pin inside the map, none hidden under the legend', async ({ page, request }) => {
  knownBug('FE-MAP-1', 'fitBounds pads 24 px and ignores the REVIEW STATUS legend overlay');
  const features = await mapFeatures(request);
  await openApp(page);
  await expect(pins(page)).toHaveCount(features.length);
  const map = (await page.getByRole('region', { name: 'Borehole map' }).boundingBox())!;
  const legend = (await page.getByRole('group', { name: 'Review status legend' }).boundingBox())!;
  const fills = await pins(page).evaluateAll((ps) => ps.map((p) => p.getAttribute('fill')));
  const boxes = await pins(page).evaluateAll((ps) =>
    ps.map((p) => {
      const r = p.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
  const hidden = boxes.map((b, i) => ({ ...b, fill: fills[i] })).filter(
    (b) =>
      b.x < map.x || b.x > map.x + map.width || b.y < map.y || b.y > map.y + map.height ||
      (b.x >= legend.x && b.x <= legend.x + legend.width && b.y >= legend.y && b.y <= legend.y + legend.height),
  );
  expect(hidden, 'pins outside the map or under the legend').toEqual([]);
});
