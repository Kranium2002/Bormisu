import { useEffect } from 'react';
import { useAppStore } from '../../store/appStore';

/** Elements whose own key handling wins over the review shortcuts. */
const TYPING = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

/**
 * Keyboard flow of the Review screen (persona 04): J / K move to the next / previous value,
 * A approves (toggle), E edits, F flags. Escape is handled globally by the store.
 * Ignored while typing, while an overlay is open, or with a modifier key.
 */
export function useReviewKeys(keys: string[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const move = k === 'j' || k === 'k';
      // Holding J / K keeps moving; other keys act once per press.
      if (e.defaultPrevented || (e.repeat && !move)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest(TYPING)) return;
      const s = useAppStore.getState();
      // An open question dialog or menu takes the keys: an A there must not approve the value behind it.
      if (s.screen !== 'review' || s.editing || s.crsDialogOpen || s.panel || s.confirmCleanOpen || s.activeClarificationId || s.exportOpen) return;
      if (move) {
        const i = s.focusKey ? keys.indexOf(s.focusKey) : -1;
        const next = keys[k === 'j' ? Math.min(keys.length - 1, i + 1) : Math.max(0, i - 1)];
        if (next && next !== s.focusKey) s.focusValue(next, true);
        e.preventDefault();
        return;
      }
      const key = s.focusKey;
      if (!key || !keys.includes(key)) return;
      if (k === 'a') s.toggleApprove(key);
      else if (k === 'e') s.startEdit(key, 'edit');
      else if (k === 'f') s.toggleFlag(key);
      else return;
      // Stops the letter from being typed into the input that E / F open.
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);
}
