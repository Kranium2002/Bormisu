import { useEffect, useMemo } from 'react';
import { boreholeText, createdText, groupByDocument, kindLabel, questionCountText, unresolvedCount, type QuestionGroup } from '../../components/clarify/clarifyModel';
import { useAppStore } from '../../store/appStore';
import type { ClarificationsSlice } from '../../store/types';
import styles from './InboxScreen.module.css';

export const INBOX_EMPTY = 'No open questions. When a report is unclear (a coordinate system, a handwritten value, a unit), the backend asks here.';
export const INBOX_NOT_OPEN = 'The question in this link is not open any more: it was answered, or the link is wrong.';

interface ViewProps {
  state: ClarificationsSlice['clarificationsState'];
  groups: QuestionGroup[];
  /** Printed borehole IDs by uid, for the affected boreholes. */
  known: readonly { uid: string; id: string }[];
  /** The ?q= of the URL names a question that is not open. */
  notOpen: boolean;
  onOpen(id: string): void;
  onRetry(): void;
}

/** The inbox (pure; rendered in tests): questions grouped by document, each opening the dialog. */
export function InboxView({ state, groups, known, notOpen, onOpen, onRetry }: ViewProps) {
  const count = groups.reduce((n, g) => n + unresolvedCount(g.questions), 0);
  const loading = (state === 'idle' || state === 'loading') && count === 0;
  return (
    <div className={styles.scroll}>
      <div className={styles.page} data-screen-label="Inbox">
        <div className={styles.titleRow}>
          <h1 className={styles.title}>INBOX</h1>
          {/* The count is announced when it changes (an answer, a skip, a new question). */}
          <span className={styles.count} aria-live="polite" aria-atomic="true">
            {state === 'ready' || count > 0 ? questionCountText(count) : ''}
          </span>
        </div>
        <p className={styles.intro}>
          Small questions the backend asks where a report is unclear. Open one to see its source and answer it, or skip it for later:
          a skipped question stays here until it is answered.
        </p>
        {notOpen && state === 'ready' && (
          <div className={styles.notice} role="status">
            {INBOX_NOT_OPEN}
          </div>
        )}
        {loading && (
          <div className={styles.state} role="status">
            Loading questions…
          </div>
        )}
        {state === 'error' && (
          <div className={`${styles.state} ${styles.error}`} role="alert">
            The questions could not be loaded.
            <button type="button" className={styles.retry} onClick={onRetry}>
              RETRY
            </button>
          </div>
        )}
        {state === 'ready' && count === 0 && (
          <div className={styles.state} role="status">
            {INBOX_EMPTY}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.documentId} className={styles.group} aria-labelledby={`inbox-doc-${g.documentId}`} data-doc-id={g.documentId}>
            <div className={styles.groupHead}>
              <h2 id={`inbox-doc-${g.documentId}`} className={styles.docName}>
                {g.name ?? `Document ${g.documentId} (not loaded)`}
              </h2>
              <span className={styles.groupCount}>
                {g.questions.length} question{g.questions.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className={styles.list}>
              {g.questions.map((q) => {
                const bh = boreholeText(q.boreholeUids, known);
                const created = createdText(q.createdAt);
                return (
                  <li key={q.id}>
                    <button type="button" className={styles.item} data-clarification-id={q.id} onClick={() => onOpen(q.id)}>
                      <span className={styles.itemHead}>
                        <span className={styles.kind}>{kindLabel(q.kind).toUpperCase()}</span>
                        {q.status === 'skipped' && <span className={styles.skipped}>SKIPPED</span>}
                      </span>
                      <span className={styles.question}>{q.question}</span>
                      <span className={styles.meta}>
                        {bh ? `Boreholes: ${bh}` : 'No borehole named'}
                        {created && (
                          <>
                            {' · asked '}
                            <time dateTime={q.createdAt}>{created}</time>
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * /inbox (FRONTEND.md F12): every unresolved question, grouped by document; each opens the question
 * dialog. Loads the questions when nobody has yet; loading, error and empty states from the store.
 */
export function InboxScreen({ notOpen = false }: { notOpen?: boolean }) {
  const list = useAppStore((s) => s.clarifications);
  const state = useAppStore((s) => s.clarificationsState);
  const documents = useAppStore((s) => s.documents);
  const boreholes = useAppStore((s) => s.boreholes);
  const features = useAppStore((s) => s.features);
  const loadClarifications = useAppStore((s) => s.loadClarifications);
  const openClarification = useAppStore((s) => s.openClarification);

  useEffect(() => {
    if (state === 'idle') void loadClarifications();
  }, [state, loadClarifications]);

  const groups = useMemo(() => groupByDocument(list, documents), [list, documents]);
  const known = useMemo(() => [...features, ...boreholes], [features, boreholes]);

  return (
    <InboxView
      state={state}
      groups={groups}
      known={known}
      notOpen={notOpen}
      onOpen={openClarification}
      onRetry={() => void loadClarifications()}
    />
  );
}
