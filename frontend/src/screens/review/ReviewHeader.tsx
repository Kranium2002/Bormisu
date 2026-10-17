import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { questionsOfBorehole } from '../../components/clarify/clarifyModel';
import { QuestionsButton } from '../../components/clarify/QuestionsButton';
import { Popover } from '../../components/Popover';
import { progress } from '../../domain/review';
import { CLEAN_CONFIDENCE } from '../../domain/status';
import type { Borehole } from '../../domain/types';
import { useT } from '../../i18n';
import { sheetPath } from '../../routing/urlState';
import { useAppStore, useDocument } from '../../store/appStore';
import { fill, plural } from './fill';
import styles from './ReviewScreen.module.css';
import { cleanCountOf, SCAN_PANE_ID, sheetPages, sheetTabText, siblings } from './reviewView';

/** Keys that move between the sheet tabs (roving tabindex, WAI-ARIA tabs pattern). */
const TAB_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/**
 * The borehole's unresolved questions as a badge that opens the first one: from the loaded list, else
 * the count on the record (then the badge opens the inbox). Nothing when there is none.
 */
function BoreholeQuestions({ b }: { b: Borehole }) {
  const t = useT();
  const list = useAppStore((s) => s.clarifications);
  const listed = useMemo(() => questionsOfBorehole(list, b.uid), [list, b.uid]);
  const n = listed.length || b.openClarifications;
  if (n <= 0) return null;
  // Open questions before skipped ones, like the document cards.
  const first = (listed.find((c) => c.status === 'open') ?? listed[0])?.id ?? null;
  return <QuestionsButton text={plural(n, '{n} open question', '{n} open questions', t)} questionId={first} about={t('this borehole')} />;
}

/**
 * Review header (frontend_din look): REVIEW · ID with file · project, borehole switcher (x / N),
 * sheet tabs (arrow keys move between them), "N of M values reviewed", the borehole's open questions,
 * SHEET › (the printable sheet), › OPEN DETAIL and APPROVE ALL CLEAN (n) with its confirm popover.
 * The count on the button is the clean values of the document's loaded boreholes; the source counts
 * the whole document (a dry run) before anything is approved.
 */
