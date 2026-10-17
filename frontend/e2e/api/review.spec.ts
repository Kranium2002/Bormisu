/**
 * Review in API mode: approve, reset, edit, flag, set state, the X / Y and CRS rows, readings and
 * revision conflicts, each checked after a reload against the backend.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`) with a plotted borehole whose CRS is
 * stated and that has provenance entries for borehole_depth_m, drilling_method,
 * surface_elevation_mASL, local_x / local_y and coordinate_system, plus one value with two readings
 * (in the seed: KB-2). The spec picks it from GET /boreholes.
 *
 * Every test puts back what it changed: through the UI (undo, edit back), and again through the API
 * in `finally` when a step failed. Not restorable: an edited value keeps method "edited" on the
 * backend (its value and AI value are equal again, so nothing is struck through); reseed for a
 * pristine record (`python -m app.seed --remove && python -m app.seed`).
 */
import type { APIRequestContext, Page } from '@playwright/test';
import {
  ensureUnreviewed,
  expect,
  fieldRow,
  openApp,
  openReview,
  patchesDuring,
  patchValue,
  record,
  records,
  reload,
  test,
  type WireRecord,
} from './fixtures';

const PATHS = {
  depth: 'metadata.borehole_depth_m',
  method: 'metadata.drilling_method',
  elevation: 'metadata.surface_elevation_mASL',
  x: 'metadata.coordinates.local_x',
  y: 'metadata.coordinates.local_y',
  crs: 'metadata.coordinates.coordinate_system',
  contractor: 'metadata.drilling_contractor',
} as const;

/** The seeded borehole this spec reviews (KB-2 in the fictional seed). */
async function target(api: APIRequestContext): Promise<WireRecord> {
  const hit = (await records(api)).find(
    (r) =>
      r.plotted &&
      r.crs_status === 'stated' &&
      Object.values(PATHS).every((p) => r.provenance[p]) &&
      Object.values(r.provenance).some((p) => p.readings.length > 1),
  );
  expect(hit, 'a seeded borehole with the review fields and a value with two readings').toBeTruthy();
  return hit!;
}

/** Reloads the app: the URL keeps the borehole in Review (F4), with the values as the server holds them. */
async function reopen(page: Page, id: string): Promise<void> {
  await reload(page);
  await expect(page.getByRole('heading', { level: 1, name: `REVIEW · ${id}` })).toBeVisible();
}

const approveBtn = (page: Page, label: string) => page.getByRole('button', { name: `Approve ${label}`, exact: true });
const flagBtn = (page: Page, label: string) => page.getByRole('button', { name: `Flag ${label}`, exact: true });

/** "7 of 43 values reviewed" → 7. */
async function reviewedCount(page: Page): Promise<number> {
  const text = (await page.getByText(/^\d+ of \d+ values reviewed$/).textContent()) ?? '';
  return Number(/^(\d+)/.exec(text)?.[1] ?? NaN);
}

test('approve a value, reload: still approved; undo it (reset), reload: unreviewed again', async ({ page, request }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  await ensureUnreviewed(request, r.uid, PATHS.depth);
  try {
    await openApp(page);
    await openReview(page, id);
    // The scanned source page of the focused value loads from the backend.
    const scan = page.getByLabel('Source page').locator('img');
    await expect(scan).toHaveAttribute('src', new RegExp(`/api/v1/documents/${r.document_id}/pages/\\d+\\.png\\?w=1400$`));
    await expect.poll(() => scan.evaluate((el) => { const img = el as unknown as { complete: boolean; naturalWidth: number }; return img.complete && img.naturalWidth > 0; })).toBe(true);

    const before = await reviewedCount(page);
    const btn = approveBtn(page, 'Final depth');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    const [approve] = await patchesDuring(page, r.uid, 1, () => btn.click());
    expect(approve).toEqual({ path: PATHS.depth, action: 'approve', if_revision: (await record(request, r.uid)).revision - 1 });
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => reviewedCount(page)).toBe(before + 1);

    await reopen(page, id);
    await expect(approveBtn(page, 'Final depth')).toHaveAttribute('aria-pressed', 'true');
    expect((await record(request, r.uid)).provenance[PATHS.depth].status).toBe('approved');

    const [reset] = await patchesDuring(page, r.uid, 1, () => approveBtn(page, 'Final depth').click());
    expect(reset).toMatchObject({ path: PATHS.depth, action: 'reset' });
    await reopen(page, id);
    await expect(approveBtn(page, 'Final depth')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => reviewedCount(page)).toBe(before);
    expect((await record(request, r.uid)).provenance[PATHS.depth].status).toBe('unreviewed');
  } finally {
    await ensureUnreviewed(request, r.uid, PATHS.depth);
  }
});

