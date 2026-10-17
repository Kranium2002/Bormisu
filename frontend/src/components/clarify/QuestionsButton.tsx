import type { MouseEvent } from 'react';
import { inboxPath } from '../../routing/urlState';
import { useAppStore } from '../../store/appStore';
import styles from './QuestionsButton.module.css';

interface Props {
  /** Badge text, e.g. "2 open questions". */
  text: string;
  /** The question the badge opens; null opens the inbox instead (the list doesn't hold one yet). */
  questionId: string | null;
  /** What it is about, for the title: "this document", "this borehole". */
  about: string;
}

/**
 * Amber open-questions badge as a button (document cards, the Review header): opens the first
 * unresolved question in the question dialog, or the inbox when the app has not loaded it. The click
 * doesn't reach the card behind it.
 */
export function QuestionsButton({ text, questionId, about }: Props) {
  const openClarification = useAppStore((s) => s.openClarification);
  const navigator = useAppStore((s) => s.navigator);
  const title = questionId ? `Answer the first open question of ${about}` : 'Open the inbox';
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (questionId) openClarification(questionId);
    else navigator?.navigate(inboxPath());
  };
  const off = !questionId && !navigator;
  return (
    <button
      type="button"
      className={styles.badge}
      title={off ? 'The questions are not loaded' : title}
      disabled={off}
      onClick={onClick}
    >
      {text}
    </button>
  );
}
