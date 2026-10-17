import { useMemo, useRef, useState } from 'react';
import { useDialogFocus } from '../../components/useDialogFocus';
import type { CrsCandidate } from '../../domain/types';
import { useAppStore, useReviewBorehole } from '../../store/appStore';
import styles from './CrsDialog.module.css';
import { CrsMap } from './CrsMap';
import { crsIntro } from './reviewView';

const NOTE_CLASS: Record<CrsCandidate['verdict'], string> = {
  match: styles.noteMatch,
  shifted: styles.noteShifted,
  out_of_range: styles.noteOut,
};

/**
 * Confirm the CRS once for the whole document (prototype template lines 341–355): candidates on the
 * left, a map preview of the picked candidate's pins on the right, "out of range" overlay, and
 * CONFIRM FOR WHOLE DOCUMENT (disabled for an out-of-range candidate). App renders it while
 * crsDialogOpen is true; Escape closes it via the store. The store preselects the candidate the
 * document currently uses and reports loading via crsLoading.
 * Candidates are native radio buttons (arrow keys move between them), drawn as cards. Tab stays
 * inside the dialog; closing it returns focus to CHOOSE CRS….
 */
export function CrsDialog() {
  const candidates = useAppStore((s) => s.crsCandidates);
  const pick = useAppStore((s) => s.crsPick);
  const pickCrs = useAppStore((s) => s.pickCrs);
  const confirmCrs = useAppStore((s) => s.confirmCrs);
  const close = useAppStore((s) => s.closeCrsDialog);
  const boreholes = useAppStore((s) => s.boreholes);
  const loading = useAppStore((s) => s.crsLoading);
  const b = useReviewBorehole();
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  /** A click closes the dialog only if it started on the scrim too (not a map drag released outside). */
  const downOnScrim = useRef(false);

  const labels = useMemo(() => Object.fromEntries(boreholes.map((x) => [x.uid, x.id])), [boreholes]);
  const current = candidates[pick];
  const canConfirm = !!current && current.verdict !== 'out_of_range' && !busy;

  useDialogFocus(dialog, { trap: true });

  const onConfirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    try {
      await confirmCrs();
    } finally {
      setBusy(false);
    }
  };

  const overlay =
    current?.verdict === 'out_of_range'
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
              {candidates.map((c, i) => (
                <label key={c.code} className={`${styles.cand} ${i === pick ? styles.candPicked : ''}`}>
                  <input
                    type="radio"
                    name="crs-candidate"
                    className={styles.radio}
                    value={c.code}
                    checked={i === pick}
                    onChange={() => pickCrs(i)}
                  />
                  <span className={styles.candName}>{c.name}</span>
                  <span className={styles.candCode}>{c.code}</span>
                  <span className={NOTE_CLASS[c.verdict]}>{c.note}</span>
                </label>
              ))}
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
          <button type="button" className={styles.confirm} disabled={!canConfirm} onClick={() => void onConfirm()}>
            CONFIRM FOR WHOLE DOCUMENT
          </button>
          <span className={styles.footNote}>Stored with your name. Map pins turn from amber to grey or green.</span>
        </div>
      </div>
    </div>
  );
}
