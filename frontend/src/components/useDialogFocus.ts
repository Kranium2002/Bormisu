import { useEffect, useState, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The keyboard-focusable elements inside `container` that are rendered, in DOM order. */
export function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/** Where Tab or Shift+Tab must go to stay inside the dialog, or null when the browser's move is fine. */
export function wrapTarget(items: HTMLElement[], active: Element | null, back: boolean, inside: boolean): HTMLElement | null {
  if (items.length === 0) return null;
  const first = items[0];
  const last = items[items.length - 1];
  if (back) return !inside || active === first ? last : null;
  return !inside || active === last ? first : null;
}

/**
 * Focus handling for a dialog or popover that `ref` points at, from mount to unmount:
 * - on mount, focus moves to its first focusable element (or the container itself), unless
 *   something inside already has focus (e.g. `autoFocus`);
 * - with `trap`, Tab and Shift+Tab wrap around inside it (modal side panel);
 * - on unmount, focus goes back to the element that had it before opening, if that element is still
 *   in the page and the user hasn't put focus somewhere else meanwhile.
 * Escape stays in the store (App's listener).
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, { trap = false }: { trap?: boolean } = {}): void {
  // Read during the first render, before any autoFocus inside the dialog moves focus.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    if (!container.contains(document.activeElement)) {
      const first = focusables(container)[0];
      if (first) first.focus({ preventScroll: true });
      else {
        if (!container.hasAttribute('tabindex')) container.tabIndex = -1;
        container.focus({ preventScroll: true });
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const active = document.activeElement;
      const items = focusables(container);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const target = wrapTarget(items, active, e.shiftKey, container.contains(active));
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    if (trap) document.addEventListener('keydown', onKey);

    return () => {
      if (trap) document.removeEventListener('keydown', onKey);
      const active = document.activeElement;
      const focusLost = !active || active === document.body || container.contains(active);
      if (focusLost && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [ref, trap, opener]);
}
