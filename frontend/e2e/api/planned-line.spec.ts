/// <reference lib="dom" />
/**
 * PLANNED LINE in API mode (contract 1.3.0): the fictional sample line (docs/samples/planned-line)
 * uploaded on the map shows the line and its band; the boreholes within 100 m are listed by chainage,
 * approved ones only until "Include unreviewed" is on; a wider distance adds the borehole just
 * outside; a line drawn on the map is uploaded the same way.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`). The sample line passes KB-1 (in
 * review, about 40 m left of the line), KB-3 (unreviewed, about 73 m right) and KB-2 (unreviewed,
 * about 135 m left, just outside 100 m); no approved borehole is near it.
 *
 * Restore: every line the spec uploads is deleted again (DELETE /alignments/{id}).
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { API, expect, getJson, openUrl, test } from './fixtures';

const SAMPLE = fileURLToPath(new URL('../../../docs/samples/planned-line/planned-line.geojson', import.meta.url));
const SAMPLE_NAME = 'Fictional tunnel alignment T1 (sample)';

const mapRegion = (page: Page) => page.getByRole('region', { name: 'Borehole map' });
const panel = (page: Page) => page.getByRole('region', { name: 'Planned line' });
const table = (page: Page) => panel(page).getByRole('table', { name: 'Boreholes along the line' });
const rows = (page: Page) => table(page).locator('tbody tr');

/** The ids of the lines stored now. */
async function lineIds(api: APIRequestContext): Promise<string[]> {
  return (await getJson<{ alignments: { alignment_id: string }[] }>(api, '/alignments')).alignments.map((a) => a.alignment_id);
}

/** Deletes the lines stored since `before`. */
async function removeNew(api: APIRequestContext, before: string[]): Promise<void> {
  for (const id of await lineIds(api)) if (!before.includes(id)) await api.delete(`${API}/alignments/${id}`);
}

async function openPanel(page: Page): Promise<void> {
  await openUrl(page, '/map');
  await expect(mapRegion(page)).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
  await page.getByRole('button', { name: 'PLANNED LINE' }).click();
  await expect(panel(page)).toBeVisible();
}

