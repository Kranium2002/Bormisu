import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveStatus } from '../../components/LiveStatus';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/appStore';
import { retryBlockedReason } from '../../store/uploads';
import { PAGE_LEGEND } from '../../theme';
import { DocumentCard } from './DocumentCard';
import { DropZone } from './DropZone';
import type { ThumbnailUrl } from './PageStrip';
import styles from './QueueScreen.module.css';
import { UploadList } from './UploadList';

/** How long a card stays highlighted after a "Same file as …" or SHOW DOCUMENT link pointed at it. */
const HIGHLIGHT_MS = 2000;

/**
 * Page-type colour key for the page strips: log, lab table, text, drawing, photo, a classified page
 * without a type, and a page not classified yet.
 */
function PageTypeLegend() {
  const t = useT();
  return (
    <ul className={styles.legend} aria-label={t('Page types')}>
      {PAGE_LEGEND.map((m) => (
        <li key={m.name} className={styles.legendItem}>
          <span className={styles.swatch} style={{ background: m.color, borderColor: m.border }} aria-hidden="true" />
          {t(m.name)}
        </li>
      ))}
    </ul>
  );
}

/**
 * Files dropped next to the drop zone would make the browser open them and leave the app.
 * While the queue is shown, such drops are refused; the drop zone handles its own events first.
 */
function useRefuseStrayDrops() {
  useEffect(() => {
    const refuse = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);
}

/** Smooth scrolling unless the user asked for reduced motion. */
const scrollBehavior = (): ScrollBehavior =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/**
 * Upload & queue: the live-update status, the drop zone with the project field, the upload queue,
 * and one card per document with status, progress, checks, counts and page map.
 */
export function QueueScreen() {
  const t = useT();
  const documents = useAppStore((s) => s.documents);
  const liveStatus = useAppStore((s) => s.liveStatus);
  const jobFailures = useAppStore((s) => s.jobFailures);
  const source = useAppStore((s) => s.source);
  const thumbnailUrl = useMemo<ThumbnailUrl | null>(() => (source ? (id, n) => source.thumbnailUrl(id, n) : null), [source]);
  // RETRY needs a working extraction: off in demo mode, with the reason.
  const retryBlocked = useAppStore((s) => retryBlockedReason(s.health));
  const [highlight, setHighlight] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useRefuseStrayDrops();

  useEffect(() => () => clearTimeout(timer.current), []);

  /** Scrolls to a document's card, moves focus to it and highlights it for a moment. */
  const showDocument = useCallback((id: string) => {
    const card = document.querySelector<HTMLElement>(`[data-doc-id="${CSS.escape(id)}"]`);
    card?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    card?.focus({ preventScroll: true });
    setHighlight(id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  }, []);

  return (
    <div className={styles.scroll} data-screen-label="Upload & queue">
      <div className={styles.page}>
        <div className={styles.titleRow}>
          <div className={styles.titleGroup}>
            <h1 className={styles.title}>{t('UPLOAD & QUEUE')}</h1>
            <LiveStatus status={liveStatus} />
          </div>
          <PageTypeLegend />
        </div>
        <DropZone />
        <UploadList onShowDocument={showDocument} />
        <div className={styles.columns} aria-hidden="true">
          <div>{t('DOCUMENT')}</div>
          <div>{t('STATUS')}</div>
          <div>{t('CHECKS')}</div>
        </div>
        <section className={styles.list} aria-label={t('Document queue')}>
          {documents.length ? (
            documents.map((d) => (
              <DocumentCard
                key={d.id}
                doc={d}
                highlighted={highlight === d.id}
                retryBlocked={retryBlocked}
                failure={jobFailures[d.id] ?? null}
                thumbnailUrl={thumbnailUrl}
                onShowDocument={showDocument}
              />
            ))
          ) : (
            <div className={styles.empty}>{t('No documents yet. Drop a report above to extract its boreholes.')}</div>
          )}
        </section>
      </div>
    </div>
  );
}
