import { useMemo, useRef, useState } from 'react';
import { crsQuestionFor } from '../../components/clarify/clarifyModel';
import { CrsPreviewMap } from '../../components/clarify/CrsPreviewMap';
import { SWAP_TEXT, SWAP_TITLE, verdictColor, verdictText } from '../../components/clarify/crsView';
import { useFocusTrap } from '../../components/useFocusTrap';
import type { CrsVerdict } from '../../domain/types';
import { useAppStore, useReviewBorehole } from '../../store/appStore';
import styles from './CrsDialog.module.css';
import { CrsMap } from './CrsMap';
import { crsIntro, scoreText } from './reviewView';

const NOTE_CLASS: Record<CrsVerdict, string> = {
  match: styles.noteMatch,
  shifted: styles.noteShifted,
  out_of_range: styles.noteOut,
};

/**
 * Confirm the CRS once for the whole document (FRONTEND.md F13; prototype template lines 341–355):
 * the backend's candidates on the left (label, code, verdict colour with the backend's note and score,
 * a swap-axes mark, and a mini-map of where the candidate puts the boreholes), the picked candidate
 * large on the right (same basemap), "out of range" overlay, and CONFIRM FOR WHOLE DOCUMENT (POST
 * /documents/{id}/crs; disabled for an out-of-range candidate). When an unresolved CRS question
 * covers the document, a link answers that question instead (it can cover the whole project). The
 * store sends the candidate's swap-axes flag and your name, then reloads the document's boreholes.
 * App renders it while crsDialogOpen is true; Escape closes it via the store. Only the backend's
 * labels and notes are shown: nothing is inferred from a code.
 */
export function CrsDialog() {
  const candidates = useAppStore((s) => s.crsCandidates);
  const pick = useAppStore((s) => s.crsPick);
  const pickCrs = useAppStore((s) => s.pickCrs);
  const confirmCrs = useAppStore((s) => s.confirmCrs);
  const close = useAppStore((s) => s.closeCrsDialog);
  const boreholes = useAppStore((s) => s.boreholes);
  const loading = useAppStore((s) => s.crsLoading);
  const reviewerName = useAppStore((s) => s.reviewerName);
  const clarifications = useAppStore((s) => s.clarifications);
  const openClarification = useAppStore((s) => s.openClarification);
  const crsDocumentId = useAppStore((s) => s.crsDocumentId);
  const features = useAppStore((s) => s.features);
  const reviewBorehole = useReviewBorehole();
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  /** A click closes the dialog only if it started on the scrim too (not a map drag released outside). */
  const downOnScrim = useRef(false);

  const labels = useMemo(
    () => Object.fromEntries([...features, ...boreholes].map((x) => [x.uid, x.id])),
    [features, boreholes],
  );
  const documentId = crsDocumentId ?? reviewBorehole?.documentId ?? null;
  // The intro describes the review borehole when it is of this document (else one of its boreholes, e.g. from a queue card).
  const b =
    reviewBorehole && reviewBorehole.documentId === documentId
      ? reviewBorehole
      : (boreholes.find((x) => x.documentId === documentId && x.meta.xRaw) ?? boreholes.find((x) => x.documentId === documentId));
  const question = useMemo(() => {
    if (!documentId) return null;
    const uids = [...features, ...boreholes].filter((x) => x.documentId === documentId).map((x) => x.uid);
    return crsQuestionFor(clarifications, documentId, uids);
  }, [clarifications, boreholes, features, documentId]);
  const current = candidates[pick];
  const outOfRange = current?.verdict === 'out_of_range';
  const canConfirm = !!current && !outOfRange && !busy;
  const confirmTitle = !current
    ? 'No candidate to confirm'
    : outOfRange
      ? 'This candidate places the coordinates out of range'
      : busy
        ? 'Confirming…'
        : undefined;

  // Modal: the focus moves in, stays inside on Tab / Shift+Tab, and goes back to the opener on close.
  useFocusTrap(dialog);

  const onConfirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    try {
      await confirmCrs();
    } finally {
      setBusy(false);
    }
  };

  const overlay = outOfRange
    ? { text: 'Coordinates out of range: no pins can be placed', error: true }
    : !candidates.length
      ? { text: loading ? 'Placing candidates…' : 'No CRS candidates for this document', error: !loading }
      : null;

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnScrim.current && e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="crs-dialog-title"
        tabIndex={-1}
      >
        <div className={styles.head}>
          <div id="crs-dialog-title" className={styles.title}>
            CONFIRM CRS FOR THE WHOLE DOCUMENT
          </div>
          <button type="button" className={styles.close} aria-label="Close" onClick={close}>
            ×
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.left}>
            <div className={styles.intro}>{crsIntro(b, candidates)}</div>
            <div className={styles.cands} role="radiogroup" aria-label="CRS candidates">
              {candidates.map((c, i) => {
                const score = scoreText(c);
                return (
                  <div key={`${c.code}:${c.swapAxes}`} className={styles.candRow}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={i === pick}
                      className={`${styles.cand} ${i === pick ? styles.candPicked : ''}`}
                      style={{ borderLeftColor: verdictColor(c.verdict) }}
                      data-verdict={c.verdict ?? 'none'}
                      onClick={() => pickCrs(i)}
                    >
                      <span className={styles.candName}>{c.name}</span>
                      <span className={styles.candCode}>
                        {c.code}
                        {score && ` · ${score}`}
                      </span>
                      {c.swapAxes && (
                        <span className={styles.swap} title={SWAP_TITLE}>
                          {SWAP_TEXT}
                        </span>
                      )}
                      <span className={c.verdict ? NOTE_CLASS[c.verdict] : styles.noteNeutral}>{verdictText(c)}</span>
                    </button>
                    <CrsPreviewMap candidate={c} size="small" />
                  </div>
                );
              })}
              {!candidates.length && (
                <div className={styles.none}>
                  {loading ? 'Loading candidates…' : 'No candidates were found. Check the report text for a CRS or a site plan.'}
                </div>
              )}
            </div>
          </div>
          <div className={styles.mapCell}>
            <CrsMap candidates={candidates} pick={pick} labels={labels} />
            {overlay && (
              <div className={`${styles.overlay} ${overlay.error ? styles.overlayError : ''}`}>{overlay.text}</div>
            )}
          </div>
        </div>

        {question && (
          <div className={styles.question}>
            <span className={styles.questionText}>
              An open question asks for this coordinate system ({question.boreholeUids.length} borehole
              {question.boreholeUids.length === 1 ? '' : 's'}, possibly in other reports of the project).
            </span>
            <button
              type="button"
              className={styles.questionLink}
              onClick={() => {
                close();
                openClarification(question.id);
              }}
            >
              Answer it for the whole project instead
            </button>
          </div>
        )}

        <div className={styles.foot}>
          <button
            type="button"
            className={styles.confirm}
            disabled={!canConfirm}
            title={confirmTitle}
            onClick={() => void onConfirm()}
          >
            CONFIRM FOR WHOLE DOCUMENT
          </button>
          <span className={styles.footNote}>
            {reviewerName ? `Stored with your name (${reviewerName}). ` : ''}
            The map places every borehole of this document after the server converts the coordinates.
          </span>
        </div>
      </div>
    </div>
  );
}
