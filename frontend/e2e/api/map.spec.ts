/// <reference lib="dom" />
// The callbacks of page.evaluate run in the browser, so they use the DOM types.
/**
 * The map canvas in API mode against the seeded backend: pins (canvas drawings, clustered) match GET
 * /map/boreholes.geojson, the legend counts them by status and by depth class, popups with DETAIL,
 * REVIEW and SOURCE, NOT ON MAP, a rectangle drawn around seeded pins gives the server's result set
 * with exactly those uids, and nothing is ever drawn at 0,0 (FRONTEND.md F9, F10).
 *
 * Seed state needed: the fictional seed (`python -m app.seed`) with plotted and unplotted boreholes.
 * Every expectation is computed from the backend's own answers (GET /boreholes, GET
 * /map/boreholes.geojson), so the spec also holds after other specs changed review states.
 * Writes nothing but result sets (POST /result-sets stores an immutable snapshot).
 *
 * Pins are canvas drawings, not elements: the spec reads the map's data attributes (`data-pins`,
 * `data-pins-in-view`, `data-members`, `data-ready`), the cluster icons and the legend.
 */
import type { Page } from '@playwright/test';
import { DEPTH_CLASSES, DEPTH_NOT_STATED } from '../../src/screens/map/depthClasses';
import {
  API,
  expect,
  expectedStatus,
  mapFeatures,
  openApp,
  openUrl,
  records,
  resultRow,
  STATUS_LABEL,
  test,
  UNPLOTTED_LABEL,
  type WireFeature,
  type WireRecord,
} from './fixtures';

/** The wire key of the final depth's provenance entry. */
const FINAL_DEPTH = 'metadata.borehole_depth_m';

const mapRegion = (page: Page) => page.getByRole('region', { name: 'Borehole map' });
const popup = (page: Page) => page.locator('.leaflet-popup-content');
/** The popup of one borehole (a closed popup fades out for 200 ms, so two can be in the page for a moment). */
const popupOf = (page: Page, uid: string) => popup(page).filter({ has: page.locator(`[data-uid="${uid}"]`) });

/** What the map shows (its data attributes), as numbers. */
async function mapStats(page: Page) {
  const d = await mapRegion(page).evaluate((e) => ({ ...(e as HTMLElement).dataset }));
  return { pins: Number(d.pins), drawn: Number(d.pinsDrawn), inView: Number(d.pinsInView), members: Number(d.members), ready: d.ready === 'true' };
}

/** Waits until the map has added `n` pins to its clustered canvas layer. */
async function mapReady(page: Page, n: number): Promise<void> {
  await expect(mapRegion(page)).toHaveAttribute('data-pins', String(n));
  await expect(mapRegion(page)).toHaveAttribute('data-ready', 'true');
}

/** The legend's rows as [label, count]. */
async function legendRows(page: Page): Promise<[string, number][]> {
  return page
    .getByRole('group', { name: /legend$/ })
    .locator('li')
    .evaluateAll((lis) => lis.map((li) => [li.children[1].textContent ?? '', Number(li.children[2].textContent)] as [string, number]));
}

/** Depth class label of a final depth as the map's config has it (an unknown depth is "not stated"). */
function depthLabel(depth: number | null | undefined): string {
  if (depth == null || !(depth > 0)) return DEPTH_NOT_STATED.label;
  return DEPTH_CLASSES.find((c) => depth > c.min && (c.max == null || depth <= c.max))?.label ?? 'Other depth';
}

/** True when a [lon, lat] lies in [min_lon, min_lat, max_lon, max_lat]. */
const inside = ([lng, lat]: [number, number], [w, s, e, n]: number[]) => lat >= s && lat <= n && (w <= e ? lng >= w && lng <= e : lng >= w || lng <= e);

/**
 * Pixels drawn on the pins' canvas inside a screen rectangle. Leaflet adds the canvas with the first
 * pin drawn on its own: while every pin is inside a cluster there is none, and nothing is drawn.
 */
