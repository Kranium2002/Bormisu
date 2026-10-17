import { useEffect, useRef, useState, type FormEvent } from 'react';
import { certaintyOf } from '../domain/certainty';
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
import { useT } from '../i18n';
import { PAGE_TYPE_META, pageMeta } from '../theme';
import { CertaintyMark } from './CertaintyMark';
import { ScanPage } from './ScanPage';
import { OriginalLabel } from './SideLabel';
import { SourceStepper } from './SourceStepper';
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
 * A field to correct the value right next to its scan: a changed text becomes the value (SAVE), the
 * same text confirms it (CONFIRM); both count as reviewed, so its dot turns green. A value the backend
 * sets elsewhere (readOnlyReason) can only be confirmed, and says why.
 */
function CorrectValue({ value, onCorrect }: { value: ExtractedValue; onCorrect(text: string): void }) {
  const t = useT();
  const [text, setText] = useState(value.value);
  const readOnly = !!value.readOnlyReason;
  const changed = !readOnly && text.trim() !== value.value;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onCorrect(readOnly ? value.value : text);
  };
  return (
    <form className={styles.correct} onSubmit={submit}>
      <div className={styles.correctRow}>
        <input
          className={styles.correctInput}
          value={readOnly ? value.value : text}
          readOnly={readOnly}
          onChange={(e) => setText(e.target.value)}
          aria-label={`${t('Corrected value for')} ${value.label}`}
          placeholder={value.state === 'ok' ? '' : t(value.state)}
        />
        {value.unit && <span className={styles.correctUnit}>{value.unit}</span>}
        <button type="submit" className={changed ? styles.correctSave : styles.correctConfirm}>
          {changed ? t('SAVE') : t('CONFIRM')}
        </button>
      </div>
      {readOnly && <div className={styles.correctNote}>{value.readOnlyReason}</div>}
    </form>
  );
}

/** Why a value can't be corrected in the document view; null when it can. */
export function correctionBlocked(value: Pick<ExtractedValue, 'hasProvenance'>): string | null {
  return value.hasProvenance ? null : 'No source reference from the backend: this value can’t be corrected here.';
}

/**
 * Source panel (the document view): the value's page with its box highlighted, the raw text, its
 * status dot and a field to correct or confirm it (see CorrectValue), in the
 * document the source is in (a value can come from another document than its borehole's, e.g. a lab
 * spreadsheet; the panel names that file). "Box not found: page shown" when the value has no box. A
 * spreadsheet value shows its cell reference ("Sheet!C5") instead of a page; a value on no page
 * (guessed, derived) says so and shows none, as does a borehole without pages. OPEN IN REVIEW for
 * reviewable values.
 */
export function SourcePanel({ panel: opened }: { panel: SourcePanelState }) {
  const correctValue = useAppStore((s) => s.correctValue);
  // A value cited on several pages: the panel steps through them (‹ source 1 of N ›), back to the
  // first whenever another value opens.
  const [stop, setStop] = useState({ for: opened, index: 0 });
  const index = stop.for === opened ? stop.index : 0;
  const panel = sourceStop(opened, index);
  const value = useValue(panel.uid, panel.key);
  const borehole = useBorehole(panel.uid);
  const doc = useDocument(panel.documentId);
  const page = usePage(panel.cell ? null : panel.documentId, panel.page);
  const count = opened.sources?.length ?? 0;
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
      onCorrect={panel.uid && panel.key && !panel.pageOnly ? (text) => correctValue(panel.uid!, panel.key!, text) : undefined}
      stepper={count > 1 ? { index, count, onStep: (to) => setStop({ for: opened, index: to }) } : undefined}
    />
  );
}

/** The panel at source `index` of a value cited on several pages (its page and box there); the panel itself otherwise. */
export function sourceStop(panel: SourcePanelState, index: number): SourcePanelState {
  const s = panel.sources?.[index];
  return s ? { ...panel, page: s.page, box: s.box } : panel;
}

interface Stepper {
  /** 0-based source shown. */
  index: number;
  count: number;
  onStep(index: number): void;
}

interface ViewProps {
  panel: SourcePanelState;
  value: ExtractedValue | undefined;
  /** The document the panel shows, when the store has it. */
  doc: DocumentSummary | undefined;
  /** File name of the borehole's own document, when the panel shows that document. */
  ownFile?: string;
  page: PageLoad;
  /** Shown as OPEN FULL REVIEW › when the value can be reviewed. */
  onOpenInReview?: () => void;
  /** Saves a correction (or a confirmation) of the value; without it there is no field. */
  onCorrect?: (text: string) => void;
  /** A value cited on several pages: ‹ source i of N ›. */
  stepper?: Stepper;
}

/** What the Source panel shows, from the store's data (pure; rendered in tests without a store). */
export function SourcePanelView({ panel, value, doc, ownFile, page, onOpenInReview, onCorrect, stepper }: ViewProps) {
  const t = useT();
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
    // The page is the last child, under its ORIGINAL caption.
    const pageEl = el?.lastElementChild;
    if (!el || !pageEl || !content) return;
    const pageTop = pageEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const boxBottom = box ? pageTop + (box.y + box.h) * PAGE_H * SCALE : 0;
    el.scrollTop = box && boxBottom + 40 > el.clientHeight ? Math.max(0, pageTop + box.y * PAGE_H * SCALE - 160) : 0;
  }, [content, box]);

  // The value's label keeps its case ('SPT @ 10.50 m').
  const title = value ? value.label : panel.page != null ? `${t('page')} ${panel.page}` : t('no page');
  const blocked = value ? correctionBlocked(value) : null;
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
        <div className={styles.heading}>
          {t('SOURCE')} · <span className={styles.headingLabel}>{title}</span>
        </div>
        {label && <div className={styles.sub}>{label}</div>}
        <div className={styles.meta}>
          {value && <CertaintyMark certainty={certaintyOf(value)} />}
          {detail && <span className={styles.raw}>{detail}</span>}
        </div>
        {stepper && (
          <SourceStepper className={styles.stepper} index={stepper.index} count={stepper.count} page={panel.page} onStep={stepper.onStep} />
        )}
        {value && !box && !panel.cell && !onNoPage && (
          <div className={styles.noBox}>{stepper ? t('No box on this page') : t('Box not found: page shown')}</div>
        )}
        {value && onCorrect && !blocked && <CorrectValue key={`${panel.uid}:${value.key}`} value={value} onCorrect={onCorrect} />}
        {value && onCorrect && blocked && <div className={styles.correctNote}>{t(blocked)}</div>}
      </PanelHeader>
      {/* A tab stop of its own, so arrow keys scroll the page. */}
      <div ref={scrollRef} className={styles.scroll} role="region" aria-label="Source page" tabIndex={0}>
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
              <div className={styles.pageCaption}>
                <OriginalLabel file={doc?.name || ownFile} page={panel.page} />
              </div>
            )}
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
            {t('OPEN FULL REVIEW ›')}
          </button>
          <span className={styles.sub}>{t('Esc to close')}</span>
        </div>
      )}
    </>
  );
}
