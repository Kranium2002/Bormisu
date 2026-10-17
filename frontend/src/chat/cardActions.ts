/**
 * What the transcript's buttons do (FRONTEND.md F14): a result card's SHOW ON MAP and OPEN TABLE, a
 * citation chip, a question card's ANSWER. All go through the store's actions.
 */
import { useAppStore } from '../store/appStore';
import { openChatClarification } from './commands';
import { openEvidence } from './evidence';
import type { Citation } from './types';
import { narrowScreen } from './view';

/** SHOW ON MAP: the set on the map, flown to (showResultSet navigates to the map with its id). */
export async function showSetOnMap(id: string): Promise<void> {
  const s = useAppStore.getState();
  if (narrowScreen()) s.closeChat();
  // Without a router (tests) the screen is set here; with one, showResultSet puts the map in the URL.
  if (!s.navigator && s.screen !== 'map') s.go('map');
  await useAppStore.getState().showResultSet(id, { fit: true });
}

/** Waits (up to about 3 s) for the table of LIST, then focuses its first row (else the table). */
export function focusResultsTable(): void {
  if (typeof document === 'undefined') return;
  let tries = 0;
  const attempt = () => {
    const table = document.querySelector<HTMLElement>('[role="table"][aria-labelledby="results-title"]');
    if (!table) {
      if (++tries < 60) setTimeout(attempt, 50);
      return;
    }
    const row = table.querySelector<HTMLElement>('[role="row"][data-uid]');
    if (row) {
      row.focus();
      return;
    }
    table.tabIndex = -1;
    table.focus();
  };
  attempt();
}

/** OPEN TABLE: as SHOW ON MAP, then LIST shows the set and the focus goes to its table. */
export async function openSetTable(id: string): Promise<void> {
  await showSetOnMap(id);
  const s = useAppStore.getState();
  if (s.resultSet?.id !== id) return;
  if (s.navigator) s.showRoute({ kind: 'list' });
  focusResultsTable();
}

/** A citation chip: the Source panel at the cited value, or the cited page and box. */
export function openCitation(c: Citation): Promise<void> {
  return openEvidence({ documentId: c.documentId, page: c.page, box: c.box, uid: c.uid, path: c.path });
}

/** A question card's ANSWER: the question dialog (the question joins the store's list first). */
export function answerQuestion(data: unknown): void {
  if (!openChatClarification(data)) useAppStore.getState().showToast('This question can’t be shown here; open it from the INBOX.');
}
