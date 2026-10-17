import { useEffect, type RefObject } from 'react';

/** Elements Tab can reach. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The elements inside `root` that Tab reaches, in document order (hidden ones left out). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Keeps the keyboard focus inside a modal dialog (FRONTEND.md section 6): focuses the dialog when it
 * opens, wraps Tab and Shift+Tab at its ends, and gives the focus back to the element that had it
 * before (the opener) when the dialog closes.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !(active instanceof Node) || !root.contains(active);
      if (e.shiftKey && (outside || active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}
