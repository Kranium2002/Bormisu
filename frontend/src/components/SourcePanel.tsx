import { useEffect, useRef } from 'react';
import { pageUsageText } from '../domain/pages';
import { PAGE_H } from '../domain/types';
import { useAppStore, useDocument, useIsReviewable, usePage, useValue, type SourcePanel as SourcePanelState } from '../store/appStore';
import { PAGE_TYPE_META } from '../theme';
import { MethodBadge } from './MethodBadge';
import { ScanPage } from './ScanPage';
import { PanelHeader } from './PanelHeader';
import styles from './SidePanel.module.css';

/** The page is shown at 92 % so a 560 px page fits the 600 px panel. */
const SCALE = 0.92;

/**
 * Source panel: the value's page with its box highlighted, the raw text and the method.
 * "Box not found: page shown" when the value has no box. A spreadsheet value shows its cell
 * reference ("Sheet!C5") instead of a page. OPEN IN REVIEW for reviewable values.
 */
export function SourcePanel({ panel }: { panel: SourcePanelState }) {
  const value = useValue(panel.uid, panel.key);
  const doc = useDocument(panel.documentId);
  const page = usePage(panel.cell ? null : panel.documentId, panel.page);
  const reviewable = useIsReviewable(panel.uid);
  const openReview = useAppStore((s) => s.openReview);
  const focusValue = useAppStore((s) => s.focusValue);
  const closePanel = useAppStore((s) => s.closePanel);
  const scrollRef = useRef<HTMLDivElement>(null);
  const content = page.status === 'ready' ? page.content : null;
  const box = panel.box ?? null;

  // Show the page from the top (sheet header in view) unless the box would be below the fold.
  useEffect(() => {
    const el = scrollRef.current;
    const pageEl = el?.firstElementChild;
    if (!el || !pageEl || !content) return;
    const pageTop = pageEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const boxBottom = box ? pageTop + (box.y + box.h) * PAGE_H * SCALE : 0;
    el.scrollTop = box && boxBottom + 40 > el.clientHeight ? Math.max(0, pageTop + box.y * PAGE_H * SCALE - 160) : 0;
  }, [content, box]);

  const title = value ? value.label.toUpperCase() : `PAGE ${panel.page ?? ''}`.trim();
  const label = panel.cell
    ? `${doc?.name ?? 'spreadsheet'} · cell ${panel.cell}`
    : (content?.label ?? `page ${panel.page}`);
  const pageInfo = panel.page != null ? doc?.pages.find((p) => p.n === panel.page) : undefined;
  const detail = value
    ? value.raw && `as printed: “${value.raw}”`
    : content && `${PAGE_TYPE_META[content.type].name} · ${pageInfo ? pageUsageText(pageInfo) : content.usage}`;

  const openInReview = () => {
    if (!panel.uid || !panel.key) return;
    openReview(panel.uid);
    focusValue(panel.key, true);
    closePanel();
  };

  return (
    <>
      <PanelHeader>
        <div className={styles.heading}>SOURCE · {title}</div>
        <div className={styles.sub}>{label}</div>
        <div className={styles.meta}>
          {value?.method && <MethodBadge method={value.method} confidence={value.confidence} formula={value.formula} />}
          {detail && <span className={styles.raw}>{detail}</span>}
        </div>
        {value && !box && !panel.cell && <div className={styles.noBox}>Box not found: page shown</div>}
      </PanelHeader>
      <div ref={scrollRef} className={styles.scroll}>
        {panel.cell ? (
          <div className={styles.cellSource}>
            <div className={styles.cellRef}>{panel.cell}</div>
            <div className={styles.status}>Spreadsheet value: the source is this cell, so there is no page image.</div>
          </div>
        ) : (
          <>
            {page.status === 'loading' && <div className={styles.status}>Loading page {panel.page}…</div>}
            {page.status === 'error' && <div className={styles.error}>{page.error}</div>}
            {content && (
              <ScanPage
                content={content}
                scale={SCALE}
                boxes={box ? [{ id: 'source', box, variant: 'highlight', title: value?.label }] : []}
              />
            )}
          </>
        )}
      </div>
      {value && reviewable && (
        <div className={styles.foot}>
          <button type="button" className={styles.primary} onClick={openInReview}>
            OPEN IN REVIEW
          </button>
          <span className={styles.sub}>Esc to close</span>
        </div>
      )}
    </>
  );
}
