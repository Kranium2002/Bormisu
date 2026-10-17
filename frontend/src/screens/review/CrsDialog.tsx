import { useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../../components/useFocusTrap';
import type { CrsVerdict } from '../../domain/types';
import { useAppStore, useReviewBorehole } from '../../store/appStore';
import styles from './CrsDialog.module.css';
import { CrsMap } from './CrsMap';
import { crsIntro, scoreText, VERDICT_LABEL } from './reviewView';

const NOTE_CLASS: Record<CrsVerdict, string> = {
  match: styles.noteMatch,
  shifted: styles.noteShifted,
  out_of_range: styles.noteOut,
};

/**
 * Confirm the CRS once for the whole document (prototype template lines 341–355): the backend's
 * candidates on the left (label, code, verdict in colour with the backend's note and score, a
 * swap-axes mark), a map preview of the picked candidate's pins on the right, "out of range"
 * overlay, and CONFIRM FOR WHOLE DOCUMENT (disabled for an out-of-range candidate). The store sends
 * the candidate's swap-axes flag and your name, then reloads the document's boreholes. App renders it
 * while crsDialogOpen is true; Escape closes it via the store.
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
  const b = useReviewBorehole();
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  /** A click closes the dialog only if it started on the scrim too (not a map drag released outside). */
  const downOnScrim = useRef(false);

  const labels = useMemo(() => Object.fromEntries(boreholes.map((x) => [x.uid, x.id])), [boreholes]);
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
                  <button
                    key={`${c.code}:${c.swapAxes}`}
                    type="button"
                    role="radio"
                    aria-checked={i === pick}
                    className={`${styles.cand} ${i === pick ? styles.candPicked : ''}`}
                    onClick={() => pickCrs(i)}
                  >
                    <span className={styles.candName}>{c.name}</span>
                    <span className={styles.candCode}>
                      {c.code}
                      {score && ` · ${score}`}
                    </span>
                    {c.swapAxes && (
                      <span className={styles.swap} title="The printed X is the northing: X and Y are swapped for this candidate">
                        ⇄ X / Y swapped
                      </span>
                    )}
                    <span className={c.verdict ? NOTE_CLASS[c.verdict] : styles.noteNeutral}>
                      {[c.verdict ? VERDICT_LABEL[c.verdict] : '', c.note ?? ''].filter(Boolean).join(' · ') || 'No verdict from the backend'}
                    </span>
                  </button>
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
