import { completenessSummary } from '../domain/review';
import { useDocument } from '../store/appStore';
import { PanelHeader } from './PanelHeader';
import styles from './SidePanel.module.css';

const ID_TITLE = {
  extracted: 'Extracted',
  missing: 'Named in the report, no log found',
  unexpected: 'Extracted, not named in the report',
} as const;

/** Completeness panel: borehole IDs named in the report vs extracted, plus the document's lint findings. */
export function CompletenessPanel({ documentId }: { documentId: string }) {
  const doc = useDocument(documentId);
  const c = doc?.completeness;
  const summary = c ? completenessSummary(c) : null;

  return (
    <>
      <PanelHeader>
        <div className={styles.heading}>COMPLETENESS</div>
        <div className={styles.subMono}>{doc?.name ?? documentId}</div>
      </PanelHeader>
      <div className={styles.body}>
        {!c || !summary ? (
          <div className={styles.status}>Checks run after extraction.</div>
        ) : (
          <>
            <div className={styles.compHead}>{summary.headText}</div>
            <div className={styles.ids}>
              {summary.ids.map((x) => (
                <span key={`${x.state}:${x.id}`} className={`${styles.id} ${x.state === 'extracted' ? '' : styles[x.state]}`} title={ID_TITLE[x.state]}>
                  {x.id}
                </span>
              ))}
            </div>
            <div className={styles.legend}>
              <span>■ extracted</span>
              <span className={styles.legendMissing}>■ named in report, not extracted</span>
              <span className={styles.legendUnexpected}>■ extracted, not named in report</span>
            </div>
            <div className={styles.lintHead}>LINT</div>
            {c.lint.map((l, i) => (
              <div key={i} className={styles.lintRow}>
                <span className={l.severity === 'error' ? styles.sevError : styles.sevWarning}>{l.severity.toUpperCase()}</span>
                <span className={styles.mono}>{l.boreholeId}</span>
                <span>{l.message}</span>
              </div>
            ))}
            {c.lint.length === 0 && <div className={styles.status}>No lint findings.</div>}
          </>
        )}
      </div>
    </>
  );
}
