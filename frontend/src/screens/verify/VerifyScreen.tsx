/**
 * Side-by-side verification (/verify/:uid?page=n): the original page on the left, the "extracted
 * page" on the right (each value of the borehole drawn as text where it was read), both the same
 * size in one scroll container (so scrolling is synced) under one zoom. Clicking a value on either
 * side focuses it (store focusValue) and opens a small control bar with Review's actions.
 *
 * It works on the review borehole (the route sets reviewUid), so approve, edit, not-in-source and
 * flag are the Review screen's own store actions.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { CertaintyMark } from '../../components/CertaintyMark';
import { EmptyState } from '../../components/EmptyState';
import { ScanPage } from '../../components/ScanPage';
import { PAGE_W, type Borehole } from '../../domain/types';
import { useT } from '../../i18n';
import { useLocationRoute } from '../../routing/RouteSync';
import { useAppStore, useDocument, usePage, useReviewBorehole } from '../../store/appStore';
import { boxStyle, ExtractedPage } from './ExtractedPage';
import styles from './VerifyScreen.module.css';
import {
  fitScale,
  neighbours,
  pageAspect,
  pageItems,
  pickPage,
  scaleOf,
  stepZoom,
  verifyPages,
  type VerifyItem,
  type Zoom,
} from './verifyModel';

/** Below this width of the panes' container they stack (original above extracted). */
const STACK_BELOW = 760;
/** Padding and gap of the panes' container (px), mirrored in the CSS. */
const PAD = 16;
const GAP = 16;

