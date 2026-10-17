import { useEffect, useMemo, useRef } from 'react';
import { Popover } from '../../components/Popover';
import { progress } from '../../domain/review';
import { CLEAN_CONFIDENCE } from '../../domain/status';
import type { Borehole } from '../../domain/types';
import { useAppStore, useDocument } from '../../store/appStore';
import styles from './ReviewScreen.module.css';
import { sheetPages, siblings } from './reviewView';

/**
 * Review header: title + file / project, borehole switcher, sheet tabs, progress,
 * › BOREHOLE DETAIL and APPROVE ALL CLEAN with its confirm popover. The source counts the clean
 * values of the whole document (a dry run) before anything is approved.
 */
export function ReviewHeader({ b }: { b: Borehole }) {
  const doc = useDocument(b.documentId);
  const isSample = useAppStore((s) => s.source?.kind === 'sample');
  const boreholes = useAppStore((s) => s.boreholes);
  const reviewPage = useAppStore((s) => s.reviewPage);
  const setReviewPage = useAppStore((s) => s.setReviewPage);
  const confirmOpen = useAppStore((s) => s.confirmCleanOpen);
  const cleanCount = useAppStore((s) => s.cleanCount);
  const cleanBusy = useAppStore((s) => s.cleanBusy);
  const askClean = useAppStore((s) => s.askClean);
  const approveClean = useAppStore((s) => s.approveClean);
  const cancelClean = useAppStore((s) => s.cancelClean);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const openReview = useAppStore((s) => s.openReview);

  const cleanRef = useRef<HTMLDivElement>(null);

  // A click outside the confirm popover cancels it (Escape is handled by the store).
  useEffect(() => {
    if (!confirmOpen) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !cleanRef.current?.contains(e.target)) cancelClean();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [confirmOpen, cancelClean]);

  const sheets = useMemo(() => sheetPages(b), [b]);
  const sibs = useMemo(() => siblings(boreholes, b), [boreholes, b]);
  const { approved, total } = progress(b);
  const pct = total ? Math.round((approved / total) * 100) : 0;
  const idx = sibs.findIndex((x) => x.uid === b.uid);
  const prev = idx > 0 ? sibs[idx - 1] : undefined;
  const next = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : undefined;
  const fileName = doc?.name ?? b.sourceFile;
  const subtitle = `${fileName} · ${doc?.project ?? b.project}${isSample ? ' (fictional)' : ''}`;
  const cleanDisabledReason = !b.documentId ? 'No source document for this borehole' : cleanBusy ? 'Approving clean values…' : undefined;

  return (
    <div className={styles.header}>
      <div className={styles.titleBlock}>
        <h1 className={styles.title}>REVIEW · {b.id}</h1>
        <div className={styles.subtitle}>{subtitle}</div>
      </div>

      {sibs.length > 1 && idx >= 0 && (
        <div className={styles.switcher} role="group" aria-label="Borehole in this report">
          <button
            type="button"
            className={styles.switchBtn}
            disabled={!prev}
            title={prev ? `Previous borehole: ${prev.id}` : 'This is the first borehole of the report'}
            aria-label="Previous borehole"
            onClick={() => prev && openReview(prev.uid)}
          >
            ‹
          </button>
          <span>
            {idx + 1} / {sibs.length}
          </span>
          <button
            type="button"
            className={styles.switchBtn}
            disabled={!next}
            title={next ? `Next borehole: ${next.id}` : 'This is the last borehole of the report'}
            aria-label="Next borehole"
            onClick={() => next && openReview(next.uid)}
          >
            ›
          </button>
        </div>
      )}

      <div className={styles.tabs} role="tablist" aria-label="Log sheets">
        {sheets.map((p, i) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={reviewPage === p}
            className={`${styles.tab} ${reviewPage === p ? styles.tabActive : ''}`}
            onClick={() => setReviewPage(p)}
          >
            SHEET {i + 1} · P.{p}
          </button>
        ))}
      </div>

      <div className={styles.progress}>
        <span className={styles.progressText}>
          {approved} of {total} values reviewed
        </span>
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-label="Values reviewed"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={approved}
        >
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <button type="button" className={styles.detailBtn} onClick={() => openBorehole(b.uid)}>
        › BOREHOLE DETAIL
      </button>

      <div ref={cleanRef} className={styles.cleanWrap}>
        <button
          type="button"
          className={styles.cleanBtn}
          disabled={!!cleanDisabledReason}
          aria-expanded={confirmOpen}
          title={cleanDisabledReason ?? `Approve every clean value of ${fileName}`}
          onClick={() => void askClean()}
        >
          {cleanBusy ? 'APPROVING…' : 'APPROVE ALL CLEAN'}
        </button>
        {confirmOpen && (
          <Popover width={320} label="Approve clean values" className={styles.confirm}>
            {cleanCount === null ? (
              <div className={styles.confirmText} role="status">
                Counting the clean values of {fileName}…
              </div>
            ) : cleanCount === 0 ? (
              <>
                <div className={styles.confirmTitle}>No clean values</div>
                <div className={styles.confirmText}>Nothing left to approve at once in {fileName}.</div>
                <div className={styles.confirmActions}>
                  <button type="button" className={styles.cancelBtn} onClick={cancelClean} autoFocus>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={styles.confirmTitle}>
                  Approve {cleanCount} clean value{cleanCount === 1 ? '' : 's'} in {fileName}?
                </div>
                <div className={styles.confirmText}>
                  Unreviewed values with a source reference, no flag, no lint and no special state, read from
                  the text layer or OCRed with at least {Math.round(CLEAN_CONFIDENCE * 100)} % confidence.
                </div>
                <div className={styles.confirmActions}>
                  <button type="button" className={styles.approveBtn} onClick={() => void approveClean()} autoFocus>
                    APPROVE
                  </button>
                  <button type="button" className={styles.cancelBtn} onClick={cancelClean}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </Popover>
        )}
      </div>
    </div>
  );
}
