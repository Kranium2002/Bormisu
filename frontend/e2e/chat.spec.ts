/**
 * The chat in sample mode (fictional sample data): there is no backend to ask, and the chat is never
 * faked, so the header's CHAT button is off with its reason and opens nothing.
 */
import { expect, openApp, test } from './fixtures';

test('the CHAT button is off in sample mode, with the reason as its tooltip', async ({ page }) => {
  await openApp(page);
  const button = page.getByRole('button', { name: 'CHAT', exact: true });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAttribute('title', 'Chat needs the backend');
  // Still focusable (keyboard users get the reason), but it opens nothing.
  await button.focus();
  await expect(button).toBeFocused();
  // aria-disabled (Playwright would wait for it to be enabled): a forced click and Enter open nothing.
  await button.click({ force: true });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Chat assistant' })).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});
