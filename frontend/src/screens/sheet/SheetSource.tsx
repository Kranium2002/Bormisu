/**
 * The uploaded original next to the generated sheet (/sheet/:uid), so a reviewer can check the
 * reconstruction against what was uploaded: left the RECONSTRUCTED sheet (from the extracted values),
 * right the ORIGINAL page as uploaded (the page image, at its true aspect ratio, never a drawing of
 * it), half and half at first. The pane opens on the borehole's first source page, with a strip of
 * its pages, zoom, and the boxes of the values on the page. Hovering (or focusing) a value on the
 * sheet shows its page and highlights its box; clicking pins it, so it stays when the pointer leaves.
 * A value read from another document offers "Open that page". The pane can be resized (drag the
 * handle, or ← → on it) and hidden; both are remembered in this browser. On a narrow screen it sits
 * under the page and starts hidden. Print keeps only the sheet.
 *
 * Its texts follow the app's UI language (useT), not the sheet's EN | DE.
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { ScanPage, type ScanBox } from '../../components/ScanPage';
import { originalLabel, OriginalLabel, ReconstructedLabel } from '../../components/SideLabel';
import { SourceStepper } from '../../components/SourceStepper';
import { useImageSize, useWidth } from '../../components/usePageSize';
import { PAGE_W, type Borehole } from '../../domain/types';
import { useT } from '../../i18n';
import { useAppStore, useDocument, usePage } from '../../store/appStore';
import { fitScale, neighbours, pageAspect, scaleOf, stepZoom, verifyPages, type Zoom } from '../verify/verifyModel';
import styles from './SheetSource.module.css';
import {
  canOpenOther,
  paneBoxes,
  paneMax,
  paneNote,
  paneTarget,
  paneView,
  paneWidth,
  PANE_MIN,
  PANE_STEP,
  readPaneLayout,
  shareOf,
  writePaneLayout,
  type PaneLayout,
} from './sourcePaneModel';

/** Below this viewport width the pane goes under the page (mirrored in the CSS). */
const NARROW = '(max-width: 899px)';
/** Width of the resize handle (px), mirrored in the CSS. */
const HANDLE = 8;
/** Padding of the page area in the pane (px), mirrored in the CSS. */
const PAD = 16;

const isNarrow = () => {
  try {
    return window.matchMedia(NARROW).matches;
  } catch {
    return false;
  }
};

/** The value under the pointer or focus on the sheet: the nearest element that names one. */
const keyAt = (target: EventTarget | null) =>
  target instanceof Element ? (target.closest('[data-value-key]')?.getAttribute('data-value-key') ?? null) : null;

interface SourceLink {
  /** The value the pane shows: hovered or focused, else pinned. */
  activeKey: string | null;
  /** The clicked value. */
  pinnedKey: string | null;
}

const SourceLinkContext = createContext<SourceLink | null>(null);

/** Which sheet value the original pane shows (null outside SheetWithSource): for the sheet's cells and rows. */
export const useSourceLink = () => useContext(SourceLinkContext);

/**
 * The sheet (`children`, the A4 page) on its desk, labelled RECONSTRUCTED, with the original pane
 * beside it. Elements of the sheet with `data-value-key` stand for a value: hovering, focusing or
 * clicking them drives the pane.
 */
