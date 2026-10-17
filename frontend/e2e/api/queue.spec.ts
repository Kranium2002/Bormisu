/**
 * Upload & queue in API mode: one card per stored document with its page strip, progress, found
 * counts, open questions (a badge button), the error with RETRY for a failed one, and OPEN REVIEW; the drop zone in
 * demo mode; a duplicate upload (answered by the test, so nothing is written).
 *
 * Seed state needed: the fictional seed (`python -m app.seed`): documents in several states,
 * including one `failed` with an error and one still `classifying`. Read-only: RETRY is not
 * clicked, because a re-queued seed document cannot be put back (see the report).
 */
import { documents, expect, getJson, nav, openApp, test, type WireDocument } from './fixtures';

const PAGE_TYPE_NAME: Record<string, string> = {
  log: 'log', lab_table: 'lab table', text: 'text', drawing: 'drawing', photo: 'photo', unknown: 'not classified yet',
};

const card = (page: import('@playwright/test').Page, d: WireDocument) => page.locator(`article[data-doc-id="${d.document_id}"]`);

/** A text as a literal inside a RegExp. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('every stored document is a card, newest first, with name, page count, project and status step', async ({ page, request }) => {
  const docs = await documents(request);
  expect(docs.length).toBeGreaterThan(0);
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  await expect(page.locator('article[data-doc-id]')).toHaveCount(docs.length);
  expect(await page.locator('article[data-doc-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-doc-id')))).toEqual(
    docs.map((d) => d.document_id),
  );
  const step: Record<string, string> = { queued: 'classifying', classifying: 'classifying', extracting: 'extracting', needs_review: 'needs review' };
  for (const d of docs) {
    const c = card(page, d);
    await expect(c.getByRole('heading', { level: 2 })).toHaveText(d.file_name);
    const n = d.page_count ?? d.pages.length;
    await expect(c).toContainText(`${n} page${n === 1 ? '' : 's'}${d.project ? ` · ${d.project}` : ''}`);
    const current = c.getByRole('list', { name: 'Processing status' }).locator('li[aria-current="step"]');
    if (d.status === 'done') await expect(current).toHaveCount(0);
    else if (d.status !== 'failed') await expect(current).toHaveText(step[d.status]);
  }
  // The nav badge counts the documents waiting for review.
  const waiting = docs.filter((d) => d.status === 'needs_review').length;
  await expect(page.getByRole('navigation', { name: 'Main' }).getByTitle(`${waiting} documents need review`)).toHaveText(String(waiting));
});

test('page strips: one cell per page with the backend type, usage and reason', async ({ page, request }) => {
  const docs = await documents(request);
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  for (const d of docs) {
    const cells = card(page, d).getByRole('group', { name: `Page map of ${d.file_name}` }).getByRole('button');
    await expect(cells).toHaveCount(d.page_count ?? d.pages.length);
    for (const p of d.pages) {
      const label = await cells.nth(p.n - 1).getAttribute('aria-label');
      // Type `unknown` of a classified page is FE-QUEUE-1 (own test below).
      if (p.type !== 'unknown') expect(label, `${d.file_name} p.${p.n}`).toMatch(new RegExp(`^p\\.${p.n} · ${PAGE_TYPE_NAME[p.type]} · `));
      if (p.used) expect(label).toContain('used: ');
      // A duplicate names the page it copies (not the other document's name); else the backend's reason.
      else if (p.duplicate_of) expect(label).toContain(`unused: duplicate of page ${p.duplicate_of.n}`);
      else if (p.unused_reason) expect(label).toContain(`unused: ${p.unused_reason}`);
    }
  }
});

test('FE-QUEUE-1: a classified page of type unknown (e.g. a duplicate) is not called "not classified yet"', async ({ page, request }) => {
  const docs = await documents(request);
  const hit = docs.flatMap((d) => d.pages.filter((p) => p.type === 'unknown' && p.role).map((p) => ({ d, p })))[0];
  test.skip(!hit, 'no seeded page of type unknown with a role');
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  const cell = card(page, hit!.d).getByRole('group', { name: `Page map of ${hit!.d.file_name}` }).getByRole('button').nth(hit!.p.n - 1);
  await expect(cell).not.toHaveAttribute('aria-label', /not classified yet/);
});

test('progress, found counts and open questions come from the document', async ({ page, request }) => {
  const docs = await documents(request);
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  for (const d of docs) {
    const c = card(page, d);
    if (d.progress) {
      const classified = c.getByRole('progressbar', { name: 'pages classified' });
      await expect(classified).toHaveAttribute('aria-valuenow', String(d.progress.pages_classified));
      await expect(classified).toHaveAttribute('aria-valuemax', String(d.progress.pages_total));
      if (d.progress.pages_ocr_total > 0) {
        await expect(c.getByRole('progressbar', { name: 'OCR' })).toHaveAttribute('aria-valuenow', String(d.progress.pages_ocr_done));
      }
      const n = d.progress.boreholes_extracted;
      await expect(c).toContainText(`${n} borehole${n === 1 ? '' : 's'} extracted`);
    }
    if (d.found) {
      const found = c.getByRole('list', { name: 'Found' });
      await expect(found).toContainText(`${d.found.boreholes} BH`);
      await expect(found).toContainText(`${d.found.layers} layer`);
      await expect(found).toContainText(`${d.found.spt} SPT`);
      await expect(found).toContainText(`${d.found.groundwater} GW reading`);
    } else {
      await expect(c).toContainText('not processed yet');
    }
    const q = d.open_clarifications;
    // F12: the open-questions badge is a button (it opens the first question; e2e/api/inbox.spec.ts).
    if (q > 0) await expect(c.getByRole('button', { name: `${q} open question${q === 1 ? '' : 's'}`, exact: true })).toBeVisible();
    else await expect(c).not.toContainText('open question');
  }
});

test('a failed document shows the backend error and RETRY (off in demo mode, BE-RETRY-1); a working one says Processing…', async ({ page, request }) => {
  const docs = await documents(request);
  const { mode } = await getJson<{ mode: string }>(request, '/health');
  const failed = docs.filter((d) => d.status === 'failed');
  const working = docs.filter((d) => ['queued', 'classifying', 'extracting'].includes(d.status));
  expect(failed.length + working.length, 'seeded failed / in-progress documents').toBeGreaterThan(0);
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  for (const d of failed) {
    const c = card(page, d);
    // 1.2.0 names the failed stage (failed_stage) after "at"; a 1.1.0 server sends none.
    const stage = (d as { failed_stage?: string | null }).failed_stage;
    if (stage) await expect(c.getByRole('alert')).toHaveText(new RegExp(`^Extraction failed at .+: ${escapeRe(d.error ?? '')}$`));
    else await expect(c.getByRole('alert')).toHaveText(`Extraction failed: ${d.error}`);
    const retry = c.getByRole('button', { name: 'RETRY' });
    // Without provider keys a retry cannot extract anything: RETRY is off with the reason.
    if (mode === 'demo') {
      await expect(retry).toBeDisabled();
      await expect(retry).toHaveAttribute('title', 'Live extraction needs API keys');
    } else {
      await expect(retry).toBeEnabled();
    }
  }
  for (const d of working) await expect(card(page, d)).toContainText('Processing…');
});

test('OPEN REVIEW on a document waiting for review opens one of its boreholes', async ({ page, request }) => {
  const docs = await documents(request);
  const d = docs.find((x) => x.status === 'needs_review');
  expect(d, 'a seeded document in needs_review').toBeTruthy();
  const own = (await (await request.get(`/api/v1/documents/${d!.document_id}/boreholes`)).json()) as { metadata: { borehole_id: string } }[];
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  await card(page, d!).getByRole('button', { name: 'OPEN IN REVIEW ›' }).click();
  const title = page.getByRole('heading', { level: 1, name: /^REVIEW · / });
  await expect(title).toBeVisible();
  const id = (await title.textContent())!.replace('REVIEW · ', '');
  expect(own.map((b) => b.metadata.borehole_id)).toContain(id);
  await expect(page.getByText(d!.file_name, { exact: false }).first()).toBeVisible();
});

test('CONTRACT-1: a failed document marks the step that failed, not "classifying" after classification finished', async ({ page, request }) => {
  const docs = await documents(request);
  const d = docs.find((x) => x.status === 'failed' && x.progress && x.progress.pages_classified === x.progress.pages_total);
  test.skip(!d, 'no seeded document that failed after classification');
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  const failedStep = card(page, d!).getByRole('list', { name: 'Processing status' }).locator('li[aria-current="step"]');
  await expect(failedStep).not.toHaveText('classifying');
});

test('demo mode: the drop zone, the project field and the folder picker are off with the reason', async ({ page, request }) => {
  const { mode } = await getJson<{ mode: string }>(request, '/health');
  test.skip(mode !== 'demo', 'the stack has provider keys');
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  await expect(page.getByLabel('Project (optional)')).toBeDisabled();
  await expect(page.getByLabel('Choose a folder to upload')).toBeDisabled();
  await expect(page.locator('label').filter({ hasText: 'DROP REPORTS HERE' })).toContainText('Uploading is off: Live extraction needs API keys.');
});

test('upload → map: a processed card shows "N on the map · SHOW" for its pins, or the next step; SHOW and WHY open the map', async ({ page, request }) => {
  const docs = (await documents(request)).filter((d) => d.status === 'needs_review' || d.status === 'done');
  expect(docs.length, 'seeded processed documents').toBeGreaterThan(0);
  const features = (await getJson<{ features: { properties: { document_id?: string | null } }[] }>(request, '/map/boreholes.geojson')).features;
  const offMap = (await getJson<{ boreholes: { uid: string; document_id?: string | null }[] }>(request, '/boreholes?plotted=false&limit=5000')).boreholes;
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  let shown: WireDocument | null = null;
  let why: WireDocument | null = null;
  for (const d of docs) {
    const c = card(page, d);
    const pins = features.filter((f) => f.properties.document_id === d.document_id).length;
    const show = c.locator('[data-map-step="onMap"]');
    if (pins > 0) {
      await expect(show).toHaveText(`${pins} on the map · SHOW`);
      shown ??= d;
    } else {
      await expect(show).toHaveCount(0);
    }
    // Every borehole of the document that is not on the map is behind a next step (CONFIRM, PLACE or WHY).
    const off = offMap.filter((b) => b.document_id === d.document_id).length;
    const next = c.locator('[data-map-step="crs"], [data-map-step="locate"], [data-map-step="notOnMap"]');
    if (off > 0) await expect(next.first()).toBeVisible();
    if (off > 0 && (await c.locator('[data-map-step="notOnMap"]').count())) why ??= d;
  }
  if (shown) {
    await card(page, shown).locator('[data-map-step="onMap"]').click();
    await expect(page).toHaveURL(/\/map/);
    await nav(page, 'UPLOAD & QUEUE');
  }
  if (why) {
    await card(page, why).locator('[data-map-step="notOnMap"]').click();
    await expect(page).toHaveURL(/\/map/);
    await expect(page.getByRole('heading', { name: /^NOT ON MAP/ })).toBeVisible();
  }
});

test('a duplicate upload says "Already uploaded" and points at the existing card instead of adding one', async ({ page, request }) => {
  const docs = await documents(request);
  const existing = docs.find((d) => d.status === 'needs_review') ?? docs[0];
  expect(existing, 'a seeded document').toBeTruthy();
  // Uploads are on (health reported live) and the server's duplicate answer is the test's: nothing is written.
  const health = await getJson<Record<string, unknown>>(request, '/health');
  await page.route((url) => url.pathname === '/api/v1/health', (route) => route.fulfill({ json: { ...health, mode: 'live' } }));
  await page.route(
    (url) => url.pathname === '/api/v1/documents',
    (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 200, json: { document_id: existing.document_id, status: existing.status, duplicate_of: existing.document_id } })
        : route.fallback(),
  );
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  await expect(page.locator('article[data-doc-id]')).toHaveCount(docs.length);
  await page
    .locator('label')
    .filter({ hasText: 'DROP REPORTS HERE' })
    .locator('input[type=file]')
    .setInputFiles({ name: 'copy_of_report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fictional copy') });
  const row = page.getByRole('region', { name: 'UPLOADS' }).getByRole('listitem').filter({ hasText: 'copy_of_report.pdf' });
  await expect(row).toContainText('Already uploaded');
  await expect(page.locator('article[data-doc-id]')).toHaveCount(docs.length);
  await row.getByRole('button', { name: 'Show the existing document of copy_of_report.pdf' }).click();
  await expect(card(page, existing)).toBeFocused();
});
