import { useEffect, useMemo, useRef } from 'react';
import { ScanPage } from '../../components/ScanPage';
import { fromOtherDocument } from '../../domain/review';
import type { Borehole } from '../../domain/types';
import { useAppStore, usePage } from '../../store/appStore';
import styles from './ReviewScreen.module.css';
import { scanBoxes, scanCaption, sheetPages } from './reviewView';

/** Distance (px) kept between the focused box and the top of the pane when scrolling to it (prototype: 200). */
const SCROLL_OFFSET = 200;

/**
 * Left half of the Review screen: the scanned page with clickable value boxes styled by state,
 * auto-scroll to the focused box, and the caption ("box not found, page shown"). A borehole without
 * pages says so instead of showing a page.
 */
export function ScanPane({ b }: { b: Borehole }) {
  // The page Review chose; else the borehole's first page; null for a borehole without pages.
  const reviewPage = useAppStore((s) => s.reviewPage) ?? b.primaryPage;
  const focusKey = useAppStore((s) => s.focusKey);
  const focusValue = useAppStore((s) => s.focusValue);
  const sheets = useMemo(() => sheetPages(b), [b]);
  // A spreadsheet's values point at cells: there is no page image to show.
  const cellsOnly = sheets.length === 0 && b.values.some((v) => v.cell);
  const noPage = !cellsOnly && !!b.documentId && reviewPage == null;
  const page = usePage(cellsOnly ? null : b.documentId, reviewPage);
  const content = page.status === 'ready' ? page.content : null;
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef<{ uid: string; page: number | null } | null>(null);

  const boxes = useMemo(
    () => scanBoxes(b, reviewPage, focusKey, (key) => focusValue(key, true)),
    [b, reviewPage, focusKey, focusValue],
  );
  const focused = b.values.find((v) => v.key === focusKey);
  const caption = scanCaption(reviewPage, sheets, focused, !!focused && fromOtherDocument(b, focused));
  const focusBox = focused && !fromOtherDocument(b, focused) && focused.page === reviewPage ? focused.box : null;

  // Bring the focused box into view; a new page or borehole starts at the top.
  useEffect(() => {
    const pane = ref.current;
    const pageEl = pane?.firstElementChild as HTMLElement | null;
    if (!pane || !pageEl || !content) return;
    const prev = shown.current;
    const fresh = !prev || prev.uid !== b.uid || prev.page !== reviewPage;
    shown.current = { uid: b.uid, page: reviewPage };
    if (!focusBox) {
      if (fresh) pane.scrollTop = 0;
      return;
    }
    const top = pageEl.offsetTop + focusBox.y * pageEl.offsetHeight;
    const bottom = top + focusBox.h * pageEl.offsetHeight;
    const visible = top >= pane.scrollTop + 8 && bottom <= pane.scrollTop + pane.clientHeight - 8;
    if (fresh && top - SCROLL_OFFSET <= 0) pane.scrollTop = 0;
    else if (!visible) pane.scrollTo({ top: Math.max(0, top - SCROLL_OFFSET), behavior: fresh ? 'auto' : 'smooth' });
  }, [b.uid, reviewPage, focusKey, focusBox, content]);

  return (
    <div ref={ref} className={styles.scan} aria-label="Source page">
      {content && <ScanPage content={content} boxes={boxes} />}
      {page.status === 'loading' && <div className={styles.pagePlaceholder}>Loading page {reviewPage}…</div>}
      {cellsOnly && (
        <div className={styles.pagePlaceholder}>
          Spreadsheet source: each value names its cell (e.g. Sheet!C5) next to its label. There is no page image.
        </div>
      )}
      {noPage && <div className={styles.pagePlaceholder}>No source page for this borehole.</div>}
      {page.status === 'error' && !cellsOnly && !noPage && (
        <div className={`${styles.pagePlaceholder} ${styles.pageError}`} role="alert">
          {b.documentId ? page.error : 'No source document for this borehole'}
        </div>
      )}
      <div className={`${styles.caption} ${caption.tone === 'warn' ? styles.captionWarn : ''}`}>{caption.text}</div>
    </div>
  );
}