export function SheetWithSource({ borehole: b, children }: { borehole: Borehole; children: ReactNode }) {
  const t = useT();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  // Source shown of a value cited on several pages; back to the first for another value.
  const [stop, setStop] = useState<{ key: string | null; index: number }>({ key: null, index: 0 });
  // The page picked in the strip (or the pinned value's), shown while no value is active.
  const [picked, setPicked] = useState<number | null>(null);
  // The value whose page in another document was opened ("Open that page").
  const [otherOpen, setOtherOpen] = useState<string | null>(null);
  const [layout, setLayout] = useState<PaneLayout>(() => readPaneLayout(isNarrow()));
  const reveal = useRef(false);
  const paneRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const available = Math.max(0, useWidth(bodyRef) - HANDLE);

  useEffect(() => writePaneLayout(layout, isNarrow()), [layout]);

  // On a narrow screen the pane is under the page: a clicked value scrolls it into view.
  useEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    if (isNarrow()) paneRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  });

  const activeKey = hoverKey ?? pinnedKey;
  const index = stop.key === activeKey ? stop.index : 0;

  const pin = (key: string) => {
    setPinnedKey(key);
    setStop({ key, index: 0 });
    const target = paneTarget(b, key, 0);
    if (target?.kind === 'page') setPicked(target.page);
    if (layout.collapsed) setLayout((l) => ({ ...l, collapsed: false }));
    reveal.current = true;
  };

  const onFocus = (e: FocusEvent) => {
    const key = keyAt(e.target);
    if (key) setHoverKey(key);
  };
  const onBlur = (e: FocusEvent) => {
    if (keyAt(e.target)) setHoverKey(null);
  };
  const onClick = (e: MouseEvent) => {
    const key = keyAt(e.target);
    if (key) pin(key);
  };

  const max = paneMax(available);
  const width = paneWidth(layout.share, available);

  return (
    <SourceLinkContext.Provider value={{ activeKey, pinnedKey }}>
      <div ref={bodyRef} className={styles.body}>
        <div
          className={styles.desk}
          onMouseOver={(e) => setHoverKey(keyAt(e.target))}
          onMouseLeave={() => setHoverKey(null)}
          onFocus={onFocus}
          onBlur={onBlur}
          onClick={onClick}
        >
          <div className={styles.deskHead}>
            <ReconstructedLabel />
          </div>
          {children}
        </div>
        {layout.collapsed ? (
          <button type="button" className={styles.rail} aria-expanded={false} onClick={() => setLayout((l) => ({ ...l, collapsed: false }))}>
            <span className={styles.railText}>{t('SHOW THE ORIGINAL')}</span>
          </button>
        ) : (
          <>
            <ResizeHandle width={width} max={max} onResize={(w) => setLayout((l) => ({ ...l, share: shareOf(w, available) }))} />
            <OriginalPane
              ref={paneRef}
              b={b}
              width={available > 0 ? width : `${layout.share * 100}%`}
              activeKey={activeKey}
              index={index}
              picked={picked}
              otherOpen={otherOpen != null && otherOpen === activeKey}
              onPick={(n) => {
                setPicked(n);
                setPinnedKey(null);
                setOtherOpen(null);
              }}
              onPin={pin}
              onStep={(i) => {
                setStop({ key: activeKey, index: i });
                const target = paneTarget(b, activeKey, i);
                if (target?.kind === 'page') setPicked(target.page);
              }}
              onOpenOther={() => setOtherOpen(activeKey)}
              onCollapse={() => setLayout((l) => ({ ...l, collapsed: true }))}
            />
          </>
        )}
      </div>
    </SourceLinkContext.Provider>
  );
}

/**
 * The handle between the sheet and the pane: drag it, or focus it and press ← (wider) / → (narrower),
 * Shift for bigger steps, Home / End for the narrowest / widest.
 */
