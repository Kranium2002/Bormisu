/**
 * Upload & queue in API mode: one card per stored document with its page strip, progress, found
 * counts, open questions, the error with RETRY for a failed one, and OPEN REVIEW.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`): documents in several states,
 * including one `failed` with an error and one still `classifying`. Read-only: RETRY is not
 * clicked, because a re-queued seed document cannot be put back (see the report).
 */
import { documents, expect, knownBug, nav, openApp, test, type WireDocument } from './fixtures';

const PAGE_TYPE_NAME: Record<string, string> = {
  log: 'log', lab_table: 'lab table', text: 'text', drawing: 'drawing', photo: 'photo', unknown: 'not classified yet',
};

const card = (page: import('@playwright/test').Page, d: WireDocument) => page.locator(`article[data-doc-id="${d.document_id}"]`);

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
  knownBug('FE-QUEUE-1', 'PAGE_TYPE_META.unknown is named "not classified yet", also for classified pages');
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
    if (q > 0) await expect(c).toContainText(`${q} open question${q === 1 ? '' : 's'}`);
    else await expect(c).not.toContainText('open question');
  }
});

test('a failed document shows the backend error and RETRY; a working one says Processing…', async ({ page, request }) => {
  const docs = await documents(request);
  const failed = docs.filter((d) => d.status === 'failed');
  const working = docs.filter((d) => ['queued', 'classifying', 'extracting'].includes(d.status));
  expect(failed.length + working.length, 'seeded failed / in-progress documents').toBeGreaterThan(0);
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  for (const d of failed) {
    const c = card(page, d);
    await expect(c.getByRole('alert')).toHaveText(`Extraction failed: ${d.error}`);
    await expect(c.getByRole('button', { name: 'RETRY' })).toBeEnabled();
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
  await card(page, d!).getByRole('button', { name: 'OPEN REVIEW ›' }).click();
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
  knownBug('CONTRACT-1', 'Document has no failed stage; the UI maps every failure to step 0 (classifying)');
  await openApp(page);
  await nav(page, 'UPLOAD & QUEUE');
  const failedStep = card(page, d!).getByRole('list', { name: 'Processing status' }).locator('li[aria-current="step"]');
  await expect(failedStep).not.toHaveText('classifying');
});
