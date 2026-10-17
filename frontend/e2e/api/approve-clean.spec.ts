/**
 * APPROVE ALL CLEAN in API mode: the confirm popover shows the server's dry-run count, confirming
 * approves on the server (one POST, no PATCH loop) and reloads the document's boreholes; after a
 * page reload the values are still approved.
 *
 * Seed state needed: the fictional seed (`python -m app.seed`) with a document in needs_review that
 * has clean values (POST approve-clean?dry_run=true > 0), every borehole of it reviewable, none of
 * them waiting for a CRS confirmation (in the seed: fictional-salar-verde-sondajes.pdf). The spec
 * picks the document with the fewest clean values.
 *
 * Restore: the test resets exactly the values that went from unreviewed to approved, through the
 * API (the same PATCH reset the UI's undo sends, one per value).
 */
import type { APIRequestContext } from '@playwright/test';
import { API, documents, expect, openApp, openReview, patchValue, records, reload, test, type WireRecord } from './fixtures';

async function dryRun(api: APIRequestContext, documentId: string): Promise<number> {
  const res = await api.post(`${API}/documents/${documentId}/approve-clean?dry_run=true`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { count: number }).count;
}

/** Paths per uid whose status is approved. */
const approvedPaths = (rs: WireRecord[]) =>
  new Map(rs.map((r) => [r.uid, new Set(Object.entries(r.provenance).filter(([, p]) => p.status === 'approved').map(([k]) => k))]));

test('the confirm popover shows the server count; APPROVE approves on the server and survives a reload', async ({ page, request, apiLog }) => {
  test.setTimeout(90_000);
  const all = await records(request);
  const candidates: { id: string; name: string; count: number; boreholes: WireRecord[] }[] = [];
  for (const d of await documents(request)) {
    const own = all.filter((r) => r.document_id === d.document_id);
    if (d.status !== 'needs_review' || !own.length || own.some((r) => r.unplotted_reason === 'crs_unconfirmed')) continue;
    const count = await dryRun(request, d.document_id);
    if (count > 0) candidates.push({ id: d.document_id, name: d.file_name, count, boreholes: own });
  }
  expect(candidates.length, 'a seeded document with clean values (reseed if every one was approved)').toBeGreaterThan(0);
  const doc = candidates.sort((a, b) => a.count - b.count)[0];
  const first = [...doc.boreholes].sort((a, b) => a.metadata.borehole_id.localeCompare(b.metadata.borehole_id, undefined, { numeric: true }))[0];
  const before = approvedPaths(doc.boreholes);

  try {
    await openApp(page);
    await openReview(page, first.metadata.borehole_id);

    const dry = page.waitForResponse((r) => r.url().includes(`/documents/${doc.id}/approve-clean?dry_run=true`));
    await page.getByRole('button', { name: 'APPROVE ALL CLEAN' }).click();
    expect(await (await dry).json()).toEqual({ count: doc.count });
    const popover = page.getByRole('dialog', { name: 'Approve clean values' });
    await expect(popover).toContainText(`Approve ${doc.count} clean value${doc.count === 1 ? '' : 's'} in ${doc.name}?`);

    const run = page.waitForResponse((r) => r.url().includes(`/documents/${doc.id}/approve-clean?dry_run=false`));
    const refetch = page.waitForResponse((r) => r.url().endsWith(`/documents/${doc.id}/boreholes`) && r.request().method() === 'GET');
    await popover.getByRole('button', { name: 'APPROVE' }).click();
    expect(await (await run).json()).toEqual({ count: doc.count });
    expect((await refetch).status()).toBe(200);
    await expect(page.getByRole('status').filter({ hasText: `${doc.count} clean value${doc.count === 1 ? '' : 's'} approved` })).toBeVisible();
    // One request for the whole document, not a loop of single PATCHes.
    expect(apiLog.filter((c) => c.method === 'PATCH')).toEqual([]);

    // The server approved exactly the clean values; nothing is left to approve at once.
    const after = approvedPaths(await records(request, `?document_id=${doc.id}`));
    const added = [...after].reduce((n, [uid, paths]) => n + [...paths].filter((p) => !before.get(uid)?.has(p)).length, 0);
    expect(added).toBe(doc.count);
    expect(await dryRun(request, doc.id)).toBe(0);

    await reload(page);
    await openReview(page, first.metadata.borehole_id);
    const firstAfter = (await records(request, `?document_id=${doc.id}`)).find((r) => r.uid === first.uid)!;
    for (const path of after.get(first.uid) ?? []) {
      expect(firstAfter.provenance[path].status, path).toBe('approved');
    }
    // The borehole ID was read cleanly in every seeded log, so its row is approved now.
    if (after.get(first.uid)?.has('metadata.borehole_id')) {
      await expect(page.getByRole('button', { name: 'Approve Borehole ID', exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(page.getByText(/^\d+ of \d+ values reviewed$/)).not.toHaveText(/^0 of/);

    // A second dry run in the UI finds nothing left.
    await page.getByRole('button', { name: 'APPROVE ALL CLEAN' }).click();
    await expect(page.getByRole('dialog', { name: 'Approve clean values' })).toContainText('No clean values');
    await page.getByRole('dialog', { name: 'Approve clean values' }).getByRole('button', { name: 'Close' }).click();
  } finally {
    // Reset exactly the values this test approved.
    const now = await records(request, `?document_id=${doc.id}`);
    for (const r of now) {
      for (const [path, p] of Object.entries(r.provenance)) {
        if (p.status === 'approved' && !before.get(r.uid)?.has(path)) await patchValue(request, r.uid, { path, action: 'reset' });
      }
    }
    expect(await dryRun(request, doc.id)).toBe(doc.count);
  }
});
