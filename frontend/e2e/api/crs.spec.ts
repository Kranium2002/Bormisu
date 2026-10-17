/**
 * CRS confirmation in API mode: the dialog lists the server's candidates with their verdicts, and
 * confirming one places the document's boreholes on the map (checked after a reload).
 *
 * Seed state needed: the fictional seed (`python -m app.seed`) with a document whose boreholes have
 * printed coordinates but no stated system (unplotted_reason crs_unconfirmed, crs_status inferred;
 * in the seed: the two Tarawhiti Wharf documents). The spec takes the one with the most such
 * boreholes and skips when none is left.
 *
 * NOT RESTORABLE: a confirmed CRS cannot be taken back (no API or UI for it). Each full run
 * consumes one such document; after two runs reseed with
 * `python -m app.seed --remove && python -m app.seed`.
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  documents,
  expect,
  expectPins,
  fieldRow,
  getJson,
  knownBug,
  mapFeatures,
  nav,
  openApp,
  openDetail,
  openReview,
  records,
  reload,
  test,
  UNPLOTTED_LABEL,
  type WireRecord,
} from './fixtures';


interface Candidate { crs: string; label: string; verdict?: string | null; note?: string | null; score?: number; swap_axes?: boolean }
interface Clarification { clarification_id: string; kind: string; status: string; document_id: string; borehole_uids: string[] }

const VERDICT_TEXT: Record<string, string> = { match: 'pins on site', shifted: 'shifted from the site', out_of_range: 'out of range' };

/** The document with the most boreholes waiting for a CRS confirmation, or null. */
async function unconfirmedDocument(api: APIRequestContext): Promise<{ id: string; name: string; boreholes: WireRecord[] } | null> {
  const waiting = (await records(api, '?plotted=false')).filter((r) => r.unplotted_reason === 'crs_unconfirmed');
  const byDoc = new Map<string, WireRecord[]>();
  for (const r of waiting) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r]);
  const [best] = [...byDoc.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!best) return null;
  const doc = (await documents(api)).find((d) => d.document_id === best[0])!;
  return { id: best[0], name: doc.file_name, boreholes: best[1].sort((a, b) => a.metadata.borehole_id.localeCompare(b.metadata.borehole_id)) };
}

/**
 * The Review row that offers CHOOSE CRS… (src/screens/review/reviewView.ts crsActionKey): the CRS row,
 * else the X / Y row, because a source that prints no system has no CRS value at all (FE-CRS-1).
 */
async function crsActionRow(page: Page): Promise<Locator> {
  const crs = fieldRow(page, 'CoordinateSystem');
  return (await crs.count()) ? crs : fieldRow(page, 'XY');
}

test('FE-CRS-1: a borehole waiting for a CRS confirmation offers CHOOSE CRS… in Review', async ({ page, request }) => {
  const doc = await unconfirmedDocument(request);
  test.skip(!doc, 'no document with crs_unconfirmed boreholes left: reseed');
  await openApp(page);
  await openReview(page, doc!.boreholes[0].metadata.borehole_id);
  const row = await crsActionRow(page);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('not stated in source');
  await row.click({ position: { x: 12, y: 12 } });
  await expect(row.getByRole('button', { name: 'CHOOSE CRS…' })).toBeVisible();
});

/** Verdict colours of the dialog (src/components/clarify/crsView.ts verdictColor), as the browser reports them. */
const VERDICT_RGB: Record<string, string> = {
  match: 'rgb(125, 183, 19)',
  shifted: 'rgb(227, 155, 0)',
  out_of_range: 'rgb(200, 16, 46)',
  none: 'rgb(163, 163, 162)',
};

