import { useAppStore } from '../../store/appStore';

/**
 * Opens the question dialog from outside React, over whatever screen is shown (FRONTEND.md F12): the
 * chat's `open_clarification` command and its inline clarification cards call this. The dialog is
 * mounted once in the app shell (ClarificationHost).
 */
export function openQuestion(clarificationId: string): void {
  useAppStore.getState().openClarification(clarificationId);
}
