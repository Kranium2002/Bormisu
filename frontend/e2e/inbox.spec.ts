/// <reference lib="dom" />
/**
 * Clarifications in sample mode (FRONTEND.md F12, F13; fictional sample questions only): the inbox,
 * the question dialog with its widgets, field errors, skip, the CRS question that places a report's
 * boreholes, deep links, focus handling, and the other ways in (document card, Review).
 *
 * The specs find questions by their kind (the chip text the UI shows), not by their wording, so they
 * follow whatever fictional questions the sample source asks. Each test starts from a fresh load (the
 * sample source is in memory).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, nav, openApp, openUrl, pathOf, resultRow, test } from './fixtures';

const inboxLink = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^INBOX/ });

/** The number in the INBOX link's name ("INBOX, 6 unresolved questions"), 0 when it says none. */
async function badgeCount(page: Page): Promise<number> {
  const name = (await inboxLink(page).getAttribute('aria-label')) ?? '';
  return Number(/(\d+) unresolved/.exec(name)?.[1] ?? 0);
}

async function openInbox(page: Page) {
  await openApp(page);
  await inboxLink(page).click();
  await expect(page.getByRole('heading', { level: 1, name: 'INBOX' })).toBeVisible();
  await expect(page.getByText('Loading questions…')).toHaveCount(0);
}

/** The inbox buttons of the questions of one kind (by the kind chip, e.g. "WHICH READING"). */
const itemsOfKind = (page: Page, kind: string) =>
  page.locator('button[data-clarification-id]').filter({ has: page.getByText(kind, { exact: true }) });

/** The open question dialog. */
const dialog = (page: Page) => page.getByRole('dialog', { name: /^QUESTION · / });

/** Opens the first inbox question of a kind and returns its dialog. */
async function openKind(page: Page, kind: string): Promise<Locator> {
  const item = itemsOfKind(page, kind).first();
  await expect(item, `a ${kind} question in the sample`).toBeVisible();
  await item.click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole('heading', { name: `QUESTION · ${kind}` })).toBeVisible();
  return d;
}

const focusInside = (page: Page) =>
  page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-modal="true"]');
    return !!d && !!document.activeElement && d.contains(document.activeElement);
  });