test('edit a value, reload: the edit and the struck-through AI value persist; edit back and undo', async ({ page, request }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  const ai = r.provenance[PATHS.elevation].ai_value as number;
  expect(typeof ai).toBe('number');
  const restore = async () => {
    const now = await record(request, r.uid);
    if (valueAt(now, PATHS.elevation) !== ai) await patchValue(request, r.uid, { path: PATHS.elevation, action: 'edit', value: ai });
    await ensureUnreviewed(request, r.uid, PATHS.elevation);
  };
  await restore();
  const edited = Math.round((ai + 0.05) * 100) / 100;
  try {
    await openApp(page);
    await openReview(page, id);
    const row = fieldRow(page, 'SurfaceElevation');
    await page.getByRole('button', { name: 'Edit Surface elevation', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Corrected value for Surface elevation' });
    await expect(input).toHaveValue(ai.toFixed(2));
    const bodies = await patchesDuring(page, r.uid, 2, async () => {
      await input.fill(edited.toFixed(2));
      await input.press('Enter');
    });
    // An edit is saved as the new value, then approved (the reviewer typed what the source says).
    expect(bodies.map((b) => [b.path, b.action, b.value])).toEqual([
      [PATHS.elevation, 'edit', edited],
      [PATHS.elevation, 'approve', undefined],
    ]);
    await expect(row).toContainText(`${edited.toFixed(2)} m`);
    await expect(row.locator('s')).toHaveText(ai.toFixed(2));
    await expect(row).toContainText('(AI value)');

    await reopen(page, id);
    const after = fieldRow(page, 'SurfaceElevation');
    await expect(after).toContainText(`${edited.toFixed(2)} m`);
    await expect(after.locator('s')).toHaveText(ai.toFixed(2));
    await expect(after).toContainText('Edited');
    await expect(approveBtn(page, 'Surface elevation')).toHaveAttribute('aria-pressed', 'true');
    const p = (await record(request, r.uid)).provenance[PATHS.elevation];
    expect({ method: p.method, status: p.status, ai: p.ai_value }).toEqual({ method: 'edited', status: 'approved', ai });

    // Edit back to the AI value, then undo the approval.
    await page.getByRole('button', { name: 'Edit Surface elevation', exact: true }).click();
    await patchesDuring(page, r.uid, 2, async () => {
      await input.fill(ai.toFixed(2));
      await input.press('Enter');
    });
    await patchesDuring(page, r.uid, 1, () => approveBtn(page, 'Surface elevation').click());
    await reopen(page, id);
    await expect(fieldRow(page, 'SurfaceElevation')).toContainText(`${ai.toFixed(2)} m`);
    await expect(fieldRow(page, 'SurfaceElevation').locator('s')).toHaveCount(0);
    await expect(approveBtn(page, 'Surface elevation')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await restore();
  }
});

/** The wire value at a simple dotted path of a record. */
function valueAt(rec: WireRecord, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined), rec);
}

test('flag with a reason and unflag, each persisting across a reload', async ({ page, request }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  const reason = 'e2e: compare with the log header';
  await ensureUnreviewed(request, r.uid, PATHS.method);
  try {
    await openApp(page);
    await openReview(page, id);
    await flagBtn(page, 'Drilling method').click();
    const input = page.getByRole('textbox', { name: 'Flag reason for Drilling method' });
    const [flag] = await patchesDuring(page, r.uid, 1, async () => {
      await input.fill(reason);
      await input.press('Enter');
    });
    expect(flag).toMatchObject({ path: PATHS.method, action: 'flag', reason });
    await expect(fieldRow(page, 'DrillingMethod')).toContainText(`⚑ Flagged: ${reason}`);

    await reopen(page, id);
    await expect(flagBtn(page, 'Drilling method')).toHaveAttribute('aria-pressed', 'true');
    await expect(fieldRow(page, 'DrillingMethod')).toContainText(`⚑ Flagged: ${reason}`);
    expect((await record(request, r.uid)).provenance[PATHS.method]).toMatchObject({ status: 'flagged', flag: reason });

    const [unflag] = await patchesDuring(page, r.uid, 1, () => flagBtn(page, 'Drilling method').click());
    expect(unflag).toMatchObject({ path: PATHS.method, action: 'reset' });
    await reopen(page, id);
    await expect(flagBtn(page, 'Drilling method')).toHaveAttribute('aria-pressed', 'false');
    await expect(fieldRow(page, 'DrillingMethod')).not.toContainText('Flagged');
    expect((await record(request, r.uid)).provenance[PATHS.method]).toMatchObject({ status: 'unreviewed', flag: null });
  } finally {
    await ensureUnreviewed(request, r.uid, PATHS.method);
  }
});

test('"Not in source" sets the state and approves; pressing it again goes back to ok and unreviewed', async ({ page, request }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  await ensureUnreviewed(request, r.uid, PATHS.method);
  try {
    await openApp(page);
    await openReview(page, id);
    await fieldRow(page, 'DrillingMethod').click({ position: { x: 12, y: 12 } });
    const btn = fieldRow(page, 'DrillingMethod').getByRole('button', { name: 'Not in source' });
    const set = await patchesDuring(page, r.uid, 2, () => btn.click());
    expect(set.map((b) => [b.action, b.state])).toEqual([['set_state', 'not_in_source'], ['approve', undefined]]);
    await reopen(page, id);
    await expect(fieldRow(page, 'DrillingMethod')).toContainText('not in source');
    expect((await record(request, r.uid)).provenance[PATHS.method]).toMatchObject({ state: 'not_in_source', status: 'approved' });

    await fieldRow(page, 'DrillingMethod').click({ position: { x: 12, y: 12 } });
    const back = await patchesDuring(page, r.uid, 2, () =>
      fieldRow(page, 'DrillingMethod').getByRole('button', { name: 'Not in source' }).click(),
    );
    expect(back.map((b) => [b.action, b.state])).toEqual([['set_state', 'ok'], ['reset', undefined]]);
    await reopen(page, id);
    expect((await record(request, r.uid)).provenance[PATHS.method]).toMatchObject({ state: 'ok', status: 'unreviewed' });
    await expect(approveBtn(page, 'Drilling method')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await ensureUnreviewed(request, r.uid, PATHS.method);
  }
});

test('X / Y row shows the converted pair and the coordinates as printed; approving it approves both paths', async ({ page, request }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  const c = r.metadata.coordinates;
  await ensureUnreviewed(request, r.uid, PATHS.x);
  await ensureUnreviewed(request, r.uid, PATHS.y);
  try {
    await openApp(page);
    await openReview(page, id);
    const xy = fieldRow(page, 'XY');
    await expect(xy).toContainText(`${c.local_x} / ${c.local_y}`);
    await expect(xy).toContainText(`“${c.x_raw} / ${c.y_raw}”`);
    await expect(xy).toContainText(`as printed: ${c.x_raw} / ${c.y_raw}${c.axis_labels_raw ? ` (${c.axis_labels_raw})` : ''}`);

    const bodies = await patchesDuring(page, r.uid, 2, () => approveBtn(page, 'X / Y').click());
    expect(bodies.map((b) => [b.path, b.action]).sort()).toEqual([
      [PATHS.x, 'approve'],
      [PATHS.y, 'approve'],
    ]);
    await reopen(page, id);
    await expect(approveBtn(page, 'X / Y')).toHaveAttribute('aria-pressed', 'true');
    const after = await record(request, r.uid);
    expect([after.provenance[PATHS.x].status, after.provenance[PATHS.y].status]).toEqual(['approved', 'approved']);

    await patchesDuring(page, r.uid, 2, () => approveBtn(page, 'X / Y').click());
    await reopen(page, id);
    await expect(approveBtn(page, 'X / Y')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await ensureUnreviewed(request, r.uid, PATHS.x);
    await ensureUnreviewed(request, r.uid, PATHS.y);
  }
});

test('CRS row shows the stated system and CHOOSE CRS… opens the dialog with the server candidates', async ({ page, request }) => {
  const r = await target(request);
  const candidates = (await (await request.get(`/api/v1/documents/${r.document_id}/crs-candidates`)).json()) as { label: string; crs: string }[];
  await openApp(page);
  await openReview(page, r.metadata.borehole_id);
  const crs = fieldRow(page, 'CoordinateSystem');
  await expect(crs).toContainText(r.metadata.coordinates.coordinate_system!);
  await crs.click({ position: { x: 12, y: 12 } });
  await crs.getByRole('button', { name: 'CHOOSE CRS…' }).click();
  const dialog = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
  await expect(dialog.getByRole('radio')).toHaveCount(candidates.length);
  for (const [i, cand] of candidates.entries()) {
    await expect(dialog.getByRole('radio').nth(i)).toContainText(cand.label);
    await expect(dialog.getByRole('radio').nth(i)).toContainText(cand.crs);
  }
  // Closing changes nothing.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await record(request, r.uid)).crs_status).toBe('stated');
});

test('a value with two readings shows them side by side', async ({ page, request }) => {
  const r = await target(request);
  const [path, prov] = Object.entries(r.provenance).find(([, p]) => p.readings.length > 1)!;
  const layer = /^stratigraphy\[(\d+)\]\.spt_n_value$/.exec(path);
  expect(layer, `readings on an SPT N value (${path})`).toBeTruthy();
  await openApp(page);
  await openReview(page, r.metadata.borehole_id);
  const readings = fieldRow(page, `layer[${Number(layer![1]) + 1}].spt`).getByLabel(/^Readings of /);
  for (const rd of prov.readings) {
    const conf = rd.confidence != null ? ` · ${Math.round(rd.confidence * 100)} %` : '';
    await expect(readings).toContainText(`${rd.reader}: “${rd.text}”${conf}`);
  }
});

test('Larger source view opens the page image at the value’s box with the raw text', async ({ page, request }) => {
  const r = await target(request);
  const prov = r.provenance[PATHS.depth];
  expect(prov.page != null && prov.box != null, 'the final depth has a page and a box').toBe(true);
  await openApp(page);
  await openReview(page, r.metadata.borehole_id);
  await fieldRow(page, 'BoreholeDepth').click({ position: { x: 12, y: 12 } });
  await fieldRow(page, 'BoreholeDepth').getByRole('button', { name: 'Larger source view' }).click();
  const panel = page.getByRole('dialog', { name: 'Source' });
  await expect(panel).toContainText('SOURCE · FINAL DEPTH');
  await expect(panel).toContainText(`page ${prov.page} · ${r.source_file}`);
  await expect(panel).toContainText(`as printed: “${prov.raw}”`);
  const img = panel.locator('img');
  await expect(img).toHaveAttribute('src', new RegExp(`/documents/${r.document_id}/pages/${prov.page}\\.png`));
  await expect.poll(() => img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
  // The highlighted box sits where the provenance box says (normalised 0..1 → percent).
  const [x, y] = prov.box!;
  const box = panel.locator('[title="Final depth"]');
  await expect(box).toHaveAttribute('style', new RegExp(`left: ${+(x * 100).toFixed(2)}[0-9]*%; top: ${+(y * 100).toFixed(2)}[0-9]*%`));
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('a change made elsewhere arrives live: the record moves on and the next save carries the new revision', async ({ page, request }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  await ensureUnreviewed(request, r.uid, PATHS.depth);
  await ensureUnreviewed(request, r.uid, PATHS.contractor);
  try {
    await openApp(page);
    await openReview(page, id);
    await expect(approveBtn(page, 'Drilling contractor')).toHaveAttribute('aria-pressed', 'false');
    // Someone else approves another value: the event stream brings the new revision without a reload.
    await patchValue(request, r.uid, { path: PATHS.contractor, action: 'approve' });
    await expect(approveBtn(page, 'Drilling contractor')).toHaveAttribute('aria-pressed', 'true');
    const revision = (await record(request, r.uid)).revision;
    const [approve] = await patchesDuring(page, r.uid, 1, () => approveBtn(page, 'Final depth').click());
    expect(approve).toEqual({ path: PATHS.depth, action: 'approve', if_revision: revision });
    await expect(approveBtn(page, 'Final depth')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await ensureUnreviewed(request, r.uid, PATHS.depth);
    await ensureUnreviewed(request, r.uid, PATHS.contractor);
  }
});

test('a change made elsewhere that the app has not heard of: the save answers 409, the newer record is shown and nothing is lost silently', async ({ page, request, errors }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  await ensureUnreviewed(request, r.uid, PATHS.depth);
  await ensureUnreviewed(request, r.uid, PATHS.contractor);
  // The event stream stays silent (it would deliver the other change before the click).
  await page.route(
    (url) => url.pathname === '/api/v1/events',
    (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: ['retry: 60000', ': held silent by this test', '', ''].join('\n'),
      }),
  );
  try {
    await openApp(page);
    await openReview(page, id);
    // Someone else approves another value: the record moves on one revision.
    await patchValue(request, r.uid, { path: PATHS.contractor, action: 'approve' });
    const conflict = page.waitForResponse((res) => res.request().method() === 'PATCH' && res.status() === 409);
    await approveBtn(page, 'Final depth').click();
    expect(await (await conflict).json()).toMatchObject({ code: 'revision_conflict' });
    await expect(page.getByRole('status').filter({ hasText: 'This borehole was changed elsewhere' })).toBeVisible();
    await expect(approveBtn(page, 'Final depth')).toHaveAttribute('aria-pressed', 'false');
    await expect(approveBtn(page, 'Drilling contractor')).toHaveAttribute('aria-pressed', 'true');
    // Chrome logs the 409 as a failed resource load; that one is expected here.
    const expected = errors.filter((e) => /status of 409/.test(e));
    expect(expected).toHaveLength(1);
    errors.splice(errors.indexOf(expected[0]), 1);
  } finally {
    await ensureUnreviewed(request, r.uid, PATHS.depth);
    await ensureUnreviewed(request, r.uid, PATHS.contractor);
  }
});

test('FE-PROV-1: the Lithology row of a layer can be approved (its source is original_description)', async ({ page, request }) => {
  const r = await target(request);
  expect(r.provenance['stratigraphy[0].original_description'], 'the backend tracks layer 1 at original_description').toBeTruthy();
  await openApp(page);
  await openReview(page, r.metadata.borehole_id);
  const lith = fieldRow(page, 'layer[1].lithology');
  await expect(lith.getByRole('button', { name: 'Approve Lithology', exact: true })).toBeEnabled();
  await expect(lith.getByRole('button', { name: 'Flag Lithology', exact: true })).toBeEnabled();
  // The row shows the English text but stands for the printed description: an edit would overwrite it.
  if (!r.provenance['stratigraphy[0].english_lithology'] && r.stratigraphy[0].english_lithology) {
    const edit = lith.getByRole('button', { name: 'Edit Lithology', exact: true });
    await expect(edit).toBeDisabled();
    await expect(edit).toHaveAttribute('title', /would overwrite the printed text/);
  }
});

test('two approvals clicked straight after each other both reach the server (saves chain their revisions)', async ({ page, request }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  for (const p of [PATHS.depth, PATHS.method]) await ensureUnreviewed(request, r.uid, p);
  try {
    await openApp(page);
    await openReview(page, id);
    const bodies = await patchesDuring(page, r.uid, 2, async () => {
      await approveBtn(page, 'Final depth').click();
      await approveBtn(page, 'Drilling method').click();
    });
    // The second PATCH carries the revision the first one produced.
    expect((bodies[1].if_revision as number) - (bodies[0].if_revision as number)).toBe(1);
    await reopen(page, id);
    await expect(approveBtn(page, 'Final depth')).toHaveAttribute('aria-pressed', 'true');
    await expect(approveBtn(page, 'Drilling method')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    for (const p of [PATHS.depth, PATHS.method]) await ensureUnreviewed(request, r.uid, p);
  }
});

test('an edit the server cannot parse (422) is rolled back to the stored value with the reason in a toast', async ({ page, request, errors }) => {
  const r = await target(request);
  const id = r.metadata.borehole_id;
  const depth = r.metadata.borehole_depth_m!;
  await ensureUnreviewed(request, r.uid, PATHS.depth);
  try {
    await openApp(page);
    await openReview(page, id);
    await page.getByRole('button', { name: 'Edit Final depth', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Corrected value for Final depth' });
    const failed = page.waitForResponse((res) => res.request().method() === 'PATCH' && res.status() === 422);
    await input.fill('twelve metres');
    await input.press('Enter');
    expect(await (await failed).json()).toMatchObject({ code: 'unparseable_value' });
    await expect(page.getByRole('status').filter({ hasText: /^Not saved: / })).toBeVisible();
    await expect(fieldRow(page, 'BoreholeDepth')).toContainText(`${depth.toFixed(2)} m`);
    await expect(fieldRow(page, 'BoreholeDepth')).not.toContainText('twelve');
    await expect(approveBtn(page, 'Final depth')).toHaveAttribute('aria-pressed', 'false');
    expect((await record(request, r.uid)).metadata.borehole_depth_m).toBe(depth);
    // Chrome logs the 422 as a failed resource load; that one is expected here.
    const expected = errors.filter((e) => /status of 422/.test(e));
    expect(expected).toHaveLength(1);
    errors.splice(errors.indexOf(expected[0]), 1);
  } finally {
    const now = await record(request, r.uid);
    if (now.metadata.borehole_depth_m !== depth) await patchValue(request, r.uid, { path: PATHS.depth, action: 'edit', value: depth });
    await ensureUnreviewed(request, r.uid, PATHS.depth);
  }
});

test('a spreadsheet value names its cell (Sheet!C5) as the source instead of a page', async ({ page, request }) => {
  const r = await target(request);
  const cellEntry = Object.entries(r.provenance).find(([, p]) => p.cell);
  test.skip(!cellEntry, 'no spreadsheet-cell value on this borehole');
  const [path, prov] = cellEntry!;
  const testIndex = /^test_results\[(\d+)\]\.value$/.exec(path);
  expect(testIndex, `cell value on a test result (${path})`).toBeTruthy();
  await openApp(page);
  await openReview(page, r.metadata.borehole_id);
  const row = fieldRow(page, `test[${testIndex![1]}]`);
  await expect(row).toContainText(prov.cell!);
  await row.click({ position: { x: 12, y: 12 } });
  await expect(page.getByLabel('Source page')).toContainText(`spreadsheet cell ${prov.cell}, no page image`);
});
