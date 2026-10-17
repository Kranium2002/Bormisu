/** useDialogFocus: where Tab / Shift+Tab go inside a trapped dialog (F01). */
import { describe, expect, it } from 'vitest';
import { wrapTarget } from './useDialogFocus';

// Stand-ins for elements: wrapTarget only compares identities.
const [close, open, last] = [{ id: 'close' }, { id: 'open' }, { id: 'last' }] as unknown as HTMLElement[];
const items = [close, open, last];

describe('wrapTarget', () => {
  it('wraps Tab from the last element to the first, and Shift+Tab from the first to the last', () => {
    expect(wrapTarget(items, last, false, true)).toBe(close);
    expect(wrapTarget(items, close, true, true)).toBe(last);
  });

  it('lets the browser move focus between inner elements', () => {
    expect(wrapTarget(items, close, false, true)).toBeNull();
    expect(wrapTarget(items, open, true, true)).toBeNull();
  });

  it('pulls focus that escaped the dialog back in', () => {
    expect(wrapTarget(items, null, false, false)).toBe(close);
    expect(wrapTarget(items, null, true, false)).toBe(last);
  });

  it('has nowhere to go without focusable elements', () => {
    expect(wrapTarget([], null, false, false)).toBeNull();
  });
});
