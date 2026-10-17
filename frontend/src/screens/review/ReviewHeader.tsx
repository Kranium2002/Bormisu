import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Popover } from '../../components/Popover';
import { cleanKeys, progress } from '../../domain/review';
import type { Borehole } from '../../domain/types';
import { useAppStore, useDocument } from '../../store/appStore';
import styles from './ReviewScreen.module.css';
import { SCAN_PANE_ID, sheetPages, siblings } from './reviewView';

/** Keys that move between the sheet tabs (roving tabindex, WAI-ARIA tabs pattern). */
const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/**
 * Review header: title + file / project, borehole switcher, sheet tabs, progress,
 * › OPEN DETAIL and APPROVE ALL CLEAN (n) with its confirm popover.
 */
export function ReviewHeader({ b }: { b: Borehole }) {
  const doc = useDocument(b.documentId);
  const isSample = useAppStore((s) => s.source?.kind === 'sample');
  const boreholes = useAppStore((s) => s.boreholes);
  const reviewPage = useAppStore((s) => s.reviewPage);
  const setReviewPage = useAppStore((s) => s.setReviewPage);
  const confirmOpen = useAppStore((s) => s.confirmCleanOpen);
  const askClean = useAppStore((s) => s.askClean);
  const approveClean = useAppStore((s) => s.approveClean);
  const cancelClean = useAppStore((s) => s.cancelClean);
  const openBorehole = useAppStore((s) => s.openBorehole);
  const openReview = useAppStore((s) => s.openReview);

  const cleanRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

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
  const clean = cleanKeys(b).length;
  const pct = total ? Math.round((approved / total) * 100) : 0;
  const idx = sibs.findIndex((x) => x.uid === b.uid);
  const prev = idx > 0 ? sibs[idx - 1] : undefined;
  const next = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : undefined;
  const subtitle = `${doc?.name ?? b.sourceFile} · ${doc?.project ?? b.project}${isSample ? ' (fictional)' : ''}`;
  const title = `REVIEW · ${b.id}`;
  // One tab is in the tab order: the shown sheet, else the first (a page outside the sheets).
  const current = Math.max(0, sheets.indexOf(reviewPage));

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!TAB_KEYS.has(e.key) || !sheets.length) return;
    e.preventDefault();
    const last = sheets.length - 1;
    const i =
      e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'ArrowRight' ? (current + 1) % sheets.length : (current + last) % sheets.length;
    setReviewPage(sheets[i]);
    tabRefs.current[i]?.focus();
  };

  return (
    <div className={styles.header}>
      <div className={styles.titleBlock}>
        <h1 className={styles.title} title={title}>
          {title}
        </h1>
        <div className={styles.subtitle} title={subtitle}>
          {subtitle}
        </div>
      </div>

      {sibs.length > 1 && idx >= 0 && (
        <div className={styles.switcher} role="group" aria-label="Borehole in this report">
          <button
            type="button"
            className={styles.switchBtn}
            disabled={!prev}
            title={prev ? `Previous borehole: ${prev.id}` : undefined}
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
            title={next ? `Next borehole: ${next.id}` : undefined}
            aria-label="Next borehole"
            onClick={() => next && openReview(next.uid)}
          >
            ›
          </button>
        </div>
      )}

      <div className={styles.tabs} role="tablist" aria-label="Log sheets" onKeyDown={onTabKey}>
        {sheets.map((p, i) => (
          <button
            key={p}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={reviewPage === p}
            aria-controls={SCAN_PANE_ID}
            tabIndex={i === current ? 0 : -1}
            className={`${styles.tab} ${reviewPage === p ? styles.tabActive : ''}`}
            onClick={() => setReviewPage(p)}
          >
            {`SHEET ${i + 1} · p.${p}`}
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
        › OPEN DETAIL
      </button>

      <div ref={cleanRef} className={styles.cleanWrap}>
        <button
          type="button"
          className={styles.cleanBtn}
          disabled={!clean}
          aria-expanded={confirmOpen && clean > 0}
          title={clean ? undefined : 'No clean values left: every Read value without lint, flag or state is approved'}
          onClick={askClean}
        >
          APPROVE ALL CLEAN ({clean})
        </button>
        {confirmOpen && clean > 0 && (
          <Popover width={300} label="Approve clean values" className={styles.confirm}>
            <div className={styles.confirmTitle}>Approve {clean} clean values?</div>
            <div className={styles.confirmText}>
              Only values with method Read, no flag, no lint warning and no special state.
            </div>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.approveBtn} onClick={approveClean} autoFocus>
                APPROVE
              </button>
              <button type="button" className={styles.cancelBtn} onClick={cancelClean}>
                CANCEL
              </button>
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}