function ResizeHandle({ width, max, onResize }: { width: number; max: number; onResize(width: number): void }) {
  const t = useT();
  const drag = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    // Dragging to the left widens the pane.
    if (drag.current) onResize(drag.current.width + drag.current.x - e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? PANE_STEP * 4 : PANE_STEP;
    const next =
      e.key === 'ArrowLeft' ? width + step : e.key === 'ArrowRight' ? width - step : e.key === 'Home' ? PANE_MIN : e.key === 'End' ? max : null;
    if (next == null) return;
    e.preventDefault();
    onResize(next);
  };

  return (
    <div
      className={styles.handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize the original page')}
      aria-valuenow={width}
      aria-valuemin={PANE_MIN}
      aria-valuemax={max}
      tabIndex={0}
      title={t('Drag, or use ← →, to resize')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

interface PaneProps {
  ref: Ref<HTMLElement>;
  b: Borehole;
  /** px, or a percentage of the row before it has been measured. */
  width: number | string;
  activeKey: string | null;
  /** Source shown of the active value (0-based). */
  index: number;
  picked: number | null;
  /** The active value's page in another document was opened. */
  otherOpen: boolean;
  /** A page picked in the strip or with ‹ ›. */
  onPick(page: number): void;
  /** A value's box clicked on the page. */
  onPin(key: string): void;
  onStep(index: number): void;
  onOpenOther(): void;
  onCollapse(): void;
}

/**
 * The pane: ORIGINAL · file, page n (as uploaded), the active value's label and raw text, page X of N
 * with ‹ ›, zoom, the value's sources (‹ source i of N ›), what it says instead of a box, the strip of
 * the borehole's pages and the uploaded page with the boxes. The page is the upload's page image
 * (ScanPage says when it is still loading or can't be loaded, and draws no boxes until it is there);
 * a page without an image is never drawn in its place. Only the fictional sample, which has no
 * uploads, draws its pages.
 */
function OriginalPane({ ref, b, width, activeKey, index, picked, otherOpen, onPick, onPin, onStep, onOpenOther, onCollapse }: PaneProps) {
  const t = useT();
  const source = useAppStore((s) => s.source);
  const target = paneTarget(b, activeKey, index);
  const active = target && activeKey ? b.values.find((v) => v.key === activeKey) : undefined;
  const view = paneView(b, target, picked, otherOpen);
  const doc = useDocument(view.documentId);
  const otherDoc = useDocument(target?.kind === 'otherDocument' ? target.documentId : null);
  const pages = verifyPages(b);
  const { prev, next } = view.other ? { prev: null, next: null } : neighbours(pages, view.page);
  const pageCount = doc?.pages.length || null;
  const load = usePage(view.documentId, view.page);
  const content = view.page != null && load.status === 'ready' ? load.content : null;
  const natural = useImageSize(content?.imageUrl);
  // The original is the uploaded page image. Only the sample (no uploads) draws its pages.
  const failed = load.status === 'error' || (!!content && !content.imageUrl && source?.kind !== 'sample');

  const scrollRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const inner = useWidth(scrollRef);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const fit = inner > 0 ? fitScale(inner - 2 * PAD) : 1;
  const scale = scaleOf(zoom, fit);
  // The page at its true aspect ratio once the image has loaded.
  const W = Math.floor(PAGE_W * scale);
  const H = Math.round(W * pageAspect(natural));

  const box = target?.kind === 'page' || target?.kind === 'otherDocument' ? target.box : null;
  const boxKey = box ? `${box.x}:${box.y}:${box.w}:${box.h}` : '';
  const note = paneNote(target, t, { docName: otherDoc?.name, otherShown: view.other });
  const boxes: ScanBox[] = failed
    ? []
    : paneBoxes(b, view, activeKey, target).map((p) => ({
        id: p.key,
        box: p.box,
        variant: p.variant,
        title: `${p.label} (${t('as printed')}): ${p.raw || '–'}`,
        onClick: p.variant === 'idle' ? () => onPin(p.key) : undefined,
      }));

  // Another page starts at the top left.
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0, left: 0 });
  }, [view.documentId, view.page]);

  // The highlighted box is scrolled into view when it is outside.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const paper = paperRef.current;
    if (!el || !paper || !box || !content) return;
    const top = paper.offsetTop + box.y * paper.offsetHeight;
    const bottom = paper.offsetTop + (box.y + box.h) * paper.offsetHeight;
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - 80);
    const left = paper.offsetLeft + box.x * paper.offsetWidth;
    const right = paper.offsetLeft + (box.x + box.w) * paper.offsetWidth;
    if (left < el.scrollLeft || right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, left - 40);
    // boxKey stands for the box, which is a new object on every render.
  }, [view.documentId, view.page, boxKey, scale, content, H]);

  const thumb = (n: number) => (b.documentId && source ? source.thumbnailUrl(b.documentId, n) : null);
  const fileName = view.other ? otherDoc?.name || t('another document') : doc?.name || b.sourceFile;

  return (
    <section ref={ref} className={styles.pane} style={{ width }} aria-label={t('Original page')}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <h2 className={styles.title} title={originalLabel(t, fileName, view.page)}>
            <OriginalLabel file={fileName} page={view.page} />
          </h2>
          <button type="button" className={styles.hide} onClick={onCollapse} aria-label={t('Hide the original')} title={t('Hide the original')}>
            ›
          </button>
        </div>
        {active && (
          <div className={styles.value}>
            <span className={styles.valueLabel}>{active.label}</span>
            {active.raw && (
              <span className={styles.raw}>
                {' · '}
                {t('as printed')}: “{active.raw}”
              </span>
            )}
          </div>
        )}
        <div className={styles.controls}>
          <div className={styles.pager}>
            <button type="button" className={styles.navBtn} onClick={() => prev != null && onPick(prev)} disabled={prev == null} aria-label={t('PREVIOUS PAGE')}>
              ‹
            </button>
            <span className={styles.pageText} aria-live="polite">
              {view.page != null ? `${t('PAGE')} ${view.page}${pageCount ? ` ${t('OF')} ${pageCount}` : ''}` : t('no page')}
            </span>
            <button type="button" className={styles.navBtn} onClick={() => next != null && onPick(next)} disabled={next == null} aria-label={t('NEXT PAGE')}>
              ›
            </button>
          </div>
          <div className={styles.zoom} role="group" aria-label="Zoom">
            <button type="button" className={styles.navBtn} onClick={() => setZoom(stepZoom(scale, -1))} aria-label={t('Zoom out')}>
              −
            </button>
            <span className={styles.zoomText}>{Math.round(scale * 100)}%</span>
            <button type="button" className={styles.navBtn} onClick={() => setZoom(stepZoom(scale, 1))} aria-label={t('Zoom in')}>
              +
            </button>
            <button type="button" className={styles.fitBtn} onClick={() => setZoom('fit')} aria-pressed={zoom === 'fit'}>
              {t('FIT')}
            </button>
          </div>
        </div>
        {target?.kind === 'page' && target.count > 1 && <SourceStepper index={target.index} count={target.count} page={target.page} onStep={onStep} />}
        {(note || canOpenOther(target, view.other)) && (
          <div className={styles.noteRow}>
            {note && (
              <span className={styles.note} role="status">
                {note}
              </span>
            )}
            {canOpenOther(target, view.other) && (
              <button type="button" className={styles.openOther} onClick={onOpenOther}>
                {t('Open that page')}
              </button>
            )}
          </div>
        )}
        {pages.length > 0 && (
          <nav className={styles.strip} aria-label={t('Pages with values of this borehole')}>
            {pages.map((n) => {
              const url = thumb(n);
              const current = !view.other && n === view.page;
              return (
                <button
                  key={n}
                  type="button"
                  className={`${styles.stripPage} ${url ? styles.withThumb : ''} ${current ? styles.stripCurrent : ''}`}
                  onClick={() => onPick(n)}
                  aria-current={current ? 'page' : undefined}
                  aria-label={`${t('PAGE')} ${n}`}
                >
                  {url ? <img src={url} alt="" className={styles.thumb} /> : null}
                  <span className={styles.stripNum}>{n}</span>
                </button>
              );
            })}
          </nav>
        )}
      </div>
      {/* A tab stop of its own, so arrow keys scroll the page. */}
      <div ref={scrollRef} className={styles.scroll} role="region" aria-label={t('Page image')} tabIndex={0}>
        {view.page == null ? (
          <div className={styles.status}>{t('No source page for this borehole.')}</div>
        ) : failed ? (
          <div className={styles.failed} style={{ width: W, height: H }} role="alert">
            <span className={styles.failedTitle}>{t('Original page could not be loaded')}</span>
            <span className={styles.failedDetail}>{load.status === 'error' ? load.error : `${t('page')} ${view.page} · ${fileName}`}</span>
          </div>
        ) : (
          <div ref={paperRef} className={styles.paper} style={{ width: W, height: H }}>
            {content && <ScanPage content={content} scale={scale} boxes={boxes} />}
            {load.status === 'loading' && (
              <div className={styles.status} aria-busy="true">
                {t('Loading the original scan…')} · {t('page')} {view.page}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