async function canvasPixelsIn(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<number> {
  return mapRegion(page)
    .locator('.leaflet-pins-pane canvas')
    .evaluateAll((cs, b) => {
      const canvas = cs[0] as HTMLCanvasElement | undefined;
      if (!canvas) return 0;
      const r = canvas.getBoundingClientRect();
      const scale = canvas.width / r.width;
      const x0 = Math.max(0, Math.floor((b.x - r.left) * scale));
      const y0 = Math.max(0, Math.floor((b.y - r.top) * scale));
      const x1 = Math.min(canvas.width, Math.ceil((b.x + b.width - r.left) * scale));
      const y1 = Math.min(canvas.height, Math.ceil((b.y + b.height - r.top) * scale));
      if (x1 <= x0 || y1 <= y0) return 0;
      const { data } = canvas.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n += 1;
      return n;
    }, box);
}

/** Seeded pins that lie together (one project's), with the bbox around them: the target of an area selection. */
function nearbyGroup(features: WireFeature[], all: WireRecord[]): { members: WireFeature[]; centre: [number, number] } {
  const byProject = new Map<string, WireFeature[]>();
  for (const f of features) {
    const project = all.find((r) => r.uid === f.properties.uid)?.metadata.project_name ?? '';
    byProject.set(project, [...(byProject.get(project) ?? []), f]);
  }
  const [members] = [...byProject.values()]
    .filter((g) => {
      const lngs = g.map((f) => f.geometry.coordinates[0]);
      const lats = g.map((f) => f.geometry.coordinates[1]);
      // Close enough to fit a rectangle in the middle of the map at zoom 13.
      return g.length >= 2 && Math.max(...lngs) - Math.min(...lngs) < 0.02 && Math.max(...lats) - Math.min(...lats) < 0.012;
    })
    .sort((a, b) => b.length - a.length);
  expect(members, 'a seeded project with at least two pins close together').toBeTruthy();
  const lngs = members.map((f) => f.geometry.coordinates[0]);
  const lats = members.map((f) => f.geometry.coordinates[1]);
  return { members, centre: [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2] };
}

test('every map feature is a pin on the clustered canvas; the legend counts them by status and by depth class', async ({ page, request }) => {
  const features = await mapFeatures(request);
  const all = await records(request);
  expect(features.length, 'seeded plotted boreholes').toBeGreaterThan(0);
  await openApp(page);
  await mapReady(page, features.length);
  // The first view fits every pin; clusters and single pins together count each pin once.
  const stats = await mapStats(page);
  expect(stats.inView).toBe(features.length);
  const clustered = await mapRegion(page).locator('[data-count]').evaluateAll((els) => els.reduce((a, e) => a + Number(e.getAttribute('data-count')), 0));
  expect(clustered + stats.drawn).toBe(features.length);
  // Canvas drawings, no SVG pins.
  await expect(mapRegion(page).locator('.leaflet-overlay-pane path.leaflet-interactive')).toHaveCount(0);

  const status = await legendRows(page);
  expect(status.map(([label]) => label)).toEqual(['Approved', 'In review', 'Unreviewed', 'Needs attention']);
  for (const [key, label] of Object.entries(STATUS_LABEL)) {
    const n = features.filter((f) => expectedStatus(f.properties) === key).length;
    expect(status.find(([l]) => l === label)?.[1], `legend ${label}`).toBe(n);
  }

  // Colour by depth: one row per configured class plus "Depth not stated", counted from the features' depths.
  await page.getByRole('radio', { name: 'DEPTH' }).check();
  await expect(page.getByRole('group', { name: 'Final depth legend' })).toBeVisible();
  await expect(mapRegion(page)).toHaveAttribute('data-colour-by', 'depth');
  const depth = await legendRows(page);
  const depthOf = (f: WireFeature) => (f.properties as { borehole_depth_m?: number | null }).borehole_depth_m;
  expect(depth.map(([label]) => label)).toEqual([...DEPTH_CLASSES.map((c) => c.label), DEPTH_NOT_STATED.label]);
  for (const [label, count] of depth) {
    expect(count, `depth legend ${label}`).toBe(features.filter((f) => depthLabel(depthOf(f)) === label).length);
  }
  // The records agree with the map layer on every plotted depth (the legend is not made up).
  for (const f of features) {
    const r = all.find((x) => x.uid === f.properties.uid);
    expect(depthLabel(r?.metadata.borehole_depth_m), `depth class of ${f.properties.borehole_id}`).toBe(depthLabel(depthOf(f)));
  }
  await page.getByRole('radio', { name: 'STATUS' }).check();
  await expect(page.getByRole('group', { name: 'Review status legend' })).toBeVisible();
});

test('NOT ON MAP lists exactly the unplotted boreholes with the reason label; none of them is a pin', async ({ page, request }) => {
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
    expect(features.some((f) => f.properties.uid === r.uid), `${r.metadata.borehole_id} is not in the map layer`).toBe(false);
  }
  // The pins are exactly the map layer's features: no unplotted borehole is drawn anywhere.
  await mapReady(page, features.length);
});

test('nothing is drawn at 0,0: the view there holds exactly the pins the server placed near it', async ({ page, request }) => {
  const features = await mapFeatures(request);
  const near = features.filter((f) => Math.abs(f.geometry.coordinates[0]) < 40 && Math.abs(f.geometry.coordinates[1]) < 30);
  test.skip(near.length > 0, 'the seed places boreholes near 0,0: this check needs a seed without them');
  await openUrl(page, '/map?at=0,0,5');
  await mapReady(page, features.length);
  await expect(mapRegion(page)).toHaveAttribute('data-pins-in-view', '0');
  // markercluster keeps clusters just outside the view in the page (for panning): none is inside the map.
  const map = (await mapRegion(page).boundingBox())!;
  const shown = await mapRegion(page)
    .locator('[data-count]')
    .evaluateAll((els, m) => els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.right > m.x && r.left < m.x + m.width && r.bottom > m.y && r.top < m.y + m.height;
    }).length, map);
  expect(shown, 'clusters inside the map at 0,0').toBe(0);
  expect(await canvasPixelsIn(page, map), 'pins drawn at 0,0').toBe(0);
});

