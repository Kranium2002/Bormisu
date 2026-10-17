import { useState, type MouseEvent } from 'react';
import { completenessSummary } from '../../domain/review';
import type { DocumentProgress, DocumentSummary } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import styles from './DocumentCard.module.css';
import { PageStrip } from './PageStrip';
import { canOpenReview, countChips, docHint, docMeta, duplicateText, isSelfDuplicate, progressView, questionsText } from './queueView';
import { StatusSteps } from './StatusSteps';

/** Completeness chip ("Report lists 14 · extracted 13 · ⚠ 1 missing") that opens the Completeness panel. */
function CompletenessChip({ doc }: { doc: DocumentSummary }) {
  const openCompleteness = useAppStore((s) => s.openCompleteness);
  if (!doc.completeness) return <span className={styles.muted}>checks run after extraction</span>;
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

/** Found counts ("13 BH · 63 layers · …"), or "not processed yet" before extraction. */
function CountChips({ counts }: { counts: DocumentSummary['counts'] }) {
  const chips = countChips(counts);
  if (!chips) return <span className={styles.muted}>not processed yet</span>;
  return (
    <ul className={styles.counts} aria-label="Found">
      {chips.map((c) => (
        <li key={c.label} className={styles.count}>
          <b>{c.n}</b> {c.label}
        </li>
      ))}
    </ul>
  );
}

/** Progress bars of a document the backend works on: pages classified, OCR, boreholes extracted. */
function Progress({ progress }: { progress: DocumentProgress }) {
  const view = progressView(progress);
  return (
    <div className={styles.progress}>
      {view.bars.map((b) => (
        <div key={b.label} className={styles.progressItem}>
          <span className={styles.progressLabel}>
            {b.label} {b.done}/{b.total}
          </span>
          <div
            className={styles.progressBar}
            role="progressbar"
            aria-label={b.label}
            aria-valuemin={0}
            aria-valuemax={b.total}
            aria-valuenow={b.done}
          >
            <div className={styles.progressFill} style={{ width: `${b.pct}%` }} />
          </div>
        </div>
      ))}
      <span className={styles.progressLabel}>{view.boreholes}</span>
    </div>
  );
}

interface Props {
  doc: DocumentSummary;
  /** Briefly highlighted (e.g. after "Same file as …" pointed here). */
  highlighted?: boolean;
  /** Why RETRY is off (demo mode: the backend can't extract), or null. */
  retryBlocked?: string | null;
  /** Scrolls to and highlights another document's card. */
  onShowDocument(id: string): void;
}

/**
 * One document of the queue. When it has a reviewable borehole, the card (and its hint) opens Review.
 * It shows progress while the backend works, open questions, a duplicate link and, after a failure,
 * the error with RETRY (disabled with the reason in demo mode).
 */
export function DocumentCard({ doc, highlighted, retryBlocked = null, onShowDocument }: Props) {
  const openReview = useAppStore((s) => s.openReview);
  const retryDocument = useAppStore((s) => s.retryDocument);
  const documents = useAppStore((s) => s.documents);
  const [retrying, setRetrying] = useState(false);
  const reviewable = canOpenReview(doc);
  const hint = docHint(doc);
  const duplicate = duplicateText(doc, documents);
  // A link only to another card: a duplicate of itself (an upload of the same bytes again) says so as text.
  const duplicateListed = !!doc.duplicateOf && !isSelfDuplicate(doc) && documents.some((d) => d.id === doc.duplicateOf);
  const questions = questionsText(doc);

  const open = () => {
    if (reviewable && doc.reviewBoreholeUid) openReview(doc.reviewBoreholeUid);
  };
  const onHint = (e: MouseEvent) => {
    e.stopPropagation();
    open();
  };
  const onRetry = async (e: MouseEvent) => {
    e.stopPropagation();
    setRetrying(true);
    try {
      await retryDocument(doc.id);
    } finally {
      setRetrying(false);
    }
  };
  const onDuplicate = (e: MouseEvent) => {
    e.stopPropagation();
    if (doc.duplicateOf) onShowDocument(doc.duplicateOf);
  };

  const cardClass = [
    styles.card,
    reviewable ? styles.openable : '',
    doc.error ? styles.failedCard : '',
    highlighted ? styles.highlighted : '',
  ].join(' ');

  return (
    <article className={cardClass} onClick={reviewable ? open : undefined} aria-label={doc.name} data-doc-id={doc.id}>
      <div className={styles.top}>
        <div className={styles.ident}>
          <h2 className={styles.name} title={doc.name}>
            {doc.name}
          </h2>
          <span className={styles.meta}>{docMeta(doc)}</span>
          {duplicate &&
            (duplicateListed ? (
              <button type="button" className={styles.dupLink} onClick={onDuplicate}>
                {duplicate}
              </button>
            ) : (
              <span className={styles.meta}>{duplicate}</span>
            ))}
        </div>
        <StatusSteps step={doc.step} failed={!!doc.error} />
        <div className={styles.checks}>
          {questions && (
            <span className={styles.questions} title="Questions the backend needs answered for this document">
              {questions}
            </span>
          )}
          <CompletenessChip doc={doc} />
        </div>
      </div>
      {doc.progress && <Progress progress={doc.progress} />}
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
          <span className={styles.errorBlock}>
            <span className={styles.hintError} role="alert">
              {hint.text}
            </span>
            <button
              type="button"
              className={styles.retry}
              disabled={retrying || !!retryBlocked}
              title={retryBlocked ?? (retrying ? 'Re-queuing…' : 'Re-queue this document from its last successful step')}
              aria-description={retryBlocked ?? undefined}
              onClick={(e) => void onRetry(e)}
            >
              {retrying ? 'RETRYING…' : 'RETRY'}
            </button>
          </span>
        )}
      </div>
    </article>
  );
}
