import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { isUnresolved } from '../../components/clarify/clarifyModel';
import { inboxPath } from '../../routing/urlState';
import { useAppStore } from '../../store/appStore';

/**
 * Keeps /inbox?q=<id> and the question dialog in step while the inbox is shown (FRONTEND.md F12):
 * - a link with ?q= opens that question once the list holds it, and says so when it is not open;
 * - the question opened or closed on the inbox goes into the URL with history replace (Back leaves
 *   the inbox instead of stepping through dialogs, and closes the dialog the URL held).
 * Returns notOpen: the URL names a question the loaded list doesn't hold as unresolved.
 */
export function useInboxQuery(q: string | null): { notOpen: boolean } {
  const navigate = useNavigate();
  const active = useAppStore((s) => s.activeClarificationId);
  const ready = useAppStore((s) => s.clarificationsState === 'ready');
  const listed = useAppStore((s) => q !== null && s.clarifications.some((c) => c.id === q && isUnresolved(c)));
  const openClarification = useAppStore((s) => s.openClarification);
  /** The open question the URL was last brought in line with (changes only, not the first render). */
  const synced = useRef(active);
  /** The ?q= of the URL, for leaving the inbox. */
  const shownQ = useRef(q);
  shownQ.current = q;

  // Leaving the inbox (Back, a link) closes the dialog its URL held, so it doesn't stay over the next screen.
  useEffect(
    () => () => {
      const s = useAppStore.getState();
      if (shownQ.current && s.activeClarificationId === shownQ.current) s.closeClarification();
    },
    [],
  );

  // URL → dialog: a deep link, Back or Forward to /inbox?q=.
  useEffect(() => {
    if (q && listed && useAppStore.getState().activeClarificationId !== q) openClarification(q);
  }, [q, listed, openClarification]);

  // Dialog → URL: the question opened or closed here.
  useEffect(() => {
    if (synced.current === active) return;
    synced.current = active;
    if ((active ?? null) !== q) void navigate(inboxPath(active), { replace: true });
  }, [active, q, navigate]);

  return { notOpen: !!q && ready && !listed && active !== q };
}