test.describe('inbox', () => {
  test('the INBOX link counts unresolved questions; the inbox groups them by document', async ({ page }) => {
    await openInbox(page);
    const n = await badgeCount(page);
    expect(n, 'fictional questions in the sample').toBeGreaterThan(0);
    await expect(page.locator('button[data-clarification-id]')).toHaveCount(n);
    await expect(page.getByText(`${n} unresolved question${n === 1 ? '' : 's'}`, { exact: true })).toBeVisible();
    // One group per document, headed by the file name.
    const groups = page.locator('section[data-doc-id]');
    expect(await groups.count()).toBeGreaterThan(0);
    for (const h of await groups.getByRole('heading', { level: 2 }).all()) await expect(h).toHaveText(/\.\w{2,5}$|^Document /);
  });

  test('a choose_reading question: pick a reading card and answer', async ({ page }) => {
    await openInbox(page);
    const before = await badgeCount(page);
    const d = await openKind(page, 'WHICH READING');
    const id = await d.getAttribute('data-clarification-id');
    const cards = d.locator('[data-widget="choose_reading"]').getByRole('radio');
    expect(await cards.count()).toBeGreaterThan(1);
    // Each reading shows its evidence crop.
    await expect(d.locator('[role="img"][aria-label^="Page "]').first()).toBeVisible();
    await cards.nth(1).check();
    await d.getByRole('button', { name: 'ANSWER', exact: true }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /^Answer stored/ })).toBeVisible();
    await expect(page.locator(`button[data-clarification-id="${id}"]`)).toHaveCount(0);
    await expect.poll(() => badgeCount(page)).toBe(before - 1);
    // The new count is announced politely.
    const n = before - 1;
    await expect(page.getByRole('banner').locator('[aria-live="polite"]')).toHaveText(`Inbox: ${n} unresolved question${n === 1 ? '' : 's'}`);
  });

  test('a number_unit question: the number and a unit', async ({ page }) => {
    await openInbox(page);
    const d = await openKind(page, 'UNIT');
    const field = d.locator('[data-widget="number_unit"]').first();
    const number = field.getByRole('textbox');
    if (!(await number.inputValue())) await number.fill('1.5');
    const unit = field.getByRole('combobox');
    const options = await unit.locator('option').allTextContents();
    expect(options[0]).toBe('Unit…');
    await unit.selectOption({ index: 1 });
    await d.getByRole('button', { name: 'ANSWER', exact: true }).click();
    await expect(d).toHaveCount(0);
  });

  test('with your name set, the answer says it is stored with it', async ({ page }) => {
    await openInbox(page);
    await page.getByRole('banner').getByRole('button', { name: 'YOUR NAME' }).click();
    await page.getByRole('dialog', { name: 'Your name' }).getByLabel('YOUR NAME').fill('A. Reviewer (fictional)');
    await page.getByRole('dialog', { name: 'Your name' }).getByRole('button', { name: 'SAVE' }).click();
    const d = await openKind(page, 'UNIT');
    await expect(d.getByText('Stored with your name (A. Reviewer (fictional)).')).toBeVisible();
    const field = d.locator('[data-widget="number_unit"]').first();
    if (!(await field.getByRole('textbox').inputValue())) await field.getByRole('textbox').fill('1.5');
    await field.getByRole('combobox').selectOption({ index: 1 });
    await d.getByRole('button', { name: 'ANSWER', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Answer stored with your name (A. Reviewer (fictional)).' })).toBeVisible();
  });

  test('a required field left empty shows its error next to it and takes the focus', async ({ page }) => {
    await openInbox(page);
    const d = await openKind(page, 'UNIT');
    const field = d.locator('[data-widget="number_unit"]').first();
    await field.getByRole('textbox').fill('');
    await d.getByRole('button', { name: 'ANSWER', exact: true }).click();
    await expect(d.getByRole('alert')).toHaveText('Some answers are missing or can’t be read. Check the marked fields.');
    await expect(field.getByText('Enter a number.')).toBeVisible();
    await expect(field.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    await expect(field.getByRole('textbox')).toBeFocused();
    // Typing clears the field's error.
    await field.getByRole('textbox').fill('2');
    await expect(field.getByText('Enter a number.')).toHaveCount(0);
  });

  test('SKIP FOR NOW keeps the question in the inbox, marked skipped and still counted', async ({ page }) => {
    await openInbox(page);
    const before = await badgeCount(page);
    const open = page.locator('button[data-clarification-id]').filter({ hasNotText: 'SKIPPED' }).first();
    const id = await open.getAttribute('data-clarification-id');
    await open.click();
    await dialog(page).getByRole('button', { name: 'SKIP FOR NOW' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Skipped for now: the question stays in the inbox.' })).toBeVisible();
    const item = page.locator(`button[data-clarification-id="${id}"]`);
    await expect(item).toContainText('SKIPPED');
    expect(await badgeCount(page)).toBe(before);
    // A skipped question can still be answered, but not skipped again.
    await item.click();
    await expect(dialog(page).getByRole('button', { name: 'SKIP FOR NOW' })).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: 'ANSWER', exact: true })).toBeEnabled();
  });

  test('the CRS question: candidates with verdicts and previews; answering places the report’s boreholes', async ({ page }) => {
    await openInbox(page);
    const d = await openKind(page, 'COORDINATE SYSTEM');
    const group = d.locator('[data-widget="crs_picker"]');
    const radios = group.getByRole('radio');
    expect(await radios.count()).toBeGreaterThan(0);
    const match = radios.filter({ hasText: 'pins on site' }).first();
    await expect(match).toBeVisible();
    await match.click();
    await expect(match).toHaveAttribute('aria-checked', 'true');
    // The picked candidate is previewed on the basemap.
    await expect(group.getByLabel(/^Map preview of /)).toBeVisible();
    await d.getByRole('button', { name: 'ANSWER', exact: true }).click();
    await expect(d).toHaveCount(0);
    await nav(page, 'MAP');
    // The Neckarbogen boreholes are placed with the confirmed system (RESULTS: "confirmed · <name>").
    await expect(resultRow(page, 'BK-01')).toContainText('confirmed');
  });

  test('deep link /inbox?q= opens the question; closing it takes ?q= out, opening puts it back', async ({ page }) => {
    await openInbox(page);
    const first = page.locator('button[data-clarification-id]').first();
    const id = (await first.getAttribute('data-clarification-id')) ?? '';
    await openUrl(page, `/inbox?q=${encodeURIComponent(id)}`);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('data-clarification-id', id);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect(pathOf(page)).toBe('/inbox');
    await page.locator(`button[data-clarification-id="${id}"]`).click();
    await expect(dialog(page)).toBeVisible();
    await expect.poll(() => pathOf(page)).toBe(`/inbox?q=${id}`);

    // A link to a question that is not open says so.
    await openUrl(page, '/inbox?q=cl_not_a_question');
    await expect(page.getByText('The question in this link is not open any more: it was answered, or the link is wrong.')).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
  });

  test('the open question replaces the inbox’s history entry: Back leaves the inbox and closes the dialog', async ({ page }) => {
    await openInbox(page);
    await page.locator('button[data-clarification-id]').first().click();
    await expect(dialog(page)).toBeVisible();
    await expect.poll(() => pathOf(page)).toMatch(/^\/inbox\?q=/);
    await page.goBack();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('main', { name: 'Map' })).toBeVisible();
  });

  test('focus stays in the dialog; Escape closes it and the focus goes back to the opener', async ({ page }) => {
    await openInbox(page);
    const opener = page.locator('button[data-clarification-id]').first();
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      expect(await focusInside(page), `focus after Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusInside(page), `focus after Shift+Tab ${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('a map_point question: a map click fills latitude and longitude', async ({ page }) => {
    await openInbox(page);
    const d = await openKind(page, 'BOREHOLE POSITION');
    const field = d.locator('[data-widget="map_point"]');
    const lat = field.getByLabel('Latitude (WGS84)');
    await expect(lat).toHaveValue('');
    await field.locator('.leaflet-container').click({ position: { x: 120, y: 100 } });
    await expect(lat).not.toHaveValue('');
    await expect(field.getByLabel('Longitude (WGS84)')).not.toHaveValue('');
    await page.keyboard.press('Escape');
  });
});

test.describe('other ways in', () => {
  test('a document card’s open-questions badge opens the document’s first question', async ({ page }) => {
    await openApp(page);
    await nav(page, 'UPLOAD & QUEUE');
    const badge = page.locator('article[data-doc-id]').getByRole('button', { name: /open questions?$/ }).first();
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(badge).toBeFocused();
  });

  test('Review shows the borehole’s open questions in its header and opens them', async ({ page }) => {
    await openApp(page);
    await nav(page, 'REVIEW');
    await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
    const header = page.getByRole('button', { name: /^\d+ open questions?$/ });
    test.skip(!(await header.isVisible()), 'the sample asks no question about BK-07');
    await header.click();
    await expect(dialog(page)).toBeVisible();
    // Keys typed in the dialog never reach the review shortcuts behind it.
    const progress = await page.getByText(/^\d+ of \d+ values reviewed$/).textContent();
    await page.keyboard.press('a');
    await expect(page.getByText(/^\d+ of \d+ values reviewed$/)).toHaveText(progress ?? '');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('a value an open question is about has a Question button on its Review row', async ({ page }) => {
    await openApp(page);
    await nav(page, 'REVIEW');
    await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
    const button = page.locator('[aria-label="Extracted values"]').getByRole('button', { name: /^Question about / }).first();
    test.skip(!(await button.isVisible()), 'no sample question names a value of BK-07 by its path');
    await button.click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('BK-07');
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
  });

  test('the CRS dialog links to the open CRS question of the document', async ({ page }) => {
    await openApp(page);
    await nav(page, 'REVIEW');
    await page.locator('[data-key="CoordinateSystem"]').click();
    await page.getByRole('button', { name: 'CHOOSE CRS…' }).click();
    const crs = page.getByRole('dialog', { name: 'CONFIRM CRS FOR THE WHOLE DOCUMENT' });
    await expect(crs).toBeVisible();
    await crs.getByRole('button', { name: 'Answer it for the whole project instead' }).click();
    await expect(crs).toHaveCount(0);
    await expect(dialog(page).getByRole('heading', { name: 'QUESTION · COORDINATE SYSTEM' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
