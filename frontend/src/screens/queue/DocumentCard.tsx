import { useMemo, useState, type MouseEvent } from 'react';
import { firstQuestionOf } from '../../components/clarify/clarifyModel';
import { QuestionsButton } from '../../components/clarify/QuestionsButton';
import { stageStep } from '../../data/adapters';
import { completenessSummary } from '../../domain/review';
import type { Borehole, DocumentProgress, DocumentSummary } from '../../domain/types';
import { useAppStore } from '../../store/appStore';
import styles from './DocumentCard.module.css';
import { PageStrip, type ThumbnailUrl } from './PageStrip';
import {
  canOpenReview,
  countChips,
  docHint,
  docMeta,
  duplicateText,
  isSelfDuplicate,
  mapSteps,
  mapStepText,
  mapStepTitle,
  NOT_RETRYABLE,
  progressView,
  questionsText,
  stageText,
  type JobFailure,
  type MapStep,
} from './queueView';
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

/** The map steps of a processed document (queueView.mapSteps) from what the store holds. */
function useMapSteps(doc: DocumentSummary): MapStep[] {
  const features = useAppStore((s) => s.features);
  const boreholes = useAppStore((s) => s.boreholes);
  const unplottedUids = useAppStore((s) => s.unplottedUids);
  const clarifications = useAppStore((s) => s.clarifications);
  return useMemo(() => {
    if (doc.step < 2 || doc.error) return [];
    const pins = features.filter((f) => f.documentId === doc.id);
    const pinned = new Set(pins.map((f) => f.uid));
    // As the map's NOT ON MAP list: listed by the server and not (any more) pinned.
    const offList = new Set(unplottedUids.filter((uid) => !pinned.has(uid)));
    const records = boreholes.filter((b) => b.documentId === doc.id);
    // The CRS status per borehole: its pin's, else (newer) its cached record's.
    const crs = new Map<string, Borehole['crs']['status']>([
      ...pins.map((f) => [f.uid, f.crsStatus] as const),
      ...records.map((b) => [b.uid, b.crs.status] as const),
    ]);
    return mapSteps(doc, {
      pinned: pins.length,
      offMap: records.filter((b) => offList.has(b.uid)),
      questions: clarifications,
      uids: [...crs.keys()],
      unsettled: [...crs].filter(([, s]) => s === 'inferred' || s === 'unknown').map(([uid]) => uid),
    });
  }, [doc, features, boreholes, unplottedUids, clarifications]);
}

/**
 * One map step of a card: SHOW flies the map to the pins, CONFIRM opens the CRS question (or the CRS
 * dialog), PLACE opens the position question, WHY opens the NOT ON MAP list. The click doesn't reach
 * the card behind it.
 */
function MapStepButton({ step, documentId }: { step: MapStep; documentId: string }) {
  const showOnMap = useAppStore((s) => s.showDocumentOnMap);
  const openClarification = useAppStore((s) => s.openClarification);
  const openCrsDialog = useAppStore((s) => s.openCrsDialog);
  const showNotOnMap = useAppStore((s) => s.showNotOnMap);
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    switch (step.kind) {
      case 'onMap':
        showOnMap(documentId);
        return;
      case 'crs':
        if (step.questionId) openClarification(step.questionId);
        else void openCrsDialog(documentId);
        return;
      case 'locate':
        openClarification(step.questionId);
        return;
      case 'notOnMap':
        showNotOnMap(documentId);
        return;
    }
  };
  const tone = step.kind === 'onMap' ? styles.onMap : step.kind === 'notOnMap' ? styles.whyStep : styles.nextStep;
  return (
    <button type="button" className={tone} data-map-step={step.kind} title={mapStepTitle(step)} onClick={onClick}>
      {mapStepText(step)}
    </button>
  );
}

interface Props {
  doc: DocumentSummary;
  /** Briefly highlighted (e.g. after "Same file as …" pointed here). */
  highlighted?: boolean;
  /** Why RETRY is off (demo mode: the backend can't extract), or null. */
  retryBlocked?: string | null;
  /** The failure the server reported live for this document (job.failed), or null. */
  failure?: JobFailure | null;
  /** Page thumbnail URLs of the source (null without page images, e.g. sample mode). */
  thumbnailUrl?: ThumbnailUrl | null;
  /** Scrolls to and highlights another document's card. */
  onShowDocument(id: string): void;
}

/**
 * One document of the queue. When it has a reviewable borehole, the card (and its hint) opens Review.
 * It shows progress while the backend works, open questions (a badge that opens the first one in the
 * question dialog, or the inbox), a duplicate link and, after processing, the way to the map: "N on
 * the map · SHOW", or the next step (CONFIRM a coordinate system, PLACE a borehole, WHY it is not on
 * the map). After a failure: the failed step marked, the error with its stage (live, else the
 * document's failed_stage) and RETRY: disabled with the reason in demo mode or when the server says a
 * retry cannot fix it.
 */
export function DocumentCard({ doc, highlighted, retryBlocked = null, failure = null, thumbnailUrl = null, onShowDocument }: Props) {
  const openReview = useAppStore((s) => s.openReview);
  const retryDocument = useAppStore((s) => s.retryDocument);
  const documents = useAppStore((s) => s.documents);
  const [retrying, setRetrying] = useState(false);
  const reviewable = canOpenReview(doc);
  const hint = docHint(doc, failure);
  const retryOff = retryBlocked ?? (failure && !failure.retryable ? NOT_RETRYABLE : null);
  const duplicate = duplicateText(doc, documents);
  // A link only to another card: a duplicate of itself (an upload of the same bytes again) says so as text.
  const duplicateListed = !!doc.duplicateOf && !isSelfDuplicate(doc) && documents.some((d) => d.id === doc.duplicateOf);
  const questions = questionsText(doc);
  // The badge opens this document's first unresolved question (or the inbox while none is loaded).
  const firstQuestion = useAppStore((s) => firstQuestionOf(s.clarifications, doc.id));
  const steps = useMapSteps(doc);

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

  const failed = !!doc.error || !!failure;
  // The failed step: the stage reported live (job.failed) wins over the document's failed_stage.
  const failedStage = failure?.stage ?? doc.failedStage ?? null;
  const step = failed ? (stageStep(failedStage) ?? doc.step) : doc.step;
  const cardClass = [
    styles.card,
    reviewable ? styles.openable : '',
    failed ? styles.failedCard : '',
    highlighted ? styles.highlighted : '',
  ].join(' ');

  return (
    // tabIndex -1: "show document" links move focus here, without adding the card to the tab order.
    <article
      className={cardClass}
      onClick={reviewable ? open : undefined}
      aria-label={doc.name}
      data-doc-id={doc.id}
      tabIndex={-1}
    >
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
        <StatusSteps step={step} failed={failed} failedStage={failed ? stageText(failedStage) : ''} />
        <div className={styles.checks}>
          {steps.map((step) => (
            <MapStepButton key={step.kind} step={step} documentId={doc.id} />
          ))}
          {questions && <QuestionsButton text={questions} questionId={firstQuestion} about="this document" />}
          <CompletenessChip doc={doc} />
        </div>
      </div>
      {doc.progress && <Progress progress={doc.progress} />}
      <CountChips counts={doc.counts} />
      <div className={styles.bottom}>
        <PageStrip doc={doc} thumbnailUrl={thumbnailUrl} />
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
              disabled={retrying || !!retryOff}
              title={retryOff ?? (retrying ? 'Re-queuing…' : 'Re-queue this document from its last successful step')}
              aria-description={retryOff ?? undefined}
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