test('search flies to each plotted borehole; its popup shows ID, project, depth and status; REVIEW, SOURCE and DETAIL act', async ({ page, request }) => {
  test.setTimeout(90_000);
  const features = await mapFeatures(request);
  const all = await records(request);
  await openApp(page);
  const search = page.getByRole('textbox', { name: 'Search project or borehole ID' });
  for (const f of features) {
    const r = all.find((x) => x.uid === f.properties.uid);
    expect(r, `record of map feature ${f.properties.borehole_id}`).toBeTruthy();
    const id = f.properties.borehole_id;
    await search.fill(id);
    await search.press('Enter');
    const p = popupOf(page, f.properties.uid);
    await expect(p.getByRole('button', { name: `Open detail of ${id}`, exact: true })).toBeVisible();
    await expect(p).toContainText(r!.metadata.project_name ?? '');
    const depth = r!.metadata.borehole_depth_m;
    await expect(p).toContainText(depth != null && depth > 0 ? `Final depth ${depth.toFixed(2)} m` : 'Depth not stated');
    await expect(p).toContainText(STATUS_LABEL[expectedStatus(f.properties)]);
    // REVIEW and SOURCE follow the record (loaded when the popup opened).
    const reviewable = !!r!.document_id && Object.values(r!.provenance).some((p) => p.page != null || p.cell != null);
    const d = r!.provenance[FINAL_DEPTH];
    const hasSource = !!d && (d.page != null || d.cell != null);
    const review = p.getByRole('button', { name: `Review ${id}`, exact: true });
    const source = p.getByRole('button', { name: `Source of the final depth of ${id}`, exact: true });
    await expect(review).toBeEnabled({ enabled: reviewable });
    await expect(source).toBeEnabled({ enabled: hasSource });
  }
  // SOURCE of the last popup opens the final depth's Source panel on the map screen; DETAIL opens Detail.
  const lastFeature = features[features.length - 1].properties;
  const last = lastFeature.borehole_id;
  const lastPopup = popupOf(page, lastFeature.uid);
  const source = lastPopup.getByRole('button', { name: `Source of the final depth of ${last}`, exact: true });
  if (await source.isEnabled()) {
    await source.click();
    await expect(page.getByRole('dialog', { name: 'Source' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/map');
    await page.getByRole('button', { name: 'Close panel' }).click();
  }
  await lastPopup.getByRole('button', { name: `Open detail of ${last}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: last, exact: true })).toBeVisible();
});

test('a rectangle drawn around seeded pins gives the server’s result set with exactly the pins inside it', async ({ page, request }) => {
  const features = await mapFeatures(request);
  const all = await records(request);
  const { members, centre } = nearbyGroup(features, all);
  await openUrl(page, `/map?at=${centre[1].toFixed(5)},${centre[0].toFixed(5)},13`);
  await mapReady(page, features.length);

  const box = (await mapRegion(page).boundingBox())!;
  const created = page.waitForResponse((res) => new URL(res.url()).pathname === `${API}/result-sets` && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Select by rectangle' }).click();
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.2);
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.7, { steps: 4 });
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.7);
  const res = await created;
  expect(res.status()).toBe(201);
  const sent = JSON.parse(res.request().postData() ?? '{}') as { area?: { type: string; bbox: number[] } };
  const rs = (await res.json()) as { result_set_id: string; uids: string[]; located_count: number };

  // The area sent is the rectangle as drawn: a bbox [min_lon, min_lat, max_lon, max_lat] around the group, never 0,0.
  expect(sent.area?.type).toBe('bbox');
  const bbox = sent.area!.bbox;
  expect(bbox).toHaveLength(4);
  expect(bbox[0]).toBeLessThan(bbox[2]);
  expect(bbox[1]).toBeLessThan(bbox[3]);
  expect(bbox.every((x) => x !== 0)).toBe(true);
  for (const f of members) expect(inside(f.geometry.coordinates, bbox), `${f.properties.borehole_id} inside the drawn rectangle`).toBe(true);
  // The server's members are exactly the pins inside it, none of the unplotted ones.
  const expected = features.filter((f) => inside(f.geometry.coordinates, bbox)).map((f) => f.properties.uid);
  expect([...rs.uids].sort()).toEqual([...expected].sort());
  expect(rs.located_count).toBe(expected.length);

  // The set is shown: its id in the URL, its members highlighted (the others dimmed but drawn), the area stays, the legend counts the set.
  await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toBe(rs.result_set_id);
  await expect(mapRegion(page)).toHaveAttribute('data-members', String(expected.length));
  await expect(mapRegion(page)).toHaveAttribute('data-pins', String(features.length));
  await expect(mapRegion(page).locator('[data-map-shape="area"]')).toHaveCount(1);
  await expect(page.getByRole('group', { name: /legend$/ })).toContainText('SELECTION');
  expect((await legendRows(page)).reduce((a, [, n]) => a + n, 0)).toBe(expected.length);

  // Removing the area resets: no set, no highlight, no area.
  await page.getByRole('button', { name: 'Remove the selected area' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('rs')).toBeNull();
  await expect(mapRegion(page)).toHaveAttribute('data-members', '0');
  await expect(mapRegion(page).locator('[data-map-shape="area"]')).toHaveCount(0);
});

test('a shared link to an area’s result set flies to its members, highlights them and draws the area', async ({ page, request }) => {
  const features = await mapFeatures(request);
  const all = await records(request);
  const { members, centre } = nearbyGroup(features, all);
  const area = { type: 'bbox', bbox: [centre[0] - 0.02, centre[1] - 0.012, centre[0] + 0.02, centre[1] + 0.012] };
  const res = await request.post(`${API}/result-sets`, { data: { include_unreviewed: true, area } });
  expect(res.status()).toBe(201);
  const rs = (await res.json()) as { result_set_id: string; uids: string[] };
  for (const f of members) expect(rs.uids, `${f.properties.borehole_id} in the set`).toContain(f.properties.uid);

  // No view in the link: the map fits the set's members (48 px padding) instead of the world's pins.
  await openUrl(page, `/map?rs=${encodeURIComponent(rs.result_set_id)}`);
  await mapReady(page, features.length);
  await expect(mapRegion(page)).toHaveAttribute('data-members', String(rs.uids.length));
  await expect(mapRegion(page).locator('[data-map-shape="area"]')).toHaveCount(1);
  await expect.poll(async () => Number(new URL(page.url()).searchParams.get('at')?.split(',')[2])).toBeGreaterThanOrEqual(12);
  const stats = await mapStats(page);
  expect(stats.inView, 'the members are in view').toBeGreaterThanOrEqual(members.length);
  expect(stats.inView, 'the view is the set, not the world').toBeLessThan(features.length);
  expect(new URL(page.url()).searchParams.get('rs')).toBe(rs.result_set_id);
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
    await expect(popup(page)).toHaveCount(0);
  }
});

test('RESULTS lists every borehole once; a row and a NOT ON MAP item open the borehole detail', async ({ page, request }) => {
  const all = await records(request);
  const [plotted] = all.filter((r) => r.plotted);
  const [unplotted] = await records(request, '?plotted=false');
  await openApp(page);
  for (const r of all) await expect(page.locator(`[role="table"] [role="row"][data-uid="${r.uid}"]`), `row of ${r.metadata.borehole_id}`).toHaveCount(1);
  await resultRow(page, plotted.metadata.borehole_id).click();
  await expect(page.getByRole('heading', { level: 1, name: plotted.metadata.borehole_id, exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/boreholes/${plotted.uid}$`));
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Map' }).click();
  await expect(page).toHaveURL(/\/map(\?|$)/);
  await page.locator(`aside button[data-uid="${unplotted.uid}"]`).click();
  await expect(page.getByRole('heading', { level: 1, name: unplotted.metadata.borehole_id, exact: true })).toBeVisible();
  await expect(page.getByLabel('Metadata')).toContainText(`${UNPLOTTED_LABEL[unplotted.unplotted_reason ?? '']}: not on the map`);
});

test('FE-MAP-1: the first view shows every pin inside the map, none hidden under the legend', async ({ page, request }) => {
  const features = await mapFeatures(request);
  await openApp(page);
  await mapReady(page, features.length);
  expect((await mapStats(page)).inView).toBe(features.length);
  const map = (await mapRegion(page).boundingBox())!;
  const legend = (await page.getByRole('group', { name: 'Review status legend' }).boundingBox())!;
  const icons = await mapRegion(page)
    .locator('[data-count]')
    .evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );
  const hidden = icons.filter(
    (b) =>
      b.x < map.x || b.x > map.x + map.width || b.y < map.y || b.y > map.y + map.height ||
      (b.x >= legend.x && b.x <= legend.x + legend.width && b.y >= legend.y && b.y <= legend.y + legend.height),
  );
  expect(hidden, 'clusters outside the map or under the legend').toEqual([]);
  expect(await canvasPixelsIn(page, legend), 'pins drawn under the legend').toBe(0);
});
