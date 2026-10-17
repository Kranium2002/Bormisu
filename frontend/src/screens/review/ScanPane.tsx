import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScanPage } from '../../components/ScanPage';
import scanStyles from '../../components/ScanPage.module.css';
import { PAGE_H, PAGE_W, type Borehole } from '../../domain/types';
import { useAppStore, usePage } from '../../store/appStore';
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
 * Left half of the Review screen: a sticky caption bar (page and sheet, or "box not found, page
 * shown", plus the box legend) above the scanned page with clickable value boxes styled by state.
 * The page scales with the pane's width; auto-scroll to the focused box follows the scaled page.
 */
export function ScanPane({ b }: { b: Borehole }) {
  const reviewPage = useAppStore((s) => s.reviewPage);
  const focusKey = useAppStore((s) => s.focusKey);
  const focusValue = useAppStore((s) => s.focusValue);
  const page = usePage(b.documentId, reviewPage);
  const content = page.status === 'ready' ? page.content : null;
  const ref = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const shown = useRef<{ uid: string; page: number } | null>(null);
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

  const sheets = useMemo(() => sheetPages(b), [b]);
  const boxes = useMemo(
    () => scanBoxes(b, reviewPage, focusKey, (key) => focusValue(key, true)),
    [b, reviewPage, focusKey, focusValue],
  );
  const focused = b.values.find((v) => v.key === focusKey);
  const caption = scanCaption(reviewPage, sheets, focused);
  const focusBox = focused?.page === reviewPage ? focused.box : null;

  // Bring the focused box into view below the caption bar; a new page or borehole starts at the top.
  // The page element is measured, so its height already includes the scale.
  useEffect(() => {
    const pane = ref.current;
    const pageEl = pageRef.current;
    if (!pane || !pageEl || !content) return;
    const prev = shown.current;
    const fresh = !prev || prev.uid !== b.uid || prev.page !== reviewPage;
    shown.current = { uid: b.uid, page: reviewPage };
    if (!focusBox) {
      if (fresh) pane.scrollTop = 0;
      return;
    }
    const bar = barRef.current?.offsetHeight ?? 0;
    const top = pageEl.offsetTop + focusBox.y * pageEl.offsetHeight;
    const bottom = top + focusBox.h * pageEl.offsetHeight;
    const visible = top >= pane.scrollTop + bar + 8 && bottom <= pane.scrollTop + pane.clientHeight - 8;
    if (fresh && top - SCROLL_OFFSET <= 0) pane.scrollTop = 0;
    else if (!visible) pane.scrollTo({ top: Math.max(0, top - SCROLL_OFFSET), behavior: fresh ? 'auto' : 'smooth' });
  }, [b.uid, reviewPage, focusKey, focusBox, content, scale]);

  const placeholderSize = { width: PAGE_W * scale, height: PAGE_H * scale };

  return (
    <div ref={ref} id={SCAN_PANE_ID} className={styles.scan} aria-label="Source page">
      <div ref={barRef} className={styles.captionBar}>
        {/* as wide as the page, so caption and legend line up with its edges */}
        <div className={styles.captionInner} style={{ width: PAGE_W * scale }}>
          <span className={caption.tone === 'warn' ? styles.captionWarn : styles.caption}>{caption.text}</span>
          <ul className={styles.legend} aria-label="Box legend">
            {LEGEND.map((l) => (
              <li key={l.variant} className={styles.legendItem}>
                <span className={`${scanStyles.box} ${scanStyles[l.variant]} ${styles.swatch}`} aria-hidden="true" />
                {l.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div ref={pageRef} className={styles.pageWrap}>
        {content && <ScanPage content={content} boxes={boxes} scale={scale} />}
        {page.status === 'loading' && (
          <div className={styles.pagePlaceholder} style={placeholderSize}>
            Loading page {reviewPage}…
          </div>
        )}
        {page.status === 'error' && (
          <div className={`${styles.pagePlaceholder} ${styles.pageError}`} style={placeholderSize} role="alert">
            {b.documentId ? page.error : 'No source document for this borehole'}
          </div>
        )}
      </div>
    </div>
  );
}
