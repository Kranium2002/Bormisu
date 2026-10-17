/// <reference lib="dom" />
// The callbacks of page.evaluate run in the browser, so they use the DOM types.
/**
 * Accessibility and rendering checks of the M0 controls in sample mode (fictional data only):
 * focus stays in the CRS dialog, the approve-clean count is announced, and the DIN 4023 patterns
 * the profile references are mounted and paintable (findings uiv-7, uiv-9 and the DIN checks).
 */
import type { Page } from '@playwright/test';
import { expect, nav, navLink, openApp, resultRow, test } from './fixtures';

const CRS_DIALOG = 'CONFIRM CRS FOR THE WHOLE DOCUMENT';

async function openReview(page: Page) {
  await openApp(page);
  await nav(page, 'REVIEW');
  await expect(page.getByRole('heading', { name: 'REVIEW · BK-07' })).toBeVisible();
}

/** True when the focused element is inside the dialog with this name. */
const focusInDialog = (page: Page, name: string) =>
  page.evaluate((label) => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute('aria-labelledby')
      ? document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() === label
      : d.getAttribute('aria-label') === label);
    return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
  }, name);

test.describe('accessibility of the review controls', () => {
  test.beforeEach(async ({ page }) => openReview(page));

  test('uiv-7: Tab and Shift+Tab keep the focus inside the CRS dialog; closing it returns the focus', async ({ page }) => {
    await page.locator('[data-key="CoordinateSystem"]').click();
    const opener = page.getByRole('button', { name: 'CHOOSE CRS…' });
    await opener.focus();
    await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: CRS_DIALOG });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio').first()).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await focusInDialog(page, CRS_DIALOG), `focus after Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusInDialog(page, CRS_DIALOG), `focus after Shift+Tab ${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('uiv-9: the clean-value count of the dry run is announced in a live region', async ({ page }) => {
    await page.getByRole('button', { name: 'APPROVE ALL CLEAN' }).click();
    const confirm = page.getByRole('dialog', { name: 'Approve clean values' });
    await expect(confirm.getByText(/^Approve \d+ clean values? in /)).toBeVisible();
    const live = confirm.locator('[aria-live="polite"]');
    await expect(live).toHaveCount(1);
    await expect(live).toContainText(/Approve \d+ clean values? in neckarbogen_BG_2019\.pdf\?/);
  });

  test('uiv-11: closing the approve-clean confirmation returns the focus to its button', async ({ page }) => {
    const button = page.getByRole('button', { name: 'APPROVE ALL CLEAN' });
    await button.focus();
    await button.press('Enter');
    const confirm = page.getByRole('dialog', { name: 'Approve clean values' });
    await expect(confirm.getByRole('button', { name: 'APPROVE', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(button).toBeFocused();
  });
});

test.describe('your name', () => {
  test('uiv-11: the name form is reachable by keyboard and gives the focus back when it closes', async ({ page }) => {
    await openApp(page);
    const button = page.getByRole('button', { name: 'YOUR NAME' });
    await button.focus();
    await button.press('Enter');
    const form = page.getByRole('dialog', { name: 'Your name' });
    const input = form.getByLabel('YOUR NAME');
    await expect(input).toBeFocused();
    await input.fill('A. Reviewer (fictional)');
    await input.press('Enter');
    await expect(form).toHaveCount(0);
    const named = page.getByRole('button', { name: 'A. Reviewer (fictional)' });
    await expect(named).toBeFocused();
    await named.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Your name' }).getByLabel('YOUR NAME')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Your name' })).toHaveCount(0);
    await expect(named).toBeFocused();
  });
});

test.describe('route changes', () => {
  test('the focus moves to the main region named after the new screen; a control that stays keeps it', async ({ page }) => {
    await openApp(page);
    await navLink(page, 'UPLOAD & QUEUE').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main', { name: 'Upload & queue' })).toBeFocused();

    await nav(page, 'LIST');
    await resultRow(page, 'BK-07').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main', { name: 'Borehole detail' })).toBeFocused();
    await page.goBack();
    await expect(page.getByRole('main', { name: 'Borehole list' })).toBeFocused();

    // The search field keeps the focus when its search changes the screen.
    await nav(page, 'UPLOAD & QUEUE');
    const search = page.getByLabel('Search project or borehole ID');
    await search.fill('EQ-03');
    await search.press('Enter');
    await expect(page.getByRole('main', { name: 'Map' })).toBeVisible();
    await expect(search).toBeFocused();
  });
});

test.describe('DIN 4023 profile', () => {
  test('every layer fill points at a mounted userSpaceOnUse pattern that is not inside display:none', async ({ page }) => {
    await openApp(page);
    await nav(page, 'LIST');
    await resultRow(page, 'BK-07').click();
    const profile = page.getByRole('group', { name: /^DIN 4023 profile of BK-07/ });
    await expect(profile).toBeVisible();
    const fills = await profile.locator('rect[data-din]').evaluateAll((rects) =>
      rects.map((r) => {
        const fill = r.getAttribute('fill') ?? '';
        const id = /^url\(#(.+)\)$/.exec(fill)?.[1] ?? null;
        const pattern = id ? document.getElementById(id) : null;
        let hidden = false;
        for (let el: Element | null = pattern; el; el = el.parentElement) {
          if (getComputedStyle(el).display === 'none') hidden = true;
        }
        return {
          din: r.getAttribute('data-din'),
          fill,
          found: pattern?.tagName ?? null,
          units: pattern?.getAttribute('patternUnits') ?? null,
          hidden,
        };
      }),
    );
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills.filter((x) => x.fill.startsWith('url('))) {
      expect(f, `layer with DIN code ${f.din}`).toMatchObject({ found: 'pattern', units: 'userSpaceOnUse', hidden: false });
    }
    // Patterns are tiled at their native size: the profile never scales them per layer.
    const transforms = await page.locator('pattern[id^="din-"]').evaluateAll((ps) => ps.filter((p) => p.hasAttribute('patternTransform')).length);
    expect(transforms).toBe(0);
  });
});