test('the sample line: line and band on the map, hits by chainage, Include unreviewed and a wider distance', async ({ page, request, apiLog }) => {
  test.setTimeout(60_000);
  const before = await lineIds(request);
  try {
    await openPanel(page);
    const query = page.waitForResponse((r) => r.url().endsWith('/query') && r.request().method() === 'POST');
    await panel(page).getByTestId('planned-line-input').setInputFiles(SAMPLE);
    expect((await query).status()).toBe(200);

    // The line and its band are drawn; the panel names the line.
    await expect(page.locator('path[data-map-shape="alignment"]')).toHaveCount(1);
    await expect(page.locator('path[data-map-shape="alignment-band"]')).toHaveCount(1);
    await expect(mapRegion(page)).toHaveAttribute('data-alignment', /^aln_/);
    await expect(panel(page)).toContainText(SAMPLE_NAME);
    await expect(panel(page)).toContainText('1.43 km');

    // Approved only (the default): nothing within 100 m, two unreviewed ones hidden.
    await expect(panel(page).getByTestId('planned-line-empty')).toHaveText('No boreholes within 100 m');
    await expect(panel(page).getByTestId('planned-line-hidden')).toContainText('2 unreviewed boreholes inside the band are hidden');
    const upload = apiLog.find((c) => c.method === 'POST' && c.url.endsWith('/alignments'));
    expect(upload?.status).toBe(201);
    const firstQuery = apiLog.find((c) => c.url.endsWith('/query'));
    expect(JSON.parse(firstQuery?.requestBody ?? '{}')).toEqual({ buffer_m: 100, include_unreviewed: false });

    // Include unreviewed: KB-1 (left) then KB-3 (right), KB-2 is just outside.
    const unreviewed = page.waitForResponse((r) => r.url().endsWith('/query'));
    await panel(page).getByRole('switch').click();
    await unreviewed;
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(0)).toContainText('KB-1');
    await expect(rows(page).nth(0)).toContainText('589 m');
    await expect(rows(page).nth(0)).toContainText('39.8 m');
    await expect(rows(page).nth(0)).toContainText('Left');
    await expect(rows(page).nth(1)).toContainText('KB-3');
    await expect(rows(page).nth(1)).toContainText('987 m');
    await expect(rows(page).nth(1)).toContainText('Right');
    await expect(table(page)).not.toContainText('KB-2');
    // The hits are the active result set: their pins are highlighted.
    await expect(mapRegion(page)).toHaveAttribute('data-members', '2');
    await expect(page.getByTestId('planned-line-hidden')).toHaveCount(0);

    // A row shows its borehole on the map (its popup opens).
    await rows(page).nth(1).click();
    await expect(page.locator('.leaflet-popup-content')).toContainText('KB-3');

    // 150 m: KB-2 comes in between.
    const wider = page.waitForResponse((r) => r.url().endsWith('/query'));
    await panel(page).getByTestId('planned-line-buffer').fill('150');
    await panel(page).getByTestId('planned-line-buffer').press('Enter');
    expect(JSON.parse((await wider).request().postData() ?? '{}')).toEqual({ buffer_m: 150, include_unreviewed: true });
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(0)).toContainText('KB-1');
    await expect(rows(page).nth(1)).toContainText('KB-2');
    await expect(rows(page).nth(1)).toContainText('790 m');
    await expect(rows(page).nth(2)).toContainText('KB-3');

    // CLEAR takes the line off the map; it stays among the earlier lines and opens again.
    await panel(page).getByRole('button', { name: 'CLEAR', exact: true }).click();
    await expect(page.locator('path[data-map-shape="alignment"]')).toHaveCount(0);
    const earlier = panel(page).getByRole('list', { name: 'Earlier lines' });
    await expect(earlier).toContainText(SAMPLE_NAME);
    await earlier.getByRole('button', { name: 'SHOW' }).first().click();
    await expect(page.locator('path[data-map-shape="alignment"]')).toHaveCount(1);
    await expect(rows(page)).toHaveCount(2); // the line's own distance (100 m) again

    // DELETE LINE removes it on the server.
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE');
    await panel(page).getByRole('button', { name: 'DELETE LINE', exact: true }).click();
    expect((await del).status()).toBe(204);
    await expect(page.locator('path[data-map-shape="alignment"]')).toHaveCount(0);
  } finally {
    await removeNew(request, before);
  }
});

test('a line drawn on the map is uploaded as drawn-line.geojson and listed like a file', async ({ page, request }) => {
  test.setTimeout(60_000);
  const before = await lineIds(request);
  try {
    await openUrl(page, '/map?at=50.2095,9.423,15');
    await expect(mapRegion(page)).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
    await page.getByRole('button', { name: 'PLANNED LINE' }).click();
    await panel(page).getByRole('button', { name: 'DRAW LINE' }).click();
    await expect(panel(page).getByRole('status')).toContainText('double-click or press Enter to finish');
    // Close the panel so the map is free to click; the drawing mode stays on.
    await panel(page).getByRole('button', { name: 'CLOSE' }).click();
    const box = (await mapRegion(page).boundingBox())!;
    const y = box.y + box.height / 2;
    const upload = page.waitForResponse((r) => r.url().endsWith('/alignments') && r.request().method() === 'POST');
    await page.mouse.click(box.x + box.width * 0.3, y);
    await page.mouse.click(box.x + box.width * 0.5, y - 40);
    await page.mouse.dblclick(box.x + box.width * 0.7, y);
    const answer = await upload;
    expect(answer.status()).toBe(201);
    const stored = (await answer.json()) as { name: string; file_name: string; format: string; vertex_count: number };
    expect(stored).toMatchObject({ name: 'Drawn line', file_name: 'drawn-line.geojson', format: 'geojson' });
    expect(stored.vertex_count).toBeGreaterThanOrEqual(3);
    await expect(page.locator('path[data-map-shape="alignment"]')).toHaveCount(1);
    await expect(page.locator('path[data-map-shape="alignment-band"]')).toHaveCount(1);
  } finally {
    await removeNew(request, before);
  }
});
