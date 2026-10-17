import { useEffect, useRef } from 'react';
import { useAppStore, useIsReviewable, usePage, useValue, type SourcePanel as SourcePanelState } from '../store/appStore';
import { PAGE_TYPE_META } from '../theme';
import { certaintyOf } from '../domain/certainty';
import { CertaintyMark } from './CertaintyMark';
import { ScanPage } from './ScanPage';
import { PanelHeader } from './PanelHeader';
import styles from './SidePanel.module.css';

/** The page is shown at 92 % so a 560 px page fits the 600 px panel. */
const SCALE = 0.92;

/**
 * Source panel: the value's page with its box highlighted, the raw text and the method.
 * "Box not found: page shown" when the value has no box. OPEN IN REVIEW for reviewable values.
 */
export function SourcePanel({ panel }: { panel: SourcePanelState }) {
  const value = useValue(panel.uid, panel.key);
  const page = usePage(panel.documentId, panel.page);
  const reviewable = useIsReviewable(panel.uid);
  const openReview = useAppStore((s) => s.openReview);
  const focusValue = useAppStore((s) => s.focusValue);
  const closePanel = useAppStore((s) => s.closePanel);
  const scrollRef = useRef<HTMLDivElement>(null);
  const content = page.status === 'ready' ? page.content : null;
  const box = panel.box ?? null;

  // Show the page from the top (sheet header in view) unless the box would be below the fold.
  // Box positions are fractions of the page as rendered, so an API image places again once it has
  // loaded and has its real height.
  useEffect(() => {
    const el = scrollRef.current;
    const pageEl = el?.firstElementChild;
    if (!el || !pageEl || !content) return;
    const place = () => {
      const rect = pageEl.getBoundingClientRect();
      const pageTop = rect.top - el.getBoundingClientRect().top + el.scrollTop;
      const boxBottom = box ? pageTop + (box.y + box.h) * rect.height : 0;
      el.scrollTop = box && boxBottom + 40 > el.clientHeight ? Math.max(0, pageTop + box.y * rect.height - 160) : 0;
    };
    place();
    const img = pageEl.querySelector('img');
    if (!img || img.complete) return;
    img.addEventListener('load', place, { once: true });
    return () => img.removeEventListener('load', place);
  }, [content, box]);

  // The value's label keeps its case ('SPT @ 10.50 m'); page refs are lowercase.
  const title = value ? value.label : `page ${panel.page}`;
  const label = content?.label ?? `page ${panel.page}`;
  const detail = value
    ? value.raw && `as printed: “${value.raw}”`
    : content && `${PAGE_TYPE_META[content.type].name} · ${content.usage}`;

  const openInReview = () => {
    if (!panel.uid || !panel.key) return;
    openReview(panel.uid);
    focusValue(panel.key, true);
    closePanel();
  };

  return (
    <>
      <PanelHeader>
        <div className={styles.heading}>
          SOURCE · <span className={styles.headingLabel}>{title}</span>
        </div>
        <div className={styles.sub}>{label}</div>
        <div className={styles.meta}>
          {value && <CertaintyMark certainty={certaintyOf(value)} />}
          {detail && <span className={styles.raw}>{detail}</span>}
        </div>
        {value && !box && <div className={styles.noBox}>Box not found: page shown</div>}
      </PanelHeader>
      {/* A tab stop of its own, so the panel's focus trap includes it and arrow keys scroll the page. */}
      <div ref={scrollRef} className={styles.scroll} role="region" aria-label="Source page" tabIndex={0}>
        {page.status === 'loading' && <div className={styles.status}>Loading page {panel.page}…</div>}
        {page.status === 'error' && <div className={styles.error}>{page.error}</div>}
        {content && (
          <ScanPage
            content={content}
            scale={SCALE}
            boxes={box ? [{ id: 'source', box, variant: 'highlight', title: value?.label }] : []}
          />
        )}
      </div>
      {value && reviewable && (
        <div className={styles.foot}>
          <button type="button" className={styles.primary} onClick={openInReview}>
            OPEN IN REVIEW ›
          </button>
        </div>
      )}
    </>
  );
}
