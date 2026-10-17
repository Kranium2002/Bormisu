import type { MouseEvent } from 'react';
import { completenessSummary } from '../../domain/review';
import type { DocumentSummary } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import styles from './DocumentCard.module.css';
import { PageStrip } from './PageStrip';
import { canOpenReview, countChips, docHint, docMeta } from './queueView';
import { StatusSteps } from './StatusSteps';

/** Completeness chip ("Report lists 14 · extracted 13 · ⚠ 1 missing") that opens the Completeness panel. */
function CompletenessChip({ doc }: { doc: DocumentSummary }) {
  const openCompleteness = useAppStore((s) => s.openCompleteness);
  if (!doc.completeness) return <span className={styles.muted}>Checks run after extraction</span>;
  const summary = completenessSummary(doc.completeness);
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    openCompleteness(doc.id);
  };
  return (
    <button
      type="button"
      className={`${styles.comp} ${styles[summary.tone]}`}
      onClick={onClick}
      title="Borehole IDs named in the report vs extracted, plus lint findings"
    >
      {summary.chipText}
    </button>
  );
}

/** Found counts ("13 BH · 63 layers · …"), or "Not processed yet" before extraction. */
function CountChips({ counts }: { counts: DocumentSummary['counts'] }) {
  const chips = countChips(counts);
  if (!chips) return <span className={styles.muted}>Not processed yet</span>;
  return (
    <ul className={styles.counts} aria-label="Found">
      {chips.map((c) => (
        <li key={c.label} className={styles.count} title={c.hint}>
          <b>{c.n}</b> {c.label}
        </li>
      ))}
    </ul>
  );
}

/** One document of the queue. When it has a reviewable borehole, the card (and its hint) opens Review. */
export function DocumentCard({ doc }: { doc: DocumentSummary }) {
  const openReview = useAppStore((s) => s.openReview);
  const reviewable = canOpenReview(doc);
  const hint = docHint(doc);

  const open = () => {
    if (reviewable && doc.reviewBoreholeUid) openReview(doc.reviewBoreholeUid);
  };
  const onHint = (e: MouseEvent) => {
    e.stopPropagation();
    open();
  };

  const cardClass = [styles.card, reviewable ? styles.openable : '', doc.error ? styles.failedCard : ''].join(' ');

  return (
    <article className={cardClass} onClick={reviewable ? open : undefined} aria-label={doc.name}>
      <div className={styles.top}>
        <div className={styles.ident}>
          <h2 className={styles.name} title={doc.name}>
            {doc.name}
          </h2>
          <span className={styles.meta}>{docMeta(doc)}</span>
        </div>
        <StatusSteps step={doc.step} failed={!!doc.error} />
        <div className={styles.checks}>
          <CompletenessChip doc={doc} />
        </div>
      </div>
      <CountChips counts={doc.counts} />
      <div className={styles.bottom}>
        <PageStrip doc={doc} />
        {hint?.tone === 'action' && (
          <button type="button" className={styles.hintAction} onClick={onHint}>
            {hint.text}
          </button>
        )}
        {hint?.tone === 'muted' && <span className={styles.hint}>{hint.text}</span>}
        {hint?.tone === 'error' && (
          <span className={styles.hintError} role="alert">
            {hint.text}
          </span>
        )}
      </div>
    </article>
  );
}