/** Natural size of a page image, once it has loaded; null before and for drawn sample pages. */
function useImageSize(url: string | undefined): { w: number; h: number } | null {
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => setSize({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return size && size.url === url ? size : null;
}

/** Width of an element, kept up to date. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function VerifyScreen() {
  const b = useReviewBorehole();
  if (!b) return null;
  return <Verify b={b} />;
}

function Verify({ b }: { b: Borehole }) {
  const t = useT();
  const route = useLocationRoute();
  const doc = useDocument(b.documentId);
  const source = useAppStore((s) => s.source);
  const focusKey = useAppStore((s) => s.focusKey);
  const focusValue = useAppStore((s) => s.focusValue);
  const showRoute = useAppStore((s) => s.showRoute);

  const pages = useMemo(() => verifyPages(b), [b]);
  const pageCount = doc?.pages.length || null;
  const page = pickPage(route.kind === 'verify' ? route.page : null, pages, pageCount);
  const { prev, next } = neighbours(pages, page);
  const { boxed, unboxed } = useMemo(() => pageItems(b, page), [b, page]);
  const selected = [...boxed, ...unboxed].find((it) => it.key === focusKey) ?? null;

  const goPage = useCallback((n: number | null) => {
    if (n != null) showRoute({ kind: 'verify', uid: b.uid, page: n });
  }, [showRoute, b.uid]);

  // ← → and PageUp / PageDown change the page (not while typing in the edit field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      const to = e.key === 'ArrowLeft' || e.key === 'PageUp' ? prev : e.key === 'ArrowRight' || e.key === 'PageDown' ? next : undefined;
      if (to === undefined) return;
      e.preventDefault();
      goPage(to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, goPage]);

  const load = usePage(b.documentId, page);
  const content = load.status === 'ready' ? load.content : null;
  const natural = useImageSize(content?.imageUrl);

  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useWidth(scrollRef);
  const stacked = width > 0 && width < STACK_BELOW;
  const paneWidth = stacked ? width - 2 * PAD : (width - 2 * PAD - GAP) / 2;
  const [zoom, setZoom] = useState<Zoom>('fit');
  const fit = width > 0 ? fitScale(paneWidth) : 1;
  const scale = scaleOf(zoom, fit);
  const W = Math.floor(PAGE_W * scale);
  const H = Math.round(W * pageAspect(natural));

  // A new page starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [page]);

  if (page == null) {
    return (
      <div className={styles.screen}>
        <TitleRow b={b} fileName={doc?.name ?? b.sourceFile} />
        <EmptyState title={t('No source page for this borehole.')} />
      </div>
    );
  }

  const thumb = (n: number) => (b.documentId && source ? source.thumbnailUrl(b.documentId, n) : null);

  return (
    <div className={styles.screen}>
      <TitleRow b={b} fileName={doc?.name ?? b.sourceFile}>
        <div className={styles.pager}>
          <button type="button" className={styles.navBtn} onClick={() => goPage(prev)} disabled={prev == null} aria-label={t('PREVIOUS PAGE')} title="←">
            ‹
          </button>
          <span className={styles.pageText}>
            {t('PAGE')} {page}
            {pageCount ? ` ${t('OF')} ${pageCount}` : ''}
          </span>
          <button type="button" className={styles.navBtn} onClick={() => goPage(next)} disabled={next == null} aria-label={t('NEXT PAGE')} title="→">
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
      </TitleRow>

      {pages.length > 0 && (
        <nav className={styles.strip} aria-label={t('Pages with values of this borehole')}>
          {pages.map((n) => {
            const url = thumb(n);
            return (
              <button
                key={n}
                type="button"
                className={`${styles.stripPage} ${url ? styles.withThumb : ''} ${n === page ? styles.stripCurrent : ''}`}
                onClick={() => goPage(n)}
                aria-current={n === page ? 'page' : undefined}
                aria-label={`${t('PAGE')} ${n}`}
              >
                {url ? <img src={url} alt="" className={styles.thumb} /> : null}
                <span className={styles.stripNum}>{n}</span>
              </button>
            );
          })}
        </nav>
      )}

      <div ref={scrollRef} className={`${styles.panes} ${stacked ? styles.stacked : ''}`}>
        <section className={styles.pane} aria-label={t('Original page')}>
          <div className={styles.paneHead}>{t('Original page')}</div>
          <div
            className={`${styles.sheet} ${selected?.placement === 'page' ? styles.pageSelected : ''}`}
            style={{ width: W, height: H }}
          >
            {content && <ScanPage content={content} scale={scale} />}
            {load.status === 'loading' && <div className={styles.pagePlaceholder}>{t('Loading page…')}</div>}
            {load.status === 'error' && (
              <div className={`${styles.pagePlaceholder} ${styles.pageError}`} role="alert">
                {load.error}
              </div>
            )}
            <div className={styles.overlay}>
              {boxed.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className={[
                    styles.srcBox,
                    styles[it.certainty.kind],
                    it.placement === 'approx' ? styles.approx : '',
                    it.key === focusKey ? styles.selected : '',
                  ].join(' ')}
                  style={boxStyle(it.box!)}
                  title={it.title}
                  aria-label={`${it.label} (${t('as printed')}): ${it.raw}`}
                  aria-pressed={it.key === focusKey}
                  onClick={() => focusValue(it.key)}
                />
              ))}
            </div>
          </div>
        </section>

        <section className={styles.pane} aria-label={t('Extracted page')}>
          <div className={styles.paneHead}>{t('Extracted page')}</div>
          <ExtractedPage
            width={W}
            height={H}
            items={boxed}
            selectedKey={focusKey}
            onSelect={focusValue}
            pageSelected={selected?.placement === 'page'}
          />
          {unboxed.length > 0 && (
            <div className={styles.unboxed} style={{ maxWidth: Math.max(W, 280) }}>
              <div className={styles.unboxedHead}>{t('No box on this page')}</div>
              <ul className={styles.unboxedList}>
                {unboxed.map((it) => (
                  <li key={it.key}>
                    <button
                      type="button"
                      className={`${styles.unboxedItem} ${it.key === focusKey ? styles.unboxedSelected : ''}`}
                      title={it.title}
                      aria-pressed={it.key === focusKey}
                      onClick={() => focusValue(it.key)}
                    >
                      <CertaintyMark certainty={it.certainty} />
                      <span className={styles.unboxedLabel}>{it.label}</span>
                      <span className={styles.unboxedValue}>{it.text}</span>
                      {it.placement === 'page' && <span className={styles.approxTag}>{t('whole page')}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {boxed.length === 0 && unboxed.length === 0 && (
            <div className={styles.note}>{t('No values of this borehole on this page.')}</div>
          )}
        </section>
      </div>

      <ControlBar item={selected} />
    </div>
  );
}

function TitleRow({ b, fileName, children }: { b: Borehole; fileName: string; children?: ReactNode }) {
  const t = useT();
  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <h1 className={styles.title}>
          {t('VERIFY')} · {b.id || b.uid}
        </h1>
        <div className={styles.subtitle} title={fileName}>
          {fileName}
        </div>
      </div>
      {children}
    </header>
  );
}

/** Under the panes: the selected value (label, raw → value) and Review's actions on it. */
function ControlBar({ item }: { item: VerifyItem | null }) {
  const t = useT();
  const editing = useAppStore((s) => s.editing);
  const value = useAppStore((s) => (item ? s.boreholes.find((x) => x.uid === s.reviewUid)?.values.find((v) => v.key === item.key) : undefined));
  const { toggleApprove, startEdit, setEditText, saveEdit, cancelEdit, setState, toggleFlag } = useAppStore.getState();

  if (!item || !value) {
    return (
      <div className={styles.bar}>
        <span className={styles.hint}>{t('Click a value on either page to check it.')}</span>
      </div>
    );
  }

  const edit = editing?.key === item.key ? editing : null;
  const onEditKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') saveEdit();
  };

  return (
    <div className={styles.bar} aria-live="polite">
      <div className={styles.barValue}>
        <CertaintyMark certainty={item.certainty} />
        <span className={styles.barLabel}>{item.label}</span>
        <span className={styles.barRaw} title={t('as printed')}>
          “{item.raw || '–'}”
        </span>
        <span aria-hidden>→</span>
        <span className={styles.barText}>{item.text}</span>
        {item.placement === 'approx' && <span className={styles.approxTag}>{t('approx.')}</span>}
      </div>
      {item.lockedReason ? (
        <span className={styles.locked}>{item.lockedReason}</span>
      ) : edit ? (
        <div className={styles.actions}>
          <input
            className={styles.editInput}
            value={edit.text}
            placeholder={edit.mode === 'flag' ? t('Why is it flagged?') : undefined}
            aria-label={edit.mode === 'flag' ? t('Why is it flagged?') : item.label}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={onEditKey}
            autoFocus
          />
          <button type="button" className={styles.primaryBtn} onClick={saveEdit}>
            {edit.mode === 'flag' ? t('FLAG') : t('SAVE')}
          </button>
          <button type="button" className={styles.quietBtn} onClick={cancelEdit}>
            {t('CANCEL')}
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={styles.primaryBtn} onClick={() => toggleApprove(item.key)} aria-pressed={value.status === 'approved'}>
            {value.status === 'approved' ? `${t('APPROVED')} ✓` : t('APPROVE')}
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={() => startEdit(item.key, 'edit')}>
            {t('EDIT')}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => setState(item.key, 'not in source')}
            aria-pressed={value.state === 'not in source'}
          >
            {t('NOT IN SOURCE')}
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={() => toggleFlag(item.key)} aria-pressed={value.status === 'flagged'}>
            {value.status === 'flagged' ? t('UNFLAG') : t('FLAG')}
          </button>
        </div>
      )}
    </div>
  );
}