export function ReviewHeader({ b }: { b: Borehole }) {
  const t = useT();
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
  const cleanButton = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** The confirmation was open (or approving) at the last render: its closing gives the focus back. */
  const wasOpen = useRef(false);

  // A click outside the confirm popover cancels it (Escape is handled by the store).
  useEffect(() => {
    if (!confirmOpen) return;
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !cleanRef.current?.contains(e.target)) cancelClean();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [confirmOpen, cancelClean]);

  // When the confirmation closes (Escape, Cancel, APPROVE) with the focus left on nothing, the focus
  // goes back to APPROVE ALL CLEAN, so a keyboard user keeps their place.
  useEffect(() => {
    const open = confirmOpen || cleanBusy;
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (!active || active === document.body) cleanButton.current?.focus();
    }
    wasOpen.current = open;
  }, [confirmOpen, cleanBusy]);

  const sheets = useMemo(() => sheetPages(b), [b]);
  const sibs = useMemo(() => siblings(boreholes, b), [boreholes, b]);
  const clean = useMemo(() => cleanCountOf(boreholes, b), [boreholes, b]);
  const { approved, total } = progress(b);
  const pct = total ? Math.round((approved / total) * 100) : 0;
  const idx = sibs.findIndex((x) => x.uid === b.uid);
  const prev = idx > 0 ? sibs[idx - 1] : undefined;
  const next = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : undefined;
  const fileName = doc?.name ?? b.sourceFile;
  const subtitle = `${fileName} · ${doc?.project ?? b.project}${isSample ? ` ${t('(fictional)')}` : ''}`;
  const title = `${t('REVIEW')} · ${b.id}`;
  const cleanDisabledReason = !b.documentId
    ? t('No source document for this borehole')
    : cleanBusy
      ? t('Approving clean values…')
      : undefined;
  // One tab is in the tab order: the shown sheet, else the first (a page outside the sheets).
  const current = Math.max(0, reviewPage == null ? 0 : sheets.indexOf(reviewPage));

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
        <div className={styles.switcher} role="group" aria-label={t('Borehole in this report')}>
          <button
            type="button"
            className={styles.switchBtn}
            disabled={!prev}
            title={prev ? fill(t('Previous borehole: {id}'), { id: prev.id }) : t('This is the first borehole of the report')}
            aria-label={t('Previous borehole')}
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
            title={next ? fill(t('Next borehole: {id}'), { id: next.id }) : t('This is the last borehole of the report')}
            aria-label={t('Next borehole')}
            onClick={() => next && openReview(next.uid)}
          >
            ›
          </button>
        </div>
      )}

      <div className={styles.tabs} role="tablist" aria-label={t('Log sheets')} onKeyDown={onTabKey}>
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
            {sheetTabText(i, p, t)}
          </button>
        ))}
      </div>

      <div className={styles.progress}>
        <span className={styles.progressText}>{fill(t('{n} of {total} values reviewed'), { n: approved, total })}</span>
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-label={t('Values reviewed')}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={approved}
        >
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <BoreholeQuestions b={b} />

      <Link className={styles.sheetLink} to={sheetPath(b.uid)} title={t('The borehole sheet, ready to print')}>
        {t('SHEET ›')}
      </Link>

      <button type="button" className={styles.detailBtn} onClick={() => openBorehole(b.uid)}>
        {t('› OPEN DETAIL')}
      </button>

      <div ref={cleanRef} className={styles.cleanWrap}>
        <button
          ref={cleanButton}
          type="button"
          className={styles.cleanBtn}
          disabled={!!cleanDisabledReason}
          aria-expanded={confirmOpen}
          title={cleanDisabledReason ?? fill(t('Approve every clean value of {file}'), { file: fileName })}
          onClick={() => void askClean()}
        >
          {cleanBusy ? t('APPROVING…') : `${t('APPROVE ALL CLEAN')} (${clean})`}
        </button>
        {confirmOpen && (
          <Popover width={320} label={t('Approve clean values')} className={styles.confirm}>
            {/* One live region for the whole exchange, so the count of the dry run is announced when it arrives. */}
            <div className={styles.confirmLive} aria-live="polite" aria-atomic="true">
              {cleanCount === null ? (
                <div className={styles.confirmText}>{fill(t('Counting the clean values of {file}…'), { file: fileName })}</div>
              ) : cleanCount === 0 ? (
                <>
                  <div className={styles.confirmTitle}>{t('No clean values')}</div>
                  <div className={styles.confirmText}>{fill(t('Nothing left to approve at once in {file}.'), { file: fileName })}</div>
                </>
              ) : (
                <>
                  <div className={styles.confirmTitle}>
                    {fill(t(cleanCount === 1 ? 'Approve {n} clean value in {file}?' : 'Approve {n} clean values in {file}?'), {
                      n: cleanCount,
                      file: fileName,
                    })}
                  </div>
                  <div className={styles.confirmText}>
                    {fill(
                      t(
                        'Unreviewed values with a source reference, no flag, no lint and no special state, read from the text layer or OCRed with at least {pct} % confidence.',
                      ),
                      { pct: Math.round(CLEAN_CONFIDENCE * 100) },
                    )}
                  </div>
                </>
              )}
            </div>
            {cleanCount === 0 && (
              <div className={styles.confirmActions}>
                <button type="button" className={styles.cancelBtn} onClick={cancelClean} autoFocus>
                  {t('CLOSE')}
                </button>
              </div>
            )}
            {cleanCount !== null && cleanCount > 0 && (
              <div className={styles.confirmActions}>
                <button type="button" className={styles.approveBtn} onClick={() => void approveClean()} autoFocus>
                  {t('APPROVE')}
                </button>
                <button type="button" className={styles.cancelBtn} onClick={cancelClean}>
                  {t('CANCEL')}
                </button>
              </div>
            )}
          </Popover>
        )}
      </div>
    </div>
  );
}