test('F13: every candidate shows its verdict colour and a mini-map; the picked one is large (read-only)', async ({ page, request }) => {
  const doc = await unconfirmedDocument(request);
  test.skip(!doc, 'no document with crs_unconfirmed boreholes left: reseed');
  const candidates = await getJson<Candidate[]>(request, `/documents/${doc!.id}/crs-candidates`);
  await openApp(page);
  await openReview(page, doc!.boreholes[0].metadata.borehole_id);
  const crsRow = await crsActionRow(page);
  await crsRow.click({ position: { x: 12, y: 12 } });
  await crsRow.getByRole('button', { name: 'CHOOSE CRS…' }).click();
  const dialog = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
  const radios = dialog.getByRole('radio');
  await expect(radios).toHaveCount(candidates.length);
  for (const [i, c] of candidates.entries()) {
    const verdict = c.verdict ?? 'none';
    await expect(radios.nth(i)).toHaveAttribute('data-verdict', verdict);
    await expect(radios.nth(i)).toHaveCSS('border-left-color', VERDICT_RGB[verdict]);
  }
  // One thumbnail per candidate on the configured basemap (decorative), and the picked candidate large.
  await expect(dialog.locator('.leaflet-container[aria-hidden="true"]')).toHaveCount(candidates.length);
  await expect(dialog.getByLabel('Map preview of the picked CRS')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('the dialog lists the server candidates with verdicts; confirming places every borehole of the document', async ({ page, request }) => {
  const doc = await unconfirmedDocument(request);
  test.skip(!doc, 'no document with crs_unconfirmed boreholes left: reseed (a confirmed CRS cannot be undone)');
  const candidates = await getJson<Candidate[]>(request, `/documents/${doc!.id}/crs-candidates`);
  expect(candidates.length, 'CRS candidates for the document').toBeGreaterThan(0);
  const plottedBefore = (await mapFeatures(request)).length;
  const first = doc!.boreholes[0];

  await openApp(page);
  await expectPins(page, plottedBefore);
  for (const b of doc!.boreholes) {
    await expect(page.locator(`aside button[data-uid="${b.uid}"]`)).toContainText(UNPLOTTED_LABEL.crs_unconfirmed);
  }
  await openReview(page, first.metadata.borehole_id);
  const crsRow = await crsActionRow(page);
  // Click the label cell: the focused row's middle holds the Not in source / Illegible buttons.
  await crsRow.click({ position: { x: 12, y: 12 } });
  const listed = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc!.id}/crs-candidates`));
  await crsRow.getByRole('button', { name: 'CHOOSE CRS…' }).click();
  expect((await listed).status()).toBe(200);

  const dialog = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
  const radios = dialog.getByRole('radio');
  await expect(radios).toHaveCount(candidates.length);
  for (const [i, c] of candidates.entries()) {
    const radio = radios.nth(i);
    await expect(radio).toContainText(c.label);
    await expect(radio).toContainText(c.crs);
    if (c.verdict) await expect(radio).toContainText(VERDICT_TEXT[c.verdict]);
    if (c.note) await expect(radio).toContainText(c.note);
    if (c.swap_axes) await expect(radio).toContainText('X / Y swapped');
  }
  // The best candidate is picked; an out-of-range one can't be confirmed.
  await expect(radios.first()).toHaveAttribute('aria-checked', 'true');
  const outIdx = candidates.findIndex((c) => c.verdict === 'out_of_range');
  if (outIdx >= 0) {
    await radios.nth(outIdx).click();
    await expect(dialog.getByRole('button', { name: 'CONFIRM FOR WHOLE DOCUMENT' })).toBeDisabled();
    await radios.first().click();
  }

  const pick = candidates[0];
  const confirm = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc!.id}/crs`) && r.request().method() === 'POST');
  const refetch = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc!.id}/boreholes`) && r.request().method() === 'GET');
  await dialog.getByRole('button', { name: 'CONFIRM FOR WHOLE DOCUMENT' }).click();
  const answer = await confirm;
  expect(JSON.parse(answer.request().postData() ?? '{}')).toEqual({ crs: pick.crs, swap_axes: pick.swap_axes ?? false, confirmed_by: null, note: null });
  expect(await answer.json()).toEqual({ updated: doc!.boreholes.length });
  expect((await refetch).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: `CRS confirmed for ${doc!.boreholes.length} borehole` })).toBeVisible();

  // The server placed them: after a reload (which keeps Review, F4) they are pins, not listed under NOT ON MAP.
  await reload(page);
  await expect(page.getByRole('heading', { level: 1, name: `REVIEW · ${first.metadata.borehole_id}` })).toBeVisible();
  await nav(page, 'MAP');
  const after = await records(request, `?document_id=${doc!.id}`);
  for (const b of after) expect({ id: b.metadata.borehole_id, plotted: b.plotted, crs: b.crs_status }).toEqual({ id: b.metadata.borehole_id, plotted: true, crs: 'confirmed' });
  await expectPins(page, plottedBefore + doc!.boreholes.length);
  for (const b of doc!.boreholes) {
    await expect(page.locator(`aside button[data-uid="${b.uid}"]`)).toHaveCount(0);
    await expect(page.locator(`[role="table"] [role="row"][data-uid="${b.uid}"]`).getByRole('cell').nth(4)).toHaveText(/^confirmed/);
  }
});

/** A borehole whose CRS a reviewer confirmed (from the test above or an earlier run). */
async function confirmedBorehole(api: APIRequestContext): Promise<WireRecord | undefined> {
  return (await records(api)).find((r) => r.crs_status === 'confirmed' && r.plotted);
}

test('FE-CRS-2: a confirmed CRS is named by its code in Detail, Review and RESULTS, never "CRS unknown"', async ({ page, request }) => {
  const b = await confirmedBorehole(request);
  test.skip(!b, 'no borehole with a confirmed CRS yet');
  const code = b!.metadata.coordinates.crs_code!;
  expect(code, 'the backend stores the confirmed code').toMatch(/^EPSG:/);
  await openApp(page);
  // Soft: report every place that drops the code, not only the first.
  // RESULTS: a pin from the map layer carries only the CRS status, so the row names the code once the
  // record is cached (Detail, Review; checked at the end) and the status before. Its title never says
  // there is no coordinate system.
  const resultsCrs = page.locator(`[role="table"] [role="row"][data-uid="${b!.uid}"]`).getByRole('cell').nth(4);
  const codePattern = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect.soft(resultsCrs, 'RESULTS CRS cell').toHaveText(new RegExp(`^confirmed( · ${codePattern})?$`));
  await expect.soft(resultsCrs, 'RESULTS CRS title').not.toHaveAttribute('title', /no coordinate system/i);
  await openDetail(page, b!.metadata.borehole_id);
  const meta = page.getByLabel('Metadata');
  await expect.soft(meta, 'Detail location').not.toContainText('CRS unknown');
  await expect.soft(meta, 'Detail metadata').toContainText(code);
  await page.getByRole('button', { name: '› OPEN IN REVIEW' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `REVIEW · ${b!.metadata.borehole_id}` })).toBeVisible();
  await expect.soft(await crsActionRow(page), 'Review CRS row (else the X / Y row that offers CHOOSE CRS…)').toContainText(code);
  // Back on the map the record is cached: RESULTS names the system after the status (the printed
  // name, else the code), and its title carries the code.
  await nav(page, 'MAP');
  await expect.soft(resultsCrs, 'RESULTS CRS cell of a cached record').toHaveText(/^confirmed · \S/);
  await expect.soft(resultsCrs, 'RESULTS CRS title of a cached record').toHaveAttribute('title', new RegExp(codePattern));
});

test('BE-CRS-1: confirming the CRS of a document resolves its open crs_confirm question', async ({ request }) => {
  const b = await confirmedBorehole(request);
  test.skip(!b, 'no borehole with a confirmed CRS yet');
  // Contract 1.2.0 fixes this (a CRS confirmation resolves the crs_confirm questions it settles) and
  // the UI reloads the questions after a confirmation. The marker stays until this test passes
  // against a 1.2.0 backend: the demo stack still runs 1.1.0 (checked 2026-10-17).
  knownBug('BE-CRS-1', 'POST /documents/{id}/crs leaves the crs_confirm clarification of the same boreholes open');
  const open = (await getJson<Clarification[]>(request, '/clarifications')).filter(
    (c) => c.kind === 'crs_confirm' && c.status === 'open' && c.borehole_uids.includes(b!.uid),
  );
  // While it stays open, the borehole counts it in open_clarifications and shows "Needs attention".
  expect(open, 'open crs_confirm questions for a borehole whose CRS is confirmed').toEqual([]);
});
