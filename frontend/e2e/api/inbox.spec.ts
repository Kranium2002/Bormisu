/**
 * Clarifications in API mode (FRONTEND.md F12, F13) against the fictional seed: the inbox lists the
 * server's unresolved questions by document, every question opens in the dialog with the widgets and
 * evidence pages the server sent, deep links, the document card and Review badges, the CRS dialog's
 * link to the CRS question, and SKIP FOR NOW.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`): open questions of several kinds
 * (seven in the seed: crs_confirm, choose_reading, conflicting_sources, locate_borehole,
 * unit_ambiguous, duplicate, datum_convention) and one skipped (borehole_boundary).
 *
 * Writes: no answer is ever sent (an answered question cannot be reopened, so a test could not put
 * the seed back). One test skips an open question: a skipped question stays unresolved (it still
 * counts on the badge, the document card and its boreholes) and can still be answered, but there is
 * no way to un-skip it, so each run turns one more open question of a kind no other spec uses
 * (duplicate, datum_convention, conflicting_sources) into a skipped one, and the test skips itself
 * when none is left (reseed).
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { documents, expect, getJson, loaded, openApp, openReview, openUrl, records, reload, test, type ApiCall } from './fixtures';

interface WireField { name: string; widget: string; label: string; required?: boolean; options?: { value: unknown; label: string }[]; default?: unknown }
interface WireEvidence { document_id: string; page: number }
interface WireClarification {
  clarification_id: string;
  kind: string;
  status: 'open' | 'answered' | 'skipped';
  document_id: string;
  borehole_uids: string[];
  question: string;
  fields: WireField[];
  evidence: WireEvidence[];
  created_at: string;
}
interface WireCandidate { crs: string; label: string; verdict?: string | null }

/** Kind chip texts of the UI (src/components/clarify/clarifyModel.ts KIND_LABEL). */
const KIND: Record<string, string> = {
  crs_confirm: 'COORDINATE SYSTEM',
  locate_borehole: 'BOREHOLE POSITION',
  choose_reading: 'WHICH READING',
  datum_convention: 'DEPTH ORIGIN',
  unit_ambiguous: 'UNIT',
  borehole_boundary: 'BOREHOLE PAGES',
  duplicate: 'DUPLICATE',
  conflicting_sources: 'CONFLICTING SOURCES',
  chat_parameter: 'CHAT QUESTION',
};

/** Kinds no other spec relies on: SKIP FOR NOW may use one of these. */
const SKIPPABLE = ['duplicate', 'datum_convention', 'conflicting_sources'];

/** Every unresolved question (open, then skipped), oldest first within each. */
async function unresolved(api: APIRequestContext): Promise<WireClarification[]> {
  const open = await getJson<WireClarification[]>(api, '/clarifications?status=open');
  const skipped = await getJson<WireClarification[]>(api, '/clarifications?status=skipped');
  return [...open, ...skipped];
}

const inboxLink = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^INBOX/ });
const dialog = (page: Page) => page.getByRole('dialog', { name: /^QUESTION · / });
const item = (page: Page, id: string) => page.locator(`button[data-clarification-id="${id}"]`);

async function openInbox(page: Page) {
  await openApp(page);
  await inboxLink(page).click();
  await expect(page.getByRole('heading', { level: 1, name: 'INBOX' })).toBeVisible();
  await expect(page.getByText('Loading questions…')).toHaveCount(0, { timeout: 15_000 });
}

