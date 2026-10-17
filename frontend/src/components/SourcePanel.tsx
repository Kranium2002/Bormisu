import { useEffect, useRef } from 'react';
import { pageUsageText } from '../domain/pages';
import { PAGE_H, type DocumentSummary, type ExtractedValue } from '../domain/types';
import {
  useAppStore,
  useBorehole,
  useDocument,
  useIsReviewable,
  usePage,
  useValue,
  type PageLoad,
  type SourcePanel as SourcePanelState,
} from '../store/appStore';
import { PAGE_TYPE_META, pageMeta } from '../theme';
import { MethodBadge } from './MethodBadge';
import { ScanPage } from './ScanPage';
import { PanelHeader } from './PanelHeader';
import styles from './SidePanel.module.css';

/** The page is shown at 92 % so a 560 px page fits the 600 px panel. */
const SCALE = 0.92;

/** Why a value with a source entry has no page to show (guessed and derived values are not printed). */
export function noPageNote(value: Pick<ExtractedValue, 'method'> | undefined): string {
  if (value?.method === 'Guessed' || value?.method === 'Derived') {
    return `Not printed on a page: this value was ${value.method.toLowerCase()}, so there is no page to show.`;
  }
  return 'No page reference from the backend for this value.';
}

/**
 * Source panel: the value's page with its box highlighted, the raw text and the method, in the
 * document the source is in (a value can come from another document than its borehole's, e.g. a lab
 * spreadsheet; the panel names that file). "Box not found: page shown" when the value has no box. A
 * spreadsheet value shows its cell reference ("Sheet!C5") instead of a page; a value on no page
 * (guessed, derived) says so and shows none, as does a borehole without pages. OPEN IN REVIEW for
 * reviewable values.
 */
export function SourcePanel({ panel }: { panel: SourcePanelState }) {
  const value = useValue(panel.uid, panel.key);
  const borehole = useBorehole(panel.uid);
  const doc = useDocument(panel.documentId);
  const page = usePage(panel.cell ? null : panel.documentId, panel.page);
  const reviewable = useIsReviewable(panel.uid);
  const openReview = useAppStore((s) => s.openReview);
  const focusValue = useAppStore((s) => s.focusValue);
  const closePanel = useAppStore((s) => s.closePanel);
  // The borehole's own file names its document while that isn't loaded; another document has no name here.
  const ownFile = borehole && borehole.documentId === panel.documentId ? borehole.sourceFile : undefined;

  const openInReview = () => {
    if (!panel.uid || !panel.key) return;
    openReview(panel.uid);
    focusValue(panel.key, true);
    closePanel();
  };

  return (
    <SourcePanelView
      panel={panel}
      value={value}
      doc={doc}
      ownFile={ownFile}
      page={page}
      onOpenInReview={reviewable ? openInReview : undefined}
    />
  );
}

interface ViewProps {
  panel: SourcePanelState;
  value: ExtractedValue | undefined;
  /** The document the panel shows, when the store has it. */
  doc: DocumentSummary | undefined;
  /** File name of the borehole's own document, when the panel shows that document. */
  ownFile?: string;
  page: PageLoad;
  /** Shown as OPEN IN REVIEW when the value can be reviewed. */
  onOpenInReview?: () => void;
}

/** What the Source panel shows, from the store's data (pure; rendered in tests without a store). */
export function SourcePanelView({ panel, value, doc, ownFile, page, onOpenInReview }: ViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Neither a page nor a cell to show: a value on no page, or a borehole without pages. */
  const noPage = panel.page == null && !panel.cell;
  /** A value whose source entry names neither a page nor a cell. */
  const onNoPage = !!value && noPage;
  const content = page.status === 'ready' && !noPage ? page.content : null;
  const box = panel.box ?? null;
  const fileName = doc?.name || ownFile || 'another document';

  // Show the page from the top (sheet header in view) unless the box would be below the fold.
  useEffect(() => {
    const el = scrollRef.current;
    const pageEl = el?.firstElementChild;
    if (!el || !pageEl || !content) return;
    const pageTop = pageEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const boxBottom = box ? pageTop + (box.y + box.h) * PAGE_H * SCALE : 0;
    el.scrollTop = box && boxBottom + 40 > el.clientHeight ? Math.max(0, pageTop + box.y * PAGE_H * SCALE - 160) : 0;
  }, [content, box]);

  const title = value ? value.label.toUpperCase() : panel.page != null ? `PAGE ${panel.page}` : 'NO PAGE';
  const label = panel.cell
    ? `${fileName} · cell ${panel.cell}`
    : noPage
      ? fileName
      : (content?.label ?? `page ${panel.page} · ${fileName}`);
  const pageInfo = panel.page != null ? doc?.pages.find((p) => p.n === panel.page) : undefined;
  // Name and usage of the page as the document lists it; a page of type unknown is named only when
  // the document says whether it was classified.
  const kind = pageInfo ? pageMeta(pageInfo).name : content && content.type !== 'unknown' ? PAGE_TYPE_META[content.type].name : '';
  const detail = value
    ? value.raw && `as printed: “${value.raw}”`
    : content && [kind, pageInfo ? pageUsageText(pageInfo) : content.usage].filter(Boolean).join(' · ');

  return (
    <>
      <PanelHeader>
        <div className={styles.heading}>SOURCE · {title}</div>
        {label && <div className={styles.sub}>{label}</div>}
        <div className={styles.meta}>
          {value?.method && <MethodBadge method={value.method} confidence={value.confidence} formula={value.formula} />}
          {detail && <span className={styles.raw}>{detail}</span>}
        </div>
        {value && !box && !panel.cell && !onNoPage && <div className={styles.noBox}>Box not found: page shown</div>}
      </PanelHeader>
      <div ref={scrollRef} className={styles.scroll}>
        {panel.cell ? (
          <div className={styles.cellSource}>
            <div className={styles.cellRef}>{panel.cell}</div>
            <div className={styles.status}>Spreadsheet value: the source is this cell, so there is no page image.</div>
          </div>
        ) : noPage ? (
          <div className={styles.cellSource}>
            <div className={styles.status}>{onNoPage ? noPageNote(value) : 'No source page for this borehole.'}</div>
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
      {value && onOpenInReview && (
        <div className={styles.foot}>
          <button type="button" className={styles.primary} onClick={onOpenInReview}>
            OPEN IN REVIEW
          </button>
          <span className={styles.sub}>Esc to close</span>
        </div>
      )}
    </>
  );
}
