import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScanPage } from '../../components/ScanPage';
import scanStyles from '../../components/ScanPage.module.css';
import { fromOtherDocument } from '../../domain/review';
import { PAGE_H, PAGE_W, type Borehole } from '../../domain/types';
import { useT } from '../../i18n';
import { useAppStore, usePage } from '../../store/appStore';
import { fill } from './fill';
import styles from './ReviewScreen.module.css';
import { SCAN_PANE_ID, scanBoxes, scanCaption, scanScale, sheetPages } from './reviewView';

/** Distance (px) kept between the focused box and the top of the pane when scrolling to it (prototype: 200). */
const SCROLL_OFFSET = 200;

/** Box styles explained in the caption bar, drawn with the scan's own box classes. */
const LEGEND = [
  { variant: 'idle', label: 'unreviewed' },
  { variant: 'approved', label: 'approved' },
  { variant: 'flagged', label: 'flagged' },
  { variant: 'lint', label: 'lint' },
] as const;

/**
 * Left half of the Review screen (frontend_din look): a sticky caption bar (page and sheet, or "box
 * not found, page shown", plus the box legend) above the scanned page with clickable value boxes
 * styled by state. The page scales with the pane's width; auto-scroll to the focused box follows the
 * scaled page. A borehole without pages, or a spreadsheet source, says so instead of showing a page.
 */
export function ScanPane({ b }: { b: Borehole }) {
  const t = useT();
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
  const barRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const shown = useRef<{ uid: string; page: number | null } | null>(null);
  const [scale, setScale] = useState(1);

  // Fit the page to the pane: measured before paint, then on every resize.
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane) return;
    const fit = () => setScale(scanScale(pane.clientWidth));
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  const boxes = useMemo(
    () => scanBoxes(b, reviewPage, focusKey, (key) => focusValue(key, true)),
    [b, reviewPage, focusKey, focusValue],
  );
  const focused = b.values.find((v) => v.key === focusKey);
  const caption = scanCaption(reviewPage, sheets, focused, !!focused && fromOtherDocument(b, focused), t);
  const focusBox = focused && !fromOtherDocument(b, focused) && focused.page === reviewPage ? focused.box : null;

  // Bring the focused box into view below the caption bar; a new page or borehole starts at the top.
  // The page element is measured, so its height already includes the scale.
  useEffect(() => {
    const pane = ref.current;
    const pageEl = pageRef.current?.firstElementChild as HTMLElement | null | undefined;
    if (!pane || !pageEl || !content) return;
    const prev = shown.current;
    const fresh = !prev || prev.uid !== b.uid || prev.page !== reviewPage;
    shown.current = { uid: b.uid, page: reviewPage };
    if (!focusBox) {
      if (fresh) pane.scrollTop = 0;
      return;
    }
    const bar = barRef.current?.offsetHeight ?? 0;
    const top = pageRef.current!.offsetTop + focusBox.y * pageEl.offsetHeight;
    const bottom = top + focusBox.h * pageEl.offsetHeight;
    const visible = top >= pane.scrollTop + bar + 8 && bottom <= pane.scrollTop + pane.clientHeight - 8;
    if (fresh && top - SCROLL_OFFSET <= 0) pane.scrollTop = 0;
    else if (!visible) pane.scrollTo({ top: Math.max(0, top - SCROLL_OFFSET), behavior: fresh ? 'auto' : 'smooth' });
  }, [b.uid, reviewPage, focusKey, focusBox, content, scale]);

  const placeholderSize = { width: PAGE_W * scale, height: PAGE_H * scale };
  const showLegend = !cellsOnly && !noPage;

  return (
    <div ref={ref} id={SCAN_PANE_ID} className={styles.scan} aria-label={t('Source page')}>
      <div ref={barRef} className={styles.captionBar}>
        {/* as wide as the page, so caption and legend line up with its edges */}
        <div className={styles.captionInner} style={{ width: PAGE_W * scale }}>
          <span className={caption.tone === 'warn' ? styles.captionWarn : styles.caption}>{caption.text}</span>
          {showLegend && (
            <ul className={styles.legend} aria-label={t('Box legend')}>
              {LEGEND.map((l) => (
                <li key={l.variant} className={styles.legendItem}>
                  <span className={`${scanStyles.box} ${scanStyles[l.variant]} ${styles.swatch}`} aria-hidden="true" />
                  {t(l.label)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div ref={pageRef} className={styles.pageWrap}>
        {content && <ScanPage content={content} boxes={boxes} scale={scale} />}
        {page.status === 'loading' && (
          <div className={styles.pagePlaceholder} style={placeholderSize}>
            {fill(t('Loading page {page}…'), { page: reviewPage ?? '' })}
          </div>
        )}
        {cellsOnly && (
          <div className={styles.pagePlaceholder} style={placeholderSize}>
            {t('Spreadsheet source: each value names its cell (e.g. Sheet!C5) next to its label. There is no page image.')}
          </div>
        )}
        {noPage && (
          <div className={styles.pagePlaceholder} style={placeholderSize}>
            {t('No source page for this borehole.')}
          </div>
        )}
        {page.status === 'error' && !cellsOnly && !noPage && (
          <div className={`${styles.pagePlaceholder} ${styles.pageError}`} style={placeholderSize} role="alert">
            {b.documentId ? page.error : t('No source document for this borehole')}
          </div>
        )}
      </div>
    </div>
  );
}