/** POSTs to the clarification endpoints (answer, skip) the page sent. */
const posts = (log: ApiCall[]) => log.filter((c) => c.method === 'POST' && /\/clarifications\//.test(c.url));

test('the inbox lists every unresolved question by document; the INBOX link counts them', async ({ page, request }) => {
  const list = await unresolved(request);
  expect(list.length, 'unresolved questions in the seed').toBeGreaterThan(0);
  const docs = await documents(request);
  await openInbox(page);
  await expect(inboxLink(page)).toHaveAttribute('aria-label', `INBOX, ${list.length} unresolved question${list.length === 1 ? '' : 's'}`);
  await expect(page.locator('button[data-clarification-id]')).toHaveCount(list.length);
  const byDoc = new Map<string, WireClarification[]>();
  for (const c of list) byDoc.set(c.document_id, [...(byDoc.get(c.document_id) ?? []), c]);
  await expect(page.locator('section[data-doc-id]')).toHaveCount(byDoc.size);
  for (const [docId, qs] of byDoc) {
    const group = page.locator(`section[data-doc-id="${docId}"]`);
    const name = docs.find((d) => d.document_id === docId)?.file_name ?? `Document ${docId} (not loaded)`;
    await expect(group.getByRole('heading', { level: 2 })).toHaveText(name);
    for (const c of qs) {
      const it = group.locator(`button[data-clarification-id="${c.clarification_id}"]`);
      await expect(it).toContainText(KIND[c.kind]);
      await expect(it).toContainText(c.question);
      if (c.status === 'skipped') await expect(it).toContainText('SKIPPED');
      else await expect(it).not.toContainText('SKIPPED');
    }
  }
});

test('every question opens with the server’s fields and evidence pages, and closes without sending anything', async ({ page, request, apiLog }) => {
  const list = await unresolved(request);
  await openInbox(page);
  for (const c of list) {
    await item(page, c.clarification_id).click();
    const d = dialog(page);
    await expect(d).toHaveAttribute('data-clarification-id', c.clarification_id);
    await expect(d.getByRole('heading', { level: 2 })).toHaveText(`QUESTION · ${KIND[c.kind]}`);
    await expect(d).toContainText(c.question);
    // One field per server field, rendered by its widget.
    expect(await d.locator('[data-widget]').evaluateAll((els) => els.map((e) => e.getAttribute('data-widget')))).toEqual(c.fields.map((f) => f.widget));
    // One evidence page per cited page.
    const pages = new Set(c.evidence.map((e) => `${e.document_id}:${e.page}`));
    await expect(d.getByRole('region', { name: 'Evidence' }).locator('figure')).toHaveCount(pages.size);
    for (const f of c.fields) {
      const field = d.locator(`[data-field="${f.name}"]`);
      if (f.widget === 'number_unit' && typeof f.default === 'number') await expect(field.getByRole('textbox')).toHaveValue(String(f.default));
      if (f.widget === 'select') for (const o of f.options ?? []) await expect(field.locator('option', { hasText: o.label })).toHaveCount(1);
      if (f.widget === 'choose_reading') await expect(field.getByRole('radio')).toHaveCount((f.options ?? []).length + (f.required ? 0 : 1));
    }
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(item(page, c.clarification_id)).toBeFocused();
  }
  expect(posts(apiLog), 'no answer or skip was sent').toEqual([]);
});

test('ANSWER with a required field empty marks it and sends nothing', async ({ page, request, apiLog }) => {
  const list = await unresolved(request);
  // The wire sends default: null for "no default".
  const c = list.find((x) => x.fields.some((f) => f.required && f.default == null));
  test.skip(!c, 'no question with a required field without a default');
  await openInbox(page);
  await item(page, c!.clarification_id).click();
  const d = dialog(page);
  await d.getByRole('button', { name: 'ANSWER', exact: true }).click();
  await expect(d.getByRole('alert')).toHaveText('Some answers are missing or can’t be read. Check the marked fields.');
  const required = c!.fields.find((f) => f.required && f.default == null)!;
  await expect(d.locator(`[data-field="${required.name}"] [aria-invalid="true"]`).first()).toBeVisible();
  await page.keyboard.press('Escape');
  expect(posts(apiLog)).toEqual([]);
});

test('a deep link /inbox?q= opens the question, also after a reload', async ({ page, request }) => {
  const [c] = await unresolved(request);
  await openUrl(page, `/inbox?q=${encodeURIComponent(c.clarification_id)}`);
  await expect(dialog(page)).toHaveAttribute('data-clarification-id', c.clarification_id, { timeout: 15_000 });
  await reload(page);
  await expect(dialog(page)).toHaveAttribute('data-clarification-id', c.clarification_id, { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/inbox$/);
});

test('a document card’s badge opens that document’s first unresolved question', async ({ page, request }) => {
  const list = await unresolved(request);
  const docs = (await documents(request)).filter((d) => d.open_clarifications > 0);
  test.skip(!docs.length, 'no document with open questions');
  const doc = docs[0];
  const mine = list.filter((c) => c.document_id === doc.document_id);
  const first = mine.find((c) => c.status === 'open') ?? mine[0];
  await openApp(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^UPLOAD & QUEUE/ }).click();
  await loaded(page);
  const badge = page.locator(`article[data-doc-id="${doc.document_id}"]`).getByRole('button', { name: /open questions?$/ });
  await expect(badge).toHaveText(`${doc.open_clarifications} open question${doc.open_clarifications === 1 ? '' : 's'}`);
  await badge.click();
  await expect(dialog(page)).toHaveAttribute('data-clarification-id', first.clarification_id);
  await page.keyboard.press('Escape');
  await expect(badge).toBeFocused();
});

test('Review shows a borehole’s open questions and opens them', async ({ page, request }) => {
  const list = await unresolved(request);
  const all = await records(request);
  const b = all.find((r) => (r.open_clarifications ?? 0) > 0 && list.some((c) => c.borehole_uids.includes(r.uid)));
  test.skip(!b, 'no reviewable borehole with an open question');
  await openApp(page);
  await openReview(page, b!.metadata.borehole_id);
  const badge = page.getByRole('button', { name: /^\d+ open questions?$/ });
  await expect(badge).toHaveText(`${b!.open_clarifications} open question${b!.open_clarifications === 1 ? '' : 's'}`);
  await badge.click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  const id = await d.getAttribute('data-clarification-id');
  expect(list.find((c) => c.clarification_id === id)?.borehole_uids).toContain(b!.uid);
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
});

test('F13: the CRS dialog links to the open CRS question; its picker previews the matched candidates', async ({ page, request }) => {
  const list = await unresolved(request);
  const q = list.find((c) => c.kind === 'crs_confirm');
  test.skip(!q, 'no unresolved crs_confirm question in the seed');
  const own = (await records(request, `?document_id=${q!.document_id}`)).sort((a, b) => a.metadata.borehole_id.localeCompare(b.metadata.borehole_id));
  test.skip(!own.length, 'the CRS question’s document has no boreholes');
  const candidates = await getJson<WireCandidate[]>(request, `/documents/${q!.document_id}/crs-candidates`);
  await openApp(page);
  await openReview(page, own[0].metadata.borehole_id);
  const crsRow = (await page.locator('[aria-label="Extracted values"] [data-key="CoordinateSystem"]').count())
    ? page.locator('[aria-label="Extracted values"] [data-key="CoordinateSystem"]')
    : page.locator('[aria-label="Extracted values"] [data-key="XY"]');
  await crsRow.click({ position: { x: 12, y: 12 } });
  await crsRow.getByRole('button', { name: 'CHOOSE CRS…' }).click();
  const crs = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
  await expect(crs.getByRole('radio')).toHaveCount(candidates.length);
  await crs.getByRole('button', { name: 'Answer it for the whole project instead' }).click();
  await expect(crs).toHaveCount(0);
  const d = dialog(page);
  await expect(d).toHaveAttribute('data-clarification-id', q!.clarification_id);
  const picker = q!.fields.find((f) => f.widget === 'crs_picker')!;
  const radios = d.locator(`[data-field="${picker.name}"]`).getByRole('radio');
  await expect(radios).toHaveCount((picker.options ?? []).length);
  for (const [i, o] of (picker.options ?? []).entries()) {
    const r = radios.nth(i);
    await expect(r).toContainText(o.label);
    const matched = candidates.some((c) => c.crs === o.value);
    if (matched) await expect(r).not.toContainText('No preview');
    else await expect(r).toContainText('No preview: the server lists no positions for this system');
  }
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
});

test('SKIP FOR NOW: the question stays in the inbox as skipped and still counts', async ({ page, request, apiLog }) => {
  const list = await unresolved(request);
  const c = list.find((x) => x.status === 'open' && SKIPPABLE.includes(x.kind));
  test.skip(!c, 'no open question of a kind this test may skip is left: reseed');
  await openInbox(page);
  await expect(inboxLink(page)).toHaveAttribute('aria-label', `INBOX, ${list.length} unresolved questions`);
  await item(page, c!.clarification_id).click();
  await dialog(page).getByRole('button', { name: 'SKIP FOR NOW' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Skipped for now: the question stays in the inbox.' })).toBeVisible();
  await expect(item(page, c!.clarification_id)).toContainText('SKIPPED');
  // Still unresolved: the badge keeps its count, the server lists it as skipped.
  await expect(inboxLink(page)).toHaveAttribute('aria-label', `INBOX, ${list.length} unresolved questions`);
  expect(posts(apiLog).map((p) => [p.method, new URL(p.url).pathname, p.status])).toEqual([
    ['POST', `/api/v1/clarifications/${c!.clarification_id}/skip`, 200],
  ]);
  const skipped = await getJson<WireClarification[]>(request, '/clarifications?status=skipped');
  expect(skipped.map((x) => x.clarification_id)).toContain(c!.clarification_id);
  // A skipped question can still be answered, but not skipped again.
  await item(page, c!.clarification_id).click();
  await expect(dialog(page).getByRole('button', { name: 'SKIP FOR NOW' })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'ANSWER', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
});
